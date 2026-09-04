/**
 * protocol.ts — every message that crosses the UI ↔ kernel boundary.
 *
 * In the v1 terminal there is no boundary. `run()` parses the line, executes
 * it, and writes to the DOM from inside the command, all on the UI thread. A
 * command that loops for a second freezes the page, and a command that streams
 * — `ping`, `traceroute` — cannot be composed at all; index.html literally
 * refuses to put one in a pipeline rather than model it:
 *
 *     這個指令是逐行串流輸出,不能用在管線中。
 *
 * This file is the seam that makes that modellable. Execution becomes a
 * conversation: the UI sends REQUESTS, the kernel sends EVENTS, and neither
 * calls into the other. That is what lets execution move to a Worker later
 * without a single command changing, and what makes a streaming command
 * ordinary rather than special.
 *
 * ---------------------------------------------------------------------------
 * THE STRUCTURED-CLONE CONSTRAINT
 * ---------------------------------------------------------------------------
 *
 * Every value in this file will eventually be passed to `postMessage`, so it
 * must survive the structured clone algorithm. Concretely, and enforced by
 * `assertCloneSafe` below:
 *
 *   NO FUNCTIONS.  A callback would throw DataCloneError at the boundary. This
 *   is why nothing here is a Sink, a promise or a listener: the reply is an
 *   event, correlated by id, not a resolved callback.
 *
 *   NO CLASS INSTANCES.  Structured clone copies own enumerable properties and
 *   drops the prototype, so a `CapabilityDeniedError` arrives as a plain object
 *   and every `instanceof` on the far side silently stops matching. Errors
 *   therefore travel as `ErrorRecord`, which is a shape rather than a class —
 *   and which the reference implementation also treats as data.
 *
 *   NO `undefined`.  Structured clone would happily carry `{ a: undefined }`,
 *   so this rule is not about survival — it is about ambiguity. A field that
 *   can be either absent or present-and-undefined has two encodings for one
 *   meaning, and a receiver will eventually handle one and not the other.
 *   So: every field of every envelope in this file is REQUIRED, and anything
 *   that can be missing is typed `| null` instead of `?`.
 *
 *   The exception is the record types imported from the pipeline contract —
 *   `ErrorRecord.targetObject`, `ErrorRecord.invocation` — which are optional
 *   there and must not be redefined here. `exactOptionalPropertyTypes` makes
 *   those unambiguous in the other direction: an optional key is ABSENT, never
 *   present-and-undefined, so the two encodings never both occur.
 *
 * What IS allowed: null, boolean, number, bigint, string, Date, ArrayBuffer and
 * typed arrays (so `Uint8Array` byte channels stay bytes), Array, Map, Set, and
 * plain objects. That is exactly the subset `PSValue` uses, with one caveat:
 * `PSObject.baseObject` holds a host value that is NOT clone-safe by design.
 * `sanitizePSValue` strips it, and the kernel calls that on the way out.
 */

import type { PSObject, PSValue } from '../pipeline/psobject.ts';
import { isPSObject } from '../pipeline/psobject.ts';
import type {
  ErrorRecord,
  InformationRecord,
  ProgressRecord,
  RedirectableStream,
} from '../pipeline/streams.ts';
import type { ProcessId, RequestId, TerminalId } from './ids.ts';
import type { ProcessSnapshot } from './process/snapshot.ts';
import type { VirtualSignal } from './signals.ts';

// ---------------------------------------------------------------------------
// streams on the wire
// ---------------------------------------------------------------------------

/**
 * The streams that travel per-process as `stream` events.
 *
 * PowerShell has seven streams: the six numbered ones plus Progress, which is
 * deliberately unnumbered because there is no `7>`. Success (stream 1) is NOT
 * in this list — it travels as an `objects` event keyed by requestId, because
 * success is the PIPELINE'S result and the terminal renders it as one thing,
 * whereas an error or a warning belongs to the specific stage that raised it
 * and is useless without knowing which. That leaves exactly six here.
 *
 * The `satisfies` clause is load-bearing: it proves at compile time that every
 * name is a real stream name from the pipeline contract, so renaming a stream
 * in `streams.ts` breaks this file rather than quietly desynchronising it.
 */
export const KERNEL_STREAMS = [
  'error',
  'warning',
  'verbose',
  'debug',
  'information',
  'progress',
] as const satisfies readonly (Exclude<RedirectableStream, 'success'> | 'progress')[];

export type KernelStream = (typeof KERNEL_STREAMS)[number];

// ---------------------------------------------------------------------------
// requests: UI -> kernel
// ---------------------------------------------------------------------------

/**
 * Run something.
 *
 * `requestId` is minted by the UI and not by the kernel, because between
 * sending this and receiving the first `process-changed` there is no pid yet.
 * A request that dies during command lookup has nothing else to be reported
 * against, and "the terminal printed nothing and never found out why" is
 * exactly the failure mode a correlation id exists to prevent.
 */
export interface ExecRequest {
  readonly kind: 'exec';
  readonly requestId: RequestId;
  readonly terminalId: TerminalId;
  /** The raw command line. Parsing belongs to the kernel, not to the UI. */
  readonly source: string;
  /**
   * Background (`&`, `Start-Job`) rather than foreground.
   *
   * Required rather than optional because it decides whether the process joins
   * the terminal's foreground group — which is what decides whether Ctrl+C
   * reaches it. A default would make the most consequential property of an
   * execution implicit.
   */
  readonly background: boolean;
}

/**
 * Feed a process's stdin.
 *
 * Bytes, not text. Since PowerShell 7.4 the raw bytes between a native command
 * and a file are preserved rather than decoded and re-encoded, and a UTF-16
 * round trip through the message boundary is the one thing that would undo
 * that. `endOfFile` is a separate flag rather than a zero-length write, because
 * a zero-length write is a legitimate thing to do and must not mean EOF.
 */
export interface StdinRequest {
  readonly kind: 'stdin';
  readonly processId: ProcessId;
  readonly bytes: Uint8Array;
  readonly endOfFile: boolean;
}

/**
 * Deliver a signal.
 *
 * A NEGATIVE `processId` addresses the process group led by its absolute
 * value, which is `kill()`'s own convention. That is how Ctrl+C reaches an
 * entire pipeline through a field that is still just a number — the alternative
 * would be a second `target` field that could disagree with the first.
 */
export interface SignalRequest {
  readonly kind: 'signal';
  readonly processId: ProcessId;
  readonly signal: VirtualSignal;
}

/**
 * The terminal changed size.
 *
 * Not cosmetic. `Format-Table` column widths, `$Host.UI.RawUI.WindowSize` and
 * text wrapping all read this, and the kernel cannot measure a DOM it is not
 * allowed to touch — so the size has to be told to it. Columns and rows are
 * character cells, not pixels.
 */
export interface ResizeRequest {
  readonly kind: 'resize';
  readonly terminalId: TerminalId;
  readonly columns: number;
  readonly rows: number;
}

/**
 * Abandon a request.
 *
 * Distinct from `signal`, and not redundant with it: `cancel` addresses a
 * REQUEST, which exists from the moment it is sent, whereas a signal addresses
 * a PROCESS, which may not exist yet. Cancelling in that window — the user hits
 * Ctrl+C while the kernel is still resolving the command name — has no pid to
 * name, and folding the two would leave that gap unhandled.
 */
export interface CancelRequest {
  readonly kind: 'cancel';
  readonly requestId: RequestId;
}

export type KernelRequest =
  | ExecRequest
  | StdinRequest
  | SignalRequest
  | ResizeRequest
  | CancelRequest;

export type KernelRequestKind = KernelRequest['kind'];

export const KERNEL_REQUEST_KINDS = [
  'exec',
  'stdin',
  'signal',
  'resize',
  'cancel',
] as const satisfies readonly KernelRequestKind[];

// ---------------------------------------------------------------------------
// events: kernel -> UI
// ---------------------------------------------------------------------------

/**
 * Objects on the success stream.
 *
 * Keyed by `requestId`, not by pid: the success stream is the pipeline's
 * output, and which stage produced it is not something the terminal renders.
 *
 * `values` is an array even when the kernel emits one object at a time. That is
 * so batching can be added in the transport later — `postMessage` per object is
 * a real cost across a worker — without a protocol change, and so a receiver
 * written today already handles the batched case.
 */
export interface ObjectsEvent {
  readonly kind: 'objects';
  readonly requestId: RequestId;
  readonly values: readonly PSValue[];
}

/** Native stdout bytes. Kept as bytes for the reason in `StdinRequest`. */
export interface StdoutEvent {
  readonly kind: 'stdout';
  readonly processId: ProcessId;
  readonly bytes: Uint8Array;
}

export interface StderrEvent {
  readonly kind: 'stderr';
  readonly processId: ProcessId;
  readonly bytes: Uint8Array;
}

/**
 * One of the six per-process streams.
 *
 * Discriminated twice — on `kind` and then on `which` — so the payload type is
 * decided by the stream name. A single `payload: unknown` would have made every
 * consumer cast, and a cast is where an ErrorRecord starts being rendered as a
 * warning string.
 */
export type StreamEvent =
  | {
      readonly kind: 'stream';
      readonly processId: ProcessId;
      readonly which: 'error';
      readonly payload: ErrorRecord;
    }
  | {
      readonly kind: 'stream';
      readonly processId: ProcessId;
      readonly which: 'warning' | 'verbose' | 'debug';
      readonly payload: string;
    }
  | {
      readonly kind: 'stream';
      readonly processId: ProcessId;
      readonly which: 'information';
      readonly payload: InformationRecord;
    }
  | {
      readonly kind: 'stream';
      readonly processId: ProcessId;
      readonly which: 'progress';
      readonly payload: ProgressRecord;
    };

/**
 * A process appeared, changed state, or ended.
 *
 * The whole snapshot rather than a delta. A delta would need the receiver to
 * hold state that can drift from the kernel's, and the first symptom of that
 * drift is a task manager showing a process that exited minutes ago.
 */
export interface ProcessChangedEvent {
  readonly kind: 'process-changed';
  readonly snapshot: ProcessSnapshot;
}

/**
 * A process ended, with the code `$LASTEXITCODE` will report.
 *
 * Redundant with the final `process-changed` on purpose. This is the event a
 * caller awaits, and making it its own kind means "wait for completion" is not
 * "watch every snapshot and filter" — which is the version everybody gets
 * subtly wrong when a process exits before they subscribe.
 */
export interface ExitEvent {
  readonly kind: 'exit';
  readonly processId: ProcessId;
  readonly requestId: RequestId;
  readonly exitCode: number;
  /** The signal that stopped it, or null if it finished on its own. */
  readonly signalled: VirtualSignal | null;
}

export type KernelEvent =
  | ObjectsEvent
  | StdoutEvent
  | StderrEvent
  | StreamEvent
  | ProcessChangedEvent
  | ExitEvent;

export type KernelEventKind = KernelEvent['kind'];

export const KERNEL_EVENT_KINDS = [
  'objects',
  'stdout',
  'stderr',
  'stream',
  'process-changed',
  'exit',
] as const satisfies readonly KernelEventKind[];

// ---------------------------------------------------------------------------
// honouring the constraint
// ---------------------------------------------------------------------------

/** Thrown when a message would not survive `postMessage`. */
export class CloneUnsafeError extends Error {
  readonly problems: readonly string[];
  constructor(label: string, problems: readonly string[]) {
    super(
      `${label} is not structured-clone safe and would not survive postMessage:\n` +
        problems.map((p) => `  - ${p}`).join('\n'),
    );
    this.name = 'CloneUnsafeError';
    this.problems = problems;
  }
}

function inspect(value: object): string {
  const name: unknown = (value as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof name === 'string' && name.length > 0 ? name : 'object';
}

function collectProblems(value: unknown, path: string, seen: Set<object>, out: string[]): void {
  if (value === null) return;

  switch (typeof value) {
    case 'boolean':
    case 'number':
    case 'bigint':
    case 'string':
      return;
    case 'undefined':
      // Not a clone failure — a MEANING failure. See the header.
      out.push(`${path} is undefined; use null so "absent" has one encoding`);
      return;
    case 'function':
      out.push(`${path} is a function; the protocol carries data, replies are events`);
      return;
    case 'symbol':
      out.push(`${path} is a symbol; structured clone cannot carry one`);
      return;
    default:
      break;
  }

  const object = value as object;
  // Cycles are fine for structured clone, which preserves them. They are not
  // fine for this walker, so remember what has been visited.
  if (seen.has(object)) return;
  seen.add(object);

  // Typed arrays and DataViews clone verbatim, which is what keeps a byte
  // channel a byte channel across the boundary.
  if (object instanceof Date || object instanceof ArrayBuffer) return;
  if (ArrayBuffer.isView(object)) return;
  if (object instanceof Error) {
    out.push(`${path} is an Error; use an ErrorRecord so the far side can still branch on it`);
    return;
  }
  if (Array.isArray(object)) {
    for (const [index, item] of object.entries()) {
      collectProblems(item, `${path}[${index}]`, seen, out);
    }
    return;
  }
  if (object instanceof Map) {
    let index = 0;
    for (const [key, entry] of object) {
      collectProblems(key, `${path}.key(${index})`, seen, out);
      collectProblems(entry, `${path}.value(${index})`, seen, out);
      index += 1;
    }
    return;
  }
  if (object instanceof Set) {
    let index = 0;
    for (const entry of object) {
      collectProblems(entry, `${path}.member(${index})`, seen, out);
      index += 1;
    }
    return;
  }

  const proto: unknown = Object.getPrototypeOf(object);
  if (proto !== Object.prototype && proto !== null) {
    out.push(
      `${path} is an instance of ${inspect(object)}; structured clone drops the prototype ` +
        'and every instanceof on the far side would stop matching',
    );
    return;
  }
  if (Object.getOwnPropertySymbols(object).length > 0) {
    out.push(`${path} has symbol-keyed properties, which structured clone silently drops`);
  }

  const record = object as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    collectProblems(record[key], `${path}.${key}`, seen, out);
  }
}

/** Every rule the header states, checked. Returns the reasons, empty if fine. */
export function cloneSafetyProblems(value: unknown, label = 'value'): readonly string[] {
  const problems: string[] = [];
  collectProblems(value, label, new Set(), problems);
  return problems;
}

export function isCloneSafe(value: unknown): boolean {
  return cloneSafetyProblems(value).length === 0;
}

/**
 * Throw unless `value` obeys the constraint.
 *
 * Used by the kernel in dev, and by the tests on every event kind. Checking
 * rather than trusting matters because the failure this prevents is
 * asymmetric: a DataCloneError at `postMessage` names the message, not the
 * command that built it, and by then the offending value is three layers away.
 */
export function assertCloneSafe(value: unknown, label = 'message'): void {
  const problems = cloneSafetyProblems(value, label);
  if (problems.length > 0) throw new CloneUnsafeError(label, problems);
}

/**
 * Make a `PSValue` safe to send.
 *
 * The only offender is `PSObject.baseObject`, which exists precisely so a
 * command can reach the underlying host value — a File handle, a Response, a
 * DOM-free stand-in for one. That is useful inside the kernel and meaningless
 * outside it, so it is dropped at the boundary rather than being banned from
 * the object model.
 *
 * Returns the SAME reference when nothing needed stripping, so the common case
 * costs one walk and no allocation.
 */
export function sanitizePSValue(value: PSValue): PSValue {
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const next = sanitizePSValue(item as PSValue);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? items : value;
  }
  if (!isPSObject(value)) return value;

  let changed = value.baseObject !== undefined;
  const properties: Record<string, PSValue> = {};
  for (const [key, property] of Object.entries(value.properties)) {
    const next = sanitizePSValue(property);
    if (next !== property) changed = true;
    properties[key] = next;
  }
  if (!changed) return value;

  // Rebuilt without `baseObject`, so the key is ABSENT rather than present and
  // undefined — the same rule the envelopes follow.
  const stripped: PSObject = { typeNames: value.typeNames, properties };
  return stripped;
}
