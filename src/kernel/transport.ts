/**
 * transport.ts — the wire the protocol travels on, and the two shapes it comes
 * in.
 *
 * `protocol.ts` says what a message IS. Nothing in it says how a message gets
 * anywhere, and that omission is deliberate: the kernel has to run behind a
 * browser `Worker`, and the test that proves it does has to run in Node with
 * `node:worker_threads`. Those are two different objects with two different
 * subscription APIs and ONE message contract — the structured clone algorithm,
 * which is the same algorithm in both.
 *
 * So the transport is injected. `serve.ts` and `client.ts` know only
 * `KernelTransport`; the entry point picks the adapter. That is what makes a
 * browser entry point a DIFFERENT FILE rather than a different design, and it
 * is why a real Worker can be put between the two halves in an ordinary unit
 * test with no browser anywhere.
 *
 * ---------------------------------------------------------------------------
 * THE TWO SHAPES, AND WHY THEY ARE NOT ONE
 * ---------------------------------------------------------------------------
 *
 * The web platform delivers a message as an EVENT carrying `.data`:
 *
 *     worker.addEventListener('message', (event) => use(event.data))
 *
 * Node's `worker_threads` delivers the message ITSELF, EventEmitter-style:
 *
 *     worker.on('message', (message) => use(message))
 *
 * One adapter cannot serve both, and guessing between them at runtime is worse
 * than either: the failure mode of getting it wrong is that the kernel is
 * handed a `MessageEvent` where it expected a request, which is a bug that
 * survives every type check because both sides are `unknown`. It is caught, in
 * the end, by `decodeKernelRequest` reporting `kind must be a string` — a
 * decoder earning its place — but the right answer is not to make that mistake,
 * so the two shapes are two functions with two names.
 *
 * ---------------------------------------------------------------------------
 * STRUCTURAL, NOT IMPORTED
 * ---------------------------------------------------------------------------
 *
 * Neither adapter imports anything. `MessageEventTargetLike` describes a
 * browser `Worker`, a `MessagePort` and a `DedicatedWorkerGlobalScope` without
 * naming any of them; `MessageEmitterLike` describes Node's `Worker` and
 * `MessagePort` without importing `node:worker_threads`. That matters in both
 * directions: a `node:` import in `src/` would break a browser bundle, and a
 * DOM type in a Node-only file would need lib juggling to compile. A structural
 * type needs neither, and `tests/unit/kernel-worker.test.mts` proves at COMPILE
 * TIME that the real browser types satisfy it — which is as close to a browser
 * as this repository can get without one, and is stated that way rather than
 * claimed as more.
 */

/** What a subscriber is handed. Always the message, never an event wrapper. */
export type TransportMessageListener = (message: unknown) => void;

/**
 * A duplex message channel, reduced to the three things either side needs.
 *
 * `post` and not `postMessage`: the name being different from the platform's is
 * a small, deliberate friction, so that a caller reaching for `postMessage` on
 * a transport notices that it is holding an abstraction rather than a Worker.
 *
 * `listen` RETURNS ITS OWN UNSUBSCRIBE rather than offering a `remove`. A
 * remove-by-identity API is the one that quietly does nothing when the caller
 * passes a different closure than it registered, and the resulting leak is a
 * listener that keeps rendering into a terminal that is gone.
 */
export interface KernelTransport {
  /**
   * Send one message. May THROW — `postMessage` throws `DataCloneError` on a
   * value the structured clone algorithm refuses — and callers are expected to
   * treat that as a reportable failure rather than let it unwind something
   * important. `serveKernel` does exactly that.
   */
  post(message: unknown): void;
  /** Subscribe. The returned function unsubscribes, and is idempotent. */
  listen(listener: TransportMessageListener): () => void;
  /**
   * Stop delivering, and close the underlying port if it has a `close`.
   *
   * A Node `Worker` has `terminate` rather than `close`, so closing a transport
   * built over one detaches this side and leaves the thread to whoever started
   * it. That is the honest division: a transport did not create the worker and
   * has no business ending it.
   */
  close(): void;
}

// ---------------------------------------------------------------------------
// the web shape: addEventListener('message', e => e.data)
// ---------------------------------------------------------------------------

/** The one field of a `MessageEvent` this cares about. */
export interface MessageEventLike {
  readonly data: unknown;
}

/**
 * A browser `Worker`, a `MessagePort`, or a `DedicatedWorkerGlobalScope`.
 *
 * `start` is here because a `MessagePort` obtained from a `MessageChannel`
 * delivers NOTHING until it is called — and `addEventListener` (unlike setting
 * `onmessage`) does not call it implicitly. A transport that omitted it would
 * work for `Worker` and `self`, and silently deliver no messages at all for the
 * port pair, which is the shape a SharedWorker hands out.
 */
export interface MessageEventTargetLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEventLike) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEventLike) => void): void;
  start?: () => void;
  close?: () => void;
}

export function eventTargetTransport(port: MessageEventTargetLike): KernelTransport {
  const listeners = new Set<TransportMessageListener>();
  let started = false;
  let closed = false;

  // ONE platform listener for however many subscribers, so unsubscribing the
  // last one does not depend on the platform's own remove-by-identity working
  // for a closure this module did not keep.
  const onMessage = (event: MessageEventLike): void => {
    if (closed) return;
    // `.data`, and this unwrapping is the entire difference between the two
    // adapters. Handing the event through would give the kernel an object with
    // no `kind`, which decodes as a rejection instead of running anything.
    deliver(listeners, event.data);
  };

  return {
    post(message: unknown): void {
      port.postMessage(message);
    },
    listen(listener: TransportMessageListener): () => void {
      listeners.add(listener);
      if (!started) {
        port.addEventListener('message', onMessage);
        // After addEventListener, never before: `start` flushes anything already
        // queued, and flushing before the handler is attached loses it.
        port.start?.();
        started = true;
      }
      return () => {
        listeners.delete(listener);
      };
    },
    close(): void {
      if (closed) return;
      closed = true;
      listeners.clear();
      if (started) port.removeEventListener('message', onMessage);
      port.close?.();
    },
  };
}

// ---------------------------------------------------------------------------
// the EventEmitter shape: on('message', message => message)
// ---------------------------------------------------------------------------

/**
 * Node's `worker_threads` `Worker` or `MessagePort`, described structurally.
 *
 * `on`/`off` return `this` on a real EventEmitter; the return type here is
 * `unknown` because nothing in this file chains, and demanding `this` would
 * make the type reject anything that is emitter-SHAPED without being one.
 */
export interface MessageEmitterLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  off(event: 'message', listener: (message: unknown) => void): unknown;
  close?: () => void;
}

export function eventEmitterTransport(port: MessageEmitterLike): KernelTransport {
  const listeners = new Set<TransportMessageListener>();
  let attached = false;
  let closed = false;

  const onMessage = (message: unknown): void => {
    if (closed) return;
    // No `.data` here, and that is not an oversight: `worker_threads` delivers
    // the cloned value itself. See the header.
    deliver(listeners, message);
  };

  return {
    post(message: unknown): void {
      port.postMessage(message);
    },
    listen(listener: TransportMessageListener): () => void {
      listeners.add(listener);
      if (!attached) {
        port.on('message', onMessage);
        attached = true;
      }
      return () => {
        listeners.delete(listener);
      };
    },
    close(): void {
      if (closed) return;
      closed = true;
      listeners.clear();
      if (attached) port.off('message', onMessage);
      port.close?.();
    },
  };
}

// ---------------------------------------------------------------------------
// shared delivery
// ---------------------------------------------------------------------------

/**
 * Hand one message to every subscriber, and let none of them stop the others.
 *
 * The same containment `Kernel.#emit` needed, for the same reason and against
 * the same evidence: a subscriber that throws is a subscriber with a bug, and
 * the transport delivering to a second subscriber must not depend on the first
 * one being correct. Rethrown on a fresh microtask so it stays loud — an
 * uncaught exception in Node, `self.onerror` in a Worker — without unwinding
 * whatever the platform was doing when the message arrived.
 *
 * The set is COPIED first: a subscriber that unsubscribes on the message it is
 * being handed would otherwise mutate the set mid-iteration.
 */
function deliver(listeners: ReadonlySet<TransportMessageListener>, message: unknown): void {
  for (const listener of [...listeners]) {
    try {
      listener(message);
    } catch (error: unknown) {
      queueMicrotask(() => {
        throw error;
      });
    }
  }
}
