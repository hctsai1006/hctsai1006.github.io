/**
 * opfs.ts — the durable `StorageBackend`, the leader election, and the mount.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS DELEGATES TO `MemoryStorage` INSTEAD OF REIMPLEMENTING POSIX
 * ---------------------------------------------------------------------------
 *
 * `OpfsStorage` holds a `MemoryStorage` and forwards every method to it. That
 * looks like a shortcut and is the opposite of one.
 *
 * What a filesystem MEANS — which condition is ENOTDIR and which is ENOENT,
 * whether `cp -r` onto a file refuses or clobbers, when a directory's mtime
 * moves, what a permission triplet computes, that a plan is validated before a
 * byte is written — is decided in `memory.ts` and pinned by the storage suite,
 * including every test in `tests/unit/storage-regressions.test.mts`, each proved
 * load-bearing by reverting its fix and watching it go red.
 * Every one of those decisions has to hold in the browser too. There are
 * exactly two ways to get that: write them again in this file and hope the two
 * agree, or have one implementation. `memory.ts` says which was chosen, and it
 * said so before this file existed: "Everything the eventual OPFS backend has
 * to get right is decided here first, where it can be tested deterministically
 * … Getting those wrong inside a worker, behind a postMessage boundary, is a
 * much worse place to find out."
 *
 * So this class adds exactly one thing: DURABILITY. It is the difference
 * between the tree existing until the tab closes and existing until the user
 * clears site data. Everything else it forwards.
 *
 * THE COST, stated because it is a real limit and not a detail. The working set
 * lives in memory; OPFS holds a checkpoint and a log, not a mirrored tree. A
 * filesystem larger than the tab's heap will not fit. `types.ts` already
 * commits the whole layer to that shape — "Commands read and write whole files
 * … Nothing streams yet" — so this is the existing limit rather than a new one,
 * but a future streaming backend is a different `StorageBackend`, not a bigger
 * version of this one. See `opfs-store.ts` for the disk layout and the two
 * MEASURED platform facts (name mangling, per-file locking) that ruled out the
 * mirrored tree.
 *
 * ---------------------------------------------------------------------------
 * TWO TABS
 * ---------------------------------------------------------------------------
 *
 * PR-09's acceptance criterion is "two tabs cannot corrupt the tree", and there
 * are two mechanisms here, doing different jobs:
 *
 *   THE PLATFORM'S, which is the one safety rests on. A `FileSystemSyncAccess
 *   Handle` takes an exclusive lock on the file entry, and this store holds one
 *   on each of its files for its whole life. MEASURED: a second tab's worker
 *   asking for the same file gets `NoModificationAllowedError`. It needs no
 *   cooperation from the other tab, which matters because a crashed or hostile
 *   tab does not cooperate.
 *
 *   WEB LOCKS, which makes the refusal ORDERLY. A tab that asks for the leader
 *   lock with `ifAvailable` and gets null KNOWS it is a follower before it
 *   touches anything, and can mount read-only and say so, instead of finding
 *   out through an exception halfway through boot. MEASURED across two real
 *   tabs: the second one's request returned null while the first held it, and
 *   `query().held` named the holder.
 *
 * Web Locks and not SharedWorker for the election, deliberately and on the
 * roadmap's own evidence: Web Locks has been available across browsers since
 * March 2022, SharedWorker only became Baseline "newly available" in May 2026
 * and is still absent on Samsung Internet and Opera Mobile. SharedWorker is
 * used for COORDINATION where it exists — telling other tabs the store moved —
 * and never for correctness. See `createCoordinator`.
 */

import { MemoryStorage } from './memory.ts';
import { importSnapshot } from './snapshot.ts';
import { err, ok } from './types.ts';
import type {
  CopyOptions,
  DirectoryEntry,
  FileStat,
  MkdirOptions,
  MutationPlan,
  Permission,
  QuotaUsage,
  RemoveOptions,
  RenameOptions,
  Result,
  SeedSpec,
  StorageBackend,
  StorageError,
  Times,
  WriteOptions,
  WriteReceipt,
} from './types.ts';
import { OpfsStore, readFollowerView } from './opfs-store.ts';
import type { OpfsStoreOptions, RecoveryReport } from './opfs-store.ts';
import type { OpfsDirectory, OpfsStorageManager } from './opfs-platform.ts';
import { UNKNOWN_USAGE } from './opfs-platform.ts';

// ---------------------------------------------------------------------------
// quota
// ---------------------------------------------------------------------------

/**
 * What a caller is told when the store is getting close to the ceiling.
 *
 * PR-09 task 9.6 is "surface quota via navigator.storage.estimate() and warn
 * before the ceiling", and the risk it names is that "OPFS is deleted on
 * site-data clear with no warning from the browser". So the warning has to be
 * actionable, which means it has to carry the numbers and it has to arrive
 * BEFORE the write that fails, not as the failure.
 */
export interface QuotaWarning {
  readonly used: number;
  readonly quota: number;
  /** `used / quota`, between 0 and 1. */
  readonly fraction: number;
  /** The threshold that was crossed. */
  readonly threshold: number;
}

/**
 * Fraction of the origin quota at which the warning fires. 0.9.
 *
 * A number and not a byte count because the quota is not a constant: MEASURED
 * at 10,737,425,705 bytes in one Chromium profile, and the Storage Standard
 * says outright that "the storage usage of a storage shelf is an
 * implementation-defined rough estimate". A fixed byte threshold would be most
 * of the disk on one machine and unreachable on another.
 */
export const DEFAULT_QUOTA_WARNING_THRESHOLD = 0.9;

// ---------------------------------------------------------------------------
// leader election
// ---------------------------------------------------------------------------

/** The part of `LockManager` this uses. Narrow, so a test can supply one. */
export interface LockManagerLike {
  request(
    name: string,
    options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<unknown> | unknown,
  ): Promise<unknown>;
}

export interface Leadership {
  readonly granted: boolean;
  /** Give the lock back. Safe to call twice. */
  release(): void;
  /** Resolves when the lock is actually released, for a test that must wait. */
  readonly done: Promise<void>;
}

/** The lock name. One per origin; the store is per origin. */
export const LEADER_LOCK = 'browsershell-storage-leader';

/**
 * Ask for the leader lock without waiting for it.
 *
 * `ifAvailable: true`, which the Web Locks spec defines as: when the lock
 * cannot be granted immediately, "invoke callback with null as the only
 * argument" rather than queueing. MEASURED in Chromium 152 both ways — the
 * callback received a `Lock` when free and `null` when another tab held it —
 * and across two real browser tabs.
 *
 * NOT `steal: true`, ever. Stealing exists for a supervisor reclaiming a lock
 * from a wedged holder, and here the holder is a tab that is very likely alive
 * and has three sync access handles open. Stealing the lock would not take the
 * handles away — the platform lock is the real one — so it would produce a
 * second "leader" that cannot write, which is strictly worse than knowing you
 * are a follower. MEASURED: a lock held by a worker is released when that
 * worker is terminated, so a genuinely dead holder frees it without help.
 */
export async function requestLeadership(
  locks: LockManagerLike,
  name: string = LEADER_LOCK,
): Promise<Leadership> {
  let releaseHeld: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });

  let settle: (granted: boolean) => void = () => {};
  const decided = new Promise<boolean>((resolve) => {
    settle = resolve;
  });

  const done = locks
    .request(name, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      if (lock === null) {
        settle(false);
        return;
      }
      settle(true);
      // Holding the lock for as long as this promise is unresolved is the
      // documented way to hold a Web Lock; there is no `lock.release()`.
      await held;
    })
    .then(
      () => undefined,
      () => {
        // A rejected request still has to settle the decision, or a caller
        // awaits `granted` forever. The lock was not granted either way.
        settle(false);
      },
    );

  const granted = await decided;
  let released = false;
  return {
    granted,
    release: (): void => {
      if (released) return;
      released = true;
      releaseHeld();
    },
    done,
  };
}

// ---------------------------------------------------------------------------
// coordination
// ---------------------------------------------------------------------------

/**
 * "The store moved" told to the other tabs. NEVER a correctness mechanism.
 *
 * A follower cannot write — the platform stops it — so the worst a missed
 * message costs is a stale read-only view until the user reloads. That is why
 * every implementation here is allowed to be absent: `NullCoordinator` is a
 * complete, correct implementation for a browser with neither SharedWorker nor
 * BroadcastChannel.
 */
export interface StorageCoordinator {
  announce(message: StorageAnnouncement): void;
  onAnnouncement(listener: (message: StorageAnnouncement) => void): void;
  close(): void;
  /** Which transport this is, for diagnostics and for the tests. */
  readonly transport: 'shared-worker' | 'broadcast-channel' | 'none';
}

export interface StorageAnnouncement {
  readonly kind: 'checkpoint' | 'leadership-released' | 'reset';
  /** The checkpoint generation after the event. */
  readonly generation: number;
}

class NullCoordinator implements StorageCoordinator {
  readonly transport = 'none' as const;
  announce(): void {}
  onAnnouncement(): void {}
  close(): void {}
}

class ChannelCoordinator implements StorageCoordinator {
  readonly transport: 'shared-worker' | 'broadcast-channel';
  readonly #post: (message: StorageAnnouncement) => void;
  readonly #subscribe: (listener: (message: StorageAnnouncement) => void) => void;
  readonly #close: () => void;

  constructor(parts: {
    transport: 'shared-worker' | 'broadcast-channel';
    post: (message: StorageAnnouncement) => void;
    subscribe: (listener: (message: StorageAnnouncement) => void) => void;
    close: () => void;
  }) {
    this.transport = parts.transport;
    this.#post = parts.post;
    this.#subscribe = parts.subscribe;
    this.#close = parts.close;
  }

  announce(message: StorageAnnouncement): void {
    this.#post(message);
  }

  onAnnouncement(listener: (message: StorageAnnouncement) => void): void {
    this.#subscribe(listener);
  }

  close(): void {
    this.#close();
  }
}

export interface CoordinatorOptions {
  /**
   * URL of the SharedWorker script. When absent, or when SharedWorker is not
   * available, the BroadcastChannel fallback is used; when that is absent too,
   * nothing is.
   *
   * MEASURED: SharedWorker exists in Chromium 152. The roadmap records that it
   * is absent on Samsung Internet and Opera Mobile and only became Baseline
   * "newly available" in May 2026, which is why the fallback is not dead code.
   */
  readonly sharedWorkerUrl?: string | URL;
  readonly channelName?: string;
}

/**
 * Pick the best available transport, preferring SharedWorker where the caller
 * supplied a script for one.
 *
 * The preference order is the roadmap's ("use SharedWorker for coordination
 * where available"), not a performance judgement: a SharedWorker can hold
 * per-origin state that a BroadcastChannel cannot, which is what a future
 * coordinator will want. For the one message kind that exists today the two are
 * equivalent.
 */
export function createCoordinator(options: CoordinatorOptions = {}): StorageCoordinator {
  const name = options.channelName ?? 'browsershell-storage';
  const url = options.sharedWorkerUrl;

  if (url !== undefined && typeof SharedWorker !== 'undefined') {
    try {
      const worker = new SharedWorker(url, { name });
      const listeners: ((message: StorageAnnouncement) => void)[] = [];
      worker.port.onmessage = (event: MessageEvent): void => {
        for (const listener of listeners) listener(event.data as StorageAnnouncement);
      };
      worker.port.start();
      return new ChannelCoordinator({
        transport: 'shared-worker',
        post: (message): void => {
          worker.port.postMessage(message);
        },
        subscribe: (listener): void => {
          listeners.push(listener);
        },
        close: (): void => {
          worker.port.close();
        },
      });
    } catch {
      // Fall through. A SharedWorker that will not construct — a blocked
      // script, a browser that has the constructor but refuses it in this
      // context — must not stop the store mounting, because coordination is
      // never what makes the store safe.
    }
  }

  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(name);
    return new ChannelCoordinator({
      transport: 'broadcast-channel',
      post: (message): void => {
        channel.postMessage(message);
      },
      subscribe: (listener): void => {
        channel.addEventListener('message', (event: MessageEvent): void => {
          listener(event.data as StorageAnnouncement);
        });
      },
      close: (): void => {
        channel.close();
      },
    });
  }

  return new NullCoordinator();
}

// ---------------------------------------------------------------------------
// the backend
// ---------------------------------------------------------------------------

export interface OpfsStorageOptions {
  /**
   * Absent for a FOLLOWER, which holds no handles and has nothing to
   * checkpoint. Every method that would reach the store is behind `readOnly`,
   * and the two that are not -- `checkpoint` and `sync` -- refuse explicitly
   * rather than being handed an inert object to call methods on.
   */
  readonly store?: OpfsStore;
  readonly memory: MemoryStorage;
  /** `navigator.storage`. Absent means quota is reported as unknown. */
  readonly manager?: OpfsStorageManager;
  readonly seed?: SeedSpec;
  readonly clock: () => number;
  readonly threshold?: number;
  readonly onQuotaWarning?: (warning: QuotaWarning) => void;
  readonly coordinator?: StorageCoordinator;
  readonly name?: string;
  /**
   * Refuse every mutation with EROFS. What a FOLLOWER mounts as.
   *
   * A separate flag from `MemoryStorage`'s own `readOnly`, because the tree
   * underneath has to be WRITABLE for the mount to graft the recovered overlay
   * onto it — `restoreSnapshot` goes through the ordinary write API, on purpose
   * (a snapshot is a file someone can hand you, and a restore that bypassed the
   * permission checks would let a crafted one write into `/etc`). So the
   * read-only-ness belongs to this wrapper, which is what a command holds, and
   * `MountReport.memory` is documented as being for reads.
   */
  readonly readOnly?: boolean;
}

/**
 * A `StorageBackend` whose tree survives the tab.
 *
 * Every read is the memory backend's, unchanged. Every mutation is the memory
 * backend's, and then a decision about whether the log has grown enough to be
 * worth folding into a checkpoint.
 */
export class OpfsStorage implements StorageBackend {
  readonly name: string;
  readonly readOnly: boolean;

  readonly #memory: MemoryStorage;
  readonly #store: OpfsStore | null;
  readonly #manager: OpfsStorageManager | null;
  readonly #seed: SeedSpec | undefined;
  readonly #clock: () => number;
  readonly #threshold: number;
  readonly #warn: (warning: QuotaWarning) => void;
  readonly #coordinator: StorageCoordinator;
  /** Edge-triggered: the warning fires on the crossing, not on every write. */
  #warned = false;

  /**
   * A SECOND mutex, above the one inside `MemoryStorage`, and it is not
   * redundant.
   *
   * `MemoryStorage`'s mutex makes one MUTATION atomic. What has to be atomic
   * here is a mutation AND the checkpoint that may follow it, because a
   * checkpoint exports the whole tree through the async read API — `createSnapshot`
   * awaits between every `readdir` and every `readBytes`. Without this lock a
   * second mutation runs inside that walk, the exported document contains half
   * of it, and then the log is reset to the new generation and the other half
   * is discarded. The result is a checkpoint of a tree that never existed.
   *
   * That is not a hypothetical shape: it is the same defect the memory backend
   * was measured to have before ITS mutex — "two appends to one file lost one,
   * two `exclusive` writes both won" — one layer up and with a durable
   * consequence instead of a transient one.
   *
   * Reads are not serialised, for the reason `memory.ts` gives: routing them
   * through the queue would let a checkpoint deadlock on the export it is
   * performing. The public `checkpoint()` takes this lock; `#after` calls
   * `#checkpointLocked` because it already holds it — the same rule `memory.ts`
   * states as "NOT `this.writeBytes(...)`. A public entry point takes the
   * mutex, and a public entry point calling another one would wait for a lock
   * its own caller is holding."
   *
   * WHAT THIS DOES NOT PROTECT. The `MemoryStorage` handed back by
   * `mountOpfsStorage` is the same object this delegates to. Mutating through
   * it directly bypasses this lock. It is returned for reads, for `replay`
   * during recovery, and for tests; a caller that writes through it has stepped
   * around the durability layer and gets what that implies.
   */
  #queue: Promise<void> = Promise.resolve();

  constructor(options: OpfsStorageOptions) {
    this.#memory = options.memory;
    this.#store = options.store ?? null;
    this.#manager = options.manager ?? null;
    this.#seed = options.seed;
    this.#clock = options.clock;
    this.#threshold = options.threshold ?? DEFAULT_QUOTA_WARNING_THRESHOLD;
    this.#warn = options.onQuotaWarning ?? ((): void => {});
    this.#coordinator = options.coordinator ?? new NullCoordinator();
    this.name = options.name ?? 'opfs';
    this.readOnly = options.readOnly ?? options.memory.readOnly;
  }

  /** The store, or null for a follower. See `OpfsStorageOptions.store`. */
  get store(): OpfsStore | null {
    return this.#store;
  }

  // --- reads: forwarded verbatim ------------------------------------------

  async stat(path: string): Promise<Result<FileStat>> {
    return this.#memory.stat(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.#memory.exists(path);
  }

  async access(path: string, permission: Permission): Promise<Result<void>> {
    return this.#memory.access(path, permission);
  }

  async readBytes(path: string): Promise<Result<Uint8Array>> {
    return this.#memory.readBytes(path);
  }

  async readText(path: string): Promise<Result<string>> {
    return this.#memory.readText(path);
  }

  async readdir(path: string): Promise<Result<readonly DirectoryEntry[]>> {
    return this.#memory.readdir(path);
  }

  // --- mutations: forwarded, then maybe checkpointed ----------------------

  async writeBytes(path: string, data: Uint8Array, options?: WriteOptions): Promise<Result<WriteReceipt>> {
    return this.#durable(() => this.#memory.writeBytes(path, data, options));
  }

  async writeText(path: string, text: string, options?: WriteOptions): Promise<Result<WriteReceipt>> {
    return this.#durable(() => this.#memory.writeText(path, text, options));
  }

  async appendBytes(path: string, data: Uint8Array, options?: WriteOptions): Promise<Result<WriteReceipt>> {
    return this.#durable(() => this.#memory.appendBytes(path, data, options));
  }

  async appendText(path: string, text: string, options?: WriteOptions): Promise<Result<WriteReceipt>> {
    return this.#durable(() => this.#memory.appendText(path, text, options));
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<Result<FileStat>> {
    return this.#durable(() => this.#memory.mkdir(path, options));
  }

  async remove(path: string, options?: RemoveOptions): Promise<Result<void>> {
    return this.#durable(() => this.#memory.remove(path, options));
  }

  async rename(from: string, to: string, options?: RenameOptions): Promise<Result<void>> {
    return this.#durable(() => this.#memory.rename(from, to, options));
  }

  async copy(from: string, to: string, options?: CopyOptions): Promise<Result<void>> {
    return this.#durable(() => this.#memory.copy(from, to, options));
  }

  async chmod(path: string, mode: number): Promise<Result<FileStat>> {
    return this.#durable(() => this.#memory.chmod(path, mode));
  }

  async utimes(path: string, times: Times, create?: boolean): Promise<Result<FileStat>> {
    return this.#durable(() => this.#memory.utimes(path, times, create));
  }

  // --- the two that touch the disk directly -------------------------------

  /**
   * `navigator.storage.estimate()`, and the warning.
   *
   * `shared: true` always. The Storage Standard's estimate is per storage
   * SHELF, not per API: "The storage usage of a storage shelf is an
   * implementation-defined rough estimate of the amount of bytes used by it",
   * and IndexedDB and Cache Storage sit on the same shelf. MEASURED, Chromium
   * 152: `estimate()` returned `{ quota: 10737425705, usage: 7465,
   * usageDetails: { fileSystem: 7465 } }`. `usageDetails` is a Chromium
   * extension and is deliberately not read — a number only one engine reports
   * is not a number a threshold may be built on.
   *
   * Both dictionary members are OPTIONAL in the IDL (no `required`, no
   * default), which is why `quota` is `number | null` here and why a missing
   * `usage` falls back to the memory backend's own count rather than to zero:
   * a zero would read as "nothing stored" for a full disk.
   */
  async quota(): Promise<Result<QuotaUsage>> {
    if (this.#manager === null) {
      const local = await this.#memory.quota();
      if (!local.ok) return local;
      return ok({ ...local.value, shared: true });
    }

    let estimate: { usage?: number; quota?: number };
    try {
      estimate = await this.#manager.estimate();
    } catch (cause) {
      return err({
        code: 'EIO',
        path: '/',
        syscall: 'quota',
        message: `navigator.storage.estimate() failed: ${String(cause)}`,
        cause: String(cause),
      });
    }

    let persisted: boolean | null = null;
    if (this.#manager.persisted !== undefined) {
      try {
        persisted = await this.#manager.persisted();
      } catch {
        // Unknown is a legitimate answer and the field is `boolean | null` for
        // exactly this. Failing a quota read because the persistence question
        // could not be answered would be a worse trade.
        persisted = null;
      }
    }

    const fallback = await this.#memory.quota();
    const used = estimate.usage ?? (fallback.ok ? fallback.value.used : 0);
    const usage: QuotaUsage = {
      used,
      quota: estimate.quota ?? null,
      shared: true,
      persisted,
    };

    this.#maybeWarn(usage);
    return ok(usage);
  }

  /**
   * Throw away the tree AND the durable store.
   *
   * Both, and in that order. Clearing only the memory tree would leave a
   * checkpoint on disk that the next mount restores, so `Reset-FileSystem`
   * would appear to work and then undo itself on reload — which is precisely
   * the class of bug the seed/overlay regression tests exist for.
   */
  async reset(): Promise<Result<void>> {
    if (this.readOnly) return this.#refuseReadOnly();
    return this.#serialise(async () => {
      const cleared = await this.#memory.reset();
      if (!cleared.ok) return cleared;
      const store = this.#store;
      if (store === null) return this.#refuseReadOnly();
      const wiped = await store.reset();
      if (!wiped.ok) return wiped;
      this.#warned = false;
      this.#coordinator.announce({ kind: 'reset', generation: store.generation });
      return ok(undefined);
    });
  }

  /**
   * Install the seed. NOT written to the store, and that is the design.
   *
   * The seed is rebuilt from code on every boot — that is the whole point of
   * the seed/overlay split, and what lets a portfolio update reach a returning
   * visitor. Checkpointing it would make the store carry a copy of the site's
   * own content that goes stale the moment the site is deployed, and the
   * overlay snapshot already records only the DEVIATIONS from it.
   */
  async installImage(spec: SeedSpec): Promise<Result<void>> {
    if (this.readOnly) return this.#refuseReadOnly();
    return this.#memory.installImage(spec);
  }

  #refuseReadOnly(): Result<never> {
    return err({
      code: 'EROFS',
      path: '/',
      syscall: 'write',
      message:
        'this tab is following another tab that holds the filesystem. ' +
        'Close the other tab and reload to take over.',
      mount: this.name,
    });
  }

  // --- durability ---------------------------------------------------------

  /** Fold the log into a checkpoint now, whatever its size. */
  async checkpoint(): Promise<Result<number>> {
    if (this.#store === null) return this.#refuseReadOnly();
    return this.#serialise(() => this.#checkpointLocked());
  }

  async #checkpointLocked(): Promise<Result<number>> {
    const store = this.#store;
    if (store === null) return this.#refuseReadOnly();
    const generation = await store.checkpoint(this.#memory, {
      seed: this.#seed,
      now: this.#clock(),
    });
    if (!generation.ok) return generation;
    this.#coordinator.announce({ kind: 'checkpoint', generation: generation.value });
    // The warning has to fire somewhere a caller does not have to ask for it.
    // Before an adversarial pass over this file it only fired from `quota()`,
    // so a session that never called `quota()` filled the disk and got an
    // ENOSPC with no warning at all — which is the whole of PR-09 task 9.6 not
    // happening. Once per checkpoint is once per `checkpointBytes` of log.
    //
    // AWAITED, not fired and forgotten. An unawaited promise here would make
    // whether the warning has arrived depend on scheduling, which is the one
    // property a test of a warning cannot work without — and `estimate()` is a
    // single call already made once per quarter-megabyte of log.
    await this.quota();
    return generation;
  }

  /** For a `pagehide` handler. See `OpfsJournal.sync`. */
  sync(): Result<void> {
    if (this.#store === null) return this.#refuseReadOnly();
    return this.#store.sync();
  }

  /** Replay a plan recovered from the log. Recovery only; see `MemoryStorage.replay`. */
  async replay(plan: MutationPlan): Promise<Result<void>> {
    return this.#memory.replay(plan);
  }

  /**
   * Run a mutation and, if the log has grown enough, the checkpoint that folds
   * it in — both inside one critical section. See `#queue`.
   *
   * A FAILED mutation is passed through untouched and does NOT trigger a
   * checkpoint. It wrote no plan — `#commit` returns before `journal.write`
   * when the plan is refused — so there is nothing new to fold in, and running
   * a checkpoint on the failure path would turn every ENOENT into a full
   * overlay rewrite.
   *
   * A failure to CHECKPOINT replaces the result, even though the mutation
   * itself succeeded. That is deliberate and it is the honest answer: the
   * caller asked for a durable write, and if the store cannot be checkpointed —
   * out of quota, the handle is gone — then telling them it succeeded is the
   * lie this whole layer exists to stop telling. The mutation stays applied in
   * memory; the error says the disk did not keep up.
   */
  #durable<T>(operation: () => Promise<Result<T>>): Promise<Result<T>> {
    if (this.readOnly) {
      // A follower. Refused HERE and not by the memory backend underneath,
      // which has to stay writable so the mount can graft the overlay onto it.
      return Promise.resolve(
        err({
          code: 'EROFS',
          path: '/',
          syscall: 'write',
          message:
            'this tab is following another tab that holds the filesystem. ' +
            'Close the other tab and reload to take over.',
          mount: this.name,
        }),
      );
    }
    return this.#serialise(async () => {
      const result = await operation();
      if (!result.ok) return result;
      if (this.#store === null || !this.#store.checkpointDue) return result;
      const checkpointed = await this.#checkpointLocked();
      if (!checkpointed.ok) return checkpointed;
      return result;
    });
  }

  /**
   * The promise-chain mutex, shaped exactly like `MemoryStorage`'s and for the
   * same reason: every link is capped with a swallow, so one operation's
   * rejection cannot poison the queue for the next, while the caller still sees
   * it through the promise this returns.
   */
  #serialise<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(operation);
    this.#queue = run.then(swallow, swallow);
    return run;
  }

  #maybeWarn(usage: QuotaUsage): void {
    if (usage.quota === null || usage.quota <= 0) return;
    const fraction = usage.used / usage.quota;
    if (fraction < this.#threshold) {
      // Edge-triggered in both directions: dropping back under the threshold
      // re-arms the warning. A level-triggered version fires on every write
      // once the disk is nearly full, which is the point at which a user is
      // least able to read a message.
      this.#warned = false;
      return;
    }
    if (this.#warned) return;
    this.#warned = true;
    this.#warn({ used: usage.used, quota: usage.quota, fraction, threshold: this.#threshold });
  }
}

// ---------------------------------------------------------------------------
// mount
// ---------------------------------------------------------------------------

export interface MountOptions extends Omit<OpfsStoreOptions, 'root'> {
  readonly root: OpfsDirectory;
  readonly clock: () => number;
  readonly seed?: SeedSpec;
  readonly manager?: OpfsStorageManager;
  readonly locks?: LockManagerLike;
  readonly coordinator?: StorageCoordinator;
  readonly user?: string;
  readonly capacity?: number | null;
  readonly threshold?: number;
  readonly onQuotaWarning?: (warning: QuotaWarning) => void;
  /**
   * Mount READ-ONLY when another tab holds the leader lock. Default false.
   *
   * A follower cannot take the sync access handles — MEASURED across two real
   * tabs, the platform refuses with `NoModificationAllowedError` — so without
   * this the second tab simply fails. With it, the second tab reads the store
   * through `getFile()`, which is NOT refused (MEASURED: a second tab read back
   * exactly what the first had written, unflushed bytes included) and shows the
   * filesystem read-only. Every mutation is EROFS with a message that says
   * which tab to close.
   *
   * An earlier version of this flag did nothing of the sort: it mounted as a
   * leader anyway and the failure just arrived later, from the platform, as an
   * EIO wrapping a DOMException. An adversarial pass over this file found it.
   */
  readonly allowFollower?: boolean;
}

export interface MountReport {
  readonly backend: OpfsStorage;
  /**
   * Null for a follower, which holds no handles and has nothing to close.
   * That is the difference the type is making visible.
   */
  readonly store: OpfsStore | null;
  /**
   * The tree underneath. FOR READS. Writing through it bypasses both the
   * durability layer and the follower's read-only refusal.
   */
  readonly memory: MemoryStorage;
  readonly recovery: RecoveryReport;
  readonly leadership: Leadership | null;
  readonly role: 'leader' | 'follower';
  /** Plans that could not be replayed. Non-empty means data was lost. */
  readonly failures: readonly StorageError[];
}

/**
 * Take the store, recover, boot, replay, checkpoint, and start logging.
 *
 * THE ORDER IS THE WHOLE ALGORITHM and every step is load-bearing:
 *
 *   1. ELECT. Ask for the leader lock without waiting. A follower stops here
 *      with EROFS rather than colliding with the leader's handles.
 *   2. OPEN. Take the three sync access handles. From here the platform itself
 *      guarantees no other context can write.
 *   3. RECOVER. Roll back an interrupted migration, pick the newer valid
 *      checkpoint slot, migrate it forward, read the committed plans out of the
 *      log if the log's generation matches, and reset the log.
 *   4. BOOT. `reset`, `installImage(seed)`, graft the recovered overlay — the
 *      exact sequence `bootStorage` performs and for its stated reasons. THE
 *      JOURNAL IS NOT RECORDING YET, so none of this is logged.
 *   5. REPLAY the committed plans onto the booted tree.
 *   6. CHECKPOINT, folding steps 3-5 into one slot, and reset the log.
 *   7. BEGIN RECORDING. Only now does a mutation reach the log.
 *
 * A tab that dies at any point before 6 leaves the store byte-identical to what
 * it found, and the next mount does the same thing again. That is why 7 is last
 * and why it is one-way.
 */
export async function mountOpfsStorage(options: MountOptions): Promise<Result<MountReport>> {
  let leadership: Leadership | null = null;
  if (options.locks !== undefined) {
    leadership = await requestLeadership(options.locks);
    if (!leadership.granted) {
      leadership.release();
      leadership = null;
      if (options.allowFollower !== true) {
        return err({
          code: 'EROFS',
          path: '/',
          syscall: 'write',
          message:
            "another tab already holds this origin's storage. Close it, or reload this one " +
            'after it is gone, to take over.',
          mount: 'opfs',
        });
      }
      return mountFollower(options);
    }
  }

  const usage = (): QuotaUsage => UNKNOWN_USAGE;
  const opened = await OpfsStore.open({
    root: options.root,
    ...(options.directory === undefined ? {} : { directory: options.directory }),
    ...(options.migrations === undefined ? {} : { migrations: options.migrations }),
    ...(options.checkpointBytes === undefined ? {} : { checkpointBytes: options.checkpointBytes }),
    usage: options.usage ?? usage,
  });
  if (!opened.ok) {
    leadership?.release();
    return opened;
  }
  const store = opened.value;

  const recovered = await store.recover();
  if (!recovered.ok) {
    store.close();
    leadership?.release();
    return recovered;
  }

  const memory = new MemoryStorage({
    clock: options.clock,
    journal: store.journal,
    capacity: options.capacity ?? null,
    name: 'opfs',
    ...(options.user === undefined ? {} : { user: options.user, group: options.user }),
  });

  const cleared = await memory.reset();
  if (!cleared.ok) return closing(store, leadership, cleared);
  if (options.seed !== undefined) {
    const installed = await memory.installImage(options.seed);
    if (!installed.ok) return closing(store, leadership, installed);
  }

  if (recovered.value.overlay !== null) {
    const grafted = await importSnapshot(memory, recovered.value.overlay, {
      // The seed is the authority on which paths may claim `s: 1`. See
      // `RestoreOptions.seed`: without it a crafted checkpoint can mark the
      // visitor's own files as seed nodes and have the boot after this one drop
      // them. A checkpoint is a file in a browser profile, and a browser
      // profile is not a trusted store.
      ...(options.seed === undefined ? {} : { seed: options.seed }),
    });
    if (!grafted.ok) return closing(store, leadership, grafted);
  }

  const failures: StorageError[] = [];
  for (const plan of recovered.value.replay) {
    const applied = await memory.replay(plan);
    if (!applied.ok) {
      failures.push(applied.error);
      // STOP. The plans are ordered and each was validated against the tree its
      // predecessor left, so applying the next one after skipping this one
      // means applying a plan against a tree it never saw. Losing the tail of a
      // crashed session is a smaller loss than a middle that never existed.
      break;
    }
  }

  const backend = new OpfsStorage({
    store,
    memory,
    clock: options.clock,
    ...(options.manager === undefined ? {} : { manager: options.manager }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(options.threshold === undefined ? {} : { threshold: options.threshold }),
    ...(options.onQuotaWarning === undefined ? {} : { onQuotaWarning: options.onQuotaWarning }),
    ...(options.coordinator === undefined ? {} : { coordinator: options.coordinator }),
  });

  const checkpointed = await backend.checkpoint();
  if (!checkpointed.ok) return closing(store, leadership, checkpointed);

  store.journal.beginRecording();

  return ok({
    backend,
    store,
    memory,
    recovery: recovered.value,
    leadership,
    role: 'leader',
    failures,
  });
}

/**
 * Mount read-only against a store another tab owns.
 *
 * It takes NO handles, so it cannot interrupt the leader and the leader cannot
 * interrupt it. It also cannot repair: an interrupted migration stays
 * interrupted until the leader mounts, a damaged slot is reported rather than
 * rewritten, and a store version newer than this build is a refusal.
 *
 * WHAT A FOLLOWER'S VIEW IS AS OF: the leader's last COMMITTED operation, not
 * its last flush.
 *
 * That is a real difference from recovery, and it took a failing test to state
 * it correctly. `getFile()` returns UNFLUSHED bytes (MEASURED), so the log a
 * follower reads is the log the leader has in hand rather than the log the disk
 * has. A follower therefore sees an operation that a crash at the same instant
 * would lose. That is the right answer for a second tab — it wants to show what
 * the other tab has done, not what would survive a power cut — but it must not
 * be mistaken for the recovery rule.
 *
 * What it does NOT do is show uncommitted work. `committedPlans` is the same
 * function recovery uses, so a plan whose apply failed, or whose commit marker
 * had not been written when the follower looked, is skipped in both.
 *
 * It does not update itself afterwards; that is what `StorageCoordinator`
 * announcements are for, and acting on one means mounting again.
 */
async function mountFollower(options: MountOptions): Promise<Result<MountReport>> {
  const view = await readFollowerView({
    root: options.root,
    ...(options.directory === undefined ? {} : { directory: options.directory }),
    ...(options.migrations === undefined ? {} : { migrations: options.migrations }),
  });
  if (!view.ok) return view;

  const memory = new MemoryStorage({
    clock: options.clock,
    capacity: options.capacity ?? null,
    name: 'opfs-follower',
    ...(options.user === undefined ? {} : { user: options.user, group: options.user }),
  });

  const cleared = await memory.reset();
  if (!cleared.ok) return cleared;
  if (options.seed !== undefined) {
    const installed = await memory.installImage(options.seed);
    if (!installed.ok) return installed;
  }
  if (view.value.overlay !== null) {
    const grafted = await importSnapshot(memory, view.value.overlay, {
      ...(options.seed === undefined ? {} : { seed: options.seed }),
    });
    if (!grafted.ok) return grafted;
  }

  const failures: StorageError[] = [];
  for (const plan of view.value.replay) {
    const applied = await memory.replay(plan);
    if (!applied.ok) {
      failures.push(applied.error);
      break;
    }
  }

  const backend = new OpfsStorage({
    memory,
    clock: options.clock,
    readOnly: true,
    name: 'opfs-follower',
    ...(options.manager === undefined ? {} : { manager: options.manager }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(options.threshold === undefined ? {} : { threshold: options.threshold }),
    ...(options.onQuotaWarning === undefined ? {} : { onQuotaWarning: options.onQuotaWarning }),
    ...(options.coordinator === undefined ? {} : { coordinator: options.coordinator }),
  });

  return ok({
    backend,
    store: null,
    memory,
    recovery: {
      generation: view.value.generation,
      storeVersion: view.value.storeVersion,
      slot: view.value.slot,
      migrated: [],
      replay: view.value.replay,
      truncatedBytes: 0,
      log: view.value.log,
      overlay: view.value.overlay,
      damaged: view.value.damaged,
    },
    leadership: null,
    role: 'follower',
    failures,
  });
}

function closing<T>(
  store: OpfsStore,
  leadership: Leadership | null,
  failure: Result<T>,
): Result<never> {
  store.close();
  leadership?.release();
  return failure as Result<never>;
}

/** The cap on every link of the mutex chain. See `OpfsStorage.#serialise`. */
function swallow(): void {}
