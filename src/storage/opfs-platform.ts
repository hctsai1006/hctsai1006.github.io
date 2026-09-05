/**
 * opfs-platform.ts — the only file in `src/storage/` that touches OPFS itself.
 *
 * Everything above it — the WAL, the checkpoint slots, the migrations, the
 * backend — is written against the four interfaces declared here and can be
 * driven, in Node, by a fake. Everything the real platform actually does lives
 * in this file, so the list of "things that could differ in a browser we have
 * not run" is one file long instead of five.
 *
 * ---------------------------------------------------------------------------
 * MEASURED, NOT ASSUMED
 * ---------------------------------------------------------------------------
 *
 * Every claim in this file about platform behaviour was RUN, in a real browser,
 * inside a real dedicated worker, on 2026-09-06:
 *
 *     Chromium 152.0.0.0 (Playwright), Windows NT 10.0 x64
 *     Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36
 *       (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36
 *     https origin, crossOriginIsolated = false
 *
 * The transcript of each probe is quoted at the code that depends on it. Where
 * the spec and the measurement agree, both are cited — the spec because it is
 * what other engines are held to, the measurement because it is what actually
 * happened. Where only a measurement exists, it is labelled ONE ENGINE ONLY and
 * nothing is allowed to depend on it for correctness.
 *
 * Spec: https://fs.spec.whatwg.org/ (WHATWG File System Standard)
 *
 * ---------------------------------------------------------------------------
 * WHY STRUCTURAL INTERFACES AND NOT `FileSystemDirectoryHandle`
 * ---------------------------------------------------------------------------
 *
 * TypeScript's DOM types would do, and were the first draft. Three reasons they
 * were replaced by the narrow subsets below:
 *
 *   1. `FileSystemSyncAccessHandle` is declared in `lib.webworker.d.ts` and in
 *      NO other lib — measured: `grep -c FileSystemSyncAccessHandle
 *      lib.dom.d.ts` is 0. That is the `[Exposed=DedicatedWorker]` constraint
 *      showing up in the type system, and it is why this repository's storage
 *      interface is async all the way down.
 *   2. Directory iteration (`keys()`/`entries()`/`values()`) is declared in
 *      `lib.webworker.asynciterable.d.ts`, which this project's `tsconfig` does
 *      not include. Nothing here iterates a directory — see `STORE_FILES` — so
 *      the narrow interface simply does not have the method, and adding one
 *      later is a compile error rather than a runtime surprise.
 *   3. A fake that has to satisfy the full DOM interface is a fake nobody
 *      writes. These four interfaces are small enough that a spec-faithful
 *      implementation is a page of code, which is what makes the whole store
 *      testable without a browser.
 *
 * A real `FileSystemDirectoryHandle` is assignable to `OpfsDirectory`, and
 * `tests/unit/opfs-platform.test.mts` asserts that with a type-level check.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS STORE USES FIVE FIXED ASCII FILE NAMES
 * ---------------------------------------------------------------------------
 *
 * The obvious design is to mirror the virtual filesystem into OPFS: one OPFS
 * file per VFS file, one OPFS directory per VFS directory. It was rejected on
 * MEASUREMENT, not taste. Probing `getFileHandle(name, {create:true})` in
 * Chromium 152 on Windows:
 *
 *     ''  '.'  '..'  'a/b'  'a\b'   -> TypeError "Name is not allowed."
 *     'a:b' 'a*b' 'a?b' 'a|b' 'a<b' 'a"b'  -> accepted
 *     'a\u0000b'                    -> ACCEPTED. A NUL is a legal OPFS name.
 *     'CON'                         -> accepted
 *     255 / 256 / 1024 characters   -> accepted; there is no NAME_MAX
 *     'a\uD800b' (lone surrogate)   -> accepted, but STORED AS 'a\uFFFDb'
 *     'Case' and 'case'             -> two distinct entries
 *
 * Two of those are disqualifying. A lone surrogate is silently replaced, so two
 * distinct VFS names can collide into one OPFS entry and one file overwrites
 * the other with no error anywhere. And the case result is engine-specific: the
 * spec's "valid file name" says only
 *
 *     "A valid file name is a string that is not an empty string, is not equal
 *      to '.' or '..', and does not contain '/' or any other character used as
 *      path separator on the underlying platform."
 *     -- https://fs.spec.whatwg.org/#valid-file-name
 *
 * which says nothing about case folding, so an engine backing OPFS with a
 * case-insensitive filesystem is conformant and would collide `README` with
 * `readme`. (The backslash result above is that clause working as written:
 * `\` IS a path separator on Windows, and Chromium rejects it there.)
 *
 * So the durable representation is a CHECKPOINT plus a WRITE-AHEAD LOG over
 * five files whose names are fixed ASCII literals in this file. No VFS name
 * ever reaches the platform. The name hazards above become unreachable rather
 * than handled, which is the same call `memory.ts` makes about `__proto__`.
 *
 * The second reason is locking, and it is the stronger one. See `STORE_FILES`.
 */

import { err, ok } from './types.ts';
import type { Err, QuotaUsage, Result, StorageError, StorageSyscall } from './types.ts';

// ---------------------------------------------------------------------------
// the platform, as narrowly as this store needs it
// ---------------------------------------------------------------------------

/** `FileSystemReadWriteOptions`. See `OpfsSyncHandle.read` for why `at` is never omitted. */
export interface OpfsReadWriteOptions {
  readonly at?: number;
}

/**
 * `FileSystemSyncAccessHandle`, which is `[Exposed=DedicatedWorker, SecureContext]`:
 *
 *     [Exposed=DedicatedWorker, SecureContext]
 *     interface FileSystemSyncAccessHandle {
 *       unsigned long long read(AllowSharedBufferSource buffer,
 *                               optional FileSystemReadWriteOptions options = {});
 *       unsigned long long write(AllowSharedBufferSource buffer,
 *                                optional FileSystemReadWriteOptions options = {});
 *       undefined truncate([EnforceRange] unsigned long long newSize);
 *       unsigned long long getSize();
 *       undefined flush();
 *       undefined close();
 *     };
 *     -- https://fs.spec.whatwg.org/#filesystemsyncaccesshandle
 *
 * MEASURED behaviour that this store depends on, all Chromium 152:
 *
 *   write(5 bytes, {at:0})              -> 5
 *   getSize() BEFORE flush()            -> 5. Size is immediate.
 *   getFile() BEFORE flush()            -> the unflushed bytes, in full.
 *                                          `flush` is a DURABILITY barrier and
 *                                          not a visibility one.
 *
 * That second line is a CORRECTION to what this file first said, and it is left
 * visible rather than quietly edited because it is exactly the mistake this
 * project's rules are written to catch. The first probe wrote and flushed in
 * one step and then read from another context; the reader saw the bytes, and
 * "after the flush" got written down as though the flush were why. Probing the
 * two apart — write, `getFile()`, THEN flush — showed the reader gets
 * "unflushed" before any flush has happened, and gets a second unflushed write
 * too. One probe cannot separate two variables, and a comment that says it did
 * is worse than no comment.
 *
 * `flush()` COSTS, and the number decides a design question below. MEASURED,
 * 200 writes of 64 bytes to one handle:
 *
 *     writes alone          3.6 ms
 *     write + flush each  152.5 ms
 *
 * about 0.75 ms per flush, roughly forty times the write. See `OpfsJournal` for
 * what that buys and what it does not.
 *   read(16-byte buffer, {at:0}) on a 5-byte file
 *                                       -> 5, and the remaining 11 bytes of the
 *                                          buffer are LEFT ALONE, not zeroed.
 *   read(buffer, {at:5}) at EOF         -> 0
 *   read(buffer, {at:99}) past EOF      -> 0, not an error
 *   write('X', {at:10}) on a 5-byte file
 *                                       -> 1, size 11, bytes
 *                                          [104,101,108,108,111,0,0,0,0,0,88]
 *                                          -- THE GAP IS ZERO-FILLED
 *   truncate(20) on an 11-byte file     -> size 20, the new tail is zeros
 *   truncate(3)                         -> size 3, and a later read returns 3
 *   read(buffer) with NO `at`           -> 0 -- see below
 *   read(buffer, {at:-1})               -> TypeError (WebIDL unsigned long long)
 *   write(1 byte, {at: 2**53-1})        -> QuotaExceededError
 *                                          "No space available for this operation"
 *   flush() twice                       -> fine
 *   close() twice                       -> fine, close is idempotent
 *   getSize()/write()/flush() after close()
 *                                       -> InvalidStateError
 *
 * THE `at` TRAP, and why every call site in this repository passes it
 * explicitly. `read(buffer)` with no options returned ZERO bytes from a 3-byte
 * file into a 3-byte buffer, because the handle carries a file position cursor
 * and the previous read had advanced it to 3. The spec is explicit:
 *
 *     "If options["at"] exists, let position be options["at"]. Otherwise, let
 *      position be handle's file position cursor."
 *     -- https://fs.spec.whatwg.org/#dom-filesystemsyncaccesshandle-read
 *
 * `at` reads like an optional convenience and is actually the difference
 * between an absolute and a relative read. `SyncFile` below never omits it, and
 * this interface therefore never relies on the cursor existing at all — which
 * is also what makes the fake's job small.
 */
export interface OpfsSyncHandle {
  read(buffer: Uint8Array, options?: OpfsReadWriteOptions): number;
  write(buffer: Uint8Array, options?: OpfsReadWriteOptions): number;
  truncate(newSize: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

/** The subset of `File` that reading a checkpoint without a lock needs. */
export interface OpfsFileSnapshot {
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface OpfsFile {
  readonly kind: 'file';
  readonly name: string;
  createSyncAccessHandle(): Promise<OpfsSyncHandle>;
  getFile(): Promise<OpfsFileSnapshot>;
}

/**
 * `FileSystemDirectoryHandle`, minus iteration. See the header for why.
 *
 * MEASURED error names, Chromium 152, matching the spec's stated exceptions:
 *
 *   getFileHandle(missing, {create:false})   -> NotFoundError
 *   getFileHandle(name of a directory)       -> TypeMismatchError
 *   getDirectoryHandle(name of a file)       -> TypeMismatchError
 *   removeEntry(non-empty directory)         -> InvalidModificationError
 *   removeEntry(non-empty, {recursive:true}) -> ok
 *   removeEntry(missing)                     -> NotFoundError
 *   a handle to a REMOVED file, reopened     -> NotFoundError
 *   a handle to a REMOVED directory, used    -> NotFoundError
 */
export interface OpfsDirectory {
  readonly kind: 'directory';
  readonly name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFile>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectory>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

/**
 * What `navigator.storage` supplies. Split out so quota reporting is testable
 * without a browser and without a global.
 *
 * MEASURED, Chromium 152:
 *   estimate() -> { quota: 10737425705, usage: 7465,
 *                   usageDetails: { fileSystem: 7465 } }
 *   persisted() -> false
 *
 * `usageDetails` is a Chromium extension and is NOT in the Storage Standard,
 * whose dictionary is exactly
 *
 *     dictionary StorageEstimate { unsigned long long usage;
 *                                  unsigned long long quota; };
 *     -- https://storage.spec.whatwg.org/#dictdef-storageestimate
 *
 * with both members OPTIONAL — no `required`, no default — which is why
 * `QuotaUsage.quota` is `number | null` and not `number`. TypeScript agrees:
 * `lib.dom.d.ts` declares `quota?: number; usage?: number`. Nothing here reads
 * `usageDetails`; a number that only one engine reports is not a number a
 * warning threshold may be built on.
 *
 * The same spec is the reason `QuotaUsage.shared` is hard-coded true for this
 * backend: "The storage usage of a storage shelf is an implementation-defined
 * rough estimate of the amount of bytes used by it" — a shelf, not a bucket per
 * API, so the number covers IndexedDB and Cache Storage too.
 */
export interface OpfsStorageManager {
  estimate(): Promise<{ usage?: number; quota?: number }>;
  persisted?(): Promise<boolean>;
  persist?(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// the file names
// ---------------------------------------------------------------------------

/**
 * Every file this store will ever create, by name, in one place.
 *
 * FIXED ASCII, for the naming reasons in the header — and, more importantly,
 * for locking. Creating a sync access handle
 *
 *     "takes an exclusive lock on the file entry ... This prevents the
 *      creation of further FileSystemSyncAccessHandles or
 *      FileSystemWritableFileStreams for the entry."
 *     -- https://fs.spec.whatwg.org/#filesystemsyncaccesshandle
 *
 * and if that lock cannot be taken, "reject result with a
 * NoModificationAllowedError DOMException".
 *
 * MEASURED, and this is the whole answer to PR-09's acceptance criterion "two
 * tabs cannot corrupt the tree":
 *
 *   a second createSyncAccessHandle in the SAME worker    -> NoModificationAllowedError
 *   createWritable() while a sync handle is open          -> NoModificationAllowedError
 *   removeEntry() on the file while its handle is open    -> NoModificationAllowedError
 *   a SECOND DEDICATED WORKER, same file                  -> NoModificationAllowedError
 *   a SECOND BROWSER TAB, its own worker, same file       -> NoModificationAllowedError
 *   getFile() (read only) from either                     -> allowed, sees flushed bytes
 *   worker.terminate() with the handle still open         -> the lock is released
 *
 * The lock is per FILE ENTRY. There is no directory-level lock in the spec and
 * none was found by probing. A store spread over one file per VFS node would
 * therefore be protected node by node, with no way to make a multi-file
 * mutation exclusive; a store held in this fixed handful of files is covered
 * completely, by the platform, with no cooperation required from the other tab.
 * Web Locks (see `opfs.ts`) is layered ON TOP of that to make the refusal
 * ORDERLY — a follower that knows it is a follower can go read-only instead of
 * discovering it by exception — but the safety does not depend on it, which
 * matters because a hostile or crashed tab does not have to cooperate.
 */
export const STORE_FILES = {
  /** Checkpoint slot A. See `opfs-store.ts` for why there are two. */
  slotA: 'ckpt-a.bin',
  /** Checkpoint slot B. */
  slotB: 'ckpt-b.bin',
  /** The write-ahead log. */
  wal: 'wal.bin',
  /** Written by a migration before it replaces a slot; see `opfs-migrate.ts`. */
  rollback: 'rollback.bin',
  /** Human-readable, written on every checkpoint, never read back. */
  readme: 'README.txt',
} as const;

/** The directory under the OPFS root that holds the store. */
export const STORE_DIRECTORY = 'browsershell';

// ---------------------------------------------------------------------------
// DOMException -> StorageError
// ---------------------------------------------------------------------------

/**
 * The name of a thrown `DOMException`, or null when the throw was not one.
 *
 * `instanceof DOMException` is not usable: this code runs in Node under the
 * test suite, where the constructor exists but nothing the fake throws is one,
 * and in a worker, where it is. Reading `.name` off an object is what both have
 * in common, and it is what the spec actually specifies — exceptions are named,
 * not classed.
 */
export function exceptionName(cause: unknown): string | null {
  if (typeof cause !== 'object' || cause === null) return null;
  const name = (cause as { name?: unknown }).name;
  return typeof name === 'string' ? name : null;
}

export function exceptionMessage(cause: unknown): string {
  if (typeof cause !== 'object' || cause === null) return String(cause);
  const message = (cause as { message?: unknown }).message;
  return typeof message === 'string' ? message : String(cause);
}

/**
 * Map a platform throw onto this repository's POSIX-shaped error union.
 *
 * WHAT IS DELIBERATELY NOT ADDED: an `EBUSY` arm.
 * `NoModificationAllowedError` is exactly EBUSY and there is no EBUSY in
 * `STORAGE_ERROR_CODES`. Adding one would widen `StorageError` under every
 * exhaustive `switch` in the command layer, which `types.ts` names as the one
 * change that must not be made casually ("adding EIO later would widen the
 * union under every command's exhaustive switch. It is here now"). A lock
 * conflict is reported as EROFS when it is discovered at mount — another
 * context owns the store, so this one genuinely is read-only, and that is the
 * true statement — and as EIO when it happens mid-operation, where the honest
 * summary is that the device failed underneath us. Both are arms callers
 * already handle.
 *
 * `QuotaExceededError` is the one that carries data: it becomes ENOSPC with a
 * `usage` reading, because the ENOSPC arm requires one and a caller that cannot
 * say how full the disk is cannot render a useful message.
 */
export function fromException(
  cause: unknown,
  path: string,
  syscall: StorageSyscall,
  usage: QuotaUsage,
): Err<StorageError> {
  const name = exceptionName(cause);
  const message = exceptionMessage(cause);

  switch (name) {
    case 'NotFoundError':
      return err({ code: 'ENOENT', path, syscall, message: `no such file or directory: ${path}` });
    case 'TypeMismatchError':
      return err({
        code: 'ENOTDIR',
        path,
        syscall,
        message: `not a directory: ${path}`,
        component: path,
      });
    case 'InvalidModificationError':
      // `removeEntry` without `recursive` on a directory that has children. The
      // count is not recoverable from the exception and this store never asks
      // the question of a directory it did not just build, so 0 is reported
      // rather than a guess.
      return err({ code: 'ENOTEMPTY', path, syscall, message: `directory not empty: ${path}`, entries: 0 });
    case 'QuotaExceededError':
      return err({
        code: 'ENOSPC',
        path,
        syscall,
        message: `no space left on device: ${message}`,
        usage,
      });
    case 'NoModificationAllowedError':
      return err({
        code: 'EIO',
        path,
        syscall,
        message: `the store is locked by another context: ${path}`,
        cause: `${name}: ${message}`,
      });
    case 'SecurityError':
    case 'NotAllowedError':
      return err({ code: 'EACCES', path, syscall, message: `permission denied: ${path}`, required: 'write' });
    case 'TypeError':
      return err({
        code: 'EINVAL',
        path,
        syscall,
        message: `the platform refused the name: ${message}`,
        reason: 'invalid-name',
      });
    default:
      return err({
        code: 'EIO',
        path,
        syscall,
        message: `the storage device failed: ${message}`,
        cause: name === null ? message : `${name}: ${message}`,
      });
  }
}

/** True when the throw was the platform saying "someone else holds this file". */
export function isLockConflict(cause: unknown): boolean {
  return exceptionName(cause) === 'NoModificationAllowedError';
}

/** True when the throw was the platform saying "there is nothing there". */
export function isNotFound(cause: unknown): boolean {
  return exceptionName(cause) === 'NotFoundError';
}

/** The reading used when nothing better is known. Shared, because OPFS is. */
export const UNKNOWN_USAGE: QuotaUsage = { used: 0, quota: null, shared: true, persisted: null };

// ---------------------------------------------------------------------------
// checksums
// ---------------------------------------------------------------------------

/**
 * FNV-1a over BYTES, returning the raw 32-bit value.
 *
 * `snapshot.ts` exports `fnv1a32(text)`, which UTF-8 encodes and returns hex.
 * This is the same function over the bytes it would have produced, kept
 * separate rather than re-encoding a base64 string of the payload — a WAL
 * record's payload is already bytes, and encoding it to a string to hash it
 * would double the work on the hot path.
 *
 * `tests/unit/opfs-platform.test.mts` asserts the two agree for the same input,
 * so this cannot drift into a second, subtly different checksum.
 */
export function fnv1a32Bytes(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// ---------------------------------------------------------------------------
// SyncFile
// ---------------------------------------------------------------------------

/**
 * One OPFS file, held open, with every throw turned into a `Result`.
 *
 * HELD OPEN FOR THE LIFETIME OF THE STORE, and that is the design rather than
 * an optimisation. The exclusive lock a sync access handle takes is the
 * mechanism that stops a second tab writing (see `STORE_FILES`); a store that
 * opened and closed a handle per operation would hand that exclusion away
 * between operations, and two tabs interleaving whole operations is exactly the
 * corruption the lock exists to prevent.
 *
 * Every call passes `at` explicitly. See `OpfsSyncHandle` for the cursor trap
 * that makes omitting it a silent wrong answer rather than a compile error.
 */
export class SyncFile {
  readonly #handle: OpfsSyncHandle;
  readonly #name: string;
  #closed = false;

  private constructor(handle: OpfsSyncHandle, name: string) {
    this.#handle = handle;
    this.#name = name;
  }

  /**
   * Open, creating when asked.
   *
   * The two failures a caller must be able to tell apart are "not there"
   * (`NotFoundError`, when `create` is false) and "someone else has it"
   * (`NoModificationAllowedError`), and both arrive as exceptions with nothing
   * but a name. `fromException` keeps them distinguishable downstream.
   */
  static async open(
    directory: OpfsDirectory,
    name: string,
    options: { create?: boolean } = {},
  ): Promise<Result<SyncFile>> {
    try {
      const file = await directory.getFileHandle(name, { create: options.create ?? false });
      const handle = await file.createSyncAccessHandle();
      return ok(new SyncFile(handle, name));
    } catch (cause) {
      return fromException(cause, name, 'write', UNKNOWN_USAGE);
    }
  }

  get name(): string {
    return this.#name;
  }

  get closed(): boolean {
    return this.#closed;
  }

  size(): Result<number> {
    try {
      return ok(this.#handle.getSize());
    } catch (cause) {
      return fromException(cause, this.#name, 'stat', UNKNOWN_USAGE);
    }
  }

  /**
   * Read `length` bytes from `at`. SHORT READS ARE AN ERROR HERE.
   *
   * The platform returns the number of bytes it managed, and returns 0 rather
   * than throwing when `at` is past the end — MEASURED: `read(buf, {at:99})` on
   * an 11-byte file returned 0. Every read this store performs is of a
   * structure whose length it already knows from a header it just parsed, so a
   * short read means the file is truncated, which is a corrupt store and not a
   * partial success. Returning the short count would push that judgement onto
   * five call sites; making it EIO here makes the corrupt case impossible to
   * forget.
   *
   * The buffer is allocated here, not passed in, because the platform leaves
   * the tail of an over-long buffer UNTOUCHED (measured: a 16-byte buffer over
   * a 5-byte file kept whatever was in bytes 5..15). A reused buffer would hand
   * stale bytes to a parser that trusted the length.
   */
  read(at: number, length: number): Result<Uint8Array> {
    if (length === 0) return ok(new Uint8Array(0));
    const buffer = new Uint8Array(length);
    let got: number;
    try {
      got = this.#handle.read(buffer, { at });
    } catch (cause) {
      return fromException(cause, this.#name, 'read', UNKNOWN_USAGE);
    }
    if (got !== length) {
      return err({
        code: 'EIO',
        path: this.#name,
        syscall: 'read',
        message: `short read: wanted ${String(length)} bytes at ${String(at)}, got ${String(got)}`,
        cause: 'short-read',
      });
    }
    return ok(buffer);
  }

  /** The whole file. Used for the WAL and a checkpoint slot, both bounded. */
  readAll(): Result<Uint8Array> {
    const size = this.size();
    if (!size.ok) return size;
    return this.read(0, size.value);
  }

  /**
   * Write at an absolute offset. A short write is EIO for the same reason a
   * short read is.
   *
   * `usage` is threaded through so a `QuotaExceededError` can be reported as
   * ENOSPC with real numbers. MEASURED: writing one byte at offset 2**53-1
   * raised `QuotaExceededError: No space available for this operation`, so this
   * is the arm the ceiling actually arrives through.
   */
  write(at: number, bytes: Uint8Array, usage: QuotaUsage = UNKNOWN_USAGE): Result<number> {
    let put: number;
    try {
      put = this.#handle.write(bytes, { at });
    } catch (cause) {
      return fromException(cause, this.#name, 'write', usage);
    }
    if (put !== bytes.byteLength) {
      return err({
        code: 'ENOSPC',
        path: this.#name,
        syscall: 'write',
        message: `short write: wanted ${String(bytes.byteLength)} bytes, wrote ${String(put)}`,
        usage,
      });
    }
    return ok(put);
  }

  truncate(size: number, usage: QuotaUsage = UNKNOWN_USAGE): Result<void> {
    try {
      this.#handle.truncate(size);
      return ok(undefined);
    } catch (cause) {
      return fromException(cause, this.#name, 'write', usage);
    }
  }

  /**
   * The durability barrier, and the only one.
   *
   * MEASURED: every read path — `getSize()` on the handle, `getFile()` from
   * another context — sees a write immediately, with no flush anywhere. So a
   * store that never flushed would look completely correct to itself and to
   * everyone else, and would lose whatever the operating system had not got
   * round to writing when the tab died. That is the failure a write-ahead log
   * exists to prevent, reintroduced one layer down and invisible to every test
   * that does not actually kill a process.
   *
   * WHAT REMAINS UNPROVEN. Nothing here has watched a real browser die and come
   * back. The measurements above establish that `flush()` exists, costs about
   * 0.75 ms, and does not affect visibility; they do NOT establish that data
   * flushed before a crash survives it and data not flushed does not. That is
   * the one claim in this file taken from the spec and from what `flush` means
   * everywhere else, rather than from a probe.
   */
  flush(usage: QuotaUsage = UNKNOWN_USAGE): Result<void> {
    try {
      this.#handle.flush();
      return ok(undefined);
    } catch (cause) {
      return fromException(cause, this.#name, 'write', usage);
    }
  }

  /**
   * Release the exclusive lock. Idempotent, because the platform's is:
   * MEASURED, calling `close()` twice on a real handle does not throw.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#handle.close();
    } catch {
      // A close that fails has nothing a caller can do about it and no state to
      // repair: the handle is gone either way, and the platform releases the
      // lock when the worker dies regardless (MEASURED: terminating a worker
      // with an open handle released it). Swallowing here keeps `close` usable
      // in a `finally`, which is the only place it is ever called.
    }
  }
}
