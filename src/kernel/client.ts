/**
 * client.ts — the host half. The terminal's entire view of the kernel.
 *
 * The point of this file is what is NOT in it. There is no `Kernel` here, no
 * `CommandModule`, no pipeline, no binder, no `PSObject` — it imports the
 * protocol, the wire types and a transport, and nothing else. That is the
 * boundary being real rather than described: the terminal cannot reach into
 * execution because there is nothing here to reach with, and a command cannot
 * touch the DOM because it is running in another thread.
 *
 * It replaces the shape v1 has instead, where `run()` parses the line,
 * executes it, prints to the page and scrolls, inline, on the UI thread — and
 * where a streaming command cannot be composed at all, so index.html refuses
 * rather than models it:
 *
 *     這個指令是逐行串流輸出,不能用在管線中。
 *
 * Here PARSE and EXECUTE are on the far side of a `postMessage` and RENDER is
 * on this side, and a streaming command is just a command that emits more than
 * once (roadmap 6.2 and 6.3).
 *
 * ---------------------------------------------------------------------------
 * WHY THE ARRIVING EVENTS ARE DECODED
 * ---------------------------------------------------------------------------
 *
 * `Kernel.send` takes `unknown` and decodes, because the sender is a page. The
 * mirror is true the moment the kernel is a Worker: a worker runs command code,
 * PR-14's whole subject is that some of that code will be third-party, and a
 * `switch (event.kind)` on this side is a claim about a sender this side does
 * not control. So every message goes through `decodeKernelEvent` and a
 * malformed one is RECORDED and dropped, never thrown past. A terminal that
 * crashes when the kernel misbehaves has turned a kernel bug into a lost
 * session.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS A QUEUE
 * ---------------------------------------------------------------------------
 *
 * Same reason `Kernel.#emit` has one, and the same measurement. A listener is
 * allowed to answer an event by sending a request — a terminal that
 * auto-responds does exactly that. With a real Worker the reply comes back on a
 * later task and nothing interleaves. With a SAME-REALM transport — a direct
 * pair, an in-process kernel, a test double — `post` reaches the kernel
 * synchronously and its events arrive back INSIDE this listener's own call, so
 * a naive dispatcher delivers seq 4 in the middle of delivering seq 3.
 * Measured, in the kernel, before its queue existed:
 *
 *     delivery order of seq: 1,2,4,3,5,6
 *
 * The transport must not decide whether ordering holds.
 */

import type { ProcessId, RequestId, TerminalId } from './ids.ts';
import type { ExitEvent, KernelEvent, KernelRequest } from './protocol.ts';
import { decodeKernelEvent } from './protocol.ts';
import type { VirtualSignal } from './signals.ts';
import type { KernelTransport } from './transport.ts';
import type { WireErrorRecord, WireValue } from './wire.ts';

// ---------------------------------------------------------------------------
// what the caller sees
// ---------------------------------------------------------------------------

/** A message from the kernel that this client would not act on. */
export interface ProtocolViolation {
  readonly problems: readonly string[];
  /** The message exactly as it arrived, for whoever has to work out why. */
  readonly message: unknown;
  /** True when the message was discarded rather than delivered to listeners. */
  readonly dropped: boolean;
}

/**
 * How one `exec` ended.
 *
 * Carries the SUCCESS and ERROR streams and the exits, which is what a caller
 * that waits for a whole command wants. Warnings, verbose, debug, information,
 * progress and the two byte channels are deliberately NOT collected: they are
 * progressive by nature, a caller that cares about them is rendering as they
 * arrive, and buffering them here would be a second, worse renderer.
 */
export interface ExecOutcome {
  readonly requestId: RequestId;
  /** The success stream, in arrival order, flattened across `objects` events. */
  readonly values: readonly WireValue[];
  /** Stream 2, from every stage of the pipeline. */
  readonly errors: readonly WireErrorRecord[];
  /** One per process, in the order the kernel reported them. */
  readonly exits: readonly ExitEvent[];
  /**
   * The LAST stage's status, or null when nothing ran.
   *
   * The last stage's and not the leader's, in POSIX and in PowerShell alike:
   * `Get-Content missing.txt | Select-Object -First 1` fails in the reader and
   * succeeds in the selector, and the pipeline's answer is the selector's.
   */
  readonly exitCode: number | null;
  /**
   * `$?` for the whole pipeline: the AND over its stages.
   *
   * Not `exitCode === 0`. Measured in pwsh 7.6.5, a failing first stage feeding
   * a succeeding last stage still leaves `$?` False.
   */
  readonly succeeded: boolean;
  /** The signal that stopped it, or null if it finished on its own. */
  readonly signalled: VirtualSignal | null;
  /** Why the kernel would not run it, or null when it ran. */
  readonly rejected: readonly string[] | null;
}

export interface ExecOptions {
  /** Background (`&`, `Start-Job`) rather than foreground. Default false. */
  readonly background?: boolean;
  /** Use this correlation id instead of minting one. Must not be reused. */
  readonly requestId?: RequestId;
  /** Which pane. Defaults to the client's own terminal id. */
  readonly terminalId?: TerminalId;
}

export interface KernelClientOptions {
  /** The pane this client speaks for. Defaults to a fresh unique id. */
  readonly terminalId?: TerminalId;
  /** Override the correlation-id generator, e.g. to make a test deterministic. */
  readonly newRequestId?: () => RequestId;
  /** Told about every message this client would not act on. */
  readonly onViolation?: (violation: ProtocolViolation) => void;
  /** Told when an event listener throws. Default rethrows on a microtask. */
  readonly onListenerError?: (error: unknown, event: KernelEvent) => void;
}

/** Thrown for a caller's own mistake, which is never a transport failure. */
export class KernelClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KernelClientError';
  }
}

/**
 * How many violations are kept.
 *
 * BOUNDED, because the sender is the thing that misbehaved and an unbounded
 * record of its misbehaviour is a memory exhaustion the misbehaving side gets
 * to choose the size of. Fifty is enough to see a pattern and small enough that
 * a flood costs nothing; `violationCount` keeps counting past it, so a full
 * buffer is never mistaken for a quiet one.
 */
const MAX_RECORDED_VIOLATIONS = 50;

interface Pending {
  readonly values: WireValue[];
  readonly errors: WireErrorRecord[];
  readonly exits: ExitEvent[];
  /** Pids the kernel has told us belong to this request. */
  readonly processes: Set<ProcessId>;
  readonly settle: (outcome: ExecOutcome) => void;
}

/**
 * A per-client prefix so two clients on one kernel cannot mint the same id.
 *
 * The same reasoning as `ScriptBlockRegistry`'s realm id: two counters both
 * starting at 1 hand out the same string, and the kernel refuses the second —
 * so the second terminal in a page would stop working, for a reason no
 * transcript would explain.
 */
function newClientId(): string {
  const source: unknown = globalThis.crypto;
  if (typeof source === 'object' && source !== null && 'randomUUID' in source) {
    return (source as Crypto).randomUUID().slice(0, 8);
  }
  return Math.random().toString(36).slice(2, 10);
}

export class KernelClient {
  readonly #transport: KernelTransport;
  readonly #terminalId: TerminalId;
  readonly #newRequestId: () => RequestId;
  readonly #onViolation: (violation: ProtocolViolation) => void;
  readonly #onListenerError: (error: unknown, event: KernelEvent) => void;

  readonly #listeners = new Set<(event: KernelEvent) => void>();
  readonly #pending = new Map<RequestId, Pending>();
  /** Which request a pid belongs to, for the events that are keyed by pid. */
  readonly #processRequests = new Map<ProcessId, RequestId>();
  /** Every id this client has minted or been given. Refused twice over. */
  readonly #used = new Set<RequestId>();
  readonly #cwd = new Map<TerminalId, string>();
  readonly #violations: ProtocolViolation[] = [];
  readonly #outbox: KernelEvent[] = [];
  readonly #detach: () => void;

  #violationCount = 0;
  #lastSequence = 0;
  #delivering = false;
  #closed = false;
  #nextRequest = 1;

  constructor(transport: KernelTransport, options: KernelClientOptions = {}) {
    this.#transport = transport;
    this.#terminalId = options.terminalId ?? `terminal-${newClientId()}`;
    const prefix = newClientId();
    this.#newRequestId =
      options.newRequestId ??
      (() => {
        const id = `${prefix}-${this.#nextRequest}`;
        this.#nextRequest += 1;
        return id;
      });
    this.#onViolation = options.onViolation ?? (() => undefined);
    this.#onListenerError =
      options.onListenerError ??
      ((error: unknown) => {
        queueMicrotask(() => {
          throw error;
        });
      });
    this.#detach = transport.listen((message) => {
      this.#receive(message);
    });
  }

  // -- inspection ----------------------------------------------------------

  get terminalId(): TerminalId {
    return this.#terminalId;
  }

  /**
   * The highest sequence number seen, or 0 before anything has arrived.
   *
   * The same number `Kernel.sequence` reports, observed from the other side of
   * the transport. A reconnecting consumer says what it has already seen with
   * this.
   */
  get lastSequence(): number {
    return this.#lastSequence;
  }

  /** How many messages this client refused. Counts past the recorded window. */
  get violationCount(): number {
    return this.#violationCount;
  }

  /** The most recent refusals, oldest first, capped. See MAX_RECORDED_VIOLATIONS. */
  get violations(): readonly ProtocolViolation[] {
    return [...this.#violations];
  }

  /**
   * Where the shell is, as last reported — or null if the kernel has never said.
   *
   * The whole of roadmap 6.4 from this side: v1's `cd` reached into the page and
   * rewrote the prompt, so the prompt was owned by whichever command last ran.
   * The prompt is now rendered from this, and only the terminal draws it.
   */
  cwd(terminalId: TerminalId = this.#terminalId): string | null {
    return this.#cwd.get(terminalId) ?? null;
  }

  // -- events --------------------------------------------------------------

  /** Subscribe to every event, in sequence order. The result unsubscribes. */
  on(listener: (event: KernelEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // -- requests ------------------------------------------------------------

  /**
   * Submit a command line. Returns the correlation id, does not wait.
   *
   * The signature a message-passing API has. `run` is the convenience over it
   * for a caller that wants the whole result, and it is built ON this rather
   * than beside it, so there is one way a request is sent.
   */
  exec(source: string, options: ExecOptions = {}): RequestId {
    const requestId = options.requestId ?? this.#newRequestId();
    this.#refuseInFlight(requestId);
    this.#submit(source, options, requestId);
    return requestId;
  }

  /**
   * A correlation id that names two executions correlates nothing.
   *
   * Only about requests still IN FLIGHT here. Reusing the id of one that has
   * FINISHED is refused too, but by the kernel, which is the side that holds the
   * whole transcript — and a client that answered for it would be duplicating a
   * check it can only get wrong.
   */
  #refuseInFlight(requestId: RequestId): void {
    if (!this.#pending.has(requestId)) return;
    throw new KernelClientError(
      `requestId '${requestId}' already has a request in flight; a correlation id that ` +
        'names two executions correlates nothing',
    );
  }

  /** The one place an `exec` is put on the wire. `exec` and `run` share it. */
  #submit(source: string, options: ExecOptions, requestId: RequestId): void {
    this.#used.add(requestId);
    this.#send({
      kind: 'exec',
      requestId,
      terminalId: options.terminalId ?? this.#terminalId,
      source,
      background: options.background ?? false,
    });
  }

  /**
   * Submit, and resolve when every process of the request has exited.
   *
   * NEVER REJECTS. A command that fails, a command that was signalled and a
   * request the kernel refused are all outcomes rather than exceptions —
   * `ExecOutcome` says which — because a rejected promise for "the command
   * exited 1" makes every caller write a try/catch that means "read the exit
   * code". A caller's OWN mistake — a reused id, a closed transport — throws
   * synchronously, before anything is sent, so it cannot be mistaken for one.
   *
   * THE BOOKKEEPING IS REGISTERED BEFORE THE REQUEST IS SENT, and that
   * ordering is load-bearing rather than tidy. This used to mint the id, send,
   * and then register — which works only if the reply cannot arrive during the
   * send. Across a real Worker it cannot. Across a SAME-REALM transport it
   * can and does: `post` reaches the kernel synchronously, and every event of a
   * request the kernel refuses is emitted inside that call. MEASURED, with a
   * directly-wired transport pair:
   *
   *     run() over a same-realm transport: settled
   *     run() of an unknown command:       hung
   *     run() of an empty line:            hung
   *
   * Both of those complete entirely before the old code reached its
   * `#pending.set`, so nothing was listening when the only events they would
   * ever produce went past — a promise that never settles, from a transport
   * that was merely faster than expected. The first line only passed because a
   * process announces itself a second time when it exits.
   *
   * Completion is decided from the kernel's own events and not from a timer:
   * the kernel creates every process of a pipeline BEFORE running any of them,
   * and events arrive in sequence order, so "at least one process was announced
   * and all of them have exited" cannot be satisfied early.
   *
   * THE HONEST LIMIT: a LOST event can leave this pending forever. A `post`
   * that throws on the worker side — `DataCloneError`, a dead port — takes an
   * `exit` with it, and no timer here would know the difference between a lost
   * exit and a command that is still running. What the loss does produce is a
   * reported gap in the sequence, which is why the ordinal is dense and why
   * `violations` is worth reading when something never finishes.
   */
  run(source: string, options: ExecOptions = {}): Promise<ExecOutcome> {
    const requestId = options.requestId ?? this.#newRequestId();
    this.#refuseInFlight(requestId);
    if (this.#closed) throw new KernelClientError('the transport is closed');

    // The executor runs synchronously, so `settle` is assigned before the next
    // statement — which is what lets the entry be complete before anything is
    // sent.
    let settle!: (outcome: ExecOutcome) => void;
    const promise = new Promise<ExecOutcome>((resolve) => {
      settle = resolve;
    });
    this.#pending.set(requestId, {
      values: [],
      errors: [],
      exits: [],
      processes: new Set(),
      settle,
    });

    try {
      // `#submit` and not `exec`, because the in-flight guard has already run
      // and the entry it would now trip over is the one registered above.
      this.#submit(source, options, requestId);
    } catch (error: unknown) {
      // Nothing was sent, so nothing will ever settle this entry.
      this.#pending.delete(requestId);
      throw error;
    }
    return promise;
  }

  /**
   * Abandon a request.
   *
   * Addresses the REQUEST and not a process, which is the whole reason both
   * exist: between sending `exec` and the first `process-changed` there is no
   * pid, and a Ctrl+C in that window has nothing else to name.
   */
  cancel(requestId: RequestId): void {
    this.#send({ kind: 'cancel', requestId });
  }

  /**
   * Deliver a signal.
   *
   * A NEGATIVE `processId` addresses the group led by its absolute value, which
   * is `kill()`'s own convention and is how one Ctrl+C reaches a whole pipeline.
   */
  signal(processId: ProcessId, signal: VirtualSignal): void {
    this.#send({ kind: 'signal', processId, signal });
  }

  /** Character cells, not pixels: what `Format-Table` and `$Host.UI` will read. */
  resize(columns: number, rows: number, terminalId: TerminalId = this.#terminalId): void {
    this.#send({ kind: 'resize', terminalId, columns, rows });
  }

  /** Feed a process's stdin. Bytes, so a UTF-16 round trip cannot corrupt them. */
  stdin(processId: ProcessId, bytes: Uint8Array, endOfFile = false): void {
    this.#send({ kind: 'stdin', processId, bytes, endOfFile });
  }

  /**
   * Post a message the protocol does not describe.
   *
   * Exists so the far side's DECODER can be exercised from here — sending a
   * malformed request through a typed API is impossible by construction, which
   * is exactly why the check on the other side has to be tested through a door
   * that allows it. Not for ordinary use, and named so nobody reaches for it.
   */
  postRaw(message: unknown): void {
    if (this.#closed) throw new KernelClientError('the transport is closed');
    this.#transport.post(message);
  }

  /**
   * Detach from the transport and settle anything still waiting.
   *
   * The pending requests are settled rather than dropped: a promise nobody will
   * ever resolve is a hang, and a terminal that closed its pane still has to
   * stop the spinner it started.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const requestId of [...this.#pending.keys()]) {
      this.#settle(requestId, ['the transport closed before the request completed']);
    }
    this.#listeners.clear();
    this.#detach();
    this.#transport.close();
  }

  // -- receiving -----------------------------------------------------------

  #send(request: KernelRequest): void {
    if (this.#closed) throw new KernelClientError('the transport is closed');
    this.#transport.post(request);
  }

  #receive(message: unknown): void {
    const decoded = decodeKernelEvent(message);
    if (!decoded.ok) {
      this.#violation(decoded.problems, message, true);
      return;
    }
    const event = decoded.value;

    // ORDER IS THE ONE THING A SEQUENCE NUMBER IS FOR, so a number that does
    // not advance is not an event, it is evidence. A message channel preserves
    // order, so a repeat or a regression means the far side minted two events
    // with one ordinal or something replayed one — and delivering it would
    // render the same output twice.
    if (event.seq <= this.#lastSequence) {
      this.#violation(
        [
          `seq ${event.seq} arrived after ${this.#lastSequence}; the kernel's ordinal must ` +
            'strictly increase, so this is a replay or a duplicate',
        ],
        message,
        true,
      );
      return;
    }
    if (event.seq > this.#lastSequence + 1) {
      // DELIVERED anyway. A gap means something was lost — a post that threw,
      // a dropped message — and the events that DID arrive are still true. What
      // must not happen is the loss going unnoticed, which is the failure the
      // dense counter exists to make visible.
      this.#violation(
        [
          `seq jumped from ${this.#lastSequence} to ${event.seq}; ` +
            `${event.seq - this.#lastSequence - 1} event(s) never arrived`,
        ],
        message,
        false,
      );
    }
    this.#lastSequence = event.seq;

    this.#outbox.push(event);
    if (this.#delivering) return;
    this.#delivering = true;
    try {
      for (let next = this.#outbox.shift(); next !== undefined; next = this.#outbox.shift()) {
        this.#route(next);
        // Copied first: a listener that unsubscribes on `exit` — the obvious
        // thing for a "wait for this command" helper to do — would otherwise
        // mutate the set while it is being iterated. Contained one at a time,
        // because one renderer's bug must not cost another renderer its event.
        for (const listener of [...this.#listeners]) {
          try {
            listener(next);
          } catch (error: unknown) {
            try {
              this.#onListenerError(error, next);
            } catch {
              // The sink for errors is the thing that failed. There is nowhere
              // left to put this, and rethrowing would stop the delivery that
              // the containment exists to protect.
            }
          }
        }
      }
    } finally {
      this.#delivering = false;
    }
  }

  #violation(problems: readonly string[], message: unknown, dropped: boolean): void {
    const violation: ProtocolViolation = { problems, message, dropped };
    this.#violationCount += 1;
    this.#violations.push(violation);
    if (this.#violations.length > MAX_RECORDED_VIOLATIONS) this.#violations.shift();
    try {
      this.#onViolation(violation);
    } catch {
      // Same reasoning as a listener's reporter: a handler that throws must not
      // be able to stop the client from reading its transport.
    }
  }

  /** Update this client's own bookkeeping. Runs before the listeners see it. */
  #route(event: KernelEvent): void {
    switch (event.kind) {
      case 'cwd-changed':
        this.#cwd.set(event.terminalId, event.cwd);
        return;
      case 'process-changed': {
        const pending = this.#pending.get(event.snapshot.requestId);
        if (pending === undefined) return;
        pending.processes.add(event.snapshot.pid);
        // Only while somebody is waiting: the map is how an error or a byte
        // channel — both keyed by pid — finds its request, and keeping it for
        // requests nobody awaits would be an unbounded map of dead pids.
        this.#processRequests.set(event.snapshot.pid, event.snapshot.requestId);
        return;
      }
      case 'objects': {
        const pending = this.#pending.get(event.requestId);
        pending?.values.push(...event.values);
        return;
      }
      case 'stream': {
        if (event.which !== 'error') return;
        const requestId = this.#processRequests.get(event.processId);
        if (requestId === undefined) return;
        this.#pending.get(requestId)?.errors.push(event.payload);
        return;
      }
      case 'exit': {
        const pending = this.#pending.get(event.requestId);
        if (pending === undefined) return;
        pending.exits.push(event);
        // The kernel announces every process of a pipeline before running any
        // of them, and events arrive in sequence order, so this cannot be
        // satisfied by a first stage that finished before a second appeared.
        if (pending.processes.size > 0 && pending.exits.length >= pending.processes.size) {
          this.#settle(event.requestId, null);
        }
        return;
      }
      case 'rejected': {
        if (event.requestId === null) return;
        // The kernel will not run it, so nothing else is coming for this id.
        if (this.#pending.has(event.requestId)) this.#settle(event.requestId, event.problems);
        return;
      }
      case 'stdout':
      case 'stderr':
        return;
      default:
        return assertNever(event);
    }
  }

  #settle(requestId: RequestId, rejected: readonly string[] | null): void {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return;
    this.#pending.delete(requestId);
    for (const pid of pending.processes) this.#processRequests.delete(pid);

    const last = pending.exits[pending.exits.length - 1];
    pending.settle({
      requestId,
      values: pending.values,
      errors: pending.errors,
      exits: pending.exits,
      exitCode: last?.exitCode ?? null,
      // `$?` is the AND over the stages, which is measurably not "the last one
      // succeeded"; a rejected request succeeded at nothing.
      succeeded: rejected === null && pending.exits.length > 0
        ? pending.exits.every((exit) => exit.succeeded)
        : false,
      signalled: pending.exits.find((exit) => exit.signalled !== null)?.signalled ?? null,
      rejected,
    });
  }
}

/**
 * Compile-time proof that `#route` handles every event kind.
 *
 * A new kind added to the protocol makes this a type error rather than a silent
 * default branch — which is how an event that a terminal needs ends up being
 * received, counted in the sequence, and then quietly ignored.
 */
function assertNever(event: never): void {
  void event;
}
