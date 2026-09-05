/**
 * types.ts — what a filesystem IS, before there is one.
 *
 * Twenty-eight commands (`ls`, `cat`, `mkdir`, `rm`, `cp`, `mv`, `touch`,
 * `nano`, `Get-ChildItem`, `Set-Content`, …) are unimplementable today. They
 * are NOT blocked on OPFS. They are blocked on this file. Written first, and
 * on purpose, so that the command work and the storage work can proceed
 * against the same contract instead of meeting at integration time and not
 * fitting — the same reason `invocation.ts` exists.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY OPERATION IS ASYNC, INCLUDING THE ONES THAT LOOK SYNCHRONOUS
 * ---------------------------------------------------------------------------
 *
 * The eventual backend is OPFS, and the only OPFS API that is fast enough to
 * back a terminal is `FileSystemFileHandle.createSyncAccessHandle()`. The
 * WHATWG File System spec marks it `[Exposed=DedicatedWorker]`:
 *
 *     [Exposed=DedicatedWorker, SecureContext]
 *     interface FileSystemSyncAccessHandle { … }
 *
 * That excludes Window AND SharedWorker. (Recent Safari exposes it more
 * widely; that is a reason nothing may DEPEND on the wider exposure, not a
 * reason to assume it.) So the handle lives in a dedicated worker, and the
 * caller — a command running in the kernel worker or on the main thread — is
 * never the holder. Every operation therefore crosses a `postMessage`, and a
 * synchronous signature would be a promise this layer cannot keep.
 *
 * The sync handle being synchronous *inside* its worker is irrelevant to the
 * shape of this interface. Getting that backwards is the one mistake that
 * would force all 28 commands to be rewritten later, which is exactly the cost
 * this file exists to avoid.
 *
 * ---------------------------------------------------------------------------
 * WHY Result<T, StorageError> AND NOT A THROW
 * ---------------------------------------------------------------------------
 *
 * v1's `fsSave()` returns a RENDERED ERROR ROW:
 *
 *     function fsSave(){
 *       try{ localStorage.setItem(FSKEY, …); return null; }
 *       catch(e){ return line('err','Warning: changes are in memory only; …'); }
 *     }
 *
 * and thirteen command bodies do `return saved(rows)` to append it. The
 * storage layer decides what the terminal prints. That is the coupling PR-09
 * task 9.7 exists to kill: it makes the failure untestable without a renderer,
 * unlocalisable, invisible to `$?` and `$LASTEXITCODE`, and impossible to turn
 * into an ErrorRecord that a script can branch on.
 *
 * A `Result` instead of a throw because these failures are EXPECTED. `cat` on a
 * missing file is not exceptional, it is Tuesday, and a `try`/`catch` around
 * every filesystem call is a control-flow shape that people forget exactly
 * once per command. The return type cannot be forgotten: `noUncheckedIndexedAccess`
 * and `strict` make `result.value` a compile error until `result.ok` is
 * checked. Genuine bugs — a corrupt backend, a violated invariant — still
 * throw, because a caller cannot do anything useful with those either.
 *
 * ---------------------------------------------------------------------------
 * WHY POSIX CODES AND NOT POWERSHELL ERROR IDS
 * ---------------------------------------------------------------------------
 *
 * MEASURED against pwsh 7.6.5 rather than assumed, and the measurement changed
 * the design. The same underlying condition produces a DIFFERENT
 * FullyQualifiedErrorId and a different category depending on which command hit
 * it, and sometimes no error at all:
 *
 *   condition                       command        FullyQualifiedErrorId          category
 *   ------------------------------  -------------  -----------------------------  ---------------
 *   path does not exist             Get-Item       PathNotFound                   ObjectNotFound
 *   path does not exist             Get-Content    PathNotFound                   ObjectNotFound
 *   traverse through a FILE         Get-ChildItem  PathNotFound                   ObjectNotFound
 *   target exists (file)            New-Item       NewItemIOError                 WriteError
 *   target exists (directory)       New-Item       DirectoryExist                 ResourceExists
 *   target exists                   Rename-Item    RenameItemIOError              WriteError
 *   target exists                   Move-Item      MoveFileInfoItemIOError        WriteError
 *   read a directory as content     Get-Content    GetContainerContentException   InvalidOperation
 *   copy a directory onto a file    Copy-Item      CopyContainerItemToLeafError   InvalidArgument
 *   copy a file onto a directory    Copy-Item      (no error — copies into it)
 *   remove a non-empty directory    Remove-Item    (no error — it PROMPTS)
 *
 * Three of those were surprises. `New-Item` uses two different ids and two
 * different categories for one condition. PowerShell does not distinguish
 * ENOTDIR from ENOENT at all — walking through a file reports "cannot find
 * path". And `Remove-Item` on a non-empty directory is not an error in
 * PowerShell, it is a `ShouldContinue` prompt (under `-NonInteractive` it
 * becomes `PSInvalidOperationException`, which is the prompt failing, not the
 * directory being non-empty).
 *
 * So the error id is a property of the COMMAND, not of the filesystem. If this
 * layer emitted `PathNotFound` it would be wrong for `New-Item` and it would
 * have to invent an answer for the two cases that are not errors. It emits the
 * POSIX-shaped condition; each command maps it to the record its own
 * reference-implementation behaviour calls for. That is the only split that
 * lets both halves be checked against pwsh independently.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE
 * ---------------------------------------------------------------------------
 *
 *   - No OPFS. It needs a dedicated worker and a message protocol, and it
 *     belongs in its own change. The point of this one is that adding it must
 *     not touch a single command. See `docs` on `StorageBackend` for the exact
 *     list of what an OPFS implementation has to supply.
 *   - No symbolic links. `StatKind` has two members, and nothing in the error
 *     union can report a link loop, because a code that nothing can produce is
 *     decoration. v1 makes the same call explicitly: it models Ubuntu's
 *     usr-merge `/bin` as a real directory with the same contents rather than
 *     as a symlink. When links land they add a `StatKind` member and an ELOOP
 *     arm, and every exhaustive `switch` over both will fail to compile — which
 *     is the point of both being unions.
 *   - No file locking or open handles. Commands read and write whole files.
 *     `nano` reads, edits in memory, writes back. Nothing streams yet.
 */

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

/**
 * Success or an expected failure.
 *
 * Shaped like `BindingOutcome` in `binding/binder.ts` — `{ ok: true }` /
 * `{ ok: false, error }` — deliberately, so a command handling a binding
 * failure and a storage failure writes the same two lines both times.
 */
export type Result<T, E = StorageError> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err(error: StorageError): Err<StorageError> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/**
 * A `StorageError` as a throwable, for the boundaries where a Result cannot be
 * returned — a constructor, a top-level `await`, a test helper.
 *
 * Not what the interface returns. It exists so that `unwrap` has something
 * honest to throw, rather than a bare `Error` whose code the catcher would have
 * to parse back out of a message.
 */
export class StorageFailure extends Error {
  readonly detail: StorageError;
  constructor(detail: StorageError) {
    super(detail.message);
    this.name = 'StorageFailure';
    this.detail = detail;
  }
}

/** Take the value, or throw. Only for callers that genuinely cannot branch. */
export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw new StorageFailure(result.error);
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

/**
 * The failure conditions, as POSIX names them.
 *
 * EVERY MEMBER IS PRODUCIBLE by the in-memory backend in this PR, and
 * `tests/unit/storage-errors.test.mts` asserts exactly that by iterating this
 * array. An error code that nothing can raise is a lie in the type system: it
 * makes callers write handling that is never exercised, and it makes the union
 * look more complete than the implementation is.
 *
 * EIO is the one that needed an argument. Nothing in a JavaScript object graph
 * fails at the device level — but OPFS does (a `FileSystemSyncAccessHandle`
 * throws `DOMException` on a truncated or evicted store), and adding EIO later
 * would widen the union under every command's exhaustive `switch`. It is here
 * now, and `MemoryStorage` can be told to raise it on demand, because the only
 * way to test that a caller handles device failure is to be able to cause one.
 */
export const STORAGE_ERROR_CODES = [
  'ENOENT',
  'EEXIST',
  'ENOTDIR',
  'EISDIR',
  'ENOTEMPTY',
  'EACCES',
  'ENOSPC',
  'EINVAL',
  'ENAMETOOLONG',
  'EXDEV',
  'EROFS',
  'EIO',
] as const;

export type StorageErrorCode = (typeof STORAGE_ERROR_CODES)[number];

/**
 * Which operation failed.
 *
 * Carried because a bare code loses the half of the message that makes it
 * actionable: ENOENT from `stat` and ENOENT from `rename`'s destination parent
 * read identically otherwise, and the second is the one people misdiagnose.
 */
export type StorageSyscall =
  | 'stat'
  | 'read'
  | 'write'
  | 'append'
  | 'mkdir'
  | 'readdir'
  | 'remove'
  | 'rename'
  | 'copy'
  | 'chmod'
  | 'utimes'
  | 'quota'
  | 'resolve'
  | 'snapshot'
  | 'restore';

interface StorageErrorBase {
  /**
   * The path the failure is about, resolved and absolute, drive-qualified when
   * it is not on the default drive. Never the raw text the user typed — that is
   * the command's to report, and it has it.
   */
  readonly path: string;
  readonly syscall: StorageSyscall;
  /**
   * One sentence, in the shape `strerror` uses. Not a rendered terminal row and
   * not a PowerShell message: the command owns the wording it shows, and this
   * is what a log or a `--verbose` trace prints.
   */
  readonly message: string;
}

/**
 * A discriminated union, not `{ code, message }`.
 *
 * The extra fields per arm are not decoration — each is something a caller has
 * to have and would otherwise re-derive with a second round trip:
 * `rm` wants the child count to say "the directory is not empty (3 items)";
 * a quota warning wants the numbers that were exceeded; and a cross-mount
 * `mv` has to name both sides to explain why it must copy-then-delete.
 */
export type StorageError =
  /** Nothing at this path. Also raised for a missing parent on write. */
  | (StorageErrorBase & { readonly code: 'ENOENT' })
  /** Something is already there, and the caller asked for it not to be. */
  | (StorageErrorBase & { readonly code: 'EEXIST'; readonly existing: StatKind })
  /** A path component that has to be a directory is a file. */
  | (StorageErrorBase & { readonly code: 'ENOTDIR'; readonly component: string })
  /** A directory was given where a file was required. */
  | (StorageErrorBase & { readonly code: 'EISDIR' })
  /** `remove` without `recursive` on a directory that has children. */
  | (StorageErrorBase & { readonly code: 'ENOTEMPTY'; readonly entries: number })
  /** The permission bits say no. `required` is which one was missing. */
  | (StorageErrorBase & { readonly code: 'EACCES'; readonly required: Permission })
  /** Out of quota. `usage` is the reading at the moment of refusal. */
  | (StorageErrorBase & { readonly code: 'ENOSPC'; readonly usage: QuotaUsage })
  /** The request itself is malformed: a NUL in a name, a copy into itself. */
  | (StorageErrorBase & { readonly code: 'EINVAL'; readonly reason: string })
  /** A component over NAME_MAX, or a whole path over PATH_MAX. */
  | (StorageErrorBase & {
      readonly code: 'ENAMETOOLONG';
      readonly limit: number;
      readonly actual: number;
    })
  /** `rename` across two mounts. The caller must copy and delete instead. */
  | (StorageErrorBase & { readonly code: 'EXDEV'; readonly from: string; readonly to: string })
  /** The mount is read-only. */
  | (StorageErrorBase & { readonly code: 'EROFS'; readonly mount: string })
  /** The backend failed underneath us. Never expected; always possible. */
  | (StorageErrorBase & { readonly code: 'EIO'; readonly cause: string });

/** Narrowing helper, so callers do not have to spell out the union member. */
export function hasCode<C extends StorageErrorCode>(
  error: StorageError,
  code: C,
): error is Extract<StorageError, { code: C }> {
  return error.code === code;
}

// ---------------------------------------------------------------------------
// metadata
// ---------------------------------------------------------------------------

/** Two members. There are no symbolic links; see the header. */
export type StatKind = 'file' | 'directory';

export type Permission = 'read' | 'write' | 'execute';

/**
 * Which layer a node came from.
 *
 * Part of `stat`, not a private field of the memory backend, and that is a
 * deliberate design decision rather than a leak. `snapshot()` has to be able to
 * export only what the user changed, and it is written against this interface
 * so it works unchanged over OPFS. If the seed marker were backend-private,
 * every backend would need its own snapshot implementation, and the export that
 * PR-09's risk section requires would be the first thing to diverge.
 *
 * v1 stores the same bit (`fnode(rows, seed, …)`) and uses it for the same
 * purpose (`fsSer` writes `{t:'f', s:1}` for a seed file instead of its
 * content).
 */
export type NodeOrigin = 'seed' | 'user';

/**
 * What `ls -l` and `Get-ChildItem` need, and nothing they do not.
 *
 * Times are epoch milliseconds and come from an injected clock, never from
 * `Date.now()` inside the backend — see `MemoryStorage`. A filesystem that
 * reads the wall clock cannot be tested for anything involving ordering.
 */
export interface FileStat {
  /** Absolute, drive-qualified, normalised. */
  readonly path: string;
  /** The last component. Empty only for a mount root. */
  readonly name: string;
  readonly kind: StatKind;
  /**
   * Bytes for a file. For a directory, `DIRECTORY_SIZE` — a constant, matching
   * ext4's 4096, which is what v1 reports and what `ls -l` shows on the machine
   * being emulated. Not the recursive contents; `du` is a different question.
   */
  readonly size: number;
  /**
   * POSIX permission bits INCLUDING setuid/setgid/sticky, as a number.
   *
   * A number and not v1's `'rwxr-xr-x'` string, because the string is a
   * rendering and `psobject.ts` is explicit that formatting is the last step.
   * `/tmp` is 0o1777 here and prints as `drwxrwxrwt`; storing the `t` would
   * make the sticky bit a character to pattern-match rather than a bit to test.
   */
  readonly mode: number;
  /** Modification time, epoch ms. */
  readonly mtime: number;
  /** Inode-change time, epoch ms. Moves on chmod, which mtime does not. */
  readonly ctime: number;
  /** Creation time, epoch ms. */
  readonly birthtime: number;
  readonly owner: string;
  readonly group: string;
  /**
   * Hard-link count, as `ls -l` prints it: 1 for a file, and 2 plus the number
   * of subdirectories for a directory (`.`, `..`, and each child's `..`).
   * Computed, not stored — there are no hard links to count.
   */
  readonly links: number;
  readonly origin: NodeOrigin;
}

/** A `readdir` row. `stat` is included because every caller immediately wants it. */
export interface DirectoryEntry {
  readonly name: string;
  readonly stat: FileStat;
}

/** `ls -l` on ext4 reports 4096 for a directory; so does v1, and so do we. */
export const DIRECTORY_SIZE = 4096;

/** POSIX `NAME_MAX` on Linux. Enforced, and tested. */
export const NAME_MAX = 255;

/** POSIX `PATH_MAX` on Linux. Enforced, and tested. */
export const PATH_MAX = 4096;

export const DEFAULT_FILE_MODE = 0o644;
export const DEFAULT_DIRECTORY_MODE = 0o755;

// ---------------------------------------------------------------------------
// mode formatting
// ---------------------------------------------------------------------------

const RWX = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx'] as const;

/**
 * `0o1777, 'directory'` → `drwxrwxrwt`.
 *
 * The special bits replace the execute character of their triplet, upper-case
 * when the execute bit is absent — `--S` versus `--s`. That case rule is the
 * detail people leave out, and leaving it out makes a setuid file without
 * execute permission indistinguishable from one with it.
 */
export function formatMode(mode: number, kind: StatKind): string {
  const triplet = (shift: number): string => RWX[(mode >> shift) & 0o7] ?? '---';
  const owner = [...triplet(6)];
  const group = [...triplet(3)];
  const other = [...triplet(0)];

  const special = (bits: string[], set: boolean, on: string, off: string): void => {
    if (!set) return;
    bits[2] = bits[2] === 'x' ? on : off;
  };
  special(owner, (mode & 0o4000) !== 0, 's', 'S');
  special(group, (mode & 0o2000) !== 0, 's', 'S');
  special(other, (mode & 0o1000) !== 0, 't', 'T');

  return (kind === 'directory' ? 'd' : '-') + owner.join('') + group.join('') + other.join('');
}

/**
 * The inverse, for seed data written the way `chmod` prints it.
 *
 * Accepts the nine-character body with or without a leading type character, so
 * both `rwxr-xr-x` (v1's `DEFMODE`) and `drwxr-xr-x` (`ls -l` output) parse.
 * Returns null rather than throwing: a mode read back out of a snapshot is
 * user-editable, and v1 already learned to validate it (`applyMeta` tests
 * `/^[rwxsStT-]{9}$/` before trusting it).
 */
export function parseMode(text: string): number | null {
  const body = text.length === 10 ? text.slice(1) : text;
  if (body.length !== 9) return null;

  let mode = 0;
  for (let triplet = 0; triplet < 3; triplet += 1) {
    const shift = 6 - triplet * 3;
    const r = body[triplet * 3];
    const w = body[triplet * 3 + 1];
    const x = body[triplet * 3 + 2];
    if (r === undefined || w === undefined || x === undefined) return null;

    if (r === 'r') mode |= 0o4 << shift;
    else if (r !== '-') return null;

    if (w === 'w') mode |= 0o2 << shift;
    else if (w !== '-') return null;

    if (x === 'x') mode |= 0o1 << shift;
    else if (x === 's' || x === 't') mode |= (0o1 << shift) | (0o4000 >> triplet);
    else if (x === 'S' || x === 'T') mode |= 0o4000 >> triplet;
    else if (x !== '-') return null;
  }
  return mode;
}

// ---------------------------------------------------------------------------
// quota
// ---------------------------------------------------------------------------

/**
 * What `navigator.storage.estimate()` reports, plus what it does not.
 *
 * PR-09 task 9.6 is "surface quota and warn before the ceiling", and the risk
 * section says OPFS is deleted when the user clears site data with no warning
 * from the browser. Two consequences are modelled here rather than left to a
 * comment: `persisted` (whether `navigator.storage.persist()` was granted, so
 * the UI can say "this can be evicted") and `shared` (OPFS does not get its own
 * quota — it shares the origin's with IndexedDB, Cache Storage and the rest, so
 * a number here is not a promise about how much room OPFS has).
 */
export interface QuotaUsage {
  /** Bytes this filesystem is using. */
  readonly used: number;
  /**
   * Bytes available in total, or null when the platform will not say.
   * `estimate()` can legitimately omit it, and a `0` there would read as full.
   */
  readonly quota: number | null;
  /** True when the quota is shared with other origin storage. Always true for OPFS. */
  readonly shared: boolean;
  /** Whether eviction has been opted out of, or null when unknown. */
  readonly persisted: boolean | null;
}

// ---------------------------------------------------------------------------
// operation options
// ---------------------------------------------------------------------------

export interface WriteOptions {
  /** Create the parent chain. Default false; a missing parent is ENOENT. */
  readonly createParents?: boolean;
  /** Mode for a newly created file. Ignored when the file already exists. */
  readonly mode?: number;
  /** Refuse if the path already exists (POSIX `O_EXCL`). Default false. */
  readonly exclusive?: boolean;
  /**
   * Which layer this node belongs to. Defaults to `'user'`, which is what every
   * command produces; only snapshot restore ever says otherwise.
   */
  readonly origin?: NodeOrigin;
}

export interface MkdirOptions {
  /** `mkdir -p`: create parents, and succeed when the target already exists. */
  readonly recursive?: boolean;
  readonly mode?: number;
  readonly origin?: NodeOrigin;
}

export interface RemoveOptions {
  /** Without this, a non-empty directory is ENOTEMPTY. */
  readonly recursive?: boolean;
  /** `rm -f`: a missing path succeeds instead of ENOENT. */
  readonly force?: boolean;
}

export interface RenameOptions {
  /** Replace an existing destination. Default false, which is EEXIST. */
  readonly overwrite?: boolean;
}

export interface CopyOptions {
  /** Required to copy a directory; without it a directory source is EISDIR. */
  readonly recursive?: boolean;
  readonly overwrite?: boolean;
}

/** Times to set, in epoch ms. Omitting one leaves it alone. */
export interface Times {
  readonly mtime?: number;
  readonly atime?: number;
}

/** What a write reports back, so `Set-Content` need not re-`stat`. */
export interface WriteReceipt {
  readonly path: string;
  readonly size: number;
  readonly created: boolean;
}

// ---------------------------------------------------------------------------
// the seed image
// ---------------------------------------------------------------------------

/**
 * One node of the seed tree, as data.
 *
 * v1 builds its seed by CALLING functions — `put(HOME,'README.md',[line(…)])` —
 * so the seed is only expressible as running code, and what it produces is
 * pre-rendered view rows. Here it is a value: enumerable, comparable, and
 * diffable against what is on disk, which is what makes "rebuild the seed each
 * boot" checkable rather than hopeful.
 */
export interface SeedEntry {
  /** Absolute, on the filesystem drive. Parents are created as needed. */
  readonly path: string;
  readonly kind: StatKind;
  /** UTF-8 text for a file. Ignored for a directory. */
  readonly content?: string;
  readonly mode?: number;
  readonly owner?: string;
  readonly group?: string;
}

export interface SeedSpec {
  /**
   * The timestamp every seed node carries.
   *
   * v1 pins this to a constant (`SEEDTIME = 2026-07-19T12:00:00Z`) for two
   * reasons it states outright, and both survive: a fixed value lets the
   * serialiser store only the mtimes that DEVIATE from it, and a value in the
   * past stops seed files appearing newer than files the user just created.
   */
  readonly time: number;
  readonly entries: readonly SeedEntry[];
}

// ---------------------------------------------------------------------------
// the interface
// ---------------------------------------------------------------------------

/**
 * One mount's worth of storage.
 *
 * Paths arriving here are ALREADY RESOLVED: absolute within this mount,
 * normalised, no `.` or `..`, no drive qualifier, no quotes. The resolution is
 * `vfs.ts`'s job and is done once for every backend, which is PR-10's
 * acceptance criterion "one path resolver, used by every provider".
 *
 * The complete list of what an OPFS implementation has to supply, so that the
 * claim "adding it touches no command" is checkable rather than hopeful:
 *
 *   1. every method below, each returning the same `Result` arms;
 *   2. a dedicated worker holding every `FileSystemSyncAccessHandle`, because
 *      `createSyncAccessHandle()` is `[Exposed=DedicatedWorker]`;
 *   3. a `postMessage` protocol whose payloads are structured-cloneable —
 *      `Uint8Array` is, `StorageError` is (it is plain data, no class, no
 *      `Error` subclass, deliberately), `FileStat` is;
 *   4. leader election via Web Locks, NOT SharedWorker. Web Locks has been
 *      available across browsers since March 2022; SharedWorker only became
 *      Baseline recently and is absent on Samsung Internet and Opera Mobile, so
 *      it may be an optimisation and never a requirement;
 *   5. `quota()` backed by `navigator.storage.estimate()`, reporting
 *      `shared: true` — OPFS has no quota of its own;
 *   6. a write-ahead log. See `docs/` on `MutationPlan` below for why the
 *      memory backend does not need one and exactly where OPFS attaches it.
 *
 * Nothing in that list reaches a command.
 */
/**
 * ---------------------------------------------------------------------------
 * CONCURRENCY CONTRACT: ONE OPERATION AT A TIME PER MOUNT
 * ---------------------------------------------------------------------------
 *
 * A mount runs ONE mutating operation at a time, and THE BACKEND SERIALISES —
 * callers do not have to. Overlapping calls are legal, well-defined and
 * ordered: each one re-validates against the tree its predecessor left, so the
 * loser of a race gets the ordinary POSIX refusal (EEXIST, ENOENT, ENOSPC) and
 * never a corrupt tree or a thrown exception.
 *
 * This is a contract and not an implementation note because the target is a
 * `StorageWorker` handling `postMessage`, where every async handler runs
 * concurrently by construction. Without it, measured on the memory backend:
 * two appends to one file lost one, two `exclusive` writes both won, two
 * `mkdir` calls both won, capacity 10 accepted two 8-byte writes, and removing
 * a subtree and its parent at once threw `plan referenced a missing node` out
 * of an API whose entire signature promises a `Result`.
 *
 * Reads are NOT serialised and do not need to be. A read walks the tree and
 * returns within one synchronous section, and the apply phase of a mutation is
 * synchronous too (see `MutationPlan`), so no read can observe a half-applied
 * plan. Serialising them would only add a way to deadlock a mutation that
 * stats its own result.
 *
 * A backend that cannot serialise internally must say so; every caller in this
 * repo is written against the guarantee.
 */
export interface StorageBackend {
  /** A stable name for this backend, used in EROFS and diagnostics. */
  readonly name: string;
  /** Whether every mutating call will return EROFS. */
  readonly readOnly: boolean;

  stat(path: string): Promise<Result<FileStat>>;
  /**
   * True/false rather than a Result.
   *
   * A path the caller cannot REACH is also false, not an error — which matches
   * `Test-Path`, and is the honest answer besides: distinguishing "absent" from
   * "present but you may not look" is itself a disclosure. Callers that need the
   * distinction ask `access` or `stat`.
   */
  exists(path: string): Promise<boolean>;
  /**
   * POSIX `access(2)`: may the current user do this to this path?
   *
   * Needed because a permission is not always implied by the operation that
   * follows it. `chdir()` requires EXECUTE on the target directory, and a walk
   * that only checks the directories it CROSSES will happily `stat` a directory
   * the user cannot enter — so `Set-Location` would succeed where a real shell
   * says "Permission denied". `Test-Path` and completion need the same
   * question asked without performing the operation.
   */
  access(path: string, permission: Permission): Promise<Result<void>>;

  readBytes(path: string): Promise<Result<Uint8Array>>;
  /**
   * UTF-8, with a leading BOM stripped, and undecodable bytes replaced rather
   * than rejected — `Get-Content` strips the BOM, and `cat` on a binary file
   * shows mojibake instead of failing. `readBytes` is the exact form.
   */
  readText(path: string): Promise<Result<string>>;

  writeBytes(path: string, data: Uint8Array, options?: WriteOptions): Promise<Result<WriteReceipt>>;
  writeText(path: string, text: string, options?: WriteOptions): Promise<Result<WriteReceipt>>;
  appendBytes(path: string, data: Uint8Array, options?: WriteOptions): Promise<Result<WriteReceipt>>;
  appendText(path: string, text: string, options?: WriteOptions): Promise<Result<WriteReceipt>>;

  mkdir(path: string, options?: MkdirOptions): Promise<Result<FileStat>>;
  /**
   * Entries in the backend's own order, NOT sorted.
   *
   * `readdir(2)` returns an arbitrary order and `ls` is what sorts; putting the
   * sort here would hide that a command forgot to. Anything that needs a stable
   * order sorts explicitly — `createSnapshot` does, so two exports of the same
   * tree are byte-identical.
   */
  readdir(path: string): Promise<Result<readonly DirectoryEntry[]>>;
  remove(path: string, options?: RemoveOptions): Promise<Result<void>>;
  rename(from: string, to: string, options?: RenameOptions): Promise<Result<void>>;
  copy(from: string, to: string, options?: CopyOptions): Promise<Result<void>>;

  chmod(path: string, mode: number): Promise<Result<FileStat>>;
  /** `touch`: creates the file when it is absent, unless `create` is false. */
  utimes(path: string, times: Times, create?: boolean): Promise<Result<FileStat>>;

  quota(): Promise<Result<QuotaUsage>>;

  /**
   * Install the seed image. PRIVILEGED, and boot-time only.
   *
   * It bypasses permission checks, and it has to: `/etc` is owned by root at
   * 0o755, so writing `/etc/os-release` through the ordinary API as the visitor
   * would be EACCES, and the seed is the disk image — it exists before the user
   * does. v1 does the same thing by manipulating the tree directly inside
   * `buildSeed()`; making it a named method rather than a side door is what
   * lets the bypass be reviewed.
   *
   * Not reachable from `VirtualFileSystem`, which is what a command holds. A
   * command cannot install an image, cannot mark a node as seed, and cannot get
   * at this by any route the type system allows.
   *
   * Called on a freshly reset mount. Every durable backend needs it too — OPFS
   * runs it on first mount and after a seed-version bump — so it belongs in the
   * interface rather than in one implementation.
   */
  installImage(spec: SeedSpec): Promise<Result<void>>;

  /** Discard everything. `Reset-FileSystem`, and the first half of a re-seed. */
  reset(): Promise<Result<void>>;
}

// ---------------------------------------------------------------------------
// the write-ahead log seam
// ---------------------------------------------------------------------------

/**
 * One step of a multi-step mutation, recorded BEFORE anything is applied.
 *
 * ---------------------------------------------------------------------------
 * WHY THE MEMORY BACKEND DOES NOT NEED A WAL, AND WHERE OPFS ATTACHES ONE
 * ---------------------------------------------------------------------------
 *
 * A write-ahead log buys crash atomicity: after an interruption, replay or undo
 * whatever was half-applied. That has a precondition — the store must SURVIVE
 * the interruption. The in-memory tree does not. If the tab dies mid-`cp -r`,
 * the tree dies with it and there is nothing to recover to. A WAL over memory
 * would be a log nothing could ever read.
 *
 * The other thing a WAL buys is atomicity against CONCURRENT operations, and
 * that one needs TWO properties, not one. This file used to claim only the
 * first, and claim it too broadly:
 *
 *   1. APPLY IS SYNCHRONOUS. Every multi-step operation is PLAN, VALIDATE, then
 *      APPLY:
 *
 *          const plan = planRecursiveCopy(from, to);  // walks, allocates nothing
 *          if (!plan.ok) return plan;                 // nothing has been touched
 *          applyPlan(plan.value);                     // synchronous, total
 *
 *      so a `cp -r` that fails on its ninth file leaves the destination EXACTLY
 *      as it was, with no partial tree to clean up. GNU cp does NOT give you
 *      this — MEASURED, coreutils 8.32: `cp -r src/. dst/` refusing on `zzz`
 *      had already created `aaa`. Planning the refusal is what makes this
 *      backend stronger than the reference, and it is tested directly.
 *
 *   2. NO SECOND OPERATION RUNS IN THE GAP. `#commit` awaits
 *      `journal.write(plan)` BETWEEN the last validation and the apply — it has
 *      to, because that await is the OPFS attachment point — so the plan-to-
 *      apply window is a real suspension point, not a synchronous section. The
 *      earlier version of this comment asserted there was no `await` there and
 *      was simply wrong: with two operations in flight, two appends to one file
 *      silently lost one, two `exclusive` writes both succeeded, and removing a
 *      subtree and its parent at once threw out of a Result API.
 *
 *      The fix is not to make `#commit` synchronous. It is a promise-chain
 *      mutex on every mutating entry point, so a mount runs ONE operation at a
 *      time and the second one re-validates against the tree the first left
 *      behind. See `StorageBackend` for the contract that states this.
 *
 * Both properties together are what a WAL would otherwise have to provide.
 *
 * OPFS cannot do that. Its apply phase is a sequence of `await`s over durable
 * handles; it can be interrupted between any two, and what it leaves behind
 * outlives the interruption. So it needs the log — and `MutationPlan` is
 * already the record it writes. The attachment point is exactly one call:
 * `journal.write(plan)` between VALIDATE and APPLY, and `journal.commit()`
 * after, with recovery at mount replaying or discarding any uncommitted plan.
 * `NullJournal` is what memory uses, and it is not a stub standing in for
 * missing work — it is the correct implementation for a store with no
 * durability to protect.
 */
export interface MutationStep {
  readonly op: 'create-file' | 'create-directory' | 'write' | 'remove' | 'move' | 'set-meta';
  readonly path: string;
  /**
   * The source of a `move`. A move is ONE step, not a remove plus a create:
   * splitting it would reset `birthtime`, and a journal replaying the halves
   * separately could leave the node in neither place.
   */
  readonly from?: string;
  /** Bytes for a write. Absent for everything else. */
  readonly data?: Uint8Array;
  readonly mode?: number;
  readonly mtime?: number;
  readonly origin?: NodeOrigin;
}

/**
 * A validated, ordered set of steps that has NOT been applied.
 *
 * Order matters: parents before children on create, children before parents on
 * remove. A journal replaying this after a crash must be able to apply it
 * front-to-back without reordering.
 */
export interface MutationPlan {
  /**
   * Identity that SURVIVES SERIALISATION. Unique per backend instance.
   *
   * A durable journal writes the plan to storage and reads it back as a
   * different object, so a `pending()` built on `Array.includes` — reference
   * identity — reports every replayed plan as still uncommitted and re-applies
   * work that already happened. Comparing on this field is what makes
   * write/commit/pending mean the same thing before and after a round trip.
   *
   * Derived from the backend name and a counter, not a clock or a random
   * source: this file's determinism rule is that two identical runs produce
   * identical bytes, and a plan id ends up inside a journal's own records.
   */
  readonly id: string;
  readonly syscall: StorageSyscall;
  readonly steps: readonly MutationStep[];
  /** Net change in bytes stored, for the quota check that runs before apply. */
  readonly byteDelta: number;
}

/**
 * Where a durable backend writes its plan. See `MutationPlan` for why memory
 * uses the null implementation and why that is not a placeholder.
 */
export interface MutationJournal {
  /** Record the plan. Must be durable before `apply` starts. */
  write(plan: MutationPlan): Promise<Result<void>>;
  /** The plan completed; the record may be discarded. */
  commit(plan: MutationPlan): Promise<Result<void>>;
  /** Plans written but never committed, in write order. Replayed at mount. */
  pending(): Promise<Result<readonly MutationPlan[]>>;
}
