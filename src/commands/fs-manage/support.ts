/**
 * support.ts — the plumbing the seven destructive, interactive and preference
 * commands share.
 *
 * These are the commands that were blocked on `ports.ts`, and they are blocked
 * on it for three different reasons:
 *
 *   Remove-Item, rm       `filesystem.delete`, which the broker gates on EVERY
 *                         call. A command that declared only write cannot get
 *                         at `remove` however it is written.
 *   nano, vi, vim         `DialogPort`. They are not filesystem commands with
 *                         extra steps: they hand a buffer to a person and wait.
 *   Set-Theme             `PreferencesPort`. A theme is not a file, and it is
 *                         not something a visitor should be able to `rm`.
 *   Reset-FileSystem      all three, and the manifest declares one. See the
 *                         header of `reset-filesystem.ts`.
 *
 * THREE RULES THIS FILE ENFORCES, rather than leaving to each command:
 *
 *   1. MANIFESTS ARE READ, NOT WRITTEN. Same rule as `simulated/support.ts`,
 *      for the same reason: a command that declared its own capabilities could
 *      quietly disagree with the classification a reviewer read, and
 *      `Get-Command -Detailed` would print one thing while the code did
 *      another. The lookup refuses anything that is not `browser-backed`,
 *      because a command in this directory really does change stored bytes or
 *      stored preferences and must not be able to claim otherwise.
 *
 *   2. A DENIAL IS AN ErrorRecord, NOT A CRASH. `brokeredFileSystem` throws
 *      `CapabilityDeniedError` — deliberately, so a command cannot ignore it.
 *      But a user who typed `rm` and was refused should see PowerShell's usual
 *      failure shape on stream 2 and a non-zero exit code, not a stack trace
 *      that takes the pipeline down. `fsManageCommand` converts it exactly
 *      once, at the boundary, and the record NAMES the capability so the
 *      refusal is diagnosable.
 *
 *   3. A MISSING PORT IS SAID OUT LOUD. `context.fs`, `context.preferences`
 *      and `context.dialog` are all nullable, and null is the normal case in a
 *      headless run. `invocation.ts` is explicit that a command that needs one
 *      "has to say so rather than crash", so each of the three has one error
 *      shape here and every command uses it.
 *
 * WHAT IS NOT HERE, on purpose: any storage-error-to-ErrorRecord table.
 * `storage/types.ts` measured that the same POSIX condition produces a
 * different FullyQualifiedErrorId and a different category depending on which
 * command hit it — `PathNotFound` for Get-Item, `NewItemIOError` for New-Item,
 * and no error at all for a wildcard that matched nothing. A shared table would
 * have to be wrong for someone. Each command maps its own, next to the pwsh
 * measurement that justifies it.
 */

import manifestsJson from '../manifests.json' with { type: 'json' };

import type { PSValue } from '../../pipeline/psobject.ts';
import { errorRecord } from '../../pipeline/streams.ts';
import type { ErrorCategory } from '../../pipeline/streams.ts';
import type { StorageError } from '../../storage/index.ts';
import { CapabilityDeniedError } from '../invocation.ts';
import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import type { CommandManifest } from '../manifest.ts';
import type { DialogPort, FileSystemPort, PreferencesPort } from '../ports.ts';

// ---------------------------------------------------------------------------
// manifests
// ---------------------------------------------------------------------------

/**
 * The slice of the generated file this module reads back.
 *
 * Declared locally rather than imported, as `simulated/support.ts` does, so
 * that widening `CommandManifest` cannot silently widen what a runtime cast is
 * claiming.
 */
interface ManifestsFile {
  readonly commands: readonly CommandManifest[];
}

const ALL_MANIFESTS: readonly CommandManifest[] = (manifestsJson as unknown as ManifestsFile)
  .commands;

/**
 * Fetch one manifest and refuse anything this directory has no business
 * implementing.
 *
 * Throwing at module load is deliberate, and is the same call
 * `simulated/support.ts` makes: a placeholder would produce a command that
 * runs, changes stored bytes, and misdeclares itself, which is worse than a
 * build that does not start.
 */
export function fsManageManifest(name: string): CommandManifest {
  const found = ALL_MANIFESTS.find((m) => m.name === name);
  if (found === undefined) {
    throw new Error(
      `No manifest named '${name}' in src/commands/manifests.json. Manifests are generated ` +
        'from classification.data.mts; add the classification rather than declaring one here.',
    );
  }
  if (found.fidelity !== 'browser-backed') {
    throw new Error(
      `'${name}' is classified ${found.fidelity}, not browser-backed. Everything in ` +
        'src/commands/fs-manage/ really changes stored bytes or stored preferences, and a ' +
        'command that claims otherwise would be lying about the one thing the fidelity ' +
        'taxonomy exists to state.',
    );
  }
  // A module exists, so the command is implemented — regardless of what the
  // generated file says. Stated here rather than read back from `found`,
  // because the generator derives `implementationStatus` FROM the modules: a
  // manifest that inherited its own status would be a feedback loop, and the
  // first stale run would demote every command in this directory to 'declared'
  // and unregister it.
  return { ...found, implementationStatus: 'implemented' };
}

/** Does this command's own manifest ask for the capability? Gate 1, read directly. */
export function declares(manifest: CommandManifest, capability: string): boolean {
  return manifest.capabilities.some((c) => c === capability);
}

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

/**
 * The tokens after the command name.
 *
 * `rm`, `nano`, `vi` and `vim` declare no parameters, which the binder treats
 * as "everything is `remaining`" — the same treatment the Linux-facade commands
 * get, and correct for the same reason: `rm -rf docs` is not PowerShell
 * parameter syntax, and binding it as if it were would invent metadata the
 * reference implementation never reported.
 */
export function argumentsOf(bound: BindingResult): readonly string[] {
  return bound.remaining;
}

/** v1's `stripQ`: one leading and one trailing quote, nothing cleverer. */
export function stripQuotes(text: string): string {
  return text.replace(/^["']|["']$/gu, '');
}

/**
 * v1's `firstArg`: the first token that does not start with a dash.
 *
 * The test is `/^-/` and NOT the binder's `/^-{1,2}[A-Za-z]/`, reproduced
 * rather than tidied — these commands are held to v1's behaviour, and a "fix"
 * here would be an unannounced change.
 */
export function firstArgument(args: readonly string[]): string {
  for (const token of args) {
    if (!token.startsWith('-')) return stripQuotes(token);
  }
  return '';
}

// ---------------------------------------------------------------------------
// exit codes
// ---------------------------------------------------------------------------

export const EXIT_SUCCESS = 0;
export const EXIT_FAILURE = 1;

// ---------------------------------------------------------------------------
// emitting
// ---------------------------------------------------------------------------

/**
 * Write values to stream 1, stopping if the consumer walks away or the user
 * pressed Ctrl+C.
 *
 * Values, not rendered rows. v1 returned `{cls, txt}` objects carrying a CSS
 * class, which is how its pipeline came to carry formatting; colour is the
 * renderer's decision and is not represented here at all.
 */
export async function writeValues(
  context: InvocationContext,
  values: readonly PSValue[],
): Promise<void> {
  const sink = context.streams.success;
  for (const value of values) {
    if (sink.closed || context.signal.aborted) return;
    await sink.write(value);
  }
}

export interface ErrorSpec {
  readonly message: string;
  /** The bare id. `errorRecord` composes `<id>,<command>`, as PowerShell does. */
  readonly errorId: string;
  readonly category: ErrorCategory;
  /**
   * The .NET exception type, which `catch` and `-ErrorAction` filter on.
   *
   * Optional, and the default is honest rather than convenient: `rm` is a Linux
   * tool with no .NET exception behind it, and naming one would invent a fact
   * about a reference implementation that has none.
   */
  readonly exceptionType?: string;
  readonly target?: PSValue;
}

/** One ErrorRecord on stream 2. */
export async function writeError(
  context: InvocationContext,
  manifest: CommandManifest,
  spec: ErrorSpec,
): Promise<void> {
  await context.streams.error.write(
    errorRecord(spec.message, spec.errorId, manifest.display, spec.category, {
      exceptionType: spec.exceptionType ?? 'System.Exception',
      ...(spec.target === undefined ? {} : { targetObject: spec.target }),
    }),
  );
}

// ---------------------------------------------------------------------------
// the three nullable ports
// ---------------------------------------------------------------------------

/**
 * `PSInvalidOperationException` is what pwsh raises when a cmdlet cannot do the
 * thing it was asked to do for a reason that is not about the arguments —
 * measured: `Remove-Item` on a non-empty directory it cannot prompt about
 * reports exactly this type with category InvalidOperation.
 */
const INVALID_OPERATION = 'System.Management.Automation.PSInvalidOperationException';

/**
 * The filesystem, or an ErrorRecord saying there is none.
 *
 * `ResourceUnavailable` rather than `InvalidOperation`: the command is not
 * wrong, and neither is the argument. The resource this host was meant to
 * supply is missing, and that is a different thing for a script to branch on.
 */
export async function needFileSystem(
  context: InvocationContext,
  manifest: CommandManifest,
): Promise<FileSystemPort | null> {
  if (context.fs !== null) return context.fs;
  await writeError(context, manifest, {
    message:
      `${manifest.display} needs the file system, and this host did not provide one. ` +
      'Storage is the embedder\'s to supply; a headless run has none.',
    errorId: 'FileSystemUnavailable',
    category: 'ResourceUnavailable',
    exceptionType: INVALID_OPERATION,
  });
  return null;
}

/**
 * The dialog, or an ErrorRecord saying there is none.
 *
 * `invocation.ts`: "Null in a headless run, which is the normal case for tests,
 * so a command that needs it has to say so rather than crash." This is that
 * saying-so, written once so all four commands that need a person say it the
 * same way.
 */
export async function needDialog(
  context: InvocationContext,
  manifest: CommandManifest,
  what: string,
): Promise<DialogPort | null> {
  if (context.dialog !== null) return context.dialog;
  await writeError(context, manifest, {
    message:
      `${manifest.display} needs to ${what}, and this host provides no dialog. ` +
      'The engine is headless: it cannot open an editor or ask a question, it can only ' +
      'request one from the host and be told what came back.',
    errorId: 'DialogUnavailable',
    category: 'ResourceUnavailable',
    exceptionType: INVALID_OPERATION,
  });
  return null;
}

/** The preferences store, or an ErrorRecord saying there is none. */
export async function needPreferences(
  context: InvocationContext,
  manifest: CommandManifest,
): Promise<PreferencesPort | null> {
  if (context.preferences !== null) return context.preferences;
  await writeError(context, manifest, {
    message:
      `${manifest.display} needs the preferences store, and this host did not provide one. ` +
      'Durable settings are the embedder\'s to supply; a headless run keeps none.',
    errorId: 'PreferencesUnavailable',
    category: 'ResourceUnavailable',
    exceptionType: INVALID_OPERATION,
  });
  return null;
}

// ---------------------------------------------------------------------------
// storage failures
// ---------------------------------------------------------------------------

/**
 * One sentence for a POSIX condition, in the words the tool being emulated
 * uses.
 *
 * NOT a FullyQualifiedErrorId and not a category — those are the command's,
 * because pwsh's own are. This is only the human half, and it is shared because
 * `strerror` is shared: "Permission denied" reads the same whichever command
 * hit it.
 */
export function strerror(error: StorageError): string {
  switch (error.code) {
    case 'ENOENT':
      return 'No such file or directory';
    case 'EEXIST':
      return 'File exists';
    case 'ENOTDIR':
      return 'Not a directory';
    case 'EISDIR':
      return 'Is a directory';
    case 'ENOTEMPTY':
      return 'Directory not empty';
    case 'EACCES':
      return 'Permission denied';
    case 'ENOSPC':
      return 'No space left on device';
    case 'EINVAL':
      return 'Invalid argument';
    case 'ENAMETOOLONG':
      return 'File name too long';
    case 'EXDEV':
      return 'Invalid cross-device link';
    case 'EROFS':
      return 'Read-only file system';
    case 'EIO':
      return 'Input/output error';
  }
}

// ---------------------------------------------------------------------------
// deleting a tree, interruptibly
// ---------------------------------------------------------------------------

export interface Removal {
  /** How many nodes actually went away. */
  readonly removed: number;
  /** The item the walk stopped at when the user pressed Ctrl+C. */
  readonly cancelledAt: string | null;
  readonly failure: { readonly path: string; readonly error: StorageError } | null;
}

/**
 * Delete a tree children-first, one `remove` call per node.
 *
 * NOT `fs.remove(path, { recursive: true })`, which is a single atomic backend
 * call that no signal can interrupt. Driving the walk here is what lets Ctrl+C
 * stop a recursive delete part way and leave a state that can be DESCRIBED:
 * everything below the reported item is gone, that item and everything above it
 * is not.
 *
 * The per-node call has a second effect `ports.ts` asks for explicitly — "the
 * check is per call rather than once at construction because a command can be
 * long-running and a grant can be dropped underneath it". Withdraw
 * `filesystem.delete` during a long delete and it stops at the next node,
 * rather than being noticed after everything is gone.
 *
 * Shared by `Remove-Item` and `rm` because the WALK is the same operation; what
 * differs between them is which failures are errors and what they are called,
 * and that stays in each command.
 */
export async function removeTree(
  fs: FileSystemPort,
  path: string,
  isDirectory: boolean,
  signal: AbortSignal,
): Promise<Removal> {
  let removed = 0;

  const walk = async (current: string, directory: boolean): Promise<Removal | null> => {
    if (signal.aborted) return { removed, cancelledAt: current, failure: null };

    if (directory) {
      const listing = await fs.readdir(current);
      if (!listing.ok) {
        return { removed, cancelledAt: null, failure: { path: current, error: listing.error } };
      }
      for (const entry of listing.value) {
        const stopped = await walk(
          `${current.endsWith('/') ? current.slice(0, -1) : current}/${entry.name}`,
          entry.stat.kind === 'directory',
        );
        if (stopped !== null) return stopped;
      }
    }

    if (signal.aborted) return { removed, cancelledAt: current, failure: null };
    // The directory is empty by now, so the non-recursive form is enough — and
    // it cannot silently take a subtree the walk has not looked at.
    const gone = await fs.remove(current);
    if (!gone.ok) return { removed, cancelledAt: null, failure: { path: current, error: gone.error } };
    removed += 1;
    return null;
  };

  return (await walk(path, isDirectory)) ?? { removed, cancelledAt: null, failure: null };
}

// ---------------------------------------------------------------------------
// defining a command
// ---------------------------------------------------------------------------

export type FsManageBody = (
  context: InvocationContext,
  bound: BindingResult,
  manifest: CommandManifest,
) => Promise<number>;

/**
 * A `CommandModule` whose manifest comes from the generated file, and whose
 * capability denials arrive as ErrorRecords rather than as an exception that
 * takes the pipeline down.
 *
 * The conversion happens HERE and nowhere else. `ports.ts` is explicit that the
 * throw is the point — a command must not be able to ignore a denial — so it is
 * caught at the outermost boundary, where ignoring it is impossible, and turned
 * into the shape PowerShell gives every other refusal: an ErrorRecord that
 * names what was refused, and exit 1.
 *
 * Only `CapabilityDeniedError` is caught. Anything else is a genuine bug and
 * must not be hidden behind a tidy error message.
 */
export function fsManageCommand(name: string, body: FsManageBody): CommandModule {
  const manifest = fsManageManifest(name);
  return {
    manifest,
    invoke: async (context: InvocationContext, bound: BindingResult): Promise<number> => {
      try {
        return await body(context, bound, manifest);
      } catch (reason) {
        if (!(reason instanceof CapabilityDeniedError)) throw reason;
        await writeError(context, manifest, {
          message:
            `${reason.message}. Capabilities are declared in the command's manifest and ` +
            'granted by the session; both are required, and the manifest is generated from ' +
            'src/commands/classification.data.mts.',
          errorId: 'CapabilityDenied',
          category: 'PermissionDenied',
          exceptionType: 'System.UnauthorizedAccessException',
          target: reason.capability,
        });
        return EXIT_FAILURE;
      }
    },
  };
}
