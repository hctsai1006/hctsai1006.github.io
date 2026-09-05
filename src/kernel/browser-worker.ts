/**
 * browser-worker.ts — the kernel, assembled for a browser dedicated Worker.
 *
 * This is the file the injected transport buys. `serve.ts` and `client.ts`
 * know nothing about a `Worker`, a `MessagePort` or `worker_threads`; this
 * picks the web adapter and the command set and hands both to `serveKernel`,
 * and `tests/unit/kernel-worker-fixture.mts` does the same job for Node with a
 * different adapter and a different command set. Two entry points, one design —
 * which is exactly the claim the split was made to support, and it is checkable
 * by reading both: neither contains any logic the other lacks.
 *
 * It is deliberately NOT exported from `index.ts`. It imports the whole command
 * registry, and a barrel that dragged 85 commands into anything wanting a
 * `KernelClient` would put the entire execution engine on the UI thread — the
 * exact thing this milestone exists to stop.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT WIRED HERE, AND WHY THAT IS NOT AN OMISSION
 * ---------------------------------------------------------------------------
 *
 * NO CAPABILITY GRANTS. `grants` defaults to nothing, so a command that
 * declares `filesystem.write` is denied and says so. What a session may do is
 * the embedder's decision — it is the trust root — and an entry point that
 * granted a default set would be a policy hidden in a plumbing file, which is
 * the shape PR-14's trusted package model exists to remove rather than add to.
 *
 * NO FILESYSTEM. `openFileSystem` is where OPFS plugs in when PR-09 lands, and
 * the signature it must satisfy is already fixed by the kernel: one view per
 * session over one shared backend, opened synchronously at a given directory.
 * Wiring a storage backend that this branch cannot test would be a claim rather
 * than a feature, so the hole is named instead.
 *
 * The commands that need neither — `Get-Date`, `Get-Random`, `Write-Output`,
 * `ping`, the formatters — run today. The ones that do are denied with a
 * capability error, which is the honest answer and not a crash.
 */

import { ALL_COMMANDS } from '../commands/registry.ts';
import type { CommandModule } from '../commands/invocation.ts';
import { Kernel } from './kernel.ts';
import type { KernelOptions } from './kernel.ts';
import { serveKernel } from './serve.ts';
import type { ServeOptions } from './serve.ts';
import { eventTargetTransport } from './transport.ts';
import type { MessageEventTargetLike } from './transport.ts';

export interface BrowserKernelOptions extends KernelOptions, ServeOptions {
  /** Which commands exist. Defaults to every implemented one. */
  readonly commands?: readonly CommandModule[];
}

export interface BrowserKernel {
  readonly kernel: Kernel;
  /** Stop serving. The kernel survives, because a pane closing is not a crash. */
  readonly stop: () => void;
}

/**
 * Serve a kernel over a worker scope.
 *
 * `scope` is the global of a dedicated Worker — `self` — and is a PARAMETER
 * rather than being read from `globalThis` here, so this function can be
 * exercised with a fake scope in a test that has no Worker. The entry point
 * that supplies the real one is `browser-worker-entry.ts`, which is three
 * lines and is the only thing in this repository that touches `self`.
 */
export function startBrowserKernel(
  scope: MessageEventTargetLike,
  options: BrowserKernelOptions = {},
): BrowserKernel {
  const { commands = ALL_COMMANDS, onPostFailure, ...kernelOptions } = options;
  const kernel = new Kernel(kernelOptions);
  for (const module of commands) kernel.register(module);
  const stop = serveKernel(
    kernel,
    eventTargetTransport(scope),
    onPostFailure === undefined ? {} : { onPostFailure },
  );
  return { kernel, stop };
}
