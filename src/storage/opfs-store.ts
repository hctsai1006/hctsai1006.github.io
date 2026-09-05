/**
 * opfs-store.ts — the durable half: two checkpoint slots, one log, and the
 * recovery that turns them back into an overlay.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS ACTUALLY ON DISK, AND WHY IT IS NOT A MIRRORED TREE
 * ---------------------------------------------------------------------------
 *
 * The durable representation is a CHECKPOINT (the overlay snapshot document
 * that `snapshot.ts` already produces) plus a WRITE-AHEAD LOG of the mutations
 * since it. It is not one OPFS file per virtual file. Three reasons, in the
 * order they were decided:
 *
 *   1. NAMES. Measured in Chromium 152 (see `opfs-platform.ts`): a lone
 *      surrogate in a name is silently replaced with U+FFFD, so two distinct
 *      virtual names can collide into one OPFS entry with no error; and case
 *      folding is unspecified, so `README` and `readme` may or may not be the
 *      same file depending on the engine. A mirrored tree has to solve that.
 *      A fixed set of ASCII file names never asks the question.
 *
 *   2. LOCKING. A sync access handle takes an exclusive lock on ONE FILE ENTRY.
 *      There is no directory lock. A mirrored tree is therefore protected node
 *      by node, and a multi-file mutation — every `cp -r`, every `mv` — has no
 *      way to be exclusive against a second tab. A store held in five files
 *      whose handles this process holds open for its whole life is covered
 *      completely, by the platform. MEASURED: a second tab's worker asking for
 *      the same file got `NoModificationAllowedError`.
 *
 *   3. THE SEAM. `types.ts` already specified that the log's records are
 *      `MutationPlan`s and that they attach at `journal.write`. A mirrored tree
 *      would need its log at a different layer, and the seam that 46 storage
 *      tests already exercise would go unused.
 *
 * The cost, stated plainly: the working set is in memory, so this design is
 * bounded by RAM rather than by quota. That is not a new limit. `types.ts`
 * already commits to it — "No file locking or open handles. Commands read and
 * write whole files. `nano` reads, edits in memory, writes back. Nothing
 * streams yet." — and a design that streams needs a different `StorageBackend`
 * first, not a different disk layout.
 *
 * ---------------------------------------------------------------------------
 * TWO SLOTS, ONE GENERATION COUNTER
 * ---------------------------------------------------------------------------
 *
 * Writing a checkpoint over the only copy of the checkpoint is the classic way
 * to lose everything: crash halfway and there is no old copy and no new one.
 * OPFS offers no atomic rename to dodge it with — `FileSystemHandle.move()` is
 * a Chromium extension, not in the WHATWG standard, and nothing here may depend
 * on it. So there are two slots, A and B, each self-describing:
 *
 *     0   8   magic, ASCII "BSCKP001"
 *     8   4   u32 LE  framing version
 *     12  4   u32 LE  STORE version (what `opfs-migrate.ts` bumps)
 *     16  4   u32 LE  generation
 *     20  4   u32 LE  payload length
 *     24  4   u32 LE  payload FNV-1a-32
 *     28  n   payload (a snapshot document, overlay scope)
 *
 * A checkpoint writes the INACTIVE slot, flushes it, and only then resets the
 * log. Mount reads both slots, discards any that fail their own checksum, and
 * takes the survivor with the highest generation. Every interruption lands
 * somewhere safe:
 *
 *   crash while writing slot B   -> B fails its checksum, A (gen g) + log (gen g) win
 *   crash after B, before the log reset
 *                                -> B (gen g+1) wins; the log still says gen g,
 *                                   so it is stale and discarded WHOLE. Correct:
 *                                   everything in it is already inside B.
 *   crash mid-append to the log  -> the torn record fails its checksum and
 *                                   everything from there on is dropped
 *
 * That last one is why the log carries the generation at all. Without it,
 * recovery would replay plans the new checkpoint already contains, and the
 * steps are absolute rather than incremental — a `write` replays harmlessly, a
 * `remove` of an already-removed path does not.
 *
 * ---------------------------------------------------------------------------
 * WHY THE JOURNAL DOES NOT RECORD DURING BOOT
 * ---------------------------------------------------------------------------
 *
 * `bootStorage` resets the mount, installs the seed, and grafts the overlay
 * through the ordinary write API. Every one of those grafted writes would
 * otherwise go through `#commit` and land in the log — a log which is about to
 * be reset by the checkpoint that ends the mount sequence. Worse, if the tab
 * died in the middle of that, the next mount would replay a graft of a
 * checkpoint on top of a restore of the same checkpoint.
 *
 * So `OpfsJournal` starts NOT RECORDING and is switched on exactly once, by
 * `mount()`, after recovery has finished. Until then the durable store is the
 * authority and nothing that happens in memory is worth logging: a tab that
 * dies during boot leaves the store byte-identical and the next boot performs
 * the same recovery. The transition is one-way and has no matching `stop`,
 * because a journal that can be silently switched off is a journal whose
 * durability is a runtime question.
 */

import { MemoryStorage } from './memory.ts';
import {
  createSnapshot,
  decodeSnapshot,
  encodeSnapshot,
  exportSnapshot,
  restoreSnapshot,
} from './snapshot.ts';
import { err, ok } from './types.ts';
import type {
  MutationPlan,
  QuotaUsage,
  Result,
  SeedSpec,
  StorageError,
} from './types.ts';
import {
  STORE_FILES,
  SyncFile,
  UNKNOWN_USAGE,
  fnv1a32Bytes,
  isNotFound,
} from './opfs-platform.ts';
import type { OpfsDirectory } from './opfs-platform.ts';
import { MIGRATIONS, STORE_VERSION, migrateDown, migrateUp } from './opfs-migrate.ts';
import type { Migration, MigrationReport } from './opfs-migrate.ts';
import { OpfsJournal, WAL_HEADER_BYTES, parseWal, walHeader } from './opfs-wal.ts';

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('utf-8', { fatal: false });

export const SLOT_MAGIC = 'BSCKP001';
export const SLOT_FRAMING_VERSION = 1;
export const SLOT_HEADER_BYTES = 28;

/**
 * What the user sees if they open DevTools and look at the origin private file
 * system. Rewritten on every checkpoint, never read back.
 *
 * Not decoration: OPFS is invisible, undiscoverable and deleted without warning
 * when site data is cleared — PR-09 names that as the risk the export path
 * exists for. Somebody who finds these files deserves to be told what they are
 * and how to get their data out, in the place they found them.
 */
function readmeText(generation: number, version: number, iso: string): string {
  return [
    'BrowserShell durable filesystem',
    '',
    `store version ${String(version)}, checkpoint generation ${String(generation)}, written ${iso}`,
    '',
    `  ${STORE_FILES.slotA} / ${STORE_FILES.slotB}   checkpoint slots; the one with the`,
    '                                higher generation that passes its checksum wins',
    `  ${STORE_FILES.wal}                     write-ahead log of mutations since the checkpoint`,
    `  ${STORE_FILES.rollback}                pre-migration copy, present only during an upgrade`,
    '',
    'These files are the ONLY copy of anything you created in the terminal, and the',
    'browser deletes them without warning when you clear site data for this origin.',
    'Run Export-FileSystem in the terminal to get a portable copy you own.',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// slots
// ---------------------------------------------------------------------------

export interface SlotContents {
  readonly storeVersion: number;
  readonly generation: number;
  readonly payload: Uint8Array;
}

export function encodeSlot(contents: SlotContents): Uint8Array {
  const bytes = new Uint8Array(SLOT_HEADER_BYTES + contents.payload.byteLength);
  bytes.set(ENCODER.encode(SLOT_MAGIC), 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, SLOT_FRAMING_VERSION, true);
  view.setUint32(12, contents.storeVersion, true);
  view.setUint32(16, contents.generation, true);
  view.setUint32(20, contents.payload.byteLength, true);
  view.setUint32(24, fnv1a32Bytes(contents.payload), true);
  bytes.set(contents.payload, SLOT_HEADER_BYTES);
  return bytes;
}

/**
 * Null for every unreadable slot, and null is not an error.
 *
 * An empty slot (a store being created), a half-written slot (a crash), and a
 * slot from a framing this build does not know are all "this slot does not
 * count", and the caller's job is to look at the other one. Returning a
 * `Result` here would make the ordinary case — a brand new store where both
 * slots are zero bytes — arrive as two errors that have to be swallowed.
 */
export function decodeSlot(bytes: Uint8Array): SlotContents | null {
  if (bytes.byteLength < SLOT_HEADER_BYTES) return null;
  if (DECODER.decode(bytes.subarray(0, 8)) !== SLOT_MAGIC) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8, true) !== SLOT_FRAMING_VERSION) return null;
  const storeVersion = view.getUint32(12, true);
  const generation = view.getUint32(16, true);
  const length = view.getUint32(20, true);
  const checksum = view.getUint32(24, true);
  if (SLOT_HEADER_BYTES + length > bytes.byteLength) return null;
  const payload = bytes.slice(SLOT_HEADER_BYTES, SLOT_HEADER_BYTES + length);
  if (fnv1a32Bytes(payload) !== checksum) return null;
  return { storeVersion, generation, payload };
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

export interface OpfsStoreOptions {
  /** Where to put the store directory. `navigator.storage.getDirectory()`. */
  readonly root: OpfsDirectory;
  /** Overridden only by tests that want two stores in one fake origin. */
  readonly directory?: string;
  /** Read at the moment of an ENOSPC, so the refusal can carry real numbers. */
  readonly usage?: () => QuotaUsage;
  /** The migration ladder. Defaults to the shipped (empty) one. */
  readonly migrations?: readonly Migration[];
  /**
   * Bytes of log that trigger a checkpoint after a mutation. Default 256 KiB.
   *
   * The tradeoff is entirely between recovery time and steady-state write cost,
   * and it is a genuine tradeoff rather than a tuned number: a checkpoint
   * rewrites the whole overlay, so a small threshold means writing the whole
   * filesystem often; a large one means a long replay after a crash. 256 KiB is
   * roughly a thousand small-file writes, which is far more than a terminal
   * session produces and far less than a crash-replay anyone would notice.
   */
  readonly checkpointBytes?: number;
}

export interface RecoveryReport {
  /** The generation that was read, or 0 for a store that did not exist. */
  readonly generation: number;
  readonly storeVersion: number;
  /** Which slot won, for diagnostics. Null when the store was empty. */
  readonly slot: 'a' | 'b' | null;
  /** Migrations that ran on the way in. */
  readonly migrated: readonly string[];
  /** Committed plans read out of the log and handed back to be replayed. */
  readonly replay: readonly MutationPlan[];
  /** Bytes at the end of the log that were torn. Non-zero means a crash. */
  readonly truncatedBytes: number;
  /** The overlay to hand to `bootStorage`, or null when there is nothing yet. */
  readonly overlay: Uint8Array | null;
  /** Slots that were present but unreadable. Non-empty means damage. */
  readonly damaged: readonly ('a' | 'b')[];
}

/**
 * The durable store. One instance per process, holding every handle open.
 *
 * `open` acquires the locks and reads; `recover` interprets; `checkpoint`
 * writes. Nothing here knows what a file is — that is `MemoryStorage`'s job,
 * and keeping the split means the POSIX semantics that 46 regression tests
 * already pin down are the same semantics in the browser.
 */
export class OpfsStore {
  readonly #slotA: SyncFile;
  readonly #slotB: SyncFile;
  readonly #walFile: SyncFile;
  readonly #directory: OpfsDirectory;
  readonly #usage: () => QuotaUsage;
  readonly #migrations: readonly Migration[];
  readonly #checkpointBytes: number;
  readonly journal: OpfsJournal;

  #generation = 0;
  #storeVersion = STORE_VERSION;
  /** Which slot the CURRENT generation is in. The next checkpoint writes the other. */
  #active: 'a' | 'b' = 'b';
  #closed = false;

  private constructor(parts: {
    slotA: SyncFile;
    slotB: SyncFile;
    walFile: SyncFile;
    directory: OpfsDirectory;
    usage: () => QuotaUsage;
    migrations: readonly Migration[];
    checkpointBytes: number;
    journal: OpfsJournal;
  }) {
    this.#slotA = parts.slotA;
    this.#slotB = parts.slotB;
    this.#walFile = parts.walFile;
    this.#directory = parts.directory;
    this.#usage = parts.usage;
    this.#migrations = parts.migrations;
    this.#checkpointBytes = parts.checkpointBytes;
    this.journal = parts.journal;
  }

  /**
   * Take the store: create the directory, open all three files exclusively.
   *
   * THE ORDER MATTERS ON FAILURE. If the second handle cannot be taken because
   * another tab holds it, the first one has already been taken and must be
   * given back — otherwise this process holds a lock on a store it is not
   * using, and the tab that DOES own the store cannot checkpoint. Every early
   * return below closes what it opened.
   */
  static async open(options: OpfsStoreOptions): Promise<Result<OpfsStore>> {
    const usage = options.usage ?? ((): QuotaUsage => UNKNOWN_USAGE);
    const name = options.directory ?? 'browsershell';

    let directory: OpfsDirectory;
    try {
      directory = await options.root.getDirectoryHandle(name, { create: true });
    } catch (cause) {
      return err({
        code: 'EIO',
        path: name,
        syscall: 'write',
        message: `could not open the store directory: ${String(cause)}`,
        cause: String(cause),
      });
    }

    const opened: SyncFile[] = [];
    const give = <T>(failure: Result<T>): Result<never> => {
      for (const file of opened) file.close();
      return failure as Result<never>;
    };

    const slotA = await SyncFile.open(directory, STORE_FILES.slotA, { create: true });
    if (!slotA.ok) return give(slotA);
    opened.push(slotA.value);

    const slotB = await SyncFile.open(directory, STORE_FILES.slotB, { create: true });
    if (!slotB.ok) return give(slotB);
    opened.push(slotB.value);

    const walFile = await SyncFile.open(directory, STORE_FILES.wal, { create: true });
    if (!walFile.ok) return give(walFile);
    opened.push(walFile.value);

    const journal = new OpfsJournal({
      file: walFile.value,
      generation: 0,
      append: WAL_HEADER_BYTES,
      usage,
    });

    return ok(
      new OpfsStore({
        slotA: slotA.value,
        slotB: slotB.value,
        walFile: walFile.value,
        directory,
        usage,
        migrations: options.migrations ?? MIGRATIONS,
        checkpointBytes: options.checkpointBytes ?? 256 * 1024,
        journal,
      }),
    );
  }

  get generation(): number {
    return this.#generation;
  }

  get storeVersion(): number {
    return this.#storeVersion;
  }

  get activeSlot(): 'a' | 'b' {
    return this.#active;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Read both slots and the log, migrate, and say what should be restored.
   *
   * Returns the overlay bytes for `bootStorage` and the committed plans for
   * `MemoryStorage.replay`. It does NOT touch the backend: recovery decides,
   * `mount` in `opfs.ts` acts. That split is what makes recovery testable
   * against a fake directory with no filesystem anywhere in sight.
   */
  async recover(): Promise<Result<RecoveryReport>> {
    const rolledBack = await this.#finishInterruptedMigration();
    if (!rolledBack.ok) return rolledBack;

    const a = this.#slotA.readAll();
    if (!a.ok) return a;
    const b = this.#slotB.readAll();
    if (!b.ok) return b;

    const parsedA = decodeSlot(a.value);
    const parsedB = decodeSlot(b.value);
    const damaged: ('a' | 'b')[] = [];
    if (parsedA === null && a.value.byteLength > 0) damaged.push('a');
    if (parsedB === null && b.value.byteLength > 0) damaged.push('b');

    // Highest generation wins, and a tie goes to A only because a tie cannot
    // happen: `checkpoint` always writes the inactive slot at generation + 1.
    // A tie in the file means someone edited one, and either answer is a guess.
    let winner: { contents: SlotContents; slot: 'a' | 'b' } | null = null;
    if (parsedA !== null) winner = { contents: parsedA, slot: 'a' };
    if (parsedB !== null && (winner === null || parsedB.generation > winner.contents.generation)) {
      winner = { contents: parsedB, slot: 'b' };
    }

    if (winner === null) {
      // A store that does not exist yet. Both slots are zero bytes, the log is
      // empty, and the correct overlay is "none" — `bootStorage` then installs
      // the seed and nothing else, which is exactly a first visit.
      this.#generation = 0;
      this.#storeVersion = STORE_VERSION;
      this.#active = 'b';
      const fresh = this.journal.reset(0);
      if (!fresh.ok) return fresh;
      return ok({
        generation: 0,
        storeVersion: STORE_VERSION,
        slot: null,
        migrated: [],
        replay: [],
        truncatedBytes: 0,
        overlay: null,
        damaged,
      });
    }

    const migrated = await this.#migrate(winner.contents, winner.slot);
    if (!migrated.ok) return migrated;
    const current = migrated.value.contents;

    this.#generation = current.generation;
    this.#storeVersion = current.storeVersion;
    this.#active = migrated.value.slot;

    // The log, and the generation gate that decides whether it counts.
    const raw = this.#walFile.readAll();
    if (!raw.ok) return raw;
    let replay: readonly MutationPlan[] = [];
    let truncatedBytes = 0;
    const parsed = parseWal(raw.value);
    if (parsed.ok && parsed.value.generation === current.generation) {
      truncatedBytes = parsed.value.truncatedBytes;
      const committed = await this.journal.replayable();
      if (!committed.ok) return committed;
      replay = committed.value;
    } else if (parsed.ok) {
      // A log from a generation the checkpoint has already absorbed. Not
      // damage; the ordinary result of dying between "slot flushed" and "log
      // reset". Everything in it is inside the checkpoint already.
      truncatedBytes = 0;
    }

    // Reset unconditionally. Whether the log was stale, torn or clean, from
    // here on it belongs to THIS generation, and a log left half-trusted is the
    // state nothing downstream can reason about.
    const cleared = this.journal.reset(current.generation);
    if (!cleared.ok) return cleared;

    return ok({
      generation: current.generation,
      storeVersion: current.storeVersion,
      slot: migrated.value.slot,
      migrated: migrated.value.applied,
      replay,
      truncatedBytes,
      overlay: current.payload,
      damaged,
    });
  }

  /**
   * Run the migration ladder over the winning slot, and write the result.
   *
   * The pre-migration bytes go to `rollback.bin` FIRST and are flushed there
   * before anything else is touched, so an interruption anywhere after that
   * point is recoverable — `#finishInterruptedMigration` puts them back on the
   * next mount. The file is deleted only after the migrated slot is flushed,
   * which is the point at which it stops being needed.
   */
  async #migrate(
    contents: SlotContents,
    slot: 'a' | 'b',
  ): Promise<Result<{ contents: SlotContents; slot: 'a' | 'b'; applied: readonly string[] }>> {
    if (contents.storeVersion === STORE_VERSION) {
      return ok({ contents, slot, applied: [] });
    }

    const report = migrateUp(contents.payload, contents.storeVersion, STORE_VERSION, this.#migrations);
    if (!report.ok) return report;
    // A no-op ladder cannot happen: `migrateUp` refuses a gap, so reaching here
    // with an empty `applied` would mean `storeVersion !== STORE_VERSION` and
    // zero steps, which `migrateUp` returns `missing-step` for.

    const saved = await this.#writeRollbackCopy(contents, slot);
    if (!saved.ok) return saved;

    const next: SlotContents = {
      storeVersion: STORE_VERSION,
      generation: contents.generation + 1,
      payload: report.value.payload,
    };
    const target = slot === 'a' ? 'b' : 'a';
    const written = this.#writeSlot(target, next);
    if (!written.ok) return written;

    const dropped = await this.#removeRollbackCopy();
    if (!dropped.ok) return dropped;

    return ok({ contents: next, slot: target, applied: report.value.applied });
  }

  /**
   * Undo a migration that already succeeded, producing a new generation.
   *
   * Separate from anything `recover` calls, and only reachable from a caller
   * that names a version. See `opfs-migrate.ts` for why an implicit downgrade
   * is a refusal rather than a feature.
   */
  async rollbackTo(target: number): Promise<Result<MigrationReport>> {
    const slot = this.#active === 'a' ? this.#slotA : this.#slotB;
    const bytes = slot.readAll();
    if (!bytes.ok) return bytes;
    const contents = decodeSlot(bytes.value);
    if (contents === null) {
      return err({
        code: 'EIO',
        path: STORE_FILES[this.#active === 'a' ? 'slotA' : 'slotB'],
        syscall: 'restore',
        message: 'the active checkpoint slot does not parse; there is nothing to roll back',
        cause: 'unreadable-slot',
      });
    }
    const report = migrateDown(contents.payload, contents.storeVersion, target, this.#migrations);
    if (!report.ok) return report;

    const next: SlotContents = {
      storeVersion: target,
      generation: contents.generation + 1,
      payload: report.value.payload,
    };
    const other = this.#active === 'a' ? 'b' : 'a';
    const written = this.#writeSlot(other, next);
    if (!written.ok) return written;

    // The log described mutations against the pre-rollback payload. It cannot
    // be replayed onto the rolled-back one, so it is dropped with the
    // generation bump — which `reset` does by definition.
    const cleared = this.journal.reset(next.generation);
    if (!cleared.ok) return cleared;

    this.#generation = next.generation;
    this.#storeVersion = target;
    this.#active = other;
    return report;
  }

  /**
   * Write the whole overlay to the inactive slot, then empty the log.
   *
   * THE ORDER IS THE CRASH-SAFETY ARGUMENT and must not be rearranged:
   *
   *   1. export the overlay (reads only; nothing durable changes)
   *   2. write and FLUSH the inactive slot at generation + 1
   *   3. only now reset the log to generation + 1
   *
   * Between 2 and 3 the store holds two valid checkpoints and a log that is one
   * generation behind; `recover` takes the newer checkpoint and discards the
   * log, which is correct because everything in it is inside that checkpoint.
   * Doing 3 before 2 would open a window where the log is empty and the only
   * checkpoint is the older one, and every mutation of the session would be
   * gone.
   */
  async checkpoint(
    backend: MemoryStorage,
    options: { seed?: SeedSpec | undefined; now: number },
  ): Promise<Result<number>> {
    const synced = this.journal.sync();
    if (!synced.ok) return synced;

    const exported = await exportSnapshot(backend, {
      scope: 'overlay',
      now: options.now,
      ...(options.seed === undefined ? {} : { seed: options.seed }),
    });
    if (!exported.ok) return exported;

    const generation = this.#generation + 1;
    const target = this.#active === 'a' ? 'b' : 'a';
    const written = this.#writeSlot(target, {
      storeVersion: STORE_VERSION,
      generation,
      payload: exported.value,
    });
    if (!written.ok) return written;

    const cleared = this.journal.reset(generation);
    if (!cleared.ok) return cleared;

    this.#generation = generation;
    this.#active = target;
    this.#storeVersion = STORE_VERSION;

    // Best effort, and deliberately not checked: the README is for a human with
    // DevTools open, and failing a checkpoint that already succeeded because a
    // note could not be written would turn a cosmetic problem into data loss.
    await this.#writeReadme(generation, options.now);
    return ok(generation);
  }

  /** True when the log has grown past the threshold and a checkpoint is due. */
  get checkpointDue(): boolean {
    return this.journal.byteLength >= this.#checkpointBytes;
  }

  /**
   * Force any un-flushed commit markers down. For a `pagehide` handler.
   *
   * See `OpfsJournal.sync` for why a commit marker is not flushed when it is
   * written and what this buys — it is the difference between losing and
   * keeping the last operation of a session that ends without a checkpoint.
   */
  sync(): Result<void> {
    return this.journal.sync();
  }

  /**
   * Throw the durable store away. `Reset-FileSystem`, and the half of a re-seed
   * that has to reach the disk.
   *
   * Both slots are zeroed, not just the active one. Leaving the inactive slot
   * intact would leave a valid checkpoint at generation g behind, and the next
   * mount would pick it up and restore a filesystem the user asked to destroy.
   */
  async reset(): Promise<Result<void>> {
    const usage = this.#usage();
    for (const file of [this.#slotA, this.#slotB]) {
      const truncated = file.truncate(0, usage);
      if (!truncated.ok) return truncated;
      const flushed = file.flush(usage);
      if (!flushed.ok) return flushed;
    }
    const cleared = this.journal.reset(0);
    if (!cleared.ok) return cleared;
    this.#generation = 0;
    this.#active = 'b';
    this.#storeVersion = STORE_VERSION;
    return ok(undefined);
  }

  /** Release every lock. After this the store is unusable and another tab may take it. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#slotA.close();
    this.#slotB.close();
    this.#walFile.close();
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  #writeSlot(slot: 'a' | 'b', contents: SlotContents): Result<void> {
    const usage = this.#usage();
    const file = slot === 'a' ? this.#slotA : this.#slotB;
    const bytes = encodeSlot(contents);
    // Truncate FIRST. A shorter checkpoint written over a longer one would
    // otherwise leave the old tail in place; the length field means the parser
    // ignores it, but a store whose file size does not match its contents is
    // one that every later debugging session has to explain.
    const truncated = file.truncate(0, usage);
    if (!truncated.ok) return truncated;
    const written = file.write(0, bytes, usage);
    if (!written.ok) return written;
    return file.flush(usage);
  }

  /**
   * `rollback.bin` is one ASCII letter — which slot these bytes came from —
   * followed by that slot's exact bytes.
   *
   * The letter is recorded rather than inferred because restoring into the
   * WRONG slot silently does nothing: the generation decides the winner, and
   * the migrated slot would still be the higher one. The rollback would report
   * success and change no state at all.
   */
  async #writeRollbackCopy(contents: SlotContents, slot: 'a' | 'b'): Promise<Result<void>> {
    const usage = this.#usage();
    const opened = await SyncFile.open(this.#directory, STORE_FILES.rollback, { create: true });
    if (!opened.ok) return opened;
    try {
      const stamped = encodeSlot(contents);
      const body = new Uint8Array(1 + stamped.byteLength);
      body.set(ENCODER.encode(slot), 0);
      body.set(stamped, 1);
      const truncated = opened.value.truncate(0, usage);
      if (!truncated.ok) return truncated;
      const put = opened.value.write(0, body, usage);
      if (!put.ok) return put;
      return opened.value.flush(usage);
    } finally {
      // MEASURED: `removeEntry` on a file whose sync access handle is still
      // open raises `NoModificationAllowedError`. Every path out of this method
      // is followed by a `removeEntry` on this file, so the close is not
      // tidiness — without it the rollback copy can never be cleared.
      opened.value.close();
    }
  }

  async #removeRollbackCopy(): Promise<Result<void>> {
    try {
      await this.#directory.removeEntry(STORE_FILES.rollback);
      return ok(undefined);
    } catch (cause) {
      if (isNotFound(cause)) return ok(undefined);
      return err({
        code: 'EIO',
        path: STORE_FILES.rollback,
        syscall: 'remove',
        message: `could not clear the migration rollback copy: ${String(cause)}`,
        cause: String(cause),
      });
    }
  }

  /**
   * Put back the pre-migration checkpoint if a migration was interrupted.
   *
   * Runs before anything else in `recover`. The presence of `rollback.bin` is
   * the only evidence that a migration started and did not finish, and it is
   * written and flushed before the migrated slot, so if it exists the store is
   * in exactly one of two states: the migration never wrote its slot (restore
   * is a no-op that costs nothing) or it wrote it and died before deleting this
   * (restore is the rollback). Both are handled by writing these bytes back and
   * deleting the file.
   */
  async #finishInterruptedMigration(): Promise<Result<void>> {
    const opened = await SyncFile.open(this.#directory, STORE_FILES.rollback, { create: false });
    if (!opened.ok) {
      // ENOENT is the normal case by a wide margin: no migration is in flight.
      if (opened.error.code === 'ENOENT') return ok(undefined);
      return opened;
    }

    // Read, then CLOSE before anything else. The handle has to be released
    // before `removeEntry` will touch the file (MEASURED: an open handle makes
    // it `NoModificationAllowedError`), and every branch below removes it.
    const bytes = opened.value.readAll();
    opened.value.close();
    if (!bytes.ok) return bytes;

    const slot = bytes.value.byteLength > 1 ? DECODER.decode(bytes.value.subarray(0, 1)) : '';
    const contents = bytes.value.byteLength > 1 ? decodeSlot(bytes.value.subarray(1)) : null;
    if ((slot !== 'a' && slot !== 'b') || contents === null) {
      // Created but never filled, or filled with something that does not parse.
      // Either way it is not a checkpoint and cannot be restored from; the
      // migration it belonged to never reached the point of writing a slot, so
      // the store is already at its pre-migration state.
      return this.#removeRollbackCopy();
    }

    const restored = this.#writeSlot(slot, contents);
    if (!restored.ok) return restored;
    // The other slot may hold a HIGHER generation written by the migration
    // that is being undone. Zero it, or the next `recover` picks it and the
    // rollback silently does nothing.
    const other = slot === 'a' ? this.#slotB : this.#slotA;
    const usage = this.#usage();
    const truncated = other.truncate(0, usage);
    if (!truncated.ok) return truncated;
    const flushed = other.flush(usage);
    if (!flushed.ok) return flushed;
    return this.#removeRollbackCopy();
  }

  async #writeReadme(generation: number, now: number): Promise<void> {
    try {
      const file = await this.#directory.getFileHandle(STORE_FILES.readme, { create: true });
      const handle = await file.createSyncAccessHandle();
      try {
        const iso = new Date(now).toISOString();
        const bytes = ENCODER.encode(readmeText(generation, STORE_VERSION, iso));
        handle.truncate(0);
        handle.write(bytes, { at: 0 });
        handle.flush();
      } finally {
        handle.close();
      }
    } catch {
      // See the call site.
    }
  }
}

/**
 * Rebuild an overlay from a checkpoint plus committed plans, without a mount.
 *
 * Used by `Export-FileSystem` when the caller wants the durable state rather
 * than the live one, and by the tests that prove replay is faithful. It builds
 * a scratch `MemoryStorage`, which is the cheapest correct way to interpret a
 * `MutationPlan`: the steps mean whatever `#apply` says they mean, and a second
 * interpreter written here would be a second definition of the same thing.
 */
export async function materialise(options: {
  readonly seed: SeedSpec;
  readonly overlay: Uint8Array | null;
  readonly replay: readonly MutationPlan[];
  readonly clock: () => number;
  readonly user?: string;
}): Promise<Result<{ backend: MemoryStorage; failures: readonly StorageError[] }>> {
  const backend = new MemoryStorage({
    clock: options.clock,
    ...(options.user === undefined ? {} : { user: options.user, group: options.user }),
  });
  const cleared = await backend.reset();
  if (!cleared.ok) return cleared;
  const installed = await backend.installImage(options.seed);
  if (!installed.ok) return installed;

  if (options.overlay !== null) {
    const document = decodeSnapshot(options.overlay);
    if (!document.ok) return document;
    const restored = await restoreSnapshot(backend, document.value, { seed: options.seed });
    if (!restored.ok) return restored;
  }

  const failures: StorageError[] = [];
  for (const plan of options.replay) {
    const applied = await backend.replay(plan);
    if (!applied.ok) {
      failures.push(applied.error);
      // STOP, do not continue. The plans are ordered and each was validated
      // against the tree its predecessor left. Skipping one and applying the
      // next means applying a plan against a tree it never saw, which is the
      // exact condition `#apply` was changed to return an error for rather than
      // throw. Losing the tail is a smaller loss than corrupting the middle.
      break;
    }
  }
  return ok({ backend, failures });
}

/** Convenience: the overlay bytes a materialised store would export. */
export async function materialiseOverlay(options: {
  readonly seed: SeedSpec;
  readonly overlay: Uint8Array | null;
  readonly replay: readonly MutationPlan[];
  readonly clock: () => number;
  readonly now: number;
}): Promise<Result<Uint8Array>> {
  const built = await materialise(options);
  if (!built.ok) return built;
  const document = await createSnapshot(built.value.backend, {
    scope: 'overlay',
    now: options.now,
    seed: options.seed,
  });
  if (!document.ok) return document;
  return ok(encodeSnapshot(document.value));
}

/** Header bytes of a fresh, empty log. Exported so a test can build one by hand. */
export function emptyWal(generation: number): Uint8Array {
  return walHeader(generation);
}
