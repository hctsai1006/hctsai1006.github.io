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
 * NOT A PARSER, and no longer a placeholder one either. This file used to carry
 * `splitPipeline` and `splitTokens` — a quote-aware `|` splitter and
 * `stage.split(/\s+/u)` — under a comment marking them for deletion. They are
 * gone. `#exec` calls `parseForExecution`, whose own docstring says it is what
 * replaces them, and hands each `CommandAst` to `tryBindCommand` rather than
 * flattening it back to strings. What that buys, beyond one lexer instead of
 * four: `-Path "my file"` is one argument rather than three, and a QUOTED
 * `'-Force'` stays a value instead of binding the switch — measured on pwsh
 * 7.6.5 in `binding/from-ast.ts`, which is where the AST-shaped binder lives.
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
import { tryBindCommand } from '../binding/from-ast.ts';
import { ParameterBindingError } from '../binding/errors.ts';
import type { CommandAst } from '../language/ast.ts';
import { parseForExecution } from '../language/parse.ts';
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
   *
   * ONE PORT MEANS ONE CURRENT DIRECTORY, for every terminal and every job.
   * A `FileSystemPort` closes over a filesystem view, and a view has a
   * location, so a `Set-Location` in one terminal moves the relative-path
   * baseline of every other. That is stated rather than hidden because it is
   * the right answer for a single-session embedder and the wrong one for a
   * page with two panes; `openFileSystem` is how a page with two panes avoids
   * it. Supplying both is refused rather than silently resolved.
   */
  readonly fs?: FileSystemPort | null;
  /**
   * A filesystem view PER SESSION: share the storage backend, not the location.
   *
   * Called once per terminal, and once more for each background pipeline. What
   * it returns must read and write the same files as every other view — one
   * `MountTable` over one backend, handed to a fresh `VirtualFileSystem` whose
   * `cwd` is the `cwd` given here — so the only thing that is NOT shared is
   * where the session happens to be standing.
   *
   * MEASURED in pwsh 7.6.5 on this machine, which is where the background rule
   * comes from:
   *
   *   session location          : C:\Users\...\Temp
   *   job start location        : C:\Users\...\Temp   (inherited)
   *   job after its own cd      : C:\                 (moved only itself)
   *   session location after    : C:\Users\...\Temp   (unchanged)
   *
   * A job is a separate runspace: it starts where the session was and its `cd`
   * does not follow the session home. So a background pipeline gets its own
   * view, seeded with the terminal's location at the moment it was started, and
   * the kernel never reads that view back.
   */
  readonly openFileSystem?: (session: FileSystemSession) => FileSystemPort;
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
  /**
   * What to do when an event listener throws.
   *
   * It has to be somebody's decision, because the default before this option
   * existed was the worst of the three: the throw travelled out of `#emit`,
   * out of `send`, and aborted whatever kernel operation happened to be
   * emitting. MEASURED against the shipped class, with two listeners and the
   * first one throwing on `process-changed`:
   *
   *     send() threw: listener blew up
   *     listener A saw: [1]
   *     listener B saw: []      <- never told about seq 1 at all
   *     final seq: 1            <- the pipeline never started
   *
   * One renderer with a bug, or one `postMessage` refusing a value, and the
   * kernel stops executing. That is not a hypothetical across a Worker: the
   * transport's post IS a listener, and `postMessage` throws `DataCloneError`.
   *
   * So a listener's failure is now contained to that listener, and this says
   * where it goes. The default rethrows it on a fresh microtask, which is loud
   * — an uncaught exception in Node, `self.onerror` in a Worker — while being
   * nowhere near the kernel's own stack.
   */
  readonly onListenerError?: (error: unknown, event: KernelEvent) => void;
}

/** Which session a filesystem view is being opened for. */
export interface FileSystemSession {
  readonly terminalId: TerminalId;
  /** Where the new view must start. For a job, where the terminal was. */
  readonly cwd: string;
  /** True for a background pipeline, which gets a view of its own. */
  readonly background: boolean;
}

/** Per-terminal state the kernel owns because the DOM is not reachable. */
interface TerminalState {
  /**
   * The last directory this terminal was TOLD about, not where it is.
   *
   * Not a second source of truth, and it used to be one: `TerminalState.cwd`
   * held a directory while the filesystem port held another, `Get-Location`
   * read the first and relative-path resolution followed the second, and after
   * a successful `Set-Location` the two disagreed for the rest of the session.
   * The authority is now the session's filesystem view and `Kernel.cwd` reads
   * it live; this is only the watermark that decides whether a `cwd-changed`
   * still needs to be emitted.
   */
  reportedCwd: string;
  /**
   * This terminal's own filesystem view, when the embedder supplies a factory.
   *
   * Null means there is no per-session view and the kernel-wide `fs` is used —
   * which is one location shared by everything. See `KernelOptions.fs`.
   */
  fs: FileSystemPort | null;
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
  readonly #openFileSystem: ((session: FileSystemSession) => FileSystemPort) | null;
  readonly #preferences: PreferencesPort | null;
  readonly #dialog: DialogPort | null;
  readonly #validateEvents: boolean;
  readonly #bindOptions: (manifest: CommandManifest) => BindOptions;
  readonly #onListenerError: (error: unknown, event: KernelEvent) => void;
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
    this.#onListenerError =
      options.onListenerError ??
      ((error: unknown) => {
        queueMicrotask(() => {
          throw error;
        });
      });
    this.#fs = options.fs ?? null;
    this.#openFileSystem = options.openFileSystem ?? null;
    if (this.#fs !== null && this.#openFileSystem !== null) {
      // Two answers to "which filesystem", and picking one silently is how a
      // session ends up resolving relative paths against a view nothing else
      // reads. The embedder decides: one shared port, or one view per session.
      throw new TypeError(
        'KernelOptions.fs and KernelOptions.openFileSystem are alternatives: ' +
          'supply a single shared port, or a factory that opens one view per session',
      );
    }
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

  /**
   * Where this terminal is, read from the filesystem view that IS the answer.
   *
   * Live rather than cached, and that is the fix for having had two current
   * directories. `Get-Location` reads the process's `context.cwd`, relative
   * paths resolve against the port, and the two used to be separate states
   * that disagreed the moment `Set-Location` succeeded: the port moved and
   * nothing moved the kernel's copy. There is now one authority — the
   * session's view — and `snapshot.cwd`, `$PWD` and this getter all read it.
   *
   * Falls back to the configured default when there is no filesystem at all,
   * which is every kernel that has not been given one.
   */
  cwd(terminalId: TerminalId): string {
    const port = this.#fsFor(terminalId);
    if (port !== null) {
      try {
        return port.location.full;
      } catch {
        // A backend that has gone away must not make the current directory
        // unreadable; the last directory the terminal was told about stands.
      }
    }
    return this.#terminals.get(terminalId)?.reportedCwd ?? this.#defaultCwd;
  }

  /** This terminal's own view, or the kernel-wide port, or nothing. */
  #fsFor(terminalId: TerminalId): FileSystemPort | null {
    return this.#terminals.get(terminalId)?.fs ?? this.#fs;
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
        //
        // CONTAINED, one listener at a time. A throw used to escape this loop
        // entirely: the listeners registered after the failing one never saw
        // the event, the events still queued behind it were delivered late,
        // and the exception surfaced inside whichever kernel operation was
        // emitting — so `#exec` aborted half-way and left a process in
        // `created` forever. See `KernelOptions.onListenerError` for the
        // transcript. A renderer's bug is not the kernel's control flow.
        for (const listener of [...this.#listeners]) {
          try {
            listener(next);
          } catch (error: unknown) {
            this.#reportListenerError(error, next);
          }
        }
      }
    } finally {
      this.#delivering = false;
    }
  }

  /** Hand a listener's failure to the handler, and survive a handler that throws too. */
  #reportListenerError(error: unknown, event: KernelEvent): void {
    try {
      this.#onListenerError(error, event);
    } catch {
      // SWALLOWED, and this is the one place in the kernel where that is the
      // right answer. `#onListenerError` IS the place errors go; if it throws,
      // the embedder's error sink is the thing that is broken, and there is
      // nowhere left to put either error. Rethrowing here — even
      // asynchronously — would turn a bug in a log line into a dead kernel,
      // which is precisely the failure the surrounding try/catch exists to
      // prevent. Delivery continues, which is the property being protected.
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
        const known = this.#table.byRequest(request.requestId);
        const live = known.filter((p) => p.state !== 'exited');
        // REMEMBERED AS WELL AS DELIVERED, and the "as well" is the fix.
        //
        // This used to branch on whether a process could be FOUND, and a
        // process can be found in the table before it can be REACHED by a
        // signal: `#exec` creates every snapshot first and registers the abort
        // controllers afterwards, so between the two there is a process with a
        // pid and no signal target. A `process-changed` listener that cancels
        // on the spot — the natural thing for a UI to do — lands exactly there.
        // MEASURED before this change:
        //
        //   cancel-from-listener: invocations = 1
        //                         exits = [{"code":0,"signalled":null}]
        //
        // The Ctrl+C vanished: not remembered, because a process was found; not
        // delivered, because none was registered. The command ran to completion
        // and reported SUCCESS.
        //
        // The record is dropped by `#exec` when it consumes it and by `#drive`'s
        // teardown when the request ends, so the only ids that persist are those
        // of requests that were cancelled and never submitted.
        if (known.length === 0 || live.length > 0) this.#cancelled.add(request.requestId);
        for (const pgid of new Set(live.map((p) => p.pgid))) {
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
        reportedCwd: this.#defaultCwd,
        // Opened once per terminal, at the default location. Every view the
        // factory returns reads the same files; only the location differs.
        fs:
          this.#openFileSystem === null
            ? null
            : this.#openFileSystem({
                terminalId,
                cwd: this.#defaultCwd,
                background: false,
              }),
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
    this.#terminal(terminalId);
    // Read ONCE, from the session's view, and used for every snapshot in this
    // pipeline — so `$PWD`, `Get-Location` and relative resolution cannot
    // disagree about where the command started.
    const cwd = this.cwd(terminalId);

    // NOT a silent return, whichever way this ends. MEASURED: an `exec` whose
    // source was `'   '` produced zero events and left `sequence` at 0, while
    // the requestId was already recorded in `#submitted` — so the correlation
    // id was spent, nothing was reported against it, and anything waiting for
    // the request to finish waited forever. Every accepted `exec` ends in at
    // least one `exit` or in exactly one `rejected`.
    const refuse = (...problems: readonly string[]): void => {
      this.#emit({ kind: 'rejected', requestId, requestKind: 'exec', problems });
    };

    // THE PARSER, not a splitter. Everything the engine will not run is named
    // here, once, by `parseForExecution`'s gate — including the things the old
    // `splitTokens` turned into arguments and handed to a command: `>` became a
    // positional value, `$x` bound as the four literal characters, and `{ ... }`
    // arrived as two tokens with the body in between.
    const parsed = parseForExecution(source);
    if (!parsed.ok) {
      refuse(...parsed.refusals.map((refusal) => refusal.message));
      return;
    }

    // What the kernel can express is ONE pipeline of commands. The parser
    // accepts more than that, and the gap is refused here rather than
    // flattened, because every flattening is a wrong answer:
    //
    //   `a; b`     pwsh runs both — measured, `@(Write-Output one; Write-Output
    //              two).Count` is 2. One request is one process group, so
    //              running them would need two, and running only the first
    //              would drop the second silently.
    //   `a && b`   pwsh runs `b` only if `a` succeeded — measured, a chain whose
    //              left side is command-not-found emits 0 objects. Nothing here
    //              implements that, and `pipelineStages` flattens a chain into
    //              a stage list, which would turn `a && b` into `a | b`.
    //   `Get-Date &`  pwsh returns a PSRemotingJob object, State Running —
    //              measured. This kernel's `background` is a property of the
    //              REQUEST, decided by the caller, and it emits no job object,
    //              so honouring `&` here would be approximate in both halves.
    //   `1`        a pipeline element that is not a command. Nothing evaluates
    //              expressions; `pipelineStages` drops such an element, and a
    //              dropped element reads as "source contains no command".
    const [statement, ...rest] = parsed.ast.statements;
    if (statement === undefined) {
      refuse('source contains no command');
      return;
    }
    if (rest.length > 0) {
      refuse(
        `BrowserShell parsed ${parsed.ast.statements.length} statements and runs one per command line. ` +
          'Separating commands with ";" is not implemented; submit them one at a time.',
      );
      return;
    }
    if (statement.kind !== 'PipelineAst') {
      refuse(
        `BrowserShell recognised a pipeline chain (${statement.kind}) in "${statement.extent.text}", ` +
          'and does not implement it. Rather than run something approximate, it refuses.',
      );
      return;
    }
    if (statement.background) {
      refuse(
        'BrowserShell recognised a background operator (&), and does not implement it. Whether a ' +
          'command line runs in the background is decided by the caller of exec, not by the line.',
      );
      return;
    }
    const commands: CommandAst[] = [];
    for (const element of statement.elements) {
      if (element.kind !== 'CommandAst') {
        refuse(
          `BrowserShell recognised an expression (${element.kind}) where a command belongs, in ` +
            `"${element.extent.text}", and does not implement it.`,
        );
        return;
      }
      commands.push(element);
    }

    // Resolve every stage BEFORE starting any of them. A pipeline whose third
    // stage does not exist must not run its first two — in a shell that would
    // mean side effects for a command line that was never going to work.
    // Verified in pwsh 7.6.5: `Prod | This-Command-Does-Not-Exist` leaves
    // Prod's side-effect log EMPTY.
    const resolved = commands.map((command) => ({
      command,
      // The stage as WRITTEN. `splitPipeline` returned a trimmed slice of the
      // source and this is the command's own extent, which is the same text for
      // everything the process table shows it for.
      stage: command.extent.text,
      name: command.commandName,
      module: this.resolve(command.commandName),
    }));

    const missing = resolved.find((entry) => entry.module === undefined);
    if (missing !== undefined) {
      this.#reportUnknownCommand(requestId, terminalId, cwd, missing.name, missing.stage, background);
      return;
    }

    // BIND every stage before starting any of them, for the same reason and on
    // the same evidence: `Prod | Get-Item -NoSuchParameter x` in pwsh 7.6.5
    // also leaves Prod's log empty. The kernel used to hand every command an
    // essentially empty BindingResult with the raw tokens in `remaining`, which
    // meant the binder — the component invocation.ts says is defined alongside
    // the kernel precisely so the two join up — was never called on the path
    // that actually runs.
    //
    // From the AST, not from strings. `tryBindParameters` on
    // `commandArguments(...)` would re-derive "is this a parameter?" from text
    // the lexer had already classified, and pwsh 7.6.5 says the two answers
    // differ: `Test-Q '-Force'` binds -Path, not the switch. See from-ast.ts.
    const bound: {
      stage: string;
      module: CommandModule;
      binding: BindingResult;
    }[] = [];
    for (const entry of resolved) {
      const module = entry.module as CommandModule;
      const outcome = tryBindCommand(
        entry.command,
        module.manifest,
        this.#profile,
        this.#bindOptions(module.manifest),
      );
      if (!outcome.ok) {
        this.#reportBindingFailure(
          requestId,
          terminalId,
          cwd,
          module,
          entry.stage,
          outcome.error,
          background,
        );
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
        cwd,
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

    // A background pipeline gets a view of ITS OWN, seeded with the location
    // the terminal was standing in when the job started, and never read back.
    // Measured in pwsh 7.6.5: a job starts where the session was, its own
    // `cd` moves only itself, and the session's location is unchanged after.
    // Without a factory there is one port for everything, so a job shares the
    // terminal's location — see `KernelOptions.fs`.
    const port =
      background && this.#openFileSystem !== null
        ? this.#openFileSystem({ terminalId, cwd, background: true })
        : this.#fsFor(terminalId);

    const prepared = bound.map((entry, index) =>
      this.#prepare(
        snapshots[index] as ProcessSnapshot,
        entry.module,
        entry.binding,
        groupLeader,
        port,
      ),
    );

    // CHECKED BEFORE THE WORK STARTS, not after.
    //
    // This used to run after `#track(#drive(...))`, and `#drive` is an async
    // function: calling it executes synchronously as far as its first await,
    // which is far enough to enter the first stage's `invoke`. So a cancel that
    // had ALREADY ARRIVED still let the command run its prologue, and the
    // SIGINT that followed only stopped whatever was left. MEASURED:
    //
    //   cancel-before-exec: invocations = 1
    //
    // Cancelling something that has not started must mean it does not start.
    // An exit code of 130 with the side effects already committed is the
    // failure this reordering exists to prevent, which is why the regression
    // test counts INVOCATIONS and not exit codes.
    if (this.#cancelled.has(requestId)) {
      this.#cancelled.delete(requestId);
      this.#abandon(prepared, requestId, terminalId, groupLeader, background);
      return;
    }

    // Synchronously, before the first await. A test that sends a signal on the
    // line after `send` must find a process that is already running, and the
    // pipeline generator does not start until it is iterated.
    for (const stage of prepared) this.#table.transition(stage.snapshot.pid, 'running');

    this.#track(this.#drive(prepared, requestId, terminalId, groupLeader, background));
  }

  /**
   * End a pipeline that was cancelled before any of it ran.
   *
   * Every stage reports SIGINT and exit code 130 without `invoke` ever being
   * called, and the request goes through the same teardown a completed one
   * does — so the UI's invariant holds: one `exit` per process, always.
   */
  #abandon(
    prepared: readonly Prepared[],
    requestId: RequestId,
    terminalId: TerminalId,
    groupLeader: ProcessGroupId,
    background: boolean,
  ): void {
    for (const entry of prepared) {
      entry.outcome = {
        exitCode: SIGNAL_EXIT_CODE.SIGINT,
        succeeded: false,
        // A cancelled CMDLET does not move `$LASTEXITCODE`, and nothing in this
        // milestone is a native program. Same answer as `#unstarted`.
        nativeExitCode: null,
        signalled: 'SIGINT',
      };
    }
    this.#teardown(prepared, requestId, terminalId, groupLeader, background);
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
          // OVERWRITTEN, not defaulted. `??=` left a stage that had already
          // reported its own success in place, and the stage HAS usually
          // succeeded here: the failure is in the kernel's consumption of what
          // it produced, not in producing it. So a pipeline whose output could
          // not be carried across the boundary wrote an error record and then
          // reported exit 0. MEASURED, with a Format-Table record that the wire
          // now refuses:
          //
          //   ERROR: PipelineFailed,Format-Table | value cannot cross …
          //   exit: 0
          //   exit: 0
          //
          // `signalled` is preserved because a stage that was stopped was
          // stopped, whatever went wrong afterwards.
          last.outcome = {
            exitCode: EXIT_FAILURE,
            succeeded: false,
            nativeExitCode: null,
            signalled: last.outcome?.signalled ?? null,
          };
        }
      }
    } finally {
      this.#teardown(prepared, requestId, terminalId, groupLeader, background);
    }
  }

  /**
   * End a request: commit its state, then say it ended.
   *
   * THE ORDER HERE IS THE POINT, and it was wrong. `exit` used to be emitted
   * before `#recordStatus` ran, so a listener that read the kernel on the event
   * that says "this finished" was shown the PREVIOUS request's answer.
   * MEASURED:
   *
   *     lastSucceeded at exit = true      after drain = false
   *
   * A monotonic sequence number orders EVENTS; it cannot make a state that has
   * not been written yet readable. So the terminal's `$?` and `$LASTEXITCODE`
   * are committed first, then the exits are published, and a listener that
   * submits the next command on `exit` — the obvious autopilot — reads the
   * result of the request that just ended rather than the one before it.
   *
   * `cwd-changed` goes first for the same reason at one remove: a prompt drawn
   * when the last process exits has to already know where the shell is.
   */
  #teardown(
    prepared: readonly Prepared[],
    requestId: RequestId,
    terminalId: TerminalId,
    groupLeader: ProcessGroupId,
    background: boolean,
  ): void {
    const outcomes = prepared.map((entry) => entry.outcome ?? this.#unstarted(entry));

    // A background pipeline does NOT write the terminal's status. Measured in
    // pwsh 7.6.5 on this machine: a job whose command throws reaches State
    // `Failed` while the session's `$?` is still True after `Wait-Job`, and a
    // job running `cmd /c "exit 42"` leaves the session's `$LASTEXITCODE`
    // unset. (`$?` only goes False at `Receive-Job`, because Receive-Job is
    // itself the statement that then fails.) Before this, a background failure
    // silently flipped the foreground terminal's `$?`.
    if (!background) {
      this.#syncLocation(terminalId);
      // `$?` and `$LASTEXITCODE`, which are two different questions with two
      // different answers. See `#recordStatus`.
      this.#recordStatus(terminalId, outcomes);
    }

    // Published after the output has drained AND after the state above is
    // committed, so the last `objects` event always precedes the `exit` that
    // follows it and the state that `exit` describes is already readable.
    for (const [index, entry] of prepared.entries()) {
      this.#finish(entry.snapshot.pid, outcomes[index] as StageResult);
    }

    // A pipeline's exit code is its LAST stage's, in POSIX and in PowerShell
    // alike. Taking the leader's would report success for
    // `Get-Content missing.txt | Select-Object -First 1`, because the reader
    // is not the stage that failed.
    const last = outcomes[outcomes.length - 1];
    if (background && last !== undefined) {
      this.#jobs.finish(groupLeader, last.exitCode, last.signalled !== null);
    }
    if (!background && this.#signals.foregroundGroup(terminalId) === groupLeader) {
      this.#signals.setForeground(terminalId, null);
    }
    this.#cancelled.delete(requestId);
  }

  /**
   * Notice that a command moved the shell, and say so.
   *
   * Roadmap task 6.4, "stop commands mutating prompt chrome; return a CWD
   * change instead". In v1 `cd` writes the prompt itself — `CWD = p;` then
   * `document.getElementById('prompt').textContent = shortCwd()` — which is
   * three things a Worker cannot do and one thing the DOM's owner cannot
   * override. Here `Set-Location` moves the FILESYSTEM PORT and touches nothing
   * else; this is the kernel noticing, and `cwd-changed` is it saying so.
   *
   * Polled rather than pushed, deliberately. The alternative is a callback on
   * the port that every backend would have to remember to fire, and a port that
   * forgot would leave the terminal permanently wrong with nothing to notice
   * it. The location is one property read, once per pipeline.
   *
   * THE LIMIT, because it is real and this is where somebody would look for it:
   * a Kernel has ONE `FileSystemPort` and a port has ONE location, so two
   * terminals share a current directory. Terminal B running anything will
   * observe A's `cd` and emit its own `cwd-changed` — consistent, and still
   * surprising to anyone expecting two independent shells. Per-terminal
   * locations belong to whoever owns the port, not here.
   */
  #syncLocation(terminalId: TerminalId): void {
    const port = this.#fsFor(terminalId);
    if (port === null) return;
    let current: string;
    try {
      current = port.location.full;
    } catch {
      // A port whose `location` getter throws must not cost the pipeline its
      // `exit` events — this runs inside `#drive`'s finally. The directory
      // simply stays where the kernel last saw it.
      return;
    }
    const terminal = this.#terminal(terminalId);
    if (current === terminal.reportedCwd) return;
    terminal.reportedCwd = current;
    this.#emit({ kind: 'cwd-changed', terminalId, cwd: current });
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
    background: boolean,
  ): void {
    const snapshot = this.#table.create({
      name,
      commandLine: stage,
      cwd,
      runtime: 'semantic',
      terminalId,
      requestId,
      background,
    });
    // A background failure is a JOB that failed, and it has to be visible
    // somewhere. It used to be visible in the wrong place: the terminal's `$?`.
    if (background) this.#jobs.start(snapshot.pid, stage);
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
    if (background) this.#jobs.finish(snapshot.pid, EXIT_COMMAND_NOT_FOUND, false);
    // NOT for a background pipeline, for the reason `#teardown` gives: measured
    // in pwsh 7.6.5, a job that fails leaves the session's `$?` True.
    else {
      this.#recordStatus(terminalId, [
        { exitCode: EXIT_COMMAND_NOT_FOUND, succeeded: false, nativeExitCode: null, signalled: null },
      ]);
    }
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
    background: boolean,
  ): void {
    const snapshot = this.#table.create({
      name: module.manifest.display,
      commandLine: stage,
      cwd,
      runtime: module.manifest.runtime,
      terminalId,
      requestId,
      background,
    });
    if (background) this.#jobs.start(snapshot.pid, stage);
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
    if (background) this.#jobs.finish(snapshot.pid, EXIT_FAILURE, false);
    else {
      this.#recordStatus(terminalId, [
        { exitCode: EXIT_FAILURE, succeeded: false, nativeExitCode: null, signalled: null },
      ]);
    }
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
    port: FileSystemPort | null,
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
      // The SESSION's view, not a kernel-wide one: which directory a relative
      // path resolves against is a property of the session that typed it.
      fs: port,
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
