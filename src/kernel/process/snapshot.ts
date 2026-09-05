/**
 * snapshot.ts — what a running command looks like from the outside.
 *
 * The v1 terminal has no such thing. `run()` calls `execOne()` in a loop and
 * the only evidence a command ever existed is the rows it printed. There is
 * nothing to list, nothing to signal, nothing to background, and nothing for a
 * task manager to render.
 *
 * A ProcessSnapshot is the OBSERVABLE half of a process: pure data, no methods,
 * no AbortController, no promise. That split is deliberate. The live half stays
 * inside the kernel where it can hold host objects; the snapshot is the only
 * thing that crosses the worker boundary, so it must be structured-clone safe
 * by construction rather than by a sanitiser someone might forget to call.
 */

import type { Runtime } from '../../commands/manifest.ts';
import type { ProcessGroupId, ProcessId, RequestId, TerminalId } from '../ids.ts';
import type { VirtualSignal } from '../signals.ts';

/**
 * Where a process is in its life.
 *
 * Modelled on POSIX rather than on PowerShell's job states, because this
 * describes a process and `JobState` in `jobs.ts` describes a job — they are
 * different objects with different lifetimes, and PowerShell keeps them
 * separate too. `created` exists as its own state so that a process is visible
 * to `Get-Process` and signallable in the window between being allocated a pid
 * and its first `await`, which is where a fast Ctrl+C lands.
 */
export type ProcessState =
  /** Allocated a pid, not yet running. Signallable already. */
  | 'created'
  /** Executing. */
  | 'running'
  /** Awaiting stdin that has not arrived. Distinguishable from a hung command. */
  | 'blocked'
  /** Signalled, still unwinding. SIGKILL skips this. */
  | 'stopping'
  /** Finished. `exitCode` is populated from here on and never changes. */
  | 'exited';

/** Every state, for a UI that renders a filter and must not miss one. */
export const PROCESS_STATES: readonly ProcessState[] = [
  'created',
  'running',
  'blocked',
  'stopping',
  'exited',
];

/**
 * A process as the UI is allowed to see it.
 *
 * Every field is REQUIRED and nullable rather than optional. A field that can
 * be either missing or present-and-null has two encodings for one meaning, and
 * a renderer will eventually handle one of them and not the other. See the
 * structured-clone rules in `../protocol.ts`.
 */
export interface ProcessSnapshot {
  readonly pid: ProcessId;
  /** 0 when a terminal started it directly. See `KERNEL_PID`. */
  readonly ppid: ProcessId;
  /**
   * The group Ctrl+C addresses. A pipeline shares one, so the whole pipeline
   * dies together instead of leaving earlier stages producing into nothing.
   */
  readonly pgid: ProcessGroupId;
  /** The resolved command name, e.g. `Get-ChildItem`. Not the raw token. */
  readonly name: string;
  readonly state: ProcessState;
  readonly cwd: string;
  /** What the user typed for this stage. What `Get-Process` shows. */
  readonly commandLine: string;
  /** Epoch milliseconds from the kernel's clock, which tests can replace. */
  readonly startedAt: number;
  /** Epoch milliseconds, or null while still running. */
  readonly endedAt: number | null;
  /** null until `exited`. Never `undefined`, never re-set afterwards. */
  readonly exitCode: number | null;
  /**
   * Where the work happens, taken from the command's manifest.
   *
   * Carried on the process rather than looked up later so that a task manager
   * can show "this is simulated" for something already running, which is the
   * one moment the distinction actually matters to a user.
   */
  readonly runtime: Runtime;
  readonly terminalId: TerminalId;
  /** Correlates back to the `exec` that produced this. */
  readonly requestId: RequestId;
  /** Backgrounded processes are excluded from the terminal's foreground group. */
  readonly background: boolean;
  /** The signal that stopped it, or null if it exited on its own. */
  readonly signalled: VirtualSignal | null;
}

/** Has this process finished, so its exit code can be trusted? */
export function isTerminated(snapshot: ProcessSnapshot): boolean {
  return snapshot.state === 'exited';
}

/**
 * Did this process fail?
 *
 * A process stopped by a signal is NOT a failure in the sense `$?` reports —
 * PowerShell distinguishes "the pipeline was stopped" from "the command
 * errored", and collapsing them would make Ctrl+C set `$?` to False in a way
 * the reference implementation does not.
 */
export function isFailure(snapshot: ProcessSnapshot): boolean {
  return snapshot.state === 'exited' && snapshot.signalled === null && snapshot.exitCode !== 0;
}
