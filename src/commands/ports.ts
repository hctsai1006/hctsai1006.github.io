/**
 * ports.ts — what a command is allowed to reach, and how the broker stays in
 * the path.
 *
 * Twenty-eight commands could not be written because `InvocationContext` had no
 * filesystem, no preferences and no way to ask the host for anything. The
 * storage layer existed; nothing handed it to a command. This is that contract.
 *
 * THE DESIGN CONSTRAINT, which is not incidental:
 *
 * An adversarial review of the kernel found that no command in the repository
 * calls `requireCapability`, and that gate 1 — the manifest declaration — is
 * checked against the live manifest object at use time. A command handed a raw
 * `VirtualFileSystem` could read, write and delete without ever asking, and the
 * capability it declared would be decoration. `capabilities: []` has to mean
 * something.
 *
 * So a command never receives the filesystem. It receives a view that requires
 * the matching capability on EVERY call, mapping the operation to the capability
 * a reader would expect:
 *
 *   stat exists readdir access readText readBytes  ->  filesystem.read
 *   write append mkdir chmod utimes rename          ->  filesystem.write
 *   remove                                          ->  filesystem.delete
 *
 * `rename` is a write and not a delete on purpose: it moves a name, it does not
 * destroy content, and real `Move-Item` needs no delete permission. `remove` is
 * separated because it is the one operation whose mistake is unrecoverable, and
 * the taxonomy already gives it its own capability.
 *
 * The check is per call rather than once at construction because a command can
 * be long-running and a grant can be dropped underneath it. Auditing follows
 * from the same call, so the log records what was actually attempted rather than
 * what was declared.
 */

import type {
  CopyOptions,
  DirectoryEntry,
  FileStat,
  MkdirOptions,
  Permission,
  RemoveOptions,
  RenameOptions,
  Result,
  Times,
  WriteOptions,
  WriteReceipt,
} from '../storage/index.ts';
import type { VirtualFileSystem, ResolvedPath } from '../storage/vfs.ts';
import type { Capability } from './manifest.ts';

/**
 * The filesystem as a command sees it: every method the twenty-eight commands
 * need, and nothing that would let one reach around the broker.
 *
 * Deliberately NOT the `VirtualFileSystem` itself. Mount management, the backend
 * handle and the seed installer are host concerns; a command that could unmount
 * a drive is a command whose declared capabilities describe nothing.
 */
export interface FileSystemPort {
  resolve(path: string): Result<ResolvedPath>;
  /** Where the shell currently is. The VFS calls it `location`. */
  readonly location: ResolvedPath;
  setLocation(path: string): Promise<Result<ResolvedPath>>;

  stat(path: string): Promise<Result<FileStat>>;
  exists(path: string): Promise<boolean>;
  access(path: string, permission: Permission): Promise<Result<void>>;
  readText(path: string): Promise<Result<string>>;
  readBytes(path: string): Promise<Result<Uint8Array>>;
  readdir(path: string): Promise<Result<readonly DirectoryEntry[]>>;

  writeText(path: string, text: string, options?: WriteOptions): Promise<Result<WriteReceipt>>;
  writeBytes(path: string, bytes: Uint8Array, options?: WriteOptions): Promise<Result<WriteReceipt>>;
  appendText(path: string, text: string, options?: WriteOptions): Promise<Result<WriteReceipt>>;
  mkdir(path: string, options?: MkdirOptions): Promise<Result<FileStat>>;
  chmod(path: string, mode: number): Promise<Result<FileStat>>;
  utimes(path: string, times: Times, create?: boolean): Promise<Result<FileStat>>;
  rename(from: string, to: string, options?: RenameOptions): Promise<Result<void>>;
  /**
   * A whole copy as ONE planned operation.
   *
   * Omitting this was a real defect, reported by the work that needed it: the
   * backend's `copy` is plan/validate/apply, so a recursive copy that fails
   * part-way has written nothing. A command without it has to loop, and a loop
   * of single writes gives up exactly that guarantee — nine files copied, the
   * tenth refused, and eight of them left behind.
   */
  copy(from: string, to: string, options?: CopyOptions): Promise<Result<void>>;

  remove(path: string, options?: RemoveOptions): Promise<Result<void>>;
}

/**
 * Wrap a filesystem so every operation asks the broker first.
 *
 * `require` is `InvocationContext.requireCapability`, which throws
 * `CapabilityDeniedError`. The throw is the point: a command that did not
 * declare `filesystem.write` cannot write, however it was written, and the
 * failure names the capability rather than surfacing as a mysterious error.
 */
export function brokeredFileSystem(
  fs: VirtualFileSystem,
  require: (capability: Capability) => void,
): FileSystemPort {
  // `async`, so a denial arrives as a REJECTED PROMISE rather than a synchronous
  // throw. Every gated method here returns a promise, and a caller writing
  // `port.writeText(...).catch(...)` would otherwise crash instead of catching:
  // the check runs before the promise exists. Making the wrapper async is what
  // keeps the contract uniform.
  const gate =
    <A extends unknown[], R>(capability: Capability, fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      require(capability);
      return fn(...args);
    };
  const read = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    gate<A, R>('filesystem.read', fn);
  const write = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    gate<A, R>('filesystem.write', fn);

  return {
    // `resolve` and `cwd` are not gated: turning "../notes.txt" into an absolute
    // path reveals nothing a command did not already type, and the binder needs
    // it before any capability question is meaningful.
    resolve: (path) => fs.resolve(path),
    get location() {
      return fs.location;
    },
    setLocation: read((path: string) => fs.setLocation(path)),

    stat: read((path: string) => fs.stat(path)),
    exists: read((path: string) => fs.exists(path)),
    access: read((path: string, permission: Permission) => fs.access(path, permission)),
    readText: read((path: string) => fs.readText(path)),
    readBytes: read((path: string) => fs.readBytes(path)),
    readdir: read((path: string) => fs.readdir(path)),

    writeText: write((path: string, text: string, options?: WriteOptions) =>
      fs.writeText(path, text, options),
    ),
    writeBytes: write((path: string, bytes: Uint8Array, options?: WriteOptions) =>
      fs.writeBytes(path, bytes, options),
    ),
    appendText: write((path: string, text: string, options?: WriteOptions) =>
      fs.appendText(path, text, options),
    ),
    mkdir: write((path: string, options?: MkdirOptions) => fs.mkdir(path, options)),
    chmod: write((path: string, mode: number) => fs.chmod(path, mode)),
    utimes: write((path: string, times: Times, create?: boolean) => fs.utimes(path, times, create)),
    rename: write((from: string, to: string, options?: RenameOptions) => fs.rename(from, to, options)),
    // A copy READS the source and WRITES the destination, so it needs both. The
    // gate takes the stricter of the two: a command holding only
    // `filesystem.read` cannot copy, which is the answer a reader expects.
    copy: write((from: string, to: string, options?: CopyOptions) => {
      require('filesystem.read');
      return fs.copy(from, to, options);
    }),

    remove: gate('filesystem.delete', (path: string, options?: RemoveOptions) =>
      fs.remove(path, options),
    ),
  };
}

/**
 * Durable per-visitor settings that are not files: the colour scheme, the
 * prompt, whatever a preferences pane would own.
 *
 * Separate from the filesystem because it is separate in the capability
 * taxonomy — `preferences.write` is its own grant — and because a theme is not
 * a file a visitor should be able to `rm`.
 */
export interface PreferencesPort {
  get(key: string): string | null;
  set(key: string, value: string): void;
  keys(): readonly string[];
}

/**
 * Asking the host for something only a UI can do.
 *
 * `nano`, `vi` and `vim` are the reason this exists. They are not filesystem
 * commands with extra steps: they hand a buffer to a person and wait. The core
 * is headless, so it cannot open an editor — it can only ask, and be told what
 * came back.
 *
 * `editText` resolves to the edited text, or to null when the visitor
 * cancelled. A null is a normal outcome and must not be an error: quitting nano
 * without saving is not a failure.
 */
export interface DialogPort {
  editText(request: {
    readonly path: string;
    readonly contents: string;
    /** Which editor was typed, so the host can match its chrome and key map. */
    readonly editor: string;
  }): Promise<string | null>;

  /** A yes/no the visitor must answer, for a destructive action. */
  confirm(request: { readonly title: string; readonly detail: string }): Promise<boolean>;
}
