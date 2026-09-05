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
 */

export type { JobId, ProcessGroupId, ProcessId, RequestId, TerminalId } from './ids.ts';
export { KERNEL_PID } from './ids.ts';

export type {
  CancelRequest,
  DecodeResult,
  ExecRequest,
  ExitEvent,
  KernelEvent,
  KernelEventKind,
  KernelRequest,
  KernelRequestKind,
  KernelStream,
  ObjectsEvent,
  ProcessChangedEvent,
  RejectedEvent,
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
  decodeKernelRequest,
  isCloneSafe,
  KERNEL_EVENT_KINDS,
  KERNEL_REQUEST_KINDS,
  KERNEL_STREAMS,
  REQUEST_LIMITS,
  sanitizePSValue,
} from './protocol.ts';

export type {
  WireErrorRecord,
  WireInformationRecord,
  WireLimits,
  WireObject,
  WireValue,
} from './wire.ts';
export {
  DEFAULT_WIRE_LIMITS,
  sanitizeErrorRecord,
  sanitizeInformationRecord,
  WireValueError,
} from './wire.ts';

export type { ProcessSnapshot, ProcessState } from './process/snapshot.ts';
export { isFailure, isTerminated, PROCESS_STATES } from './process/snapshot.ts';
export type { ProcessListener, ProcessSpec } from './process/table.ts';
export { ProcessTable } from './process/table.ts';
export type { JobListener, JobOutput, JobSnapshot, JobState } from './process/jobs.ts';
export { isJobFinished, JobManager } from './process/jobs.ts';

export type { SignalListener, VirtualSignal } from './signals.ts';
export {
  isPipelineStopped,
  PipelineStoppedError,
  SIGNAL_EXIT_CODE,
  SIGNAL_NUMBER,
  SignalController,
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
  CapabilityBroker,
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
