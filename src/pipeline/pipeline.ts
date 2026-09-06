/**
 * pipeline.ts — composing commands into an object pipeline.
 *
 * The three properties this file exists to provide, in the order they bite:
 *
 *   BACKPRESSURE      a fast producer must not be able to outrun a slow
 *                     consumer. In a browser tab there is no OS to page us
 *                     out: `1..10000000 | Where-Object {...} | Format-Table`
 *                     buffering the middle of that pipeline is a dead tab.
 *
 *   CANCELLATION      Ctrl+C has to reach every stage, not just the one the
 *                     engine happens to be inside. A stage parked waiting for
 *                     its consumer must wake up and fail, not sit forever.
 *
 *   EARLY TERMINATION `Select-Object -First 3` STOPS the upstream. This was
 *                     verified rather than assumed, with a side effect that
 *                     makes it observable:
 *
 *                       1..10 | ForEach-Object { $seen += $_; $_ } |
 *                         Select-Object -First 3
 *                       $seen  ->  1,2,3          (pwsh 7.6.5)
 *
 *                     Not 1..10, and not 1..4. The producer runs exactly three
 *                     times. Upstream really is torn down, not just ignored.
 *
 * How the three fall out of one mechanism
 * ---------------------------------------
 * A stage is an async generator. That is not a stylistic choice; JavaScript's
 * async iteration protocol already has the semantics PowerShell needs:
 *
 *   - a generator suspends at `yield` until the consumer asks again, which IS
 *     backpressure, with no buffer to size and no watermark to tune;
 *   - when a consumer `break`s, the runtime calls `.return()` on the iterator,
 *     which resumes the generator at its `yield` with a return completion and
 *     runs its `finally` — so tearing down one stage tears down the whole
 *     upstream chain, which IS early termination.
 *
 * Commands cannot be generators, because a `CommandModule` writes to six
 * streams and returns an exit code (see invocation.ts for why). So the bridge
 * between "writes to a Sink" and "is an AsyncIterable" is `ObjectChannel`, and
 * getting its acknowledgement rule right is what makes the observed 1,2,3
 * reproduce exactly. See the comment on `write` — the obvious rule is off by
 * one, and the probe is what showed it.
 */

import { enumerate } from './psobject.ts';
import type { PSValue } from './psobject.ts';
import type { NativeStreams, PowerShellStreams, Sink } from './streams.ts';
import type {
  BindingResult,
  CommandModule,
  CompatibilityView,
  InvocationContext,
} from '../commands/invocation.ts';
import type { Capability } from '../commands/manifest.ts';
import type { ProviderRegistry } from '../providers/index.ts';
import type { DialogPort, FileSystemPort, PreferencesPort } from '../commands/ports.ts';

// ---------------------------------------------------------------------------
// cancellation
// ---------------------------------------------------------------------------

/**
 * What a cancelled pipeline throws. Distinct from a command failing: the
 * terminal reports `^C` for this and an ErrorRecord for that, and `$?` differs.
 */
export class PipelineCancelledError extends Error {
  readonly stage: string;
  constructor(stage: string) {
    super(`The pipeline was stopped while running ${stage}.`);
    this.name = 'PipelineCancelledError';
    this.stage = stage;
  }
}

/**
 * The check every long-running command loop owes the user.
 *
 * Exported because a command that loops without input — a generator like
 * `1..1000000` — has no `for await` to inherit cancellation from, so it has to
 * ask.
 */
export function throwIfCancelled(signal: AbortSignal, stage = 'the pipeline'): void {
  if (signal.aborted) throw new PipelineCancelledError(stage);
}

// ---------------------------------------------------------------------------
// the channel between a command's Sink and the next stage's AsyncIterable
// ---------------------------------------------------------------------------

type Resolver = (result: IteratorResult<PSValue>) => void;
type Rejecter = (reason: unknown) => void;

/**
 * A one-value-at-a-time channel: a `Sink<PSValue>` on one end, an
 * `AsyncIterable<PSValue>` on the other.
 *
 * `slack` is how far ahead of the consumer the producer may run. It defaults to
 * ZERO, which is the setting that reproduces the reference implementation —
 * see `write`.
 */
export class ObjectChannel implements Sink<PSValue>, AsyncIterable<PSValue> {
  readonly #slack: number;
  readonly #buffer: PSValue[] = [];
  readonly #readers: Array<{ resolve: Resolver; reject: Rejecter }> = [];
  /** Producers parked inside `write`, waiting for the consumer to catch up. */
  readonly #acks: Array<() => void> = [];

  /** How many times the consumer has asked for a value. */
  #demand = 0;
  /** How many times `write` has been called. Indexes the acknowledgement rule. */
  #writes = 0;
  #ended = false;
  #abandoned = false;
  #failure: { reason: unknown } | null = null;

  constructor(slack = 0) {
    this.#slack = slack < 0 ? 0 : slack;
  }

  /**
   * True once there is no point producing any more: either the consumer walked
   * away, or the producer already declared itself finished.
   *
   * A command that emits in a loop is expected to check this. It is the cheap
   * path out of early termination; the AbortSignal is the one that works even
   * on a command that does not check.
   */
  get closed(): boolean {
    return this.#abandoned || this.#ended;
  }

  /** True specifically because the CONSUMER stopped, not because we finished. */
  get abandoned(): boolean {
    return this.#abandoned;
  }

  /**
   * Hand one value to the consumer, and do not come back until it is safe to
   * produce the next one.
   *
   * THE ACKNOWLEDGEMENT RULE, and why the obvious one is wrong.
   *
   * The obvious rule is "resolve once the value has been delivered". With it,
   * the probe above reports the producer running FOUR times, not three:
   *
   *   deliver 1 -> resolve -> producer computes 2 -> parks
   *   deliver 2 -> resolve -> producer computes 3 -> parks
   *   deliver 3 -> resolve -> producer computes 4 -> parks
   *   consumer has its three values and breaks         <- 4 already happened
   *
   * The producer always sits one value ahead, because it computes the next
   * value BEFORE discovering nobody wants it. pwsh does not do that: it reports
   * 1,2,3, because `Select-Object -First` unwinds the upstream the instant it
   * has enough, before the upstream is asked for anything more.
   *
   * So write N resolves when the consumer asks for value N+1 — the ask is the
   * acknowledgement, not the delivery:
   *
   *   write(N) delivers N and PARKS
   *   consumer takes N, does its work, asks again  -> write(N) resolves
   *   producer computes N+1
   *
   * Now a consumer that stops after three never asks a fourth time, the third
   * `write` is released by `abandon()` instead, and the producer's loop exits
   * without computing a fourth value. That reproduces 1,2,3 exactly.
   *
   * `slack` relaxes it by that many values for a caller that would rather
   * overlap work than match the reference implementation exactly.
   */
  async write(value: PSValue): Promise<void> {
    if (this.closed) return;
    const index = this.#writes++;
    this.#deliver(value);

    // Value at index i is delivered on the consumer's ask number i+1; this
    // write is acknowledged by ask number i+2.
    const acknowledgedAt = index + 2 - this.#slack;
    while (!this.closed && this.#demand < acknowledgedAt) {
      await new Promise<void>((resolve) => this.#acks.push(resolve));
    }
  }

  /** The producer is finished. Pending readers see the end of iteration. */
  close(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#flushWaiters();
  }

  /** The producer failed. The consumer's `for await` rethrows this. */
  fail(reason: unknown): void {
    if (this.#failure !== null || this.#ended) return;
    this.#failure = { reason };
    this.#ended = true;
    this.#flushWaiters();
  }

  /**
   * The consumer stopped caring. Releases any parked producer so it can notice
   * `closed` and unwind, and drops whatever was buffered — nobody will read it.
   */
  abandon(): void {
    if (this.#abandoned) return;
    this.#abandoned = true;
    this.#buffer.length = 0;
    this.#flushWaiters();
  }

  #deliver(value: PSValue): void {
    const reader = this.#readers.shift();
    if (reader !== undefined) reader.resolve({ value, done: false });
    else this.#buffer.push(value);
  }

  #flushWaiters(): void {
    while (this.#readers.length > 0) {
      const reader = this.#readers.shift();
      if (reader === undefined) break;
      if (this.#failure !== null) reader.reject(this.#failure.reason);
      else reader.resolve({ value: undefined, done: true });
    }
    this.#releaseAcks();
  }

  #releaseAcks(): void {
    // Every parked producer re-tests its own condition after waking, so waking
    // all of them is correct even though in practice there is exactly one.
    while (this.#acks.length > 0) {
      const ack = this.#acks.shift();
      if (ack !== undefined) ack();
    }
  }

  #next(): Promise<IteratorResult<PSValue>> {
    // Count the ask BEFORE anything else: it is what acknowledges the previous
    // write, and the producer must see it as soon as it wakes.
    this.#demand++;
    this.#releaseAcks();

    if (this.#buffer.length > 0) {
      const value = this.#buffer.shift() as PSValue;
      return Promise.resolve({ value, done: false });
    }
    if (this.#failure !== null) return Promise.reject(this.#failure.reason);
    if (this.#ended || this.#abandoned) return Promise.resolve({ value: undefined, done: true });

    // Registered synchronously, so a producer woken by the ack above finds a
    // reader waiting rather than buffering behind its back.
    return new Promise<IteratorResult<PSValue>>((resolve, reject) => {
      this.#readers.push({ resolve, reject });
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<PSValue> {
    return {
      next: () => this.#next(),
      return: (): Promise<IteratorResult<PSValue>> => {
        this.abandon();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

// ---------------------------------------------------------------------------
// stages
// ---------------------------------------------------------------------------

/**
 * Everything a stage needs that is not its input.
 *
 * This is `InvocationContext` minus `input` and `streams.success`, which the
 * pipeline supplies per stage — a command's success stream IS the next stage's
 * input, so it cannot be part of a shared host.
 */
export interface PipelineHost {
  readonly profile: CompatibilityView;
  /** Streams 2..6 plus progress. `success` is replaced per stage. */
  readonly streams: PowerShellStreams;
  readonly native: NativeStreams | null;
  readonly cwd: string;
  readonly env: ReadonlyMap<string, string>;
  /** Ctrl+C. Reaches every stage. */
  readonly signal: AbortSignal;
  requireCapability(capability: Capability): void;
  /**
   * The host's ports, handed to every stage.
   *
   * These were hard-coded to null here and in the kernel, and `PipelineHost` had
   * no field to carry them — so `InvocationContext` declared a filesystem that
   * nothing could ever supply, and no filesystem command could run in a
   * pipeline. Nullable because a headless run genuinely has none, which a
   * command must check rather than assume.
   */
  readonly fs?: FileSystemPort | null;
  /** The provider registry, when the host has one. See `InvocationContext`. */
  readonly providers?: ProviderRegistry | null;
  readonly preferences?: PreferencesPort | null;
  readonly dialog?: DialogPort | null;
}

export interface PipelineStage {
  /** Display name, used in cancellation messages. */
  readonly name: string;
  run(input: AsyncIterable<PSValue>, host: PipelineHost): AsyncIterable<PSValue>;
  /**
   * The STATUS of the most recent run: 0 for success, anything else for
   * failure. It lives on the stage rather than being returned by the pipeline
   * because a pipeline's status is its LAST stage's, and every stage's is
   * separately interesting to a caller that wants to know which one failed.
   *
   * NOT `$LASTEXITCODE`, which this docstring used to call it. Measured in
   * pwsh 7.6.5: `cmd /c "exit 7"` followed by a failing `Get-Item` leaves
   * `$LASTEXITCODE` at 7 and sets `$?` to False. A cmdlet's status shows in
   * `$?`; `$LASTEXITCODE` reports native programs and scripts, and the kernel
   * models the two separately.
   */
  readonly exitCode: number;
}

export interface CommandStageOptions {
  /** How far ahead of the consumer this command may run. Default 0. */
  readonly slack?: number;
}

/**
 * Wrap a `CommandModule` as a stage.
 *
 * The command's success sink becomes this stage's output, and the previous
 * stage's output becomes `context.input`. Nothing is buffered beyond `slack`.
 */
export function commandStage(
  module: CommandModule,
  bound: BindingResult,
  options: CommandStageOptions = {},
): PipelineStage {
  const slack = options.slack ?? 0;
  let exitCode = 0;
  return {
    name: module.manifest.display,
    get exitCode(): number {
      return exitCode;
    },
    run(input: AsyncIterable<PSValue>, host: PipelineHost): AsyncIterable<PSValue> {
      return runCommand(module, bound, input, host, slack, (code) => {
        exitCode = code;
      });
    },
  };
}

async function* runCommand(
  module: CommandModule,
  bound: BindingResult,
  input: AsyncIterable<PSValue>,
  host: PipelineHost,
  slack: number,
  setExitCode: (code: number) => void,
): AsyncGenerator<PSValue> {
  const name = module.manifest.display;
  const channel = new ObjectChannel(slack);

  // Two reasons a command must stop: the user cancelled (host.signal), or this
  // stage's consumer walked away (stageStop). A command sees one signal and
  // does not need to know which happened.
  const stageStop = new AbortController();
  const signal = AbortSignal.any([host.signal, stageStop.signal]);

  // Cancellation has to reach a command that is PARKED, not just one that is
  // looping — a parked `write` would otherwise never wake to check the signal.
  // Failing the channel does both: it wakes the producer and makes the consumer
  // rethrow, so the cancellation travels in both directions from here.
  const onCancel = (): void => channel.fail(new PipelineCancelledError(name));
  if (host.signal.aborted) onCancel();
  else host.signal.addEventListener('abort', onCancel, { once: true });

  // Hoisted rather than inlined: it is also what gets DRAINED below, and the
  // command's own iterator has to be the same object for that to be a no-op
  // when the command already consumed its input.
  const guarded = guardedInput(input, signal);

  const context: InvocationContext = {
    profile: host.profile,
    streams: { ...host.streams, success: channel },
    native: host.native,
    input: guarded,
    cwd: host.cwd,
    env: host.env,
    signal,
    requireCapability: (capability: Capability) => host.requireCapability(capability),
    fs: host.fs ?? null,
    providers: host.providers ?? null,
    preferences: host.preferences ?? null,
    dialog: host.dialog ?? null,
  };

  const running = module.invoke(context, bound).then(
    async (code) => {
      setExitCode(code);
      // POWERSHELL'S PIPELINE IS PUSH-BASED, and this is what reproduces that
      // in a pull-based engine. Measured in pwsh 7.6.5:
      //
      //   function Prod { 1..3 | ForEach-Object { $script:produced += $_; $_ } }
      //   function IgnoreInput { 'ignored' }      # no process block, no $input
      //   Prod | IgnoreInput
      //   $produced  ->  1,2,3
      //
      // The upstream runs to completion even though the downstream never reads
      // a single object. A pull-based chain would never have started it: an
      // async generator's body does not run until somebody asks. So the ask is
      // made here, once the command is done, and the objects are discarded —
      // which is what pwsh does with them too (the pipeline's output was just
      // 'ignored').
      //
      // It is a no-op in both of the normal cases. A command that consumed its
      // input leaves the generator completed; a command that stopped early has
      // already had `.return()` called on it by its own `break`, which tore the
      // upstream down — and that is what keeps the other measured behaviour:
      //
      //   1..10 | ForEach-Object { $seen += $_; $_ } | Select-Object -First 3
      //   $seen  ->  1,2,3      (not 1..10, and not 1,2,3,4)
      //
      // KNOWN DEVIATION, stated rather than hidden: pwsh interleaves the
      // upstream with the downstream, so an upstream warning arrives BEFORE a
      // downstream one (measured: `from-upstream | from-downstream | 1`). Here
      // an ignored upstream runs after its consumer has finished, so those two
      // events arrive in the other order. It costs nothing to say so, and only
      // a stage that reads none of its input is affected.
      try {
        for await (const _ignored of guarded) {
          // Discarded on purpose. See above.
        }
        channel.close();
      } catch (reason: unknown) {
        // A cancellation reaching us through the upstream, most likely.
        channel.fail(reason);
      }
    },
    (reason: unknown) => {
      // PowerShell reports a command that threw with a non-zero code; the
      // ErrorRecord itself travels on stream 2, which the command owns.
      setExitCode(1);
      channel.fail(reason);
    },
  );

  try {
    for await (const value of channel) yield value;
  } finally {
    // Order matters. `abandon` releases a producer parked in `write` so it can
    // see `closed` and return on its own; `abort` is the backstop for a command
    // that ignores `closed` but does check its signal. Awaiting `running` last
    // is what stops a torn-down stage leaking a command that keeps executing.
    channel.abandon();
    stageStop.abort();
    host.signal.removeEventListener('abort', onCancel);
    await running;
  }
}

/**
 * Wrap a command's input so a torn-down stage cannot leave the command running.
 *
 * Without this, early termination relies entirely on the command noticing
 * `sink.closed` — and a command that forgets to check would keep pulling from
 * upstream forever while the stage waits for it to finish. This makes the
 * teardown structural: once the stage is finished with, the very next pull ends
 * the command's `for await` loop and it returns on its own.
 *
 * The abort is checked BEFORE pulling, not after. Checking after would ask
 * upstream for one more object before noticing there was no point, which is
 * exactly the off-by-one that would turn the verified 1,2,3 into 1,2,3,4.
 */
async function* guardedInput(
  input: AsyncIterable<PSValue>,
  signal: AbortSignal,
): AsyncGenerator<PSValue> {
  const iterator = input[Symbol.asyncIterator]();
  try {
    for (;;) {
      if (signal.aborted) return;
      const next = await iterator.next();
      if (next.done === true) return;
      yield next.value;
    }
  } finally {
    // Closing our reader is what unwinds everything above us.
    await iterator.return?.(undefined);
  }
}

/**
 * Build a stage from an async transform — the shape the engine's own internal
 * stages (unrolling, redirection, `2>&1` merging) take, and the shape a test
 * uses when it wants a producer or consumer without a whole CommandModule.
 */
export function transformStage(
  name: string,
  transform: (input: AsyncIterable<PSValue>, host: PipelineHost) => AsyncIterable<PSValue>,
): PipelineStage {
  return {
    name,
    exitCode: 0,
    run: transform,
  };
}

// ---------------------------------------------------------------------------
// sources and running
// ---------------------------------------------------------------------------

/**
 * Turn a single value into a pipeline source, unrolling it ONE level.
 *
 * Enumeration belongs here and NOT at every stage boundary. `@(1,@(2,3))`
 * unrolls once as it enters the pipeline, so the second item arrives at the
 * first command as an intact `Object[]`; a stage that re-enumerated would
 * flatten it and make `@(1,@(2,3)) | Measure-Object` report 3 where pwsh 7.6.5
 * reports 2. A command that wants to emit each element of an array — which is
 * what `Select-Object -ExpandProperty` does — calls `enumerate` itself.
 */
export async function* fromValue(value: PSValue): AsyncGenerator<PSValue> {
  for (const item of enumerate(value)) yield item;
}

/** Items that are ALREADY separate pipeline objects. Not re-enumerated. */
export async function* fromValues(values: Iterable<PSValue>): AsyncGenerator<PSValue> {
  for (const value of values) yield value;
}

/** The empty pipeline — what a command first in a pipeline receives. */
export async function* noInput(): AsyncGenerator<PSValue> {
  // Deliberately empty: `yield` is unreachable, which is the point.
}

/**
 * Where a stage's host comes from.
 *
 * A function rather than one shared host, because a stage is a PROCESS as soon
 * as there is a kernel: it has its own pid, its own six streams, its own stdin
 * and its own AbortSignal, and an error written by the third stage has to be
 * attributable to the third stage. One shared host cannot express that, which
 * is why the kernel grew a second engine instead of using this one.
 *
 * Called once per stage, at composition time.
 */
export type StageHost = (stage: PipelineStage, index: number) => PipelineHost;

/**
 * Compose the stages and run them, giving each its own host.
 *
 * The returned generator is lazy: nothing executes until it is iterated, and
 * abandoning it tears the whole chain down through each stage's `finally`.
 */
export async function* runPipelineStages(
  source: AsyncIterable<PSValue>,
  stages: readonly PipelineStage[],
  hostFor: StageHost,
): AsyncGenerator<PSValue> {
  let current: AsyncIterable<PSValue> = source;
  let last: PipelineHost | null = null;
  for (const [index, stage] of stages.entries()) {
    const host = hostFor(stage, index);
    last = host;
    current = stage.run(current, host);
  }

  const lastName = stages.at(-1)?.name ?? 'the pipeline';
  for await (const value of current) {
    // Checked per value as well as inside each command, so a pipeline of
    // stages that all happen to be cooperative still stops promptly. The LAST
    // stage's signal is the one to check: it is the stage this loop is reading
    // from, and an earlier stage that was stopped has already ended its output.
    if (last !== null) throwIfCancelled(last.signal, lastName);
    yield value;
  }
}

/**
 * Every stage sharing one host. The shape a test and a headless run want.
 *
 * With NO stages this is `source` forwarded verbatim and no cancellation check
 * happens, because there is no stage to cancel: the source belongs to the
 * caller and so does guarding it.
 */
export function runPipeline(
  source: AsyncIterable<PSValue>,
  stages: readonly PipelineStage[],
  host: PipelineHost,
): AsyncGenerator<PSValue> {
  return runPipelineStages(source, stages, () => host);
}

/** Drain a pipeline into an array. The shape a test and `$(...)` both want. */
export async function collectPipeline(
  source: AsyncIterable<PSValue>,
  stages: readonly PipelineStage[],
  host: PipelineHost,
): Promise<PSValue[]> {
  const values: PSValue[] = [];
  for await (const value of runPipeline(source, stages, host)) values.push(value);
  return values;
}

/** Drain any async iterable. Small, but written once rather than five times. */
export async function toArray(input: AsyncIterable<PSValue>): Promise<PSValue[]> {
  const values: PSValue[] = [];
  for await (const value of input) values.push(value);
  return values;
}
