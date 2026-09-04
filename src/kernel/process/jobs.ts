/**
 * jobs.ts — background work that outlives the prompt.
 *
 * A job is NOT a process, and this file exists because conflating the two is
 * the easy mistake. A process is the kernel's unit of execution and signalling.
 * A job is PowerShell's user-facing handle onto a backgrounded one: it has its
 * own id space, its own state machine, and — the part that actually forces a
 * separate object — its own OUTPUT BUFFER.
 *
 * The buffer is the whole point of `Receive-Job`. A foreground pipeline writes
 * straight to the terminal because someone is watching. A background job has no
 * reader, so its objects have to go somewhere until `Receive-Job` asks for
 * them; that is what `HasMoreData` reports on. Without a buffer, backgrounding
 * a command would mean discarding its results, which is not backgrounding.
 *
 * Two fidelity notes worth keeping:
 *
 *   - Job ids are their OWN monotonic sequence, not pids. `Stop-Job 3` means
 *     job 3. Sharing a counter with the process table would make that command
 *     able to stop an unrelated foreground pipeline that happened to get pid 3.
 *
 *   - PowerShell's Job also carries an `InstanceId` GUID. We deliberately do
 *     not mint one. The reason is the same as for pids and is recorded in
 *     `table.ts`: PowerShell 7.7 changes `New-Guid` to UUIDv7 by default, so a
 *     guid in kernel state would inherit a version-dependent shape from a
 *     command we are emulating. If `Get-Job` ever needs to print an InstanceId
 *     it should come from an explicit kernel-owned generator, never from the
 *     emulated command.
 */

import type { PSValue } from '../../pipeline/psobject.ts';
import type { ErrorRecord } from '../../pipeline/streams.ts';
import type { JobId, ProcessId } from '../ids.ts';

/**
 * PowerShell's own `JobState` names, in PowerShell's own casing, because
 * `Get-Job` prints them and scripts compare against them as strings.
 *
 * Only the states this kernel can actually reach are listed. PowerShell also
 * has Suspended, Disconnected and AtBreakpoint; none of them is reachable
 * without a debugger or a remoting session, and declaring a state we can never
 * enter would be a claim we cannot keep.
 */
export type JobState =
  | 'NotStarted'
  | 'Running'
  | 'Blocked'
  | 'Stopping'
  | 'Stopped'
  | 'Completed'
  | 'Failed';

/** A job as the UI and `Get-Job` see it: data only, clone-safe. */
export interface JobSnapshot {
  readonly id: JobId;
  /** `Job1`, `Job2`, … — PowerShell's own naming. */
  readonly name: string;
  /** The process doing the work. Null once it has been reaped. */
  readonly pid: ProcessId | null;
  readonly state: JobState;
  /** Whether `Receive-Job` would return anything. */
  readonly hasMoreData: boolean;
  /** The source that was backgrounded. What `Get-Job` shows under Command. */
  readonly command: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly exitCode: number | null;
}

/** What `Receive-Job` hands back: the success objects and the errors, apart. */
export interface JobOutput {
  readonly values: readonly PSValue[];
  readonly errors: readonly ErrorRecord[];
}

interface JobEntry {
  snapshot: JobSnapshot;
  values: PSValue[];
  errors: ErrorRecord[];
}

export type JobListener = (snapshot: JobSnapshot) => void;

/** Which job states mean the job is finished and will produce nothing more. */
const TERMINAL_STATES: ReadonlySet<JobState> = new Set<JobState>([
  'Stopped',
  'Completed',
  'Failed',
]);

export function isJobFinished(state: JobState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Tracks background jobs and buffers what they produce.
 *
 * Deliberately knows nothing about how a process runs — it is told. The kernel
 * owns execution; this owns the user-visible bookkeeping, so `Get-Job` can be
 * implemented against it without the command layer touching the process table.
 */
export class JobManager {
  /** Separate from the pid counter. See the header. */
  #nextId: JobId = 1;
  readonly #jobs = new Map<JobId, JobEntry>();
  readonly #byPid = new Map<ProcessId, JobId>();
  readonly #listeners = new Set<JobListener>();
  readonly #clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.#clock = clock;
  }

  get nextId(): JobId {
    return this.#nextId;
  }

  /** Register a backgrounded process as a job. */
  start(pid: ProcessId, command: string): JobSnapshot {
    const id = this.#nextId;
    this.#nextId += 1;

    const snapshot: JobSnapshot = Object.freeze({
      id,
      name: `Job${id}`,
      pid,
      // 'Running' rather than 'NotStarted': by the time a job exists the kernel
      // has already created its process. 'NotStarted' is kept in the union for
      // a future `Start-Job -Suspended`-shaped path, not asserted here.
      state: 'Running' as JobState,
      hasMoreData: false,
      command,
      startedAt: this.#clock(),
      endedAt: null,
      exitCode: null,
    });
    this.#jobs.set(id, { snapshot, values: [], errors: [] });
    this.#byPid.set(pid, id);
    this.#announce(snapshot);
    return snapshot;
  }

  get(id: JobId): JobSnapshot | undefined {
    return this.#jobs.get(id)?.snapshot;
  }

  byPid(pid: ProcessId): JobSnapshot | undefined {
    const id = this.#byPid.get(pid);
    return id === undefined ? undefined : this.#jobs.get(id)?.snapshot;
  }

  /** In id order, which is start order. What `Get-Job` lists. */
  list(): readonly JobSnapshot[] {
    return [...this.#jobs.values()].map((e) => e.snapshot).sort((a, b) => a.id - b.id);
  }

  /** Buffer a success-stream object produced by a job. */
  record(pid: ProcessId, value: PSValue): void {
    const entry = this.#entryForPid(pid);
    if (entry === undefined) return;
    entry.values.push(value);
    this.#setHasMoreData(entry, true);
  }

  /** Buffer an error. Kept apart so `Receive-Job` can re-raise on stream 2. */
  recordError(pid: ProcessId, record: ErrorRecord): void {
    const entry = this.#entryForPid(pid);
    if (entry === undefined) return;
    entry.errors.push(record);
    this.#setHasMoreData(entry, true);
  }

  /**
   * Drain a job's buffer, as `Receive-Job` does.
   *
   * `keep` mirrors `Receive-Job -Keep`. The DEFAULT is destructive because
   * PowerShell's is: a second `Receive-Job` without `-Keep` returns nothing,
   * and a buffer that never drained would grow without bound in a tab that
   * stays open for days.
   */
  receive(id: JobId, keep = false): JobOutput {
    const entry = this.#jobs.get(id);
    if (entry === undefined) return { values: [], errors: [] };

    const output: JobOutput = { values: [...entry.values], errors: [...entry.errors] };
    if (!keep) {
      entry.values.length = 0;
      entry.errors.length = 0;
      this.#setHasMoreData(entry, false);
    }
    return output;
  }

  /** Move a job to a new state. Refuses to move out of a terminal one. */
  transition(id: JobId, state: JobState): JobSnapshot | undefined {
    const entry = this.#jobs.get(id);
    if (entry === undefined) return undefined;
    if (isJobFinished(entry.snapshot.state)) return entry.snapshot;
    if (entry.snapshot.state === state) return entry.snapshot;

    entry.snapshot = Object.freeze({ ...entry.snapshot, state });
    this.#announce(entry.snapshot);
    return entry.snapshot;
  }

  /**
   * Record that the job's process ended.
   *
   * The state is derived rather than passed in, so that "exit code 0 means
   * Completed" is decided in exactly one place. A job stopped by a signal is
   * `Stopped`, NOT `Failed` — PowerShell separates "you stopped it" from "it
   * broke", and `Get-Job` showing Failed for a Ctrl+C would misreport what
   * happened.
   */
  finish(pid: ProcessId, exitCode: number, signalled: boolean): JobSnapshot | undefined {
    const entry = this.#entryForPid(pid);
    if (entry === undefined) return undefined;
    if (isJobFinished(entry.snapshot.state)) return entry.snapshot;

    const state: JobState = signalled ? 'Stopped' : exitCode === 0 ? 'Completed' : 'Failed';
    entry.snapshot = Object.freeze({
      ...entry.snapshot,
      state,
      exitCode,
      endedAt: this.#clock(),
    });
    this.#announce(entry.snapshot);
    return entry.snapshot;
  }

  /**
   * Forget a job, as `Remove-Job` does.
   *
   * Refuses while the job is still running unless `force`, which is
   * `Remove-Job -Force`. Silently discarding a running job's buffer would lose
   * output the user could still have received.
   */
  remove(id: JobId, force = false): boolean {
    const entry = this.#jobs.get(id);
    if (entry === undefined) return false;
    if (!force && !isJobFinished(entry.snapshot.state)) return false;
    if (entry.snapshot.pid !== null) this.#byPid.delete(entry.snapshot.pid);
    return this.#jobs.delete(id);
  }

  onChange(listener: JobListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #entryForPid(pid: ProcessId): JobEntry | undefined {
    const id = this.#byPid.get(pid);
    return id === undefined ? undefined : this.#jobs.get(id);
  }

  #setHasMoreData(entry: JobEntry, hasMoreData: boolean): void {
    if (entry.snapshot.hasMoreData === hasMoreData) return;
    entry.snapshot = Object.freeze({ ...entry.snapshot, hasMoreData });
    this.#announce(entry.snapshot);
  }

  #announce(snapshot: JobSnapshot): void {
    for (const listener of [...this.#listeners]) listener(snapshot);
  }
}
