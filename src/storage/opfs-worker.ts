/**
 * opfs-worker.ts — the dedicated StorageWorker, its wire protocol, and the
 * client that looks like a `StorageBackend` on the other side.
 *
 * ---------------------------------------------------------------------------
 * WHY A WORKER AT ALL
 * ---------------------------------------------------------------------------
 *
 * Not for concurrency. For one line of IDL:
 *
 *     [Exposed=DedicatedWorker, SecureContext]
 *     interface FileSystemSyncAccessHandle { … };
 *     -- https://fs.spec.whatwg.org/#filesystemsyncaccesshandle
 *
 * `createSyncAccessHandle()` cannot be called from a Window and cannot be
 * called from a SharedWorker. MEASURED, in this repository's own dependencies
 * rather than from memory: `FileSystemSyncAccessHandle` appears in TypeScript's
 * `lib.webworker.d.ts` and appears ZERO times in `lib.dom.d.ts`. The store has
 * to live in a dedicated worker; the terminal does not; so something has to
 * cross a `postMessage`, and that something is this file.
 *
 * `types.ts` decided this before there was any code, and gave the reason that
 * matters: "a synchronous signature would be a promise this layer cannot keep …
 * Getting that backwards is the one mistake that would force all 28 commands to
 * be rewritten later." Every method of `StorageBackend` is already async, so
 * `WorkerStorageBackend` below is a drop-in — a command cannot tell whether its
 * filesystem is in this thread or another one.
 *
 * ---------------------------------------------------------------------------
 * THE PROTOCOL IS DERIVED FROM THE INTERFACE, NOT WRITTEN OUT
 * ---------------------------------------------------------------------------
 *
 * `StorageCall` is a mapped type over `StorageBackend`, so its payloads are
 * `Parameters<StorageBackend[K]>`. Adding a method to `StorageBackend` widens
 * the union, and the `switch` in `dispatch` stops compiling until the new
 * method is handled. A hand-written protocol drifts from its interface silently
 * and is discovered by a command failing in a browser; this one cannot drift.
 *
 * ---------------------------------------------------------------------------
 * WHAT CROSSES THE BOUNDARY, AND WHY IT ALL SURVIVES structuredClone
 * ---------------------------------------------------------------------------
 *
 * `types.ts` lists this as requirement 3 for an OPFS backend: "a `postMessage`
 * protocol whose payloads are structured-cloneable — `Uint8Array` is,
 * `StorageError` is (it is plain data, no class, no `Error` subclass,
 * deliberately), `FileStat` is". That is not an accident of those types; it is
 * why `StorageError` is a discriminated union of plain objects and why
 * `StorageFailure` — the throwable — is a SEPARATE thing that never appears in
 * a `Result`. An `Error` subclass loses its prototype and its own properties
 * through a structured clone, so a backend that returned one would arrive on
 * the other side as an object with a `message` and nothing to branch on.
 *
 * A genuine THROW is the exception, and it is flattened deliberately: the
 * worker catches it and sends `{ failed: string }`, and the client re-throws a
 * plain `Error`. A thrown error means a bug rather than an expected failure —
 * `Result` carries every expected one — and a stack trace from the wrong thread
 * is worth less than the guarantee that the channel never hangs.
 */

import { err } from './types.ts';
import type { Result, StorageBackend, StorageError } from './types.ts';

// ---------------------------------------------------------------------------
// the wire
// ---------------------------------------------------------------------------

/**
 * The methods that cross. Every one of `StorageBackend`'s, by name.
 *
 * Written out rather than derived with `keyof` because `keyof StorageBackend`
 * would include `name` and `readOnly`, which are values and not calls. They
 * cross once, in the handshake.
 */
export const STORAGE_OPS = [
  'stat',
  'exists',
  'access',
  'readBytes',
  'readText',
  'writeBytes',
  'writeText',
  'appendBytes',
  'appendText',
  'mkdir',
  'readdir',
  'remove',
  'rename',
  'copy',
  'chmod',
  'utimes',
  'quota',
  'installImage',
  'reset',
] as const;

export type StorageOp = (typeof STORAGE_OPS)[number];

/**
 * A compile-time assertion that `STORAGE_OPS` covers `StorageBackend`.
 *
 * If a method is added to the interface and not to the array, `Missing` becomes
 * a non-`never` type and the `Exhaustive` line fails to compile with the name
 * of the missing method in the error. That is the whole point: a protocol that
 * silently omits a method is a command that works in Node and fails in the
 * browser, which is the most expensive kind of bug this layer can have.
 */
type CallableKeys = {
  [K in keyof StorageBackend]: StorageBackend[K] extends (...args: never[]) => unknown ? K : never;
}[keyof StorageBackend];
type Missing = Exclude<CallableKeys, StorageOp>;
type Exhaustive = Missing extends never ? true : Missing;
const OPS_ARE_EXHAUSTIVE: Exhaustive = true;
export { OPS_ARE_EXHAUSTIVE };

type CallFor<K extends StorageOp> = {
  readonly id: number;
  readonly op: K;
  readonly args: Parameters<StorageBackend[K]>;
};

/** One request. `args` is exactly the method's parameter tuple. */
export type StorageCall = { [K in StorageOp]: CallFor<K> }[StorageOp];

/**
 * One reply.
 *
 * `value` is whatever the method resolved to — usually a `Result`, sometimes a
 * bare boolean (`exists`). `failed` is a thrown error, flattened to a string;
 * see the header for why the stack is not carried.
 */
export type StorageReply =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly failed: string };

/** The minimum of `Worker`/`DedicatedWorkerGlobalScope` this needs. */
export interface MessagePortLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

/**
 * The durability controls, which are NOT part of `StorageBackend`.
 *
 * A SECOND ADVERSARIAL PASS found this gap. `StorageCall` is derived from
 * `StorageBackend` so it cannot drift from it — and `checkpoint` and `sync` are
 * not on `StorageBackend`, deliberately: no command has any business calling
 * them, and putting them there would put them in front of all 28.
 *
 * But the page is where `pagehide` fires, and the store is in the worker. With
 * only `StorageCall` crossing, a page could not tell its own storage to flush
 * before the tab went away — so the last operation of every session was lost
 * for want of a message. That is one of PR-09's own acceptance conditions
 * ("clearing site data is survivable") failing on a technicality.
 *
 * So they cross as a separate message shape rather than being bolted onto the
 * derived union. Nothing about `StorageCall`'s drift-proofing changes, and a
 * backend that has no durability to control simply is not passed here.
 */
export interface StorageControls {
  checkpoint(): Promise<Result<number>>;
  sync(): Result<void>;
}

export type StorageControl = {
  readonly id: number;
  readonly control: 'checkpoint' | 'sync';
};

function isControl(message: unknown): message is StorageControl {
  return (
    typeof message === 'object' &&
    message !== null &&
    'control' in message &&
    ((message as StorageControl).control === 'checkpoint' ||
      (message as StorageControl).control === 'sync')
  );
}

// ---------------------------------------------------------------------------
// the worker side
// ---------------------------------------------------------------------------

/**
 * Serve `backend` over `scope`. Call this from the dedicated worker's top level.
 *
 * ONE CALL AT A TIME IS NOT ENFORCED HERE, and that is correct. `StorageBackend`
 * states the contract — "A mount runs ONE mutating operation at a time, and THE
 * BACKEND SERIALISES — callers do not have to. Overlapping calls are legal,
 * well-defined and ordered" — and both implementations keep it with an internal
 * mutex. Serialising here as well would add a second queue with different
 * ordering rules, and the message handler is exactly the place `types.ts` warns
 * about: "the target is a `StorageWorker` handling `postMessage`, where every
 * async handler runs concurrently by construction."
 *
 * So this dispatches immediately and lets the backend order the work. A read
 * issued during a long `cp -r` answers straight away, which is the behaviour a
 * terminal needs.
 */
export function serveStorageWorker(
  scope: MessagePortLike,
  backend: StorageBackend,
  controls?: StorageControls,
): void {
  scope.addEventListener('message', (event): void => {
    const message = event.data;
    void (async (): Promise<void> => {
      const id = (message as { id?: number }).id ?? 0;
      try {
        if (isControl(message)) {
          if (controls === undefined) {
            // A backend with no durability to control. Reported rather than
            // ignored: a page whose `pagehide` sync silently did nothing would
            // believe its data was safe.
            scope.postMessage({
              id,
              ok: false,
              failed: `this storage worker serves a backend with no ${message.control}`,
            } satisfies StorageReply);
            return;
          }
          const value =
            message.control === 'checkpoint' ? await controls.checkpoint() : controls.sync();
          scope.postMessage({ id, ok: true, value } satisfies StorageReply);
          return;
        }
        const value = await dispatch(backend, message as StorageCall);
        scope.postMessage({ id, ok: true, value } satisfies StorageReply);
      } catch (cause) {
        scope.postMessage({
          id,
          ok: false,
          failed: cause instanceof Error ? cause.message : String(cause),
        } satisfies StorageReply);
      }
    })();
  });
}

/**
 * Route one call. The `switch` is exhaustive by construction; see `StorageCall`.
 *
 * `...call.args` and not a positional list, so the arity comes from the
 * interface rather than from this file's memory of it. An optional argument
 * that the caller omitted arrives as a shorter tuple and the method's own
 * default applies, which is what a local call would have done.
 */
async function dispatch(backend: StorageBackend, call: StorageCall): Promise<unknown> {
  switch (call.op) {
    case 'stat':
      return backend.stat(...call.args);
    case 'exists':
      return backend.exists(...call.args);
    case 'access':
      return backend.access(...call.args);
    case 'readBytes':
      return backend.readBytes(...call.args);
    case 'readText':
      return backend.readText(...call.args);
    case 'writeBytes':
      return backend.writeBytes(...call.args);
    case 'writeText':
      return backend.writeText(...call.args);
    case 'appendBytes':
      return backend.appendBytes(...call.args);
    case 'appendText':
      return backend.appendText(...call.args);
    case 'mkdir':
      return backend.mkdir(...call.args);
    case 'readdir':
      return backend.readdir(...call.args);
    case 'remove':
      return backend.remove(...call.args);
    case 'rename':
      return backend.rename(...call.args);
    case 'copy':
      return backend.copy(...call.args);
    case 'chmod':
      return backend.chmod(...call.args);
    case 'utimes':
      return backend.utimes(...call.args);
    case 'quota':
      return backend.quota(...call.args);
    case 'installImage':
      return backend.installImage(...call.args);
    case 'reset':
      return backend.reset(...call.args);
  }
}

// ---------------------------------------------------------------------------
// the client side
// ---------------------------------------------------------------------------

export interface WorkerStorageOptions {
  readonly port: MessagePortLike;
  /** Reported in EROFS and diagnostics. The worker's backend has its own. */
  readonly name?: string;
  readonly readOnly?: boolean;
}

/**
 * A `StorageBackend` that is somewhere else.
 *
 * Every method is the same one line: send, await, unwrap. The repetition is the
 * feature — each line is checked against the interface's own signature, so a
 * mismatched argument list is a compile error rather than a wrong call made at
 * runtime in a worker where nothing can see it.
 */
export class WorkerStorageBackend implements StorageBackend {
  readonly name: string;
  readonly readOnly: boolean;

  readonly #port: MessagePortLike;
  readonly #waiting = new Map<number, (reply: StorageReply) => void>();
  #next = 1;

  constructor(options: WorkerStorageOptions) {
    this.#port = options.port;
    this.name = options.name ?? 'opfs-worker';
    this.readOnly = options.readOnly ?? false;
    this.#port.addEventListener('message', (event): void => {
      const reply = event.data as StorageReply;
      const settle = this.#waiting.get(reply.id);
      if (settle === undefined) return;
      this.#waiting.delete(reply.id);
      settle(reply);
    });
  }

  /**
   * Send one call and wait for its reply.
   *
   * NO TIMEOUT, deliberately. A timeout here would resolve a call the worker is
   * still running, and the caller would then issue the next one against a
   * backend that is mid-operation — turning a slow disk into a corrupt tree.
   * A worker that never answers is a worker that has died, and the page has
   * `worker.onerror` and `pagehide` for that; it is not something a filesystem
   * call should paper over. This is the same judgement `types.ts` makes about
   * throwing: a caller cannot do anything useful with the failure, so do not
   * invent one.
   */
  #send<T>(op: StorageOp, args: unknown[]): Promise<T> {
    const id = this.#next;
    this.#next += 1;
    return new Promise<T>((resolve, reject) => {
      this.#waiting.set(id, (reply) => {
        if (reply.ok) resolve(reply.value as T);
        else reject(new Error(`storage worker: ${reply.failed}`));
      });
      this.#port.postMessage({ id, op, args });
    });
  }

  async stat(...args: Parameters<StorageBackend['stat']>): ReturnType<StorageBackend['stat']> {
    return this.#send('stat', args);
  }

  async exists(...args: Parameters<StorageBackend['exists']>): ReturnType<StorageBackend['exists']> {
    return this.#send('exists', args);
  }

  async access(...args: Parameters<StorageBackend['access']>): ReturnType<StorageBackend['access']> {
    return this.#send('access', args);
  }

  async readBytes(...args: Parameters<StorageBackend['readBytes']>): ReturnType<StorageBackend['readBytes']> {
    return this.#send('readBytes', args);
  }

  async readText(...args: Parameters<StorageBackend['readText']>): ReturnType<StorageBackend['readText']> {
    return this.#send('readText', args);
  }

  async writeBytes(...args: Parameters<StorageBackend['writeBytes']>): ReturnType<StorageBackend['writeBytes']> {
    return this.#send('writeBytes', args);
  }

  async writeText(...args: Parameters<StorageBackend['writeText']>): ReturnType<StorageBackend['writeText']> {
    return this.#send('writeText', args);
  }

  async appendBytes(...args: Parameters<StorageBackend['appendBytes']>): ReturnType<StorageBackend['appendBytes']> {
    return this.#send('appendBytes', args);
  }

  async appendText(...args: Parameters<StorageBackend['appendText']>): ReturnType<StorageBackend['appendText']> {
    return this.#send('appendText', args);
  }

  async mkdir(...args: Parameters<StorageBackend['mkdir']>): ReturnType<StorageBackend['mkdir']> {
    return this.#send('mkdir', args);
  }

  async readdir(...args: Parameters<StorageBackend['readdir']>): ReturnType<StorageBackend['readdir']> {
    return this.#send('readdir', args);
  }

  async remove(...args: Parameters<StorageBackend['remove']>): ReturnType<StorageBackend['remove']> {
    return this.#send('remove', args);
  }

  async rename(...args: Parameters<StorageBackend['rename']>): ReturnType<StorageBackend['rename']> {
    return this.#send('rename', args);
  }

  async copy(...args: Parameters<StorageBackend['copy']>): ReturnType<StorageBackend['copy']> {
    return this.#send('copy', args);
  }

  async chmod(...args: Parameters<StorageBackend['chmod']>): ReturnType<StorageBackend['chmod']> {
    return this.#send('chmod', args);
  }

  async utimes(...args: Parameters<StorageBackend['utimes']>): ReturnType<StorageBackend['utimes']> {
    return this.#send('utimes', args);
  }

  async quota(...args: Parameters<StorageBackend['quota']>): ReturnType<StorageBackend['quota']> {
    return this.#send('quota', args);
  }

  async installImage(...args: Parameters<StorageBackend['installImage']>): ReturnType<StorageBackend['installImage']> {
    return this.#send('installImage', args);
  }

  async reset(...args: Parameters<StorageBackend['reset']>): ReturnType<StorageBackend['reset']> {
    return this.#send('reset', args);
  }

  /**
   * Fold the log into a checkpoint, from the other side of the boundary.
   *
   * Not part of `StorageBackend` and not in `STORAGE_OPS`; see
   * `StorageControls` for why it crosses as a different message shape.
   */
  async checkpoint(): Promise<Result<number>> {
    return this.#control<Result<number>>('checkpoint');
  }

  /**
   * Force un-flushed commit markers down. WHAT A `pagehide` HANDLER CALLS.
   *
   * The page owns the lifecycle event and the worker owns the store, so without
   * this the last operation of every session that ends without a checkpoint is
   * lost — see `OpfsJournal.sync` for exactly how wide that window is.
   */
  async sync(): Promise<Result<void>> {
    return this.#control<Result<void>>('sync');
  }

  #control<T>(control: 'checkpoint' | 'sync'): Promise<T> {
    const id = this.#next;
    this.#next += 1;
    return new Promise<T>((resolve, reject) => {
      this.#waiting.set(id, (reply) => {
        if (reply.ok) resolve(reply.value as T);
        else reject(new Error(`storage worker: ${reply.failed}`));
      });
      this.#port.postMessage({ id, control });
    });
  }

  /** Calls still in flight. A test asserts this reaches zero. */
  get inFlight(): number {
    return this.#waiting.size;
  }
}

/**
 * The failure to report when the worker itself could not be started.
 *
 * A separate function because the page needs the same shape whether the worker
 * script 404'd, the browser has no OPFS, or the context is not secure — and
 * because a caller staring at a bare `Event` from `worker.onerror` has nothing
 * to render.
 */
export function workerUnavailable(reason: string): Result<never, StorageError> {
  return err({
    code: 'EIO',
    path: '/',
    syscall: 'read',
    message: `the storage worker could not be started: ${reason}`,
    cause: reason,
  });
}

// ---------------------------------------------------------------------------
// the coordination hub
// ---------------------------------------------------------------------------

export interface SharedWorkerScopeLike {
  addEventListener(type: 'connect', listener: (event: { ports: readonly MessagePortLike[] }) => void): void;
}

/**
 * The body of the SharedWorker that `createCoordinator` connects to.
 *
 * It is a repeater and nothing else: it holds the connected ports and forwards
 * each message to the others. It deliberately holds NO storage state and NEVER
 * touches OPFS — it cannot, since `createSyncAccessHandle` is not exposed here,
 * and the roadmap records that constraint as one "worth stating as a hard
 * constraint so nobody 'simplifies' it later".
 *
 * A port that throws on `postMessage` is dropped rather than retried. The only
 * reason it throws is that the tab is gone, and a coordinator that cannot
 * deliver a message costs a stale read-only view until a reload — see
 * `StorageCoordinator` for why that is the whole exposure.
 */
export function serveCoordinatorSharedWorker(scope: SharedWorkerScopeLike): void {
  const ports: MessagePortLike[] = [];
  scope.addEventListener('connect', (event): void => {
    const port = event.ports[0];
    if (port === undefined) return;
    ports.push(port);
    port.addEventListener('message', (message): void => {
      for (let index = ports.length - 1; index >= 0; index -= 1) {
        const other = ports[index];
        if (other === undefined || other === port) continue;
        try {
          other.postMessage(message.data);
        } catch {
          ports.splice(index, 1);
        }
      }
    });
  });
}
