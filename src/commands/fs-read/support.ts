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
 *   2. `context.fs` IS NULLABLE AND THE NULL IS REAL. This used to say nothing
 *      in the repository supplied one; `PipelineHost` and `KernelOptions` now
 *      carry both a `fs` and a `providers`, and the kernel passes the session's
 *      port through. What has NOT changed is which branch actually runs in the
 *      shipped host: `src/kernel/browser-worker.ts` wires neither, so the null
 *      arm is still the live one and must produce an ErrorRecord rather than a
 *      TypeError.
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

import { basename, dirname, formatResolved, joinPath, ok, splitSegments } from '../../storage/index.ts';
import {
  PROVIDER_NOT_SUPPORTED,
  compareItemNames,
  orderChildItems,
  providerRelativePath,
} from '../../providers/index.ts';
import type { ProviderItem, ProviderRegistry } from '../../providers/index.ts';
import type { DirectoryEntry, FileStat, Result, StorageError } from '../../storage/index.ts';
import type { ResolvedPath } from '../../storage/vfs.ts';
import { decodeFile } from '../../pipeline/encoding.ts';
import type { PSValue } from '../../pipeline/psobject.ts';
import { errorRecord } from '../../pipeline/streams.ts';
import type { ErrorCategory, ErrorRecord, Sink } from '../../pipeline/streams.ts';
import type { InvocationContext } from '../invocation.ts';
import type { CommandManifest } from '../manifest.ts';
import type { FileSystemPort } from '../ports.ts';
import { hasWildcard, wildcardPattern } from '../powershell/support.ts';

/**
 * The FileSystem provider's item shaping MOVED to `providers/filesystem.ts`.
 *
 * It was always that provider's answer to "what does one of my items look
 * like" — the same question `ProviderItem.value` asks of Env:, Variable:,
 * Function: and Alias: — and leaving it here would have meant four providers
 * building their items in the provider layer and the fifth building its in a
 * command directory. Re-exported so the ten readers that import it did not have
 * to change, and so a future move of the importers is a separate diff.
 */
export {
  DIRECTORY_INFO_TYPE_NAMES,
  FILESYSTEM_PROVIDER,
  FILE_INFO_TYPE_NAMES,
  baseNameOf,
  extensionOf,
  fileSystemInfo,
  isHidden,
  modeString,
} from '../../providers/filesystem.ts';
import { isHidden } from '../../providers/filesystem.ts';

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
  // A module exists, so the command is implemented — regardless of what the
  // generated file says. Stated here rather than read back from `found`,
  // because the generator derives `implementationStatus` FROM the modules: a
  // manifest that inherited its own status would be a feedback loop, and the
  // first stale run would demote every command in this directory to 'declared'
  // and unregister it.
  return { ...found, implementationStatus: 'implemented' };
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
      if (error.reason === 'unknown-drive') {
        // MEASURED, and it is a DIFFERENT family from every other EINVAL:
        //   Get-Item     zzNoDrive:\x  ->  DriveNotFound,...GetItemCommand
        //   Set-Location zzNoDrive:    ->  DriveNotFound,...SetLocationCommand
        //   both: ObjectNotFound, System.Management.Automation.DriveNotFoundException,
        //   "Cannot find drive. A drive with the name 'zzNoDrive' does not exist."
        // The sentence names the DRIVE and not the path, so the drive is parsed
        // back out of the resolver's own message rather than re-derived from
        // the raw text — the resolver is the thing that decided what the drive
        // was. `Test-Path` is the exception and answers False with no error at
        // all; it handles this before reaching here.
        const named = /'([^']*)'/u.exec(error.message)?.[1] ?? displayPath;
        return errorRecord(
          `Cannot find drive. A drive with the name '${named}' does not exist.`,
          'DriveNotFound',
          identity.dotNetType,
          'ObjectNotFound',
          {
            exceptionType: 'System.Management.Automation.DriveNotFoundException',
            targetObject: named,
          },
        );
      }
      if (error.reason.startsWith(PROVIDER_NOT_SUPPORTED)) {
        // The reason carries the interface name after the prefix, because
        // `StorageError` has no field for it and inventing a code would widen
        // an exhaustive switch in eight commands. See `providerNotSupportedError`.
        return providerNotSupportedError(
          identity,
          `Cannot use interface. The ${error.reason.slice(
            PROVIDER_NOT_SUPPORTED.length + 1,
          )} interface is not implemented by this provider.`,
        );
      }
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

// ---------------------------------------------------------------------------
// non-filesystem drives
// ---------------------------------------------------------------------------

/**
 * Expand one already-resolved path on a drive that is NOT the filesystem.
 *
 * ONE implementation, shared by `Get-ChildItem`, `Test-Path` and `Get-Content`,
 * because writing "look it up, or match the wildcard against the child names"
 * three times is the drift this repository keeps finding. `globPath` above is
 * the filesystem's counterpart and stays separate: it walks wildcards in EVERY
 * segment through `readdir`, which a flat provider has no segments for.
 *
 * MEASURED, and all three halves matter:
 *
 *   Get-Item      'Env:zzTp*'   ->  expands; 13 items when 13 matched
 *   Get-Item -LiteralPath 'Env:zzTp*'
 *                               ->  PathNotFound; the `*` is a character
 *   Get-Item      'Env:zzQQ*'   ->  count 0, and NO error
 *   Get-ChildItem 'Env:zzQQ*'   ->  count 0, and NO error
 *
 * so a wildcard that matches nothing is silence, exactly as it is on the
 * filesystem, while a literal name that is absent is `PathNotFound`.
 */
export async function providerTargets(
  registry: ProviderRegistry,
  resolved: ResolvedPath,
  literal: boolean,
): Promise<Result<readonly ProviderItem[]>> {
  const relative = providerRelativePath(resolved);
  if (literal || !hasWildcard(relative)) {
    const item = await registry.item(resolved);
    if (!item.ok) return item;
    return ok([item.value]);
  }
  const root: ResolvedPath = {
    drive: resolved.drive,
    path: '/',
    full: formatResolved(resolved.drive, '/'),
    clampedAtRoot: false,
  };
  const children = await registry.childItems(root);
  if (!children.ok) return children;
  return ok(children.value.filter((item) => matchesAny(item.name, [relative])));
}

/**
 * The `NotSupported` record pwsh produces for a capability a provider does not
 * implement.
 *
 * MEASURED, twice, and both are the same family rather than `PathNotFound`:
 *
 *   Get-Content HKCU:\Software
 *     NotSupported,...GetContentCommand, PSNotSupportedException, NotImplemented
 *     "Cannot use interface. The IContentCmdletProvider interface is not
 *      implemented by this provider."
 *   Get-ChildItem Env: -Filter 'zz*'
 *     NotSupported,...GetChildItemCommand, PSNotSupportedException, NotImplemented
 *     "Cannot call method. The provider does not support the use of filters."
 *
 * Kept out of `storageErrorRecord`'s switch because it is not a storage
 * condition: nothing in `StorageErrorCode` describes "this provider does not
 * implement that interface", and adding a code for it would widen an exhaustive
 * switch in eight commands to carry an arm only this layer can reach.
 */
export function providerNotSupportedError(
  identity: CommandIdentity,
  message: string,
): ErrorRecord {
  return errorRecord(message, 'NotSupported', identity.dotNetType, 'NotImplemented', {
    exceptionType: 'System.Management.Automation.PSNotSupportedException',
  });
}

/**
 * A parameter the FILESYSTEM supplies, used on a drive that is not one.
 *
 * Half of what `Get-Content`, `Get-ChildItem` and `Test-Path` accept is a
 * FileSystem DYNAMIC parameter — the provider contributes it, so on `Env:` the
 * parameter does not exist and binding fails. This binder is static and binds
 * it anyway, so the refusal has to be reproduced in the command body.
 *
 * MEASURED, and there are THREE different refusals rather than one:
 *
 *   Get-Content  Env:x -Raw          NamedParameterNotFound, InvalidArgument,
 *                                    ParameterBindingException
 *                                    "A parameter cannot be found that matches
 *                                     parameter name 'Raw'."
 *   Get-Content  Env:x -Tail 1       TailNotSupported, InvalidOperation,
 *                                    InvalidOperationException
 *   Get-ChildItem Env: -Filter 'z*'  NotSupported, NotImplemented,
 *                                    PSNotSupportedException
 *   Get-ChildItem Env: -Depth 1      NotSupported, same pair, different sentence
 *
 * and the ones that ARE accepted are worth recording too, because refusing them
 * would be just as wrong: `-Include`, `-Exclude`, `-Force`, `-Recurse`, `-Name`,
 * `-ReadCount` and `-TotalCount` all bind on `Env:`.
 */
export function namedParameterNotFoundError(
  identity: CommandIdentity,
  parameter: string,
): ErrorRecord {
  return errorRecord(
    `A parameter cannot be found that matches parameter name '${parameter}'.`,
    'NamedParameterNotFound',
    identity.dotNetType,
    'InvalidArgument',
    { exceptionType: 'System.Management.Automation.ParameterBindingException' },
  );
}

/**
 * `-Filter` where the provider does not declare the capability.
 *
 * The capability list is what decides, not the drive: `Get-PSProvider` reports
 * `Filter` for FileSystem alone, and `ProviderRegistry.supports` reads the same
 * list. MEASURED sentence, identical from Get-Content and Get-ChildItem.
 */
export function filterNotSupportedError(identity: CommandIdentity): ErrorRecord {
  return providerNotSupportedError(
    identity,
    'Cannot call method. The provider does not support the use of filters.',
  );
}

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
 * The ordering rule MOVED to `providers/filesystem.ts`, where the FileSystem
 * provider's `getChildItems` needs it.
 *
 * It was briefly written twice — once there for `ProviderItem`, once here for
 * `DirectoryEntry` — which is the "one conversion implemented more than once"
 * shape this repository has found six times. `orderChildItems` is generic over
 * the row so both callers use it, and the measured order (directories first,
 * then files, each collated with the pinned `en` collator) is stated in one
 * place. These two names stay because ten call sites import them.
 */
export function compareNames(a: string, b: string): number {
  return compareItemNames(a, b);
}

export function sortDirectoryEntries(
  entries: readonly DirectoryEntry[],
): readonly DirectoryEntry[] {
  return orderChildItems(
    entries,
    (entry) => entry.name,
    (entry) => entry.stat.kind === 'directory',
  );
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

/**
 * Read a file as text the way PowerShell's own readers do: BYTES first, then
 * the broker, with the byte-order mark consulted.
 *
 * `FileSystemPort.readText` decodes UTF-8 unconditionally and has no sniff, so
 * every command that used it returned mojibake for a UTF-16 file. MEASURED on
 * pwsh 7.6.5 against a UTF-16LE file holding "hello world":
 *
 *   Select-String -Pattern world   ->  MATCHED: [hello world]
 *   Get-Content -Raw               ->  hello world
 *
 * This engine's Select-String found nothing there, because the bytes
 * FF FE 68 00 65 00 ... decode under UTF-8 to replacement characters
 * interleaved with NULs and the pattern cannot match. `cat` and `grep` had the
 * same hole.
 *
 * Routed through `decodeFile` rather than a private decoder so there is still
 * exactly one place that decides an encoding — see the gate in
 * tests/unit/encoding.test.mts. UTF-8 is the requested codec because that is
 * what these commands assumed; what changes is that a BOM now overrides it, as
 * it does in the reference implementation.
 */
export async function readTextSniffed(
  fs: FileSystemPort,
  path: string,
): Promise<Result<string>> {
  const bytes = await fs.readBytes(path);
  if (!bytes.ok) return bytes;
  return { ok: true, value: decodeFile(bytes.value, 'utf8') };
}

/** v1's `stripQ`: one leading and one trailing quote, nothing cleverer. */
export function stripQuotes(text: string): string {
  return text.replace(/^["']|["']$/gu, '');
}

export { basename, dirname };
