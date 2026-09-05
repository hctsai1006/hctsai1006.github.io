/**
 * support.ts — the plumbing the twelve filesystem WRITE commands share.
 *
 * Four jobs, each closing a specific way this set could lie:
 *
 *   1. MANIFESTS ARE READ, NOT WRITTEN. `fsWriteManifest` looks the command up
 *      in `src/commands/manifests.json` — the generated file — and refuses
 *      anything that is not `browser-backed` or that does not declare BOTH
 *      `filesystem.read` and `filesystem.write`. Nothing here may state its own
 *      fidelity, risk, capabilities, aliases or captured parameter metadata.
 *      `src/commands/simulated/support.ts` established the pattern and the
 *      reason: a command that declared them locally could quietly disagree with
 *      the classification a reviewer read.
 *
 *      The ONE thing layered on top is `notes`. The generated file carries none
 *      for these entries, and several of these commands need one — `chown`
 *      cannot change an owner in a browser and has to say so where
 *      `Get-Command -Detailed` will print it. Adding the note in code rather
 *      than editing the generated file keeps the generator the single author of
 *      everything it generates, and the note is required rather than optional:
 *      `fsWriteManifest` throws without one.
 *
 *   2. THE FILESYSTEM IS NULLABLE AND THAT IS NOT A CRASH.
 *      `InvocationContext.fs` is `FileSystemPort | null` — null when the host
 *      runs headless, which is the normal case for tests. `requireFileSystem`
 *      turns that into one ErrorRecord naming the reason, so a visitor sees a
 *      sentence instead of a stack.
 *
 *   3. A `Result` IS NOT AN EXCEPTION. Every storage call returns
 *      `Result<T, StorageError>`, and every failure has to become an
 *      `ErrorRecord` on stream 2 with the id, category and exception type real
 *      PowerShell produces. `storageShape` is the map, and every arm cites
 *      where it came from — measured against pwsh 7.6.5, taken from v1, or
 *      declared as ours because the reference implementation has no analogue.
 *
 *   4. NO COMMAND CALLS `requireCapability`. The port does it on every call.
 *      `tests/unit/ports.test.mts` proves a read-only command is refused every
 *      write, and asking twice would only make the second ask look like the
 *      enforcement.
 *
 * ---------------------------------------------------------------------------
 * A CONTRACT GAP, RECORDED RATHER THAN WORKED AROUND SILENTLY
 * ---------------------------------------------------------------------------
 *
 * `FileSystemPort` exposes no `copy`, though `VirtualFileSystem.copy` and
 * `StorageBackend.copy` both exist and the memory backend implements copy as a
 * single PLAN/VALIDATE/APPLY mutation — the one that guarantees a copy failing
 * on its ninth file leaves the destination exactly as it was. `Copy-Item` and
 * `cp` therefore cannot be atomic here: they must walk the source and write the
 * pieces through `mkdir` and `writeBytes`. What that costs, and what is done to
 * limit it, is written at the top of `copy-item.ts`.
 */

import manifestsJson from '../manifests.json' with { type: 'json' };

import { NEWLINE } from '../format/out-string.ts';
import { psObject } from '../../pipeline/psobject.ts';
import type { PSObject, PSValue } from '../../pipeline/psobject.ts';
import { toPSString } from '../../pipeline/psobject.ts';
import { errorRecord } from '../../pipeline/streams.ts';
import type { ErrorCategory, ErrorRecord } from '../../pipeline/streams.ts';
import type { BindingResult, InvocationContext } from '../invocation.ts';
import type { Capability, CommandManifest } from '../manifest.ts';
import type { FileSystemPort } from '../ports.ts';
import { basename, dirname, formatMode } from '../../storage/index.ts';
import type { FileStat, StorageError } from '../../storage/index.ts';

// ---------------------------------------------------------------------------
// manifests
// ---------------------------------------------------------------------------

/**
 * The slice of the generated file this module reads back. Declared locally, as
 * `simulated/support.ts` does, so that widening `CommandManifest` cannot
 * silently widen what a runtime cast is claiming.
 */
interface ManifestsFile {
  readonly commands: readonly CommandManifest[];
}

const ALL_MANIFESTS: readonly CommandManifest[] = (manifestsJson as unknown as ManifestsFile)
  .commands;

const REQUIRED: readonly Capability[] = ['filesystem.read', 'filesystem.write'];

/**
 * Fetch one generated manifest, attach the note, and refuse anything that does
 * not belong in this directory.
 *
 * Throwing at module load is deliberate and copied from `simulatedManifest`:
 * the alternative — a placeholder — produces a command that runs, writes to a
 * visitor's files, and misdeclares what it is allowed to do.
 */
export function fsWriteManifest(name: string, notes: string): CommandManifest {
  const found = ALL_MANIFESTS.find((m) => m.name === name);
  if (found === undefined) {
    throw new Error(
      `No manifest named '${name}' in src/commands/manifests.json. Manifests are generated ` +
        'from classification.data.mts; add the classification rather than declaring one here.',
    );
  }
  if (found.fidelity !== 'browser-backed') {
    throw new Error(
      `'${name}' is classified ${found.fidelity}, not browser-backed. A command that really ` +
        'writes bytes must say so, and one that does not must not live in src/commands/fs-write/.',
    );
  }
  const missing = REQUIRED.filter((c) => !found.capabilities.includes(c));
  if (missing.length > 0) {
    throw new Error(
      `'${name}' does not declare ${missing.join(' and ')}. Every call this command makes goes ` +
        'through the brokered FileSystemPort, which requires the matching capability, so an ' +
        'undeclared one is a command that cannot run rather than a command with fewer rights.',
    );
  }
  if (notes.trim() === '') {
    throw new Error(
      `'${name}' was given no notes. These commands change a visitor's files; where the ` +
        'behaviour was measured, where it follows v1, and what is not implemented all have to ' +
        'be printable by Get-Command -Detailed.',
    );
  }
  // A module exists, so the command is implemented — regardless of what the
  // generated file says. Stated here rather than read back from `found`,
  // because the generator derives `implementationStatus` FROM the modules: a
  // manifest that inherited its own status would be a feedback loop, and the
  // first stale run would demote every command in this directory to 'declared'
  // and unregister it.
  return { ...found, notes, implementationStatus: 'implemented' };
}

// ---------------------------------------------------------------------------
// reaching the filesystem
// ---------------------------------------------------------------------------

/**
 * The port, or one ErrorRecord saying why there is none.
 *
 * Null is a real configuration, not a bug: the kernel is headless and the
 * embedder supplies storage. A command that assumed otherwise would throw a
 * TypeError out of `invoke`, which the pipeline turns into a failed stage with
 * no ErrorRecord at all — the visitor would see the command stop and be told
 * nothing.
 */
export async function requireFileSystem(
  context: InvocationContext,
  manifest: CommandManifest,
): Promise<FileSystemPort | null> {
  if (context.fs !== null) return context.fs;
  await context.streams.error.write(
    errorRecord(
      `${manifest.display} cannot run: this session has no filesystem. The host did not supply ` +
        'storage, so there is nothing to write to.',
      'FileSystemNotAvailable',
      manifest.display,
      'ResourceUnavailable',
      { exceptionType: 'System.InvalidOperationException' },
    ),
  );
  return null;
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

/** What an ErrorRecord needs beyond the command name. */
export interface PSErrorShape {
  readonly id: string;
  readonly category: ErrorCategory;
  readonly exceptionType: string;
  readonly message: string;
}

/**
 * The four ids one PowerShell provider command uses, which differ per command
 * and were read off pwsh 7.6.5 rather than guessed. See each command's file for
 * the probe that produced them.
 */
export interface ProviderErrorIds {
  /** Surfacing a `System.IO.IOException`. */
  readonly io: string;
  /** Surfacing a `System.UnauthorizedAccessException`. */
  readonly access: string;
  /** The path does not exist at all. */
  readonly notFound: string;
  /** The provider itself rejected the request. */
  readonly argument: string;
}

const IO_EXCEPTION = 'System.IO.IOException';
const UNAUTHORIZED = 'System.UnauthorizedAccessException';
const DIRECTORY_NOT_FOUND = 'System.IO.DirectoryNotFoundException';
const ITEM_NOT_FOUND = 'System.Management.Automation.ItemNotFoundException';
const ARGUMENT_EXCEPTION = 'System.Management.Automation.PSArgumentException';

/** The wordings pwsh 7.6.5 produced, kept in one place so they cannot drift. */
export const MESSAGES = {
  /** MEASURED: Copy-Item / Move-Item / Rename-Item on a missing source. */
  cannotFindPath: (path: string): string =>
    `Cannot find path '${path}' because it does not exist.`,
  /** MEASURED: New-Item, Set-Content, Copy-Item on a missing destination parent. */
  couldNotFindPart: (path: string): string => `Could not find a part of the path '${path}'.`,
  /** MEASURED: New-Item onto an existing directory; Copy-Item onto a read-only file. */
  accessDenied: (path: string): string => `Access to the path '${path}' is denied.`,
  /** MEASURED: New-Item -ItemType File onto an existing file. */
  fileExists: (path: string): string => `The file '${path}' already exists.`,
  /**
   * MEASURED: New-Item -ItemType Directory onto anything that exists, and
   * Copy-Item -Recurse over a directory that is already there. Note the missing
   * quotes around the path — that is what pwsh prints.
   */
  itemExists: (path: string): string => `An item with the specified name ${path} already exists.`,
  /**
   * MEASURED via the localised zh-TW form 「當檔案已存在時，無法建立該檔案。」,
   * which is .NET's translation of this sentence; v1 uses the English wording
   * verbatim for the same case.
   */
  fileAlreadyExists: (): string => 'Cannot create a file when that file already exists.',
  /** MEASURED: Rename-Item onto an existing name. */
  cannotCreate: (path: string): string =>
    `Cannot create '${path}' because a file or directory with the same name already exists.`,
  /** MEASURED: Copy-Item source and destination the same path. */
  overwriteWithItself: (path: string): string => `Cannot overwrite the item ${path} with itself.`,
} as const;

/**
 * `StorageError` → the ErrorRecord shape, for a provider command.
 *
 * Every one of the twelve `StorageErrorCode` members is here. That is the point
 * of the exhaustive switch: `STORAGE_ERROR_CODES` says every member is
 * producible by the in-memory backend, so an unhandled arm is a failure a
 * visitor would see as a blank.
 *
 * A command with a MEASURED shape for a particular code overrides this by
 * checking that code before calling here; the arms below are the fallbacks, and
 * each says where it came from.
 */
export function storageShape(error: StorageError, ids: ProviderErrorIds): PSErrorShape {
  switch (error.code) {
    case 'ENOENT':
      // MEASURED: `Copy-Item ghost.txt out.txt` -> PathNotFound / ObjectNotFound /
      // ItemNotFoundException. The same shape appeared for Move-Item and
      // Rename-Item, so it is the provider's rule and not one command's.
      return {
        id: ids.notFound,
        category: 'ObjectNotFound',
        exceptionType: ITEM_NOT_FOUND,
        message: MESSAGES.cannotFindPath(error.path),
      };
    case 'EEXIST':
      // MEASURED: `New-Item -ItemType File` onto an existing file gives
      // IOException / WriteError. Which of the two "already exists" wordings a
      // command uses depends on the command and is decided at the call site.
      return {
        id: ids.io,
        category: 'WriteError',
        exceptionType: IO_EXCEPTION,
        message:
          error.existing === 'directory'
            ? MESSAGES.itemExists(error.path)
            : MESSAGES.fileExists(error.path),
      };
    case 'ENOTDIR':
      // A path component that has to be a directory is a file. .NET reports
      // this as DirectoryNotFoundException — the same class it uses for a
      // missing parent — because from the API's side the directory is not
      // there either way. MEASURED for the missing-parent half; the
      // component-is-a-file half is the same call in .NET and is not separately
      // reachable through pwsh on a real filesystem.
      return {
        id: ids.io,
        category: 'WriteError',
        exceptionType: DIRECTORY_NOT_FOUND,
        message: MESSAGES.couldNotFindPart(error.path),
      };
    case 'EISDIR':
      // MEASURED: `New-Item -ItemType File` onto an existing directory gives
      // UnauthorizedAccessException / PermissionDenied — not an "is a
      // directory" error. That is Windows opening a directory as a file, and it
      // is what the reference implementation reports, so it is what is
      // reproduced rather than the POSIX-shaped answer that looks more correct.
      return {
        id: ids.access,
        category: 'PermissionDenied',
        exceptionType: UNAUTHORIZED,
        message: MESSAGES.accessDenied(error.path),
      };
    case 'ENOTEMPTY':
      // MEASURED: `Rename-Item` a directory onto an existing directory reports
      // "Cannot create '<p>' because a file or directory with the same name
      // already exists." with RenameItemIOError / WriteError.
      return {
        id: ids.io,
        category: 'WriteError',
        exceptionType: IO_EXCEPTION,
        message: MESSAGES.cannotCreate(error.path),
      };
    case 'EACCES':
      // MEASURED: Copy-Item onto a read-only file ->
      // CopyFileInfoItemUnauthorizedAccessError / PermissionDenied.
      return {
        id: ids.access,
        category: 'PermissionDenied',
        exceptionType: UNAUTHORIZED,
        message: MESSAGES.accessDenied(error.path),
      };
    case 'ENOSPC':
      // OURS, and labelled as ours. pwsh has no measurable analogue: a browser
      // quota is not a disk, and filling a real one to read the error back was
      // not a probe worth running on the capture host. What matters is the
      // requirement the storage layer states — the visitor must be TOLD rather
      // than silently truncated — so the numbers travel in the message and the
      // category is the one the ErrorCategory union already has for this,
      // QuotaExceeded, which `-ErrorAction` can filter on. The id is prefixed
      // with the command name the same way pwsh composes its own.
      return {
        id: 'QuotaExceeded',
        category: 'QuotaExceeded',
        exceptionType: IO_EXCEPTION,
        message:
          `There is not enough space to write '${error.path}'. ` +
          `${String(error.usage.used)} bytes are in use` +
          (error.usage.quota === null ? '' : ` of a ${String(error.usage.quota)} byte quota`) +
          `. Nothing further was written.`,
      };
    case 'EINVAL':
      // The provider rejecting the request itself. MEASURED shape:
      // `Rename-Item -NewName 'sub/x'` -> Argument / InvalidArgument /
      // PSArgumentException. The reason travels in the message because the
      // caller cannot re-derive it.
      return {
        id: ids.argument,
        category: 'InvalidArgument',
        exceptionType: ARGUMENT_EXCEPTION,
        message: `The path '${error.path}' cannot be used: ${error.reason}.`,
      };
    case 'ENAMETOOLONG':
      // DERIVED, not measured. .NET raises PathTooLongException, which derives
      // from IOException, so it takes the provider's IOException id. Probing it
      // on the capture host would have measured Windows' MAX_PATH rather than
      // the Linux NAME_MAX/PATH_MAX this filesystem enforces.
      return {
        id: ids.io,
        category: 'WriteError',
        exceptionType: 'System.IO.PathTooLongException',
        message:
          `The path '${error.path}' is too long: ${String(error.actual)} exceeds the ` +
          `${String(error.limit)} character limit.`,
      };
    case 'EXDEV':
      // OURS. A rename across two mounts is EXDEV, and the shell is expected to
      // fall back to copy-then-delete — which these commands CANNOT do, because
      // none of them declares `filesystem.delete` and the port refuses the call.
      // Saying so is the honest outcome; silently copying and leaving the
      // source behind would be a wrong answer dressed as success.
      return {
        id: ids.argument,
        category: 'InvalidOperation',
        exceptionType: IO_EXCEPTION,
        message:
          `Cannot move '${error.from}' to '${error.to}': they are on different mounts. ` +
          'Completing it needs a copy followed by a delete, and this command is not granted ' +
          'filesystem.delete.',
      };
    case 'EROFS':
      // OURS in wording, PowerShell's in shape: a refusal to write is
      // UnauthorizedAccessException / PermissionDenied, which is MEASURED. The
      // mount name is added because "denied" alone does not say the whole mount
      // is read-only.
      return {
        id: ids.access,
        category: 'PermissionDenied',
        exceptionType: UNAUTHORIZED,
        message: `${MESSAGES.accessDenied(error.path)} The mount '${error.mount}' is read-only.`,
      };
    case 'EIO':
      // The backend failed underneath us. Never expected; always possible —
      // OPFS throws DOMException on a truncated or evicted store. Reported as
      // the provider's IOException rather than swallowed, and the cause is kept
      // because it is the only thing that makes it diagnosable.
      return {
        id: ids.io,
        category: 'WriteError',
        exceptionType: IO_EXCEPTION,
        message: `The storage backend failed on '${error.path}': ${error.cause}`,
      };
  }
}

/** Turn a shape into the record stream 2 carries. */
export function recordOf(
  shape: PSErrorShape,
  manifest: CommandManifest,
  target: PSValue,
): ErrorRecord {
  return errorRecord(shape.message, shape.id, providerCommandName(manifest), shape.category, {
    exceptionType: shape.exceptionType,
    targetObject: target,
  });
}

/**
 * The name pwsh puts after the comma in a FullyQualifiedErrorId.
 *
 * MEASURED: it is the .NET COMMAND CLASS, not the display name —
 * `NewItemIOError,Microsoft.PowerShell.Commands.NewItemCommand`. The six
 * cmdlets here have such a class; `cp`, `mv`, `mkdir`, `touch`, `chmod` and
 * `chown` do not, because in real PowerShell on Linux they are external
 * binaries with no ErrorRecord at all, so those use their own name.
 */
export function providerCommandName(manifest: CommandManifest): string {
  const cmdlet = CMDLET_CLASSES[manifest.name];
  return cmdlet ?? manifest.display;
}

/**
 * MEASURED, one probe per entry: the class name pwsh 7.6.5 composed into each
 * FullyQualifiedErrorId. Not derived from the display name, because
 * `Add-Content` is `AddContentCommand` while `New-Item` is `NewItemCommand` and
 * a rule that produced both would be a coincidence rather than a rule.
 */
const CMDLET_CLASSES: Readonly<Record<string, string | undefined>> = {
  'new-item': 'Microsoft.PowerShell.Commands.NewItemCommand',
  'set-content': 'Microsoft.PowerShell.Commands.SetContentCommand',
  'add-content': 'Microsoft.PowerShell.Commands.AddContentCommand',
  'copy-item': 'Microsoft.PowerShell.Commands.CopyItemCommand',
  'move-item': 'Microsoft.PowerShell.Commands.MoveItemCommand',
  'rename-item': 'Microsoft.PowerShell.Commands.RenameItemCommand',
};

/** Write one storage failure to stream 2 and carry on. */
export async function reportStorage(
  context: InvocationContext,
  manifest: CommandManifest,
  error: StorageError,
  ids: ProviderErrorIds,
  target: PSValue,
): Promise<void> {
  await context.streams.error.write(recordOf(storageShape(error, ids), manifest, target));
}

/** Write one message of the command's own devising to stream 2. */
export async function reportError(
  context: InvocationContext,
  manifest: CommandManifest,
  shape: PSErrorShape,
  target: PSValue,
): Promise<void> {
  await context.streams.error.write(recordOf(shape, manifest, target));
}

// ---------------------------------------------------------------------------
// the objects these commands emit
// ---------------------------------------------------------------------------

/**
 * MEASURED type chains. `New-Item -ItemType File` reported
 * `System.IO.FileInfo | System.IO.FileSystemInfo | System.MarshalByRefObject |
 * System.Object`, and the Directory form the same chain with DirectoryInfo at
 * the front.
 */
export const FILE_INFO_TYPE_NAMES: readonly string[] = [
  'System.IO.FileInfo',
  'System.IO.FileSystemInfo',
  'System.MarshalByRefObject',
  'System.Object',
];

export const DIRECTORY_INFO_TYPE_NAMES: readonly string[] = [
  'System.IO.DirectoryInfo',
  'System.IO.FileSystemInfo',
  'System.MarshalByRefObject',
  'System.Object',
];

/** The provider prefix pwsh puts on PSPath, read off a real FileInfo. */
const PROVIDER_PREFIX = 'Microsoft.PowerShell.Core\\FileSystem::';

/**
 * A FileInfo or DirectoryInfo, as far as this project can honestly build one.
 *
 * WHAT IS HERE is backed by a real `FileStat`. WHAT IS DELIBERATELY ABSENT,
 * rather than invented — pwsh 7.6.5 reports 30 members on a FileInfo and this
 * carries 14 of them:
 *
 *   Mode, ModeWithoutHardLink   a Windows FileAttributes rendering. The
 *                               emulated machine is Ubuntu, where the useful
 *                               answer is `UnixMode`, which IS here. Measuring
 *                               `Mode` needed a Linux pwsh the capture host is
 *                               not.
 *   Attributes, IsReadOnly      the same, as an enum and a bit.
 *   VersionInfo                 assembly version metadata of a binary.
 *   Target, LinkType,           there are no symbolic links; `StatKind` has two
 *   LinkTarget, ResolvedTarget  members and inventing a third would be a lie
 *                               the type system would not catch.
 *   PSDrive, PSProvider         real objects in pwsh; `get-location.ts` builds
 *                               them and this does not duplicate that shape.
 *   LastAccessTime, *Utc        `FileStat` carries mtime, ctime and birthtime.
 *                               There is no atime to report.
 *   Directory, Parent, Root     nested FileSystemInfo objects, each of which is
 *                               another stat. `DirectoryName` is the same fact
 *                               as a string and is here.
 *
 * The manifest notes of every command that emits one say the same thing, so a
 * visitor reading `Get-Command -Detailed` is told before they pipe it into
 * something that wants `Attributes`.
 */
export function fileSystemInfo(stat: FileStat): PSObject {
  const directory = stat.kind === 'directory';
  const parent = dirname(stat.path);
  const name = stat.name === '' ? basename(stat.path) : stat.name;
  const dot = name.lastIndexOf('.');
  // .NET: a leading dot is not an extension separator, so `.bashrc` has no
  // extension and its BaseName is the whole name.
  const extension = dot > 0 ? name.slice(dot) : '';
  const base = extension === '' ? name : name.slice(0, dot);

  const common: Record<string, PSValue> = {
    PSPath: `${PROVIDER_PREFIX}${stat.path}`,
    PSParentPath: `${PROVIDER_PREFIX}${parent}`,
    PSChildName: name,
    PSIsContainer: directory,
    UnixMode: formatMode(stat.mode, stat.kind),
    User: stat.owner,
    Group: stat.group,
    BaseName: directory ? name : base,
    Name: name,
    FullName: stat.path,
    Extension: directory ? '' : extension,
    Exists: true,
    CreationTime: new Date(stat.birthtime),
    LastWriteTime: new Date(stat.mtime),
  };

  if (directory) return psObject(common, DIRECTORY_INFO_TYPE_NAMES);
  return psObject(
    { ...common, Length: stat.size, DirectoryName: parent },
    FILE_INFO_TYPE_NAMES,
  );
}

// ---------------------------------------------------------------------------
// content
// ---------------------------------------------------------------------------

export { NEWLINE };

/**
 * `-Value` flattened to the lines that will be written.
 *
 * MEASURED, and both halves surprised the first draft:
 *
 *   Set-Content -Value @('a', @('b','c'), 'd')  ->  a\nb\nc\nd\n
 *
 * so a NESTED array is flattened all the way rather than one level, which is
 * the opposite of what the pipeline does with the same literal. And
 *
 *   Set-Content -Value 42                       ->  42
 *   Set-Content -Value $true                    ->  True
 *   Set-Content -Value ([pscustomobject]@{A=1;B='x'})  ->  @{A=1; B=x}
 *
 * so each element is rendered with PowerShell's own ToString, which is
 * `toPSString` — the single rendering this repo keeps, not a second one.
 */
export function contentLines(value: PSValue | undefined): readonly string[] {
  if (value === undefined) return [];
  const out: string[] = [];
  const walk = (item: PSValue): void => {
    if (Array.isArray(item)) {
      for (const child of item as readonly PSValue[]) walk(child);
      return;
    }
    out.push(toPSString(item));
  };
  walk(value);
  return out;
}

/**
 * The bytes-worth of text those lines become.
 *
 * MEASURED: `-NoNewline` does NOT merely drop the trailing terminator, it drops
 * ALL of them — `Set-Content -Value @('a','b','c') -NoNewline` is `abc`, three
 * bytes. Without it every element is followed by one, including the last.
 *
 * The terminator is `\n`, not the `\r\n` the capture host produced. The
 * emulated machine is Ubuntu and `format/out-string.ts` already pins `NEWLINE`
 * to `\n` for the same reason; a second answer here would make
 * `Set-Content x; Get-Content x | Out-String` disagree with itself.
 */
export function contentBody(lines: readonly string[], noNewline: boolean): string {
  return noNewline ? lines.join('') : lines.map((line) => line + NEWLINE).join('');
}

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

/**
 * The tokens after the command name.
 *
 * `cp`, `mv`, `mkdir`, `touch`, `chmod` and `chown` declare no parameters,
 * which the binder treats as "everything is remaining" — the same arrangement
 * `simulated/support.ts` documents. That is correct rather than lazy: `mkdir -p`
 * and `chmod u+x` are not PowerShell parameter syntax, and binding them as if
 * they were would invent metadata the reference implementation never reported.
 */
export function argumentsOf(bound: BindingResult): readonly string[] {
  return bound.remaining;
}

/** v1's `stripQ`: one leading and one trailing quote, nothing cleverer. */
export function stripQuotes(text: string): string {
  return text.replace(/^["']|["']$/gu, '');
}

/** Operands, in order, with the dash-led tokens removed. v1's filter exactly. */
export function operandsOf(args: readonly string[]): readonly string[] {
  return args.filter((token) => !token.startsWith('-')).map(stripQuotes);
}

// ---------------------------------------------------------------------------
// exit codes
// ---------------------------------------------------------------------------

export const EXIT_SUCCESS = 0;
export const EXIT_FAILURE = 1;

/**
 * A command that wrote to stream 2 exits 1, one that did not exits 0 — the rule
 * `simulated/support.ts` states, and the one the six cmdlets need too: every
 * failure measured above was NON-TERMINATING, so `New-Item a,exists,c` created
 * two files, wrote one error, and still had to report that something failed.
 */
export function exitFor(failures: number): number {
  return failures > 0 ? EXIT_FAILURE : EXIT_SUCCESS;
}

// ---------------------------------------------------------------------------
// cancellation
// ---------------------------------------------------------------------------

/**
 * Whether to stop, checked before every item.
 *
 * Deliberately NOT `throwIfCancelled`. These commands mutate a visitor's files,
 * and the difference between "cancelled after four of nine" and "threw" is the
 * difference between a state that can be described and one that cannot. So a
 * cancelled write stops the loop, reports how far it got, and returns —
 * `$LASTEXITCODE` is 1 and stream 2 says where it stopped.
 */
export function cancelled(context: InvocationContext): boolean {
  return context.signal.aborted;
}

/** The record a cancelled mutation leaves behind. */
export function cancellationShape(done: readonly string[]): PSErrorShape {
  return {
    id: 'OperationStopped',
    category: 'OperationStopped',
    exceptionType: 'System.OperationCanceledException',
    message:
      done.length === 0
        ? 'The operation was cancelled before anything was written.'
        : `The operation was cancelled after writing ${String(done.length)} item(s): ` +
          `${done.join(', ')}. Nothing beyond that was attempted.`,
  };
}
