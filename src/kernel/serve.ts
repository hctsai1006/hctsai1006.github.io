/**
 * serve.ts — the worker half. Six lines of wiring and one thing that must not
 * happen.
 *
 * The kernel already has exactly the shape a worker needs: `send(unknown)` is
 * an `onmessage`, and `on(listener)` is an outbound stream of clone-safe
 * values. `protocol.ts` was written first precisely so that moving execution
 * into a Worker would be a change of TRANSPORT and not a change of design, and
 * this file is the whole of that change.
 *
 * ---------------------------------------------------------------------------
 * THE ONE THING THAT MUST NOT HAPPEN
 * ---------------------------------------------------------------------------
 *
 * `transport.post` is called from inside the kernel's event delivery. It can
 * throw: `postMessage` throws `DataCloneError` on anything the structured
 * clone algorithm refuses, and a browser adds `Worker` states of its own. If
 * that throw travels back into `Kernel.#emit` it stops the kernel — MEASURED,
 * before the containment in `#emit` existed:
 *
 *     send() threw: listener blew up
 *     listener A saw: [1]   listener B saw: []   final seq: 1
 *
 * — the pipeline never started, and the process was left in `created` forever.
 * So there are now two seatbelts and they are not redundant. `#emit` contains a
 * listener's failure so the KERNEL survives; this file catches the post failure
 * so the failure is ATTRIBUTED, naming the event that could not be sent rather
 * than surfacing as an anonymous listener error. Without the second one, the
 * report says "a listener threw" about a message nobody can identify.
 *
 * A failed post is not retried. There is no mechanism that could make the
 * retry succeed — the value is the same value — and the sequence number the
 * event carries is the receiver's evidence that it missed something, which is
 * exactly what `KernelClient` reports as a gap.
 */

import type { Kernel } from './kernel.ts';
import type { KernelEvent } from './protocol.ts';
import type { KernelTransport } from './transport.ts';

export interface ServeOptions {
  /**
   * Where a failed `post` goes.
   *
   * The default rethrows on a fresh microtask, which is the loudest thing
   * available that does not run on the kernel's stack: an uncaught exception in
   * Node — which a `node:worker_threads` host sees as `worker.on('error')` —
   * and `self.onerror` in a browser Worker, which the page sees as an `error`
   * event on the `Worker`. Both are places a human already looks.
   */
  readonly onPostFailure?: (error: unknown, event: KernelEvent) => void;
}

/**
 * Put a kernel behind a transport.
 *
 * Returns the detach function. Calling it stops both directions and leaves the
 * kernel intact, because a kernel outliving its transport is a real state —
 * a page that closed one terminal pane and kept the worker — and tearing the
 * kernel down here would make that impossible to express.
 *
 * The kernel is a parameter rather than something this builds. Which commands
 * exist, which capabilities are granted and which ports are wired are the
 * embedder's decisions, and an entry point that made them here would be a
 * policy hidden inside a plumbing file. `browser-worker.ts` makes them for the
 * browser; a test fixture makes them for a test.
 */
export function serveKernel(
  kernel: Kernel,
  transport: KernelTransport,
  options: ServeOptions = {},
): () => void {
  const onPostFailure =
    options.onPostFailure ??
    ((error: unknown) => {
      queueMicrotask(() => {
        throw error;
      });
    });

  const unsubscribe = kernel.on((event) => {
    try {
      transport.post(event);
    } catch (error: unknown) {
      onPostFailure(error, event);
    }
  });

  // Straight through, undecoded. `Kernel.send` takes `unknown` and decodes,
  // which is the entire reason it takes `unknown`: a message from a page has no
  // compile-time type, and a check here would either duplicate
  // `decodeKernelRequest` or — worse — assert a type and hand the kernel
  // whatever arrived.
  const detach = transport.listen((message) => {
    kernel.send(message);
  });

  return () => {
    unsubscribe();
    detach();
  };
}
