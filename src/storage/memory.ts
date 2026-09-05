/**
 * memory.ts — a complete filesystem that runs in Node today, with no browser.
 *
 * Not a mock and not a stand-in for OPFS. It is the backend the whole command
 * layer can be built and tested against, which is the point of the split: 28
 * commands were blocked on an interface, and an interface with one working
 * implementation unblocks them, while an interface with zero does not.
 *
 * Everything the eventual OPFS backend has to get right is decided here first,
 * where it can be tested deterministically: what `stat` reports, which
 * conditions map to which POSIX code, what order a recursive walk visits, when
 * a directory's mtime moves. Getting those wrong inside a worker, behind a
 * postMessage boundary, is a much worse place to find out.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM
 * ---------------------------------------------------------------------------
 *
 * There is no `Date.now()` in this file. The clock is a constructor argument.
 * v1 calls `Date.now()` in `stamp()`, `setChild()` and `rmChild()` — three
 * sites — and the consequence is that nothing about ordering can be tested:
 * two files created in the same millisecond tie, and `ls -t` has no defined
 * answer. `CapabilityBroker` in `kernel/capabilities.ts` already takes the same
 * argument for the same reason, and its `AuditLog` goes further and orders by a
 * counter because "an audit log whose entries can tie is one whose ordering
 * cannot be argued from".
 *
 * ---------------------------------------------------------------------------
 * WHY A Map AND NOT AN OBJECT
 * ---------------------------------------------------------------------------
 *
 * v1 uses `Object.create(null)` for directory children and comments that a file
 * called `__proto__` would otherwise rewrite the prototype and make the whole
 * directory's structure disappear on serialisation. That is the right fix for
 * an object; a `Map` makes the class of bug unreachable rather than avoided,
 * keeps insertion order defined, and gives `size` without `Object.keys().length`
 * allocating an array on every `readdir`. There is a test that creates files
 * named `__proto__`, `constructor` and `prototype` and reads them back.
 *
 * ---------------------------------------------------------------------------
 * PERMISSIONS, AND WHY THERE IS NO ROOT BYPASS
 * ---------------------------------------------------------------------------
 *
 * Real POSIX lets uid 0 skip every permission check. This does not, and the
 * omission is deliberate: `kernel/capabilities.ts` is built around the claim
 * that simulated elevation confers nothing, and warns in its header that
 * someone will eventually add `if (elevated) return true` to a permission check
 * "because it obviously should work that way". A root bypass here would be that
 * line. `sudo` moves a string in `VirtualPolicy`; if a user is named `root` and
 * owns `/root`, the ordinary owner-triplet computation already gives them
 * access, and nothing else does.
 *
 * The check itself is standard POSIX: owner triplet if the owner matches, else
 * group triplet if the group matches, else other. v1 skips the group triplet
 * ("此單使用者模型省略 group"); it is included here because `mode` already has
 * the bits and a two-thirds implementation of a permission model is harder to
 * reason about than a whole one.
 *
 * ---------------------------------------------------------------------------
 * ATIME IS NOT UPDATED ON READ
 * ---------------------------------------------------------------------------
 *
 * `noatime` semantics, and a real Linux mount option rather than a shortcut. If
 * reading touched atime, every `cat` would be a mutation, every browse would
 * dirty the overlay, and the snapshot would grow while the user changed
 * nothing. atime is set at creation and by an explicit `utimes`.
 */

import {
  DEFAULT_DIRECTORY_MODE,
  DEFAULT_FILE_MODE,
  DIRECTORY_SIZE,
  PATH_MAX,
  err,
  ok,
} from './types.ts';
import type {
  CopyOptions,
  DirectoryEntry,
  Err,
  FileStat,
  MkdirOptions,
  MutationJournal,
  MutationPlan,
  MutationStep,
  NodeOrigin,
  Permission,
  QuotaUsage,
  RemoveOptions,
  RenameOptions,
  Result,
  SeedSpec,
  StatKind,
  StorageBackend,
  StorageError,
  StorageSyscall,
  Times,
  WriteOptions,
  WriteReceipt,
} from './types.ts';
import { basename, dirname, isDescendant, splitSegments, validatePath,
  requireNormalisedPath,
} from './vfs.ts';

// ---------------------------------------------------------------------------
// the tree
// ---------------------------------------------------------------------------

interface NodeMeta {
  mode: number;
  mtime: number;
  ctime: number;
  atime: number;
  birthtime: number;
  owner: string;
  group: string;
  origin: NodeOrigin;
}

interface MemoryFile extends NodeMeta {
  readonly kind: 'file';
  data: Uint8Array;
}

interface MemoryDirectory extends NodeMeta {
  readonly kind: 'directory';
  readonly children: Map<string, MemoryNode>;
}

type MemoryNode = MemoryFile | MemoryDirectory;

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

export interface MemoryStorageOptions {
  /** Epoch milliseconds. Injected so ordering is testable; see the header. */
  readonly clock: () => number;
  /** Who the checks are run as. */
  readonly user?: string;
  readonly group?: string;
  /**
   * Who owns the mount root before an image is installed.
   *
   * Defaults to the user, and it has to: a fresh mount whose root is owned by
   * someone else is one nobody can write to, which made a second mount useless
   * as anything but a read-only provider. The filesystem drive gets `/` back to
   * root ownership from the seed, where it belongs and where it is visible.
   */
  readonly rootOwner?: string;
  /** Total bytes of file content allowed. Null means unbounded. */
  readonly capacity?: number | null;
  readonly name?: string;
  readonly readOnly?: boolean;
  /**
   * Where a durable backend would write its plan before applying it.
   *
   * Memory passes nothing and gets `NullJournal`, which is the CORRECT
   * implementation for a store that cannot survive the interruption a log
   * exists to recover from — see `MutationPlan` in `types.ts`. It is wired
   * anyway so the seam is exercised: a test asserts the journal sees the exact
   * steps of a recursive copy, which is what makes the OPFS attachment point a
   * tested interface rather than a promise.
   */
  readonly journal?: MutationJournal;
  /**
   * Force a device-level failure. TEST AFFORDANCE, and named to say so.
   *
   * EIO is in the error union because OPFS raises it (a
   * `FileSystemSyncAccessHandle` throws `DOMException` when the store is
   * truncated or evicted) and because widening the union later would break
   * every command's exhaustive switch. An error code nothing can produce is
   * untestable, and untested error handling is the handling that is wrong. This
   * is how a test produces one.
   */
  readonly injectFault?: (syscall: StorageSyscall, path: string) => string | null;
}

/**
 * The journal a store with no durability needs. See `MutationPlan`.
 *
 * `#written` is kept so a test can assert that the seam actually carries the
 * plan, rather than that a method exists.
 */
export class NullJournal implements MutationJournal {
  readonly #written: MutationPlan[] = [];
  readonly #committed: MutationPlan[] = [];

  async write(plan: MutationPlan): Promise<Result<void>> {
    this.#written.push(plan);
    return ok(undefined);
  }

  async commit(plan: MutationPlan): Promise<Result<void>> {
    this.#committed.push(plan);
    return ok(undefined);
  }

  /**
   * Written but not committed, compared on `plan.id` and NOT on the object.
   *
   * `Array.includes` is reference identity, and the whole point of a durable
   * journal is that it hands back a plan it read off disk — a different object
   * with the same content. Under reference identity every replayed plan reads
   * as still pending, so recovery re-applies work that already happened. This
   * implementation is memory-only, but it is the one an OPFS journal is
   * written against, so it has to model the round trip correctly.
   */
  async pending(): Promise<Result<readonly MutationPlan[]>> {
    const committed = new Set(this.#committed.map((plan) => plan.id));
    return ok(this.#written.filter((plan) => !committed.has(plan.id)));
  }

  get written(): readonly MutationPlan[] {
    return this.#written;
  }

  get committed(): readonly MutationPlan[] {
    return this.#committed;
  }
}

// ---------------------------------------------------------------------------
// error construction
// ---------------------------------------------------------------------------

function enoent(path: string, syscall: StorageSyscall): Err<StorageError> {
  return err({
    code: 'ENOENT',
    path,
    syscall,
    message: `no such file or directory: ${path}`,
  });
}

function enotdir(path: string, syscall: StorageSyscall, component: string): Err<StorageError> {
  return err({
    code: 'ENOTDIR',
    path,
    syscall,
    message: `not a directory: ${component}`,
    component,
  });
}

function eisdir(path: string, syscall: StorageSyscall): Err<StorageError> {
  return err({ code: 'EISDIR', path, syscall, message: `is a directory: ${path}` });
}

function eexist(path: string, syscall: StorageSyscall, existing: StatKind): Err<StorageError> {
  return err({ code: 'EEXIST', path, syscall, message: `already exists: ${path}`, existing });
}

function eacces(path: string, syscall: StorageSyscall, required: Permission): Err<StorageError> {
  return err({
    code: 'EACCES',
    path,
    syscall,
    message: `permission denied: ${required} on ${path}`,
    required,
  });
}

function einval(path: string, syscall: StorageSyscall, message: string, reason: string): Err<StorageError> {
  return err({ code: 'EINVAL', path, syscall, message, reason });
}

function enametoolong(path: string, syscall: StorageSyscall, limit: number): Err<StorageError> {
  return err({
    code: 'ENAMETOOLONG',
    path: path.slice(0, 80),
    syscall,
    message: `path exceeds PATH_MAX (${String(limit)})`,
    limit,
    actual: path.length,
  });
}

// ---------------------------------------------------------------------------
// the backend
// ---------------------------------------------------------------------------

const ENCODER = new TextEncoder();
/**
 * `fatal: false` so undecodable bytes become U+FFFD instead of throwing — `cat`
 * on a binary file shows mojibake, it does not fail. `ignoreBOM` is left at its
 * default of false, which (confusingly) means the BOM IS consumed, matching
 * `Get-Content`. `readBytes` is the lossless form for anything that must be exact.
 */
const DECODER = new TextDecoder('utf-8', { fatal: false });

export class MemoryStorage implements StorageBackend {
  readonly name: string;
  readonly readOnly: boolean;

  readonly #clock: () => number;
  readonly #user: string;
  readonly #group: string;
  readonly #capacity: number | null;
  readonly #journal: MutationJournal;
  readonly #injectFault: (syscall: StorageSyscall, path: string) => string | null;
  readonly #rootOwner: string;
  #root: MemoryDirectory;

  /**
   * The mutex. See the concurrency contract on `StorageBackend`.
   *
   * A promise chain rather than a lock object because there is nothing to lock
   * against: JavaScript has one thread, and what has to be prevented is a
   * SECOND operation starting while the first is suspended at
   * `await journal.write(plan)` — the one await that sits between the last
   * validation and the apply, and cannot be removed because it is the point an
   * OPFS write-ahead log attaches to.
   *
   * Never rejects: every link is capped with a swallow so one operation's
   * failure cannot poison the queue for the next. The caller still sees the
   * rejection, through the promise `#serialise` returns.
   */
  #queue: Promise<void> = Promise.resolve();

  /**
   * Counter behind `MutationPlan.id`. Not a clock and not a random source —
   * this file's determinism rule is that two identical runs produce identical
   * output, and a plan id ends up inside a durable journal's records.
   */
  #plans = 0;

  /**
   * Running total of stored file bytes, maintained by `#apply`.
   *
   * MEASURED: recomputing this by walking the tree on every capacity-checked
   * mutation cost 4381 ms for 8000 writes with a capacity set, against 35 ms
   * with no capacity, because the walk is O(tree) per write and the tree grows.
   * The walk still exists as `#usedBytes()` and is the authority after the two
   * operations that bypass `#apply` — `reset` and `installImage`.
   */
  #used = 0;

  constructor(options: MemoryStorageOptions) {
    this.#clock = options.clock;
    this.#user = options.user ?? 'thc1006';
    this.#group = options.group ?? 'thc1006';
    this.#capacity = options.capacity ?? null;
    this.name = options.name ?? 'memory';
    this.readOnly = options.readOnly ?? false;
    this.#journal = options.journal ?? new NullJournal();
    this.#injectFault = options.injectFault ?? (() => null);
    this.#rootOwner = options.rootOwner ?? this.#user;
    this.#root = this.#newDirectory(DEFAULT_DIRECTORY_MODE, this.#rootOwner, this.#rootOwner, 'seed');
  }

  /**
   * Run `operation` after every mutation already queued on this mount.
   *
   * Reads deliberately do NOT go through here. A read walks and returns inside
   * one synchronous section and `#apply` is synchronous too, so a read can
   * never see a half-applied plan; routing reads through the queue would only
   * create a way for `mkdir` to deadlock on the `stat` it does to build its
   * own return value.
   */
  #serialise<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(operation);
    this.#queue = run.then(noop, noop);
    return run;
  }

  #nextPlanId(): string {
    this.#plans += 1;
    return `${this.name}-${String(this.#plans)}`;
  }

  /** Throw away everything. `Reset-FileSystem`, and the boot path before seeding. */
  async reset(): Promise<Result<void>> {
    return this.#serialise(async () => {
      this.#root = this.#newDirectory(DEFAULT_DIRECTORY_MODE, this.#rootOwner, this.#rootOwner, 'seed');
      this.#used = 0;
      return ok(undefined);
    });
  }

  get user(): string {
    return this.#user;
  }

  /**
   * Install the seed image, bypassing permission checks. See `StorageBackend`.
   *
   * Direct tree construction rather than the plan/apply path, and deliberately:
   * the checks that path exists to enforce are exactly the ones that must not
   * apply. Writing `/etc/os-release` as the visitor is EACCES because `/etc` is
   * root-owned at 0o755, and it should be — the seed is the disk image, and it
   * predates the user. Every node lands with `origin: 'seed'` and the spec's
   * fixed timestamp, which is what lets the snapshot store only deviations.
   */
  async installImage(spec: SeedSpec): Promise<Result<void>> {
    return this.#serialise(() => this.#installImageLocked(spec));
  }

  async #installImageLocked(spec: SeedSpec): Promise<Result<void>> {
    // `finally`, and not a line at the end of the happy path. `#installEntries`
    // mutates the tree entry by entry and can bail out PART WAY — an
    // unnormalised path, a component that turns out to be a file, a seed root
    // declared as a file — with earlier entries already written. Recomputing
    // only on the successful return left `#used` stale forever, and because
    // `#checkCapacity` reads it, a capacity-100 mount then accepted 90 more
    // bytes on top of the 90 the failed image had already stored. MEASURED at
    // 180 bytes in a 100-byte mount before this moved.
    try {
      return this.#installEntries(spec);
    } finally {
      this.#used = this.#usedBytes();
    }
  }

  #installEntries(spec: SeedSpec): Result<void> {
    for (const entry of spec.entries) {
      const checked = validatePath(entry.path, 'restore');
      if (checked.ok) {
        const normalised = requireNormalisedPath(entry.path, 'restore');
        if (!normalised.ok) return normalised;
      }
      if (!checked.ok) return checked;

      const segments = splitSegments(entry.path);
      const name = segments.pop();
      if (name === undefined) {
        // '/' itself. Metadata only — the seed is how the filesystem drive's
        // root becomes root-owned, which is what makes `rm -rf ~` fail the way
        // it fails on a real box: /home is not writable by the visitor.
        if (entry.kind !== 'directory') {
          return einval(entry.path, 'restore', 'the mount root cannot be a file', 'seed-root');
        }
        this.#root.mode = entry.mode ?? DEFAULT_DIRECTORY_MODE;
        this.#root.owner = entry.owner ?? this.#rootOwner;
        this.#root.group = entry.group ?? this.#root.owner;
        this.#root.mtime = spec.time;
        this.#root.ctime = spec.time;
        this.#root.atime = spec.time;
        this.#root.birthtime = spec.time;
        continue;
      }

      let parent = this.#root;
      let walked = '';
      for (const segment of segments) {
        walked = `${walked}/${segment}`;
        let next = parent.children.get(segment);
        if (next === undefined) {
          next = this.#newDirectory(DEFAULT_DIRECTORY_MODE, this.#rootOwner, this.#rootOwner, 'seed');
          next.mtime = spec.time;
          next.ctime = spec.time;
          next.atime = spec.time;
          next.birthtime = spec.time;
          parent.children.set(segment, next);
        }
        if (next.kind !== 'directory') return enotdir(entry.path, 'restore', walked);
        parent = next;
      }

      const owner = entry.owner ?? this.#user;
      const group = entry.group ?? owner;
      const mode =
        entry.mode ?? (entry.kind === 'directory' ? DEFAULT_DIRECTORY_MODE : DEFAULT_FILE_MODE);

      const existing = parent.children.get(name);
      const node: MemoryNode =
        entry.kind === 'directory'
          ? existing !== undefined && existing.kind === 'directory'
            ? existing
            : this.#newDirectory(mode, owner, group, 'seed')
          : this.#newFile(ENCODER.encode(entry.content ?? ''), mode, owner, group, 'seed');

      node.mode = mode;
      node.owner = owner;
      node.group = group;
      node.origin = 'seed';
      node.mtime = spec.time;
      node.ctime = spec.time;
      node.atime = spec.time;
      node.birthtime = spec.time;
      parent.children.set(name, node);
    }
    return ok(undefined);
  }

  // -------------------------------------------------------------------------
  // node construction
  // -------------------------------------------------------------------------

  #newDirectory(mode: number, owner: string, group: string, origin: NodeOrigin): MemoryDirectory {
    const now = this.#clock();
    return {
      kind: 'directory',
      children: new Map(),
      mode,
      mtime: now,
      ctime: now,
      atime: now,
      birthtime: now,
      owner,
      group,
      origin,
    };
  }

  #newFile(data: Uint8Array, mode: number, owner: string, group: string, origin: NodeOrigin): MemoryFile {
    const now = this.#clock();
    return {
      kind: 'file',
      data,
      mode,
      mtime: now,
      ctime: now,
      atime: now,
      birthtime: now,
      owner,
      group,
      origin,
    };
  }

  // -------------------------------------------------------------------------
  // permissions
  // -------------------------------------------------------------------------

  /** Owner triplet, else group triplet, else other. No root bypass; see the header. */
  #can(node: MemoryNode, permission: Permission): boolean {
    const shift = node.owner === this.#user ? 6 : node.group === this.#group ? 3 : 0;
    const bit = permission === 'read' ? 0o4 : permission === 'write' ? 0o2 : 0o1;
    return ((node.mode >> shift) & bit) !== 0;
  }

  /**
   * Which bit stops the user creating or removing an entry in this directory,
   * or null if none does.
   *
   * POSIX needs BOTH: write to change the directory, and execute (search) to
   * resolve the name being changed. Every call site here used to check only
   * `write`, and a directory at mode 0o644 — writable, NOT searchable — was
   * the result: `writeText` and `copy` happily planted entries in it that
   * `stat` then refused with EACCES and `remove` could not delete, and `mkdir`
   * created the node and THEN returned EACCES from the `stat` it does to build
   * its own return value, which is a mutation reported as a refusal.
   *
   * Write is tested first so every refusal that already said 'write' still
   * says 'write'; 'execute' is only ever reported for the case that used to be
   * allowed by mistake.
   */
  #blocksCreateIn(directory: MemoryDirectory): Permission | null {
    if (!this.#can(directory, 'write')) return 'write';
    if (!this.#can(directory, 'execute')) return 'execute';
    return null;
  }

  // -------------------------------------------------------------------------
  // traversal
  // -------------------------------------------------------------------------

  /**
   * Walk to a node, checking the search bit on every directory crossed.
   *
   * The `execute` bit on a directory is POSIX's "search" permission, and
   * enforcing it at each step rather than only at the target is what makes
   * `/root` at 0o700 actually private: without the per-step check, a path
   * through an unreadable directory to a world-readable file would succeed.
   * v1 needed a separate `firstUnsearchable()` helper for `cd` because its
   * `fsGet` did not check; folding it into the walk means no caller can skip it.
   */
  #walk(path: string, syscall: StorageSyscall): Result<MemoryNode> {
    const segments = splitSegments(path);
    let node: MemoryNode = this.#root;
    let walked = '';

    for (const segment of segments) {
      if (node.kind !== 'directory') return enotdir(path, syscall, walked || '/');
      if (!this.#can(node, 'execute')) return eacces(walked || '/', syscall, 'execute');
      const next = node.children.get(segment);
      walked = `${walked}/${segment}`;
      if (next === undefined) return enoent(path, syscall);
      node = next;
    }
    return ok(node);
  }

  /** The parent directory of `path`, with the same per-step checks. */
  #parent(path: string, syscall: StorageSyscall): Result<MemoryDirectory> {
    const parentPath = dirname(path);
    const found = this.#walk(parentPath, syscall);
    if (!found.ok) return found;
    if (found.value.kind !== 'directory') {
      return enotdir(path, syscall, parentPath);
    }
    return ok(found.value);
  }

  // -------------------------------------------------------------------------
  // stat
  // -------------------------------------------------------------------------

  #stat(node: MemoryNode, path: string): FileStat {
    const links =
      node.kind === 'file'
        ? 1
        : 2 + [...node.children.values()].filter((c) => c.kind === 'directory').length;
    return {
      path,
      name: basename(path),
      kind: node.kind,
      size: node.kind === 'file' ? node.data.byteLength : DIRECTORY_SIZE,
      mode: node.mode,
      mtime: node.mtime,
      ctime: node.ctime,
      birthtime: node.birthtime,
      owner: node.owner,
      group: node.group,
      links,
      origin: node.origin,
    };
  }

  #fault(syscall: StorageSyscall, path: string): Err<StorageError> | null {
    const cause = this.#injectFault(syscall, path);
    if (cause === null) return null;
    return err({ code: 'EIO', path, syscall, message: `backend failure: ${cause}`, cause });
  }

  #guard(path: string, syscall: StorageSyscall): Err<StorageError> | null {
    const fault = this.#fault(syscall, path);
    if (fault !== null) return fault;
    const checked = validatePath(path, syscall);
    if (!checked.ok) return checked;
    // The precondition this backend documents, now enforced. Two in-repo
    // callers broke it with data they had not normalised, and the halves of
    // this class disagreed about the result: reads walk segments literally
    // while dirname/basename apply `..`, so writeText('/a/../b/t') succeeded
    // and landed at /b/t while stat of the same string said ENOENT.
    const normalised = requireNormalisedPath(path, syscall);
    if (!normalised.ok) return normalised;
    return null;
  }

  #guardWrite(path: string, syscall: StorageSyscall): Err<StorageError> | null {
    const guarded = this.#guard(path, syscall);
    if (guarded !== null) return guarded;
    if (this.readOnly) {
      return err({
        code: 'EROFS',
        path,
        syscall,
        message: `read-only file system: ${this.name}`,
        mount: this.name,
      });
    }
    return null;
  }

  async stat(path: string): Promise<Result<FileStat>> {
    const guarded = this.#guard(path, 'stat');
    if (guarded !== null) return guarded;
    const found = this.#walk(path, 'stat');
    if (!found.ok) return found;
    return ok(this.#stat(found.value, path));
  }

  async exists(path: string): Promise<boolean> {
    const found = this.#walk(path, 'stat');
    return found.ok;
  }

  async access(path: string, permission: Permission): Promise<Result<void>> {
    const guarded = this.#guard(path, 'stat');
    if (guarded !== null) return guarded;
    const found = this.#walk(path, 'stat');
    if (!found.ok) return found;
    if (!this.#can(found.value, permission)) return eacces(path, 'stat', permission);
    return ok(undefined);
  }

  // -------------------------------------------------------------------------
  // reading
  // -------------------------------------------------------------------------

  async readBytes(path: string): Promise<Result<Uint8Array>> {
    const guarded = this.#guard(path, 'read');
    if (guarded !== null) return guarded;
    const found = this.#walk(path, 'read');
    if (!found.ok) return found;
    if (found.value.kind === 'directory') return eisdir(path, 'read');
    if (!this.#can(found.value, 'read')) return eacces(path, 'read', 'read');
    // A copy, not the stored array: handing out the live buffer would let a
    // caller mutate the file by writing through the view it was given.
    return ok(found.value.data.slice());
  }

  async readText(path: string): Promise<Result<string>> {
    const bytes = await this.readBytes(path);
    if (!bytes.ok) return bytes;
    return ok(DECODER.decode(bytes.value));
  }

  async readdir(path: string): Promise<Result<readonly DirectoryEntry[]>> {
    const guarded = this.#guard(path, 'readdir');
    if (guarded !== null) return guarded;
    const found = this.#walk(path, 'readdir');
    if (!found.ok) return found;
    const node = found.value;
    if (node.kind !== 'directory') return enotdir(path, 'readdir', basename(path));
    if (!this.#can(node, 'read')) return eacces(path, 'readdir', 'read');

    const rows: DirectoryEntry[] = [];
    for (const [name, child] of node.children) {
      rows.push({ name, stat: this.#stat(child, join(path, name)) });
    }
    return ok(rows);
  }

  // -------------------------------------------------------------------------
  // quota
  // -------------------------------------------------------------------------

  /**
   * The authoritative walk. Called after `reset` and `installImage`, which are
   * the only two mutations that do not go through `#apply`, and by the test
   * that asserts the running total has not drifted from the truth.
   *
   * The loop is not a style preference. `stack.push(...node.children.values())`
   * spreads every child into an argument list, and MEASURED, that is
   * `RangeError: Maximum call stack size exceeded` at 130k entries in one
   * directory — an exception thrown straight out of `quota()`, whose signature
   * says it returns a `Result`. A directory that wide is reachable: nothing in
   * this backend caps `children.size`.
   */
  #usedBytes(): number {
    let total = 0;
    const stack: MemoryNode[] = [this.#root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) break;
      if (node.kind === 'file') total += node.data.byteLength;
      else for (const child of node.children.values()) stack.push(child);
    }
    return total;
  }

  async quota(): Promise<Result<QuotaUsage>> {
    return ok({
      used: this.#used,
      quota: this.#capacity,
      // The memory backend's bytes are its own. OPFS reports `true` here
      // because it shares the origin quota with IndexedDB and Cache Storage,
      // and a caller that treats the number as OPFS-only will be wrong.
      shared: false,
      persisted: null,
    });
  }

  #checkCapacity(plan: MutationPlan, path: string): Err<StorageError> | null {
    if (this.#capacity === null || plan.byteDelta <= 0) return null;
    const used = this.#used;
    if (used + plan.byteDelta <= this.#capacity) return null;
    return err({
      code: 'ENOSPC',
      path,
      syscall: plan.syscall,
      message: `no space left on device: ${String(used + plan.byteDelta)} > ${String(this.#capacity)}`,
      usage: { used, quota: this.#capacity, shared: false, persisted: null },
    });
  }

  // -------------------------------------------------------------------------
  // the plan / validate / apply cycle
  // -------------------------------------------------------------------------

  /**
   * Journal the plan, apply it, mark it committed.
   *
   * The plan arrives fully validated, so `apply` cannot fail for any reason a
   * caller could have anticipated — which is why the memory backend needs no
   * rollback and no write-ahead log. An OPFS backend replaces `NullJournal`
   * here and nothing else changes; `MutationPlan` is already the record it
   * writes. The full argument is on `MutationPlan` in `types.ts`.
   */
  async #commit<T>(plan: MutationPlan, path: string, value: T): Promise<Result<T>> {
    const space = this.#checkCapacity(plan, path);
    if (space !== null) return space;

    const written = await this.#journal.write(plan);
    if (!written.ok) return written;

    // THE SUSPENSION POINT. The await above is the only gap between the last
    // validation and the first write, and it is the reason every mutating
    // entry point runs under `#serialise` — without it a second operation
    // starts here, mutates the tree, and this plan applies against a shape it
    // never validated against.
    const failed = this.#apply(plan);
    // Deliberately NOT committed on failure: an uncommitted plan is exactly
    // what `journal.pending()` is for, so a durable backend can decide at mount
    // whether to replay or discard it.
    //
    // STATED PLAINLY: a plan that fails PART WAY through apply leaves the tree
    // partially updated. That is not a hole in the atomicity claim, because
    // with the mutex in place a plan can only be stale if it was built against
    // a different tree — which, through this class's public API, cannot
    // happen; every plan is built and applied inside one critical section. The
    // reachable route is a durable journal replaying a plan from a previous
    // process, and cleaning that up is exactly the job the journal exists for.
    // What must never happen, and no longer does, is a THROW: recovery code
    // needs a value it can branch on.
    if (failed !== null) return failed;

    const committed = await this.#journal.commit(plan);
    if (!committed.ok) return committed;
    return ok(value);
  }

  /**
   * Execute a validated plan. Synchronous, and the only writer of `#used`.
   *
   * It RETURNS an `Err` rather than throwing, and that is a change from what
   * this comment used to say. The old version threw on any inconsistency on
   * the grounds that reaching here with a bad step is a planner bug and not a
   * caller's problem. Two things make that wrong:
   *
   *   - it was reachable. Before the mutex, `remove('/d/e')` and `remove('/d')`
   *     in flight together threw `plan referenced a missing node` straight out
   *     of `remove`, whose signature promises a `Result`, having already
   *     applied part of the plan.
   *   - it stays reachable by design. `MutationJournal.pending()` exists so a
   *     durable backend can REPLAY a plan it read back off disk at mount. That
   *     plan was validated against a tree that may no longer exist, and the
   *     recovery path needs an answer it can branch on, not an exception.
   *
   * The refusals below are also the second line against the copy defect: the
   * planner now resolves the existing node at every target path, so a
   * `create-file` can no longer be handed a directory — and if it ever is
   * again, it says so instead of dropping the subtree.
   */
  #apply(plan: MutationPlan): Err<StorageError> | null {
    const now = this.#clock();
    const syscall = plan.syscall;

    for (const step of plan.steps) {
      const parentPath = dirname(step.path);
      const name = basename(step.path);

      if (step.op === 'remove') {
        const parent = this.#locateDirectory(parentPath, syscall);
        if (!parent.ok) return parent;
        const going = parent.value.children.get(name);
        if (going === undefined) return enoent(step.path, syscall);
        if (going.kind === 'file') this.#used -= going.data.byteLength;
        parent.value.children.delete(name);
        parent.value.mtime = now;
        parent.value.ctime = now;
        continue;
      }

      if (step.op === 'move') {
        if (step.from === undefined) {
          return einval(step.path, syscall, `a move step has no source: ${step.path}`, 'move-without-source');
        }
        const sourceParent = this.#locateDirectory(dirname(step.from), syscall);
        if (!sourceParent.ok) return sourceParent;
        const moving = sourceParent.value.children.get(basename(step.from));
        if (moving === undefined) return enoent(step.from, syscall);
        const targetParent = this.#locateDirectory(parentPath, syscall);
        if (!targetParent.ok) return targetParent;
        sourceParent.value.children.delete(basename(step.from));
        sourceParent.value.mtime = now;
        sourceParent.value.ctime = now;
        targetParent.value.children.set(name, moving);
        targetParent.value.mtime = now;
        targetParent.value.ctime = now;
        // ctime, not mtime: a rename changes the inode's metadata, not the
        // file's contents, and `ls -lt` must not reorder on a move. No byte
        // accounting either — a move relocates bytes, it does not add them.
        moving.ctime = now;
        if (step.origin !== undefined) moving.origin = step.origin;
        continue;
      }

      if (step.op === 'create-directory') {
        const parent = this.#locateDirectory(parentPath, syscall);
        if (!parent.ok) return parent;
        const existing = parent.value.children.get(name);
        if (existing !== undefined) {
          // Merging into a directory that is already there is the normal case
          // for `cp -r` and `mkdir -p`, and it keeps the target's own mode.
          // A FILE there is not mergeable and must never be silently kept
          // while the steps below try to create children inside it.
          if (existing.kind !== 'directory') return enotdir(step.path, syscall, name);
          continue;
        }
        parent.value.children.set(
          name,
          this.#newDirectory(
            step.mode ?? DEFAULT_DIRECTORY_MODE,
            this.#user,
            this.#group,
            step.origin ?? 'user',
          ),
        );
        parent.value.mtime = now;
        parent.value.ctime = now;
        continue;
      }

      if (step.op === 'create-file' || step.op === 'write') {
        const parent = this.#locateDirectory(parentPath, syscall);
        if (!parent.ok) return parent;
        const data = step.data ?? new Uint8Array(0);
        const existing = parent.value.children.get(name);
        if (existing !== undefined) {
          // The defect this refusal closes: the old branch reused the node only
          // when it was a file and otherwise called `children.set(name, file)`,
          // which replaced a whole destination DIRECTORY with a file and
          // returned ok. MEASURED, GNU coreutils 8.32 refuses the same shape:
          //   cp: cannot overwrite directory 'dst/x' with non-directory
          if (existing.kind !== 'file') return eisdir(step.path, syscall);
          this.#used += data.byteLength - existing.data.byteLength;
          existing.data = data;
          existing.mtime = now;
          existing.ctime = now;
          if (step.origin !== undefined) existing.origin = step.origin;
          continue;
        }
        this.#used += data.byteLength;
        parent.value.children.set(
          name,
          this.#newFile(
            data,
            step.mode ?? DEFAULT_FILE_MODE,
            this.#user,
            this.#group,
            step.origin ?? 'user',
          ),
        );
        parent.value.mtime = now;
        parent.value.ctime = now;
        continue;
      }

      // set-meta
      const found = this.#locateNode(step.path, syscall);
      if (!found.ok) return found;
      const node = found.value;
      if (step.mode !== undefined) {
        node.mode = step.mode;
        node.ctime = now;
      }
      if (step.mtime !== undefined) {
        node.mtime = step.mtime;
        node.atime = step.mtime;
        node.ctime = now;
      }
      if (step.origin !== undefined) node.origin = step.origin;
    }
    return null;
  }

  #locateDirectory(path: string, syscall: StorageSyscall): Result<MemoryDirectory> {
    const node = this.#locateNode(path, syscall);
    if (!node.ok) return node;
    if (node.value.kind !== 'directory') return enotdir(path, syscall, basename(path));
    return ok(node.value);
  }

  /**
   * Walk a plan step's path with no permission checks — the plan already
   * passed them — but with a real answer when the tree has moved underneath.
   */
  #locateNode(path: string, syscall: StorageSyscall): Result<MemoryNode> {
    let node: MemoryNode = this.#root;
    let walked = '';
    for (const segment of splitSegments(path)) {
      if (node.kind !== 'directory') return enotdir(path, syscall, walked || '/');
      const next = node.children.get(segment);
      walked = `${walked}/${segment}`;
      if (next === undefined) return enoent(path, syscall);
      node = next;
    }
    return ok(node);
  }

  // -------------------------------------------------------------------------
  // writing
  // -------------------------------------------------------------------------

  async writeBytes(
    path: string,
    data: Uint8Array,
    options: WriteOptions = {},
  ): Promise<Result<WriteReceipt>> {
    return this.#serialise(() => this.#writeEntry(path, data, options, 'write', false));
  }

  /**
   * NOT `this.writeBytes(...)`. A public entry point takes the mutex, and a
   * public entry point calling another one would wait for a lock its own
   * caller is holding. Every internal route goes to the locked body instead —
   * the same rule applies to `appendText` and to `utimes`, which creates a
   * file and then stamps it.
   */
  async writeText(path: string, text: string, options: WriteOptions = {}): Promise<Result<WriteReceipt>> {
    return this.#serialise(() => this.#writeEntry(path, ENCODER.encode(text), options, 'write', false));
  }

  async appendBytes(
    path: string,
    data: Uint8Array,
    options: WriteOptions = {},
  ): Promise<Result<WriteReceipt>> {
    return this.#serialise(() => this.#writeEntry(path, data, options, 'append', true));
  }

  async appendText(path: string, text: string, options: WriteOptions = {}): Promise<Result<WriteReceipt>> {
    return this.#serialise(() => this.#writeEntry(path, ENCODER.encode(text), options, 'append', true));
  }

  /**
   * The guard runs INSIDE the critical section, not before it. `readOnly` and
   * the path precondition are cheap, but validating outside the lock and
   * mutating inside it is the shape this whole class of defect comes from.
   */
  async #writeEntry(
    path: string,
    data: Uint8Array,
    options: WriteOptions,
    syscall: StorageSyscall,
    append: boolean,
  ): Promise<Result<WriteReceipt>> {
    const guarded = this.#guardWrite(path, syscall);
    if (guarded !== null) return guarded;
    return this.#write(path, data, options, syscall, append);
  }

  async #write(
    path: string,
    data: Uint8Array,
    options: WriteOptions,
    syscall: StorageSyscall,
    append: boolean,
  ): Promise<Result<WriteReceipt>> {
    if (splitSegments(path).length === 0) return eisdir(path, syscall);

    const steps: MutationStep[] = [];
    let byteDelta = data.byteLength;

    const parentPath = dirname(path);
    const parentFound = this.#walk(parentPath, syscall);
    let parent: MemoryDirectory;

    if (!parentFound.ok) {
      if (parentFound.error.code !== 'ENOENT' || options.createParents !== true) {
        return parentFound;
      }
      const made = this.#planMkdirp(parentPath, DEFAULT_DIRECTORY_MODE, options.origin ?? 'user', syscall);
      if (!made.ok) return made;
      steps.push(...made.value.steps);
      // The deepest EXISTING ancestor is where the write permission has to be
      // checked. v1 makes the same point at `deepestExisting()`: creating the
      // intermediate levels first and then checking would let `mkdir -p` build
      // a chain into a directory the user cannot write to.
      const anchor = this.#deepestExisting(parentPath);
      const blocked = this.#blocksCreateIn(anchor.node);
      if (blocked !== null) return eacces(anchor.path, syscall, blocked);
      parent = anchor.node;
    } else {
      if (parentFound.value.kind !== 'directory') return enotdir(path, syscall, parentPath);
      parent = parentFound.value;
    }

    const name = basename(path);
    const existing = steps.length > 0 ? undefined : parent.children.get(name);

    if (existing !== undefined) {
      if (existing.kind === 'directory') return eisdir(path, syscall);
      if (options.exclusive === true) return eexist(path, syscall, 'file');
      if (!this.#can(existing, 'write')) return eacces(path, syscall, 'write');
      const next = append ? concat(existing.data, data) : data;
      byteDelta = next.byteLength - existing.data.byteLength;
      // WRITING CONTENT TO A SEED FILE MAKES IT THE USER'S.
      //
      // Without this the node keeps `origin: 'seed'`, and the seed/overlay
      // contract then throws the edit away: `createSnapshot` records a seed
      // node's metadata and NOT its content (the next boot is supposed to
      // rebuild it), the overlay restore applies mode and mtime only, and
      // `installImage` puts the original bytes back. MEASURED end to end — a
      // visitor's rewrite of their own `~/README.md` was gone after one
      // reload, with `failures: []` and nothing reported.
      //
      // `vfs.ts` enumerates the graft rules and names ONE limitation of this
      // model — deleting a seed file does not persist, because the overlay
      // records what exists and not what was removed. Losing an EDIT is not on
      // that list and was never a decision; the rule it comes from ("a seed
      // file's content comes from this version of the seed") is about the site
      // updating README.md, not about the user having rewritten it.
      //
      // Only content does this. `chmod` and `utimes` go through `set-meta` and
      // leave origin alone, which is what keeps a seed file's mode change
      // recordable as the small `s: 1` overlay entry it should be. An explicit
      // `options.origin` still wins, because that is how `restoreSnapshot`
      // puts a node back as the seed node it was.
      const origin = options.origin ?? (existing.origin === 'seed' ? 'user' : undefined);
      steps.push({
        op: 'write',
        path,
        data: next,
        ...(origin === undefined ? {} : { origin }),
      });
      const plan: MutationPlan = { id: this.#nextPlanId(), syscall, steps, byteDelta };
      return this.#commit(plan, path, { path, size: next.byteLength, created: false });
    }

    const blocksParent = this.#blocksCreateIn(parent);
    if (blocksParent !== null) return eacces(parentPath, syscall, blocksParent);
    steps.push({
      op: 'create-file',
      path,
      data,
      mode: options.mode ?? DEFAULT_FILE_MODE,
      origin: options.origin ?? 'user',
    });
    const plan: MutationPlan = { id: this.#nextPlanId(), syscall, steps, byteDelta };
    return this.#commit(plan, path, { path, size: data.byteLength, created: true });
  }

  #deepestExisting(path: string): { node: MemoryDirectory; path: string } {
    let node: MemoryDirectory = this.#root;
    let walked = '';
    for (const segment of splitSegments(path)) {
      const next = node.children.get(segment);
      if (next === undefined || next.kind !== 'directory') break;
      node = next;
      walked = `${walked}/${segment}`;
    }
    return { node, path: walked === '' ? '/' : walked };
  }

  // -------------------------------------------------------------------------
  // mkdir
  // -------------------------------------------------------------------------

  #planMkdirp(
    path: string,
    mode: number,
    origin: NodeOrigin,
    syscall: StorageSyscall,
  ): Result<MutationPlan> {
    const segments = splitSegments(path);
    const steps: MutationStep[] = [];
    let node: MemoryNode = this.#root;
    let walked = '';
    let creating = false;

    for (const segment of segments) {
      walked = `${walked}/${segment}`;
      if (creating) {
        steps.push({ op: 'create-directory', path: walked, mode, origin });
        continue;
      }
      if (node.kind !== 'directory') return enotdir(path, syscall, walked);
      if (!this.#can(node, 'execute')) return eacces(walked, syscall, 'execute');
      const next = node.children.get(segment);
      if (next === undefined) {
        if (!this.#can(node, 'write')) {
          return eacces(dirname(walked), syscall, 'write');
        }
        creating = true;
        steps.push({ op: 'create-directory', path: walked, mode, origin });
        continue;
      }
      if (next.kind !== 'directory') return enotdir(path, syscall, walked);
      node = next;
    }
    return ok({ id: this.#nextPlanId(), syscall, steps, byteDelta: 0 });
  }

  async mkdir(path: string, options: MkdirOptions = {}): Promise<Result<FileStat>> {
    return this.#serialise(() => this.#mkdirLocked(path, options));
  }

  async #mkdirLocked(path: string, options: MkdirOptions): Promise<Result<FileStat>> {
    const guarded = this.#guardWrite(path, 'mkdir');
    if (guarded !== null) return guarded;

    const mode = options.mode ?? DEFAULT_DIRECTORY_MODE;
    const origin = options.origin ?? 'user';

    if (options.recursive === true) {
      const plan = this.#planMkdirp(path, mode, origin, 'mkdir');
      if (!plan.ok) return plan;
      const done = await this.#commit(plan.value, path, undefined);
      if (!done.ok) return done;
      return this.stat(path);
    }

    const existing = this.#walk(path, 'mkdir');
    if (existing.ok) return eexist(path, 'mkdir', existing.value.kind);

    const parent = this.#parent(path, 'mkdir');
    if (!parent.ok) return parent;
    const blocked = this.#blocksCreateIn(parent.value);
    if (blocked !== null) return eacces(dirname(path), 'mkdir', blocked);

    const plan: MutationPlan = {
      id: this.#nextPlanId(),
      syscall: 'mkdir',
      steps: [{ op: 'create-directory', path, mode, origin }],
      byteDelta: 0,
    };
    const done = await this.#commit(plan, path, undefined);
    if (!done.ok) return done;
    return this.stat(path);
  }

  // -------------------------------------------------------------------------
  // remove
  // -------------------------------------------------------------------------

  async remove(path: string, options: RemoveOptions = {}): Promise<Result<void>> {
    return this.#serialise(() => this.#removeLocked(path, options));
  }

  async #removeLocked(path: string, options: RemoveOptions): Promise<Result<void>> {
    const guarded = this.#guardWrite(path, 'remove');
    if (guarded !== null) return guarded;
    if (splitSegments(path).length === 0) {
      return einval(path, 'remove', 'refusing to remove the mount root', 'remove-root');
    }

    const found = this.#walk(path, 'remove');
    if (!found.ok) {
      if (found.error.code === 'ENOENT' && options.force === true) return ok(undefined);
      return found;
    }
    const node = found.value;

    if (node.kind === 'directory' && node.children.size > 0 && options.recursive !== true) {
      return err({
        code: 'ENOTEMPTY',
        path,
        syscall: 'remove',
        message: `directory not empty: ${path}`,
        entries: node.children.size,
      });
    }

    const parent = this.#parent(path, 'remove');
    if (!parent.ok) return parent;
    const blocked = this.#blocksCreateIn(parent.value);
    if (blocked !== null) return eacces(dirname(path), 'remove', blocked);

    // Children before parents, so a journal replaying front-to-back after a
    // crash never tries to delete a directory that still has entries.
    const steps: MutationStep[] = [];
    let byteDelta = 0;
    const collect = (current: MemoryNode, currentPath: string): Err<StorageError> | null => {
      if (current.kind === 'directory') {
        if (!this.#can(current, 'write') || !this.#can(current, 'execute')) {
          return eacces(currentPath, 'remove', 'write');
        }
        for (const [name, child] of current.children) {
          const failure = collect(child, join(currentPath, name));
          if (failure !== null) return failure;
        }
      } else {
        byteDelta -= current.data.byteLength;
      }
      steps.push({ op: 'remove', path: currentPath });
      return null;
    };
    const failure = collect(node, path);
    if (failure !== null) return failure;

    return this.#commit({ id: this.#nextPlanId(), syscall: 'remove', steps, byteDelta }, path, undefined);
  }

  // -------------------------------------------------------------------------
  // rename and copy
  // -------------------------------------------------------------------------

  async rename(from: string, to: string, options: RenameOptions = {}): Promise<Result<void>> {
    return this.#serialise(() => this.#renameLocked(from, to, options));
  }

  async #renameLocked(from: string, to: string, options: RenameOptions): Promise<Result<void>> {
    const guarded = this.#guardWrite(from, 'rename');
    if (guarded !== null) return guarded;
    const guardedTo = this.#guardWrite(to, 'rename');
    if (guardedTo !== null) return guardedTo;
    if (from === to) return ok(undefined);

    const source = this.#walk(from, 'rename');
    if (!source.ok) return source;

    if (isDescendant(to, from)) {
      // MEASURED: pwsh 7.6.5 reports MoveItemArgumentError / InvalidArgument
      // for `Move-Item dir dir\inner`, so a guard here matches. Copy-Item does
      // NOT guard the same shape — `Copy-Item dir dir\inner -Recurse` recursed
      // until the probe had to be killed — which is why `copy` below guards it
      // too rather than following the reference implementation off a cliff.
      return einval(to, 'rename', 'cannot move a directory into itself', 'into-self');
    }

    const destinationParent = this.#parent(to, 'rename');
    if (!destinationParent.ok) return destinationParent;
    const blocksTo = this.#blocksCreateIn(destinationParent.value);
    if (blocksTo !== null) return eacces(dirname(to), 'rename', blocksTo);

    const sourceParent = this.#parent(from, 'rename');
    if (!sourceParent.ok) return sourceParent;
    const blocksFrom = this.#blocksCreateIn(sourceParent.value);
    if (blocksFrom !== null) return eacces(dirname(from), 'rename', blocksFrom);

    const existing = destinationParent.value.children.get(basename(to));
    if (existing !== undefined) {
      if (options.overwrite !== true) return eexist(to, 'rename', existing.kind);
      // POSIX rename() refuses a type mismatch even with an overwrite, and it
      // is right to: silently replacing a directory with a file destroys the
      // directory's contents with no way back.
      if (existing.kind !== source.value.kind) {
        return existing.kind === 'directory' ? eisdir(to, 'rename') : enotdir(to, 'rename', basename(to));
      }
      if (existing.kind === 'directory' && existing.children.size > 0) {
        return err({
          code: 'ENOTEMPTY',
          path: to,
          syscall: 'rename',
          message: `directory not empty: ${to}`,
          entries: existing.children.size,
        });
      }
    }

    // One `move` step, not a remove plus a create: splitting it would reset
    // birthtime, and a journal replaying the halves separately could leave the
    // node in neither place. Routed through the same commit path as every other
    // mutation so the OPFS attachment point stays a single call.
    const steps: MutationStep[] = [];
    if (existing !== undefined) steps.push({ op: 'remove', path: to });
    // `origin: 'user'`, for the third time and the same reason as `#write` and
    // the copy planner. `#apply`'s move branch relocates the node object, so a
    // renamed SEED file stayed marked seed — and was then recorded in the
    // overlay as `s: 1` with no content, and dropped on the next boot.
    // MEASURED: `mv ~/README.md ~/README.bak` and one reload left README.bak
    // ENOENT and `~/projects` back where it started, so the move did not even
    // stick. A renamed seed DIRECTORY was worse in a quieter way: it survived
    // only as a side effect of its children being restored with
    // `createParents: true`, losing its own mode and mtime, and vanished
    // outright when it was empty. A move is a user action whatever it moves.
    steps.push({ op: 'move', path: to, from, origin: 'user' });
    return this.#commit({ id: this.#nextPlanId(), syscall: 'rename', steps, byteDelta: 0 }, to, undefined);
  }

  async copy(from: string, to: string, options: CopyOptions = {}): Promise<Result<void>> {
    return this.#serialise(() => this.#copyLocked(from, to, options));
  }

  async #copyLocked(from: string, to: string, options: CopyOptions): Promise<Result<void>> {
    const guarded = this.#guardWrite(from, 'copy');
    if (guarded !== null) return guarded;
    const guardedTo = this.#guardWrite(to, 'copy');
    if (guardedTo !== null) return guardedTo;

    const source = this.#walk(from, 'copy');
    if (!source.ok) return source;
    if (from === to) {
      return einval(to, 'copy', 'source and destination are the same path', 'same-path');
    }
    if (isDescendant(to, from)) {
      return einval(to, 'copy', 'cannot copy a directory into itself', 'into-self');
    }
    if (source.value.kind === 'directory' && options.recursive !== true) {
      return eisdir(from, 'copy');
    }

    const destinationParent = this.#parent(to, 'copy');
    if (!destinationParent.ok) return destinationParent;
    const blocksDestination = this.#blocksCreateIn(destinationParent.value);
    if (blocksDestination !== null) return eacces(dirname(to), 'copy', blocksDestination);

    const existing = destinationParent.value.children.get(basename(to));
    if (existing !== undefined && options.overwrite !== true) {
      return eexist(to, 'copy', existing.kind);
    }
    // The top-level kind check that used to live here is GONE, and deliberately.
    // It only ever guarded the destination ROOT, so `copy('/src', '/dst')` with
    // a file at `/src/x` and a directory at `/dst/x` sailed past it: the
    // recursive planner emitted `create-file /dst/x` without asking what was
    // already there, and `#apply` replaced the directory — subtree and all —
    // with a 16-byte file, and returned ok. Deleting that check killed zero
    // tests, which is what a guard applied at one level out of N is worth. The
    // planner below now resolves the existing node at EVERY target path,
    // including the root, and produces exactly the codes the old check did.

    // PLAN, then VALIDATE, then APPLY. A copy that fails on its ninth file must
    // leave the destination exactly as it was; building the whole plan first is
    // what guarantees that without a rollback path. See `MutationPlan`.
    //
    // MEASURED, GNU coreutils 8.32 — this is where the semantics come from:
    //   $ cp -r src/. dst/     # src/x is a file, dst/x is a directory
    //   cp: cannot overwrite directory 'dst/./x' with non-directory
    //   $ cp -r src/. dst/     # src/zzz is a directory, dst/zzz is a file
    //   cp: cannot overwrite non-directory 'dst/./zzz' with directory 'src/./zzz'
    // Both exit 1, and `cp -rf` gives the identical refusal — there is no flag
    // that turns either case into a remove-then-create. So the planner REFUSES;
    // it does not plan a `remove` first.
    //
    // Where this backend is deliberately STRONGER than the reference: GNU cp is
    // best-effort per file, and in the second transcript it had already created
    // `dst/aaa` before it reached `zzz`. Refusing during PLANNING means no step
    // is applied at all, which is the atomicity `MutationPlan` promises.
    const steps: MutationStep[] = [];
    let byteDelta = 0;
    const plan = (
      node: MemoryNode,
      sourcePath: string,
      targetPath: string,
      target: MemoryNode | undefined,
    ): Err<StorageError> | null => {
      // The planner BUILDS these paths, so `#guardWrite` on `to` does not
      // bound them: copying a 2040-deep tree under a long destination name
      // produced a 4201-character path — past PATH_MAX — and created a node
      // that `stat` then refused with ENAMETOOLONG and nothing could reach.
      // The component names come from nodes that already passed NAME_MAX, so
      // the total length is the only thing that can newly overflow.
      if (targetPath.length > PATH_MAX) return enametoolong(targetPath, 'copy', PATH_MAX);
      if (node.kind === 'file') {
        if (!this.#can(node, 'read')) return eacces(sourcePath, 'copy', 'read');
        if (target !== undefined) {
          if (target.kind === 'directory') return eisdir(targetPath, 'copy');
          // MEASURED: `chmod 0444 ro && cp src ro` is
          //   cp: cannot create regular file 'ro': Permission denied
          // `writeText` already refused this; `copy` was the one write path
          // that overwrote a read-only file and reported ok.
          if (!this.#can(target, 'write')) return eacces(targetPath, 'copy', 'write');
          // NET bytes. Charging the gross made a copy that replaces a 40-byte
          // file with another 40-byte file report ENOSPC "120 > 100" on a disk
          // whose occupancy does not move.
          byteDelta -= target.data.byteLength;
        }
        // `origin: 'user'` EXPLICITLY, not left to `#apply`'s default.
        //
        // `#apply` only overrides an existing node's origin when the step
        // carries one, so a copy onto a SEED file left it marked seed — and
        // then the seed/overlay contract threw the user's data away exactly as
        // it did for `writeText` before that was fixed. MEASURED: after
        // `cp ~/mine.md ~/README.md` and one reload, the file was back to the
        // seed's text, `failures: []`. A copy is a user action whatever it
        // lands on; a NEW target already became 'user' through the default, so
        // this only changes the overwrite case and makes the two agree.
        steps.push({
          op: 'create-file',
          path: targetPath,
          data: node.data.slice(),
          mode: node.mode,
          origin: 'user',
        });
        byteDelta += node.data.byteLength;
        return null;
      }
      if (!this.#can(node, 'read') || !this.#can(node, 'execute')) {
        return eacces(sourcePath, 'copy', 'read');
      }
      if (target !== undefined) {
        if (target.kind !== 'directory') return enotdir(targetPath, 'copy', basename(targetPath));
        // Looking at what the destination already holds is a directory search,
        // and adding an entry to it is a write — the pair `#blocksCreateIn`
        // enforces everywhere else. An earlier version of this comment claimed
        // `#write` and `mkdir` already checked both bits and that only `copy`
        // did not. That was FALSE when it was written: none of the three
        // checked execute, so all three could plant an entry in a directory
        // the user cannot enter, and only `copy` was being fixed. They all
        // check it now, which is what makes the sentence above true.
        if (!this.#can(target, 'execute')) return eacces(targetPath, 'copy', 'execute');
        let addsEntry = false;
        for (const name of node.children.keys()) {
          if (!target.children.has(name)) {
            addsEntry = true;
            break;
          }
        }
        if (addsEntry && !this.#can(target, 'write')) return eacces(targetPath, 'copy', 'write');
      }
      steps.push({ op: 'create-directory', path: targetPath, mode: node.mode });
      for (const [name, child] of node.children) {
        const failure = plan(
          child,
          join(sourcePath, name),
          join(targetPath, name),
          target === undefined ? undefined : target.children.get(name),
        );
        if (failure !== null) return failure;
      }
      return null;
    };
    const failure = plan(source.value, from, to, existing);
    if (failure !== null) return failure;

    return this.#commit({ id: this.#nextPlanId(), syscall: 'copy', steps, byteDelta }, to, undefined);
  }

  // -------------------------------------------------------------------------
  // metadata
  // -------------------------------------------------------------------------

  async chmod(path: string, mode: number): Promise<Result<FileStat>> {
    return this.#serialise(() => this.#chmodLocked(path, mode));
  }

  async #chmodLocked(path: string, mode: number): Promise<Result<FileStat>> {
    const guarded = this.#guardWrite(path, 'chmod');
    if (guarded !== null) return guarded;
    const found = this.#walk(path, 'chmod');
    if (!found.ok) return found;
    // Real POSIX requires ownership, not the write bit — `chmod` on a file you
    // do not own fails even when the file is world-writable. v1 checks the
    // write bit instead, which lets anyone re-open a directory they were
    // locked out of.
    if (found.value.owner !== this.#user) return eacces(path, 'chmod', 'write');

    const plan: MutationPlan = {
      id: this.#nextPlanId(),
      syscall: 'chmod',
      steps: [{ op: 'set-meta', path, mode }],
      byteDelta: 0,
    };
    const done = await this.#commit(plan, path, undefined);
    if (!done.ok) return done;
    return this.stat(path);
  }

  async utimes(path: string, times: Times, create = true): Promise<Result<FileStat>> {
    return this.#serialise(() => this.#utimesLocked(path, times, create));
  }

  async #utimesLocked(path: string, times: Times, create: boolean): Promise<Result<FileStat>> {
    const guarded = this.#guardWrite(path, 'utimes');
    if (guarded !== null) return guarded;

    const found = this.#walk(path, 'utimes');
    if (!found.ok) {
      if (found.error.code !== 'ENOENT' || !create) return found;
      // `touch` on a missing file creates it. The write goes through the normal
      // path so the parent's permissions and the quota are checked the same way.
      // The locked bodies, not the public methods: this code already holds
      // the mutex, and `this.writeBytes(...)` would queue behind itself.
      const written = await this.#writeEntry(path, new Uint8Array(0), {}, 'write', false);
      if (!written.ok) return written;
      if (times.mtime === undefined) return this.stat(path);
      return this.#utimesLocked(path, times, false);
    }

    if (!this.#can(found.value, 'write') && found.value.owner !== this.#user) {
      return eacces(path, 'utimes', 'write');
    }
    const mtime = times.mtime ?? this.#clock();
    const plan: MutationPlan = {
      id: this.#nextPlanId(),
      syscall: 'utimes',
      steps: [{ op: 'set-meta', path, mtime }],
      byteDelta: 0,
    };
    const done = await this.#commit(plan, path, undefined);
    if (!done.ok) return done;
    return this.stat(path);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * The cap on every link of the mutex chain. One operation's rejection must not
 * become every later operation's rejection — the caller of the failing call
 * still sees it, through the promise `#serialise` hands back.
 */
function noop(): void {}

function join(directory: string, name: string): string {
  return directory === '/' ? `/${name}` : `${directory}/${name}`;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.byteLength + right.byteLength);
  out.set(left, 0);
  out.set(right, left.byteLength);
  return out;
}

