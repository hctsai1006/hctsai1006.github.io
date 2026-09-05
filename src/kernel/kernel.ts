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
 * deletion. Lexing, the AST and version-aware binding belong to the binder, and
 * every parameter rule that leaks in here is one that will have to be removed
 * from two places later.
 */

import type {
  BindingResult,
  CommandModule,
  CompatibilityView,
  InvocationContext,
} from '../commands/invocation.ts';
import { CapabilityDeniedError } from '../commands/invocation.ts';
import type { Capability } from '../commands/manifest.ts';
import type { DialogPort, FileSystemPort, PreferencesPort } from '../commands/ports.ts';
import type { PSValue } from '../pipeline/psobject.ts';
import type {
  ErrorRecord,
  InformationRecord,
  NativeStreams,
  PowerShellStreams,
  ProgressRecord,
} from '../pipeline/streams.ts';
import { CallbackSink, errorRecord } from '../pipeline/streams.ts';
import type { ProcessGroupId, ProcessId, RequestId, TerminalId } from './ids.ts';
import type { KernelEvent, KernelRequest } from './protocol.ts';
import { assertCloneSafe, sanitizePSValue } from './protocol.ts';
import { AuditLog, CapabilityBroker, VirtualPolicy } from './capabilities.ts';
import { JobManager } from './process/jobs.ts';
import type { ProcessSnapshot } from './process/snapshot.ts';
import { ProcessTable } from './process/table.ts';
import type { VirtualSignal } from './signals.ts';
import { SIGNAL_EXIT_CODE, SignalController, isPipelineStopped } from './signals.ts';

// ---------------------------------------------------------------------------
// exit codes with meanings
// ---------------------------------------------------------------------------

/**
 * `command not found`. The shell convention, and what makes `if (!$?)` and
 * `$LASTEXITCODE -eq 127` mean the same here as in bash and in pwsh on Unix.
 */
export const EXIT_COMMAND_NOT_FOUND = 127;
/** A command threw, or was denied a capability. */
export const EXIT_FAILURE = 1;

// ---------------------------------------------------------------------------
// the object queue that joins two pipeline stages
// ---------------------------------------------------------------------------

/**
 * A single-producer, single-consumer channel of pipeline objects.
 *
 * Single-consumer is a real constraint, not a simplification: a pipeline stage
 * has exactly one reader, and two readers would silently split the objects
 * between them. It is enforced by construction — the kernel creates one queue
 * per join and hands its iterable to exactly one stage.
 *
 * Buffering here is unbounded, which is the honest limit of this milestone. The
 * `Sink` contract is async precisely so back-pressure can be added without a
 * signature change; adding it needs the transport's credit protocol, which
 * arrives with the Worker.
 */
class ObjectQueue implements AsyncIterable<PSValue> {
  readonly #buffer: PSValue[] = [];
  #wake: (() => void) | null = null;
  #closed = false;

  push(value: PSValue): void {
    if (this.#closed) return;
    this.#buffer.push(value);
    this.#signal();
  }

  close(): void {
    this.#closed = true;
    this.#signal();
  }

  #signal(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<PSValue> {
    for (;;) {
      while (this.#buffer.length > 0) {
        yield this.#buffer.shift() as PSValue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }
}

/** An empty pipeline input: what the first stage of a pipeline receives. */
const EMPTY_INPUT: AsyncIterable<PSValue> = {
  async *[Symbol.asyncIterator](): AsyncGenerator<PSValue> {
    // Intentionally empty. `Get-Process` first in a pipeline gets no input, and
    // that is different from getting `$null` — which would be one object.
  },
};

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
}

/** Per-terminal state the kernel owns because the DOM is not reachable. */
interface TerminalState {
  cwd: string;
  columns: number;
  rows: number;
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
};

/** How a stage ended. The last stage's result is the pipeline's. */
interface StageResult {
  readonly exitCode: number;
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
  readonly #env: Map<string, string>;
  readonly #clock: () => number;
  readonly #profile: CompatibilityView;
  readonly #defaultCwd: string;
  readonly #fs: FileSystemPort | null;
  readonly #preferences: PreferencesPort | null;
  readonly #dialog: DialogPort | null;
  readonly #validateEvents: boolean;

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
      if (signal === 'SIGKILL') this.#finish(pid, SIGNAL_EXIT_CODE.SIGKILL, 'SIGKILL');
      else this.#table.transition(pid, 'stopping');
    });
  }

  // -- inspection ----------------------------------------------------------

  get processes(): ProcessTable {
    return this.#table;
  }

  get jobs(): JobManager {
    return this.#jobs;
  }

  get signals(): SignalController {
    return this.#signals;
  }

  get capabilities(): CapabilityBroker {
    return this.#broker;
  }

  get audit(): AuditLog {
    return this.#broker.audit;
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

  #emit(event: KernelEvent): void {
    if (this.#validateEvents) assertCloneSafe(event, `KernelEvent(${event.kind})`);
    // Copy first: a listener that unsubscribes on `exit` — the obvious thing
    // for a "wait for this command" helper to do — would otherwise mutate the
    // set while it is being iterated.
    for (const listener of [...this.#listeners]) listener(event);
  }

  // -- the protocol entry point -------------------------------------------

  /**
   * Handle one request. The single door in, shaped like `onmessage`.
   *
   * Returns void rather than a promise on purpose: this is the signature a
   * message handler has, and a UI that could `await` a request would grow code
   * that cannot survive the move into a Worker. Callers that need to join —
   * tests, a script runner, an MCP tool — use `drain`.
   */
  send(request: KernelRequest): void {
    switch (request.kind) {
      case 'exec':
        this.#exec(request.requestId, request.terminalId, request.source, request.background);
        return;
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
      terminal = { cwd: this.#defaultCwd, columns: DEFAULT_COLUMNS, rows: DEFAULT_ROWS };
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

    // The group leader is the FIRST stage, as in POSIX. Every later stage joins
    // it, so one signal stops the whole pipeline rather than leaving earlier
    // stages producing into a sink nobody reads.
    let leader: ProcessGroupId | null = null;
    const started: { snapshot: ProcessSnapshot; module: CommandModule; tokens: readonly string[] }[] = [];

    for (const entry of resolved) {
      const module = entry.module as CommandModule;
      const snapshot = this.#table.create({
        name: module.manifest.display,
        commandLine: entry.stage,
        cwd: terminal.cwd,
        runtime: module.manifest.runtime,
        terminalId,
        requestId,
        background,
        ...(leader === null ? {} : { pgid: leader, ppid: leader }),
      });
      leader ??= snapshot.pid;
      started.push({ snapshot, module, tokens: entry.tokens });
    }

    const groupLeader = leader as ProcessId;

    // Foreground pipelines own the terminal's Ctrl+C; background ones must not,
    // which is the entire reason process groups are here.
    if (!background) this.#signals.setForeground(terminalId, groupLeader);

    // The job's handle is keyed on the group leader's pid, so the pipeline's
    // output can be buffered under one job however many stages it has.
    if (background) this.#jobs.start(groupLeader, source);

    // Queues join the stages. Stage i writes into queue i, stage i+1 reads it.
    const queues = started.slice(0, -1).map(() => new ObjectQueue());

    const promises = started.map((entry, index) => {
      const input: AsyncIterable<PSValue> = index === 0 ? EMPTY_INPUT : (queues[index - 1] as ObjectQueue);
      const downstream = queues[index] ?? null;
      return this.#runStage(entry.snapshot, entry.module, entry.tokens, input, downstream, groupLeader);
    });

    const all = Promise.all(promises).then((results) => {
      // A pipeline's exit code is its LAST stage's, in POSIX and in PowerShell
      // alike. Taking the leader's would report success for
      // `Get-Content missing.txt | Select-Object -First 1` because the reader
      // is not the stage that failed.
      const last = results[results.length - 1];
      if (background && last !== undefined) {
        this.#jobs.finish(groupLeader, last.exitCode, last.signalled !== null);
      }
      if (!background && this.#signals.foregroundGroup(terminalId) === groupLeader) {
        this.#signals.setForeground(terminalId, null);
      }
      this.#cancelled.delete(requestId);
    });
    this.#track(all);

    // A cancel that arrived before the processes existed still has to land.
    if (this.#cancelled.has(requestId)) {
      this.#cancelled.delete(requestId);
      this.#signals.raiseGroup(groupLeader, 'SIGINT');
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
      payload: errorRecord(
        `The term '${name}' is not recognized as a name of a cmdlet, function, script file, or executable program.`,
        'CommandNotFoundException',
        name,
        'ObjectNotFound',
        { exceptionType: 'System.Management.Automation.CommandNotFoundException', targetObject: name },
      ),
    });
    this.#finish(snapshot.pid, EXIT_COMMAND_NOT_FOUND, null);
  }

  async #runStage(
    snapshot: ProcessSnapshot,
    module: CommandModule,
    tokens: readonly string[],
    input: AsyncIterable<PSValue>,
    downstream: ObjectQueue | null,
    groupLeader: ProcessGroupId,
  ): Promise<StageResult> {
    const { pid, requestId, terminalId, background } = snapshot;
    const signal = this.#signals.register(pid, groupLeader);
    const stdin = new StdinPipe();

    // Where the success stream goes depends on who is watching. A foreground
    // pipeline's last stage is the request's result; a background one's is
    // buffered for `Receive-Job`, because PowerShell does not print background
    // output to the console and a terminal that did would interleave it with
    // whatever the user is typing now.
    const onSuccess = (value: PSValue): void => {
      const safe = sanitizePSValue(value);
      if (downstream !== null) {
        downstream.push(safe);
        return;
      }
      if (background) {
        this.#jobs.record(groupLeader, safe);
        return;
      }
      this.#emit({ kind: 'objects', requestId, values: [safe] });
    };

    const onError = (record: ErrorRecord): void => {
      if (background) this.#jobs.recordError(groupLeader, record);
      this.#emit({ kind: 'stream', processId: pid, which: 'error', payload: record });
    };

    const streams = this.#buildStreams(pid, onSuccess, onError);
    const native = this.#buildNativeStreams(pid, stdin);

    const running: Running = {
      pid,
      requestId,
      terminalId,
      leader: groupLeader,
      background,
      stdin,
      closeStreams: streams.close,
    };
    this.#running.set(pid, running);

    const env = new Map(this.#env);
    // A shell exports these; `Format-Table` and anything that wraps needs them,
    // and reading them from the DOM is not available to a kernel that must run
    // in a Worker.
    const size = this.terminalSize(terminalId);
    env.set('COLUMNS', String(size.columns));
    env.set('LINES', String(size.rows));
    env.set('PWD', snapshot.cwd);

    const scoped = this.#broker.forCommand(module.manifest, pid);
    const context: InvocationContext = {
      profile: this.#profile,
      streams: streams.streams,
      native,
      input,
      cwd: snapshot.cwd,
      env,
      signal,
      requireCapability: (capability) => {
        scoped.require(capability);
      },
      fs: this.#fs,
      preferences: this.#preferences,
      dialog: this.#dialog,
    };

    // Not the binder. Until PR-08 exists the kernel hands the raw remainder
    // through rather than inventing binding semantics that would then have to
    // be un-invented in two places.
    const binding: BindingResult = {
      parameters: {},
      parameterSet: '__AllParameterSets',
      remaining: tokens.slice(1),
    };

    this.#table.transition(pid, 'running');

    let exitCode = EXIT_FAILURE;
    let signalled: VirtualSignal | null = null;
    try {
      exitCode = await module.invoke(context, binding);
    } catch (error: unknown) {
      if (isPipelineStopped(error) || signal.aborted) {
        signalled = this.#signals.deliveredTo(pid) ?? 'SIGINT';
        exitCode = SIGNAL_EXIT_CODE[signalled];
      } else if (error instanceof CapabilityDeniedError) {
        await streams.streams.error.write(
          errorRecord(error.message, 'CapabilityDenied', module.manifest.display, 'PermissionDenied', {
            exceptionType: 'System.UnauthorizedAccessException',
            targetObject: error.capability,
          }),
        );
        exitCode = EXIT_FAILURE;
      } else {
        const message = error instanceof Error ? error.message : String(error);
        await streams.streams.error.write(
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

    // Close downstream before reporting the exit, so the next stage sees
    // end-of-input rather than hanging on a producer that has already gone.
    downstream?.close();
    this.#finish(pid, exitCode, signalled);
    return { exitCode, signalled };
  }

  /**
   * Report an exit exactly once.
   *
   * The guard is not defensive tidiness. A SIGKILLed process is finished by the
   * signal listener while its invocation is still running, and that invocation
   * will later settle and try to report its own code. The kill happened first
   * and is what the user saw, so the later report must lose.
   */
  #finish(pid: ProcessId, exitCode: number, signalled: VirtualSignal | null): void {
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
      signalled,
    });
  }

  #buildStreams(
    pid: ProcessId,
    onSuccess: (value: PSValue) => void,
    onError: (record: ErrorRecord) => void,
  ): { streams: PowerShellStreams; close: () => void } {
    const success = new CallbackSink<PSValue>(onSuccess);
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
      this.#emit({ kind: 'stream', processId: pid, which: 'information', payload: record });
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
        for (const sink of [success, error, warning, verbose, debug, information, progress]) {
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
