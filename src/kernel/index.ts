/**
 * index.ts — the kernel's public surface, in one import.
 *
 * A barrel rather than deep imports everywhere, because the module layout below
 * is an implementation detail that will move: `process/` grows a scheduler,
 * `signals.ts` may split. Anything importing `src/kernel/index.ts` survives
 * that; anything importing `src/kernel/process/table.ts` does not.
 *
 * Explicitly NOT re-exported: nothing from `../commands/` or `../pipeline/`.
 * Those are separate contracts with their own owners, and re-exporting them
 * here would make the kernel look like the place they are defined.
 *
 * ---------------------------------------------------------------------------
 * WHAT LEFT THIS BARREL, AND WHY EACH ONE LEFT
 * ---------------------------------------------------------------------------
 *
 * This file used to export the kernel's mutating managers. Exporting a class
 * whose whole job is to change kernel state is the same defect as returning one
 * from an inspection getter, one layer up: the type says "the kernel's public
 * API", so a reader concludes it is meant to be used, and there is nothing at
 * runtime to say otherwise.
 *
 *   ProcessTable       GONE. `create`, `transition`, `exit`, `reap`. Only the
 *                      Kernel builds one; a process is created by sending an
 *                      `exec` request, not by calling `create`. `ProcessView`
 *                      is the read side and `Kernel.processes` returns it.
 *
 *   JobManager         GONE, for the same reason, plus one of its own: the
 *                      innocuous-looking `receive` DRAINS a job's buffer, so
 *                      exporting it exported the ability to make a background
 *                      job's output disappear before `Receive-Job` asked.
 *                      `JobView.peek` is the non-destructive read.
 *
 *   SignalController   GONE. `raise`, `deliver`, `interrupt`, `setForeground`.
 *                      Signals travel as `signal` requests through
 *                      `Kernel.send`, which is the only door that knows which
 *                      terminal — and therefore which foreground group — a
 *                      Ctrl+C belongs to. `SignalView` is the read side.
 *
 *   CapabilityBroker   GONE. `forCommand` mints a scoped capability object that
 *                      writes audit records under a CALLER-SUPPLIED manifest,
 *                      display name and pid. It grants nothing — both gates
 *                      still run — but forging log lines and deleting them are
 *                      the same integrity failure from opposite sides.
 *                      `CapabilityView` answers `evaluate` and `shouldAudit`
 *                      without writing anything.
 *
 *   AuditLog.clear     GONE from the class entirely, not merely from here. A
 *                      log with a public `clear` is not append-only, and
 *                      nothing in `src/` ever called it. See the note on
 *                      `AuditLog`, including what to do instead if a long
 *                      session ever makes the growth matter.
 *
 * WHAT STAYED, AND WHY IT IS NOT THE SAME QUESTION:
 *
 *   AuditLog           STAYS. `KernelOptions.audit` is how an embedder
 *                      subscribes to the log before the kernel starts, which
 *                      needs the constructor and the type. It can `append`,
 *                      which is the power to add a line to its OWN log — the
 *                      embedder is the trust root and already decides what the
 *                      session may do. What it can no longer do is remove one.
 *
 *   VirtualPolicy      STAYS, for the same construction reason
 *                      (`KernelOptions.policy`), and because its mutators are
 *                      provably harmless: `elevate()` confers exactly
 *                      `ELEVATION_CONFERS`, which is empty and is checked
 *                      against `CAPABILITY_REALITY` at load and on every grant
 *                      computation. The worst an elevation does is change a
 *                      prompt. It is frozen, so nothing can be injected into it.
 *
 * The honest limit that bounds all of this — a capability broker is not a
 * sandbox — is stated at the top of `inspect.ts` and again in `capabilities.ts`.
 */

export type { JobId, ProcessGroupId, ProcessId, RequestId, TerminalId } from './ids.ts';
export { KERNEL_PID } from './ids.ts';

export type {
  CancelRequest,
  ExecRequest,
  ExitEvent,
  KernelEvent,
  KernelEventKind,
  KernelRequest,
  KernelRequestKind,
  KernelStream,
  ObjectsEvent,
  ProcessChangedEvent,
  ResizeRequest,
  SignalRequest,
  StderrEvent,
  StdinRequest,
  StdoutEvent,
  StreamEvent,
} from './protocol.ts';
export {
  assertCloneSafe,
  cloneSafetyProblems,
  CloneUnsafeError,
  isCloneSafe,
  KERNEL_EVENT_KINDS,
  KERNEL_REQUEST_KINDS,
  KERNEL_STREAMS,
  sanitizePSValue,
} from './protocol.ts';

export type {
  AuditView,
  CapabilityView,
  JobView,
  PolicyView,
  ProcessView,
  SignalView,
} from './inspect.ts';

export type { ProcessSnapshot, ProcessState } from './process/snapshot.ts';
export { isFailure, isTerminated, PROCESS_STATES } from './process/snapshot.ts';
export type { ProcessListener, ProcessSpec } from './process/table.ts';
export type { JobListener, JobOutput, JobSnapshot, JobState } from './process/jobs.ts';
export { isJobFinished } from './process/jobs.ts';

export type { SignalListener, VirtualSignal } from './signals.ts';
export {
  isPipelineStopped,
  PipelineStoppedError,
  SIGNAL_EXIT_CODE,
  SIGNAL_NUMBER,
  VIRTUAL_SIGNALS,
} from './signals.ts';

export type {
  AuditListener,
  AuditRecord,
  CapabilityBrokerOptions,
  CapabilityDecision,
  ElevationResult,
  ScopedCapabilities,
} from './capabilities.ts';
export {
  assertElevationCannotConferReality,
  AuditLog,
  CAPABILITY_AUDITED,
  CAPABILITY_REALITY,
  ELEVATION_CONFERS,
  ELEVATION_DISCLOSURE,
  ElevationScopeError,
  isGranted,
  REAL_CAPABILITIES,
  RISK_AUDITED,
  VIRTUAL_CAPABILITIES,
  VirtualPolicy,
} from './capabilities.ts';

export type { KernelEventListener, KernelOptions } from './kernel.ts';
export {
  EXIT_COMMAND_NOT_FOUND,
  EXIT_FAILURE,
  Kernel,
  splitPipeline,
  splitTokens,
} from './kernel.ts';
