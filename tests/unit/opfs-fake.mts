/**
 * opfs-fake.mts — an OPFS that runs in Node, built to match what a real browser
 * was measured doing.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS AND, MORE IMPORTANTLY, WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 *
 * It is the thing that lets `npm run verify` exercise the whole durable store —
 * framing, checksums, torn tails, generation gates, migrations, rollback,
 * recovery — in two seconds, offline, with no browser. That is worth having and
 * it is why this file exists.
 *
 * It is NOT evidence that the store works in a browser. A fake written by the
 * same person who wrote the code under test proves the code is self-consistent
 * with one person's understanding of the platform, which is exactly the thing
 * that was wrong when it was wrong. Every behaviour below is therefore
 * annotated with where it came from:
 *
 *   MEASURED   run against Chromium 152.0.0.0 (Playwright) on Windows, in a
 *              real dedicated worker, 2026-09-06. The transcript is in
 *              `src/storage/opfs-platform.ts`.
 *   SPEC       taken from https://fs.spec.whatwg.org/ and quoted.
 *   MODELLED   neither: this file's own choice, made because the store needs
 *              *some* answer. These are the ones that could be wrong, and they
 *              are listed together at `MODELLED_BEHAVIOURS` so a reviewer does
 *              not have to hunt.
 *
 * `tests/unit/opfs-conformance.test.mts` asserts the MEASURED rows against this
 * fake, and `tests/browser/opfs-backend.browser.mts` asserts THE SAME ROWS
 * against a real browser. When a harness runs the second file, any row where
 * the fake and the platform disagree fails there, and the platform is right.
 *
 * ---------------------------------------------------------------------------
 * DURABILITY IS MODELLED, BECAUSE IT IS THE POINT
 * ---------------------------------------------------------------------------
 *
 * Each file keeps two byte arrays: what the handle can see (`live`) and what
 * would survive a crash (`durable`). `flush()` copies the first onto the
 * second. `crash()` throws away the first and replaces it with the second, and
 * invalidates every open handle — which is what a killed tab does.
 *
 * That is the only way to test a write-ahead log at all. A fake where every
 * write is instantly durable makes the log look correct no matter where the
 * flushes are, including nowhere.
 *
 * MEASURED, and worth stating because it contradicts the intuition the two-copy
 * model invites: in Chromium, an UNFLUSHED write is immediately visible to
 * `getSize()` and to another context's `getFile()`. Visibility and durability
 * are separate, and this fake models both separately for that reason —
 * `getFile()` here returns `live`, not `durable`.
 */

import {
  STORE_FILES,
} from '../../src/storage/opfs-platform.ts';
import type {
  OpfsDirectory,
  OpfsFile,
  OpfsFileSnapshot,
  OpfsReadWriteOptions,
  OpfsStorageManager,
  OpfsSyncHandle,
} from '../../src/storage/opfs-platform.ts';

/**
 * The behaviours this fake had to invent. Read this list before trusting a
 * green test about any of them.
 *
 *   1. WHICH WRITES SURVIVE A CRASH. Chromium was never crashed. The model is
 *      "flushed bytes survive, unflushed bytes do not", which is what `flush`
 *      means everywhere else and what the spec implies by having it at all, but
 *      it was not observed. A platform that flushes on every write would make
 *      the store's log placement untested rather than wrong; a platform that
 *      never flushes on close would make it more important, not less.
 *   2. PARTIAL WRITES. `SyncFile` treats a short write as ENOSPC. Chromium was
 *      never seen returning one — every observed `write` returned the full
 *      count or threw `QuotaExceededError`. The fake can be told to short-write
 *      so that arm is exercised, but the arm may be dead code on that engine.
 *   3. TORN RECORDS. `crash()` truncates at the last flush, so a torn tail is
 *      always a whole number of records short. A real crash can leave HALF a
 *      record — `parseWal` handles that and `truncateTo()` exists to produce it
 *      — but which of the two a browser actually leaves was not observed.
 *   4. ERROR MESSAGE TEXT. The `name` of every exception is MEASURED; the
 *      message strings are this file's own. Nothing in `src/` reads a message,
 *      and `fromException` switches on `name` alone, deliberately.
 */
export const MODELLED_BEHAVIOURS = [
  'which writes survive a crash',
  'partial writes',
  'whether a torn record is possible',
  'exception message text',
] as const;

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

/**
 * A real `DOMException`, which Node has had as a global since v17.
 *
 * Not a plain object with a `name`, even though `exceptionName` would accept
 * one: a fake whose errors are a different shape is a fake that cannot catch a
 * call site doing `instanceof`, and someone will eventually write one.
 */
function fail(name: string, message: string): never {
  throw new DOMException(message, name);
}

/**
 * SPEC: "A valid file name is a string that is not an empty string, is not
 * equal to '.' or '..', and does not contain '/' or any other character used as
 * path separator on the underlying platform."
 * -- https://fs.spec.whatwg.org/#valid-file-name
 *
 * MEASURED, Chromium 152 on Windows: '', '.', '..', 'a/b' and 'a\b' are all
 * `TypeError: Name is not allowed.` — the backslash because it IS a path
 * separator there. Everything else probed was accepted, including ':', '*',
 * '?', '|', '<', '"', a literal NUL, 'CON', a trailing dot, a trailing space,
 * and names of 256 and 1024 characters.
 *
 * The backslash is rejected here unconditionally. That makes this fake STRICTER
 * than a POSIX-hosted engine would be, and that is the safe direction: a store
 * that passes here uses names no platform can refuse.
 */
function requireValidName(name: string): void {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    fail('TypeError', `Name is not allowed: ${JSON.stringify(name)}`);
  }
}

// ---------------------------------------------------------------------------
// the byte store
// ---------------------------------------------------------------------------

class FakeEntryFile {
  live: Uint8Array = new Uint8Array(0);
  durable: Uint8Array = new Uint8Array(0);
  /** At most one open sync access handle. See `FakeFileHandle`. */
  open: FakeSyncHandle | null = null;
  /** Set when the entry is removed; every handle to it starts failing. */
  removed = false;
}

class FakeDirectoryEntry {
  readonly children = new Map<string, FakeEntryFile | FakeDirectoryEntry>();
  removed = false;
}

export interface FakeOpfsOptions {
  /**
   * Total bytes allowed across the whole fake origin. `null` for unbounded.
   * A write that would exceed it raises `QuotaExceededError`, which is
   * MEASURED: Chromium raised exactly that for a write past the ceiling, with
   * the message "No space available for this operation".
   */
  readonly quota?: number | null;
}

export class FakeOpfs implements OpfsStorageManager {
  readonly #root = new FakeDirectoryEntry();
  #quota: number | null;
  #persisted = false;

  /**
   * Writes to fail with a short count instead of succeeding, from now on.
   * See `MODELLED_BEHAVIOURS` entry 2: this arm may be unreachable on a real
   * engine, and the option exists so the handling is exercised anyway.
   */
  shortWriteAfter: number | null = null;
  #writes = 0;

  constructor(options: FakeOpfsOptions = {}) {
    this.#quota = options.quota ?? null;
  }

  get root(): OpfsDirectory {
    return new FakeDirectory(this, this.#root, '');
  }

  async estimate(): Promise<{ usage?: number; quota?: number }> {
    const used = this.usedBytes();
    return this.#quota === null ? { usage: used } : { usage: used, quota: this.#quota };
  }

  async persisted(): Promise<boolean> {
    return this.#persisted;
  }

  async persist(): Promise<boolean> {
    this.#persisted = true;
    return true;
  }

  setQuota(bytes: number | null): void {
    this.#quota = bytes;
  }

  /**
   * Kill the tab. Every unflushed byte is lost and every open handle stops
   * working, exactly as the platform stops working when the worker is gone.
   */
  crash(): void {
    const walk = (directory: FakeDirectoryEntry): void => {
      for (const child of directory.children.values()) {
        if (child instanceof FakeDirectoryEntry) {
          walk(child);
          continue;
        }
        child.live = Uint8Array.from(child.durable);
        if (child.open !== null) {
          child.open.invalidate();
          child.open = null;
        }
      }
    };
    walk(this.#root);
  }

  /** Every byte a crash would keep, summed. What `estimate()` reports on. */
  usedBytes(): number {
    let total = 0;
    const walk = (directory: FakeDirectoryEntry): void => {
      for (const child of directory.children.values()) {
        if (child instanceof FakeDirectoryEntry) walk(child);
        else total += child.live.byteLength;
      }
    };
    walk(this.#root);
    return total;
  }

  /**
   * Chop a file's durable bytes, for the torn-record case a crash cannot
   * produce here. See `MODELLED_BEHAVIOURS` entry 3.
   */
  truncateTo(path: readonly string[], bytes: number): void {
    const file = this.#find(path);
    file.durable = file.durable.slice(0, bytes);
    file.live = Uint8Array.from(file.durable);
  }

  /** Raw durable bytes of a file, for a test that wants to look at the format. */
  durableBytes(path: readonly string[]): Uint8Array {
    return Uint8Array.from(this.#find(path).durable);
  }

  /**
   * Overwrite a file's durable bytes, for corruption tests. Creates the file
   * and its parents when they are missing, so a test can plant a file the store
   * has never written — `rollback.bin` is the one that matters, since its very
   * existence is what tells recovery a migration was interrupted.
   */
  setDurableBytes(path: readonly string[], bytes: Uint8Array): void {
    const file = this.#find(path, true);
    file.durable = Uint8Array.from(bytes);
    file.live = Uint8Array.from(bytes);
  }

  has(path: readonly string[]): boolean {
    let node: FakeEntryFile | FakeDirectoryEntry = this.#root;
    for (const segment of path) {
      if (!(node instanceof FakeDirectoryEntry)) return false;
      const next = node.children.get(segment);
      if (next === undefined) return false;
      node = next;
    }
    return true;
  }

  #find(path: readonly string[], create = false): FakeEntryFile {
    let node: FakeEntryFile | FakeDirectoryEntry = this.#root;
    for (const [index, segment] of path.entries()) {
      if (!(node instanceof FakeDirectoryEntry)) throw new Error(`not a directory: ${segment}`);
      let next = node.children.get(segment);
      if (next === undefined) {
        if (!create) throw new Error(`no such fake entry: ${path.join('/')}`);
        next = index === path.length - 1 ? new FakeEntryFile() : new FakeDirectoryEntry();
        node.children.set(segment, next);
      }
      node = next;
    }
    if (!(node instanceof FakeEntryFile)) throw new Error(`not a file: ${path.join('/')}`);
    return node;
  }

  /** @internal Used by the handle to police the origin-wide ceiling. */
  quotaCeiling(): number | null {
    return this.#quota;
  }

  /** @internal */
  countWrite(): boolean {
    this.#writes += 1;
    return this.shortWriteAfter !== null && this.#writes > this.shortWriteAfter;
  }
}

// ---------------------------------------------------------------------------
// handles
// ---------------------------------------------------------------------------

class FakeDirectory implements OpfsDirectory {
  readonly kind = 'directory' as const;
  readonly name: string;
  readonly #fake: FakeOpfs;
  readonly #entry: FakeDirectoryEntry;

  constructor(fake: FakeOpfs, entry: FakeDirectoryEntry, name: string) {
    this.#fake = fake;
    this.#entry = entry;
    this.name = name;
  }

  async getFileHandle(name: string, options: { create?: boolean } = {}): Promise<OpfsFile> {
    requireValidName(name);
    this.#requireAlive();
    const existing = this.#entry.children.get(name);
    if (existing instanceof FakeDirectoryEntry) {
      // MEASURED: `TypeMismatchError`, "The path supplied exists, but was not
      // an entry of requested type."
      fail('TypeMismatchError', `not a file: ${name}`);
    }
    if (existing === undefined) {
      // MEASURED: `NotFoundError` when `create` is false.
      if (options.create !== true) fail('NotFoundError', `no such file: ${name}`);
      const created = new FakeEntryFile();
      this.#entry.children.set(name, created);
      return new FakeFileHandle(this.#fake, created, name);
    }
    return new FakeFileHandle(this.#fake, existing, name);
  }

  async getDirectoryHandle(name: string, options: { create?: boolean } = {}): Promise<OpfsDirectory> {
    requireValidName(name);
    this.#requireAlive();
    const existing = this.#entry.children.get(name);
    if (existing instanceof FakeEntryFile) fail('TypeMismatchError', `not a directory: ${name}`);
    if (existing === undefined) {
      if (options.create !== true) fail('NotFoundError', `no such directory: ${name}`);
      const created = new FakeDirectoryEntry();
      this.#entry.children.set(name, created);
      return new FakeDirectory(this.#fake, created, name);
    }
    return new FakeDirectory(this.#fake, existing, name);
  }

  async removeEntry(name: string, options: { recursive?: boolean } = {}): Promise<void> {
    requireValidName(name);
    this.#requireAlive();
    const existing = this.#entry.children.get(name);
    // MEASURED: `NotFoundError` for a name that is not there.
    if (existing === undefined) fail('NotFoundError', `no such entry: ${name}`);
    if (existing instanceof FakeDirectoryEntry) {
      // MEASURED: `InvalidModificationError` for a non-empty directory without
      // `recursive`, and success with it.
      if (existing.children.size > 0 && options.recursive !== true) {
        fail('InvalidModificationError', `directory not empty: ${name}`);
      }
      markRemoved(existing);
    } else {
      // MEASURED: removing a file whose sync access handle is open raises
      // `NoModificationAllowedError`. This is the rule the whole store's
      // two-tab safety rests on, so the fake enforces it rather than being
      // lenient and letting a bug through.
      if (existing.open !== null) {
        fail('NoModificationAllowedError', `an access handle is open on ${name}`);
      }
      existing.removed = true;
    }
    this.#entry.children.delete(name);
  }

  #requireAlive(): void {
    // MEASURED: a handle to a directory that has been removed raises
    // `NotFoundError` on any child operation.
    if (this.#entry.removed) fail('NotFoundError', `the directory ${this.name} was removed`);
  }
}

function markRemoved(directory: FakeDirectoryEntry): void {
  directory.removed = true;
  for (const child of directory.children.values()) {
    if (child instanceof FakeDirectoryEntry) markRemoved(child);
    else child.removed = true;
  }
}

class FakeFileHandle implements OpfsFile {
  readonly kind = 'file' as const;
  readonly name: string;
  readonly #fake: FakeOpfs;
  readonly #entry: FakeEntryFile;

  constructor(fake: FakeOpfs, entry: FakeEntryFile, name: string) {
    this.#fake = fake;
    this.#entry = entry;
    this.name = name;
  }

  async createSyncAccessHandle(): Promise<OpfsSyncHandle> {
    // MEASURED: `NotFoundError` when the entry has been removed.
    if (this.#entry.removed) fail('NotFoundError', `the file ${this.name} was removed`);
    // MEASURED, in three shapes — a second handle in the same worker, a handle
    // in a second dedicated worker, and a handle in a SECOND BROWSER TAB — all
    // `NoModificationAllowedError`: "Access Handles cannot be created if there
    // is another open Access Handle or Writable stream".
    if (this.#entry.open !== null) {
      fail('NoModificationAllowedError', `an access handle is already open on ${this.name}`);
    }
    const handle = new FakeSyncHandle(this.#fake, this.#entry, this.name);
    this.#entry.open = handle;
    return handle;
  }

  async getFile(): Promise<OpfsFileSnapshot> {
    if (this.#entry.removed) fail('NotFoundError', `the file ${this.name} was removed`);
    // MEASURED: `getFile()` returns UNFLUSHED bytes, and returns them while a
    // sync access handle is open. Visibility is not gated on the flush.
    const bytes = Uint8Array.from(this.#entry.live);
    return {
      size: bytes.byteLength,
      arrayBuffer: async (): Promise<ArrayBuffer> => bytes.buffer as ArrayBuffer,
    };
  }
}

class FakeSyncHandle implements OpfsSyncHandle {
  readonly #fake: FakeOpfs;
  readonly #entry: FakeEntryFile;
  readonly #name: string;
  #closed = false;
  /**
   * SPEC: "If options["at"] exists, let position be options["at"]. Otherwise,
   * let position be handle's file position cursor."
   * -- https://fs.spec.whatwg.org/#dom-filesystemsyncaccesshandle-read
   *
   * MEASURED, and this is the trap: `read(buffer)` with no `at` returned 0
   * bytes from a 3-byte file because the previous read had advanced the cursor
   * to 3. Modelled faithfully so that any call site in `src/` which forgets
   * `at` fails a test here rather than in a browser.
   */
  #cursor = 0;

  constructor(fake: FakeOpfs, entry: FakeEntryFile, name: string) {
    this.#fake = fake;
    this.#entry = entry;
    this.#name = name;
  }

  /** The tab died with this handle open. */
  invalidate(): void {
    this.#closed = true;
  }

  read(buffer: Uint8Array, options: OpfsReadWriteOptions = {}): number {
    this.#requireOpen('read');
    const at = requireOffset(options.at ?? this.#cursor, 'read');
    const source = this.#entry.live;
    if (at >= source.byteLength) {
      // MEASURED: reading at or past EOF returns 0 and does not throw.
      this.#cursor = at;
      return 0;
    }
    const count = Math.min(buffer.byteLength, source.byteLength - at);
    // MEASURED: bytes of the buffer beyond what was read are LEFT ALONE, not
    // zeroed — a 16-byte buffer over a 5-byte file kept its own bytes 5..15.
    buffer.set(source.subarray(at, at + count), 0);
    this.#cursor = at + count;
    return count;
  }

  write(buffer: Uint8Array, options: OpfsReadWriteOptions = {}): number {
    this.#requireOpen('write');
    const at = requireOffset(options.at ?? this.#cursor, 'write');
    const end = at + buffer.byteLength;

    const ceiling = this.#fake.quotaCeiling();
    if (ceiling !== null) {
      const growth = Math.max(0, end - this.#entry.live.byteLength);
      if (this.#fake.usedBytes() + growth > ceiling) {
        // MEASURED: `QuotaExceededError`, message "No space available for this
        // operation".
        fail('QuotaExceededError', 'No space available for this operation');
      }
    }

    const short = this.#fake.countWrite();
    const count = short ? Math.floor(buffer.byteLength / 2) : buffer.byteLength;

    if (end > this.#entry.live.byteLength) {
      // MEASURED: writing past the end ZERO-FILLS the gap. Writing 'X' at
      // offset 10 of a 5-byte file gave [104,101,108,108,111,0,0,0,0,0,88].
      const grown = new Uint8Array(end);
      grown.set(this.#entry.live, 0);
      this.#entry.live = grown;
    }
    this.#entry.live.set(buffer.subarray(0, count), at);
    this.#cursor = at + count;
    return count;
  }

  truncate(newSize: number): void {
    this.#requireOpen('truncate');
    // MEASURED: `truncate(-1)` raises `TypeError` (WebIDL unsigned long long).
    requireOffset(newSize, 'truncate');
    const next = new Uint8Array(newSize);
    // MEASURED: growing pads with zeros; shrinking drops the tail.
    next.set(this.#entry.live.subarray(0, Math.min(newSize, this.#entry.live.byteLength)), 0);
    this.#entry.live = next;
  }

  getSize(): number {
    this.#requireOpen('getSize');
    // MEASURED: immediate, before any flush.
    return this.#entry.live.byteLength;
  }

  flush(): void {
    this.#requireOpen('flush');
    this.#entry.durable = Uint8Array.from(this.#entry.live);
  }

  close(): void {
    // MEASURED: `close()` twice does not throw.
    if (this.#closed) return;
    this.#closed = true;
    if (this.#entry.open === this) this.#entry.open = null;
  }

  #requireOpen(operation: string): void {
    // MEASURED: `getSize`, `write` and `flush` after `close()` all raise
    // `InvalidStateError`.
    if (this.#closed) {
      fail('InvalidStateError', `${operation} on ${this.#name}: the file was already closed`);
    }
  }
}

function requireOffset(value: number, operation: string): number {
  if (!Number.isInteger(value) || value < 0) {
    fail('TypeError', `${operation}: value is outside the 'unsigned long long' value range`);
  }
  return value;
}

/** Reads the store's own files without going through `OpfsStore`. */
export const STORE_PATH = {
  slotA: [STORE_FILES.slotA],
  slotB: [STORE_FILES.slotB],
  wal: [STORE_FILES.wal],
  rollback: [STORE_FILES.rollback],
} as const;

/** `['browsershell', file]`, the path a store built with default options uses. */
export function storePath(directory: string, file: string): readonly string[] {
  return [directory, file];
}
