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
import { frozenList } from '../inspect.ts';
import type { JobView } from '../inspect.ts';

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
  /**
   * How many objects and errors this job produced that the buffer could not
   * keep. Non-zero means `Receive-Job` will return less than the job emitted,
   * and both `Get-Job` and `Receive-Job` are expected to say so. See
   * JOB_VALUE_LIMIT.
   */
  readonly droppedValues: number;
  readonly droppedErrors: number;
}

/** What `Receive-Job` hands back: the success objects and the errors, apart. */
export interface JobOutput {
  readonly values: readonly PSValue[];
  readonly errors: readonly ErrorRecord[];
  /**
   * Produced but not kept, because the buffer was full. Carried here so that
   * `Receive-Job` can report an incomplete answer AS incomplete: a suffix that
   * looks like the whole output is the failure this exists to prevent.
   */
  readonly droppedValues: number;
  readonly droppedErrors: number;
}

interface JobEntry {
  snapshot: JobSnapshot;
  values: PSValue[];
  errors: ErrorRecord[];
}

/**
 * How much a job may accumulate before the oldest is dropped.
 *
 * A KNOWN DIVERGENCE, recorded rather than hidden: real PowerShell does not
 * bound this. It is a desktop process, and a job that fills memory is the
 * user's problem to notice. This is a browser tab, where the same runaway takes
 * the page down with it — including the terminal the user would have used to
 * stop the job.
 *
 * `receive`'s docstring already says a buffer that never drained "would grow
 * without bound in a tab that stays open for days", and offered the destructive
 * default of `Receive-Job` as the answer. That is only an answer if somebody
 * runs it. A job nobody receives grew forever.
 *
 * THE OLDEST GOES, and the count of what went is kept. Two reasons for that
 * direction rather than refusing new output: a person checking on a
 * long-running job wants what it is doing NOW, and refusing is not available
 * anyway — the job has already produced the value by the time this is called.
 * What matters is that the loss is COUNTED and reaches the snapshot, so
 * `Get-Job` and `Receive-Job` can say it happened. Silently returning a
 * plausible-looking suffix is the failure mode; a suffix plus "4,213 dropped"
 * is not.
 *
 * Errors are capped separately and never compete with values for room. They are
 * rarer and worth more, and one runaway success stream must not be able to push
 * out the error that explains it.
 */
export const JOB_VALUE_LIMIT = 10_000;
export const JOB_ERROR_LIMIT = 1_000;

/** Append, dropping the oldest at the limit. Returns how many were dropped. */
function appendBounded<T>(buffer: T[], item: T, limit: number): number {
  buffer.push(item);
  if (buffer.length <= limit) return 0;
  const excess = buffer.length - limit;
  buffer.splice(0, excess);
  return excess;
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
  #view: JobView | null = null;

  constructor(clock: () => number = Date.now) {
    this.#clock = clock;
    Object.freeze(this);
  }

  /**
   * The half of this manager that cannot change a job.
   *
   * `receive` is deliberately absent even though it looks like a read: its
   * default is DESTRUCTIVE, because PowerShell's is, so anything holding this
   * could empty a job's buffer and the output would be gone before
   * `Receive-Job` ever asked for it. `peek` is `receive(id, keep = true)` under
   * a name that says what it does.
   */
  view(): JobView {
    const jobs = this;
    this.#view ??= Object.freeze({
      get nextId(): JobId {
        return jobs.nextId;
      },
      get: (id: JobId): JobSnapshot | undefined => jobs.get(id),
      byPid: (pid: ProcessId): JobSnapshot | undefined => jobs.byPid(pid),
      list: (): readonly JobSnapshot[] => jobs.list(),
      peek: (id: JobId): JobOutput => {
        const output = jobs.receive(id, true);
        // `receive` already copies; freezing stops a reader from splicing the
        // copy and handing it on as if it were what the job produced.
        return Object.freeze({
          values: frozenList(output.values),
          errors: frozenList(output.errors),
          droppedValues: output.droppedValues,
          droppedErrors: output.droppedErrors,
        });
      },
      onChange: (listener: JobListener): (() => void) => jobs.onChange(listener),
    });
    return this.#view;
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
      droppedValues: 0,
      droppedErrors: 0,
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
    const dropped = appendBounded(entry.values, value, JOB_VALUE_LIMIT);
    if (dropped > 0) this.#countDropped(entry, dropped, 0);
    this.#setHasMoreData(entry, true);
  }

  /** Buffer an error. Kept apart so `Receive-Job` can re-raise on stream 2. */
  recordError(pid: ProcessId, record: ErrorRecord): void {
    const entry = this.#entryForPid(pid);
    if (entry === undefined) return;
    const dropped = appendBounded(entry.errors, record, JOB_ERROR_LIMIT);
    if (dropped > 0) this.#countDropped(entry, 0, dropped);
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
    if (entry === undefined) return { values: [], errors: [], droppedValues: 0, droppedErrors: 0 };

    // The dropped counts are NOT reset by a drain. They describe what this job
    // produced and lost, which stays true after the buffer is emptied; zeroing
    // them here would make a second Receive-Job report a complete answer.
    const output: JobOutput = {
      values: [...entry.values],
      errors: [...entry.errors],
      droppedValues: entry.snapshot.droppedValues,
      droppedErrors: entry.snapshot.droppedErrors,
    };
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

  /**
   * Record output this job produced and the buffer could not keep.
   *
   * Announced like any other snapshot change, so a UI watching a job learns
   * that it started losing output at the moment it started -- not when someone
   * eventually runs Receive-Job and wonders why the numbers do not add up.
   */
  #countDropped(entry: JobEntry, values: number, errors: number): void {
    entry.snapshot = Object.freeze({
      ...entry.snapshot,
      droppedValues: entry.snapshot.droppedValues + values,
      droppedErrors: entry.snapshot.droppedErrors + errors,
    });
    this.#announce(entry.snapshot);
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
