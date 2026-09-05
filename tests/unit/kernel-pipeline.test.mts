/**
 * The kernel runs the pipeline the pipeline tests test.
 *
 * It used to run a second engine. `kernel.ts` joined its stages with a private
 * `ObjectQueue` whose own comment admitted "buffering here is unbounded, which
 * is the honest limit of this milestone", so every backpressure, early-stop and
 * cancellation test in pipeline.test.mts covered a path the kernel never took —
 * and a fast producer feeding a slow consumer grew without limit on the path it
 * did take. It also never called the binder: `invocation.ts` says the binder,
 * the commands and the kernel are defined together so that they are guaranteed
 * to join up, and the kernel handed every command `{ parameters: {} }` with the
 * raw tokens in `remaining`.
 *
 * These are the properties the two engines disagreed about, asserted THROUGH
 * THE KERNEL. Each one fails against the ObjectQueue.
 *
 * The pipeline semantics asserted here were measured in pwsh 7.6.5 and the
 * probes are quoted at the assertions that depend on them.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { CommandModule, InvocationContext, BindingResult } from '../../src/commands/invocation.ts';
import type { CommandManifest, ParameterMetadata } from '../../src/commands/manifest.ts';
import type { PSValue } from '../../src/pipeline/psobject.ts';
import { Kernel } from '../../src/kernel/kernel.ts';
import type { KernelEvent } from '../../src/kernel/protocol.ts';
import { SIGNAL_EXIT_CODE } from '../../src/kernel/signals.ts';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function parameterMetadata(
  name: string,
  extra: { position?: number | null; isSwitch?: boolean } = {},
): ParameterMetadata {
  const position = extra.position ?? null;
  return {
    name,
    aliases: [],
    type: extra.isSwitch === true ? 'System.Management.Automation.SwitchParameter' : 'System.String',
    isSwitch: extra.isSwitch ?? false,
    sets: { __AllParameterSets: { position, mandatory: false, valueFromPipeline: false } },
    mandatoryInAnySet: false,
    mandatoryInEverySet: false,
    firstPosition: position,
    valueFromPipelineInAnySet: false,
    validation: [],
    verified: false,
  };
}

function manifest(name: string, parameters: readonly ParameterMetadata[] = []): CommandManifest {
  return {
    name,
    display: name,
    aliases: [],
    runtime: 'semantic',
    fidelity: 'native-semantic',
    risk: 'read',
    capabilities: [],
    parameters,
    outputTypeNames: [],
    synopsis: 'A command that exists only in these tests.',
    parameterSource: 'none',
    implementationStatus: 'implemented',
  };
}

function command(
  name: string,
  invoke: (context: InvocationContext, bound: BindingResult) => Promise<number>,
  parameters: readonly ParameterMetadata[] = [],
): CommandModule {
  return { manifest: manifest(name, parameters), invoke };
}

function newKernel(options: ConstructorParameters<typeof Kernel>[0] = {}): {
  kernel: Kernel;
  events: KernelEvent[];
} {
  const kernel = new Kernel({ clock: () => 1_700_000_000_000, ...options });
  const events: KernelEvent[] = [];
  kernel.on((event) => events.push(event));
  return { kernel, events };
}

function objects(events: readonly KernelEvent[]): readonly PSValue[] {
  return events.flatMap((event) => (event.kind === 'objects' ? [...event.values] : []));
}

function errors(events: readonly KernelEvent[]): readonly string[] {
  return events.flatMap((event) =>
    event.kind === 'stream' && event.which === 'error' ? [event.payload.fullyQualifiedErrorId] : [],
  );
}

/** Yield to the microtask queue enough times for a burst of writes to land. */
async function settle(times = 20): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// backpressure
// ---------------------------------------------------------------------------

describe('backpressure through the kernel', () => {
  it('a fast producer cannot outrun a slow consumer', async () => {
    // With the ObjectQueue this producer ran to completion before the consumer
    // read its first object, because `push` never blocks. `1..10000000 |
    // Where-Object {...} | Format-Table` buffering the middle of that pipeline
    // is a dead tab, and there is no OS here to page us out.
    const produced: number[] = [];
    const consumed: number[] = [];
    let maxLead = 0;

    const { kernel, events } = newKernel();
    kernel.register(
      command('flood', async (context) => {
        for (let index = 0; index < 50; index += 1) {
          if (context.streams.success.closed) break;
          produced.push(index);
          maxLead = Math.max(maxLead, produced.length - consumed.length);
          await context.streams.success.write(index);
        }
        return 0;
      }),
    );
    kernel.register(
      command('trickle', async (context) => {
        for await (const value of context.input) {
          consumed.push(value as number);
          // A yield per object, so a producer that could run ahead would.
          await settle(5);
          await context.streams.success.write(value);
        }
        return 0;
      }),
    );

    kernel.send({
      kind: 'exec',
      requestId: 'r1',
      terminalId: 't1',
      source: 'flood | trickle',
      background: false,
    });
    await kernel.drain();

    assert.equal(consumed.length, 50);
    assert.deepEqual(objects(events).length, 50);
    // Two: the value in flight plus the one the consumer is working on. The
    // ObjectQueue's answer was 50.
    assert.ok(maxLead <= 2, `the producer ran ${maxLead} objects ahead of the consumer`);
  });

  it('the producer PARKS after the consumer stops asking, and wakes when it resumes', async () => {
    let written = 0;
    let released = (): void => {};
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });

    const { kernel } = newKernel();
    kernel.register(
      command('emit', async (context) => {
        for (let index = 0; index < 10; index += 1) {
          written += 1;
          await context.streams.success.write(index);
        }
        return 0;
      }),
    );
    kernel.register(
      command('pause-after-two', async (context) => {
        let taken = 0;
        for await (const value of context.input) {
          taken += 1;
          if (taken === 2) await gate;
          await context.streams.success.write(value);
        }
        return 0;
      }),
    );

    kernel.send({
      kind: 'exec',
      requestId: 'r1',
      terminalId: 't1',
      source: 'emit | pause-after-two',
      background: false,
    });
    try {
      await settle(200);
      // Exactly two: object 0 was taken, and object 1 was handed over and is
      // waiting to be acknowledged by an ask that never comes. Nothing beyond
      // that has been COMPUTED, which is what backpressure means. The
      // ObjectQueue's answer here was all ten, because `push` never blocks.
      assert.equal(written, 2, `${written} objects were produced while the consumer was away`);
    } finally {
      released();
    }

    await kernel.drain();
    assert.equal(written, 10);
  });
});

// ---------------------------------------------------------------------------
// early termination
// ---------------------------------------------------------------------------

describe('early termination through the kernel', () => {
  it('a consumer that stops after three lets the producer run exactly three times', async () => {
    // Measured in pwsh 7.6.5:
    //   1..10 | ForEach-Object { $seen += $_; $_ } | Select-Object -First 3
    //   $seen  ->  1,2,3      (not 1..10, and not 1,2,3,4)
    const seen: number[] = [];
    const { kernel, events } = newKernel();
    kernel.register(
      command('range', async (context) => {
        for (let index = 1; index <= 10; index += 1) {
          if (context.streams.success.closed) break;
          seen.push(index);
          await context.streams.success.write(index);
        }
        return 0;
      }),
    );
    kernel.register(
      command('first3', async (context) => {
        let taken = 0;
        for await (const value of context.input) {
          await context.streams.success.write(value);
          taken += 1;
          if (taken === 3) break;
        }
        return 0;
      }),
    );

    kernel.send({
      kind: 'exec',
      requestId: 'r1',
      terminalId: 't1',
      source: 'range | first3',
      background: false,
    });
    await kernel.drain();

    assert.deepEqual(objects(events), [1, 2, 3]);
    assert.deepEqual(seen, [1, 2, 3], 'the upstream really is torn down, not just ignored');
  });

  it('an upstream still runs to completion when the downstream ignores its input', async () => {
    // The other half of the same measurement, and the half a pull-based engine
    // gets wrong on its own. pwsh 7.6.5:
    //   function Prod { 1..3 | ForEach-Object { $script:produced += $_; $_ } }
    //   function IgnoreInput { 'ignored' }     # no process block, no $input
    //   Prod | IgnoreInput   ->  'ignored'
    //   $produced            ->  1,2,3
    const produced: number[] = [];
    const { kernel, events } = newKernel();
    kernel.register(
      command('prod', async (context) => {
        for (let index = 1; index <= 3; index += 1) {
          produced.push(index);
          await context.streams.success.write(index);
        }
        return 0;
      }),
    );
    kernel.register(
      command('ignores', async (context) => {
        await context.streams.success.write('ignored');
        return 0;
      }),
    );

    kernel.send({
      kind: 'exec',
      requestId: 'r1',
      terminalId: 't1',
      source: 'prod | ignores',
      background: false,
    });
    await kernel.drain();

    assert.deepEqual(objects(events), ['ignored']);
    assert.deepEqual(produced, [1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// cancellation
// ---------------------------------------------------------------------------

describe('cancellation through the kernel reaches a parked producer', () => {
  it('Ctrl+C wakes a producer waiting on a consumer that never asks again', async () => {
    // The failure this prevents: with backpressure but no cancellation path, a
    // parked `write` never wakes to check the signal and the pipeline hangs
    // instead of stopping. Blocking is correct; deadlocking is not.
    let unwound = false;
    let attempts = 0;
    const { kernel, events } = newKernel();
    kernel.register(
      command('endless', async (context) => {
        try {
          for (let index = 0; ; index += 1) {
            // The check `Sink.closed` exists for: once the channel is failed by
            // the cancellation, a parked `write` returns immediately and a loop
            // without this would spin forever rather than unwind.
            if (context.streams.success.closed || context.signal.aborted) break;
            attempts += 1;
            await context.streams.success.write(index);
          }
        } finally {
          unwound = true;
        }
        return 0;
      }),
    );
    kernel.register(
      command('never', async (context) => {
        // Reads one object and then waits forever on the signal.
        const iterator = context.input[Symbol.asyncIterator]();
        await iterator.next();
        await new Promise<void>((resolve) => {
          context.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return 0;
      }),
    );

    kernel.send({
      kind: 'exec',
      requestId: 'r1',
      terminalId: 't1',
      source: 'endless | never',
      background: false,
    });
    await settle(50);
    assert.deepEqual(kernel.interrupt('t1'), [1, 2]);
    await kernel.drain();

    assert.equal(unwound, true, 'the parked producer woke up and unwound');
    // Blocked, not spinning: the consumer asked once, so exactly one more
    // object was computed before the producer parked. Unbounded buffering would
    // have let it run until the interrupt arrived.
    assert.ok(attempts <= 3, `the producer computed ${attempts} objects before it parked`);
    const exits = new Map(events.filter((e) => e.kind === 'exit').map((e) => [e.processId, e]));
    assert.equal(exits.get(1)?.signalled, 'SIGINT');
    assert.equal(exits.get(2)?.signalled, 'SIGINT');
    assert.equal(exits.get(2)?.exitCode, SIGNAL_EXIT_CODE.SIGINT);
  });
});

// ---------------------------------------------------------------------------
// the binder
// ---------------------------------------------------------------------------

describe('the kernel binds parameters instead of inventing an empty BindingResult', () => {
  it('a declared parameter arrives bound, by name and by position', async () => {
    const seen: BindingResult[] = [];
    const { kernel } = newKernel();
    kernel.register(
      command(
        'probe',
        async (_context, bound) => {
          seen.push(bound);
          return 0;
        },
        [parameterMetadata('Path', { position: 0 }), parameterMetadata('Force', { isSwitch: true })],
      ),
    );

    kernel.send({
      kind: 'exec',
      requestId: 'r1',
      terminalId: 't1',
      source: 'probe -Path /tmp -Force',
      background: false,
    });
    await kernel.drain();
    kernel.send({
      kind: 'exec',
      requestId: 'r2',
      terminalId: 't1',
      source: 'probe /var',
      background: false,
    });
    await kernel.drain();

    assert.deepEqual(seen[0]?.parameters, { Path: '/tmp', Force: true });
    assert.deepEqual(seen[0]?.remaining, [], 'nothing is left over when everything bound');
    assert.deepEqual(seen[1]?.parameters, { Path: '/var' });
  });

  it('a manifest with no parameters still gets its raw tokens, which unix commands need', async () => {
    // `ls -la` and `git status` declare none by design. The binder's own rule,
    // relied on here rather than re-implemented in the kernel.
    const seen: BindingResult[] = [];
    const { kernel } = newKernel();
    kernel.register(
      command('ls', async (_context, bound) => {
        seen.push(bound);
        return 0;
      }),
    );

    kernel.send({
      kind: 'exec',
      requestId: 'r1',
      terminalId: 't1',
      source: 'ls -la /home',
      background: false,
    });
    await kernel.drain();

    assert.deepEqual(seen[0]?.remaining, ['-la', '/home']);
  });

  it('reports a binding failure with the binder\'s own message and never runs the command', async () => {
    let ran = false;
    const { kernel, events } = newKernel();
    kernel.register(
      command(
        'probe',
        async () => {
          ran = true;
          return 0;
        },
        [parameterMetadata('Path', { position: 0 })],
      ),
    );

    kernel.send({
      kind: 'exec',
      requestId: 'r1',
      terminalId: 't1',
      source: 'probe -Nope x',
      background: false,
    });
    await kernel.drain();

    assert.equal(ran, false);
    assert.deepEqual(errors(events), ['NamedParameterNotFound,probe']);
    const error = events.find((e) => e.kind === 'stream' && e.which === 'error');
    assert.ok(error?.kind === 'stream' && error.which === 'error');
    assert.equal(
      error.payload.message,
      "A parameter cannot be found that matches parameter name 'Nope'.",
    );
    // Every exec still produces exactly one exit.
    assert.equal(events.filter((e) => e.kind === 'exit').length, 1);
    assert.equal(events.find((e) => e.kind === 'exit')?.exitCode, 1);
  });

  it('a binding failure in a later stage stops the earlier stages running at all', async () => {
    // Measured in pwsh 7.6.5:
    //   function Prod4 { 1..2 | ForEach-Object { $script:bindProbe += $_; $_ } }
    //   Prod4 | Get-Item -NoSuchParameter x
    //   $bindProbe  ->  <empty>
    const produced: number[] = [];
    const { kernel, events } = newKernel();
    kernel.register(
      command('prod', async (context) => {
        for (const value of [1, 2]) {
          produced.push(value);
          await context.streams.success.write(value);
        }
        return 0;
      }),
    );
    kernel.register(
      command('probe', async () => 0, [parameterMetadata('Path', { position: 0 })]),
    );

    kernel.send({
      kind: 'exec',
      requestId: 'r1',
      terminalId: 't1',
      source: 'prod | probe -Nope x',
      background: false,
    });
    await kernel.drain();

    assert.deepEqual(produced, [], 'the first stage must not run for a line that cannot work');
    assert.deepEqual(errors(events), ['NamedParameterNotFound,probe']);
    // One pid, for the stage that could not bind — the same invariant the
    // unknown-command path keeps.
    assert.equal(kernel.processes.list().length, 1);
  });
});

// ---------------------------------------------------------------------------
// what an adversarial pass over the fixes above turned up
// ---------------------------------------------------------------------------

describe('trying to defeat the fixes', () => {
  it('an ignored INFINITE upstream still terminates when the consumer stops early', async () => {
    // The drain that reproduces pwsh's push semantics is also the obvious place
    // to introduce a hang: a stage that ignores its input drains the upstream
    // after it returns, and if that drain outlived the teardown, `infinite |
    // ignores | first1` would never finish. It does not, because `runCommand`
    // aborts the stage BEFORE awaiting the drain and `guardedInput` checks the
    // signal before every pull.
    let produced = 0;
    const { kernel, events } = newKernel();
    kernel.register(
      command('infinite', async (context) => {
        for (;;) {
          if (context.streams.success.closed || context.signal.aborted) break;
          produced += 1;
          await context.streams.success.write(produced);
        }
        return 0;
      }),
    );
    kernel.register(
      command('ignores', async (context) => {
        await context.streams.success.write('ignored');
        return 0;
      }),
    );
    kernel.register(
      command('first1', async (context) => {
        for await (const value of context.input) {
          await context.streams.success.write(value);
          break;
        }
        return 0;
      }),
    );

    kernel.send({
      kind: 'exec',
      requestId: 'r1',
      terminalId: 't1',
      source: 'infinite | ignores | first1',
      background: false,
    });
    await kernel.drain();

    assert.deepEqual(objects(events), ['ignored']);
    assert.ok(produced < 10, `the ignored upstream produced ${produced} before being torn down`);
    assert.equal(events.filter((event) => event.kind === 'exit').length, 3);
  });

  it('SIGKILL on any stage of a running pipeline stops it rather than deadlocking it', async () => {
    // Backpressure is only correct if it BLOCKS. A stage parked in `write`
    // waiting for an acknowledgement that will never come is the difference
    // between a pipeline that stops and a tab that hangs, so every position in
    // the chain is killed and the drain has to finish.
    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      });

    for (const target of [1, 2, 3]) {
      const { kernel } = newKernel();
      kernel.register(
        command('produce', async (context) => {
          for (let index = 0; index < 100; index += 1) {
            if (context.streams.success.closed || context.signal.aborted) break;
            await sleep(2);
            await context.streams.success.write(index);
          }
          return 0;
        }),
      );
      for (const name of ['middle', 'tail']) {
        kernel.register(
          command(name, async (context) => {
            for await (const value of context.input) await context.streams.success.write(value);
            return 0;
          }),
        );
      }

      kernel.send({
        kind: 'exec',
        requestId: 'r1',
        terminalId: 't1',
        source: 'produce | middle | tail',
        background: false,
      });
      await sleep(20);
      kernel.send({ kind: 'signal', processId: target, signal: 'SIGKILL' });

      const finished = await Promise.race([
        kernel.drain().then(() => true),
        sleep(5000).then(() => false),
      ]);
      assert.equal(finished, true, `killing stage ${target} deadlocked the pipeline`);
      assert.equal(kernel.processes.get(target)?.exitCode, SIGNAL_EXIT_CODE.SIGKILL);
      for (const pid of [1, 2, 3]) {
        assert.equal(kernel.processes.get(pid)?.state, 'exited', `pid ${pid} after killing ${target}`);
      }
      assert.equal(kernel.lastSucceeded('t1'), false);
    }
  });

  it('events reach a listener in sequence order even when a listener sends a request', async () => {
    // A UI that answers an event by sending a request is an ordinary thing to
    // write, and it used to break the ordering the sequence number exists for:
    // the nested request emitted seq 4 and delivered it in full before seq 3
    // reached the listener registered after it. Measured before the outbox:
    //   delivery order of seq: 1,2,4,3,5,6
    const { kernel } = newKernel();
    kernel.register(
      command('greet', async (context) => {
        await context.streams.success.write('hi');
        return 0;
      }),
    );

    let answered = false;
    kernel.on((event) => {
      if (event.kind === 'objects' && !answered) {
        answered = true;
        // Malformed on purpose, so it emits a `rejected` from inside delivery.
        kernel.send({ kind: 'resize', terminalId: 't1', columns: 0, rows: 0 });
      }
    });
    const delivered: KernelEvent[] = [];
    kernel.on((event) => delivered.push(event));

    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: 'greet', background: false });
    await kernel.drain();

    assert.equal(answered, true, 'the re-entrant send has to have happened');
    const numbers = delivered.map((event) => event.seq);
    assert.deepEqual(
      numbers,
      [...numbers].sort((a, b) => a - b),
      `delivered out of order: ${numbers.join(',')}`,
    );
  });

  it('an event emitted during delivery still reaches every listener exactly once', async () => {
    const { kernel } = newKernel();
    kernel.register(command('quiet', async () => 0));
    let sent = false;
    kernel.on((event) => {
      if (event.kind === 'exit' && !sent) {
        sent = true;
        kernel.send({ kind: 'cancel', requestId: '' });
      }
    });
    const seen: number[] = [];
    kernel.on((event) => seen.push(event.seq));

    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: 'quiet', background: false });
    await kernel.drain();

    assert.equal(new Set(seen).size, seen.length, `an event was delivered twice: ${seen.join(',')}`);
  });
});

// ---------------------------------------------------------------------------
// $? and $LASTEXITCODE are two different questions
// ---------------------------------------------------------------------------

describe('$? and $LASTEXITCODE', () => {
  /** A command whose manifest says a separate runtime executed it. */
  function nativeCommand(name: string, status: number): CommandModule {
    return {
      manifest: { ...manifest(name), runtime: 'wasm' },
      invoke: async () => status,
    };
  }

  it('starts as pwsh does: $? true, $LASTEXITCODE unset', () => {
    // Measured in a fresh pwsh 7.6.5 session: `Get-Variable LASTEXITCODE`
    // finds nothing, and `$?` is True.
    const { kernel } = newKernel();
    assert.equal(kernel.lastSucceeded('t1'), true);
    assert.equal(kernel.lastExitCode('t1'), null, 'null, not 0 — 0 means a program succeeded');
  });

  it('a cmdlet moves $? and NEVER $LASTEXITCODE', async () => {
    // The measurement this whole model comes from, in pwsh 7.6.5:
    //   cmd /c "exit 42"                 $LASTEXITCODE 42, $? False
    //   Get-Date                         $LASTEXITCODE 42, $? True
    //   cmd /c "exit 7"; Get-Item nosuch $LASTEXITCODE  7, $? False
    const { kernel } = newKernel();
    kernel.register(nativeCommand('program', 42));
    kernel.register(command('ok', async () => 0));
    kernel.register(command('fails', async () => 3));

    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: 'program', background: false });
    await kernel.drain();
    assert.equal(kernel.lastExitCode('t1'), 42);
    assert.equal(kernel.lastSucceeded('t1'), false);

    kernel.send({ kind: 'exec', requestId: 'r2', terminalId: 't1', source: 'ok', background: false });
    await kernel.drain();
    assert.equal(kernel.lastSucceeded('t1'), true);
    assert.equal(kernel.lastExitCode('t1'), 42, 'a cmdlet that SUCCEEDED left it alone');

    kernel.send({ kind: 'exec', requestId: 'r3', terminalId: 't1', source: 'fails', background: false });
    await kernel.drain();
    assert.equal(kernel.lastSucceeded('t1'), false);
    assert.equal(kernel.lastExitCode('t1'), 42, 'a cmdlet that FAILED left it alone too');
  });

  it('$? is false for a command that produced output AND wrote an error', async () => {
    // Measured: `Get-Item 'C:\nope','C:\Windows' -ErrorAction SilentlyContinue`
    // emits one object and still leaves $? False. So $? is not exitCode === 0.
    const { kernel, events } = newKernel();
    kernel.register(
      command('partial', async (context) => {
        await context.streams.success.write('one');
        await context.streams.error.write({
          message: 'the other one is missing',
          fullyQualifiedErrorId: 'PathNotFound,partial',
          category: 'ObjectNotFound',
          exceptionType: 'System.Management.Automation.ItemNotFoundException',
        });
        return 0;
      }),
    );

    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: 'partial', background: false });
    await kernel.drain();

    assert.deepEqual(objects(events), ['one'], 'it really did produce output');
    const exit = events.find((event) => event.kind === 'exit');
    assert.equal(exit?.exitCode, 0, 'and its status really is zero');
    assert.equal(exit?.succeeded, false);
    assert.equal(kernel.lastSucceeded('t1'), false);
  });

  it('a command-not-found sets $? false and leaves $LASTEXITCODE alone', async () => {
    // Measured: `cmd /c "exit 13"` then This-Command-Does-Not-Exist leaves the
    // variable at 13. 127 is this engine's STATUS for it, not that variable.
    const { kernel, events } = newKernel();
    kernel.register(nativeCommand('program', 13));

    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: 'program', background: false });
    await kernel.drain();
    kernel.send({ kind: 'exec', requestId: 'r2', terminalId: 't1', source: 'nope', background: false });
    await kernel.drain();

    assert.equal(kernel.lastExitCode('t1'), 13);
    assert.equal(kernel.lastSucceeded('t1'), false);
    const exits = events.filter((event) => event.kind === 'exit');
    assert.equal(exits[1]?.exitCode, 127, 'the status is still the shell convention');
    assert.equal(exits[1]?.nativeExitCode, null, 'but it is not $LASTEXITCODE');
  });

  it('$? is the AND over a pipeline, not just the last stage', async () => {
    // Measured: `Get-Item 'C:\nope' -ErrorAction SilentlyContinue | Measure-Object`
    // leaves $? False even though the last stage succeeded.
    const { kernel } = newKernel();
    kernel.register(command('fails', async () => 3));
    kernel.register(
      command('counts', async (context) => {
        let seen = 0;
        for await (const _value of context.input) seen += 1;
        await context.streams.success.write(seen);
        return 0;
      }),
    );

    kernel.send({
      kind: 'exec',
      requestId: 'r1',
      terminalId: 't1',
      source: 'fails | counts',
      background: false,
    });
    await kernel.drain();
    assert.equal(kernel.lastSucceeded('t1'), false);
  });

  it('$LASTEXITCODE is the last stage that set one, even mid-pipeline', async () => {
    // Measured: `cmd /c "exit 77" | Out-Null`  ->  $LASTEXITCODE 77.
    const { kernel } = newKernel();
    kernel.register(nativeCommand('program', 77));
    kernel.register(
      command('sink', async (context) => {
        for await (const _value of context.input) {
          // consumed and discarded
        }
        return 0;
      }),
    );

    kernel.send({
      kind: 'exec',
      requestId: 'r1',
      terminalId: 't1',
      source: 'program | sink',
      background: false,
    });
    await kernel.drain();
    assert.equal(kernel.lastExitCode('t1'), 77);
  });

  it('keeps $? per terminal, because two panes are two sessions', async () => {
    const { kernel } = newKernel();
    kernel.register(command('fails', async () => 1));
    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: 'fails', background: false });
    await kernel.drain();
    assert.equal(kernel.lastSucceeded('t1'), false);
    assert.equal(kernel.lastSucceeded('t2'), true);
  });
});

// ---------------------------------------------------------------------------
// the object model across a stage boundary
// ---------------------------------------------------------------------------

describe('what a stage hands the next stage', () => {
  it('keeps baseObject BETWEEN stages and strips it only on the way out', async () => {
    // The old kernel sanitised at every stage boundary, so a command downstream
    // of a producer could never reach the host value that `PSObject.baseObject`
    // exists to carry. Sanitising is a boundary concern, and the boundary is
    // the kernel's edge, not a join inside it.
    let sawBase: unknown = 'not-seen';
    const { kernel, events } = newKernel();
    kernel.register(
      command('wrap', async (context) => {
        await context.streams.success.write({
          typeNames: ['System.IO.FileInfo', 'System.Object'],
          properties: { Name: 'file.txt' },
          baseObject: { handle: 7 },
        });
        return 0;
      }),
    );
    kernel.register(
      command('peek', async (context) => {
        for await (const value of context.input) {
          sawBase = (value as { baseObject?: unknown }).baseObject;
          await context.streams.success.write(value);
        }
        return 0;
      }),
    );

    kernel.send({
      kind: 'exec',
      requestId: 'r1',
      terminalId: 't1',
      source: 'wrap | peek',
      background: false,
    });
    await kernel.drain();

    assert.deepEqual(sawBase, { handle: 7 }, 'the host value survived the join');
    const emitted = objects(events)[0] as { properties: Record<string, unknown> };
    assert.equal(Object.hasOwn(emitted, 'baseObject'), false, 'and not the boundary');
    assert.deepEqual(emitted.properties, { Name: 'file.txt' });
  });
});
