/**
 * Move-Item (mi, move), Rename-Item (rni, ren) and mv.
 *
 * All three are one storage call — `port.rename` — which is what makes them the
 * atomic members of this set: `MemoryStorage.rename` emits ONE `move` step, so
 * a move either happened or did not, with no half state to describe. That is
 * the property `Copy-Item` cannot have, and the reason these three are together
 * and `Copy-Item` is not.
 *
 * Measured against pwsh 7.6.5 on 2026-09-05 (p3, p4, p5).
 *
 * ---------------------------------------------------------------------------
 * WHICH ONE TAKES A PATH, AND WHICH ONE TAKES A NAME
 * ---------------------------------------------------------------------------
 *
 * The brief asked. The answer is not "one of each":
 *
 *   Move-Item -Destination   a PATH. Absolute, relative, another directory,
 *                            all fine. `Move-Item across.txt other/renamed.txt`
 *                            moved AND renamed in one step.
 *   Rename-Item -NewName     a NAME — but the check is not "no separators". It
 *                            is that the new name must land in the SAME
 *                            DIRECTORY. Measured, four ways:
 *
 *      'sub/x.txt'                     Argument / InvalidArgument, refused
 *      './fs3.txt'                     ACCEPTED, renamed in place
 *      '<root>/movable2.txt'  (same dir)   ACCEPTED
 *      '<root>/elsewhere/moved.txt'        Argument / InvalidArgument, refused
 *
 * So an absolute path is fine as long as it resolves beside the item, and a
 * relative path with a separator is refused because it does not. v1 checks
 * `/[\\/:]/` on the raw string, which gets the first and fourth right and the
 * second and third wrong; the directory comparison gets all four. v1's other
 * rule — that the name is relative to the ITEM's directory, not the working
 * directory — is kept, because it is the one the probe cannot distinguish (they
 * coincided) and v1 states it deliberately.
 *
 * ---------------------------------------------------------------------------
 * COLLISIONS: THREE COMMANDS, THREE ANSWERS
 * ---------------------------------------------------------------------------
 *
 *   Move-Item onto an existing file, no -Force
 *       MoveFileInfoItemIOError / WriteError / IOException
 *       "Cannot create a file when that file already exists."
 *       (captured as zh-TW 「當檔案已存在時，無法建立該檔案。」 on this host,
 *        which is .NET's translation of that sentence; v1 uses the English form
 *        verbatim, so the English form is what is emitted.)
 *   Move-Item onto an existing file, WITH -Force        overwrites, no error
 *   Rename-Item onto an existing name                   RenameItemIOError, same
 *                                                       message
 *   Rename-Item onto an existing name, WITH -Force      STILL REFUSED, same
 *                                                       error, source untouched
 *   mv onto an existing file                            OVERWRITES. GNU mv needs
 *                                                       no flag, and v1 says so
 *                                                       at the site.
 *
 * `-Force` not helping Rename-Item is the single most surprising measurement in
 * this file. It was run twice and the destination was still `b` and the source
 * still there both times.
 *
 * ---------------------------------------------------------------------------
 * THE REST, EACH MEASURED
 * ---------------------------------------------------------------------------
 *
 *   emits NOTHING; -PassThru emits the DESTINATION's FileInfo (all three)
 *   file into an existing DIRECTORY        moves INTO it
 *   directory into an existing DIRECTORY   moves INTO it
 *   missing source                         PathNotFound / ObjectNotFound
 *   missing destination parent             MoveFileInfoItemIOError / WriteError,
 *                                          message "Could not find a part of
 *                                          the path." — with NO path in it,
 *                                          which is what pwsh prints
 *   source == destination                  NO ERROR, no-op (all three)
 *   directory into its own subdirectory    MoveItemArgumentError /
 *                                          InvalidArgument, "Destination path
 *                                          cannot be a subdirectory of the
 *                                          source or the source itself: <p>"
 *
 * That last one is the guard `Copy-Item` does NOT have — see `copy-item.ts` for
 * the probe that hung — and `MemoryStorage.rename` already enforces it, so this
 * command reports the storage layer's EINVAL rather than re-checking it.
 */

import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import type { CommandManifest } from '../manifest.ts';
import type { FileSystemPort } from '../ports.ts';
import { stringArray, stringValue, switchValue } from '../powershell/support.ts';
import { basename, dirname } from '../../storage/index.ts';
import type { ResolvedPath, Result, StorageError } from '../../storage/index.ts';
import {
  EXIT_SUCCESS,
  MESSAGES,
  argumentsOf,
  cancellationShape,
  cancelled,
  exitFor,
  fileSystemInfo,
  fsWriteManifest,
  operandsOf,
  reportError,
  requireFileSystem,
  storageShape,
} from './support.ts';
import type { PSErrorShape, ProviderErrorIds } from './support.ts';

// ---------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------

function samePath(a: ResolvedPath, b: ResolvedPath): boolean {
  return a.drive === b.drive && a.path === b.path;
}

/** MEASURED for all three: an existing destination DIRECTORY receives the item. */
async function landingOf(
  port: FileSystemPort,
  source: ResolvedPath,
  destination: ResolvedPath,
): Promise<ResolvedPath> {
  if (samePath(source, destination)) return destination;
  const stat = await port.stat(destination.full);
  if (!stat.ok || stat.value.kind !== 'directory') return destination;
  const child = port.resolve(`${destination.full}/${basename(source.path)}`);
  return child.ok ? child.value : destination;
}

/**
 * The shapes that differ from the shared provider mapping, for a move.
 *
 * ENOENT can only be the destination parent here — the source is stat'd first —
 * and EEXIST is the collision, whose measured message is not either of the two
 * "already exists" wordings the item cmdlets use.
 */
function moveShape(error: StorageError, ids: ProviderErrorIds, forRename: boolean): PSErrorShape {
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
    return {
      id: ids.io,
      category: 'WriteError',
      exceptionType: 'System.IO.DirectoryNotFoundException',
      // MEASURED, and deliberately path-less: pwsh really does print the bare
      // sentence here, unlike every other missing-parent message in this set.
      message: 'Could not find a part of the path.',
    };
  }
  if (error.code === 'EEXIST') {
    return {
      id: ids.io,
      category: 'WriteError',
      exceptionType: 'System.IO.IOException',
      message: MESSAGES.fileAlreadyExists(),
    };
  }
  if (error.code === 'EINVAL' && error.reason === 'into-self') {
    // MEASURED: MoveItemArgumentError / InvalidArgument / IOException, with the
    // destination in the message. Raised by `MemoryStorage.rename`, not
    // re-derived here.
    return {
      id: forRename ? 'Argument' : 'MoveItemArgumentError',
      category: 'InvalidArgument',
      exceptionType: 'System.IO.IOException',
      message:
        'Destination path cannot be a subdirectory of the source or the source itself: ' +
        error.path,
    };
  }
  return storageShape(error, ids);
}

/** MEASURED, one probe each. */
const MOVE_IDS: ProviderErrorIds = {
  io: 'MoveFileInfoItemIOError',
  access: 'MoveFileInfoItemUnauthorizedAccessError',
  notFound: 'PathNotFound',
  argument: 'MoveItemArgumentError',
};

const RENAME_IDS: ProviderErrorIds = {
  io: 'RenameItemIOError',
  access: 'RenameItemUnauthorizedAccessError',
  notFound: 'PathNotFound',
  argument: 'Argument',
};

const MV_IDS: ProviderErrorIds = {
  io: 'MvIOError',
  access: 'MvPermissionDenied',
  notFound: 'MvPathNotFound',
  argument: 'MvArgumentError',
};

function missingSource(source: ResolvedPath, ids: ProviderErrorIds): PSErrorShape {
  // MEASURED for Move-Item and Rename-Item alike.
  return {
    id: ids.notFound,
    category: 'ObjectNotFound',
    exceptionType: 'System.Management.Automation.ItemNotFoundException',
    message: MESSAGES.cannotFindPath(source.full),
  };
}

/**
 * Move one item, once every guard has been applied.
 *
 * The whole mutation is `port.rename`, which is one planned step in the storage
 * layer. Nothing here loops over pieces, so there is no partial state.
 */
async function moveOne(
  context: InvocationContext,
  manifest: CommandManifest,
  port: FileSystemPort,
  source: ResolvedPath,
  final: ResolvedPath,
  options: {
    readonly overwrite: boolean;
    readonly passThru: boolean;
    readonly ids: ProviderErrorIds;
    readonly forRename: boolean;
  },
): Promise<boolean> {
  // MEASURED for all three: moving something onto itself is success and a
  // no-op, not an error. v1 says the same at both of its sites.
  if (samePath(source, final)) return true;

  const moved = await port.rename(
    source.full,
    final.full,
    options.overwrite ? { overwrite: true } : {},
  );
  if (!moved.ok) {
    await reportError(
      context,
      manifest,
      moveShape(moved.error, options.ids, options.forRename),
      source.full,
    );
    return false;
  }
  if (options.passThru) {
    const stat = await port.stat(final.full);
    if (stat.ok) await context.streams.success.write(fileSystemInfo(stat.value));
  }
  return true;
}

// ---------------------------------------------------------------------------
// Move-Item
// ---------------------------------------------------------------------------

const MOVE_ITEM_MANIFEST = fsWriteManifest(
  'move-item',
  'Really moves an item in the browser filesystem, as one atomic storage rename — a move here ' +
    'either happened or did not. -Path, -LiteralPath, -Destination, -Force and -PassThru are ' +
    'implemented, all measured against pwsh 7.6.5: -Destination takes a full path, an existing ' +
    'destination directory receives the item under its own name, a collision without -Force is ' +
    'refused with "Cannot create a file when that file already exists.", -Force overwrites, ' +
    'moving something onto itself succeeds silently, and moving a directory into its own ' +
    'subdirectory is refused by the storage layer with the wording pwsh uses. A move across two ' +
    'mounts is reported rather than emulated: completing it needs a copy and a delete, and this ' +
    'command is not granted filesystem.delete. -Filter, -Include, -Exclude and -Credential are ' +
    'not implemented.',
);

export const moveItem: CommandModule = {
  manifest: MOVE_ITEM_MANIFEST,

  async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
    const port = await requireFileSystem(context, MOVE_ITEM_MANIFEST);
    if (port === null) return exitFor(1);

    const specs =
      stringArray(bound.parameters, 'LiteralPath') ?? stringArray(bound.parameters, 'Path') ?? [];
    if (specs.length === 0) {
      await reportError(context, MOVE_ITEM_MANIFEST, missingMandatory('Path'), null);
      return exitFor(1);
    }
    // Unlike Copy-Item, a missing -Destination is not measured; `.` is the same
    // reading and is what makes `Move-Item x` mean "into here".
    const destinationSpec = stringValue(bound.parameters, 'Destination') ?? '.';
    const destination = port.resolve(destinationSpec);
    if (!destination.ok) {
      await reportError(
        context,
        MOVE_ITEM_MANIFEST,
        moveShape(destination.error, MOVE_IDS, false),
        destinationSpec,
      );
      return exitFor(1);
    }

    const overwrite = switchValue(bound.parameters, 'Force');
    const passThru = switchValue(bound.parameters, 'PassThru');

    let failures = 0;
    for (const spec of specs) {
      if (cancelled(context)) {
        await reportError(context, MOVE_ITEM_MANIFEST, cancellationShape([]), null);
        return exitFor(failures + 1);
      }
      const source = port.resolve(spec);
      if (!source.ok) {
        await reportError(context, MOVE_ITEM_MANIFEST, moveShape(source.error, MOVE_IDS, false), spec);
        failures += 1;
        continue;
      }
      const stat = await port.stat(source.value.full);
      if (!stat.ok) {
        await reportError(
          context,
          MOVE_ITEM_MANIFEST,
          stat.error.code === 'ENOENT'
            ? missingSource(source.value, MOVE_IDS)
            : storageShape(stat.error, MOVE_IDS),
          spec,
        );
        failures += 1;
        continue;
      }
      const final = await landingOf(port, source.value, destination.value);
      const ok = await moveOne(context, MOVE_ITEM_MANIFEST, port, source.value, final, {
        overwrite,
        passThru,
        ids: MOVE_IDS,
        forRename: false,
      });
      if (!ok) failures += 1;
    }

    return exitFor(failures);
  },
};

// ---------------------------------------------------------------------------
// Rename-Item
// ---------------------------------------------------------------------------

const RENAME_ITEM_MANIFEST = fsWriteManifest(
  'rename-item',
  'Renames an item in place, as one atomic storage rename. -Path, -LiteralPath, -NewName and ' +
    '-PassThru are implemented. -NewName must land in the SAME DIRECTORY, which is measured and ' +
    'is subtler than "no separators": pwsh accepts ./name and an absolute path beside the item, ' +
    'and refuses sub/name and an absolute path elsewhere. The name is resolved relative to the ' +
    "ITEM's directory rather than the working directory, which is v1's stated rule. -Force is " +
    'accepted and, as measured, does NOT let a rename overwrite an existing name: pwsh refuses it ' +
    'with or without the switch, and reproducing that is deliberate rather than an omission. ' +
    '-Credential is not implemented.',
);

/**
 * Resolve `-NewName` the way pwsh does: beside the item, not beside the shell.
 *
 * An absolute name, a home-relative name or a drive-qualified name is resolved
 * as written; anything else is joined onto the item's own directory.
 */
function relativeToItem(
  port: FileSystemPort,
  parent: string,
  name: string,
): Result<ResolvedPath> {
  const anchored = name.startsWith('/') || name.startsWith('~') || /^[A-Za-z][\w.-]*:/u.test(name);
  return port.resolve(anchored ? name : `${parent}/${name}`);
}

export const renameItem: CommandModule = {
  manifest: RENAME_ITEM_MANIFEST,

  async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
    const port = await requireFileSystem(context, RENAME_ITEM_MANIFEST);
    if (port === null) return exitFor(1);

    const spec =
      stringValue(bound.parameters, 'LiteralPath') ?? stringValue(bound.parameters, 'Path');
    const newName = stringValue(bound.parameters, 'NewName');
    if (spec === undefined || newName === undefined) {
      await reportError(
        context,
        RENAME_ITEM_MANIFEST,
        missingMandatory(spec === undefined ? 'Path' : 'NewName'),
        null,
      );
      return exitFor(1);
    }
    if (cancelled(context)) {
      await reportError(context, RENAME_ITEM_MANIFEST, cancellationShape([]), null);
      return exitFor(1);
    }

    const source = port.resolve(spec);
    if (!source.ok) {
      await reportError(context, RENAME_ITEM_MANIFEST, moveShape(source.error, RENAME_IDS, true), spec);
      return exitFor(1);
    }
    const stat = await port.stat(source.value.full);
    if (!stat.ok) {
      await reportError(
        context,
        RENAME_ITEM_MANIFEST,
        stat.error.code === 'ENOENT'
          ? missingSource(source.value, RENAME_IDS)
          : storageShape(stat.error, RENAME_IDS),
        spec,
      );
      return exitFor(1);
    }

    const parent = dirname(source.value.path);
    const target = relativeToItem(port, parent, newName);
    if (!target.ok) {
      await reportError(context, RENAME_ITEM_MANIFEST, moveShape(target.error, RENAME_IDS, true), newName);
      return exitFor(1);
    }
    if (target.value.drive !== source.value.drive || dirname(target.value.path) !== parent) {
      // MEASURED wording, and the check the four probes pin down: not "contains
      // a separator", but "lands somewhere else".
      await reportError(
        context,
        RENAME_ITEM_MANIFEST,
        {
          id: 'Argument',
          category: 'InvalidArgument',
          exceptionType: 'System.Management.Automation.PSArgumentException',
          message: 'Cannot rename the specified target, because it represents a path or device name.',
        },
        newName,
      );
      return exitFor(1);
    }

    const ok = await moveOne(context, RENAME_ITEM_MANIFEST, port, source.value, target.value, {
      // MEASURED: -Force does not help. Never overwrite.
      overwrite: false,
      passThru: switchValue(bound.parameters, 'PassThru'),
      ids: RENAME_IDS,
      forRename: true,
    });
    return ok ? EXIT_SUCCESS : exitFor(1);
  },
};

// ---------------------------------------------------------------------------
// mv
// ---------------------------------------------------------------------------

/**
 * GNU coreutils `mv`, for the same reason `cp` is separate: PowerShell on Linux
 * removes the alias so the real binary runs, and v1 reproduces that. v1 is the
 * specification, and its one substantive difference from Move-Item is stated in
 * its own comment — GNU mv OVERWRITES BY DEFAULT.
 */
const MV_MANIFEST = fsWriteManifest(
  'mv',
  'GNU coreutils mv, not an alias of Move-Item: PowerShell on Linux deliberately removes that ' +
    'alias so the real binary runs, and v1 does the same. It OVERWRITES an existing destination ' +
    'without asking, which is where GNU mv and Move-Item genuinely differ and is what v1 ' +
    'implements. A destination that is an existing directory receives the source under its own ' +
    'name; moving something onto itself succeeds silently; moving a directory into its own ' +
    'subtree is refused by the storage layer. The whole move is one atomic storage rename. No ' +
    'flags are implemented — v1 implements none either — and dash-led tokens are ignored rather ' +
    'than rejected, which is v1\'s behaviour.',
);

export const mv: CommandModule = {
  manifest: MV_MANIFEST,

  async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
    const port = await requireFileSystem(context, MV_MANIFEST);
    if (port === null) return exitFor(1);

    const operands = operandsOf(argumentsOf(bound));
    if (operands.length < 2) {
      await reportError(
        context,
        MV_MANIFEST,
        {
          id: MV_IDS.argument,
          category: 'InvalidArgument',
          exceptionType: 'System.ArgumentException',
          message:
            operands.length === 0 ? 'mv: missing file operand' : 'mv: missing destination file operand',
        },
        null,
      );
      return exitFor(1);
    }

    const destinationSpec = operands[operands.length - 1] ?? '.';
    const destination = port.resolve(destinationSpec);
    if (!destination.ok) {
      await reportError(context, MV_MANIFEST, moveShape(destination.error, MV_IDS, false), destinationSpec);
      return exitFor(1);
    }

    let failures = 0;
    for (const spec of operands.slice(0, -1)) {
      if (cancelled(context)) {
        await reportError(context, MV_MANIFEST, cancellationShape([]), null);
        return exitFor(failures + 1);
      }
      const source = port.resolve(spec);
      if (!source.ok) {
        await reportError(context, MV_MANIFEST, moveShape(source.error, MV_IDS, false), spec);
        failures += 1;
        continue;
      }
      const stat = await port.stat(source.value.full);
      if (!stat.ok) {
        await reportError(
          context,
          MV_MANIFEST,
          stat.error.code === 'ENOENT'
            ? {
                // v1: `mv: cannot stat 'X': No such file or directory`
                id: MV_IDS.notFound,
                category: 'ObjectNotFound',
                exceptionType: 'System.Management.Automation.ItemNotFoundException',
                message: `mv: cannot stat '${spec}': No such file or directory`,
              }
            : storageShape(stat.error, MV_IDS),
          spec,
        );
        failures += 1;
        continue;
      }
      const final = await landingOf(port, source.value, destination.value);
      const ok = await moveOne(context, MV_MANIFEST, port, source.value, final, {
        // v1: "GNU mv 預設就覆寫,不像 Move-Item 要 -Force".
        overwrite: true,
        passThru: false,
        ids: MV_IDS,
        forRename: false,
      });
      if (!ok) failures += 1;
    }

    return exitFor(failures);
  },
};

function missingMandatory(name: string): PSErrorShape {
  return {
    id: 'MissingMandatoryParameter',
    category: 'InvalidArgument',
    exceptionType: 'System.Management.Automation.ParameterBindingException',
    message: `Cannot process command because of one or more missing mandatory parameters: ${name}.`,
  };
}
