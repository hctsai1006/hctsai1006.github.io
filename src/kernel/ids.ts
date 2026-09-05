/**
 * ids.ts — the identifier types the kernel hands out, in one place.
 *
 * Kept apart from the modules that use them so that `protocol.ts`,
 * `signals.ts` and `process/snapshot.ts` can all name a pid without importing
 * one another. Three modules that each need the same alias will otherwise grow
 * an import cycle, and a cycle between the protocol and the process model is
 * exactly the kind of knot that makes a worker boundary hard to draw later.
 */

/**
 * A process identifier.
 *
 * A MONOTONIC INTEGER, deliberately, and never a GUID. The reasoning is
 * recorded at the allocator in `process/table.ts`, because that is where
 * someone would be tempted to reach for a guid generator.
 */
export type ProcessId = number;

/**
 * Reserved for the kernel itself. A process whose ppid is 0 was started
 * directly by a terminal rather than by another process, which mirrors POSIX
 * where pid 1's parent is 0. Using 0 rather than `null` keeps every pid field
 * a plain integer, so `ppid` never needs a null check just to be compared.
 */
export const KERNEL_PID: ProcessId = 0;

/**
 * A process group. Always the pid of the group leader, as in POSIX — a
 * pipeline's first process leads the group its later stages join.
 */
export type ProcessGroupId = ProcessId;

/** One terminal pane. The UI mints these; the kernel only ever compares them. */
export type TerminalId = string;

/**
 * Correlates a submitted `exec` with the events it produces.
 *
 * The UI mints this too, and it must: between sending `exec` and receiving the
 * first `process-changed` there is no pid yet, so a request that fails during
 * lookup has nothing but this to be reported against.
 */
export type RequestId = string;

/**
 * A background job's id.
 *
 * A SEPARATE NUMBER SPACE from pids, because PowerShell's is. `Stop-Job 3`
 * addresses job 3, which is not pid 3, and folding the two would make
 * `Stop-Job` able to kill an unrelated foreground pipeline.
 */
export type JobId = number;
