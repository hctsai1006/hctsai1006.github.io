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
 *
 * That caveat is the reason the values in this file are typed `WireValue` and
 * not `PSValue`. They are two different claims — "this is a pipeline object"
 * and "this can be sent" — and a single type meaning both is how a closure ends
 * up typed as if it were data. `wire.ts` holds the wire type and the one
 * function that converts, and every payload here that could carry a `PSValue`
 * has been through it.
 *
 * ---------------------------------------------------------------------------
 * BOTH DIRECTIONS
 * ---------------------------------------------------------------------------
 *
 * Events leaving the kernel are checked by `assertCloneSafe`. Requests arriving
 * at it are DECODED by `decodeKernelRequest`, which is a different thing from
 * being type-asserted: a static type is a claim about the sender, and the
 * sender is about to become a `postMessage` from a page.
 */

import type { ProgressRecord, RedirectableStream } from '../pipeline/streams.ts';
import type { ProcessId, RequestId, TerminalId } from './ids.ts';
import type { ProcessSnapshot } from './process/snapshot.ts';
import type { VirtualSignal } from './signals.ts';
import { VIRTUAL_SIGNALS } from './signals.ts';
import type { WireErrorRecord, WireInformationRecord, WireValue } from './wire.ts';

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
// decoding a request that arrived from outside
// ---------------------------------------------------------------------------

/**
 * The ceilings a request must respect.
 *
 * TRANSPORT limits, not PowerShell semantics. Nothing here was measured against
 * pwsh and nothing here should be read as a claim about it: a real console's
 * window size is bounded by the host rather than by the language, and the
 * reference implementation has no opinion about how long a command line may be.
 * What these bound is the far side's ability to make the kernel allocate.
 */
export const REQUEST_LIMITS = {
  /** A `requestId` or `terminalId`. Long enough for a uuid and a prefix. */
  maxIdLength: 256,
  /** One command line. Longer than any line a terminal can usefully submit. */
  maxSourceLength: 64 * 1024,
  /** One `stdin` write. A larger feed arrives as several writes. */
  maxStdinBytes: 1024 * 1024,
  minColumns: 1,
  maxColumns: 10_000,
  minRows: 1,
  maxRows: 10_000,
} as const;

/** What a decode produced, or why it produced nothing. */
export type DecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problems: readonly string[] };

/** Shared so a rejected `stdin` does not allocate a buffer to throw away. */
const EMPTY_BYTES = new Uint8Array(0);

function decodeFailure(...problems: string[]): DecodeResult<never> {
  return { ok: false, problems };
}

function decodeId(value: unknown, field: string, problems: string[]): string {
  if (typeof value !== 'string') {
    problems.push(`${field} must be a string`);
    return '';
  }
  if (value.length === 0) problems.push(`${field} must not be empty`);
  else if (value.length > REQUEST_LIMITS.maxIdLength) {
    problems.push(`${field} is longer than ${REQUEST_LIMITS.maxIdLength} characters`);
  }
  return value;
}

function decodeInteger(value: unknown, field: string, problems: string[]): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    problems.push(`${field} must be an integer`);
    return 0;
  }
  return value;
}

function decodeBoundedInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
  problems: string[],
): number {
  const before = problems.length;
  const n = decodeInteger(value, field, problems);
  if (problems.length === before && (n < min || n > max)) {
    problems.push(`${field} must be between ${min} and ${max}, not ${n}`);
  }
  return n;
}

function decodeBoolean(value: unknown, field: string, problems: string[]): boolean {
  if (typeof value !== 'boolean') {
    problems.push(`${field} must be a boolean`);
    return false;
  }
  return value;
}

/**
 * Turn an arbitrary message into a `KernelRequest`, or say why it is not one.
 *
 * The kernel used to TYPE-ASSERT its input and nothing more, which is a claim
 * about the sender rather than a check on the message. That is fine while the
 * only sender is the same module in the same realm; it stops being fine the
 * moment the sender is a `postMessage` from a page, because the type says
 * nothing at runtime and the first symptom of a malformed message is a NaN
 * column width or a `bytes.length` read on a string.
 *
 * Every field is checked, and every problem is collected rather than the first
 * one thrown: a UI that has to fix its message one field per round trip is a UI
 * that will stop checking.
 *
 * NOT checked here: whether the ids refer to anything. A `stdin` for a process
 * that has already exited is a well-formed request about a process that is
 * gone, and that is the kernel's business rather than the decoder's — as is a
 * `requestId` that has been used before, which needs the kernel's own history.
 */
export function decodeKernelRequest(message: unknown): DecodeResult<KernelRequest> {
  if (typeof message !== 'object' || message === null) {
    return decodeFailure('a request must be an object');
  }
  const record = message as Record<string, unknown>;
  const kind: unknown = record['kind'];
  if (typeof kind !== 'string') return decodeFailure('kind must be a string');

  const problems: string[] = [];
  switch (kind) {
    case 'exec': {
      const requestId = decodeId(record['requestId'], 'requestId', problems);
      const terminalId = decodeId(record['terminalId'], 'terminalId', problems);
      const rawSource: unknown = record['source'];
      let source = '';
      if (typeof rawSource !== 'string') problems.push('source must be a string');
      else if (rawSource.length > REQUEST_LIMITS.maxSourceLength) {
        problems.push(`source is longer than ${REQUEST_LIMITS.maxSourceLength} characters`);
      } else source = rawSource;
      const background = decodeBoolean(record['background'], 'background', problems);
      if (problems.length > 0) return { ok: false, problems };
      return { ok: true, value: { kind: 'exec', requestId, terminalId, source, background } };
    }
    case 'stdin': {
      const processId = decodeInteger(record['processId'], 'processId', problems);
      const rawBytes: unknown = record['bytes'];
      // `instanceof` and not a structural check: a plain object with a `length`
      // would pass a duck test and then be enqueued into a byte stream.
      let bytes: Uint8Array = EMPTY_BYTES;
      if (!(rawBytes instanceof Uint8Array)) problems.push('bytes must be a Uint8Array');
      else if (rawBytes.length > REQUEST_LIMITS.maxStdinBytes) {
        problems.push(
          `bytes is ${rawBytes.length} long, over the ${REQUEST_LIMITS.maxStdinBytes}-byte limit for one write`,
        );
      } else bytes = rawBytes;
      const endOfFile = decodeBoolean(record['endOfFile'], 'endOfFile', problems);
      if (problems.length > 0) return { ok: false, problems };
      return { ok: true, value: { kind: 'stdin', processId, bytes, endOfFile } };
    }
    case 'signal': {
      // NEGATIVE is legal and load-bearing: it addresses the group led by the
      // absolute value, which is `kill()`'s own convention.
      const processId = decodeInteger(record['processId'], 'processId', problems);
      const signal: unknown = record['signal'];
      if (typeof signal !== 'string' || !(VIRTUAL_SIGNALS as readonly string[]).includes(signal)) {
        problems.push(`signal must be one of ${VIRTUAL_SIGNALS.join(', ')}`);
      }
      if (problems.length > 0) return { ok: false, problems };
      return { ok: true, value: { kind: 'signal', processId, signal: signal as VirtualSignal } };
    }
    case 'resize': {
      const terminalId = decodeId(record['terminalId'], 'terminalId', problems);
      const columns = decodeBoundedInteger(
        record['columns'],
        'columns',
        REQUEST_LIMITS.minColumns,
        REQUEST_LIMITS.maxColumns,
        problems,
      );
      const rows = decodeBoundedInteger(
        record['rows'],
        'rows',
        REQUEST_LIMITS.minRows,
        REQUEST_LIMITS.maxRows,
        problems,
      );
      if (problems.length > 0) return { ok: false, problems };
      return { ok: true, value: { kind: 'resize', terminalId, columns, rows } };
    }
    case 'cancel': {
      const requestId = decodeId(record['requestId'], 'requestId', problems);
      if (problems.length > 0) return { ok: false, problems };
      return { ok: true, value: { kind: 'cancel', requestId } };
    }
    default:
      return decodeFailure(
        `kind must be one of ${KERNEL_REQUEST_KINDS.join(', ')}, not '${kind}'`,
      );
  }
}

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
  readonly values: readonly WireValue[];
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
      readonly payload: WireErrorRecord;
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
      readonly payload: WireInformationRecord;
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

/**
 * A request the kernel would not act on.
 *
 * Its own event kind rather than an error on some process's stream, because a
 * malformed request has no process — that is what makes it malformed. Before
 * this existed a bad message was either type-asserted into the kernel and acted
 * on, or silently ignored, and both leave the UI waiting for events that will
 * never come.
 *
 * `requestId` is null when the message did not carry a usable one. There is
 * nothing else to correlate against in that case, which is exactly why the
 * problems are spelled out in full rather than summarised.
 */
export interface RejectedEvent {
  readonly kind: 'rejected';
  readonly requestId: RequestId | null;
  /** The `kind` field as it arrived, or null when it was not even a string. */
  readonly requestKind: string | null;
  readonly problems: readonly string[];
}

/**
 * An event as its call site builds it, before the kernel stamps it.
 *
 * Exported because a test that constructs a sample event should not have to
 * invent a sequence number, and because the distinction is the whole point:
 * only ONE function may assign `seq`, and this is the type of everything that
 * has not been through it.
 */
export type KernelEventBody =
  | ObjectsEvent
  | StdoutEvent
  | StderrEvent
  | StreamEvent
  | ProcessChangedEvent
  | ExitEvent
  | RejectedEvent;

/**
 * The envelope every event passes through.
 *
 * Every event already carried a process id, and none carried an ORDER. So
 * nothing downstream could reconstruct the true interleaving of `command 2>&1`
 * or of a transcript: success travels keyed by requestId, error and warning by
 * pid, stdout and stderr as bytes, and four independent streams arriving at one
 * renderer with no common ordinal can be printed in any order at all.
 *
 * `seq` is monotonic across the WHOLE kernel — not per process, not per stream,
 * not per request. Per-stream counters would order each stream against itself,
 * which is the one thing that was never in doubt.
 *
 * It is spelled as an intersection rather than a wrapper object because there
 * is exactly one payload per message: `{ seq, event }` would nest every
 * consumer's switch one level deeper for no additional information. The
 * guarantee — one assignment site — comes from `Kernel.#emit` being the only
 * place that can produce a `KernelEvent` from a `KernelEventBody`.
 */
export interface Sequenced {
  /**
   * Strictly increasing, starting at 1, never reset for the life of the kernel.
   * 0 therefore means "no event has been emitted yet" and can never be an
   * event's own number.
   */
  readonly seq: number;
}

export type KernelEvent = KernelEventBody & Sequenced;

export type KernelEventKind = KernelEventBody['kind'];

export const KERNEL_EVENT_KINDS = [
  'objects',
  'stdout',
  'stderr',
  'stream',
  'process-changed',
  'exit',
  'rejected',
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
 * The value sanitiser lives in `wire.ts`, next to the type it produces.
 *
 * Re-exported here because "how do I make this safe to send" is a question
 * about the protocol, and a caller should not have to know which file the
 * boundary happens to be implemented in.
 */
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
  sanitizePSValue,
  WireValueError,
} from './wire.ts';
