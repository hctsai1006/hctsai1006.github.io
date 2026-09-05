/**
 * Tests for the object pipeline.
 *
 * The three properties under test — backpressure, cancellation, early
 * termination — are the ones that cannot be checked by reading the code, and
 * they are the ones that silently do not hold in a naive implementation:
 * everything still produces the right VALUES while buffering without limit,
 * running upstream to completion, and ignoring Ctrl+C.
 *
 * The early-termination expectations are pwsh 7.6.5's, read off a side effect:
 *
 *   1..10 | ForEach-Object { $seen += $_; $_ } | Select-Object -First 3
 *   $seen  ->  1,2,3
 *
 * Not 1..10 (no early stop) and not 1,2,3,4 (an off-by-one in the handshake).
 * The `-First 0` case is the same probe and gives 1..10, which is why it has
 * its own test rather than being folded into the first.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ObjectChannel,
  PipelineCancelledError,
  collectPipeline,
  commandStage,
  fromValue,
  fromValues,
  noInput,
  runPipeline,
  throwIfCancelled,
  toArray,
  transformStage,
} from '../../src/pipeline/pipeline.ts';
import type { PipelineHost } from '../../src/pipeline/pipeline.ts';
import type { PSValue } from '../../src/pipeline/psobject.ts';
import { collectingStreams } from '../../src/pipeline/streams.ts';
import type {
  BindingResult,
  CommandModule,
  InvocationContext,
} from '../../src/commands/invocation.ts';
import type { CommandManifest } from '../../src/commands/manifest.ts';
import { viewOfBehaviors } from '../../src/compatibility/profile-resolver.ts';

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

function testManifest(display: string): CommandManifest {
  return {
    name: display.toLowerCase(),
    display,
    aliases: [],
    runtime: 'semantic',
    fidelity: 'native-semantic',
    risk: 'read',
    capabilities: [],
    parameters: [],
    outputTypeNames: [],
    synopsis: 'test double',
    parameterSource: 'none',
    implementationStatus: 'implemented',
  };
}

type Host = PipelineHost & { readonly collected: ReturnType<typeof collectingStreams>['collected'] };

function testHost(signal?: AbortSignal): Host {
  const streams = collectingStreams();
  return {
    profile: viewOfBehaviors('7.6.5', {}),
    streams,
    collected: streams.collected,
    native: null,
    cwd: '/',
    env: new Map<string, string>(),
    signal: signal ?? new AbortController().signal,
    requireCapability: (): void => {},
  };
}

const NO_ARGS: BindingResult = { parameters: {}, parameterSet: 'Default', remaining: [] };

/** A command in the shape a well-behaved one takes: read input, write output. */
function passthrough(display: string, onEach: (value: PSValue) => void): CommandModule {
  return {
    manifest: testManifest(display),
    async invoke(context: InvocationContext): Promise<number> {
      for await (const item of context.input) {
        onEach(item);
        await context.streams.success.write(item);
        if (context.streams.success.closed) break;
      }
      return 0;
    },
  };
}

/** Takes the first `count` objects and stops, the way Select-Object -First does. */
function takeFirst(count: number): CommandModule {
  return {
    manifest: testManifest('Take-First'),
    async invoke(context: InvocationContext): Promise<number> {
      let taken = 0;
      if (count === 0) {
        // Deliberately drains without stopping, matching `Select-Object -First 0`.
        for await (const _item of context.input) void _item;
        return 0;
      }
      for await (const item of context.input) {
        await context.streams.success.write(item);
        taken += 1;
        if (taken >= count) break;
      }
      return 0;
    },
  };
}

// ---------------------------------------------------------------------------
// composition
// ---------------------------------------------------------------------------

describe('composing stages', () => {
  it('threads objects through every stage in order', async () => {
    const host = testHost();
    const trace: string[] = [];
    const stages = [
      commandStage(passthrough('One', (v) => trace.push(`one:${String(v)}`)), NO_ARGS),
      commandStage(passthrough('Two', (v) => trace.push(`two:${String(v)}`)), NO_ARGS),
    ];
    const out = await collectPipeline(fromValues([1, 2]), stages, host);
    assert.deepEqual(out, [1, 2]);
    assert.deepEqual(trace, ['one:1', 'two:1', 'one:2', 'two:2']);
  });

  it('runs a pipeline with no stages at all', async () => {
    const host = testHost();
    assert.deepEqual(await collectPipeline(fromValues(['a']), [], host), ['a']);
  });

  it('gives a command with no upstream an empty input', async () => {
    const host = testHost();
    let iterations = 0;
    const source: CommandModule = {
      manifest: testManifest('Source'),
      async invoke(context: InvocationContext): Promise<number> {
        for await (const _item of context.input) {
          void _item;
          iterations += 1;
        }
        await context.streams.success.write('made up');
        return 0;
      },
    };
    const out = await collectPipeline(noInput(), [commandStage(source, NO_ARGS)], host);
    assert.equal(iterations, 0);
    assert.deepEqual(out, ['made up']);
  });

  it('reports the last stage status, which is what the pipeline is judged on', async () => {
    // NOT $LASTEXITCODE. Measured in pwsh 7.6.5: a cmdlet never touches that
    // variable — `cmd /c "exit 7"` then a failing Get-Item leaves it at 7 —
    // so a stage's status and $LASTEXITCODE are two different numbers.
    const host = testHost();
    const failing: CommandModule = {
      manifest: testManifest('Fails'),
      invoke: (): Promise<number> => Promise.resolve(42),
    };
    const stage = commandStage(failing, NO_ARGS);
    await collectPipeline(noInput(), [stage], host);
    assert.equal(stage.exitCode, 42);
  });

  it('propagates a thrown command as a rejection, with exit code 1', async () => {
    const host = testHost();
    const throwing: CommandModule = {
      manifest: testManifest('Throws'),
      invoke: (): Promise<number> => Promise.reject(new Error('boom')),
    };
    const stage = commandStage(throwing, NO_ARGS);
    await assert.rejects(collectPipeline(noInput(), [stage], host), /boom/u);
    assert.equal(stage.exitCode, 1);
  });
});

// ---------------------------------------------------------------------------
// enumeration at the source
// ---------------------------------------------------------------------------

describe('pipeline sources', () => {
  it('unrolls a value ONE level, matching pwsh', async () => {
    // pwsh: (@(1,@(2,3)) | Measure-Object).Count -> 2
    const out = await toArray(fromValue([1, [2, 3]] as PSValue));
    assert.equal(out.length, 2);
    assert.deepEqual(out[1], [2, 3], 'the inner array must arrive intact');
  });

  it('does not re-enumerate items that are already separate objects', async () => {
    // A stage emitting an array as one object must not have it flattened by the
    // next stage; enumeration happens once, at the source.
    const out = await toArray(fromValues([1, [2, 3]] as PSValue[]));
    assert.equal(out.length, 2);
    assert.deepEqual(out[1], [2, 3]);
  });

  it('passes null through as a value', async () => {
    assert.deepEqual(await toArray(fromValue([null, 1] as PSValue)), [null, 1]);
  });
});

// ---------------------------------------------------------------------------
// backpressure
// ---------------------------------------------------------------------------

describe('backpressure', () => {
  it('throttles a fast producer to a slow consumer', async () => {
    const host = testHost();
    let produced = 0;
    const flood: CommandModule = {
      manifest: testManifest('Flood'),
      async invoke(context: InvocationContext): Promise<number> {
        while (produced < 500 && !context.streams.success.closed) {
          produced += 1;
          await context.streams.success.write(produced);
        }
        return 0;
      },
    };

    let consumed = 0;
    const highWater: number[] = [];
    for await (const _value of runPipeline(noInput(), [commandStage(flood, NO_ARGS)], host)) {
      void _value;
      consumed += 1;
      // Yield to the event loop so an unthrottled producer would have every
      // opportunity to run away. It must not be able to.
      await new Promise((resolve) => setTimeout(resolve, 0));
      highWater.push(produced - consumed);
      if (consumed === 20) break;
    }

    assert.equal(consumed, 20);
    const worst = Math.max(...highWater);
    assert.ok(worst <= 1, `producer ran ${String(worst)} objects ahead; expected at most 1`);
    assert.ok(produced <= 21, `producer emitted ${String(produced)} for 20 consumed`);
  });

  it('honours a slack setting when the caller asks to overlap work', async () => {
    const host = testHost();
    let produced = 0;
    const flood: CommandModule = {
      manifest: testManifest('Flood'),
      async invoke(context: InvocationContext): Promise<number> {
        while (produced < 200 && !context.streams.success.closed) {
          produced += 1;
          await context.streams.success.write(produced);
        }
        return 0;
      },
    };

    let consumed = 0;
    let worst = 0;
    const stage = commandStage(flood, NO_ARGS, { slack: 4 });
    for await (const _value of runPipeline(noInput(), [stage], host)) {
      void _value;
      consumed += 1;
      await new Promise((resolve) => setTimeout(resolve, 0));
      worst = Math.max(worst, produced - consumed);
      if (consumed === 20) break;
    }
    assert.ok(worst > 1, 'slack should let the producer run ahead');
    assert.ok(worst <= 5, `bounded by slack + 1; saw ${String(worst)}`);
  });

  it('keeps a multi-stage pipeline bounded end to end', async () => {
    const host = testHost();
    let produced = 0;
    const flood: CommandModule = {
      manifest: testManifest('Flood'),
      async invoke(context: InvocationContext): Promise<number> {
        while (produced < 1000 && !context.streams.success.closed) {
          produced += 1;
          await context.streams.success.write(produced);
        }
        return 0;
      },
    };
    const stages = [
      commandStage(flood, NO_ARGS),
      commandStage(passthrough('Middle', () => {}), NO_ARGS),
      commandStage(passthrough('Last', () => {}), NO_ARGS),
    ];

    let consumed = 0;
    for await (const _value of runPipeline(noInput(), stages, host)) {
      void _value;
      consumed += 1;
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (consumed === 10) break;
    }
    // Each stage may hold at most one in flight, so the source cannot get more
    // than a small constant ahead however many stages there are.
    assert.ok(produced <= consumed + 3, `source produced ${String(produced)} for 10 consumed`);
  });
});

// ---------------------------------------------------------------------------
// early termination
// ---------------------------------------------------------------------------

describe('early termination', () => {
  it('stops the upstream, reproducing the pwsh side-effect probe', async () => {
    // pwsh 7.6.5:
    //   1..10 | ForEach-Object { $seen += $_; $_ } | Select-Object -First 3
    //   $seen -> 1,2,3
    const host = testHost();
    const seen: PSValue[] = [];
    const stages = [
      commandStage(passthrough('ForEach-Object', (v) => seen.push(v)), NO_ARGS),
      commandStage(takeFirst(3), NO_ARGS),
    ];
    const out = await collectPipeline(fromValues([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), stages, host);
    assert.deepEqual(out, [1, 2, 3]);
    assert.deepEqual(seen, [1, 2, 3], 'the producer must run exactly three times');
  });

  it('tears down every upstream stage, not just the one next to it', async () => {
    const host = testHost();
    const first: PSValue[] = [];
    const second: PSValue[] = [];
    const stages = [
      commandStage(passthrough('First', (v) => first.push(v)), NO_ARGS),
      commandStage(passthrough('Second', (v) => second.push(v)), NO_ARGS),
      commandStage(takeFirst(2), NO_ARGS),
    ];
    const out = await collectPipeline(fromValues([1, 2, 3, 4, 5, 6]), stages, host);
    assert.deepEqual(out, [1, 2]);
    assert.deepEqual(second, [1, 2]);
    assert.deepEqual(first, [1, 2], 'the stage two hops upstream must stop too');
  });

  it('closes the source iterator so its finally block runs', async () => {
    const host = testHost();
    let sourceClosed = false;
    async function* source(): AsyncGenerator<PSValue> {
      try {
        for (let i = 1; i <= 100; i += 1) yield i;
      } finally {
        sourceClosed = true;
      }
    }
    await collectPipeline(source(), [commandStage(takeFirst(2), NO_ARGS)], host);
    assert.equal(sourceClosed, true);
  });

  it('does NOT stop the upstream for a zero-length take', async () => {
    // pwsh: `Select-Object -First 0` runs the producer to completion, because
    // the stop is signalled when an object is passed through and none ever is.
    const host = testHost();
    const seen: PSValue[] = [];
    const stages = [
      commandStage(passthrough('ForEach-Object', (v) => seen.push(v)), NO_ARGS),
      commandStage(takeFirst(0), NO_ARGS),
    ];
    const out = await collectPipeline(fromValues([1, 2, 3, 4, 5]), stages, host);
    assert.deepEqual(out, []);
    assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  });

  it('stops a command that ignores `closed`, because the input guard ends it', async () => {
    // The teardown must not depend on every command remembering to check.
    const host = testHost();
    let pulls = 0;
    const careless: CommandModule = {
      manifest: testManifest('Careless'),
      async invoke(context: InvocationContext): Promise<number> {
        for await (const item of context.input) {
          pulls += 1;
          await context.streams.success.write(item);
          // No `closed` check at all.
        }
        return 0;
      },
    };
    const stages = [commandStage(careless, NO_ARGS), commandStage(takeFirst(2), NO_ARGS)];
    const out = await collectPipeline(fromValues([1, 2, 3, 4, 5, 6, 7, 8]), stages, host);
    assert.deepEqual(out, [1, 2]);
    assert.ok(pulls <= 3, `a careless command should not drain the source; pulled ${String(pulls)}`);
  });

  it('unwinds when the consumer of the whole pipeline breaks', async () => {
    const host = testHost();
    const seen: PSValue[] = [];
    const stages = [commandStage(passthrough('Watch', (v) => seen.push(v)), NO_ARGS)];
    for await (const value of runPipeline(fromValues([1, 2, 3, 4, 5]), stages, host)) {
      if (value === 2) break;
    }
    assert.deepEqual(seen, [1, 2]);
  });

  it('works with plain generator stages too', async () => {
    const host = testHost();
    const seen: PSValue[] = [];
    const producer = transformStage('Producer', async function* (input) {
      for await (const value of input) {
        seen.push(value);
        yield value;
      }
    });
    const limiter = transformStage('Limiter', async function* (input) {
      let count = 0;
      for await (const value of input) {
        yield value;
        count += 1;
        if (count === 3) return;
      }
    });
    const out = await collectPipeline(fromValues([1, 2, 3, 4, 5, 6]), [producer, limiter], host);
    assert.deepEqual(out, [1, 2, 3]);
    assert.deepEqual(seen, [1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// cancellation
// ---------------------------------------------------------------------------

describe('cancellation', () => {
  it('reaches a command that is looping', async () => {
    const controller = new AbortController();
    const host = testHost(controller.signal);
    let iterations = 0;
    const forever: CommandModule = {
      manifest: testManifest('Forever'),
      async invoke(context: InvocationContext): Promise<number> {
        for (;;) {
          throwIfCancelled(context.signal, 'Forever');
          iterations += 1;
          await context.streams.success.write(iterations);
        }
      },
    };

    const stage = commandStage(forever, NO_ARGS);
    const iterator = runPipeline(noInput(), [stage], host);
    await iterator.next();
    controller.abort();
    await assert.rejects(iterator.next(), PipelineCancelledError);
  });

  it('wakes a command PARKED in write, which no signal check alone would do', async () => {
    const controller = new AbortController();
    const host = testHost(controller.signal);
    let returnedNormally = false;
    const parked: CommandModule = {
      manifest: testManifest('Parked'),
      async invoke(context: InvocationContext): Promise<number> {
        // Parks immediately: nobody is going to ask for a second value.
        await context.streams.success.write('one');
        await context.streams.success.write('two');
        returnedNormally = true;
        return 0;
      },
    };
    const iterator = runPipeline(noInput(), [commandStage(parked, NO_ARGS)], host);
    assert.deepEqual((await iterator.next()).value, 'one');
    controller.abort();
    await assert.rejects(iterator.next(), PipelineCancelledError);
    assert.equal(returnedNormally, true, 'the parked write must have been released');
  });

  it('reaches every stage of a multi-stage pipeline', async () => {
    const controller = new AbortController();
    const host = testHost(controller.signal);
    const observed: boolean[] = [];
    const watcher = (name: string): CommandModule => ({
      manifest: testManifest(name),
      async invoke(context: InvocationContext): Promise<number> {
        try {
          for await (const item of context.input) {
            await context.streams.success.write(item);
            if (context.streams.success.closed) break;
          }
        } finally {
          observed.push(context.signal.aborted);
        }
        return 0;
      },
    });
    const stages = [
      commandStage(watcher('A'), NO_ARGS),
      commandStage(watcher('B'), NO_ARGS),
      commandStage(watcher('C'), NO_ARGS),
    ];
    const iterator = runPipeline(fromValues([1, 2, 3, 4, 5]), stages, host);
    await iterator.next();
    controller.abort();
    await assert.rejects(iterator.next(), PipelineCancelledError);
    assert.equal(observed.length, 3, 'all three commands must have unwound');
    assert.ok(
      observed.every((aborted) => aborted),
      'every stage must see an aborted signal',
    );
  });

  it('refuses to start when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const host = testHost(controller.signal);
    await assert.rejects(
      collectPipeline(fromValues([1]), [commandStage(passthrough('X', () => {}), NO_ARGS)], host),
      PipelineCancelledError,
    );
  });

  it('leaves an uncancelled pipeline alone', async () => {
    const host = testHost();
    const out = await collectPipeline(
      fromValues([1, 2, 3]),
      [commandStage(passthrough('X', () => {}), NO_ARGS)],
      host,
    );
    assert.deepEqual(out, [1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// the channel itself
// ---------------------------------------------------------------------------

describe('ObjectChannel', () => {
  it('acknowledges a write only when the consumer asks for the NEXT value', async () => {
    // This is the rule that makes the 1,2,3 probe reproduce. If a write
    // resolved on delivery, the producer would always sit one value ahead.
    const channel = new ObjectChannel();
    const iterator = channel[Symbol.asyncIterator]();

    let acknowledged = false;
    const write = channel.write('a').then(() => {
      acknowledged = true;
    });

    const first = await iterator.next();
    assert.equal(first.value, 'a');
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(acknowledged, false, 'delivery alone must not acknowledge');

    const second = iterator.next();
    await write;
    assert.equal(acknowledged, true, 'the next ask is the acknowledgement');

    channel.close();
    assert.equal((await second).done, true);
  });

  it('releases a parked producer when the consumer abandons it', async () => {
    const channel = new ObjectChannel();
    const iterator = channel[Symbol.asyncIterator]();
    const write = channel.write('a');
    await iterator.next();
    assert.equal(channel.closed, false);
    await iterator.return?.(undefined);
    await write;
    assert.equal(channel.closed, true);
    assert.equal(channel.abandoned, true);
  });

  it('drops further writes once abandoned, without blocking', async () => {
    const channel = new ObjectChannel();
    channel.abandon();
    await channel.write('ignored');
    await channel.write('also ignored');
    assert.equal(channel.closed, true);
  });

  it('ends iteration when the producer closes', async () => {
    const channel = new ObjectChannel(4);
    await channel.write(1);
    await channel.write(2);
    channel.close();
    assert.deepEqual(await toArray(channel), [1, 2]);
  });

  it('surfaces a producer failure to the consumer', async () => {
    const channel = new ObjectChannel();
    channel.fail(new Error('producer exploded'));
    await assert.rejects(toArray(channel), /producer exploded/u);
  });

  it('never buffers more than slack + 1 objects', async () => {
    const channel = new ObjectChannel();
    const writes = [1, 2, 3, 4, 5].map((value) => channel.write(value));
    // Nothing has been read, so only the first write can have been accepted.
    const settled = await Promise.race([
      Promise.all(writes).then(() => 'all'),
      new Promise((resolve) => setTimeout(() => resolve('parked'), 10)),
    ]);
    assert.equal(settled, 'parked', 'unread writes must park rather than buffer');
    channel.abandon();
    await Promise.all(writes);
  });
});
