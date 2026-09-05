/**
 * kernel.ts — the in-memory kernel: processes, groups, signals, streams.
 *
 * This is the piece the v1 terminal does not have. There, `run()` is a god
 * function — parse, history, prompt echo, pipeline policy, execution, DOM
 * printing and scrolling, inline — and a command IS a synchronous call that
 * writes to the page itself. Nothing can be listed, signalled, backgrounded or
 * cancelled, because nothing exists for long enough to be any of those things.
 *
 * Here, submitting a command creates a PROCESS. A process has a pid, a parent,
 * a group, a state, an abort signal, six streams, a byte channel and an exit
 * code. Everything the terminal wants to do — render output, stop a pipeline,
 * leave a job running, show a task manager — is then an ordinary operation on
 * that model rather than a special case bolted onto a print function.
 *
 * DELIBERATELY NOT A WORKER, yet. Every line runs in-process and in Node, with
 * no DOM and no `postMessage`, so the model can be tested before the transport
 * exists. The protocol is already shaped for the boundary (see `protocol.ts`),
 * so moving execution into a Worker is a change of transport rather than a
 * change of design — which is the whole reason the protocol was written first.
 *
 * DELIBERATELY NOT A PARSER. `splitPipeline` and `splitTokens` below are the
 * smallest thing that lets a pipeline exist at all, and they are marked for
 * deletion. Lexing and the AST belong to PR-08, and every parameter rule that
 * leaks in here is one that will have to be removed from two places later.
 *
 * NOT A SECOND ENGINE, any more. This file used to join its stages with a
 * private `ObjectQueue` whose own comment admitted the buffering was unbounded
 * — so `pipeline.ts`'s backpressure, early-termination and cancellation tests
 * covered a path the kernel never took, a fast producer feeding a slow consumer
 * grew without limit, and the Worker milestone was a rewrite rather than a
 * change of transport. It now composes `commandStage` and `runPipelineStages`,
 * which is the engine those tests exercise. The one thing the kernel adds is
 * that a stage is a PROCESS — its own pid, streams, stdin and signal — which is
 * what `runPipelineStages`'s per-stage host exists for.
 *
 * AND IT CALLS THE BINDER. It used to hand every command a BindingResult with
 * no parameters and the raw tokens in `remaining`, while `invocation.ts` said
 * the binder, the commands and the kernel are defined together precisely so
 * that they are guaranteed to join up. They now do.
 */

import type {
  BindingResult,
  CommandModule,
  CompatibilityView,
  InvocationContext,
} from '../commands/invocation.ts';
import { CapabilityDeniedError } from '../commands/invocation.ts';
import type { Capability, CommandManifest, Runtime } from '../commands/manifest.ts';
import type { DialogPort, FileSystemPort, PreferencesPort } from '../commands/ports.ts';
import type { PSValue } from '../pipeline/psobject.ts';
import type {
  ErrorRecord,
  InformationRecord,
  NativeStreams,
  PowerShellStreams,
  ProgressRecord,
  Sink,
} from '../pipeline/streams.ts';
import { CallbackSink, NullSink, errorRecord } from '../pipeline/streams.ts';
import type { PipelineHost } from '../pipeline/pipeline.ts';
import {
  PipelineCancelledError,
  commandStage,
  noInput,
  runPipelineStages,
} from '../pipeline/pipeline.ts';
import type { BindOptions } from '../binding/binder.ts';
import { tryBindParameters } from '../binding/binder.ts';
import { ParameterBindingError } from '../binding/errors.ts';
import type { ProcessGroupId, ProcessId, RequestId, TerminalId } from './ids.ts';
import type { KernelEvent, KernelEventBody } from './protocol.ts';
import {
  assertCloneSafe,
  decodeKernelRequest,
  sanitizeErrorRecord,
  sanitizeInformationRecord,
  sanitizePSValue,
} from './protocol.ts';
import { AuditLog, CapabilityBroker, VirtualPolicy } from './capabilities.ts';
import type { AuditView, CapabilityView, JobView, ProcessView, SignalView } from './inspect.ts';
import { JobManager } from './process/jobs.ts';
import type { ProcessSnapshot } from './process/snapshot.ts';
import { ProcessTable } from './process/table.ts';
import type { VirtualSignal } from './signals.ts';
import { SIGNAL_EXIT_CODE, SignalController, isPipelineStopped } from './signals.ts';

/**
 * Was this a stop rather than a failure?
 *
 * Two error types mean it, and the distinction between them is not the
 * kernel's: `PipelineStoppedError` is a delivered signal, and
 * `PipelineCancelledError` is the pipeline engine relaying one to a stage that
 * was parked rather than looping. Both are Ctrl+C to the user.
 */
function isStopped(error: unknown): boolean {
  return isPipelineStopped(error) || error instanceof PipelineCancelledError;
}

// ---------------------------------------------------------------------------
// exit codes with meanings
// ---------------------------------------------------------------------------

/**
 * `command not found`, as a STATUS.
 *
 * 127 is the shell convention for a program that could not be found, and it is
 * kept because a status number needs a value and this one is the one everybody
 * recognises. What it is NOT is `$LASTEXITCODE`. Measured in pwsh 7.6.5:
 *
 *   cmd /c "exit 13"            $LASTEXITCODE 13
 *   This-Command-Does-Not-Exist $LASTEXITCODE 13, $? False
 *
 * The variable does not move. A missing CMDLET is not a missing program, and
 * this constant's previous docstring claimed the two agreed.
 */
export const EXIT_COMMAND_NOT_FOUND = 127;
/** A command threw, was denied a capability, or could not bind. */
export const EXIT_FAILURE = 1;

/**
 * Does a process of this runtime set `$LASTEXITCODE`?
 *
 * `wasm` and `vm` mean a separate runtime executed the command — real
 * execution, but not ours — which is the closest thing this engine has to "a
 * native program PowerShell launched". `semantic` and `browser` are both
 * cmdlet-shaped: they run here, they write to the six streams, and pwsh's own
 * answer for a cmdlet is that `$LASTEXITCODE` does not move.
 *
 * Nothing in `manifests.json` is `wasm` or `vm` today — 57 `semantic` and 28
 * `browser` — so in practice `$LASTEXITCODE` stays unset for a whole session,
 * which is exactly what a pwsh session that has run no external program shows.
 */
function setsLastExitCode(runtime: Runtime): boolean {
  return runtime === 'wasm' || runtime === 'vm';
}

// ---------------------------------------------------------------------------
// stdin
// ---------------------------------------------------------------------------

/**
 * A process's stdin, fed by `stdin` requests from the UI.
 *
 * Bytes rather than text, for the reason in `protocol.ts`: since PowerShell 7.4
 * the raw bytes between a native command and a file survive, and decoding once
 * — wrongly — is not recoverable.
 */
class StdinPipe {
  #controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  #closed = false;
  readonly readable: ReadableStream<Uint8Array>;

  constructor() {
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#controller = controller;
      },
    });
  }

  push(bytes: Uint8Array): void {
    if (this.#closed) return;
    this.#controller?.enqueue(bytes);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#controller?.close();
    } catch {
      // Already closed or errored by the reader. Closing twice is not an error
      // worth propagating to a UI that just pressed Ctrl+D.
    }
  }
}

// ---------------------------------------------------------------------------
// options and listeners
// ---------------------------------------------------------------------------

export type KernelEventListener = (event: KernelEvent) => void;

export interface KernelOptions {
  /** Injected so `startedAt` is deterministic under test. */
  readonly clock?: () => number;
  /** What this session may do. Absent means nothing is granted. */
  readonly grants?: Iterable<Capability>;
  readonly profile?: CompatibilityView;
  readonly env?: Iterable<readonly [string, string]>;
  readonly cwd?: string;
  readonly policy?: VirtualPolicy;
  readonly audit?: AuditLog;
  /**
   * The embedder's ports. The kernel itself is in-memory and headless — it
   * neither creates a filesystem nor knows what a dialog is — but it has to be
   * able to HAND one to a command, which it previously could not.
   */
  readonly fs?: FileSystemPort | null;
  readonly preferences?: PreferencesPort | null;
  readonly dialog?: DialogPort | null;
  /**
   * Check every outgoing event against the structured-clone rules.
   *
   * ON by default. The failure it prevents is asymmetric: a DataCloneError at
   * `postMessage` names the message, not the command three layers down that
   * put a class instance in it. The transport may turn this off once the
   * boundary itself is the thing enforcing the rule.
   */
  readonly validateEvents?: boolean;
  /**
   * Extra facts the binder needs that `CommandManifest` does not carry.
   *
   * Three of them exist — `defaultParameterSet`, `validationDetails` and
   * `valueFromRemainingArguments` — and every one is a CAPTURED fact about a
   * real cmdlet rather than something derivable from the manifest. The kernel
   * refuses to guess them: with none supplied the binder is still correct for
   * every command that does not need them, and a command that does gets a
   * binding error instead of a silently different binding. The embedder that
   * holds the capture supplies this.
   */
  readonly bindOptions?: (manifest: CommandManifest) => BindOptions;
}

/** Per-terminal state the kernel owns because the DOM is not reachable. */
interface TerminalState {
  cwd: string;
  columns: number;
  rows: number;
  /**
   * `$?`. True in a fresh session, which is what pwsh 7.6.5 reports before
   * anything has run.
   */
  lastSucceeded: boolean;
  /**
   * `$LASTEXITCODE`, or null for "never set".
   *
   * Null and not 0. Measured: in a fresh pwsh 7.6.5 session the variable does
   * not exist, and `0` would be indistinguishable from a program that ran and
   * succeeded.
   */
  lastExitCode: number | null;
}

/** The default terminal geometry, used until the UI sends a `resize`. */
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

/**
 * The compatibility profile used when none is supplied.
 *
 * Pinned to the version this repository has actually verified against a real
 * pwsh, and answering every behaviour query with the caller's fallback — a
 * kernel must not invent version semantics it has not checked. The real
 * profiles arrive from the compatibility layer.
 */
const DEFAULT_PROFILE: CompatibilityView = {
  displayVersion: '7.6.5',
  behavior<T extends boolean | number | string>(_key: string, fallback: T): T {
    return fallback;
  },
  scopedBehavior<T extends boolean | number | string>(_key: string, whenUndeclared: T): T {
    return whenUndeclared;
  },
};

/**
 * How a stage ended.
 *
 * Three separate facts, because pwsh keeps them separate and measurably so:
 * `exitCode` is the command's status, `succeeded` is `$?` (which is False even
 * for a command that produced output, if it also wrote an error record), and
 * `nativeExitCode` is the only one of the three that can move `$LASTEXITCODE`.
 */
interface StageResult {
  readonly exitCode: number;
  readonly succeeded: boolean;
  readonly nativeExitCode: number | null;
  readonly signalled: VirtualSignal | null;
}

/** Bookkeeping for one running stage. Never leaves the kernel. */
interface Running {
  readonly pid: ProcessId;
  readonly requestId: RequestId;
  readonly terminalId: TerminalId;
  readonly leader: ProcessId;
  readonly background: boolean;
  readonly stdin: StdinPipe;
  readonly closeStreams: () => void;
}

/**
 * One stage of a pipeline, as the kernel assembles it.
 *
 * A stage is a PROCESS: its own pid, its own six streams, its own stdin, its
 * own AbortSignal. That is exactly why the kernel could not use
 * `runPipeline` — one shared `PipelineHost` cannot express it — and exactly
 * what `runPipelineStages` was added to fix. `outcome` is filled in by the
 * guard around `invoke`, which is the only thing that knows how the command
 * ended.
 */
interface Prepared {
  readonly snapshot: ProcessSnapshot;
  readonly module: CommandModule;
  readonly binding: BindingResult;
  readonly host: PipelineHost;
  readonly signal: AbortSignal;
  readonly errorSink: Sink<ErrorRecord>;
  /**
   * Did anything reach stream 2?
   *
   * `$?` is not `exitCode === 0`. Measured in pwsh 7.6.5:
   * `Get-Item 'C:
ope','C:\Windows' -ErrorAction SilentlyContinue` emits one
   * object and still leaves `$?` False. Writing an error record is the fact
   * that decides it, so the fact has to be recorded.
   */
  wroteError: boolean;
  outcome: StageResult | null;
}

// ---------------------------------------------------------------------------
// the placeholder splitter
// ---------------------------------------------------------------------------

/**
 * Split a command line on top-level `|`.
 *
 * NOT THE PARSER. Delete this when the binder lands; PR-08 owns lexing, the
 * AST and every version-dependent rule. It exists only so a pipeline can form a
 * process group, which is what makes Ctrl+C testable at all.
 *
 * It does respect quotes, because the alternative — `index.html`'s bare
 * `split('|')` — turns `Write-Output 'a|b'` into two commands, and a splitter
 * that is wrong on a literal is worse than no splitter.
 */
export function splitPipeline(source: string): readonly string[] {
  const stages: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;

  for (const character of source) {
    if (quote !== null) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === '|') {
      stages.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  stages.push(current);
  return stages.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** The command name and everything after it. Also not the parser. */
export function splitTokens(stage: string): readonly string[] {
  return stage.split(/\s+/u).filter((t) => t.length > 0);
}

// ---------------------------------------------------------------------------
// the kernel
// ---------------------------------------------------------------------------

export class Kernel {
  readonly #table: ProcessTable;
  readonly #signals = new SignalController();
  readonly #jobs: JobManager;
  readonly #broker: CapabilityBroker;
  readonly #commands = new Map<string, CommandModule>();
  readonly #listeners = new Set<KernelEventListener>();
  readonly #terminals = new Map<TerminalId, TerminalState>();
  readonly #running = new Map<ProcessId, Running>();
  /** Invocations still in flight. `drain` waits on these. */
  readonly #inflight = new Set<Promise<void>>();
  /** Pids whose `exit` event has already been emitted. Guards double-exit. */
  readonly #finished = new Set<ProcessId>();
  /** Requests cancelled before a process existed for them. */
  readonly #cancelled = new Set<RequestId>();
  /**
   * Every `exec` requestId this kernel has ever accepted.
   *
   * Kept for the life of the session rather than cleared on exit, because a
   * correlation id has to stay unique against the whole transcript and not just
   * against what is currently running. It is one string per submitted command
   * line — the same order of growth as the history the terminal already keeps.
   */
  readonly #submitted = new Set<RequestId>();
  readonly #env: Map<string, string>;
  readonly #clock: () => number;
  readonly #profile: CompatibilityView;
  readonly #defaultCwd: string;
  readonly #fs: FileSystemPort | null;
  readonly #preferences: PreferencesPort | null;
  readonly #dialog: DialogPort | null;
  readonly #validateEvents: boolean;
  readonly #bindOptions: (manifest: CommandManifest) => BindOptions;
  /**
   * The last sequence number handed out. Never reset, so a consumer that sees
   * seq N knows it has missed nothing if it has already seen 1..N-1.
   */
  #sequence = 0;
  /** Stamped events waiting to be delivered. See `#emit`. */
  readonly #outbox: KernelEvent[] = [];
  #delivering = false;

  constructor(options: KernelOptions = {}) {
    this.#clock = options.clock ?? Date.now;
    this.#table = new ProcessTable(this.#clock);
    this.#jobs = new JobManager(this.#clock);
    this.#broker = new CapabilityBroker({
      ...(options.grants === undefined ? {} : { grants: options.grants }),
      ...(options.policy === undefined ? {} : { policy: options.policy }),
      ...(options.audit === undefined ? {} : { audit: options.audit }),
      clock: this.#clock,
    });
    this.#profile = options.profile ?? DEFAULT_PROFILE;
    this.#env = new Map(options.env ?? []);
    // The seed tree's home, not an invented one. These were two different
    // strings — the kernel started in /home/visitor while the filesystem the
    // host boots contains /home/thc1006 — so the first `ls` would have run in a
    // directory that does not exist. A test asserts they still agree.
    this.#defaultCwd = options.cwd ?? '/home/thc1006';
    this.#validateEvents = options.validateEvents ?? true;
    this.#bindOptions = options.bindOptions ?? (() => ({}));
    this.#fs = options.fs ?? null;
    this.#preferences = options.preferences ?? null;
    this.#dialog = options.dialog ?? null;

    // Every process-table change becomes a protocol event. Wiring it once here
    // means no call site can forget to tell the UI that a state changed.
    this.#table.onChange((snapshot) => {
      this.#emit({ kind: 'process-changed', snapshot });
    });

    // SIGKILL is the only signal the kernel acts on itself. The others are
    // delivered to the AbortController and it is the command's job to notice;
    // a kill a command could ignore would just be SIGTERM with extra steps.
    this.#signals.onSignal((pid, signal) => {
      if (signal === 'SIGKILL') {
        this.#finish(pid, {
          exitCode: SIGNAL_EXIT_CODE.SIGKILL,
          succeeded: false,
          // A killed CMDLET does not move `$LASTEXITCODE` either; a killed
          // native program on Unix would, and nothing here is one yet.
          nativeExitCode: null,
          signalled: 'SIGKILL',
        });
      }
      else this.#table.transition(pid, 'stopping');
    });

    // The read-only getters below live on the prototype, and a getter on a
    // prototype can be SHADOWED by an own property on the instance. Found by an
    // adversarial pass on the views themselves:
    //
    //   Object.defineProperty(kernel, 'capabilities',
    //     { value: { grants: new Set(['device.request']) } })
    //   => kernel.capabilities.grants  is now whatever the attacker said
    //
    // It escalates nothing for whoever does it — they already hold the Kernel —
    // but a page that hands the SAME kernel to a third-party module and then
    // renders `kernel.capabilities.grants` or `kernel.audit.records` itself
    // would be shown a fabricated answer. Freezing the instance makes the
    // defineProperty throw. Every field here is `#private`, which lives in an
    // internal slot, so the kernel keeps working normally.
    Object.freeze(this);
  }

  // -- inspection ----------------------------------------------------------

  /**
   * READ-ONLY, AND THE WORD IS MEANT AT RUNTIME.
   *
   * These five getters used to return the live managers — the ProcessTable, the
   * JobManager, the SignalController, the CapabilityBroker and the AuditLog —
   * so `kernel.capabilities`, `kernel.jobs` and the rest were the kernel's own
   * mutable state under an inspection heading. Measured against the real class:
   *
   *     (kernel.capabilities.grants as Set<Capability>).add('device.request')
   *     => filesystem.read,device.request
   *
   * A holder of a Kernel could grant itself a capability the kernel was never
   * given, kill a process, drain a job's buffer before Receive-Job saw it, and
   * both forge and erase audit lines. `readonly` in the signature stopped none
   * of it, because `readonly` does not survive compilation.
   *
   * Each getter now returns a frozen view with the mutators absent — see
   * `inspect.ts` for what that costs and what it does not buy. The mutating
   * objects stay behind `#` fields, reachable only from inside this class.
   */
  get processes(): ProcessView {
    return this.#table.view();
  }

  get jobs(): JobView {
    return this.#jobs.view();
  }

  get signals(): SignalView {
    return this.#signals.view();
  }

  get capabilities(): CapabilityView {
    return this.#broker.view();
  }

  get audit(): AuditView {
    return this.#broker.audit;
  }

  /**
   * The highest sequence number emitted so far; 0 before anything is emitted.
   *
   * Exposed so a reconnecting consumer can say what it has already seen, and so
   * a test can assert the counter does not restart.
   */
  get sequence(): number {
    return this.#sequence;
  }

  /** Character cells, not pixels. What `Format-Table` will read. */
  terminalSize(terminalId: TerminalId): { columns: number; rows: number } {
    const terminal = this.#terminals.get(terminalId);
    return {
      columns: terminal?.columns ?? DEFAULT_COLUMNS,
      rows: terminal?.rows ?? DEFAULT_ROWS,
    };
  }

  cwd(terminalId: TerminalId): string {
    return this.#terminals.get(terminalId)?.cwd ?? this.#defaultCwd;
  }

  /**
   * `$?` for this terminal. True before anything has run.
   *
   * SEPARATE from `lastExitCode`, because pwsh keeps them separate and the
   * difference is measurable. In pwsh 7.6.5, after `cmd /c "exit 7"` a failing
   * `Get-Item` leaves `$LASTEXITCODE` at 7 and sets `$?` to False; a succeeding
   * `Get-Date` leaves it at 7 and sets `$?` to True. A cmdlet moves one of the
   * two and never the other.
   */
  lastSucceeded(terminalId: TerminalId): boolean {
    return this.#terminals.get(terminalId)?.lastSucceeded ?? true;
  }

  /**
   * `$LASTEXITCODE` for this terminal, or null for "never set".
   *
   * Null and not 0: in a fresh pwsh 7.6.5 session the variable does not exist,
   * and 0 would be indistinguishable from a program that ran and succeeded.
   * Nothing in this milestone is a program PowerShell launched, so it stays
   * null for a whole session — which is what a pwsh session that has run no
   * external command shows too.
   */
  lastExitCode(terminalId: TerminalId): number | null {
    return this.#terminals.get(terminalId)?.lastExitCode ?? null;
  }

  // -- registration --------------------------------------------------------

  /**
   * Make a command runnable.
   *
   * Registered under its name, its display form and every alias, all
   * lower-cased, because PowerShell command lookup is case-insensitive and a
   * `Map` keyed on the exact string would silently miss `get-childitem`.
   */
  register(module: CommandModule): void {
    const { manifest } = module;
    for (const key of [manifest.name, manifest.display, ...manifest.aliases]) {
      this.#commands.set(key.toLowerCase(), module);
    }
  }

  resolve(token: string): CommandModule | undefined {
    return this.#commands.get(token.toLowerCase());
  }

  // -- events --------------------------------------------------------------

  on(listener: KernelEventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * The ONE place an event acquires its sequence number.
   *
   * Every event already carried a pid; none carried an order. Success travels
   * keyed by requestId, error and warning by pid, stdout and stderr as bytes,
   * and four independent streams arriving at one renderer with no common
   * ordinal can be printed in any order at all — so `command 2>&1` and a
   * transcript were both unreconstructable. The counter is per KERNEL rather
   * than per process or per stream, because ordering a stream against itself
   * was never the thing in doubt.
   *
   * Stamped here and nowhere else, which is what makes the numbers dense and
   * gap-free: a call site that could mint its own would eventually mint two.
   */
  #emit(body: KernelEventBody): void {
    this.#sequence += 1;
    const event = { ...body, seq: this.#sequence } as KernelEvent;
    if (this.#validateEvents) assertCloneSafe(event, `KernelEvent(${event.kind})`);

    // DELIVERED IN SEQUENCE ORDER, which needs a queue rather than a direct
    // call. A listener is allowed to answer an event by sending a request — a
    // UI that auto-responds does exactly that — and a request handled inside
    // the delivery of event N emits event N+1 and delivers it in full before N
    // reaches the listeners that come after. Measured before this queue existed:
    //
    //   delivery order of seq: 1,2,4,3,5,6
    //
    // A number whose whole purpose is to say what happened first must not
    // arrive out of order, or a consumer that simply appends is already wrong.
    this.#outbox.push(event);
    if (this.#delivering) return;

    this.#delivering = true;
    try {
      for (let next = this.#outbox.shift(); next !== undefined; next = this.#outbox.shift()) {
        // Copy the listener set first: a listener that unsubscribes on `exit` —
        // the obvious thing for a "wait for this command" helper to do — would
        // otherwise mutate it while it is being iterated.
        for (const listener of [...this.#listeners]) listener(next);
      }
    } finally {
      this.#delivering = false;
    }
  }

  // -- the protocol entry point -------------------------------------------

  /**
   * Handle one request. The single door in, shaped like `onmessage`.
   *
   * Returns void rather than a promise on purpose: this is the signature a
   * message handler has, and a UI that could `await` a request would grow code
   * that cannot survive the move into a Worker. Callers that need to join —
   * tests, a script runner, an MCP tool — use `drain`.
   *
   * `unknown` rather than `KernelRequest`, deliberately. This is the door a
   * `postMessage` will arrive at, and a message from a page has no compile-time
   * type — pretending otherwise is what made the old kernel type-ASSERT its
   * input and act on whatever came through. A caller that wants checking builds
   * its message as a `KernelRequest` first; the door itself checks at runtime.
   */
  send(message: unknown): void {
    // DECODED, not asserted. The static type is a claim about the sender, and
    // the sender is about to become a `postMessage` from a page. Everything
    // below can then rely on the fields being what they say they are, which is
    // what the type alone never guaranteed at runtime.
    const decoded = decodeKernelRequest(message);
    if (!decoded.ok) {
      const record = (typeof message === 'object' && message !== null
        ? message
        : {}) as Record<string, unknown>;
      const requestId: unknown = record['requestId'];
      const kind: unknown = record['kind'];
      this.#emit({
        kind: 'rejected',
        requestId: typeof requestId === 'string' ? requestId : null,
        requestKind: typeof kind === 'string' ? kind : null,
        problems: decoded.problems,
      });
      return;
    }
    const request = decoded.value;

    switch (request.kind) {
      case 'exec': {
        // A requestId is a CORRELATION id, and a correlation id that names two
        // executions correlates nothing: the second run's objects, errors and
        // exit would all arrive labelled as the first's. Reusing one is a UI
        // bug, and a UI bug that silently produces interleaved output is worse
        // than one that is reported.
        if (this.#submitted.has(request.requestId)) {
          this.#emit({
            kind: 'rejected',
            requestId: request.requestId,
            requestKind: 'exec',
            problems: [`requestId '${request.requestId}' has already been submitted`],
          });
          return;
        }
        this.#submitted.add(request.requestId);
        this.#exec(request.requestId, request.terminalId, request.source, request.background);
        return;
      }
      case 'stdin': {
        const running = this.#running.get(request.processId);
        if (running === undefined) return;
        if (request.bytes.length > 0) running.stdin.push(request.bytes);
        if (request.endOfFile) running.stdin.close();
        return;
      }
      case 'signal':
        // Negative means the group led by |processId|, as `kill()` defines it.
        this.#signals.deliver(request.processId, request.signal);
        return;
      case 'resize': {
        const terminal = this.#terminal(request.terminalId);
        terminal.columns = request.columns;
        terminal.rows = request.rows;
        return;
      }
      case 'cancel': {
        const processes = this.#table.byRequest(request.requestId).filter((p) => p.state !== 'exited');
        if (processes.length === 0) {
          // No process yet: the request is still being resolved. Remember the
          // cancellation so it is honoured when one appears — this window is
          // exactly why `cancel` addresses a request and `signal` a process.
          this.#cancelled.add(request.requestId);
          return;
        }
        for (const pgid of new Set(processes.map((p) => p.pgid))) {
          this.#signals.raiseGroup(pgid, 'SIGINT');
        }
        return;
      }
    }
  }

  /**
   * Ctrl+C, expressed as a request.
   *
   * A convenience over `send`, not a second API: it resolves the terminal's
   * foreground group and sends the negative-pid signal the UI would send. It
   * exists because "which group is in the foreground" is kernel knowledge, and
   * making every caller track it is how a background job eventually gets killed
   * by someone else's Ctrl+C.
   */
  interrupt(terminalId: TerminalId): readonly ProcessId[] {
    return this.#signals.interrupt(terminalId);
  }

  /**
   * Resolve when every process started so far has exited.
   *
   * The UI never needs this — it is event-driven. A headless caller does, and
   * without one every test, script runner and tool would reimplement the same
   * bookkeeping slightly differently.
   */
  async drain(): Promise<void> {
    while (this.#inflight.size > 0) {
      await Promise.all([...this.#inflight]);
    }
  }

  // -- execution -----------------------------------------------------------

  #terminal(terminalId: TerminalId): TerminalState {
    let terminal = this.#terminals.get(terminalId);
    if (terminal === undefined) {
      terminal = {
        cwd: this.#defaultCwd,
        columns: DEFAULT_COLUMNS,
        rows: DEFAULT_ROWS,
        lastSucceeded: true,
        lastExitCode: null,
      };
      this.#terminals.set(terminalId, terminal);
    }
    return terminal;
  }

  #exec(requestId: RequestId, terminalId: TerminalId, source: string, background: boolean): void {
    const terminal = this.#terminal(terminalId);
    const stages = splitPipeline(source);
    if (stages.length === 0) return;

    // Resolve every stage BEFORE starting any of them. A pipeline whose third
    // stage does not exist must not run its first two — in a shell that would
    // mean side effects for a command line that was never going to work.
    // Verified in pwsh 7.6.5: `Prod | This-Command-Does-Not-Exist` leaves
    // Prod's side-effect log EMPTY.
    const resolved = stages.map((stage) => {
      const tokens = splitTokens(stage);
      const name = tokens[0] ?? '';
      return { stage, tokens, name, module: this.resolve(name) };
    });

    const missing = resolved.find((entry) => entry.module === undefined);
    if (missing !== undefined) {
      this.#reportUnknownCommand(requestId, terminalId, terminal.cwd, missing.name, missing.stage);
      return;
    }

    // BIND every stage before starting any of them, for the same reason and on
    // the same evidence: `Prod | Get-Item -NoSuchParameter x` in pwsh 7.6.5
    // also leaves Prod's log empty. The kernel used to hand every command an
    // essentially empty BindingResult with the raw tokens in `remaining`, which
    // meant the binder — the component invocation.ts says is defined alongside
    // the kernel precisely so the two join up — was never called on the path
    // that actually runs.
    const bound: {
      stage: string;
      module: CommandModule;
      binding: BindingResult;
    }[] = [];
    for (const entry of resolved) {
      const module = entry.module as CommandModule;
      const outcome = tryBindParameters(
        entry.tokens.slice(1),
        module.manifest,
        this.#profile,
        this.#bindOptions(module.manifest),
      );
      if (!outcome.ok) {
        this.#reportBindingFailure(requestId, terminalId, terminal.cwd, module, entry.stage, outcome.error);
        return;
      }
      bound.push({ stage: entry.stage, module, binding: outcome.result });
    }

    // The group leader is the FIRST stage, as in POSIX. Every later stage joins
    // it, so one signal stops the whole pipeline rather than leaving earlier
    // stages producing into a sink nobody reads.
    let leader: ProcessGroupId | null = null;
    const snapshots: ProcessSnapshot[] = [];
    for (const entry of bound) {
      const snapshot = this.#table.create({
        name: entry.module.manifest.display,
        commandLine: entry.stage,
        cwd: terminal.cwd,
        runtime: entry.module.manifest.runtime,
        terminalId,
        requestId,
        background,
        ...(leader === null ? {} : { pgid: leader, ppid: leader }),
      });
      leader ??= snapshot.pid;
      snapshots.push(snapshot);
    }

    const groupLeader = leader as ProcessId;

    // Foreground pipelines own the terminal's Ctrl+C; background ones must not,
    // which is the entire reason process groups are here.
    if (!background) this.#signals.setForeground(terminalId, groupLeader);

    // The job's handle is keyed on the group leader's pid, so the pipeline's
    // output can be buffered under one job however many stages it has.
    if (background) this.#jobs.start(groupLeader, source);

    const prepared = bound.map((entry, index) =>
      this.#prepare(snapshots[index] as ProcessSnapshot, entry.module, entry.binding, groupLeader),
    );

    // Synchronously, before the first await. A test that sends a signal on the
    // line after `send` must find a process that is already running, and the
    // pipeline generator does not start until it is iterated.
    for (const stage of prepared) this.#table.transition(stage.snapshot.pid, 'running');

    this.#track(this.#drive(prepared, requestId, terminalId, groupLeader, background));

    // A cancel that arrived before the processes existed still has to land.
    if (this.#cancelled.has(requestId)) {
      this.#cancelled.delete(requestId);
      this.#signals.raiseGroup(groupLeader, 'SIGINT');
    }
  }

  /**
   * Run the composed pipeline and report what happened.
   *
   * This is where the kernel stopped having a second execution engine. It used
   * to join its stages with a private `ObjectQueue` whose own comment admitted
   * "buffering here is unbounded, which is the honest limit of this milestone"
   * — so the backpressure, early-termination and cancellation tests in
   * pipeline.test.mts covered a path the kernel never took, and a fast producer
   * feeding a slow consumer grew without limit.
   */
  async #drive(
    prepared: readonly Prepared[],
    requestId: RequestId,
    terminalId: TerminalId,
    groupLeader: ProcessGroupId,
    background: boolean,
  ): Promise<void> {
    const stages = prepared.map((entry) => commandStage(this.#guard(entry), entry.binding));
    const output = runPipelineStages(
      // Deliberately empty rather than `[null]`: a command first in a pipeline
      // gets NO input, which is different from getting one null object.
      noInput(),
      stages,
      (_stage, index) => (prepared[index] as Prepared).host,
    );

    try {
      for await (const value of output) {
        // Sanitised HERE and not between stages. The old kernel sanitised on
        // every stage boundary, which stripped `baseObject` from objects that
        // had not left the kernel yet — so a command downstream of a producer
        // could never reach the host value the object model exists to carry.
        const safe = sanitizePSValue(value);
        // A background pipeline's output is buffered for `Receive-Job`, because
        // PowerShell does not print background output to the console and a
        // terminal that did would interleave it with whatever is being typed.
        if (background) this.#jobs.record(groupLeader, safe);
        else this.#emit({ kind: 'objects', requestId, values: [safe] });
      }
    } catch (error: unknown) {
      // A cancellation travels through the channel in both directions, so it
      // can surface here as well as inside a command. Anything else is a kernel
      // bug and is attributed to the last stage rather than swallowed.
      if (!isStopped(error)) {
        const last = prepared[prepared.length - 1];
        if (last !== undefined) {
          const message = error instanceof Error ? error.message : String(error);
          await last.errorSink.write(
            errorRecord(message, 'PipelineFailed', last.module.manifest.display, 'NotSpecified', {
              exceptionType: error instanceof Error ? error.name : 'System.Exception',
            }),
          );
          last.outcome ??= {
            exitCode: EXIT_FAILURE,
            succeeded: false,
            nativeExitCode: null,
            signalled: null,
          };
        }
      }
    } finally {
      // Reported after the output has drained, so the last `objects` event
      // always precedes the `exit` that follows it — the sequence number is
      // only worth having if the kernel's own events respect it.
      for (const entry of prepared) {
        const outcome = entry.outcome ?? this.#unstarted(entry);
        this.#finish(entry.snapshot.pid, outcome);
      }

      // `$?` and `$LASTEXITCODE`, which are two different questions with two
      // different answers. See `#recordStatus`.
      this.#recordStatus(
        terminalId,
        prepared.map((entry) => entry.outcome ?? this.#unstarted(entry)),
      );

      // A pipeline's exit code is its LAST stage's, in POSIX and in PowerShell
      // alike. Taking the leader's would report success for
      // `Get-Content missing.txt | Select-Object -First 1`, because the reader
      // is not the stage that failed.
      const last = prepared[prepared.length - 1]?.outcome ?? undefined;
      if (background && last !== undefined && last !== null) {
        this.#jobs.finish(groupLeader, last.exitCode, last.signalled !== null);
      }
      if (!background && this.#signals.foregroundGroup(terminalId) === groupLeader) {
        this.#signals.setForeground(terminalId, null);
      }
      this.#cancelled.delete(requestId);
    }
  }

  /**
   * What to report for a stage whose `invoke` never settled.
   *
   * The only way to get here is a SIGKILL, which reaps the process while its
   * invocation is still running and may never return. `#finish` has already
   * reported that exit and ignores this one; producing a value anyway keeps the
   * caller from having to special-case it.
   */
  #unstarted(entry: Prepared): StageResult {
    const signalled = this.#signals.deliveredTo(entry.snapshot.pid) ?? null;
    const exitCode = signalled === null ? EXIT_FAILURE : SIGNAL_EXIT_CODE[signalled];
    return {
      exitCode,
      succeeded: false,
      nativeExitCode: setsLastExitCode(entry.module.manifest.runtime) ? exitCode : null,
      signalled,
    };
  }

  /**
   * Update `$?` and `$LASTEXITCODE` for a terminal, from one pipeline's stages.
   *
   * Two different rules, because pwsh has two different rules.
   *
   * `$?` is the AND over the pipeline. Measured in pwsh 7.6.5: a failing first
   * stage feeding a succeeding last stage still leaves `$?` False
   * (`Get-Item 'C:\nope' -ErrorAction SilentlyContinue | Measure-Object`), so
   * it is not simply the last stage's answer.
   *
   * `$LASTEXITCODE` is the LAST stage that set one, and it is left ALONE when
   * no stage set one. Measured: `cmd /c "exit 77" | Out-Null` reports 77, and
   * every cmdlet in between leaves the previous value standing.
   */
  #recordStatus(terminalId: TerminalId, results: readonly StageResult[]): void {
    const terminal = this.#terminal(terminalId);
    terminal.lastSucceeded = results.every((result) => result.succeeded);
    for (const result of results) {
      if (result.nativeExitCode !== null) terminal.lastExitCode = result.nativeExitCode;
    }
  }

  #track(promise: Promise<void>): void {
    const tracked = promise.finally(() => {
      this.#inflight.delete(tracked);
    });
    this.#inflight.add(tracked);
    // Two handlers on one settlement, deliberately. `drain` awaits `tracked`
    // itself, so a kernel bug is loud in a test; this no-op handler marks the
    // same rejection as handled, so when nobody is draining — which is the
    // normal, event-driven case — it cannot take down the host tab as an
    // unhandled rejection. A command's own failure never reaches here: it is
    // already converted into an ErrorRecord inside the stage.
    void tracked.catch(() => undefined);
  }

  /**
   * A command that does not exist still gets a pid.
   *
   * It costs one process and buys an invariant the UI can rely on: EVERY
   * `exec` produces exactly one `exit`. Without it the "nothing was found"
   * path is the one case with no pid to attribute the error to, and a terminal
   * that prints nothing and never finds out why is precisely what a
   * correlation id exists to prevent. 127 is the shell's own code for it.
   */
  #reportUnknownCommand(
    requestId: RequestId,
    terminalId: TerminalId,
    cwd: string,
    name: string,
    stage: string,
  ): void {
    const snapshot = this.#table.create({
      name,
      commandLine: stage,
      cwd,
      runtime: 'semantic',
      terminalId,
      requestId,
      background: false,
    });
    this.#table.transition(snapshot.pid, 'running');
    this.#emit({
      kind: 'stream',
      processId: snapshot.pid,
      which: 'error',
      payload: sanitizeErrorRecord(
        errorRecord(
          `The term '${name}' is not recognized as a name of a cmdlet, function, script file, or executable program.`,
          'CommandNotFoundException',
          name,
          'ObjectNotFound',
          {
            exceptionType: 'System.Management.Automation.CommandNotFoundException',
            targetObject: name,
          },
        ),
      ),
    });
    // `$?` False, `$LASTEXITCODE` untouched. Measured: after `cmd /c "exit 13"`
    // a command-not-found leaves the variable at 13.
    this.#finish(snapshot.pid, {
      exitCode: EXIT_COMMAND_NOT_FOUND,
      succeeded: false,
      nativeExitCode: null,
      signalled: null,
    });
    this.#recordStatus(terminalId, [
      { exitCode: EXIT_COMMAND_NOT_FOUND, succeeded: false, nativeExitCode: null, signalled: null },
    ]);
  }

  /**
   * A stage whose parameters could not be bound.
   *
   * The same shape as `#reportUnknownCommand`, and for the same reason: every
   * `exec` must produce exactly one `exit`, and a pipeline that never ran still
   * has to say why. The message, the category and the FullyQualifiedErrorId all
   * come from the binder rather than being re-worded here, because the binder's
   * are byte-for-byte what pwsh printed for the same input.
   */
  #reportBindingFailure(
    requestId: RequestId,
    terminalId: TerminalId,
    cwd: string,
    module: CommandModule,
    stage: string,
    error: ParameterBindingError,
  ): void {
    const snapshot = this.#table.create({
      name: module.manifest.display,
      commandLine: stage,
      cwd,
      runtime: module.manifest.runtime,
      terminalId,
      requestId,
      background: false,
    });
    this.#table.transition(snapshot.pid, 'running');
    this.#emit({
      kind: 'stream',
      processId: snapshot.pid,
      which: 'error',
      payload: sanitizeErrorRecord({
        message: error.message,
        fullyQualifiedErrorId: error.fullyQualifiedErrorId,
        category: error.category,
        exceptionType: error.exceptionTypeName,
        ...(error.parameterName === null ? {} : { targetObject: error.parameterName }),
      }),
    });
    this.#finish(snapshot.pid, {
      exitCode: EXIT_FAILURE,
      succeeded: false,
      nativeExitCode: null,
      signalled: null,
    });
    this.#recordStatus(terminalId, [
      { exitCode: EXIT_FAILURE, succeeded: false, nativeExitCode: null, signalled: null },
    ]);
  }

  /**
   * Everything one stage needs, built once.
   *
   * The success stream is deliberately absent: it IS the next stage's input, so
   * the pipeline supplies it per stage and whatever is put here is replaced.
   * That is the shape `PipelineHost` documents, and the reason the kernel can
   * now hand its stages to the same engine the pipeline tests exercise.
   */
  #prepare(
    snapshot: ProcessSnapshot,
    module: CommandModule,
    binding: BindingResult,
    groupLeader: ProcessGroupId,
  ): Prepared {
    const { pid, requestId, terminalId, background } = snapshot;
    const signal = this.#signals.register(pid, groupLeader);
    const stdin = new StdinPipe();
    // Declared before the sinks so the error sink can record into it. The
    // fields the sinks do not need are filled in at the end.
    const prepared = { wroteError: false } as {
      wroteError: boolean;
    } & Partial<Prepared>;

    const onError = (record: ErrorRecord): void => {
      prepared.wroteError = true;
      if (background) this.#jobs.recordError(groupLeader, record);
      // Sanitised, not merely checked. `ErrorRecord.targetObject` is a PSValue,
      // so an error naming the object that failed is a hole exactly as wide as
      // the success stream's — and it was the ONE stream that only ever got the
      // clone check, which turned "this error mentions a File handle" into "the
      // command failed" instead of into a correctly carried error.
      this.#emit({
        kind: 'stream',
        processId: pid,
        which: 'error',
        payload: sanitizeErrorRecord(record),
      });
    };

    const streams = this.#buildStreams(pid, onError);
    const native = this.#buildNativeStreams(pid, stdin);

    this.#running.set(pid, {
      pid,
      requestId,
      terminalId,
      leader: groupLeader,
      background,
      stdin,
      closeStreams: streams.close,
    });

    const env = new Map(this.#env);
    // A shell exports these; `Format-Table` and anything that wraps needs them,
    // and reading them from the DOM is not available to a kernel that must run
    // in a Worker.
    const size = this.terminalSize(terminalId);
    env.set('COLUMNS', String(size.columns));
    env.set('LINES', String(size.rows));
    env.set('PWD', snapshot.cwd);

    const scoped = this.#broker.forCommand(module.manifest, pid);
    const host: PipelineHost = {
      profile: this.#profile,
      streams: streams.streams,
      native,
      cwd: snapshot.cwd,
      env,
      signal,
      requireCapability: (capability: Capability) => {
        scoped.require(capability);
      },
      fs: this.#fs,
      preferences: this.#preferences,
      dialog: this.#dialog,
    };

    return Object.assign(prepared, {
      snapshot,
      module,
      binding,
      host,
      signal,
      errorSink: streams.streams.error,
      outcome: null,
    }) as Prepared;
  }

  /**
   * Wrap a command so its own failure never reaches the channel.
   *
   * `commandStage` turns a rejected `invoke` into `channel.fail`, which
   * propagates the rejection DOWNSTREAM and would make one stage's bug look
   * like the next stage's. A command failing is not a pipeline failing: pwsh
   * writes an ErrorRecord on stream 2, sets a non-zero status and carries on.
   * So the conversion happens here, against this stage's own pid, and the
   * channel only ever sees a clean close.
   */
  #guard(entry: Prepared): CommandModule {
    const { snapshot, module, signal } = entry;
    const pid = snapshot.pid;
    return {
      manifest: module.manifest,
      invoke: async (context: InvocationContext, bound: BindingResult): Promise<number> => {
        let exitCode = EXIT_FAILURE;
        let signalled: VirtualSignal | null = null;
        try {
          exitCode = await module.invoke(context, bound);
        } catch (error: unknown) {
          if (isStopped(error) || signal.aborted) {
            signalled = this.#signals.deliveredTo(pid) ?? 'SIGINT';
            exitCode = SIGNAL_EXIT_CODE[signalled];
          } else if (error instanceof CapabilityDeniedError) {
            await context.streams.error.write(
              errorRecord(
                error.message,
                'CapabilityDenied',
                module.manifest.display,
                'PermissionDenied',
                {
                  exceptionType: 'System.UnauthorizedAccessException',
                  targetObject: error.capability,
                },
              ),
            );
            exitCode = EXIT_FAILURE;
          } else {
            const message = error instanceof Error ? error.message : String(error);
            await context.streams.error.write(
              errorRecord(message, 'CommandFailed', module.manifest.display, 'NotSpecified', {
                exceptionType: error instanceof Error ? error.name : 'System.Exception',
              }),
            );
            exitCode = EXIT_FAILURE;
          }
        }

        // A command that returned normally but was aborted mid-flight was still
        // stopped, and reporting 0 for it would make Ctrl+C look like success.
        if (signalled === null && signal.aborted) {
          signalled = this.#signals.deliveredTo(pid) ?? 'SIGINT';
          exitCode = SIGNAL_EXIT_CODE[signalled];
        }

        entry.outcome = {
          exitCode,
          // `$?`: the status AND the error stream AND the signal. Every one of
          // the three was measured to matter on its own.
          succeeded: exitCode === 0 && !entry.wroteError && signalled === null,
          nativeExitCode: setsLastExitCode(module.manifest.runtime) ? exitCode : null,
          signalled,
        };
        return exitCode;
      },
    };
  }

  /**
   * Report an exit exactly once.
   *
   * The guard is not defensive tidiness. A SIGKILLed process is finished by the
   * signal listener while its invocation is still running, and that invocation
   * will later settle and try to report its own code. The kill happened first
   * and is what the user saw, so the later report must lose.
   */
  #finish(pid: ProcessId, result: StageResult): void {
    const { exitCode, signalled } = result;
    if (this.#finished.has(pid)) return;
    const existing = this.#table.get(pid);
    if (existing === undefined) return;
    this.#finished.add(pid);

    const running = this.#running.get(pid);
    running?.closeStreams();
    running?.stdin.close();
    this.#running.delete(pid);

    const snapshot = this.#table.exit(pid, exitCode, signalled);
    this.#signals.unregister(pid);

    // A signal reaches the whole group, so a job whose pipeline was stopped is
    // Stopped the moment ANY stage reports it — waiting for the last stage
    // would leave `Get-Job` showing Running for a pipeline nobody can rescue,
    // and a SIGKILLed stage never reports at all.
    if (signalled !== null && this.#jobs.byPid(existing.pgid) !== undefined) {
      this.#jobs.finish(existing.pgid, exitCode, true);
    }

    this.#emit({
      kind: 'exit',
      processId: pid,
      requestId: snapshot?.requestId ?? existing.requestId,
      exitCode,
      succeeded: result.succeeded,
      nativeExitCode: result.nativeExitCode,
      signalled,
    });
  }

  /**
   * Streams 2..6 plus progress, for one process.
   *
   * `success` is a placeholder and is MEANT to be discarded: a command's
   * success stream IS the next stage's input, so the pipeline replaces it per
   * stage. Making that explicit here is what stopped the kernel needing its own
   * plumbing between stages.
   */
  #buildStreams(
    pid: ProcessId,
    onError: (record: ErrorRecord) => void,
  ): { streams: PowerShellStreams; close: () => void } {
    const success = new NullSink<PSValue>();
    const error = new CallbackSink<ErrorRecord>(onError);
    const warning = new CallbackSink<string>((text) => {
      this.#emit({ kind: 'stream', processId: pid, which: 'warning', payload: text });
    });
    const verbose = new CallbackSink<string>((text) => {
      this.#emit({ kind: 'stream', processId: pid, which: 'verbose', payload: text });
    });
    const debug = new CallbackSink<string>((text) => {
      this.#emit({ kind: 'stream', processId: pid, which: 'debug', payload: text });
    });
    const information = new CallbackSink<InformationRecord>((record) => {
      // `InformationRecord.message` is a PSValue too, for the same reason.
      this.#emit({
        kind: 'stream',
        processId: pid,
        which: 'information',
        payload: sanitizeInformationRecord(record),
      });
    });
    const progress = new CallbackSink<ProgressRecord>((record) => {
      this.#emit({ kind: 'stream', processId: pid, which: 'progress', payload: record });
    });

    return {
      streams: { success, error, warning, verbose, debug, information, progress },
      close: () => {
        // Closing tells a still-running producer that nobody is reading, which
        // is what `Sink.closed` is for — a command emitting a million objects
        // must be able to give up rather than fill memory for a dead terminal.
        // `success` is not in the list because it is not ours: the pipeline
        // owns that end and closes it when the stage is torn down.
        for (const sink of [error, warning, verbose, debug, information, progress]) {
          sink.close();
        }
      },
    };
  }

  #buildNativeStreams(pid: ProcessId, stdin: StdinPipe): NativeStreams {
    return {
      stdin: stdin.readable,
      stdout: new WritableStream<Uint8Array>({
        write: (chunk) => {
          this.#emit({ kind: 'stdout', processId: pid, bytes: chunk });
        },
      }),
      stderr: new WritableStream<Uint8Array>({
        write: (chunk) => {
          this.#emit({ kind: 'stderr', processId: pid, bytes: chunk });
        },
      }),
    };
  }
}
