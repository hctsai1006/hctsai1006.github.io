/**
 * browser-worker-entry.ts — what `new Worker(...)` points at.
 *
 * The whole file, on purpose. An entry point is a side effect: importing it
 * starts a kernel, which means nothing may import it to reach something else.
 * Everything worth testing is in `browser-worker.ts`, which takes its scope as
 * a parameter and starts nothing on its own.
 *
 * `globalThis` and not `self`: in a dedicated Worker they are the same object,
 * and `globalThis` is the one spelling that also type-checks under a `lib` that
 * includes DOM — where `self` is typed as a `Window`, whose `postMessage`
 * takes a target origin that a worker scope's does not. The cast is through
 * `unknown` and lands on the structural type in `transport.ts`, which describes
 * exactly the three members used and nothing else.
 *
 * NOTHING IS GRANTED AND NO FILESYSTEM IS WIRED. See `browser-worker.ts` for
 * why those are the embedder's decisions and where they plug in.
 */

import { startBrowserKernel } from './browser-worker.ts';
import type { MessageEventTargetLike } from './transport.ts';

startBrowserKernel(globalThis as unknown as MessageEventTargetLike);
