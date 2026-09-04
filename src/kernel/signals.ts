/**
 * signals.ts — Ctrl+C, and why it needs process groups before it means anything.
 *
 * In the v1 terminal, Ctrl+C echoes the prompt and empties the input box:
 *
 *     if ((e.ctrlKey||e.metaKey) && (k==="c"||k==="C")) { ... printPrompt(val()); setVal(""); return; }
 *
 * Nothing is interrupted, because nothing is running. A command there is a
 * synchronous function call that has already returned by the time a key can be
 * pressed. Once commands are asynchronous, "interrupt" needs a target — and the
 * target is NOT "everything".
 *
 * A real terminal delivers SIGINT to the FOREGROUND PROCESS GROUP of its
 * controlling terminal. That is the whole reason process groups exist: it is
 * what lets a backgrounded job survive the Ctrl+C that stops the pipeline you
 * are watching. Without groups the only choices are to interrupt background
 * jobs as well, or to interrupt nothing, and both are wrong.
 *
 * A pipeline is ONE group. `Get-Content big.log | Select-String foo | Select-Object -First 3`
 * has to die as a unit: interrupting only the last stage would leave the first
 * two producing into a sink that nobody reads.
 *
 * Mapping onto the browser: a virtual signal is an `AbortController`.
 * AbortSignal is the only cancellation primitive the platform actually has,
 * every command already receives one through `InvocationContext.signal`, and
 * `fetch` and the stream APIs consume it natively — so SIGINT reaches a network
 * command without that command containing a single line about signals.
 *
 * The three signals differ in how much cooperation they need, which is the only
 * honest distinction available to us:
 *
 *   SIGINT   Cooperative. Aborts the controller; the command's own loops notice
 *            and unwind. This is Ctrl+C.
 *   SIGTERM  Cooperative too. It differs from SIGINT only in what it MEANS —
 *            "end" rather than "stop what you are doing" — and in the exit code
 *            it produces. The kernel still waits for the command to unwind, so
 *            anything it has already produced is flushed rather than lost.
 *   SIGKILL  NOT cooperative and NOT catchable. The kernel abandons the pending
 *            invocation and reaps immediately. A kill a command could ignore
 *            would just be SIGTERM with extra steps.
 *
 * There is no SIGSTOP/SIGCONT here. Suspending a JavaScript function that is
 * mid-await is not something the platform can do, and modelling a signal we
 * cannot deliver would be a lie in the shape of an API.
 */

import type { ProcessGroupId, ProcessId, TerminalId } from './ids.ts';

/** The signals the kernel can actually deliver. */
export type VirtualSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL';

/** Every signal name, for validating a message that arrived from outside. */
export const VIRTUAL_SIGNALS: readonly VirtualSignal[] = ['SIGINT', 'SIGTERM', 'SIGKILL'];

/**
 * POSIX signal numbers, kept because they are what the exit code encodes and
 * what a user typing `kill -9` means.
 */
export const SIGNAL_NUMBER: Record<VirtualSignal, number> = {
  SIGINT: 2,
  SIGKILL: 9,
  SIGTERM: 15,
};

/**
 * Exit code for a process stopped by a signal: 128 + the signal number.
 *
 * This is the shell convention, and PowerShell on Unix reports it: Ctrl+C out
 * of a native command leaves `$LASTEXITCODE` at 130. Inventing our own numbers
 * would break every script that tests for 130.
 */
export const SIGNAL_EXIT_CODE: Record<VirtualSignal, number> = {
  SIGINT: 128 + SIGNAL_NUMBER.SIGINT,
  SIGKILL: 128 + SIGNAL_NUMBER.SIGKILL,
  SIGTERM: 128 + SIGNAL_NUMBER.SIGTERM,
};

/**
 * What an interrupted command sees as `signal.reason`.
 *
 * Named after PowerShell's own `PipelineStoppedException`, and carrying the
 * `OperationStopped` category that `$Error[0].CategoryInfo` reports, so a
 * `catch` written against the reference implementation matches here too.
 *
 * It never crosses the worker boundary. The protocol carries an `exit` event
 * with a code instead, because an Error subclass does not survive structured
 * clone with its identity intact — it arrives as a plain Error and the
 * `instanceof` check on the far side silently stops matching.
 */
export class PipelineStoppedError extends Error {
  readonly signal: VirtualSignal;
  readonly pid: ProcessId;
  /** The category `$Error[0].CategoryInfo.Category` reports for this. */
  readonly category = 'OperationStopped';
  constructor(signal: VirtualSignal, pid: ProcessId) {
    super(`The pipeline has been stopped (${signal}).`);
    this.name = 'PipelineStoppedError';
    this.signal = signal;
    this.pid = pid;
  }
}

/** Was this the result of a delivered signal rather than a command bug? */
export function isPipelineStopped(value: unknown): value is PipelineStoppedError {
  return value instanceof PipelineStoppedError;
}

/** Told to the kernel so it can decide how hard to stop waiting. */
export type SignalListener = (pid: ProcessId, signal: VirtualSignal) => void;

/**
 * Routes virtual signals to the AbortControllers that stand in for processes.
 *
 * Knows about pids and groups and nothing else — not the process table, not the
 * command registry, not the terminal. Keeping it that narrow is what lets a
 * test interrupt a foreground group without constructing a whole kernel.
 */
export class SignalController {
  readonly #controllers = new Map<ProcessId, AbortController>();
  /** pgid -> members. A group exists while at least one member is registered. */
  readonly #groups = new Map<ProcessGroupId, Set<ProcessId>>();
  readonly #groupOf = new Map<ProcessId, ProcessGroupId>();
  /** Which group each terminal's Ctrl+C addresses. */
  readonly #foreground = new Map<TerminalId, ProcessGroupId>();
  /** The last signal each process was sent, for the exit code and for Get-Process. */
  readonly #delivered = new Map<ProcessId, VirtualSignal>();
  readonly #listeners = new Set<SignalListener>();

  /**
   * Give a process its AbortSignal and put it in a group.
   *
   * `pgid` defaults to the pid, which makes a lone process its own group leader
   * — the same default POSIX applies, and the reason a bare command can be
   * interrupted without anyone having set a group up first.
   */
  register(pid: ProcessId, pgid: ProcessGroupId = pid): AbortSignal {
    const existing = this.#controllers.get(pid);
    if (existing !== undefined) return existing.signal;

    const controller = new AbortController();
    this.#controllers.set(pid, controller);
    this.#groupOf.set(pid, pgid);
    let members = this.#groups.get(pgid);
    if (members === undefined) {
      members = new Set();
      this.#groups.set(pgid, members);
    }
    members.add(pid);
    return controller.signal;
  }

  /** Forget a process that has exited. A group dies with its last member. */
  unregister(pid: ProcessId): void {
    this.#controllers.delete(pid);
    const pgid = this.#groupOf.get(pid);
    this.#groupOf.delete(pid);
    if (pgid === undefined) return;
    const members = this.#groups.get(pgid);
    if (members === undefined) return;
    members.delete(pid);
    if (members.size === 0) this.#groups.delete(pgid);
  }

  signalFor(pid: ProcessId): AbortSignal | undefined {
    return this.#controllers.get(pid)?.signal;
  }

  groupOf(pid: ProcessId): ProcessGroupId | undefined {
    return this.#groupOf.get(pid);
  }

  /** Members in registration order, which for a pipeline is pipeline order. */
  members(pgid: ProcessGroupId): readonly ProcessId[] {
    return [...(this.#groups.get(pgid) ?? [])];
  }

  /** Which signal, if any, stopped this process. */
  deliveredTo(pid: ProcessId): VirtualSignal | undefined {
    return this.#delivered.get(pid);
  }

  /**
   * Point a terminal's Ctrl+C at a group.
   *
   * The kernel calls this when a foreground pipeline starts and clears it when
   * that pipeline exits. A terminal with no foreground group is sitting at a
   * prompt, where Ctrl+C means "abandon this input line" — a UI concern, and
   * deliberately not a signal, because there is no process to send one to.
   */
  setForeground(terminalId: TerminalId, pgid: ProcessGroupId | null): void {
    if (pgid === null) this.#foreground.delete(terminalId);
    else this.#foreground.set(terminalId, pgid);
  }

  foregroundGroup(terminalId: TerminalId): ProcessGroupId | undefined {
    return this.#foreground.get(terminalId);
  }

  /** Deliver to exactly one process. False if it is not registered. */
  raise(pid: ProcessId, signal: VirtualSignal): boolean {
    const controller = this.#controllers.get(pid);
    if (controller === undefined) return false;

    // Record the signal even when the controller is already aborted. A second
    // Ctrl+C followed by a kill must leave the process reported as killed, and
    // PowerShell's own "press Ctrl+C again to force" escalation depends on the
    // later, harder signal winning rather than being dropped as redundant.
    this.#delivered.set(pid, signal);
    if (!controller.signal.aborted) controller.abort(new PipelineStoppedError(signal, pid));
    for (const listener of this.#listeners) listener(pid, signal);
    return true;
  }

  /** Deliver to every member of a group. Returns who was signalled. */
  raiseGroup(pgid: ProcessGroupId, signal: VirtualSignal): readonly ProcessId[] {
    const hit: ProcessId[] = [];
    // Snapshot the membership first: a listener may unregister the process it
    // is told about, and mutating the set while iterating it would skip the
    // next member — meaning half a pipeline would keep running.
    for (const pid of this.members(pgid)) {
      if (this.raise(pid, signal)) hit.push(pid);
    }
    return hit;
  }

  /**
   * `kill()` semantics: a NEGATIVE target means the group led by its absolute
   * value, exactly as POSIX defines it.
   *
   * The protocol carries a plain `processId` number, so this is how a UI asks
   * for "the whole pipeline" without the protocol growing a second field that
   * could disagree with the first.
   */
  deliver(target: number, signal: VirtualSignal): readonly ProcessId[] {
    if (target < 0) return this.raiseGroup(-target, signal);
    return this.raise(target, signal) ? [target] : [];
  }

  /**
   * Ctrl+C: interrupt the terminal's foreground group and NOTHING else.
   *
   * Returns the pids that were interrupted, so the caller can distinguish
   * "stopped the pipeline" from "there was nothing to stop" — different things
   * to show the user, and the second is where the input line gets cleared.
   */
  interrupt(terminalId: TerminalId): readonly ProcessId[] {
    const pgid = this.#foreground.get(terminalId);
    if (pgid === undefined) return [];
    return this.raiseGroup(pgid, 'SIGINT');
  }

  onSignal(listener: SignalListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}
