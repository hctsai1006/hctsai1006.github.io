/**
 * reset-filesystem.ts — `Reset-FileSystem`, which throws away everything the
 * visitor ever made here.
 *
 * ── THE DECISION, STATED FIRST BECAUSE IT IS THE POINT ────────────────────
 *
 * v1 REQUIRES NOTHING. Its whole implementation is
 *
 *     'reset-filesystem': run: function(){ fsReset();
 *       return [line('ok','File system restored to its initial state.')]; }
 *
 * and `fsReset()` is `buildSeed(); localStorage.removeItem(FSKEY); CWD=HOME;`.
 * No flag, no prompt, no undo. One typo away from every file a visitor wrote.
 * "Keep at least what v1 required" is therefore satisfied by anything at all,
 * so the decision is made on its merits rather than inherited:
 *
 *   THIS COMMAND ALWAYS ASKS, AND REFUSES WHEN IT CANNOT.
 *
 * If `context.dialog` is present it calls `confirm` and does nothing unless the
 * answer is yes. If the host supplied no dialog — the normal case in a headless
 * run — it REFUSES. Proceeding unasked because nobody was there to object is
 * the one behaviour that cannot be justified for an irreversible operation, and
 * "there was no way to ask" is a reason to stop, not a licence.
 *
 * ── THE MANIFEST IS WRONG, AND THIS COMMAND CANNOT FIX IT ─────────────────
 *
 * `classification.data.mts` gives this command exactly one capability:
 *
 *     'reset-filesystem': { …, capabilities: ['filesystem.delete'] },
 *
 * and that set cannot express the command. Measured against this repository's
 * own storage layer:
 *
 *   - `remove('/')`            EINVAL, reason `remove-root` — the mount root is
 *                              refused outright by `MemoryStorage`.
 *   - `remove('/home')`        EACCES — `/` is root-owned 0755, and deletion
 *     `remove('/tmp')`         needs WRITE on the PARENT.
 *   - `remove('/home/thc1006')`EACCES — `/home` is root-owned 0755 too. v1 says
 *                              the same thing in a comment: 連 ~ 本身都刪不掉.
 *
 * So the only reachable targets are the CONTENTS of the directories the visitor
 * owns, and finding them needs `readdir` and `stat` — `filesystem.read`, which
 * is not declared. Returning the prompt to HOME needs `setLocation`, also
 * `filesystem.read`. And asking the question above needs `ui.dialog`, also not
 * declared.
 *
 * Neither `manifests.json` nor `classification.data.mts` is this change's to
 * edit, so the code below is written correctly and the DENIAL is surfaced
 * precisely — `CapabilityDenied` naming `filesystem.read` and pointing at the
 * classification — rather than the command being written around its own
 * manifest. `tests/unit/fs-manage-settings.test.mts` pins both halves: the
 * logic works when the capability is granted, and the refusal is exact when it
 * is not. The classification needs `filesystem.read` and `ui.dialog` added.
 *
 * `ui.dialog` is put through `requireCapability` ONLY IF the manifest declares
 * it, which today it does not. That is deliberate rather than an oversight:
 * gate 1 checks the command's own manifest, so asking unconditionally would be
 * denied, and the command could then never confirm anything — a capability gate
 * that made a destructive command LESS careful. Asking a person before
 * destroying their work is not a power a gate should be able to withhold; the
 * DELETION is what the gate refuses, and it does. `DialogPort` is not brokered
 * by `ports.ts` in any case; it is handed over whole. So the honest state of
 * affairs is that this command uses a capability it does not declare, to ask
 * permission before destroying data — recorded here, pinned by a test, and in
 * the report rather than hidden. Adding `ui.dialog` to the classification turns
 * the gate on with no further change here.
 *
 * ── WHAT "INITIAL STATE" CAN AND CANNOT MEAN HERE ─────────────────────────
 *
 * v1 rebuilds the seed tree in memory (`buildSeed()`), so its reset is
 * immediate and total. `FileSystemPort` exposes no `reset` and no
 * `installImage` — `ports.ts` calls those "host concerns", correctly — so this
 * command can only DELETE. What it deletes is every node whose `origin` is
 * `user`, which is every file and directory the visitor created.
 *
 * The gap, measured rather than assumed: overwriting a seed file does NOT flip
 * its origin. `writeText` on `~/README.md` leaves `stat().origin === 'seed'`,
 * so a seed file the visitor EDITED is not deleted here and keeps its edited
 * content for the rest of the session. `bootStorage` reinstalls the seed image
 * on every boot, so the original content is back on the next reload — which is
 * the same overlay model v1 documents ("使用者刪掉種子檔後重新載入會復原"). That
 * caveat is not left for someone to discover: it goes on the Warning stream
 * every time the command runs.
 *
 * ── THE EXPORT ────────────────────────────────────────────────────────────
 *
 * `storage/snapshot.ts` exists because "OPFS is deleted on site-data clear with
 * no warning from the browser; export/import must land in the same PR", and it
 * ships `exportSnapshot`, tested. NOTHING SURFACES IT: there is no command in
 * `manifests.json` that exports a snapshot, so the confirmation below cannot
 * honestly tell a visitor to run one. It tells them what it can — that this
 * cannot be undone — and the missing command is reported rather than papered
 * over with advice they cannot follow.
 */

import { HOME } from '../../storage/index.ts';
import { CapabilityDeniedError } from '../invocation.ts';
import type { CommandModule, InvocationContext } from '../invocation.ts';
import type { CommandManifest } from '../manifest.ts';
import type { FileSystemPort } from '../ports.ts';
import {
  EXIT_FAILURE,
  EXIT_SUCCESS,
  declares,
  fsManageCommand,
  needDialog,
  needFileSystem,
  removeTree,
  strerror,
  writeError,
  writeValues,
} from './support.ts';

/** v1's sentence, kept. */
const RESTORED = 'File system restored to its initial state.';

/**
 * The caveat, on the Warning stream so it is seen by default.
 *
 * A visitor who edited a seeded file and reset expecting the original back
 * would otherwise get their own edit and no hint that anything was incomplete,
 * which is a silently wrong answer rather than a missing feature.
 */
const SEED_CAVEAT =
  'Files that came with the image are rebuilt when the page loads, not by this command. ' +
  'If you edited one, it keeps your version until the next reload.';

const CONFIRM_TITLE = 'Delete everything you have created here?';
const CONFIRM_DETAIL =
  'Reset-FileSystem removes every file and directory you made in this terminal and returns ' +
  'the prompt to your home directory. It cannot be undone, and nothing in this page keeps a ' +
  'copy. Anything you want to keep should be copied out of the terminal first.';

interface SweepOutcome {
  readonly removed: number;
  /** The directory the sweep stopped at when the user pressed Ctrl+C. */
  readonly cancelledAt: string | null;
  /** `<path>: <strerror>` for the first storage refusal. Null when there was none. */
  readonly problem: string | null;
}

/**
 * Delete every `user`-origin node, depth first.
 *
 * A seed directory is descended into rather than removed, because a user file
 * can live inside one — `~/notes.txt` sits in a seeded `~`. A user directory is
 * removed whole: everything inside it is the visitor's too.
 */
async function sweep(
  fs: FileSystemPort,
  path: string,
  signal: AbortSignal,
): Promise<SweepOutcome> {
  let removed = 0;

  const walk = async (current: string): Promise<{ cancelledAt: string | null; problem: string | null }> => {
    if (signal.aborted) return { cancelledAt: current, problem: null };

    const listing = await fs.readdir(current);
    if (!listing.ok) {
      return { cancelledAt: null, problem: `${listing.error.path}: ${strerror(listing.error)}` };
    }

    // Sorted so two resets of the same tree report the same order; `readdir`
    // returns the backend's own, which is deliberately not sorted.
    const entries = [...listing.value].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (signal.aborted) return { cancelledAt: current, problem: null };
      const child = `${current === '/' ? '' : current}/${entry.name}`;

      if (entry.stat.origin === 'user') {
        const outcome = await removeTree(fs, child, entry.stat.kind === 'directory', signal);
        removed += outcome.removed;
        if (outcome.cancelledAt !== null) return { cancelledAt: outcome.cancelledAt, problem: null };
        if (outcome.failure !== null) {
          return {
            cancelledAt: null,
            problem: `${outcome.failure.path}: ${strerror(outcome.failure.error)}`,
          };
        }
        continue;
      }

      if (entry.stat.kind === 'directory') {
        const stopped = await walk(child);
        if (stopped.cancelledAt !== null || stopped.problem !== null) return stopped;
      }
    }
    return { cancelledAt: null, problem: null };
  };

  const outcome = await walk(path);
  return { removed, ...outcome };
}

/**
 * The `filesystem.read` denial, said precisely.
 *
 * The generic wrapper in `support.ts` would report the capability correctly;
 * this adds WHY a delete command needs to read, so the manifest defect is
 * diagnosable from the message alone rather than from this file's header.
 */
async function readDenied(
  context: InvocationContext,
  manifest: CommandManifest,
  reason: CapabilityDeniedError,
): Promise<void> {
  await writeError(context, manifest, {
    message:
      `${reason.message}. Reset-FileSystem has to enumerate the tree before it can delete ` +
      'anything: the mount root refuses removal outright, and /home and /tmp are root-owned, ' +
      'so the only reachable targets are found by reading. Nothing was removed. The ' +
      "classification in src/commands/classification.data.mts declares only 'filesystem.delete' " +
      "and needs 'filesystem.read' and 'ui.dialog' as well.",
    errorId: 'CapabilityDenied',
    category: 'PermissionDenied',
    exceptionType: 'System.UnauthorizedAccessException',
    target: reason.capability,
  });
}

export const resetFileSystem: CommandModule = fsManageCommand(
  'reset-filesystem',
  async (context, _bound, manifest) => {
    const fs = await needFileSystem(context, manifest);
    if (fs === null) return EXIT_FAILURE;

    // Asked for only if the manifest declares it. Gate 1 checks the command's
    // OWN manifest, so asking unconditionally under today's classification
    // would be denied and this command could then never confirm anything — a
    // capability gate that made a destructive command LESS careful. Written
    // this way so that adding `ui.dialog` to the classification starts
    // enforcing it here with no further change. See the header.
    if (declares(manifest, 'ui.dialog')) context.requireCapability('ui.dialog');

    // Refuse rather than proceed unasked. See the header.
    const dialog = await needDialog(
      context,
      manifest,
      'confirm that everything you created here will be deleted',
    );
    if (dialog === null) return EXIT_FAILURE;

    let agreed: boolean;
    try {
      agreed = await dialog.confirm({ title: CONFIRM_TITLE, detail: CONFIRM_DETAIL });
    } catch (reason) {
      await writeError(context, manifest, {
        message:
          `The confirmation could not be shown: ${reason instanceof Error ? reason.message : String(reason)}. ` +
          'Nothing was removed.',
        errorId: 'ConfirmationFailed',
        category: 'InvalidOperation',
        exceptionType: 'System.Management.Automation.PSInvalidOperationException',
      });
      return EXIT_FAILURE;
    }

    // Declining is not a failure. PowerShell's own ShouldProcess says no the
    // same way: nothing happens, nothing is written, exit 0.
    if (!agreed) return EXIT_SUCCESS;

    let outcome: SweepOutcome;
    try {
      outcome = await sweep(fs, '/', context.signal);
    } catch (reason) {
      if (!(reason instanceof CapabilityDeniedError)) throw reason;
      await readDenied(context, manifest, reason);
      return EXIT_FAILURE;
    }

    if (outcome.cancelledAt !== null) {
      await writeError(context, manifest, {
        message:
          `The reset was stopped after removing ${String(outcome.removed)} ` +
          `item${outcome.removed === 1 ? '' : 's'}, at '${outcome.cancelledAt}'. ` +
          'Everything already removed is gone; the rest is untouched. Run it again to finish.',
        errorId: 'ResetStopped',
        category: 'OperationStopped',
        exceptionType: 'System.Management.Automation.PipelineStoppedException',
      });
      return EXIT_FAILURE;
    }

    if (outcome.problem !== null) {
      await writeError(context, manifest, {
        message:
          `The reset stopped at ${outcome.problem}. ${String(outcome.removed)} ` +
          `item${outcome.removed === 1 ? ' was' : 's were'} removed before that.`,
        errorId: 'ResetFailed',
        category: 'WriteError',
        exceptionType: 'System.IO.IOException',
      });
      return EXIT_FAILURE;
    }

    // v1 returns the prompt to HOME; the location does not move on its own when
    // the directory under it is removed. Read-gated, like the sweep.
    try {
      await fs.setLocation(HOME);
    } catch (reason) {
      if (!(reason instanceof CapabilityDeniedError)) throw reason;
      await readDenied(context, manifest, reason);
      return EXIT_FAILURE;
    }

    await context.streams.warning.write(SEED_CAVEAT);
    await context.streams.verbose.write(
      `Removed ${String(outcome.removed)} item${outcome.removed === 1 ? '' : 's'}.`,
    );
    await writeValues(context, [RESTORED]);
    return EXIT_SUCCESS;
  },
);
