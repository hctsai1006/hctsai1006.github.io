/**
 * vfs.ts — path resolution, the mount table, and the seed/overlay split.
 *
 * Three jobs that look separate and are not. A mount table is only useful if
 * every provider agrees on what a path means, and the seed/overlay split is
 * only correct if "the same file" is decidable — which is a question about path
 * normalisation. Splitting them across files would let the three answers drift.
 *
 * ---------------------------------------------------------------------------
 * THE RESOLVER TAKES A PATH, NOT A COMMAND-LINE FRAGMENT
 * ---------------------------------------------------------------------------
 *
 * v1's resolver strips quotes:
 *
 *     function resolvePath(p){
 *       if(p==null||p==='') return CWD;
 *       p=String(p).replace(/^["']|["']$/g,'');      // <-- lexing, here
 *       …
 *
 * PR-10 task 10.4 says that has to move out, and it is right for a reason
 * beyond tidiness: it makes a file whose name genuinely starts with a quote
 * unaddressable, and it makes the resolver's answer depend on how the argument
 * was written rather than on what it is. Once the lexer produces values, a
 * quote in a path is a character like any other. Nothing here touches quotes,
 * and there is a test that `"a"` names a file with quotes in its name.
 *
 * ---------------------------------------------------------------------------
 * DECISIONS, EACH TESTED
 * ---------------------------------------------------------------------------
 *
 * `..` ABOVE THE ROOT CLAMPS, AND THE CLAMP IS REPORTED. `/..` is `/`, and
 *   `../../../../etc/passwd` from `/home/thc1006` is `/etc/passwd`. This is not
 *   leniency, it is POSIX: the root directory's `..` entry points at the root
 *   itself, so clamping is what a real kernel does rather than a check bolted
 *   on top. It also makes "a resolved path never leaves its mount" a TOTAL
 *   property with no error arm — and an escape check with no error arm is one
 *   no caller can forget to handle. Rejecting instead would put a
 *   traversal-shaped `EINVAL` in front of all 28 commands, and the first one to
 *   mishandle it would have the bug the check was meant to prevent.
 *   MEASURED against pwsh 7.6.5, which does both: `(Resolve-Path 'C:\..\..')`
 *   emits "referred to an item that was outside the base 'C:'" AND returns
 *   `C:\`. So `ResolvedPath.clampedAtRoot` carries the fact, and the one
 *   command that reports it — `Resolve-Path` — can, without the other 27
 *   having to.
 *
 * PATHS ARE CASE-SENSITIVE. `README.md` and `readme.md` are different files.
 *   The emulated machine is Ubuntu; v1 says so at the site where it removed the
 *   old Windows-derived lowercasing. DRIVE NAMES ARE CASE-INSENSITIVE, because
 *   PowerShell drive names are: `env:PATH` and `Env:PATH` are the same drive.
 *   Both halves of that asymmetry are tested, together, in one test.
 *
 * `/` IS THE ONLY SEPARATOR ON THE FILESYSTEM DRIVE. On Linux `\` is an
 *   ordinary character in a filename, so `a\b` is one file, not two segments.
 *   On a DRIVE-QUALIFIED path both `/` and `\` separate. MEASURED: pwsh 7.6.5
 *   accepts `Env:/PATH`, `Env:\PATH` and bare `Env:PATH` alike, and renders the
 *   location as `Env:\` — so a provider drive prints with backslashes while the
 *   filesystem prints POSIX-style. That looks inconsistent and is what the
 *   reference implementation does. Both halves are tested.
 *
 * AN EMPTY PATH IS `EINVAL`, NOT THE CWD. v1 returns `CWD` for `''`, which
 *   turns `cat ""` into `cat .` — the class of silent wrong answer this repo
 *   keeps finding. A caller that means "no argument, use the cwd" says
 *   `path ?? cwd` at the call site, where the default is visible. MEASURED:
 *   pwsh rejects it one layer earlier still, at binding —
 *   `ParameterArgumentValidationErrorEmptyStringNotAllowed` — so in a wired-up
 *   engine this arm should be unreachable, and it exists for the callers that
 *   are not commands.
 *
 * A LEADING `/` IS ALWAYS THE FILESYSTEM DRIVE, not the current drive's root.
 *   PowerShell roots such a path at the current drive; here the two readings
 *   coincide everywhere except inside a non-filesystem drive, and there the
 *   useful one is unambiguous — `Env:` is flat, so `/x` cannot mean anything
 *   inside it, while `cd /` from `Env:` is the first thing a terminal user
 *   tries. Recorded as a deliberate simplification, not an accident.
 */

import { NAME_MAX, PATH_MAX, err, ok } from './types.ts';
import type {
  CopyOptions,
  DirectoryEntry,
  Err,
  FileStat,
  MkdirOptions,
  Permission,
  QuotaUsage,
  RemoveOptions,
  RenameOptions,
  Result,
  StorageBackend,
  StorageError,
  StorageSyscall,
  Times,
  WriteOptions,
  WriteReceipt,
} from './types.ts';

// ---------------------------------------------------------------------------
// pure path arithmetic
// ---------------------------------------------------------------------------

export const SEPARATOR = '/';

/** The mount every rooted path belongs to. On Ubuntu, PowerShell's drive is `/`. */
export const FILESYSTEM_DRIVE = '/';

/**
 * The only two characters a POSIX filename may not contain.
 *
 * NEWLINES ARE LEGAL. `touch $'a\nb'` works on Linux and produces one file, and
 * a resolver that rejected it would be inventing a rule the emulated machine
 * does not have. It is tested, because the tempting "reject anything odd" fix
 * is exactly the wrong one and someone will propose it.
 */
const FORBIDDEN_IN_NAME = /[\0/]/;

function invalid(path: string, syscall: StorageSyscall, message: string, reason: string): Err<StorageError> {
  return err({ code: 'EINVAL', path, syscall, message, reason });
}

function tooLong(
  path: string,
  syscall: StorageSyscall,
  message: string,
  limit: number,
  actual: number,
): Err<StorageError> {
  return err({ code: 'ENAMETOOLONG', path, syscall, message, limit, actual });
}

/**
 * Split on `/`, dropping empty segments and `.`.
 *
 * Empty segments are dropped rather than preserved, which is what collapses
 * `//a///b/` to `a`, `b`. POSIX permits an implementation to treat a leading
 * `//` specially; Linux does not, and neither do we.
 */
export function splitSegments(path: string): string[] {
  const out: string[] = [];
  for (const segment of path.split(SEPARATOR)) {
    if (segment === '' || segment === '.') continue;
    out.push(segment);
  }
  return out;
}

/** Apply `..`, clamping at the root. See the header for why clamping. */
export function normalizeSegments(segments: readonly string[]): string[] {
  return normalizeTracked(segments).segments;
}

/**
 * The same walk, reporting whether a `..` was discarded at the root.
 *
 * MEASURED, and it changed this design. pwsh 7.6.5 does BOTH things:
 *
 *     PS> (Resolve-Path 'C:\..\..').Path
 *     Resolve-Path: The path 'C:\..\..' referred to an item that was outside the base 'C:'.
 *     C:\
 *
 * — it reports the escape AND yields the clamped root. So clamping is not a
 * deviation from PowerShell; suppressing the report would be. But the report
 * belongs to `Resolve-Path`, which is the only command that makes it, and
 * putting an error arm in the resolver would push it in front of the other 27.
 * The flag is how `Resolve-Path` reproduces the message without any of them
 * having to care.
 */
export function normalizeTracked(segments: readonly string[]): {
  readonly segments: string[];
  readonly clampedAtRoot: boolean;
} {
  const out: string[] = [];
  let clampedAtRoot = false;
  for (const segment of segments) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') {
      if (out.length === 0) clampedAtRoot = true;
      else out.pop();
      continue;
    }
    out.push(segment);
  }
  return { segments: out, clampedAtRoot };
}

/** `/a/./b/../c//` → `/a/c`. Absolute in, absolute out, always. */
export function normalizePath(path: string): string {
  return SEPARATOR + normalizeSegments(splitSegments(path)).join(SEPARATOR);
}

/** Everything before the last component. `/a/b` → `/a`; `/a` → `/`. */
export function dirname(path: string): string {
  const segments = normalizeSegments(splitSegments(path));
  segments.pop();
  return SEPARATOR + segments.join(SEPARATOR);
}

/** The last component. `/a/b` → `b`; `/` → `''`. */
export function basename(path: string): string {
  const segments = normalizeSegments(splitSegments(path));
  return segments[segments.length - 1] ?? '';
}

/**
 * Join, with an absolute right-hand side winning outright.
 *
 * That rule is what makes the associativity property in the tests hold:
 * `resolve(resolve(base, a), b)` equals `resolve(base, join(a, b))` only if
 * `join` discards the left side exactly when `resolve` would have.
 */
export function joinPath(left: string, right: string): string {
  if (right.startsWith(SEPARATOR)) return normalizePath(right);
  if (left === '') return right;
  return `${left}${left.endsWith(SEPARATOR) ? '' : SEPARATOR}${right}`;
}

/** Is `path` inside `ancestor`? False when they are equal — a directory is not its own descendant. */
export function isDescendant(path: string, ancestor: string): boolean {
  const a = normalizePath(ancestor);
  const p = normalizePath(path);
  if (a === SEPARATOR) return p !== SEPARATOR;
  return p.startsWith(`${a}${SEPARATOR}`);
}

/**
 * Check every component and the whole, as the kernel does.
 *
 * `NAME_MAX` is per component and `PATH_MAX` is for the whole string; enforcing
 * only the second lets a single 4000-character filename through, which every
 * real filesystem rejects.
 */
/**
 * Refuse a path a backend was promised it would never see.
 *
 * `StorageBackend` documents its input as "already resolved: absolute within
 * this mount, normalised, no `.` or `..`". It was a comment and nothing else,
 * and two in-repo callers broke it with data they had not normalised —
 * `restoreSnapshot`, whose own docstring says a snapshot is a file someone can
 * hand you, and `installImage`.
 *
 * The consequences were not subtle. Inside `MemoryStorage`, reads walk segments
 * literally while `dirname`/`basename` apply `..`, so the two halves disagreed
 * about the same string:
 *
 *     stat('/a/../b/t')      ENOENT
 *     writeText('/a/../b/t') ok      <- and the bytes landed at /b/t
 *
 * A mutation reported as a failure is the worst shape this can take. And
 * `writeText('/..')` created a NAMELESS child of the root, because `basename`
 * of `/..` is the empty string — after which exporting the tree recursed into
 * the root forever and exhausted the heap.
 *
 * So the precondition is enforced where it is documented. `validatePath` still
 * allows `..`, because `VirtualFileSystem.resolve` runs before normalisation
 * and `cd ..` has to work.
 */
export function requireNormalisedPath(
  path: string,
  syscall: StorageSyscall,
): Result<string> {
  for (const segment of splitSegments(path)) {
    if (segment === '.' || segment === '..' || segment === '') {
      return invalid(
        path,
        syscall,
        `path is not normalised: "${segment}" must be resolved before it reaches a backend`,
        'not-normalised',
      );
    }
  }
  return ok(path);
}

export function validatePath(path: string, syscall: StorageSyscall): Result<string> {
  if (path.length > PATH_MAX) {
    return tooLong(
      path.slice(0, 80),
      syscall,
      `path exceeds PATH_MAX (${String(PATH_MAX)})`,
      PATH_MAX,
      path.length,
    );
  }
  for (const segment of splitSegments(path)) {
    if (segment === '..') continue;
    if (FORBIDDEN_IN_NAME.test(segment)) {
      return invalid(path, syscall, 'a path component contains a NUL byte', 'nul-in-name');
    }
    if (segment.length > NAME_MAX) {
      return tooLong(
        path,
        syscall,
        `a path component exceeds NAME_MAX (${String(NAME_MAX)})`,
        NAME_MAX,
        segment.length,
      );
    }
  }
  return ok(path);
}

// ---------------------------------------------------------------------------
// resolution
// ---------------------------------------------------------------------------

/** A path that has been decided: which mount, and where inside it. */
export interface ResolvedPath {
  /** The canonical drive name, exactly as registered in the mount table. */
  readonly drive: string;
  /** Absolute inside that drive, normalised, always starting with `/`. */
  readonly path: string;
  /** How it is written back to the user: `/home/x` or `Env:\PATH`. */
  readonly full: string;
  /** A `..` was discarded at the root. See `normalizeTracked`. */
  readonly clampedAtRoot: boolean;
}

/**
 * How a resolved path is written back to the user.
 *
 * MEASURED: pwsh 7.6.5 renders a non-filesystem location with BACKSLASHES on
 * every platform — `Set-Location Env:` then `Get-Location` gives `Env:\`, and
 * `Env:/PATH`, `Env:\PATH` and `Env:PATH` are all accepted on input. So the
 * filesystem drive prints POSIX-style and a provider drive prints
 * PowerShell-style, which looks inconsistent and is what the reference
 * implementation actually does.
 */
export function formatResolved(drive: string, path: string): string {
  if (drive === FILESYSTEM_DRIVE) return path;
  return `${drive}:${path.replaceAll(SEPARATOR, '\\')}`;
}

function resolved(drive: string, path: string, clampedAtRoot = false): ResolvedPath {
  return { drive, path, full: formatResolved(drive, path), clampedAtRoot };
}

/**
 * `Env:/PATH` → drive `Env`, remainder `/PATH`. `/a/b` → no drive.
 *
 * Any leading `name:` is a drive qualifier, which means a Linux file genuinely
 * named `notes:draft` is not addressable as a bare relative path — `./notes:draft`
 * is. That is PowerShell's rule, not an oversight: `Get-Item foo:bar` on Linux
 * looks for a drive named `foo` and reports that it cannot find it.
 */
const DRIVE_QUALIFIER = /^([A-Za-z][A-Za-z0-9_.-]*):(.*)$/s;

interface ParsedPath {
  readonly drive: string | null;
  readonly rooted: boolean;
  readonly home: boolean;
  readonly rest: string;
}

function parsePath(input: string): ParsedPath {
  const qualified = DRIVE_QUALIFIER.exec(input);
  if (qualified !== null) {
    const drive = qualified[1] ?? '';
    // Drive-qualified paths accept `\` as a separator too; non-filesystem
    // providers use it on every platform, so `Env:\PATH` has to work.
    const rest = (qualified[2] ?? '').replaceAll('\\', SEPARATOR);
    return { drive, rooted: true, home: false, rest };
  }
  if (input === '~' || input.startsWith(`~${SEPARATOR}`)) {
    return { drive: null, rooted: false, home: true, rest: input.slice(1) };
  }
  if (input.startsWith(SEPARATOR)) {
    return { drive: null, rooted: true, home: false, rest: input };
  }
  return { drive: null, rooted: false, home: false, rest: input };
}

export interface ResolveContext {
  /** Where relative paths start. */
  readonly cwd: ResolvedPath;
  /** What `~` means. Always on the filesystem drive. */
  readonly home: string;
  /** Which drives exist, for rejecting `Nope:/x`. Case-insensitive lookup. */
  readonly drives: (name: string) => string | null;
}

/**
 * Turn one already-lexed path into a mount and an absolute location.
 *
 * The single resolver PR-10's acceptance criterion asks for: every provider
 * calls this, so `Get-ChildItem Env:/` and `Get-ChildItem /etc` take the same
 * code path and cannot disagree about what `..` means.
 */
export function resolvePath(input: string, context: ResolveContext): Result<ResolvedPath> {
  if (input === '') {
    return invalid('', 'resolve', 'the path is empty', 'empty-path');
  }

  const parsed = parsePath(input);

  const finish = (drive: string, raw: string): Result<ResolvedPath> => {
    const checked = validatePath(raw, 'resolve');
    if (!checked.ok) return checked;
    const walked = normalizeTracked(splitSegments(raw));
    return ok(resolved(drive, SEPARATOR + walked.segments.join(SEPARATOR), walked.clampedAtRoot));
  };

  if (parsed.drive !== null) {
    const canonical = context.drives(parsed.drive);
    if (canonical === null) {
      return invalid(input, 'resolve', `there is no drive named '${parsed.drive}'`, 'unknown-drive');
    }
    return finish(canonical, parsed.rest);
  }

  if (parsed.home) {
    return finish(FILESYSTEM_DRIVE, joinPath(context.home, parsed.rest.replace(/^\//, '')));
  }

  if (parsed.rooted) {
    return finish(FILESYSTEM_DRIVE, parsed.rest);
  }

  return finish(context.cwd.drive, joinPath(context.cwd.path, parsed.rest));
}

// ---------------------------------------------------------------------------
// the mount table
// ---------------------------------------------------------------------------

/**
 * Which backend serves which drive.
 *
 * This exists so PR-10 can add `Env:`, `Variable:` and `Function:` without
 * rewriting path handling. None of them is implemented here — the claim being
 * made is only that they CAN be, and the tests prove it by mounting a second,
 * trivial backend and driving it through the same `VirtualFileSystem`.
 *
 * Drive names are compared case-insensitively (PowerShell's are) while the
 * paths inside them stay case-sensitive (Linux's are). Keeping both rules in
 * one class is why they cannot drift apart.
 */
export class MountTable {
  readonly #mounts = new Map<string, StorageBackend>();
  /** lower-cased name → canonical name, for the case-insensitive lookup. */
  readonly #canonical = new Map<string, string>();

  constructor(filesystem: StorageBackend) {
    this.mount(FILESYSTEM_DRIVE, filesystem);
  }

  mount(drive: string, backend: StorageBackend): void {
    const key = drive.toLowerCase();
    this.#canonical.set(key, drive);
    this.#mounts.set(drive, backend);
  }

  unmount(drive: string): boolean {
    if (drive === FILESYSTEM_DRIVE) {
      throw new Error('the filesystem drive cannot be unmounted');
    }
    const canonical = this.resolveDriveName(drive);
    if (canonical === null) return false;
    this.#canonical.delete(canonical.toLowerCase());
    return this.#mounts.delete(canonical);
  }

  /** `'env'` → `'Env'`, or null when nothing is mounted there. */
  resolveDriveName(drive: string): string | null {
    return this.#canonical.get(drive.toLowerCase()) ?? null;
  }

  backend(drive: string): StorageBackend | null {
    const canonical = this.resolveDriveName(drive);
    if (canonical === null) return null;
    return this.#mounts.get(canonical) ?? null;
  }

  get drives(): readonly string[] {
    return [...this.#mounts.keys()];
  }
}

// ---------------------------------------------------------------------------
// the filesystem commands hold
// ---------------------------------------------------------------------------

export interface VirtualFileSystemOptions {
  readonly home: string;
  readonly cwd?: string;
}

/**
 * The object a command actually gets.
 *
 * Same operation names as `StorageBackend`, one difference: these take paths as
 * the user typed them (already lexed) and resolve them. A command therefore
 * never calls a backend, never knows which mount answered, and does not change
 * when OPFS replaces the memory backend underneath it.
 */
export class VirtualFileSystem {
  readonly #mounts: MountTable;
  readonly #home: string;
  #cwd: ResolvedPath;

  constructor(mounts: MountTable, options: VirtualFileSystemOptions) {
    this.#mounts = mounts;
    this.#home = normalizePath(options.home);
    this.#cwd = resolved(FILESYSTEM_DRIVE, normalizePath(options.cwd ?? options.home));
  }

  get mounts(): MountTable {
    return this.#mounts;
  }

  get home(): string {
    return this.#home;
  }

  /** What `pwd` and `$PWD` report. */
  get location(): ResolvedPath {
    return this.#cwd;
  }

  #context(): ResolveContext {
    return {
      cwd: this.#cwd,
      home: this.#home,
      drives: (name) => this.#mounts.resolveDriveName(name),
    };
  }

  /** Resolve without touching anything. Exposed because completion needs it. */
  resolve(path: string): Result<ResolvedPath> {
    return resolvePath(path, this.#context());
  }

  /** `Set-Location`. Fails unless the target exists and is a directory. */
  async setLocation(path: string): Promise<Result<ResolvedPath>> {
    const target = this.resolve(path);
    if (!target.ok) return target;
    const backend = this.#backendFor(target.value, 'stat');
    if (!backend.ok) return backend;

    const stat = await backend.value.stat(target.value.path);
    if (!stat.ok) return err(relabel(stat.error, target.value));
    if (stat.value.kind !== 'directory') {
      return err({
        code: 'ENOTDIR',
        path: target.value.full,
        syscall: 'stat',
        message: 'not a directory',
        component: basename(target.value.path),
      });
    }
    // POSIX chdir() needs EXECUTE on the target, not read, and not merely
    // execute on everything above it. Without this a directory the user cannot
    // enter still accepts `cd`, and every relative path from there then fails
    // one level too late to explain itself.
    const searchable = await backend.value.access(target.value.path, 'execute');
    if (!searchable.ok) return err(relabel(searchable.error, target.value));

    this.#cwd = target.value;
    return ok(target.value);
  }

  #backendFor(target: ResolvedPath, syscall: StorageSyscall): Result<StorageBackend> {
    const backend = this.#mounts.backend(target.drive);
    if (backend === null) {
      return err({
        code: 'EINVAL',
        path: target.full,
        syscall,
        message: `there is no drive named '${target.drive}'`,
        reason: 'unknown-drive',
      });
    }
    return ok(backend);
  }

  /**
   * Resolve, find the backend, run, and re-label the error with the path the
   * user would recognise.
   *
   * The re-labelling matters: a backend only ever sees its own in-mount path,
   * so an error out of `Env:` would say `/PATH` and the user would look for a
   * file called `/PATH`.
   */
  async #on<T>(
    path: string,
    syscall: StorageSyscall,
    run: (backend: StorageBackend, target: ResolvedPath) => Promise<Result<T>>,
  ): Promise<Result<T>> {
    const target = this.resolve(path);
    if (!target.ok) return target;
    const backend = this.#backendFor(target.value, syscall);
    if (!backend.ok) return backend;
    const outcome = await run(backend.value, target.value);
    if (outcome.ok) return outcome;
    return err(relabel(outcome.error, target.value));
  }

  async stat(path: string): Promise<Result<FileStat>> {
    return this.#on(path, 'stat', async (backend, target) => {
      const stat = await backend.stat(target.path);
      if (!stat.ok) return stat;
      return ok({ ...stat.value, path: target.full });
    });
  }

  async exists(path: string): Promise<boolean> {
    const target = this.resolve(path);
    if (!target.ok) return false;
    const backend = this.#mounts.backend(target.value.drive);
    if (backend === null) return false;
    return backend.exists(target.value.path);
  }

  /** POSIX `access(2)`. What `Test-Path` and completion ask before acting. */
  async access(path: string, permission: Permission): Promise<Result<void>> {
    return this.#on(path, 'stat', async (b, t) => b.access(t.path, permission));
  }

  async readBytes(path: string): Promise<Result<Uint8Array>> {
    return this.#on(path, 'read', async (b, t) => b.readBytes(t.path));
  }

  async readText(path: string): Promise<Result<string>> {
    return this.#on(path, 'read', async (b, t) => b.readText(t.path));
  }

  async writeBytes(
    path: string,
    data: Uint8Array,
    options?: WriteOptions,
  ): Promise<Result<WriteReceipt>> {
    return this.#on(path, 'write', async (b, t) => b.writeBytes(t.path, data, options));
  }

  async writeText(path: string, text: string, options?: WriteOptions): Promise<Result<WriteReceipt>> {
    return this.#on(path, 'write', async (b, t) => b.writeText(t.path, text, options));
  }

  async appendText(path: string, text: string, options?: WriteOptions): Promise<Result<WriteReceipt>> {
    return this.#on(path, 'append', async (b, t) => b.appendText(t.path, text, options));
  }

  async appendBytes(
    path: string,
    data: Uint8Array,
    options?: WriteOptions,
  ): Promise<Result<WriteReceipt>> {
    return this.#on(path, 'append', async (b, t) => b.appendBytes(t.path, data, options));
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<Result<FileStat>> {
    return this.#on(path, 'mkdir', async (b, t) => {
      const made = await b.mkdir(t.path, options);
      if (!made.ok) return made;
      return ok({ ...made.value, path: t.full });
    });
  }

  async readdir(path: string): Promise<Result<readonly DirectoryEntry[]>> {
    return this.#on(path, 'readdir', async (b, t) => {
      const rows = await b.readdir(t.path);
      if (!rows.ok) return rows;
      return ok(
        rows.value.map((entry) => ({
          name: entry.name,
          stat: { ...entry.stat, path: formatResolved(t.drive, entry.stat.path) },
        })),
      );
    });
  }

  async remove(path: string, options?: RemoveOptions): Promise<Result<void>> {
    return this.#on(path, 'remove', async (b, t) => b.remove(t.path, options));
  }

  async chmod(path: string, mode: number): Promise<Result<FileStat>> {
    return this.#on(path, 'chmod', async (b, t) => {
      const changed = await b.chmod(t.path, mode);
      if (!changed.ok) return changed;
      return ok({ ...changed.value, path: t.full });
    });
  }

  async utimes(path: string, times: Times, create = true): Promise<Result<FileStat>> {
    return this.#on(path, 'utimes', async (b, t) => {
      const changed = await b.utimes(t.path, times, create);
      if (!changed.ok) return changed;
      return ok({ ...changed.value, path: t.full });
    });
  }

  /**
   * `rename` and `copy` are the two that can straddle a mount boundary.
   *
   * A rename across mounts is `EXDEV`, exactly as it is on a real machine when
   * you `mv` between filesystems; the shell is expected to fall back to
   * copy-then-delete, and reporting it rather than silently doing the fallback
   * is what lets `mv` keep the right semantics for a partial failure.
   */
  async rename(from: string, to: string, options?: RenameOptions): Promise<Result<void>> {
    const source = this.resolve(from);
    if (!source.ok) return source;
    const destination = this.resolve(to);
    if (!destination.ok) return destination;

    if (source.value.drive !== destination.value.drive) {
      return err({
        code: 'EXDEV',
        path: source.value.full,
        syscall: 'rename',
        message: 'cannot rename across mounts',
        from: source.value.full,
        to: destination.value.full,
      });
    }
    const backend = this.#backendFor(source.value, 'rename');
    if (!backend.ok) return backend;
    const outcome = await backend.value.rename(source.value.path, destination.value.path, options);
    if (outcome.ok) return outcome;
    return err(relabel(outcome.error, source.value));
  }

  async copy(from: string, to: string, options?: CopyOptions): Promise<Result<void>> {
    const source = this.resolve(from);
    if (!source.ok) return source;
    const destination = this.resolve(to);
    if (!destination.ok) return destination;

    if (source.value.drive !== destination.value.drive) {
      return err({
        code: 'EXDEV',
        path: source.value.full,
        syscall: 'copy',
        message: 'cross-mount copy is not implemented; read and write instead',
        from: source.value.full,
        to: destination.value.full,
      });
    }
    const backend = this.#backendFor(source.value, 'copy');
    if (!backend.ok) return backend;
    const outcome = await backend.value.copy(source.value.path, destination.value.path, options);
    if (outcome.ok) return outcome;
    return err(relabel(outcome.error, source.value));
  }

  /** Quota for one drive; the filesystem drive when none is named. */
  async quota(drive = FILESYSTEM_DRIVE): Promise<Result<QuotaUsage>> {
    const backend = this.#mounts.backend(drive);
    if (backend === null) {
      return err({
        code: 'EINVAL',
        path: drive,
        syscall: 'quota',
        message: `there is no drive named '${drive}'`,
        reason: 'unknown-drive',
      });
    }
    return backend.quota();
  }
}

/**
 * Rewrite a backend's in-mount path into the drive-qualified one.
 *
 * A structural rebuild per arm rather than `{ ...error, path }`, because
 * `StorageError` is a union and spreading it would widen every arm's extra
 * fields into optional ones — which is how a discriminated union quietly stops
 * discriminating.
 */
function relabel(error: StorageError, target: ResolvedPath): StorageError {
  if (target.drive === FILESYSTEM_DRIVE) return error;
  return { ...error, path: formatResolved(target.drive, error.path) };
}

// ---------------------------------------------------------------------------
// the seed / overlay split
// ---------------------------------------------------------------------------

/**
 * THE SPLIT, AND WHY IT IS THE WAY IT IS.
 *
 * v1's model, preserved here because it solves a real problem correctly:
 *
 *   1. the seed tree is REBUILT FROM SCRATCH on every boot;
 *   2. the persisted blob holds only what the user changed;
 *   3. boot grafts (2) onto (1).
 *
 * The alternative — persist the whole tree, load it back — is what v1 started
 * with and abandoned, and its comment says why: a returning visitor would be
 * frozen on the tree from the day they first loaded the page, and would never
 * see a file added to the portfolio afterwards. That is not a storage
 * subtlety, it is the difference between a site that updates and one that
 * looks broken to exactly the people who come back.
 *
 * The graft rules, from v1's `graftUser`, each preserved:
 *
 *   - a USER file is restored in full, content included;
 *   - a SEED file gets only its metadata back (mode, mtime). Its content comes
 *     from this version of the seed, so an updated `README.md` is what a
 *     returning visitor sees;
 *   - a user directory absent from the seed is created;
 *   - a directory in both keeps the user's mode and mtime, and the walk
 *     descends;
 *   - if the seed has since replaced a directory with a file of the same name,
 *     THE SEED WINS. The site's shape is authoritative.
 *
 * THE LIMITATION THIS INHERITS, stated rather than discovered later: DELETING A
 * SEED FILE DOES NOT PERSIST. `rm ~/README.md` then reload, and it is back,
 * because the overlay records what exists and not what was removed. v1 documents
 * the same trade-off and points at `Reset-FileSystem`. Fixing it needs
 * tombstones — a recorded "this seed path was deleted" — and the place they
 * attach is the snapshot's entry list, as a third entry kind alongside file and
 * directory. Not done here: it changes the persisted format, and the format is
 * versioned precisely so that change can be made later without guessing.
 *
 * The seed itself is installed by `StorageBackend.installImage`, which is
 * privileged and bypasses permission checks — `/etc` is root-owned, and the
 * image predates the user. The graft is `importSnapshot` in `snapshot.ts`,
 * which runs afterwards as the user and therefore cannot smuggle in a node the
 * user could not have created.
 */
export const SEED_OVERLAY_NOTE =
  'The seed tree is rebuilt on every boot and the overlay is grafted on top, so ' +
  'portfolio updates reach returning visitors while their own files survive. ' +
  'Deleting a seed file does not persist; use Reset-FileSystem to start over.';
