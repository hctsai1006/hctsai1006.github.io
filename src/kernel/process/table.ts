/**
 * table.ts — pid allocation and the live process list.
 *
 * ---------------------------------------------------------------------------
 * WHY PIDS ARE MONOTONIC INTEGERS AND NOT GUIDS
 * ---------------------------------------------------------------------------
 *
 * The obvious shortcut is `crypto.randomUUID()`, or worse, whatever this
 * emulator's own `New-Guid` returns. Both are wrong here, and the second is
 * wrong in a way that is easy to miss.
 *
 * PowerShell 7.7 changes `New-Guid` to emit a time-sortable UUIDv7 BY DEFAULT,
 * where 7.6 emits a random UUIDv4. That is a deliberate upstream change and
 * this project models it as a profile behaviour. But it means a guid
 * generator's output shape — random, or time-ordered and leaking a timestamp —
 * now depends on which compatibility profile is active.
 *
 * An identifier the KERNEL depends on must never inherit a version-dependent
 * default from a command we are emulating. If pids came from a guid generator:
 *
 *   - switching the profile from 7.6 to 7.7 would silently change whether pids
 *     sort chronologically, so `Get-Process | Sort-Object Id` would mean one
 *     thing on one profile and another thing on the other;
 *   - a bug in our emulation of a COMMAND would become a bug in process
 *     identity, which is the kernel's own invariant;
 *   - the dependency runs backwards. The kernel is what the command layer is
 *     built on; it must not import that layer's semantics.
 *
 * So: a plain counter. It is monotonic without reference to a clock, it sorts
 * correctly under every profile, it is short enough to type into `kill`, and
 * `Get-Process` reports the integer Id that PowerShell reports.
 *
 * Pids are NEVER REUSED, even after a process is reaped. Reuse is the classic
 * source of "signal delivered to the wrong process": a UI holding pid 7 from a
 * stale snapshot must get "no such process", not somebody else's pipeline.
 * A 53-bit safe integer counter cannot realistically wrap in a browser tab.
 */

import type { Runtime } from '../../commands/manifest.ts';
import type { ProcessGroupId, ProcessId, RequestId, TerminalId } from '../ids.ts';
import { KERNEL_PID } from '../ids.ts';
import type { VirtualSignal } from '../signals.ts';
import type { ProcessSnapshot, ProcessState } from './snapshot.ts';

/** What the kernel must know to start a process. */
export interface ProcessSpec {
  /** Resolved command name, e.g. `Get-ChildItem`. */
  readonly name: string;
  readonly commandLine: string;
  readonly cwd: string;
  readonly runtime: Runtime;
  readonly terminalId: TerminalId;
  readonly requestId: RequestId;
  readonly background: boolean;
  /** Defaults to `KERNEL_PID` — started by a terminal, not by another process. */
  readonly ppid?: ProcessId;
  /** Defaults to the new pid, making a lone process its own group leader. */
  readonly pgid?: ProcessGroupId;
}

/** Told whenever anything about a process changes, so the UI can re-render. */
export type ProcessListener = (snapshot: ProcessSnapshot) => void;

/**
 * Every process the kernel knows about, alive or awaiting reaping.
 *
 * Holds DATA ONLY. The AbortController lives in `SignalController` and the
 * pending invocation lives in the kernel, so that this table can be snapshotted
 * and sent across a worker boundary without anything being stripped out first.
 */
export class ProcessTable {
  /**
   * The next pid. Starts at 1 because 0 is the kernel, and a falsy pid would
   * make `if (pid)` a subtly wrong liveness check somewhere downstream.
   */
  #nextPid: ProcessId = 1;
  /** Snapshots are replaced wholesale rather than mutated, so a listener that
   *  keeps one keeps a consistent picture rather than a half-updated object. */
  readonly #processes = new Map<ProcessId, ProcessSnapshot>();
  readonly #listeners = new Set<ProcessListener>();
  readonly #clock: () => number;

  constructor(clock: () => number = Date.now) {
    // Injected so tests get deterministic startedAt values. A kernel that reads
    // the wall clock directly cannot be asserted against.
    this.#clock = clock;
  }

  /** The pid the next `create` will return. Exposed for tests, not for logic. */
  get nextPid(): ProcessId {
    return this.#nextPid;
  }

  create(spec: ProcessSpec): ProcessSnapshot {
    const pid = this.#nextPid;
    this.#nextPid += 1;

    const snapshot: ProcessSnapshot = Object.freeze({
      pid,
      ppid: spec.ppid ?? KERNEL_PID,
      pgid: spec.pgid ?? pid,
      name: spec.name,
      state: 'created' as ProcessState,
      cwd: spec.cwd,
      commandLine: spec.commandLine,
      startedAt: this.#clock(),
      endedAt: null,
      exitCode: null,
      runtime: spec.runtime,
      terminalId: spec.terminalId,
      requestId: spec.requestId,
      background: spec.background,
      signalled: null,
    });
    this.#processes.set(pid, snapshot);
    this.#announce(snapshot);
    return snapshot;
  }

  get(pid: ProcessId): ProcessSnapshot | undefined {
    return this.#processes.get(pid);
  }

  /** In pid order, which is start order — see the monotonicity note above. */
  list(): readonly ProcessSnapshot[] {
    return [...this.#processes.values()].sort((a, b) => a.pid - b.pid);
  }

  /** Everything still capable of doing work. What Ctrl+C and `jobs` care about. */
  live(): readonly ProcessSnapshot[] {
    return this.list().filter((p) => p.state !== 'exited');
  }

  membersOf(pgid: ProcessGroupId): readonly ProcessSnapshot[] {
    return this.list().filter((p) => p.pgid === pgid);
  }

  byTerminal(terminalId: TerminalId): readonly ProcessSnapshot[] {
    return this.list().filter((p) => p.terminalId === terminalId);
  }

  byRequest(requestId: RequestId): readonly ProcessSnapshot[] {
    return this.list().filter((p) => p.requestId === requestId);
  }

  /**
   * Move a process to a new state.
   *
   * Refuses to move OUT of `exited`. An exit is final and its code is what
   * `$LASTEXITCODE` reports; a late callback resurrecting a reaped process
   * would make that value depend on scheduling.
   */
  transition(pid: ProcessId, state: ProcessState): ProcessSnapshot | undefined {
    const current = this.#processes.get(pid);
    if (current === undefined) return undefined;
    if (current.state === 'exited') return current;
    if (current.state === state) return current;

    const next = Object.freeze({ ...current, state });
    this.#processes.set(pid, next);
    this.#announce(next);
    return next;
  }

  /**
   * Record an exit. Idempotent: the FIRST exit wins.
   *
   * Idempotence is not a nicety. A process can be SIGKILLed while its
   * invocation is still running, and that invocation will later settle and try
   * to report its own code. The kill happened first and is what the user saw,
   * so the later report must not overwrite it.
   */
  exit(
    pid: ProcessId,
    exitCode: number,
    signalled: VirtualSignal | null = null,
  ): ProcessSnapshot | undefined {
    const current = this.#processes.get(pid);
    if (current === undefined) return undefined;
    if (current.state === 'exited') return current;

    const next = Object.freeze({
      ...current,
      state: 'exited' as ProcessState,
      exitCode,
      signalled,
      endedAt: this.#clock(),
    });
    this.#processes.set(pid, next);
    this.#announce(next);
    return next;
  }

  /**
   * Drop an exited process from the table.
   *
   * Exited processes are KEPT until reaped, because `$LASTEXITCODE`,
   * `Receive-Job` and a task manager's "recently finished" list all read a
   * process after it has ended. Reaping a live process is refused rather than
   * ignored — it would orphan an AbortController that nothing can now reach.
   */
  reap(pid: ProcessId): boolean {
    const current = this.#processes.get(pid);
    if (current === undefined || current.state !== 'exited') return false;
    return this.#processes.delete(pid);
  }

  /** Reap everything that exited before `cutoff`. Returns how many went. */
  reapBefore(cutoff: number): number {
    let reaped = 0;
    for (const snapshot of this.list()) {
      if (snapshot.state === 'exited' && snapshot.endedAt !== null && snapshot.endedAt < cutoff) {
        if (this.#processes.delete(snapshot.pid)) reaped += 1;
      }
    }
    return reaped;
  }

  onChange(listener: ProcessListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #announce(snapshot: ProcessSnapshot): void {
    // Copy the listener set before iterating: a listener that unsubscribes on
    // 'exited' (the obvious thing for a UI row to do) would otherwise mutate
    // the set mid-iteration.
    for (const listener of [...this.#listeners]) listener(snapshot);
  }
}
