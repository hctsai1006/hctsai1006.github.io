/**
 * support.ts — the plumbing the ten filesystem READ commands share.
 *
 * Everything here was measured against a real `pwsh 7.6.5` (Windows, .NET
 * 10.0.11) before it was written. The probe scripts and their transcripts are
 * quoted inline as `pwsh:` comments; where the reference implementation could
 * not be asked — because the behaviour is Unix-only and the only pwsh available
 * runs on Windows — the note says so and names v1 as the specification instead,
 * which is what the brief requires.
 *
 * FOUR RULES THIS DIRECTORY OBEYS, EACH FOR A REASON THAT COST SOMETHING:
 *
 *   1. STORAGE IS REACHED ONLY THROUGH `context.fs`. That is a `FileSystemPort`,
 *      which asks the broker on every call. No command here calls
 *      `requireCapability` itself: the port already does, and a command that
 *      called it as well would be claiming a guarantee it does not provide.
 *      `filesystem.read` is declared in manifests.json and the broker enforces
 *      it — `tests/unit/ports.test.mts` proves a reader is refused every write.
 *
 *   2. `context.fs` IS NULLABLE AND THE NULL IS REAL. Nothing in the repository
 *      supplies one yet: `src/pipeline/pipeline.ts` and `src/kernel/kernel.ts`
 *      both hard-code `fs: null`. So the null branch is the branch that
 *      currently runs in the shipped kernel, and it must produce an ErrorRecord
 *      rather than a TypeError.
 *
 *   3. A STORAGE FAILURE IS A `Result`, NOT A THROW. `storageErrorRecord` turns
 *      one into the ErrorRecord pwsh produces for the same condition, and every
 *      arm cites where the mapping came from. Callers CONTINUE afterwards,
 *      because pwsh continues:
 *
 *        pwsh: Get-Content nope.txt, notrail.txt  ->  1 error, 1 line emitted
 *
 *   4. OBJECTS, NEVER RENDERED TEXT. The cmdlets emit PSObjects. The five Unix
 *      tools emit STRINGS, because that is what a coreutils program writes to
 *      stdout — `simulated/support.ts` makes the same distinction, and the thing
 *      actually forbidden is v1's `{cls, txt}` row, which put a CSS class into
 *      the pipeline.
 */

import manifestsJson from '../manifests.json' with { type: 'json' };

import {
  basename,
  dirname,
  formatMode,
  formatResolved,
  joinPath,
  splitSegments,
} from '../../storage/index.ts';
import type { DirectoryEntry, FileStat, Result, StorageError } from '../../storage/index.ts';
import type { ResolvedPath } from '../../storage/vfs.ts';
import { compareValues, psObject } from '../../pipeline/psobject.ts';
import type { PSObject, PSValue } from '../../pipeline/psobject.ts';
import { errorRecord } from '../../pipeline/streams.ts';
import type { ErrorCategory, ErrorRecord, Sink } from '../../pipeline/streams.ts';
import type { InvocationContext } from '../invocation.ts';
import type { CommandManifest } from '../manifest.ts';
import type { FileSystemPort } from '../ports.ts';
import { hasWildcard, wildcardPattern } from '../powershell/support.ts';

// ---------------------------------------------------------------------------
// manifests
// ---------------------------------------------------------------------------

interface ManifestsFile {
  readonly commands: readonly CommandManifest[];
}

const ALL_MANIFESTS: readonly CommandManifest[] = (manifestsJson as unknown as ManifestsFile)
  .commands;

/**
 * Fetch one manifest out of the generated file, and refuse anything that is not
 * a filesystem reader.
 *
 * Read, never written — the same rule `simulated/support.ts` follows, and for
 * the same reason: a command that stated its own capabilities could disagree
 * with the classification a reviewer read, and `Get-Command -Detailed` would
 * then print one thing while the broker enforced another.
 *
 * The second check is the one that matters here. A command in this directory
 * must declare `filesystem.read` and must NOT declare write or delete: the whole
 * point of the port is that a reader cannot write, and a manifest that asked for
 * more would quietly widen every command in the file.
 */
export function fsReadManifest(name: string): CommandManifest {
  const found = ALL_MANIFESTS.find((m) => m.name === name);
  if (found === undefined) {
    throw new Error(
      `No manifest named '${name}' in src/commands/manifests.json. Manifests are generated ` +
        'from classification.data.mts; add the classification rather than declaring one here.',
    );
  }
  if (!found.capabilities.includes('filesystem.read')) {
    throw new Error(
      `'${name}' does not declare filesystem.read, so the broker would refuse its first stat. ` +
        'It does not belong in src/commands/fs-read/.',
    );
  }
  for (const forbidden of ['filesystem.write', 'filesystem.delete'] as const) {
    if (found.capabilities.includes(forbidden)) {
      throw new Error(
        `'${name}' declares ${forbidden}. Every command in src/commands/fs-read/ is a reader; ` +
          'a writer belongs elsewhere.',
      );
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// command identity
// ---------------------------------------------------------------------------

/**
 * What an ErrorRecord needs to name the command.
 *
 * `dotNetType` is the class name the reference implementation puts after the
 * comma in `FullyQualifiedErrorId`, and scripts match on the composed form:
 *
 *   pwsh: Get-Content nope.txt      ->  PathNotFound,Microsoft.PowerShell.Commands.GetContentCommand
 *   pwsh: Get-ChildItem nope        ->  PathNotFound,Microsoft.PowerShell.Commands.GetChildItemCommand
 *
 * The five Unix tools have no .NET class because they are not cmdlets; they use
 * their own name, which is what a native program's diagnostics carry.
 */
export interface CommandIdentity {
  readonly display: string;
  readonly dotNetType: string;
}

export const GET_CHILDITEM: CommandIdentity = {
  display: 'Get-ChildItem',
  dotNetType: 'Microsoft.PowerShell.Commands.GetChildItemCommand',
};
export const GET_CONTENT: CommandIdentity = {
  display: 'Get-Content',
  dotNetType: 'Microsoft.PowerShell.Commands.GetContentCommand',
};
export const SELECT_STRING: CommandIdentity = {
  display: 'Select-String',
  dotNetType: 'Microsoft.PowerShell.Commands.SelectStringCommand',
};
export const TEST_PATH: CommandIdentity = {
  display: 'Test-Path',
  dotNetType: 'Microsoft.PowerShell.Commands.TestPathCommand',
};
export const SET_LOCATION: CommandIdentity = {
  display: 'Set-Location',
  dotNetType: 'Microsoft.PowerShell.Commands.SetLocationCommand',
};

/** A coreutils program. Its diagnostics are named after itself, not a class. */
export function nativeIdentity(name: string): CommandIdentity {
  return { display: name, dotNetType: name };
}

// ---------------------------------------------------------------------------
// the port, and its absence
// ---------------------------------------------------------------------------

/**
 * The error a filesystem command produces when the host runs without storage.
 *
 * This is not a hypothetical branch. Neither `commandStage` in
 * `src/pipeline/pipeline.ts` nor the kernel supplies an `fs` today — both write
 * `fs: null` with a comment saying the embedder will provide one — so every one
 * of these commands takes this path in the shipped engine until that is wired.
 * Crashing with "cannot read properties of null" would describe the bug rather
 * than the situation.
 *
 * `DriveNotFound` and `ResourceUnavailable` are borrowed rather than measured:
 * pwsh cannot be made to run without a FileSystem provider, so there is no
 * reference answer for "there is no filesystem at all". The id is ours and says
 * so in the message.
 */
export function noFileSystemError(identity: CommandIdentity): ErrorRecord {
  return errorRecord(
    `Cannot find drive. This host was started without storage, so ${identity.display} has ` +
      'no filesystem to read. The kernel supplies InvocationContext.fs; it is null here.',
    'FileSystemUnavailable',
    identity.dotNetType,
    'ResourceUnavailable',
    { exceptionType: 'System.Management.Automation.DriveNotFoundException' },
  );
}

/**
 * Fetch the port, or write the explanation and return null.
 *
 * Returning null rather than throwing keeps the shape of every command body the
 * same: `const fs = await requirePort(...); if (fs === null) return 1;`
 */
export async function requirePort(
  context: InvocationContext,
  identity: CommandIdentity,
): Promise<FileSystemPort | null> {
  if (context.fs !== null) return context.fs;
  await context.streams.error.write(noFileSystemError(identity));
  return null;
}

// ---------------------------------------------------------------------------
// storage errors -> ErrorRecords
// ---------------------------------------------------------------------------

/**
 * The per-command halves of the mapping below.
 *
 * They are parameters and not constants because the reference implementation
 * gives the SAME condition different ids in different commands — measured:
 *
 *   pwsh: Get-Content <unreadable file>   ->  GetContentReaderUnauthorizedAccessError
 *   pwsh: Get-ChildItem <unreadable dir>  ->  DirUnauthorizedAccessError
 *
 * A single shared id would have been wrong for one of them.
 */
export interface FsErrorIds {
  /** ENOENT and ENOTDIR. pwsh: `PathNotFound` for all five cmdlets probed. */
  readonly notFound: string;
  /** EACCES. Differs per command; see above. */
  readonly accessDenied: string;
  /** EISDIR. Only Get-Content has a measured id for it. */
  readonly isDirectory?: string;
}

export const DEFAULT_ERROR_IDS: FsErrorIds = {
  notFound: 'PathNotFound',
  accessDenied: 'UnauthorizedAccessError',
};

/**
 * A `StorageError` as the ErrorRecord pwsh produces for the same condition.
 *
 * EVERY ARM CITES ITS SOURCE. Six of the twelve `StorageErrorCode` members were
 * reproduced on a real filesystem and read off pwsh 7.6.5; the rest cannot be
 * caused there (a JavaScript object graph does not run out of inodes) and say
 * so, so that a reader can tell a measurement from an extrapolation.
 *
 * `displayPath` is the text the MESSAGE should name, and it is the caller's to
 * choose because pwsh's choice is not uniform — see `Set-Location` below, where
 * an existing-but-not-a-directory target is reported with the raw argument and a
 * missing one with the resolved path.
 */
export function storageErrorRecord(
  identity: CommandIdentity,
  error: StorageError,
  displayPath: string,
  ids: FsErrorIds = DEFAULT_ERROR_IDS,
): ErrorRecord {
  const target: PSValue = displayPath;

  switch (error.code) {
    case 'ENOENT':
    // A component of the path is a file. pwsh does not distinguish it from a
    // missing path — measured:
    //   pwsh: Get-Content 'alpha.txt/inner.txt'
    //         -> PathNotFound, ObjectNotFound, ItemNotFoundException,
    //            "Cannot find path '<full>' because it does not exist."
    //   and Get-ChildItem, Set-Location and Select-String all give the same.
    case 'ENOTDIR':
      // pwsh: Get-Content nope.txt
      //   FQEID    PathNotFound,Microsoft.PowerShell.Commands.GetContentCommand
      //   Category ObjectNotFound
      //   Exception System.Management.Automation.ItemNotFoundException
      //   Message  Cannot find path '<full>' because it does not exist.
      return errorRecord(
        `Cannot find path '${displayPath}' because it does not exist.`,
        ids.notFound,
        identity.dotNetType,
        'ObjectNotFound',
        {
          exceptionType: 'System.Management.Automation.ItemNotFoundException',
          targetObject: target,
        },
      );

    case 'EISDIR':
      // pwsh: Get-Content sub
      //   FQEID    GetContainerContentException,...GetContentCommand
      //   Category InvalidOperation
      //   Exception System.InvalidOperationException
      //   Message  Unable to get content because it is a directory: '<full>'.
      //            Please use 'Get-ChildItem' instead.
      return errorRecord(
        `Unable to get content because it is a directory: '${displayPath}'. ` +
          "Please use 'Get-ChildItem' instead.",
        ids.isDirectory ?? 'GetContainerContentException',
        identity.dotNetType,
        'InvalidOperation',
        { exceptionType: 'System.InvalidOperationException', targetObject: target },
      );

    case 'EACCES':
      // Reproduced with a Deny ACE on a real file and a real directory:
      //   pwsh: Get-Content <denied file>
      //     GetContentReaderUnauthorizedAccessError, PermissionDenied,
      //     System.UnauthorizedAccessException,
      //     "Access to the path '<full>' is denied."
      //   pwsh: Get-ChildItem <denied dir>
      //     DirUnauthorizedAccessError, same category, same exception, same message.
      return errorRecord(
        `Access to the path '${displayPath}' is denied.`,
        ids.accessDenied,
        identity.dotNetType,
        'PermissionDenied',
        { exceptionType: 'System.UnauthorizedAccessException', targetObject: target },
      );

    case 'EINVAL':
      // pwsh: Get-ChildItem "bad`0name"
      //   ItemExistsArgumentError,...GetChildItemCommand
      //   InvalidArgument, System.ArgumentException,
      //   "Null character in path. (Parameter 'path')"
      // Test-Path and Set-Location give the identical shape; only Select-String
      // differs, and it differs because Windows strips the NUL before the
      // provider sees it. The `(Parameter 'path')` suffix is pwsh's; the
      // sentence before it is this storage layer's own `reason`, since pwsh has
      // no vocabulary for "unknown drive" or "copy into itself".
      return errorRecord(
        error.reason === 'nul-in-name'
          ? "Null character in path. (Parameter 'path')"
          : `${capitalise(error.message)}. (Parameter 'path')`,
        'ItemExistsArgumentError',
        identity.dotNetType,
        'InvalidArgument',
        { exceptionType: 'System.ArgumentException', targetObject: target },
      );

    case 'ENAMETOOLONG':
      // NOT MEASURED. Windows has long-path support enabled on this machine, so
      // a 300-character name produced PathNotFound rather than a length error —
      // the limit this storage enforces is Linux's NAME_MAX/PATH_MAX, which the
      // available pwsh cannot be made to hit. The InvalidArgument/ArgumentException
      // shape is borrowed from the NUL case above, which IS measured, because it
      // is the same kind of failure: the argument itself is unusable.
      return errorRecord(
        `The path '${displayPath}' is too long: ${String(error.actual)} exceeds the ` +
          `limit of ${String(error.limit)}. (Parameter 'path')`,
        'ItemExistsArgumentError',
        identity.dotNetType,
        'InvalidArgument',
        { exceptionType: 'System.ArgumentException', targetObject: target },
      );

    case 'EIO':
      // NOT MEASURED, and not measurable: nothing in a JavaScript object graph
      // fails at the device level, and pwsh cannot be asked to simulate one.
      // `types.ts` keeps EIO in the union because OPFS really does throw
      // DOMException on an evicted store. ReadError/IOException is the family
      // .NET uses for exactly that, which is the closest honest answer.
      return errorRecord(
        `Could not read '${displayPath}': ${error.cause}`,
        'ReadError',
        identity.dotNetType,
        'ReadError',
        { exceptionType: 'System.IO.IOException', targetObject: target },
      );

    // The remaining members of the union cannot be reached by a reader: they
    // are raised by write, mkdir, rename and remove, none of which this
    // directory can call — the broker would refuse. They are handled rather
    // than defaulted so that widening `StorageError` breaks the build here
    // instead of silently producing a NotSpecified error at run time.
    case 'EEXIST':
    case 'ENOTEMPTY':
    case 'ENOSPC':
    case 'EXDEV':
    case 'EROFS':
      return errorRecord(
        `${identity.display} could not read '${displayPath}': ${error.message} (${error.code}).`,
        'ProviderError',
        identity.dotNetType,
        'NotSpecified',
        { exceptionType: 'System.Management.Automation.ProviderInvocationException', targetObject: target },
      );
  }
}

function capitalise(text: string): string {
  return text.length === 0 ? text : (text[0] ?? '').toUpperCase() + text.slice(1);
}

/** A one-off diagnostic that is not a storage failure. */
export function commandError(
  identity: CommandIdentity,
  message: string,
  errorId: string,
  category: ErrorCategory,
  exceptionType = 'System.Exception',
  targetObject?: PSValue,
): ErrorRecord {
  return errorRecord(message, errorId, identity.dotNetType, category, {
    exceptionType,
    ...(targetObject === undefined ? {} : { targetObject }),
  });
}

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

/**
 * One thing a path argument resolved to.
 *
 * `raw` is kept because the reference implementation reports it rather than the
 * resolved path in three measured places, and losing it would make those
 * messages unreproducible.
 */
export interface Target {
  /** Exactly what the user typed for this item. */
  readonly raw: string;
  readonly resolved: ResolvedPath;
  readonly stat: FileStat;
}

/** Hidden, by the only rule this filesystem has: a leading dot. */
export function isHidden(name: string): boolean {
  return name.startsWith('.');
}

/**
 * PowerShell's wildcard match against a file NAME.
 *
 * Case-insensitive, which is `WildcardPattern`'s default on every platform even
 * though the Linux filesystem underneath is case-sensitive. `support.ts` in the
 * cmdlet directory already implements the pattern language (`*`, `?`, `[a-z]`,
 * backtick escape); using it rather than a second regex builder is what stops
 * the two drifting apart.
 */
export function matchesAny(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => wildcardPattern(pattern).test(name));
}

export { hasWildcard };

/**
 * Expand one path argument, globbing wildcards segment by segment.
 *
 * Wildcards are expanded in EVERY segment, not just the last, because pwsh does:
 * `Get-ChildItem "s*" + "/deeper"` resolves through the wildcard. The walk reads each
 * directory it has to expand, which is why this is async and why it goes through
 * the port — the capability question is asked once per readdir, as it should be.
 *
 * Hidden entries are excluded from a WILDCARD expansion unless `force`, and are
 * never excluded from a literal name. Measured:
 *
 *   pwsh: Get-ChildItem -Filter '.hid*'          ->  nothing
 *   pwsh: Get-ChildItem -Filter '.hid*' -Force   ->  .hidden
 *
 * Returns an EMPTY list when a wildcard matched nothing, and that is not an
 * error — measured:
 *
 *   pwsh: Get-ChildItem 'zz*'   ->  no output, no error
 *   pwsh: Get-ChildItem 'nope'  ->  PathNotFound
 */
export async function globPath(
  fs: FileSystemPort,
  raw: string,
  force = false,
): Promise<Result<readonly ResolvedPath[]>> {
  const start = fs.resolve(raw);
  if (!start.ok) return start;
  if (!hasWildcard(raw)) return { ok: true, value: [start.value] };

  const drive = start.value.drive;
  let frontier: string[] = ['/'];

  for (const segment of splitSegments(start.value.path)) {
    if (!hasWildcard(segment)) {
      frontier = frontier.map((base) => joinPath(base, segment));
      continue;
    }
    const pattern = wildcardPattern(segment);
    const next: string[] = [];
    for (const base of frontier) {
      const rows = await fs.readdir(formatResolved(drive, base));
      // A directory that cannot be listed contributes nothing. pwsh reports the
      // denial when the path was literal and stays quiet when it was globbed;
      // this is the globbed half.
      if (!rows.ok) continue;
      for (const entry of sortDirectoryEntries(rows.value)) {
        if (!pattern.test(entry.name)) continue;
        if (!force && isHidden(entry.name)) continue;
        next.push(joinPath(base, entry.name));
      }
    }
    frontier = next;
  }

  return {
    ok: true,
    value: frontier.map((path) => ({
      drive,
      path,
      full: formatResolved(drive, path),
      clampedAtRoot: false,
    })),
  };
}

/**
 * Resolve one argument to the items it names, statting each.
 *
 * Errors are written to stream 2 and the caller CONTINUES, because every command
 * here is non-terminating per item — measured:
 *
 *   pwsh: Get-Content nope.txt, notrail.txt  ->  one error AND one line of output
 */
export async function resolveTargets(
  fs: FileSystemPort,
  context: InvocationContext,
  identity: CommandIdentity,
  raw: string,
  options: { readonly force?: boolean; readonly ids?: FsErrorIds } = {},
): Promise<readonly Target[]> {
  const globbed = await globPath(fs, raw, options.force ?? false);
  if (!globbed.ok) {
    await context.streams.error.write(
      storageErrorRecord(identity, globbed.error, raw, options.ids ?? DEFAULT_ERROR_IDS),
    );
    return [];
  }

  const targets: Target[] = [];
  for (const resolved of globbed.value) {
    const stat = await fs.stat(resolved.full);
    if (!stat.ok) {
      // A wildcard that matched nothing is silent; a literal name that does not
      // exist is an error. Both measured — see globPath.
      if (hasWildcard(raw)) continue;
      await context.streams.error.write(
        storageErrorRecord(identity, stat.error, resolved.full, options.ids ?? DEFAULT_ERROR_IDS),
      );
      continue;
    }
    targets.push({ raw, resolved, stat: stat.value });
  }
  return targets;
}

// ---------------------------------------------------------------------------
// ordering
// ---------------------------------------------------------------------------

/**
 * The order `Get-ChildItem` lists a directory in: DIRECTORIES FIRST, then files,
 * each collated.
 *
 * Both halves were measured, and the second one was the surprise. A directory
 * holding `a.txt B.txt C.txt _u.txt 1.txt a-b.txt ab.txt Z.txt` plus the
 * directories `a` and `M` lists as
 *
 *   pwsh: a | M | _u.txt | 1.txt | a-b.txt | a.txt | ab.txt | B.txt | C.txt | Z.txt
 *
 * which is neither ordinal (`1.txt` would precede `B.txt` and `_u.txt` would
 * follow `Z.txt`) nor natural (`f1 f10 f2` stays in that order, measured
 * separately). It is a CULTURE-AWARE collation, and the pinned `en` collator
 * behind `compareValues` reproduces it exactly — checked element by element.
 * Using `compareValues` rather than a local comparator is deliberate: this
 * engine has one ordering rule, and a second one here is where the two would
 * diverge.
 */
export function compareNames(a: string, b: string): number {
  return compareValues(a, b);
}

export function sortDirectoryEntries(
  entries: readonly DirectoryEntry[],
): readonly DirectoryEntry[] {
  const directories = entries.filter((e) => e.stat.kind === 'directory');
  const files = entries.filter((e) => e.stat.kind !== 'directory');
  const byName = (x: DirectoryEntry, y: DirectoryEntry): number => compareNames(x.name, y.name);
  return [...directories.sort(byName), ...files.sort(byName)];
}

// ---------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------

/**
 * Split file content into the lines `Get-Content` emits.
 *
 * Three measurements shape this and two of them contradict the obvious code:
 *
 *   pwsh: "one\ntwo\nthree\n"  ->  3 lines, NOT 4. A trailing separator does
 *                                  not produce a trailing empty line.
 *   pwsh: ""                   ->  0 lines. An empty file emits NOTHING, and
 *                                  `Get-Content empty.txt` is `$null`.
 *   pwsh: "a\rb"               ->  2 lines. A LONE CARRIAGE RETURN separates,
 *                                  which a naive split on "\n" misses entirely.
 *
 * `"a\r\nb"` gives 2 lines with no `\r` left on the first, so `\r\n` is one
 * separator rather than two.
 */
export function splitLines(text: string): readonly string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r\n|\n|\r/u);
  // The split of "a\n" is ['a', ''] — the empty tail is the absence of a line,
  // not an empty one.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** `-Delimiter`'s split. Same trailing rule, a caller-supplied separator. */
export function splitOnDelimiter(text: string, delimiter: string): readonly string[] {
  if (delimiter === '') return splitLines(text);
  if (text.length === 0) return [];
  const parts = text.split(delimiter);
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/**
 * `.NET`'s `Path.GetExtension`: everything from the LAST dot, dot included.
 *
 *   pwsh: (Get-Item zeta.md).Extension       ->  .md
 *   pwsh: (Get-Item dotted.dir).Extension    ->  .dir   (directories too)
 *   pwsh: (Get-Item .dotonly).Extension      ->  .dotonly
 */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot);
}

/**
 * `BaseName`, which is NOT the same script property on the two types.
 *
 *   pwsh: (Get-Item zeta.md).BaseName        ->  zeta        (file: strip it)
 *   pwsh: (Get-Item .dotonly).BaseName       ->  <empty>     (file: strip it)
 *   pwsh: (Get-Item dotted.dir).BaseName     ->  dotted.dir  (directory: keep it)
 */
export function baseNameOf(name: string, kind: FileStat['kind']): string {
  if (kind === 'directory') return name;
  const dot = name.lastIndexOf('.');
  return dot === -1 ? name : name.slice(0, dot);
}

// ---------------------------------------------------------------------------
// FileInfo / DirectoryInfo
// ---------------------------------------------------------------------------

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

/** pwsh: `(Get-Item x).PSProvider` -> `Microsoft.PowerShell.Core\FileSystem`. */
export const FILESYSTEM_PROVIDER = 'Microsoft.PowerShell.Core\\FileSystem';

/**
 * `Mode`, the five-character attribute string.
 *
 * Measured on Windows, where the positions and the letters come from:
 *
 *   pwsh: a directory   ->  d----
 *   pwsh: a file        ->  -a---
 *   pwsh: a hidden file ->  -a-h-
 *
 * so the columns are `d a r h s`. WHICH of them this filesystem can set is a
 * different question, and inventing the rest would be worse than omitting them:
 *
 *   d  from `FileStat.kind`
 *   a  ARCHIVE is a Windows attribute with no POSIX bit behind it. `FileStat`
 *      has nowhere to store one, so it is always '-'. On Windows every ordinary
 *      file shows `a`; that is a property of NTFS, not of this store.
 *   r  from the owner's write bit — .NET derives IsReadOnly the same way on Unix
 *   h  from the leading dot, which is the only hidden rule this filesystem has
 *      and the rule v1's `ls` already used (`k.charAt(0) !== '.'`)
 *   s  SYSTEM, as with ARCHIVE: no bit, always '-'
 *
 * `UnixMode` below is the one that carries the whole truth, which is why the
 * default table leads with it.
 */
export function modeString(stat: FileStat): string {
  const readOnly = (stat.mode & 0o200) === 0;
  return (
    (stat.kind === 'directory' ? 'd' : '-') +
    '-' +
    (readOnly ? 'r' : '-') +
    (isHidden(stat.name) ? 'h' : '-') +
    '-'
  );
}

/**
 * The object `Get-ChildItem` emits.
 *
 * TYPE NAMES ARE MEASURED. `(Get-Item x).PSTypeNames` is
 * `System.IO.FileInfo, System.IO.FileSystemInfo, System.MarshalByRefObject,
 * System.Object` for a file and the DirectoryInfo chain for a directory, and
 * `Get-ChildItem` really does emit two different types from one call.
 *
 * PROPERTY ORDER IS THE PS7-ON-UNIX DEFAULT TABLE, then everything else. There
 * is no format view for FileInfo in this engine yet, so `Format-Table` builds
 * its columns from the first object's properties in order; leading with
 * `UnixMode User Group LastWriteTime Length Name` is what makes the default
 * rendering resemble the reference implementation's on Linux, which is the
 * platform being emulated and the column set v1 chose for the same reason.
 * (pwsh on Linux labels the Length column `Size`; the PROPERTY is `Length`
 * there too, so the label is the formatter's business and not modelled here.)
 *
 * `Length` IS ABSENT ON A DIRECTORY, which was measured and is easy to get
 * wrong:
 *
 *   pwsh: (Get-Item sub).PSObject.Properties['Length']   ->  $null
 *   pwsh: (Get-Item sub).Length                          ->  1
 *
 * The 1 is PowerShell's intrinsic collection Count showing through, not a size,
 * and `Get-Member` on a DirectoryInfo lists no Length at all. So a directory
 * here has no Length property and its cell in the table is blank, exactly as
 * `Get-ChildItem | Format-Table` shows.
 *
 * DELIBERATELY NOT EMITTED, because this storage cannot answer them and a
 * plausible-looking wrong value is worse than a missing one: `LastAccessTime`
 * (no atime in `FileStat`), `Attributes` (a Windows flags enum), `LinkType`,
 * `LinkTarget`, `Target`, `ResolvedTarget` (there are no symbolic links —
 * `storage/types.ts` says so), `VersionInfo`, `UnixFileMode` (the .NET enum
 * rendering), `Directory`, `Parent` and `Root` (which are FileSystemInfo
 * OBJECTS in pwsh; `DirectoryName` is the string form and is emitted).
 */
export function fileSystemInfo(stat: FileStat, resolved: ResolvedPath): PSObject {
  const isDirectory = stat.kind === 'directory';
  const full = resolved.full;
  const parent = dirname(resolved.path);

  const properties: Record<string, PSValue> = {
    UnixMode: formatMode(stat.mode, stat.kind),
    User: stat.owner,
    Group: stat.group,
    LastWriteTime: new Date(stat.mtime),
  };
  // Files only. See the note above: a DirectoryInfo has no Length member.
  if (!isDirectory) properties['Length'] = stat.size;
  properties['Name'] = stat.name;

  properties['Mode'] = modeString(stat);
  properties['FullName'] = full;
  properties['PSIsContainer'] = isDirectory;
  properties['Extension'] = extensionOf(stat.name);
  properties['BaseName'] = baseNameOf(stat.name, stat.kind);
  properties['CreationTime'] = new Date(stat.birthtime);
  properties['Exists'] = true;
  if (!isDirectory) properties['IsReadOnly'] = (stat.mode & 0o200) === 0;
  if (!isDirectory) properties['DirectoryName'] = formatResolved(resolved.drive, parent);

  // pwsh: (Get-Item x).PSPath -> Microsoft.PowerShell.Core\FileSystem::<full>
  properties['PSPath'] = `${FILESYSTEM_PROVIDER}::${full}`;
  properties['PSParentPath'] = `${FILESYSTEM_PROVIDER}::${formatResolved(resolved.drive, parent)}`;
  properties['PSChildName'] = stat.name;
  properties['PSDrive'] = resolved.drive;
  properties['PSProvider'] = FILESYSTEM_PROVIDER;

  return psObject(properties, isDirectory ? DIRECTORY_INFO_TYPE_NAMES : FILE_INFO_TYPE_NAMES);
}

// ---------------------------------------------------------------------------
// emitting
// ---------------------------------------------------------------------------

/**
 * Write one value, and say whether the caller should keep going.
 *
 * Returns false when the consumer has walked away (`... | Select-Object -First
 * 3`) or the user pressed Ctrl+C. A recursive listing that ignored this would
 * keep reading a filesystem nobody is watching, which is the exact failure
 * `context.signal` exists to prevent.
 */
export async function emit(
  sink: Sink<PSValue>,
  signal: AbortSignal,
  value: PSValue,
): Promise<boolean> {
  if (sink.closed || signal.aborted) return false;
  await sink.write(value);
  return !sink.closed && !signal.aborted;
}

/** v1's `stripQ`: one leading and one trailing quote, nothing cleverer. */
export function stripQuotes(text: string): string {
  return text.replace(/^["']|["']$/gu, '');
}

export { basename, dirname };
