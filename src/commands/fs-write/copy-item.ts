/**
 * Copy-Item (ci, copy) and cp — and the one place this set cannot be atomic.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT GAP, STATED FIRST BECAUSE IT SHAPES EVERYTHING BELOW
 * ---------------------------------------------------------------------------
 *
 * `FileSystemPort` exposes no `copy`. `VirtualFileSystem.copy` exists,
 * `StorageBackend.copy` exists, and `MemoryStorage.copy` is the textbook case
 * for the layer's PLAN / VALIDATE / APPLY discipline — it builds every step
 * first so that "a `cp -r` that fails on its ninth file leaves the destination
 * EXACTLY as it was" is a property rather than a hope. None of that is
 * reachable from a command. So this file walks the source and writes the pieces
 * through `mkdir` and `writeBytes`, which is a loop, which can fail halfway.
 *
 * What is done about it, since the loop is forced:
 *
 *   1. THE WHOLE PLAN IS BUILT BEFORE ONE BYTE IS WRITTEN. Every source file is
 *      read and every source directory listed during the plan phase. A source
 *      that cannot be read — a missing file, a directory without execute
 *      permission — fails with NOTHING written, which is the half of atomicity
 *      that is still available.
 *   2. A FAILURE DURING APPLY STOPS THE COPY IMMEDIATELY and says how far it
 *      got. The ErrorRecord names the step that failed and states that the
 *      items before it remain; `tests/unit/fs-write-copy.test.mts` runs a copy
 *      out of quota partway through and asserts exactly that list. Continuing
 *      would scatter a half-tree with no report of its shape.
 *   3. THERE IS NO ROLLBACK, and there cannot be: undoing a partial copy means
 *      deleting, and these commands do not declare `filesystem.delete`. The
 *      port would refuse the call. Pretending otherwise would be worse than
 *      saying so.
 *
 * ---------------------------------------------------------------------------
 * MEASURED, pwsh 7.6.5, 2026-09-05 (p3, p4, p7, p11)
 * ---------------------------------------------------------------------------
 *
 *   emits NOTHING; -PassThru emits the DESTINATION's FileInfo
 *   file onto an existing DIRECTORY   copies INTO it — confirmed
 *   file onto an existing FILE        OVERWRITES SILENTLY, no -Force needed
 *   directory WITHOUT -Recurse        creates an EMPTY directory, no error
 *   directory WITH -Recurse onto an existing directory   copies INTO it
 *   no -Destination at all            copies into the CURRENT directory
 *   missing source                    PathNotFound / ObjectNotFound
 *   missing destination parent, FILE  CopyFileInfoItemIOError / WriteError /
 *                                     DirectoryNotFoundException
 *   missing destination parent, DIR   CREATED, no error. The asymmetry is real.
 *   source == destination             CopyError / WriteError,
 *                                     "Cannot overwrite the item <p> with itself."
 *   directory onto an existing FILE   CopyContainerItemToLeafError /
 *                                     InvalidArgument
 *   read-only destination             CopyFileInfoItemUnauthorizedAccessError
 *   one of several -Path missing       reports it and copies the others
 *
 * RECURSIVE COPY OVER AN EXISTING TREE, measured precisely because guessing it
 * wrong is silent: FILES ARE OVERWRITTEN, and EVERY directory that is already
 * there raises `DirectoryExist` / ResourceExists — two errors for a two-level
 * tree, parent first — WHILE THE COPY PROCEEDS ANYWAY. `-Force` suppresses
 * those and changes nothing else.
 *
 * ---------------------------------------------------------------------------
 * THE GUARD THIS FILE ADDS THAT pwsh DOES NOT HAVE
 * ---------------------------------------------------------------------------
 *
 * `Copy-Item tree -Destination tree\inner -Recurse` DOES NOT TERMINATE in real
 * pwsh 7.6.5. Confirmed on this machine: the probe printed its "BEFORE" marker
 * and was still building nested copies of itself when a 90-second timeout
 * killed it, by which point it had created 1154 directories and a path 6412
 * characters long. Copy-Item guards `source == destination` — it says "Cannot
 * overwrite the item with itself" — and does NOT guard the subtree case that
 * Move-Item does guard.
 *
 * So this refuses it, deliberately diverging, and `MemoryStorage.copy` already
 * made the same call in its own comment. A faithful reproduction here would
 * hang the visitor's tab with no way back, and fidelity to a defect that
 * destroys the session is not fidelity worth having. The refusal borrows
 * Move-Item's measured wording so the message is at least one pwsh really
 * produces.
 */

import type { PSValue } from '../../pipeline/psobject.ts';
import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import type { CommandManifest } from '../manifest.ts';
import type { FileSystemPort } from '../ports.ts';
import { stringArray, stringValue, switchValue } from '../powershell/support.ts';
import { basename, isDescendant } from '../../storage/index.ts';
import type { FileStat, ResolvedPath, StorageError, WriteOptions } from '../../storage/index.ts';
import {
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
// the plan
// ---------------------------------------------------------------------------

interface DirectoryStep {
  readonly kind: 'directory';
  readonly target: string;
  readonly mode: number;
}
interface FileStep {
  readonly kind: 'file';
  readonly target: string;
  readonly mode: number;
  readonly data: Uint8Array;
}
type CopyStep = DirectoryStep | FileStep;

type Plan = { readonly ok: true; readonly steps: readonly CopyStep[] } | { readonly ok: false; readonly error: StorageError; readonly path: string };

/**
 * Walk the source, reading everything, writing nothing.
 *
 * Parents come before children so the apply phase never writes into a directory
 * it has not made yet — the same ordering `MutationPlan` requires of a journal
 * replaying after a crash, for the same reason.
 *
 * Entries are sorted by name. `readdir` returns the backend's own order by
 * design ("`ls` is what sorts"), and an unsorted plan would make the state left
 * behind by a partial failure depend on insertion order, which is exactly the
 * thing that has to be describable.
 */
async function planCopy(
  port: FileSystemPort,
  source: FileStat,
  sourcePath: string,
  targetPath: string,
  recurse: boolean,
  signal: AbortSignal,
): Promise<Plan> {
  const steps: CopyStep[] = [];

  const walk = async (stat: FileStat, from: string, to: string): Promise<Plan | null> => {
    if (signal.aborted) return null;
    if (stat.kind === 'file') {
      const bytes = await port.readBytes(from);
      if (!bytes.ok) return { ok: false, error: bytes.error, path: from };
      steps.push({ kind: 'file', target: to, mode: stat.mode, data: bytes.value });
      return null;
    }
    steps.push({ kind: 'directory', target: to, mode: stat.mode });
    // MEASURED: a directory copied WITHOUT -Recurse produces an EMPTY directory
    // at the destination and no error at all.
    if (!recurse) return null;

    const entries = await port.readdir(from);
    if (!entries.ok) return { ok: false, error: entries.error, path: from };
    const sorted = [...entries.value].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of sorted) {
      const failure = await walk(entry.stat, `${from}/${entry.name}`, `${to}/${entry.name}`);
      if (failure !== null) return failure;
    }
    return null;
  };

  const failure = await walk(source, sourcePath, targetPath);
  if (failure !== null) return failure;
  return { ok: true, steps };
}

interface Applied {
  readonly written: readonly string[];
  /** The step that stopped the copy, or null when every step was applied. */
  readonly failure: { readonly error: StorageError; readonly path: string } | null;
  /** Directories that were already there. Reported, but not a failure. */
  readonly present: readonly string[];
}

/**
 * Write the plan. Stops at the first genuine failure and says what it wrote.
 *
 * `mkdir` is `recursive: true` because a directory copy is measured to create
 * its missing destination parents; a file copy is `createParents: false`
 * because a file copy is measured NOT to.
 */
async function applyPlan(
  port: FileSystemPort,
  steps: readonly CopyStep[],
  signal: AbortSignal,
): Promise<Applied> {
  const written: string[] = [];
  const present: string[] = [];

  for (const step of steps) {
    if (signal.aborted) break;
    if (step.kind === 'directory') {
      const existing = await port.stat(step.target);
      if (existing.ok) {
        if (existing.value.kind === 'directory') {
          // MEASURED: already-present directories are reported and the copy
          // carries on. Not a failure, so it does not stop the apply.
          present.push(step.target);
          continue;
        }
        // A file is in the way of a directory. `mkdir` would say EEXIST; asking
        // it is what keeps the error the storage layer's rather than ours.
      }
      const made = await port.mkdir(step.target, { recursive: true, mode: step.mode });
      if (!made.ok) return { written, present, failure: { error: made.error, path: step.target } };
      written.push(step.target);
      continue;
    }

    const options: WriteOptions = { mode: step.mode };
    const done = await port.writeBytes(step.target, step.data, options);
    if (!done.ok) return { written, present, failure: { error: done.error, path: step.target } };
    written.push(step.target);
  }

  return { written, present, failure: null };
}

// ---------------------------------------------------------------------------
// shared decision-making
// ---------------------------------------------------------------------------

/**
 * Where one source really lands.
 *
 * MEASURED, and confirmed as the brief asked: a file copied onto an existing
 * DIRECTORY goes INTO it. v1 makes the same decision at its `finalPath`, and
 * every later check — same-item, into-self, container-onto-leaf — has to be
 * about the LANDING rather than about the argument that was typed.
 */
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

function samePath(a: ResolvedPath, b: ResolvedPath): boolean {
  return a.drive === b.drive && a.path === b.path;
}

/** True when the destination is inside the source, which is the loop pwsh runs. */
function intoOwnSubtree(source: ResolvedPath, final: ResolvedPath): boolean {
  return source.drive === final.drive && isDescendant(final.path, source.path);
}

// ---------------------------------------------------------------------------
// Copy-Item
// ---------------------------------------------------------------------------

/** MEASURED ids, one probe each. See the header for which probe produced which. */
const COPY_IDS: ProviderErrorIds = {
  io: 'CopyFileInfoItemIOError',
  access: 'CopyFileInfoItemUnauthorizedAccessError',
  notFound: 'PathNotFound',
  argument: 'CopyError',
};

const COPY_ITEM_MANIFEST = fsWriteManifest(
  'copy-item',
  'Really copies bytes in the browser filesystem. -Path, -LiteralPath, -Destination, -Recurse, ' +
    '-Force and -PassThru are implemented and every behaviour was measured against pwsh 7.6.5: a ' +
    'file copied onto an existing directory goes into it, a file copied onto an existing file ' +
    'overwrites silently without -Force, a directory without -Recurse produces an empty ' +
    'directory, a missing -Destination means the current directory, and a recursive copy over an ' +
    'existing tree overwrites the files while reporting DirectoryExist for each directory that ' +
    'was already there unless -Force. ONE DELIBERATE DIVERGENCE: copying a directory into its own ' +
    'subtree is refused. Real pwsh does not guard it and does not terminate — measured, 1154 ' +
    'nested directories in 90 seconds before the probe had to be killed — and hanging a browser ' +
    'tab is not a fidelity worth reproducing. NOT ATOMIC: FileSystemPort exposes no copy, so the ' +
    'source is read entirely before anything is written and a failure during the write stops the ' +
    'copy and reports which items were already created. There is no rollback, because undoing a ' +
    'copy means deleting and this command is not granted filesystem.delete. -Filter, -Include, ' +
    '-Exclude, -Container, -FromSession, -ToSession and -Credential are not implemented.',
);

/** ENOENT out of a copy is the source, which pwsh reports as PathNotFound. */
function copyShape(error: StorageError, path: string, ids: ProviderErrorIds): PSErrorShape {
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
    // MEASURED: a missing DESTINATION PARENT is CopyFileInfoItemIOError /
    // WriteError / DirectoryNotFoundException, and a missing SOURCE is
    // PathNotFound / ObjectNotFound. The caller decides which it is asking
    // about; this arm is the destination one, and the source is checked by
    // `stat` before any of this runs.
    return {
      id: ids.io,
      category: 'WriteError',
      exceptionType: 'System.IO.DirectoryNotFoundException',
      message: MESSAGES.couldNotFindPart(path),
    };
  }
  return storageShape(error, ids);
}

interface CopyOutcome {
  readonly failed: boolean;
  readonly stop: boolean;
}

/**
 * One source, one landing, all the guards, the plan and the apply.
 *
 * Shared by `Copy-Item` and `cp` because the sequence of decisions is the same
 * on both; only the wording of the refusals differs, and that arrives as
 * `messages`.
 */
async function copyOne(
  context: InvocationContext,
  manifest: CommandManifest,
  port: FileSystemPort,
  spec: string,
  source: ResolvedPath,
  destination: ResolvedPath,
  options: {
    readonly recurse: boolean;
    readonly force: boolean;
    readonly passThru: boolean;
    readonly ids: ProviderErrorIds;
    readonly messages: CopyMessages;
  },
): Promise<CopyOutcome> {
  const { ids, messages } = options;

  const sourceStat = await port.stat(source.full);
  if (!sourceStat.ok) {
    await reportError(context, manifest, messages.missingSource(sourceStat.error, spec, source), spec);
    return { failed: true, stop: false };
  }

  const final = await landingOf(port, source, destination);

  if (samePath(source, final)) {
    await reportError(context, manifest, messages.sameItem(source, spec), source.full);
    return { failed: true, stop: false };
  }

  if (sourceStat.value.kind === 'directory' && intoOwnSubtree(source, final)) {
    // OURS. See the header: pwsh loops here until something kills it.
    await reportError(context, manifest, messages.intoSelf(source, final), final.full);
    return { failed: true, stop: false };
  }

  if (sourceStat.value.kind === 'directory') {
    const target = await port.stat(final.full);
    if (target.ok && target.value.kind === 'file') {
      // MEASURED: CopyContainerItemToLeafError / InvalidArgument /
      // PSArgumentException, "Container cannot be copied onto existing leaf item."
      await reportError(context, manifest, messages.containerOntoLeaf(final), final.full);
      return { failed: true, stop: false };
    }
    if (!options.recurse && messages.requiresRecurse !== null) {
      // GNU `cp` refuses a directory without -r; Copy-Item copies an empty one.
      // The two are genuinely different commands here, so the branch is a
      // property of the wording table rather than a flag.
      await reportError(context, manifest, messages.requiresRecurse(spec), spec);
      return { failed: true, stop: false };
    }
  }

  const plan = await planCopy(
    port,
    sourceStat.value,
    source.full,
    final.full,
    options.recurse,
    context.signal,
  );
  if (!plan.ok) {
    // Nothing has been written. This is the atomic half.
    await reportError(context, manifest, copyShape(plan.error, plan.path, ids), plan.path);
    return { failed: true, stop: false };
  }
  if (cancelled(context)) {
    await reportError(context, manifest, cancellationShape([]), null);
    return { failed: true, stop: true };
  }

  const applied = await applyPlan(port, plan.steps, context.signal);

  // MEASURED: every already-present directory is reported, and the copy carries
  // on regardless. -Force suppresses exactly this and nothing else.
  if (!options.force) {
    for (const path of applied.present) {
      await reportError(context, manifest, messages.directoryExists(path), path);
    }
  }

  if (applied.failure !== null) {
    const shape = copyShape(applied.failure.error, applied.failure.path, ids);
    await reportError(
      context,
      manifest,
      {
        ...shape,
        message:
          `${shape.message} The copy stopped here; ` +
          (applied.written.length === 0
            ? 'nothing was written.'
            : `${String(applied.written.length)} item(s) were already written and remain: ` +
              `${applied.written.join(', ')}.`),
      },
      applied.failure.path,
    );
    return { failed: true, stop: false };
  }

  if (cancelled(context)) {
    await reportError(context, manifest, cancellationShape(applied.written), null);
    return { failed: true, stop: true };
  }

  if (options.passThru) {
    const made = await port.stat(final.full);
    // MEASURED: -PassThru emits the DESTINATION's FileInfo, one per source.
    if (made.ok) await context.streams.success.write(fileSystemInfo(made.value));
  }
  return { failed: applied.present.length > 0 && !options.force, stop: false };
}

/** The wordings that differ between the cmdlet and the coreutil. */
interface CopyMessages {
  missingSource(error: StorageError, spec: string, source: ResolvedPath): PSErrorShape;
  sameItem(source: ResolvedPath, spec: string): PSErrorShape;
  intoSelf(source: ResolvedPath, final: ResolvedPath): PSErrorShape;
  containerOntoLeaf(final: ResolvedPath): PSErrorShape;
  directoryExists(path: string): PSErrorShape;
  /** Null when the command copies an empty directory instead of refusing. */
  requiresRecurse: ((spec: string) => PSErrorShape) | null;
}

const COPY_ITEM_MESSAGES: CopyMessages = {
  missingSource: (error, _spec, source) =>
    error.code === 'ENOENT'
      ? {
          // MEASURED: PathNotFound / ObjectNotFound / ItemNotFoundException.
          id: 'PathNotFound',
          category: 'ObjectNotFound',
          exceptionType: 'System.Management.Automation.ItemNotFoundException',
          message: MESSAGES.cannotFindPath(source.full),
        }
      : storageShape(error, COPY_IDS),
  sameItem: (source) => ({
    // MEASURED: CopyError / WriteError / IOException, and the message has no
    // quotes around the path.
    id: 'CopyError',
    category: 'WriteError',
    exceptionType: 'System.IO.IOException',
    message: MESSAGES.overwriteWithItself(source.full),
  }),
  intoSelf: (source, final) => ({
    // OURS, in Move-Item's measured wording — the sentence pwsh does produce
    // for the same shape, on the one command that guards it.
    id: 'CopyItemArgumentError',
    category: 'InvalidArgument',
    exceptionType: 'System.IO.IOException',
    message:
      `Destination path cannot be a subdirectory of the source or the source itself: ` +
      `${final.full}. Real PowerShell does not refuse this and does not terminate; ` +
      `BrowserShell refuses it rather than filling the visitor's storage. Source: ${source.full}.`,
  }),
  containerOntoLeaf: () => ({
    // MEASURED, including the wording.
    id: 'CopyContainerItemToLeafError',
    category: 'InvalidArgument',
    exceptionType: 'System.Management.Automation.PSArgumentException',
    message: 'Container cannot be copied onto existing leaf item.',
  }),
  directoryExists: (path) => ({
    // MEASURED: DirectoryExist / ResourceExists, once per directory already
    // present, parent before child, while the copy continues.
    id: 'DirectoryExist',
    category: 'ResourceExists',
    exceptionType: 'System.IO.IOException',
    message: MESSAGES.itemExists(path),
  }),
  requiresRecurse: null,
};

export const copyItem: CommandModule = {
  manifest: COPY_ITEM_MANIFEST,

  async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
    const port = await requireFileSystem(context, COPY_ITEM_MANIFEST);
    if (port === null) return exitFor(1);

    const specs =
      stringArray(bound.parameters, 'LiteralPath') ?? stringArray(bound.parameters, 'Path') ?? [];
    if (specs.length === 0) {
      await reportError(
        context,
        COPY_ITEM_MANIFEST,
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

    // MEASURED: no -Destination copies into the CURRENT directory.
    const destinationSpec = stringValue(bound.parameters, 'Destination') ?? '.';
    const destination = port.resolve(destinationSpec);
    if (!destination.ok) {
      await reportError(
        context,
        COPY_ITEM_MANIFEST,
        copyShape(destination.error, destinationSpec, COPY_IDS),
        destinationSpec,
      );
      return exitFor(1);
    }

    const options = {
      recurse: switchValue(bound.parameters, 'Recurse'),
      force: switchValue(bound.parameters, 'Force'),
      passThru: switchValue(bound.parameters, 'PassThru'),
      ids: COPY_IDS,
      messages: COPY_ITEM_MESSAGES,
    };

    let failures = 0;
    for (const spec of specs) {
      if (cancelled(context)) {
        await reportError(context, COPY_ITEM_MANIFEST, cancellationShape([]), null);
        return exitFor(failures + 1);
      }
      const source = port.resolve(spec);
      if (!source.ok) {
        await reportError(context, COPY_ITEM_MANIFEST, copyShape(source.error, spec, COPY_IDS), spec);
        failures += 1;
        continue;
      }
      const outcome = await copyOne(
        context,
        COPY_ITEM_MANIFEST,
        port,
        spec,
        source.value,
        destination.value,
        options,
      );
      if (outcome.failed) failures += 1;
      if (outcome.stop) break;
    }

    return exitFor(failures);
  },
};

// ---------------------------------------------------------------------------
// cp
// ---------------------------------------------------------------------------

/**
 * `cp` is a separate manifest entry, not an alias of Copy-Item, and v1 explains
 * why at the site where it lists them: PowerShell on Linux DELIBERATELY REMOVES
 * the `cp`, `mv`, `ls`, `rm` and `cat` aliases so the real binaries run. So this
 * speaks GNU coreutils — its flags, its wording, its exit code — and v1's
 * implementation is the specification, since there is no pwsh behaviour to
 * measure.
 *
 * The one thing it does NOT inherit from v1 is v1's silence about failure. v1
 * returned rendered rows; here every refusal is an ErrorRecord on stream 2, so
 * `cp missing dst 2>$null` can suppress it and `$LASTEXITCODE` reports 1.
 */
const CP_MANIFEST = fsWriteManifest(
  'cp',
  'GNU coreutils cp, not an alias of Copy-Item: PowerShell on Linux deliberately removes that ' +
    'alias so the real binary runs, and v1 does the same. -r/-R/--recursive and -v/--verbose are ' +
    'implemented; the messages and the refusals follow v1, which is the specification here ' +
    'because there is no pwsh behaviour to measure. A destination that is an existing directory ' +
    'receives the source under its own name. Copying a directory into its own subtree is refused, ' +
    'as it is for Copy-Item and for the same measured reason. NOT ATOMIC — see Copy-Item. ' +
    '-p/--preserve, -i, -n, -u, -l, -s and -t are not implemented; the copy always takes the ' +
    "source's mode and the running user's ownership, which is what v1 does.",
);

/** GNU cp's ids are ours: a coreutil has no ErrorRecord in real PowerShell. */
const CP_IDS: ProviderErrorIds = {
  io: 'CpIOError',
  access: 'CpPermissionDenied',
  notFound: 'CpPathNotFound',
  argument: 'CpArgumentError',
};

const CP_MESSAGES: CopyMessages = {
  missingSource: (error, spec) =>
    error.code === 'ENOENT'
      ? {
          // v1: `cp: cannot stat 'X': No such file or directory`
          id: CP_IDS.notFound,
          category: 'ObjectNotFound',
          exceptionType: 'System.Management.Automation.ItemNotFoundException',
          message: `cp: cannot stat '${spec}': No such file or directory`,
        }
      : storageShape(error, CP_IDS),
  sameItem: (_source, spec) => ({
    // v1: `cp: 'X' and 'Y' are the same file`
    id: CP_IDS.argument,
    category: 'InvalidArgument',
    exceptionType: 'System.IO.IOException',
    message: `cp: '${spec}' and the destination are the same file`,
  }),
  intoSelf: (_source, final) => ({
    // v1: `cp: cannot copy a directory into itself`
    id: CP_IDS.argument,
    category: 'InvalidArgument',
    exceptionType: 'System.IO.IOException',
    message: `cp: cannot copy a directory, '${final.full}', into itself`,
  }),
  containerOntoLeaf: (final) => ({
    id: CP_IDS.argument,
    category: 'InvalidArgument',
    exceptionType: 'System.IO.IOException',
    message: `cp: cannot overwrite non-directory '${final.full}' with directory`,
  }),
  directoryExists: (path) => ({
    // GNU cp merges into an existing directory without complaint, so this is
    // never reported for cp — it is here because the shared engine asks for it.
    id: CP_IDS.io,
    category: 'ResourceExists',
    exceptionType: 'System.IO.IOException',
    message: `cp: '${path}' already exists`,
  }),
  // v1: `cp: -r not specified; omitting directory 'X'`
  requiresRecurse: (spec) => ({
    id: CP_IDS.argument,
    category: 'InvalidArgument',
    exceptionType: 'System.IO.IOException',
    message: `cp: -r not specified; omitting directory '${spec}'`,
  }),
};

export const cp: CommandModule = {
  manifest: CP_MANIFEST,

  async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
    const port = await requireFileSystem(context, CP_MANIFEST);
    if (port === null) return exitFor(1);

    const args = argumentsOf(bound);
    // v1's test: any dash-led token whose letters include r or R.
    const recurse = args.some((token) => /^-[a-zA-Z]*[rR]/u.test(token) || token === '--recursive');
    const verbose = args.some((token) => /^-[a-zA-Z]*v/u.test(token) || token === '--verbose');
    const operands = operandsOf(args);

    if (operands.length < 2) {
      await reportError(
        context,
        CP_MANIFEST,
        {
          id: CP_IDS.argument,
          category: 'InvalidArgument',
          exceptionType: 'System.ArgumentException',
          message:
            operands.length === 0 ? 'cp: missing file operand' : 'cp: missing destination file operand',
        },
        null,
      );
      return exitFor(1);
    }

    const destinationSpec = operands[operands.length - 1] ?? '.';
    const destination = port.resolve(destinationSpec);
    if (!destination.ok) {
      await reportError(
        context,
        CP_MANIFEST,
        copyShape(destination.error, destinationSpec, CP_IDS),
        destinationSpec,
      );
      return exitFor(1);
    }

    let failures = 0;
    for (const spec of operands.slice(0, -1)) {
      if (cancelled(context)) {
        await reportError(context, CP_MANIFEST, cancellationShape([]), null);
        return exitFor(failures + 1);
      }
      const source = port.resolve(spec);
      if (!source.ok) {
        await reportError(context, CP_MANIFEST, copyShape(source.error, spec, CP_IDS), spec);
        failures += 1;
        continue;
      }
      const outcome = await copyOne(context, CP_MANIFEST, port, spec, source.value, destination.value, {
        recurse,
        // GNU cp merges into existing directories silently, which is what
        // `force: true` means to the shared engine: suppress DirectoryExist.
        force: true,
        passThru: false,
        ids: CP_IDS,
        messages: CP_MESSAGES,
      });
      if (outcome.failed) failures += 1;
      else if (verbose) {
        const line: PSValue = `'${spec}' -> '${destination.value.full}'`;
        await context.streams.success.write(line);
      }
      if (outcome.stop) break;
    }

    return exitFor(failures);
  },
};
