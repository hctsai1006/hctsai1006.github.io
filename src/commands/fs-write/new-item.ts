/**
 * New-Item (ni, md) — measured, because almost none of it is guessable.
 *
 * Every claim below was read off pwsh 7.6.5 on 2026-09-05. The probe scripts
 * are `p1-newitem.ps1` and `p9-newitem2.ps1`; each line here names what it
 * produced.
 *
 * WHAT IT EMITS
 *   New-Item -ItemType File      ->  System.IO.FileInfo
 *   New-Item -ItemType Directory ->  System.IO.DirectoryInfo
 *   New-Item -Path a,b           ->  one object per path
 * always, with no -PassThru: it is the only command in this set that emits
 * without being asked.
 *
 * THE TWO "ALREADY EXISTS" ERRORS, AND WHICH ONE YOU GET
 *
 *   -ItemType File      onto an existing FILE   NewItemIOError / WriteError
 *                                               "The file '<p>' already exists."
 *   -ItemType Directory onto an existing DIR    DirectoryExist / ResourceExists
 *                                               "An item with the specified
 *                                                name <p> already exists."
 *   -ItemType Directory onto an existing FILE   DirectoryExist / ResourceExists
 *   -ItemType File      onto an existing DIR    NewItemUnauthorizedAccessError
 *                                               PermissionDenied
 *                                               "Access to the path '<p>' is denied."
 *
 * Both ids the brief asked to confirm are confirmed. The third and fourth lines
 * are the ones that were NOT guessable: the id follows the type you ASKED FOR,
 * not the type that is in the way — except when you ask for a file and find a
 * directory, which is Windows opening a directory as a file and reports a
 * permission failure rather than "is a directory". That is what the reference
 * implementation does, so it is what is reproduced.
 *
 * WHAT -Force DOES, WHICH IS FOUR DIFFERENT THINGS
 *
 *   file onto an existing file      TRUNCATES it. 11 bytes before, 0 after.
 *   file, missing parent            creates the parent chain, then the file.
 *   directory onto an existing dir  succeeds, contents UNTOUCHED, emits the
 *                                   DirectoryInfo.
 *   directory onto an existing FILE succeeds, emits NOTHING AT ALL, no error,
 *                                   and the file is still a 7-byte file. That
 *                                   is measured twice and it is not a typo.
 *
 * And what it does NOT do: a parent that is a FILE stays an error with or
 * without it — NewItemIOError / DirectoryNotFoundException both times.
 *
 * -ItemType Directory ALREADY CREATES MISSING PARENTS WITHOUT -Force.
 * `New-Item -ItemType Directory deep/er/est` builds all three. The file form
 * does not. That asymmetry is real and is the reason `mkdir` and `New-Item`
 * disagree about `-Force` in v1 too.
 *
 * -Value IS ToString(), NOT THE PIPELINE'S RENDERING
 *
 *   -Value 'hello'              ->  5 bytes, NO trailing newline
 *   -Value 42                   ->  '42'
 *   -Value $true                ->  'True'
 *   -Value ([pscustomobject]@{A=1;B='x'})  ->  '@{A=1; B=x}'
 *   -Value @('a','b')           ->  'System.Object[]'      <-- fifteen bytes
 *   -Value ([string[]]@('a','b'))          ->  'System.String[]'
 *
 * The last two are the surprise, and they are not a bug in the probe: New-Item
 * declares `-Value` as `System.Object` (Set-Content declares `System.Object[]`),
 * so an array binds as one object and `Object[].ToString()` is its type name.
 * Reproduced rather than tidied — writing `a\nb` here would be inventing a
 * behaviour the reference implementation does not have, and `Set-Content` is
 * the command that does what a reader expects.
 *
 * ITEM TYPES are matched case-insensitively BY PREFIX: `d`, `di`, `dir`,
 * `DIRECTORY` all mean directory; `f`, `fi`, `FILE` all mean file. `sym`,
 * `symboliclink`, `junction` and `hardlink` are recognised link types — pwsh
 * asks for a -Value target for those. There are no links in this filesystem
 * (`StatKind` has two members and the header of `storage/types.ts` says why),
 * so they are refused as not implemented rather than silently making a file.
 * Anything else is `Argument` / InvalidArgument with pwsh's own wording.
 *
 * NO -ItemType AT ALL MEANS FILE. `New-Item -Path b` in a script created a
 * file. (Interactively pwsh prompts; a headless engine has nobody to ask, and
 * v1 makes the same choice — its `wantDir` is false unless the type starts
 * `dir` or the command was typed as `mkdir`/`md`.)
 */

import type { PSValue } from '../../pipeline/psobject.ts';
import { toPSString } from '../../pipeline/psobject.ts';
import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import type { FileSystemPort } from '../ports.ts';
import { rawValue, stringArray, stringValue, switchValue } from '../powershell/support.ts';
import type { FileStat, ResolvedPath, StorageError } from '../../storage/index.ts';
import {
  MESSAGES,
  cancellationShape,
  cancelled,
  exitFor,
  fileSystemInfo,
  fsWriteManifest,
  reportError,
  requireFileSystem,
  storageShape,
} from './support.ts';
import type { PSErrorShape, ProviderErrorIds } from './support.ts';

/**
 * MEASURED ids, one probe each. `argument` is the id pwsh gave for
 * `-ItemType Sausage`; `notFound` never fires for New-Item's own target — it is
 * creating it — so ENOENT is overridden below to the missing-parent shape.
 */
const NEW_ITEM_IDS: ProviderErrorIds = {
  io: 'NewItemIOError',
  access: 'NewItemUnauthorizedAccessError',
  notFound: 'NewItemIOError',
  argument: 'Argument',
};

const NEW_ITEM_MANIFEST = fsWriteManifest(
  'new-item',
  'Creates a real file or directory in the browser filesystem and emits a FileInfo or ' +
    'DirectoryInfo. -Path, -Name, -ItemType, -Value and -Force are implemented, and every ' +
    'behaviour was measured against pwsh 7.6.5: -ItemType matches by prefix, a missing -ItemType ' +
    'means File, -ItemType Directory creates missing parents without -Force while File needs it, ' +
    '-Force truncates an existing file, and -Value is written with ToString() and NO trailing ' +
    'newline, so an array becomes the literal text System.Object[] exactly as pwsh writes it. ' +
    'Symbolic links, junctions and hard links are refused: this filesystem has no links, and ' +
    'making a plain file instead would be a silent wrong answer. -Credential is not implemented. ' +
    'The emitted FileInfo carries 14 of the 30 members pwsh reports: UnixMode, User and Group are ' +
    'present and Mode, Attributes, VersionInfo, the link members, LastAccessTime and the nested ' +
    'Directory/Parent objects are deliberately absent rather than invented.',
);

/** The five names pwsh recognises, longest-first so prefix matching is total. */
const ITEM_TYPES = ['directory', 'file', 'symboliclink', 'junction', 'hardlink'] as const;
type ItemTypeName = (typeof ITEM_TYPES)[number];

/** MEASURED: `New-Item -ItemType Sausage` produced exactly this sentence. */
const UNKNOWN_TYPE_MESSAGE =
  'The type is not a known type for the file system. Only "file","directory" or "symboliclink" ' +
  'can be specified.';

function itemTypeOf(raw: string | undefined): ItemTypeName | 'unknown' {
  // Absent or empty is File. MEASURED: a script-mode New-Item with no -ItemType
  // made a file, and v1 makes the same choice.
  if (raw === undefined || raw.trim() === '') return 'file';
  const wanted = raw.trim().toLowerCase();
  const hit = ITEM_TYPES.find((name) => name.startsWith(wanted));
  return hit ?? 'unknown';
}

/**
 * `-Value`, as New-Item writes it.
 *
 * See the header: an array becomes its .NET type name because `-Value` is a
 * scalar `System.Object` and this is `Object[].ToString()`. `System.Object[]`
 * is what an untyped array literal binds to, which is the case a visitor will
 * hit; a `[string[]]` would print `System.String[]` in pwsh and prints
 * `System.Object[]` here, which is the one divergence in this conversion and is
 * recorded rather than hidden.
 */
function valueText(value: PSValue | undefined): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return 'System.Object[]';
  return toPSString(value);
}

/** MEASURED: a missing parent is reported as an IO failure, not a lookup one. */
function missingParent(path: string): PSErrorShape {
  return {
    id: NEW_ITEM_IDS.io,
    category: 'WriteError',
    exceptionType: 'System.IO.DirectoryNotFoundException',
    message: MESSAGES.couldNotFindPart(path),
  };
}

/** ENOENT out of New-Item can only be the parent; everything else is shared. */
function shapeFor(error: StorageError, path: string): PSErrorShape {
  if (error.code === 'ENOENT') return missingParent(path);
  return storageShape(error, NEW_ITEM_IDS);
}

/**
 * Where the item goes.
 *
 * MEASURED: `-Name` may itself contain separators — `New-Item -Path sub -Name
 * deeper/x.txt -Force` created `sub/deeper/x.txt` — so it is joined and
 * re-resolved rather than validated as a single segment. `-Path` alone is the
 * whole path; `-Name` alone is relative to the working directory.
 */
function targetsOf(
  port: FileSystemPort,
  paths: readonly string[] | undefined,
  name: string | undefined,
): readonly { readonly spec: string; readonly resolved: ResolvedPath | StorageError }[] {
  const specs =
    name === undefined
      ? (paths ?? [])
      : (paths ?? ['.']).map((parent) => `${parent}/${name}`);

  return specs.map((spec) => {
    const outcome = port.resolve(spec);
    return { spec, resolved: outcome.ok ? outcome.value : outcome.error };
  });
}

async function createDirectory(
  context: InvocationContext,
  port: FileSystemPort,
  target: ResolvedPath,
  force: boolean,
  existing: FileStat | null,
): Promise<'ok' | 'failed' | 'silent'> {
  if (existing !== null) {
    if (!force) {
      // MEASURED: DirectoryExist / ResourceExists / IOException, for an
      // existing directory AND for an existing file. The id follows the type
      // that was asked for.
      await reportError(
        context,
        NEW_ITEM_MANIFEST,
        {
          id: 'DirectoryExist',
          category: 'ResourceExists',
          exceptionType: 'System.IO.IOException',
          message: MESSAGES.itemExists(target.full),
        },
        target.full,
      );
      return 'failed';
    }
    // MEASURED, twice: -Force onto an existing DIRECTORY succeeds with the
    // contents untouched and emits the DirectoryInfo; -Force onto an existing
    // FILE succeeds, emits NOTHING, raises no error, and leaves the file a
    // file. The second one looks like a bug and is what pwsh 7.6.5 does.
    if (existing.kind === 'file') return 'silent';
    await context.streams.success.write(fileSystemInfo(existing));
    return 'ok';
  }

  // MEASURED: the chain is created with or without -Force. `mkdir -p` is the
  // default for a directory and only the file form needs -Force.
  const made = await port.mkdir(target.full, { recursive: true });
  if (!made.ok) {
    await reportError(context, NEW_ITEM_MANIFEST, shapeFor(made.error, target.full), target.full);
    return 'failed';
  }
  await context.streams.success.write(fileSystemInfo(made.value));
  return 'ok';
}

async function createFile(
  context: InvocationContext,
  port: FileSystemPort,
  target: ResolvedPath,
  force: boolean,
  existing: FileStat | null,
  text: string,
): Promise<'ok' | 'failed'> {
  if (existing !== null && existing.kind === 'directory') {
    // MEASURED with and without -Force: NewItemUnauthorizedAccessError /
    // PermissionDenied / UnauthorizedAccessException. Not EISDIR-shaped.
    await reportError(
      context,
      NEW_ITEM_MANIFEST,
      {
        id: NEW_ITEM_IDS.access,
        category: 'PermissionDenied',
        exceptionType: 'System.UnauthorizedAccessException',
        message: MESSAGES.accessDenied(target.full),
      },
      target.full,
    );
    return 'failed';
  }
  if (existing !== null && !force) {
    // MEASURED: NewItemIOError / WriteError / IOException.
    await reportError(
      context,
      NEW_ITEM_MANIFEST,
      {
        id: NEW_ITEM_IDS.io,
        category: 'WriteError',
        exceptionType: 'System.IO.IOException',
        message: MESSAGES.fileExists(target.full),
      },
      target.full,
    );
    return 'failed';
  }

  // One write. MEASURED: -Force truncates an existing file to the new -Value
  // (or to nothing), and creates the parent chain when it is missing.
  const written = await port.writeText(target.full, text, { createParents: force });
  if (!written.ok) {
    await reportError(
      context,
      NEW_ITEM_MANIFEST,
      shapeFor(written.error, target.full),
      target.full,
    );
    return 'failed';
  }
  const stat = await port.stat(target.full);
  if (!stat.ok) {
    await reportError(context, NEW_ITEM_MANIFEST, shapeFor(stat.error, target.full), target.full);
    return 'failed';
  }
  await context.streams.success.write(fileSystemInfo(stat.value));
  return 'ok';
}

export const newItem: CommandModule = {
  manifest: NEW_ITEM_MANIFEST,

  async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
    const port = await requireFileSystem(context, NEW_ITEM_MANIFEST);
    if (port === null) return exitFor(1);

    const kind = itemTypeOf(stringValue(bound.parameters, 'ItemType'));
    if (kind === 'unknown') {
      await reportError(
        context,
        NEW_ITEM_MANIFEST,
        {
          id: 'Argument',
          category: 'InvalidArgument',
          exceptionType: 'System.Management.Automation.PSArgumentException',
          message: UNKNOWN_TYPE_MESSAGE,
        },
        null,
      );
      return exitFor(1);
    }
    if (kind !== 'file' && kind !== 'directory') {
      // Recognised and refused, which is a different claim from "not valid
      // PowerShell". There are no links in this filesystem; producing a plain
      // file would be a silent wrong answer that no later command could detect.
      await reportError(
        context,
        NEW_ITEM_MANIFEST,
        {
          id: 'NotImplemented',
          category: 'NotImplemented',
          exceptionType: 'System.NotSupportedException',
          message:
            `-ItemType ${kind} is recognised but not implemented by BrowserShell: this ` +
            'filesystem has no links, so there is nothing for a link to point through.',
        },
        null,
      );
      return exitFor(1);
    }

    const force = switchValue(bound.parameters, 'Force');
    const text = valueText(rawValue(bound.parameters, 'Value'));
    const targets = targetsOf(
      port,
      stringArray(bound.parameters, 'Path'),
      stringValue(bound.parameters, 'Name'),
    );

    if (targets.length === 0) {
      await reportError(
        context,
        NEW_ITEM_MANIFEST,
        {
          id: 'MissingMandatoryParameter',
          category: 'InvalidArgument',
          exceptionType: 'System.Management.Automation.ParameterBindingException',
          message:
            'Cannot process command because of one or more missing mandatory parameters: Path.',
        },
        null,
      );
      return exitFor(1);
    }

    let failures = 0;
    const created: string[] = [];
    for (const target of targets) {
      // MEASURED: every failure here is NON-TERMINATING. `New-Item a,exists,c`
      // created a and c, wrote one error, and emitted two objects.
      if (cancelled(context)) {
        await reportError(context, NEW_ITEM_MANIFEST, cancellationShape(created), null);
        return exitFor(failures + 1);
      }
      if (!('drive' in target.resolved)) {
        await reportError(
          context,
          NEW_ITEM_MANIFEST,
          shapeFor(target.resolved, target.spec),
          target.spec,
        );
        failures += 1;
        continue;
      }
      const resolved = target.resolved;

      // `exists` cannot distinguish absent from unreadable, so the decision
      // below is made from `stat`, whose failure arm carries the reason.
      const probe = await port.stat(resolved.full);
      let existing: FileStat | null = null;
      if (probe.ok) existing = probe.value;
      else if (probe.error.code !== 'ENOENT' && probe.error.code !== 'ENOTDIR') {
        await reportError(context, NEW_ITEM_MANIFEST, shapeFor(probe.error, resolved.full), resolved.full);
        failures += 1;
        continue;
      }

      const outcome =
        kind === 'directory'
          ? await createDirectory(context, port, resolved, force, existing)
          : await createFile(context, port, resolved, force, existing, text);

      if (outcome === 'failed') failures += 1;
      else if (outcome === 'ok') created.push(resolved.full);
    }

    return exitFor(failures);
  },
};
