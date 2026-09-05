/**
 * opfs-wal.ts — the write-ahead log, which is `MutationJournal` and nothing new.
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT A SECOND WAL. IT IS THE SEAM THAT WAS ALREADY THERE
 * ---------------------------------------------------------------------------
 *
 * `types.ts` already specified where a durable backend attaches its log, down
 * to the call:
 *
 *     "OPFS cannot do that. Its apply phase is a sequence of `await`s over
 *      durable handles; it can be interrupted between any two, and what it
 *      leaves behind outlives the interruption. So it needs the log — and
 *      `MutationPlan` is already the record it writes. The attachment point is
 *      exactly one call: `journal.write(plan)` between VALIDATE and APPLY, and
 *      `journal.commit()` after, with recovery at mount replaying or discarding
 *      any uncommitted plan."
 *
 * and `MemoryStorage` already takes a `journal` in its options and already
 * calls `write` / `commit` around the one `await` between validation and apply.
 * The correct implementation of PR-09 task 9.3 is therefore to FILL IN
 * `NullJournal`'s counterpart, not to invent a parallel logging path. Nothing
 * in `memory.ts` changes to make this work except the one method recovery needs
 * (`MemoryStorage.replay`), and that method exists because `types.ts` said
 * recovery would need it.
 *
 * ---------------------------------------------------------------------------
 * FILE FORMAT
 * ---------------------------------------------------------------------------
 *
 * Header, 16 bytes, written once when the log is created or reset:
 *
 *     0   8   magic, ASCII "BSWAL001"
 *     8   4   u32 LE   framing version (this file's, not the store's)
 *     12  4   u32 LE   the checkpoint GENERATION this log applies to
 *
 * then a sequence of records, each:
 *
 *     0   1   u8       kind: 1 = plan, 2 = commit
 *     1   3   u8[3]    zero padding, reserved
 *     4   4   u32 LE   payload length
 *     8   4   u32 LE   FNV-1a-32 of the payload
 *     12  n   payload  UTF-8 JSON
 *
 * WHY A GENERATION IN THE HEADER. A checkpoint writes the whole overlay and
 * then the log is reset. Those are two operations and a tab can die between
 * them, leaving a log full of plans that the new checkpoint already contains.
 * Replaying those would be wrong in a way that is easy to miss: the steps are
 * absolute, not incremental, so a `write` replays harmlessly, but a `remove`
 * of an already-removed path fails and a `move` from an already-moved source
 * fails, and recovery would report a corrupt store for a store that is fine.
 * Comparing the log's generation to the checkpoint's makes the stale case a
 * cheap, total discard instead of a per-record judgement.
 *
 * WHY A CHECKSUM PER RECORD, when the checkpoint document already has one. A
 * checkpoint is written whole; a log is APPENDED TO, so its last record is
 * exactly the thing most likely to be half-written when the tab died. The
 * checksum plus the length is what lets recovery stop at the first record that
 * does not verify and treat everything after it as absent — which is correct,
 * because a record that was not fully written was never durable and the caller
 * was never told it succeeded.
 *
 * ---------------------------------------------------------------------------
 * WHAT RECOVERY DOES WITH AN UNCOMMITTED PLAN: DISCARDS IT
 * ---------------------------------------------------------------------------
 *
 * `types.ts` permits either ("replaying or discarding"). This discards, and the
 * reason is the invariant it buys:
 *
 *     the durable store contains exactly the mutations that were REPORTED
 *     SUCCESSFUL to a caller, and no others.
 *
 * A plan with no commit record is one of two things: an apply that failed (in
 * which case `#commit` returned an `Err` and the caller saw a failure — making
 * it durable would resurrect an operation that was refused) or a tab that died
 * before the commit record was flushed (in which case the caller's promise
 * never resolved and nothing anywhere claimed success). Replaying would turn
 * the first case into a lie. Discarding costs at most the final operation of a
 * session that ended in a crash, and that operation's caller was never told it
 * had happened.
 *
 * ---------------------------------------------------------------------------
 * ONE FLUSH PER MUTATION, NOT TWO, AND THE MEASUREMENT THAT DECIDED IT
 * ---------------------------------------------------------------------------
 *
 * The obvious implementation flushes twice: once so the plan is durable before
 * apply (the interface REQUIRES this — "Must be durable before `apply`
 * starts"), and once so the commit marker is durable after it. MEASURED in
 * Chromium 152, 200 writes of 64 bytes to one sync access handle:
 *
 *     writes alone          3.6 ms
 *     write + flush each  152.5 ms
 *
 * about 0.75 ms per flush. Two per mutation is 1.5 ms of unavoidable latency on
 * every `echo`, and 1.5 seconds for a script that writes a thousand files.
 *
 * So `write` flushes and `commit` does not. THE COMMIT MARKER STILL BECOMES
 * DURABLE — it is carried by the next mutation's flush, because the log is one
 * file appended in order. What that costs is a strictly smaller window: a crash
 * between a commit marker and the next flush loses THAT operation, where
 * flushing the marker would have kept it. It cannot lose anything earlier,
 * because `parseWal` stops at the first record that does not verify, so a
 * record which is durable while an earlier one is not is unreachable rather
 * than merely unlikely.
 *
 * `sync()` forces the outstanding markers down, and `opfs-store.ts` calls it
 * before a checkpoint — the one moment where "everything reported successful is
 * durable" has to be true rather than nearly true.
 */

import { fromBase64, toBase64 } from './snapshot.ts';
import { err, ok } from './types.ts';
import type {
  MutationJournal,
  MutationPlan,
  MutationStep,
  NodeOrigin,
  QuotaUsage,
  Result,
  StorageSyscall,
} from './types.ts';
import { UNKNOWN_USAGE, fnv1a32Bytes } from './opfs-platform.ts';
import type { SyncFile } from './opfs-platform.ts';

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('utf-8', { fatal: false });

/** ASCII, so it survives every encoding and shows up in a hex dump. */
export const WAL_MAGIC = 'BSWAL001';
export const WAL_FRAMING_VERSION = 1;
export const WAL_HEADER_BYTES = 16;
export const WAL_RECORD_HEADER_BYTES = 12;

export const RECORD_PLAN = 1;
export const RECORD_COMMIT = 2;

/**
 * A ceiling on one record's payload, checked BEFORE the payload is allocated.
 *
 * The length field is read out of a file that a corrupt write, a truncated
 * store or a curious user can have edited. Without a bound, a garbage length
 * of 0xFFFFFFFF asks for a 4 GB allocation before anything has had a chance to
 * notice the checksum is wrong. 64 MiB is far above any plan this backend
 * builds — the whole filesystem is smaller than that — and far below a number
 * that hurts to refuse.
 */
export const MAX_RECORD_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// plan serialisation
// ---------------------------------------------------------------------------

/** A `MutationStep` as it appears in the log. `data` is base64; the rest is as-is. */
interface WireStep {
  readonly op: MutationStep['op'];
  readonly path: string;
  readonly from?: string;
  readonly data?: string;
  readonly mode?: number;
  readonly mtime?: number;
  readonly origin?: NodeOrigin;
}

interface WirePlan {
  readonly id: string;
  readonly syscall: StorageSyscall;
  readonly steps: readonly WireStep[];
  readonly byteDelta: number;
}

const STEP_OPS: readonly MutationStep['op'][] = [
  'create-file',
  'create-directory',
  'write',
  'remove',
  'move',
  'set-meta',
];

const SYSCALLS: readonly StorageSyscall[] = [
  'stat',
  'read',
  'write',
  'append',
  'mkdir',
  'readdir',
  'remove',
  'rename',
  'copy',
  'chmod',
  'utimes',
  'quota',
  'resolve',
  'snapshot',
  'restore',
];

/**
 * Base64 rather than raw bytes appended after the JSON.
 *
 * A binary payload would be smaller and is what a database would do. It is not
 * what this does, because the record would then need a second length, a second
 * checksum and an offset table, and every one of those is a place for a parser
 * and a writer to disagree — which is the failure this format exists to detect,
 * not to add. `toBase64` is already in `snapshot.ts`, already tested, and
 * already the reason a snapshot document can hold file content; reusing it
 * keeps one encoder in the repository instead of two.
 */
export function encodePlan(plan: MutationPlan): Uint8Array {
  const steps: WireStep[] = plan.steps.map((step) => ({
    op: step.op,
    path: step.path,
    ...(step.from === undefined ? {} : { from: step.from }),
    ...(step.data === undefined ? {} : { data: toBase64(step.data) }),
    ...(step.mode === undefined ? {} : { mode: step.mode }),
    ...(step.mtime === undefined ? {} : { mtime: step.mtime }),
    ...(step.origin === undefined ? {} : { origin: step.origin }),
  }));
  const wire: WirePlan = {
    id: plan.id,
    syscall: plan.syscall,
    steps,
    byteDelta: plan.byteDelta,
  };
  return ENCODER.encode(JSON.stringify(wire));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse a plan back, refusing anything that is not exactly the shape written.
 *
 * Every field is checked, including the ones a well-behaved writer could never
 * get wrong. That is the same reasoning `decodeSnapshot` states: this is a file
 * on disk in a browser profile, and "our own writer produced it" is an
 * assumption, not a fact. A step with a bad `op` that got as far as
 * `MemoryStorage.replay` would fall through to the `set-meta` arm — the switch
 * there is an if-chain ending in a default — and silently do the wrong thing.
 */
export function decodePlan(bytes: Uint8Array): Result<MutationPlan> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(DECODER.decode(bytes));
  } catch {
    return refuse('not-json', 'a journal record is not valid JSON');
  }
  if (!isRecord(parsed)) return refuse('not-an-object', 'a journal record is not an object');

  const id = parsed['id'];
  const syscall = parsed['syscall'];
  const rawSteps = parsed['steps'];
  const byteDelta = parsed['byteDelta'];

  if (typeof id !== 'string' || id === '') return refuse('bad-id', 'a journal record has no plan id');
  if (typeof syscall !== 'string' || !SYSCALLS.includes(syscall as StorageSyscall)) {
    return refuse('bad-syscall', `a journal record names an unknown syscall: ${String(syscall)}`);
  }
  if (typeof byteDelta !== 'number' || !Number.isFinite(byteDelta)) {
    return refuse('bad-delta', 'a journal record has no finite byteDelta');
  }
  if (!Array.isArray(rawSteps)) return refuse('bad-steps', 'a journal record has no step list');

  const steps: MutationStep[] = [];
  for (const raw of rawSteps) {
    if (!isRecord(raw)) return refuse('bad-step', 'a journal step is not an object');
    const op = raw['op'];
    const path = raw['path'];
    if (typeof op !== 'string' || !STEP_OPS.includes(op as MutationStep['op'])) {
      return refuse('bad-op', `a journal step names an unknown op: ${String(op)}`);
    }
    if (typeof path !== 'string' || !path.startsWith('/')) {
      return refuse('bad-path', 'a journal step has no absolute path');
    }
    const from = raw['from'];
    if (from !== undefined && (typeof from !== 'string' || !from.startsWith('/'))) {
      return refuse('bad-from', 'a journal move step has a malformed source');
    }
    // A `move` with no source is the one malformed step `MemoryStorage.#apply`
    // calls out by name, and it returns EINVAL rather than throwing. Catching it
    // here means recovery refuses the whole log instead of applying the steps
    // before it and then failing — see `pending`.
    if (op === 'move' && from === undefined) {
      return refuse('move-without-source', 'a journal move step has no source');
    }
    const encoded = raw['data'];
    let data: Uint8Array | undefined;
    if (encoded !== undefined) {
      if (typeof encoded !== 'string') return refuse('bad-data', 'a journal step has non-string data');
      const decoded = fromBase64(encoded);
      if (decoded === null) return refuse('bad-base64', 'a journal step has malformed base64 data');
      data = decoded;
    }
    const mode = raw['mode'];
    if (mode !== undefined && (typeof mode !== 'number' || !Number.isInteger(mode) || mode < 0 || mode > 0o7777)) {
      return refuse('bad-mode', 'a journal step has an out-of-range mode');
    }
    const mtime = raw['mtime'];
    if (mtime !== undefined && (typeof mtime !== 'number' || !Number.isFinite(mtime))) {
      return refuse('bad-mtime', 'a journal step has a non-finite mtime');
    }
    const origin = raw['origin'];
    if (origin !== undefined && origin !== 'seed' && origin !== 'user') {
      return refuse('bad-origin', 'a journal step has an unknown origin');
    }

    steps.push({
      op: op as MutationStep['op'],
      path,
      ...(from === undefined ? {} : { from }),
      ...(data === undefined ? {} : { data }),
      ...(mode === undefined ? {} : { mode: mode as number }),
      ...(mtime === undefined ? {} : { mtime: mtime as number }),
      ...(origin === undefined ? {} : { origin: origin as NodeOrigin }),
    });
  }

  return ok({ id, syscall: syscall as StorageSyscall, steps, byteDelta });
}

function refuse(reason: string, message: string): Result<never> {
  return err({ code: 'EINVAL', path: `<${WAL_MAGIC}>`, syscall: 'restore', message, reason });
}

// ---------------------------------------------------------------------------
// framing
// ---------------------------------------------------------------------------

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

/** Build the 16-byte header for a log at `generation`. */
export function walHeader(generation: number): Uint8Array {
  const bytes = new Uint8Array(WAL_HEADER_BYTES);
  bytes.set(ENCODER.encode(WAL_MAGIC), 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, WAL_FRAMING_VERSION, true);
  view.setUint32(12, generation, true);
  return bytes;
}

/** Frame one record. The checksum covers the payload only, never the header. */
export function walRecord(kind: number, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(WAL_RECORD_HEADER_BYTES + payload.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, kind);
  view.setUint32(4, payload.byteLength, true);
  view.setUint32(8, fnv1a32Bytes(payload), true);
  bytes.set(payload, WAL_RECORD_HEADER_BYTES);
  return bytes;
}

export interface WalRecord {
  readonly kind: number;
  readonly payload: Uint8Array;
}

export interface WalContents {
  readonly generation: number;
  readonly records: readonly WalRecord[];
  /**
   * Bytes at the tail that did not parse as a whole, verified record.
   *
   * Non-zero is the NORMAL outcome of a crash mid-append, not an error. It is
   * reported so a caller can say so out loud rather than pretend the log ended
   * neatly.
   */
  readonly truncatedBytes: number;
}

/**
 * Parse a whole log. Never throws, never allocates on an unverified length.
 *
 * Stops at the first record whose header is incomplete, whose length exceeds
 * `MAX_RECORD_BYTES`, whose payload runs past the end of the file, or whose
 * checksum does not match — and counts everything from there to the end as
 * truncated. It does NOT try to resynchronise and find good records after a bad
 * one: a log is append-only, so anything after a torn record was written after
 * it, and a record that appears intact after a hole is far more likely to be a
 * coincidence than a rescue.
 */
export function parseWal(bytes: Uint8Array): Result<WalContents> {
  if (bytes.byteLength < WAL_HEADER_BYTES) {
    return refuse('short-header', 'the journal is shorter than its own header');
  }
  const magic = DECODER.decode(bytes.subarray(0, 8));
  if (magic !== WAL_MAGIC) {
    return refuse('bad-magic', `the journal has magic ${JSON.stringify(magic)}, not ${WAL_MAGIC}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const framing = u32(view, 8);
  if (framing !== WAL_FRAMING_VERSION) {
    return refuse(
      'bad-framing',
      `the journal is framing version ${String(framing)}; this build writes ${String(WAL_FRAMING_VERSION)}`,
    );
  }
  const generation = u32(view, 12);

  const records: WalRecord[] = [];
  let offset = WAL_HEADER_BYTES;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < WAL_RECORD_HEADER_BYTES) break;
    const kind = view.getUint8(offset);
    const length = u32(view, offset + 4);
    const checksum = u32(view, offset + 8);
    if (length > MAX_RECORD_BYTES) break;
    const start = offset + WAL_RECORD_HEADER_BYTES;
    if (start + length > bytes.byteLength) break;
    const payload = bytes.subarray(start, start + length);
    if (fnv1a32Bytes(payload) !== checksum) break;
    records.push({ kind, payload });
    offset = start + length;
  }

  return ok({ generation, records, truncatedBytes: bytes.byteLength - offset });
}

// ---------------------------------------------------------------------------
// the journal
// ---------------------------------------------------------------------------

export interface OpfsJournalOptions {
  /** The open, exclusively locked log file. */
  readonly file: SyncFile;
  /** The checkpoint generation this log belongs to. */
  readonly generation: number;
  /** Byte offset to append the next record at. `WAL_HEADER_BYTES` on a new log. */
  readonly append: number;
  /** What to report inside an ENOSPC. Read at the moment of failure. */
  readonly usage?: () => QuotaUsage;
}

/**
 * `MutationJournal` over an OPFS file.
 *
 * The one behavioural difference from `NullJournal` that matters: `pending()`
 * here reads the FILE, not an in-memory list, so a plan written by a previous
 * session comes back as a different object with the same `id`. `MutationPlan`
 * says this is the whole reason the `id` field exists, and `NullJournal`
 * already compares on it for exactly this case.
 */
export class OpfsJournal implements MutationJournal {
  readonly #file: SyncFile;
  readonly #usage: () => QuotaUsage;
  #generation: number;
  #append: number;
  /**
   * Ids committed in THIS session, so `pending()` need not re-read the file
   * mid-session. The durable answer is still the file; this is only what makes
   * a mid-session `pending()` cheap and consistent with it.
   */
  readonly #committed = new Set<string>();

  /** Records appended since the last flush. `sync()` is a no-op when false. */
  #dirty = false;

  constructor(options: OpfsJournalOptions) {
    this.#file = options.file;
    this.#generation = options.generation;
    this.#append = options.append;
    this.#usage = options.usage ?? ((): QuotaUsage => UNKNOWN_USAGE);
  }

  get generation(): number {
    return this.#generation;
  }

  /** Bytes currently in the log, header included. Drives checkpoint scheduling. */
  get byteLength(): number {
    return this.#append;
  }

  /**
   * Not recording until `beginRecording()` says so, and then permanently.
   *
   * `bootStorage` resets the mount, installs the seed and grafts the overlay
   * through the ordinary write API, so every grafted write would otherwise be
   * logged — into a log that is about to be reset by the checkpoint at the end
   * of the mount, and which, if the tab died halfway, would replay a graft of
   * the very checkpoint the next boot restores from.
   *
   * A one-way switch and not a suspend/resume pair. A journal that can be
   * turned off is one whose durability is a runtime question, and the answer
   * would be somewhere in a call stack.
   */
  #recording = false;

  beginRecording(): void {
    this.#recording = true;
  }

  get recording(): boolean {
    return this.#recording;
  }

  async write(plan: MutationPlan): Promise<Result<void>> {
    if (!this.#recording) return ok(undefined);
    return this.#append_(RECORD_PLAN, encodePlan(plan), true);
  }

  /**
   * Appended but NOT flushed. See the header: the next mutation's flush carries
   * it, and forcing one here costs 0.75 ms on every write for a window that
   * only ever contains the operation that was in flight when the tab died.
   */
  async commit(plan: MutationPlan): Promise<Result<void>> {
    if (!this.#recording) return ok(undefined);
    const written = await this.#append_(
      RECORD_COMMIT,
      ENCODER.encode(JSON.stringify({ id: plan.id })),
      false,
    );
    if (written.ok) this.#committed.add(plan.id);
    return written;
  }

  /**
   * Force everything appended so far to disk.
   *
   * WHAT THIS IS FOR, precisely, because it is easy to over-claim: the moment a
   * tab is going away and there is still an unflushed commit marker. A
   * `pagehide` or `visibilitychange` handler calls `OpfsStore.sync()` and the
   * last operation of the session is durable rather than at the mercy of the
   * next mutation that will never come.
   *
   * `checkpoint()` also calls it, which costs one extra flush per 256 KiB of
   * log and is not where the value is — a crash after the checkpoint slot is
   * flushed discards the whole log anyway, and a crash before it is not helped
   * by having synced earlier. It is called there because "everything reported
   * successful is durable" being momentarily true at a known point is worth 0.75 ms
   * a quarter-megabyte, not because the checkpoint would otherwise be wrong.
   */
  sync(): Result<void> {
    if (!this.#dirty) return ok(undefined);
    const flushed = this.#file.flush(this.#usage());
    if (!flushed.ok) return flushed;
    this.#dirty = false;
    return ok(undefined);
  }

  /**
   * Plans written but never committed, in write order.
   *
   * Reads the file rather than a field, because the case this exists for is a
   * log written by a session that is gone. A record that fails to decode is a
   * REFUSAL of the whole call, not a skip: the steps are ordered and a hole in
   * the middle means the plans after it were validated against a tree this
   * recovery is not going to build.
   */
  async pending(): Promise<Result<readonly MutationPlan[]>> {
    const bytes = this.#file.readAll();
    if (!bytes.ok) return bytes;
    const parsed = parseWal(bytes.value);
    if (!parsed.ok) return parsed;

    const plans: MutationPlan[] = [];
    const committed = new Set<string>(this.#committed);
    for (const record of parsed.value.records) {
      if (record.kind === RECORD_COMMIT) {
        const id = readCommitId(record.payload);
        if (!id.ok) return id;
        committed.add(id.value);
        continue;
      }
      if (record.kind !== RECORD_PLAN) {
        return refuse('bad-kind', `a journal record has unknown kind ${String(record.kind)}`);
      }
      const plan = decodePlan(record.payload);
      if (!plan.ok) return plan;
      plans.push(plan.value);
    }
    return ok(plans.filter((plan) => !committed.has(plan.id)));
  }

  /**
   * Everything in the log, decoded, with committed plans marked.
   *
   * `pending()` is the interface's question; this is recovery's. Recovery needs
   * the COMMITTED plans — the ones to replay — and `pending()` deliberately
   * returns their complement.
   */
  async replayable(): Promise<Result<readonly MutationPlan[]>> {
    const bytes = this.#file.readAll();
    if (!bytes.ok) return bytes;
    const parsed = parseWal(bytes.value);
    if (!parsed.ok) return parsed;
    return committedPlans(parsed.value);
  }

  /**
   * Empty the log and stamp it with a new generation. Runs AFTER a checkpoint
   * is flushed, never before — see `opfs-store.ts` for the ordering argument.
   */
  reset(generation: number): Result<void> {
    const usage = this.#usage();
    const truncated = this.#file.truncate(0, usage);
    if (!truncated.ok) return truncated;
    const header = this.#file.write(0, walHeader(generation), usage);
    if (!header.ok) return header;
    const flushed = this.#file.flush(usage);
    if (!flushed.ok) return flushed;
    this.#generation = generation;
    this.#append = WAL_HEADER_BYTES;
    this.#committed.clear();
    this.#dirty = false;
    return ok(undefined);
  }

  async #append_(kind: number, payload: Uint8Array, flush: boolean): Promise<Result<void>> {
    const usage = this.#usage();
    const record = walRecord(kind, payload);
    const written = this.#file.write(this.#append, record, usage);
    if (!written.ok) {
      // The offset is NOT advanced. A failed append leaves the log exactly as
      // it was, so the next one overwrites whatever partial bytes the platform
      // may have left — and even if it does not, the checksum makes the
      // leftovers a torn tail, which `parseWal` already discards.
      return written;
    }
    this.#append += record.byteLength;
    this.#dirty = true;
    if (!flush) return ok(undefined);
    const flushed = this.#file.flush(usage);
    if (!flushed.ok) return flushed;
    this.#dirty = false;
    return ok(undefined);
  }
}

/**
 * The committed plans in a parsed log, in write order.
 *
 * ONE implementation, used by recovery (which holds the log open with an
 * exclusive handle) and by a FOLLOWER (which reads the same bytes through
 * `getFile()` and holds nothing). Two implementations of "which of these plans
 * counted" is exactly the pair that drifts, and the way it is discovered is a
 * user losing a file.
 */
export function committedPlans(contents: WalContents): Result<readonly MutationPlan[]> {
  const plans: MutationPlan[] = [];
  const committed = new Set<string>();
  for (const record of contents.records) {
    if (record.kind === RECORD_COMMIT) {
      const id = readCommitId(record.payload);
      if (!id.ok) return id;
      committed.add(id.value);
      continue;
    }
    if (record.kind !== RECORD_PLAN) {
      return refuse('bad-kind', `a journal record has unknown kind ${String(record.kind)}`);
    }
    const plan = decodePlan(record.payload);
    if (!plan.ok) return plan;
    plans.push(plan.value);
  }
  return ok(plans.filter((plan) => committed.has(plan.id)));
}

function readCommitId(payload: Uint8Array): Result<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(DECODER.decode(payload));
  } catch {
    return refuse('bad-commit', 'a journal commit record is not valid JSON');
  }
  if (!isRecord(parsed) || typeof parsed['id'] !== 'string' || parsed['id'] === '') {
    return refuse('bad-commit-id', 'a journal commit record names no plan');
  }
  return ok(parsed['id']);
}
