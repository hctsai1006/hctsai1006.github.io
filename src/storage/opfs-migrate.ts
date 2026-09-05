/**
 * opfs-migrate.ts — versioned store migrations, and the rollback that makes
 * them safe to attempt.
 *
 * ---------------------------------------------------------------------------
 * TWO VERSIONS, NOT ONE, AND THEY MIGRATE DIFFERENTLY
 * ---------------------------------------------------------------------------
 *
 *   SNAPSHOT_VERSION (`snapshot.ts`, currently 2) versions the DOCUMENT: what
 *   an entry looks like and what the checksum covers. It is enforced by
 *   `decodeSnapshot`, which REFUSES a document it does not understand rather
 *   than guessing — the reasoning is in that file, and the worked example is
 *   tombstones, which cannot be ignored safely by an older reader.
 *
 *   STORE_VERSION (here, currently 1) versions the DURABLE STORE: the framing,
 *   which files exist, and what the checkpoint payload means. It is what a
 *   migration bumps.
 *
 * Keeping them separate is not bookkeeping. A store upgrade that does not
 * change the document (adding a second WAL, say) must not force every
 * checkpoint to be rewritten, and a document upgrade that does not change the
 * store must not force a store migration. Collapsing them into one number
 * makes every change of either kind a change of both.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SHIPPED CHAIN IS EMPTY, AND WHY THAT IS NOT "UNIMPLEMENTED"
 * ---------------------------------------------------------------------------
 *
 * `MIGRATIONS` below is `[]`. Store version 1 is the first durable format this
 * project has ever written, so there is nothing in any user's browser to
 * migrate FROM. Inventing a 0 -> 1 migration for a version 0 that never
 * existed would be a fixture pretending to be history, and this repository has
 * a standing rule against numbers that describe nothing.
 *
 * What is NOT empty is the machinery, and it is the machinery that has to be
 * right before the first real migration is written, because the first real
 * migration is when a user's only copy of their files is on the line. The chain
 * is injectable, and `tests/unit/opfs-migrate.test.mts` drives it with real
 * migrations through: a successful upgrade, a rollback of a successful
 * upgrade, a failing upgrade that leaves the store untouched, a store from a
 * newer build being refused rather than downgraded, a gap in the chain being
 * refused, and a crash between the migration and the checkpoint being
 * recovered from. When the first genuine migration lands it is a data change,
 * not a machinery change.
 *
 * ---------------------------------------------------------------------------
 * WHAT "ROLLBACK" MEANS HERE, PRECISELY
 * ---------------------------------------------------------------------------
 *
 * Two different guarantees, and PR-09's acceptance criterion ("a migration can
 * be rolled back") needs both to be worth anything:
 *
 *   1. A FAILED migration rolls back for free, because a migration is a pure
 *      function from bytes to bytes and nothing is written until the whole
 *      chain has succeeded. There is no half-migrated state to repair, and no
 *      window in which a crash leaves one. This is why `Migration.up` returns
 *      a `Result` instead of mutating a store.
 *
 *   2. A SUCCESSFUL migration can be undone later, because every migration
 *      supplies `down`. That is the one that costs something: a migration
 *      author has to be able to express the inverse, and a migration that
 *      genuinely destroys information has to say so by refusing in `down`
 *      rather than silently returning something lossy.
 *
 * The store also keeps the PREVIOUS generation on disk (see the two checkpoint
 * slots in `opfs-store.ts`), so even without `down` a crash during the
 * checkpoint that follows a migration leaves the pre-migration state readable.
 * That is a third, weaker guarantee, and it is deliberately not called
 * rollback: it survives exactly one further checkpoint.
 */

import { err, ok } from './types.ts';
import type { Result } from './types.ts';

/**
 * The durable store format this build writes.
 *
 * BUMP THIS when the framing changes, when a file is added to or removed from
 * `STORE_FILES`, or when the checkpoint payload stops being a snapshot
 * document — and add a `Migration` in the same commit. A bump with no migration
 * is a store that a returning visitor cannot open.
 */
export const STORE_VERSION = 1;

/**
 * One version step, as a pure function on the checkpoint payload.
 *
 * BYTES IN, BYTES OUT, and not `SnapshotDocument` in and out, because a
 * migration is exactly the operation that may need to change what the payload
 * IS. A migration typed against today's document shape cannot express the
 * migration that stops the payload being that shape, which is the migration
 * most likely to be needed and hardest to add later.
 */
export interface Migration {
  /** The store version this reads. */
  readonly from: number;
  /** The store version it produces. Must be `from + 1`; see `orderMigrations`. */
  readonly to: number;
  /** A one-line description, quoted in the error when the step fails. */
  readonly describe: string;
  up(payload: Uint8Array): Result<Uint8Array>;
  /**
   * The inverse. Refuse — do not approximate — when the step genuinely cannot
   * be undone; a `down` that returns something lossy is worse than one that
   * says it cannot, because the caller believes it worked.
   */
  down(payload: Uint8Array): Result<Uint8Array>;
}

/** Empty on purpose. See the header. */
export const MIGRATIONS: readonly Migration[] = [];

function refuse(reason: string, message: string): Result<never> {
  return err({ code: 'EINVAL', path: '<store>', syscall: 'restore', message, reason });
}

/**
 * Index the chain by `from`, refusing anything that is not a simple ladder.
 *
 * A migration that skips a version, one that goes backwards, one that stands
 * still, and two that claim the same `from` are all refused here rather than at
 * the moment they are needed. The failure a ladder check prevents is subtle:
 * with a 1 -> 3 shortcut present alongside 1 -> 2 and 2 -> 3, which path runs
 * depends on iteration order, and the two paths are not required to agree.
 */
export function orderMigrations(migrations: readonly Migration[]): Result<Map<number, Migration>> {
  const byFrom = new Map<number, Migration>();
  for (const migration of migrations) {
    if (!Number.isInteger(migration.from) || !Number.isInteger(migration.to)) {
      return refuse('non-integer-version', `migration ${migration.describe} has a non-integer version`);
    }
    if (migration.to !== migration.from + 1) {
      return refuse(
        'not-a-ladder',
        `migration ${migration.describe} goes ${String(migration.from)} -> ${String(migration.to)}; ` +
          'every step must advance by exactly one',
      );
    }
    if (byFrom.has(migration.from)) {
      return refuse(
        'duplicate-step',
        `two migrations both start at store version ${String(migration.from)}`,
      );
    }
    byFrom.set(migration.from, migration);
  }
  return ok(byFrom);
}

export interface MigrationReport {
  /** The version the payload started at. */
  readonly from: number;
  /** The version it is at now. */
  readonly to: number;
  /** Each step that ran, in order, by `describe`. Empty when nothing was needed. */
  readonly applied: readonly string[];
  readonly payload: Uint8Array;
}

/**
 * Walk a payload from `from` up to `target`.
 *
 * REFUSES A STORE FROM THE FUTURE. If `from > target` this returns an error and
 * does not run `down` steps to get there, and the distinction is the whole
 * point: a store written by a NEWER build of the site is not something this
 * build knows how to read, and running this build's `down` migrations over it
 * would be inventing an inverse for a step that does not exist here. The user
 * opening an old tab against a new store gets a refusal they can act on
 * ("export from the newer version"), not a silently downgraded filesystem.
 *
 * This mirrors `decodeSnapshot`'s rule for the document axis, and for the same
 * stated reason: "an older reader declines a newer file rather than silently
 * ignoring its tombstones and resurrecting every deleted file".
 */
export function migrateUp(
  payload: Uint8Array,
  from: number,
  target: number,
  migrations: readonly Migration[] = MIGRATIONS,
): Result<MigrationReport> {
  if (!Number.isInteger(from) || from < 0) {
    return refuse('bad-version', `the store records a nonsensical version: ${String(from)}`);
  }
  if (from > target) {
    return refuse(
      'store-from-the-future',
      `the store is at version ${String(from)} and this build reads ${String(target)}. ` +
        'Open the newer version and export, rather than letting an older build rewrite it.',
    );
  }
  const ordered = orderMigrations(migrations);
  if (!ordered.ok) return ordered;

  const applied: string[] = [];
  let current = payload;
  for (let version = from; version < target; version += 1) {
    const step = ordered.value.get(version);
    if (step === undefined) {
      return refuse(
        'missing-step',
        `no migration from store version ${String(version)} to ${String(version + 1)}`,
      );
    }
    const next = step.up(current);
    if (!next.ok) {
      // NOTHING HAS BEEN WRITTEN. The caller still holds the original payload
      // and the store on disk is untouched, which is guarantee (1) in the
      // header. The error names the step so the failure is attributable.
      return err({
        ...next.error,
        message: `migration ${step.describe} failed: ${next.error.message}`,
      });
    }
    applied.push(step.describe);
    current = next.value;
  }
  return ok({ from, to: target, applied, payload: current });
}

/**
 * Walk a payload back down from `from` to `target`. This is the rollback.
 *
 * Deliberately a SEPARATE entry point from `migrateUp` rather than a direction
 * flag. Rolling back is not something that should ever happen implicitly on a
 * mount — a build that silently downgraded a store it did not recognise is the
 * failure `migrateUp` refuses — so it is reachable only from a caller that
 * asked for it by name.
 */
export function migrateDown(
  payload: Uint8Array,
  from: number,
  target: number,
  migrations: readonly Migration[] = MIGRATIONS,
): Result<MigrationReport> {
  if (target > from) {
    return refuse('not-a-rollback', `rolling back to ${String(target)} from ${String(from)} is an upgrade`);
  }
  const ordered = orderMigrations(migrations);
  if (!ordered.ok) return ordered;

  const applied: string[] = [];
  let current = payload;
  for (let version = from; version > target; version -= 1) {
    const step = ordered.value.get(version - 1);
    if (step === undefined) {
      return refuse(
        'missing-step',
        `no migration to roll back store version ${String(version)} to ${String(version - 1)}`,
      );
    }
    const previous = step.down(current);
    if (!previous.ok) {
      return err({
        ...previous.error,
        message: `rollback of ${step.describe} failed: ${previous.error.message}`,
      });
    }
    applied.push(step.describe);
    current = previous.value;
  }
  return ok({ from, to: target, applied, payload: current });
}
