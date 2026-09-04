/**
 * streams.ts — the six PowerShell streams, plus the native byte channel.
 *
 * The v1 terminal has one output channel: a command returns rendered rows, and
 * everything it wants to say — a result, a warning, an error — arrives on it.
 * That collapses distinctions PowerShell treats as fundamental. `2>&1` cannot
 * mean anything if there is no stream 2, and a command that prints its own
 * error cannot have that error caught, counted, or suppressed.
 *
 * The numbering is PowerShell's own and is load-bearing, because it is the
 * syntax users type:
 *
 *   1  Success       objects, the pipeline itself
 *   2  Error         ErrorRecord
 *   3  Warning       text
 *   4  Verbose       text, off unless asked for
 *   5  Debug         text, off unless asked for
 *   6  Information   InformationRecord (Write-Host writes here)
 *   -  Progress      NOT redirectable, and deliberately has no number
 *
 * Progress being non-redirectable is a real constraint, not an omission: there
 * is no `7>` in PowerShell. Modelling it as just another numbered stream would
 * invite a redirection syntax that does not exist.
 *
 * The native byte channel is separate on purpose. Since PowerShell 7.4 the raw
 * bytes between a native command and a file are preserved rather than being
 * decoded to text and re-encoded. Decoding once, wrongly, is not recoverable —
 * so bytes stay bytes until something asks for text and says which encoding.
 */

import type { PSObject, PSValue } from './psobject.ts';

/** The redirectable streams, by the number users actually type. */
export const STREAM_NUMBER = {
  success: 1,
  error: 2,
  warning: 3,
  verbose: 4,
  debug: 5,
  information: 6,
} as const;

export type RedirectableStream = keyof typeof STREAM_NUMBER;

/**
 * PowerShell's error categories. Used by `$Error[0].CategoryInfo` and by
 * `-ErrorAction`; a differential test compares these against the reference
 * implementation, so they are the real names rather than approximations.
 */
export type ErrorCategory =
  | 'NotSpecified'
  | 'OpenError'
  | 'CloseError'
  | 'DeviceError'
  | 'DeadlockDetected'
  | 'InvalidArgument'
  | 'InvalidData'
  | 'InvalidOperation'
  | 'InvalidResult'
  | 'InvalidType'
  | 'MetadataError'
  | 'NotImplemented'
  | 'NotInstalled'
  | 'ObjectNotFound'
  | 'OperationStopped'
  | 'OperationTimeout'
  | 'SyntaxError'
  | 'ParserError'
  | 'PermissionDenied'
  | 'ResourceBusy'
  | 'ResourceExists'
  | 'ResourceUnavailable'
  | 'ReadError'
  | 'WriteError'
  | 'FromStdErr'
  | 'SecurityError'
  | 'ProtocolError'
  | 'ConnectionError'
  | 'AuthenticationError'
  | 'LimitsExceeded'
  | 'QuotaExceeded'
  | 'NotEnabled';

/**
 * PowerShell's ErrorRecord. The shape matters: scripts branch on
 * `FullyQualifiedErrorId` and on the category, so an error that carries only a
 * message is not catchable in the ways the language allows.
 */
export interface ErrorRecord {
  message: string;
  /**
   * The id PowerShell composes as `<ErrorId>,<CommandName>`. Scripts match on
   * it, so it is part of the observable contract rather than a debug aid.
   */
  fullyQualifiedErrorId: string;
  category: ErrorCategory;
  /** The thing the error is about, when there is one. */
  targetObject?: PSValue;
  /** The .NET exception type name, for `-ErrorAction` and `catch` filtering. */
  exceptionType: string;
  /** Where it happened, once the parser can say. */
  invocation?: { line: number; column: number; source: string };
}

/** Write-Host and Write-Information both land here. */
export interface InformationRecord {
  message: PSValue;
  tags: readonly string[];
  source: string;
  timestamp: number;
}

export interface ProgressRecord {
  activityId: number;
  activity: string;
  status: string;
  /** 0-100, or -1 for indeterminate, matching PowerShell's own convention. */
  percentComplete: number;
  parentActivityId?: number;
  completed: boolean;
}

// ---------------------------------------------------------------------------
// sinks
// ---------------------------------------------------------------------------

/**
 * Somewhere to put values. Async so a slow consumer can push back on a fast
 * producer: a command emitting a million objects must not be able to exhaust
 * memory because the terminal renders more slowly than the loop runs.
 */
export interface Sink<T> {
  write(value: T): Promise<void>;
  /** True once the consumer has stopped caring — lets a producer give up early. */
  readonly closed: boolean;
}

export interface PowerShellStreams {
  success: Sink<PSValue>;
  error: Sink<ErrorRecord>;
  warning: Sink<string>;
  verbose: Sink<string>;
  debug: Sink<string>;
  information: Sink<InformationRecord>;
  /** Not redirectable. There is no `7>` in PowerShell, and there must not be one here. */
  progress: Sink<ProgressRecord>;
}

/**
 * The raw byte channel, kept apart from the object streams.
 *
 * Native command output must survive as bytes. A UTF-16 round trip through the
 * object pipeline corrupts anything that is not text, and there is no way to
 * tell afterwards that it happened.
 */
export interface NativeStreams {
  stdin: ReadableStream<Uint8Array> | null;
  stdout: WritableStream<Uint8Array>;
  stderr: WritableStream<Uint8Array>;
}

// ---------------------------------------------------------------------------
// implementations
// ---------------------------------------------------------------------------

/** Collects everything written. The backbone of testing a command's output. */
export class CollectingSink<T> implements Sink<T> {
  readonly values: T[] = [];
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  write(value: T): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.values.push(value);
    return Promise.resolve();
  }

  close(): void {
    this.#closed = true;
  }
}

/** Discards everything. What `Out-Null` and a disabled Verbose stream use. */
export class NullSink<T> implements Sink<T> {
  readonly closed = false;
  write(): Promise<void> {
    return Promise.resolve();
  }
}

/** Hands each value to a callback as it arrives. */
export class CallbackSink<T> implements Sink<T> {
  #closed = false;
  readonly #onValue: (value: T) => void | Promise<void>;

  constructor(onValue: (value: T) => void | Promise<void>) {
    this.#onValue = onValue;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async write(value: T): Promise<void> {
    if (this.#closed) return;
    await this.#onValue(value);
  }

  close(): void {
    this.#closed = true;
  }
}

/**
 * A stream set that keeps everything, for tests and for the difference explorer.
 *
 * Verbose and Debug are collected rather than dropped: whether they are SHOWN
 * is a rendering decision driven by `-Verbose` and `$VerbosePreference`, and
 * discarding them at the sink would make that decision unreachable.
 */
export function collectingStreams(): PowerShellStreams & {
  collected: {
    success: CollectingSink<PSValue>;
    error: CollectingSink<ErrorRecord>;
    warning: CollectingSink<string>;
    verbose: CollectingSink<string>;
    debug: CollectingSink<string>;
    information: CollectingSink<InformationRecord>;
    progress: CollectingSink<ProgressRecord>;
  };
} {
  const collected = {
    success: new CollectingSink<PSValue>(),
    error: new CollectingSink<ErrorRecord>(),
    warning: new CollectingSink<string>(),
    verbose: new CollectingSink<string>(),
    debug: new CollectingSink<string>(),
    information: new CollectingSink<InformationRecord>(),
    progress: new CollectingSink<ProgressRecord>(),
  };
  return { ...collected, collected };
}

/** Build an ErrorRecord with the fields PowerShell always populates. */
export function errorRecord(
  message: string,
  errorId: string,
  commandName: string,
  category: ErrorCategory = 'NotSpecified',
  extra: Partial<Pick<ErrorRecord, 'targetObject' | 'exceptionType' | 'invocation'>> = {},
): ErrorRecord {
  return {
    message,
    // PowerShell composes this as `<ErrorId>,<CommandName>`, and scripts match
    // on the composed form.
    fullyQualifiedErrorId: `${errorId},${commandName}`,
    category,
    exceptionType: extra.exceptionType ?? 'System.Exception',
    ...(extra.targetObject !== undefined ? { targetObject: extra.targetObject } : {}),
    ...(extra.invocation !== undefined ? { invocation: extra.invocation } : {}),
  };
}

/** Is this object a PSObject the success stream can carry unchanged? */
export type SuccessValue = PSValue | PSObject;
