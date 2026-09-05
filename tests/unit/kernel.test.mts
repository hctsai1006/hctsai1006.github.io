/**
 * Tests for the protocol and the kernel end to end.
 *
 * Two things are being pinned.
 *
 * The protocol is structured-clone safe, because it will cross a Worker
 * boundary. That is asserted rather than reasoned about: a `DataCloneError` at
 * `postMessage` names the message, not the command three layers down that put a
 * class instance in it, so the check has to happen where the message is built.
 * Both directions are covered — the rules reject what they should, and every
 * event a real session actually emits survives a real `structuredClone`.
 *
 * The kernel turns a command line into a process. Everything the v1 terminal
 * cannot do — interrupt a pipeline, background a job, report an exit code,
 * stream progressively — is asserted here as an ordinary operation rather than
 * as a special case, because being ordinary is the entire point of the model.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CapabilityDeniedError } from '../../src/commands/invocation.ts';
import type { CommandModule, InvocationContext } from '../../src/commands/invocation.ts';
import type { CommandManifest } from '../../src/commands/manifest.ts';
import type { PSValue } from '../../src/pipeline/psobject.ts';
// The seed's home, imported rather than repeated: the kernel default and the
// filesystem it boots into were two different strings, and nothing compared them.
import { HOME as DEFAULT_HOME } from '../../src/storage/seed.ts';
import { psObject, psWrap } from '../../src/pipeline/psobject.ts';
import { errorRecord } from '../../src/pipeline/streams.ts';
import {
  KERNEL_EVENT_KINDS,
  KERNEL_REQUEST_KINDS,
  KERNEL_STREAMS,
  assertCloneSafe,
  cloneSafetyProblems,
  isCloneSafe,
  sanitizePSValue,
} from '../../src/kernel/protocol.ts';
import type { KernelEvent, KernelRequest, ObjectsEvent } from '../../src/kernel/protocol.ts';
import {
  EXIT_COMMAND_NOT_FOUND,
  EXIT_FAILURE,
  Kernel,
  splitPipeline,
  splitTokens,
} from '../../src/kernel/kernel.ts';
import { SIGNAL_EXIT_CODE } from '../../src/kernel/signals.ts';
import { KERNEL_PID } from '../../src/kernel/ids.ts';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function manifest(overrides: Partial<CommandManifest> = {}): CommandManifest {
  return {
    name: 'test-command',
    display: 'Test-Command',
    aliases: [],
    runtime: 'semantic',
    fidelity: 'native-semantic',
    risk: 'read',
    capabilities: [],
    parameters: [],
    outputTypeNames: [],
    synopsis: 'A command that exists only in these tests.',
    parameterSource: 'none',
    implementationStatus: 'implemented',
    ...overrides,
  };
}

/** Build a CommandModule from an invoke body. */
function command(
  overrides: Partial<CommandManifest>,
  invoke: (context: InvocationContext) => Promise<number>,
): CommandModule {
  return { manifest: manifest(overrides), invoke: (context) => invoke(context) };
}

interface Gate {
  readonly promise: Promise<void>;
  release(): void;
}

function gate(): Gate {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, release: () => resolve() };
}

/** Resolves when the signal aborts. Never rejects — the caller decides. */
function aborted(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

const encoder = new TextEncoder();

/** Emits its arguments as objects. The trivial end-to-end command. */
function emitter(name: string, values: readonly PSValue[]): CommandModule {
  return command({ name, display: name }, async (context) => {
    for (const value of values) await context.streams.success.write(value);
    return 0;
  });
}

/** Waits for a gate, and honours the signal while waiting. */
function waiter(name: string, released: Gate): CommandModule {
  return command({ name, display: name }, async (context) => {
    await Promise.race([released.promise, aborted(context.signal)]);
    context.signal.throwIfAborted();
    await context.streams.success.write(`${name}-finished`);
    return 0;
  });
}

/** Ignores the signal entirely. The only way to test that SIGKILL is not catchable. */
function stubborn(name: string, released: Gate): CommandModule {
  return command({ name, display: name }, async (context) => {
    await released.promise;
    await context.streams.success.write(`${name}-finished`);
    return 0;
  });
}

/** Writes to every stream and both byte channels. */
const CHATTY = command({ name: 'chatty', display: 'Write-Everything' }, async (context) => {
  await context.streams.success.write(psObject({ Name: 'result' }));
  await context.streams.error.write(errorRecord('bad', 'Boom', 'Write-Everything', 'InvalidData'));
  await context.streams.warning.write('careful');
  await context.streams.verbose.write('details');
  await context.streams.debug.write('internals');
  await context.streams.information.write({
    message: 'hello',
    tags: ['host'],
    source: 'Write-Everything',
    timestamp: 1_700,
  });
  await context.streams.progress.write({
    activityId: 1,
    activity: 'Working',
    status: 'Half way',
    percentComplete: 50,
    completed: false,
  });

  const out = context.native?.stdout.getWriter();
  if (out !== undefined) {
    await out.write(encoder.encode('to stdout'));
    out.releaseLock();
  }
  const err = context.native?.stderr.getWriter();
  if (err !== undefined) {
    await err.write(encoder.encode('to stderr'));
    err.releaseLock();
  }
  return 0;
});

function objectValues(events: readonly KernelEvent[]): readonly PSValue[] {
  return events
    .filter((event): event is ObjectsEvent => event.kind === 'objects')
    .flatMap((event) => [...event.values]);
}

// ---------------------------------------------------------------------------
// the structured-clone constraint
// ---------------------------------------------------------------------------

describe('structured-clone safety', () => {
  it('accepts everything the protocol is allowed to carry', () => {
    const message = {
      nothing: null,
      flag: true,
      count: 7,
      big: 9_007_199_254_740_993n,
      text: 'hello',
      when: new Date(0),
      bytes: encoder.encode('raw'),
      list: [1, 'two', null],
      map: new Map([['k', 1]]),
      set: new Set([1, 2]),
      nested: { deep: { deeper: 'yes' } },
    };
    assert.deepEqual(cloneSafetyProblems(message), []);
    assert.deepEqual(structuredClone(message), message);
  });

  it('rejects a function, because a reply is an event and not a callback', () => {
    const problems = cloneSafetyProblems({ onDone: () => undefined }, 'msg');
    assert.equal(problems.length, 1);
    assert.match(problems[0] as string, /msg\.onDone is a function/u);
    assert.throws(() => assertCloneSafe({ onDone: () => undefined }), /not structured-clone safe/u);
  });

  it('rejects a class instance, because the prototype does not survive', () => {
    // This is the failure that matters most: the value arrives intact-looking
    // and every `instanceof` on the far side silently stops matching.
    class Handle {
      readonly id = 1;
    }
    const problems = cloneSafetyProblems({ handle: new Handle() }, 'msg');
    assert.equal(problems.length, 1);
    assert.match(problems[0] as string, /instance of Handle/u);
    assert.match(problems[0] as string, /instanceof on the far side would stop matching/u);
  });

  it('rejects an Error and points at ErrorRecord', () => {
    const problems = cloneSafetyProblems({ cause: new TypeError('nope') }, 'msg');
    assert.equal(problems.length, 1);
    assert.match(problems[0] as string, /use an ErrorRecord/u);
  });

  it('rejects undefined, which clones fine but means two things', () => {
    // Not a survival problem — an ambiguity problem. A field that can be both
    // absent and present-and-undefined has two encodings for one meaning.
    assert.deepEqual(structuredClone({ a: undefined }), { a: undefined });
    const problems = cloneSafetyProblems({ a: undefined }, 'msg');
    assert.match(problems[0] as string, /use null so "absent" has one encoding/u);
  });

  it('rejects a symbol key, which structured clone silently drops', () => {
    const message = { [Symbol('hidden')]: 1, visible: 2 };
    assert.match(cloneSafetyProblems(message, 'msg')[0] as string, /symbol-keyed/u);
  });

  it('allows a cycle, because structured clone preserves one', () => {
    const message: Record<string, unknown> = { name: 'loop' };
    message['self'] = message;
    assert.equal(isCloneSafe(message), true);
    const clone = structuredClone(message);
    assert.equal(clone['self'], clone);
  });

  it('names the path of the offending value', () => {
    const problems = cloneSafetyProblems({ a: { b: [1, () => undefined] } }, 'event');
    assert.match(problems[0] as string, /^event\.a\.b\[1\] /u);
  });
});

describe('sanitizePSValue', () => {
  it('strips baseObject, which is the one thing a PSObject cannot send', () => {
    // baseObject exists so a command can reach the underlying host value. That
    // is useful inside the kernel and meaningless outside it, so it is dropped
    // at the boundary rather than banned from the object model.
    const wrapped = psWrap({ Name: 'file.txt' }, ['System.IO.FileInfo'], { handle: () => undefined });
    assert.equal(isCloneSafe(wrapped), false);

    const safe = sanitizePSValue(wrapped);
    assert.equal(isCloneSafe(safe), true);
    assert.equal(Object.hasOwn(safe as object, 'baseObject'), false);
    assert.deepEqual(structuredClone(safe), safe);
  });

  it('strips it from nested properties and from arrays too', () => {
    const nested = psObject({
      Child: psWrap({ X: 1 }, ['T'], new Map()),
      List: [psWrap({ Y: 2 }, ['T'], new Map())],
    });
    assert.equal(isCloneSafe(sanitizePSValue(nested)), true);
  });

  it('returns the same reference when nothing needed stripping', () => {
    const plain = psObject({ Name: 'x' });
    assert.equal(sanitizePSValue(plain), plain);
  });
});

describe('every KernelEvent survives structuredClone', () => {
  /** One of every variant of the union, including all four `stream` shapes. */
  const samples: readonly KernelEvent[] = [
    { kind: 'objects', requestId: 'r1', values: [psObject({ Name: 'a', Size: 1 }), null, 'text'] },
    { kind: 'stdout', processId: 1, bytes: encoder.encode('out') },
    { kind: 'stderr', processId: 1, bytes: encoder.encode('err') },
    {
      kind: 'stream',
      processId: 1,
      which: 'error',
      payload: errorRecord('bad', 'Boom', 'Test-Command', 'InvalidData', { targetObject: 'x' }),
    },
    { kind: 'stream', processId: 1, which: 'warning', payload: 'careful' },
    { kind: 'stream', processId: 1, which: 'verbose', payload: 'details' },
    { kind: 'stream', processId: 1, which: 'debug', payload: 'internals' },
    {
      kind: 'stream',
      processId: 1,
      which: 'information',
      payload: { message: 'hello', tags: ['host'], source: 'Test-Command', timestamp: 1 },
    },
    {
      kind: 'stream',
      processId: 1,
      which: 'progress',
      payload: { activityId: 1, activity: 'Work', status: 'Going', percentComplete: 50, completed: false },
    },
    {
      kind: 'process-changed',
      snapshot: {
        pid: 1,
        ppid: KERNEL_PID,
        pgid: 1,
        name: 'Test-Command',
        state: 'running',
        cwd: '/home/visitor',
        commandLine: 'Test-Command',
        startedAt: 1_700,
        endedAt: null,
        exitCode: null,
        runtime: 'semantic',
        terminalId: 't1',
        requestId: 'r1',
        background: false,
        signalled: null,
      },
    },
    { kind: 'exit', processId: 1, requestId: 'r1', exitCode: 0, signalled: null },
  ];

  it('covers every event kind and every stream', () => {
    // A round-trip suite that quietly stopped covering a variant would pass
    // forever, so the coverage itself is asserted.
    assert.deepEqual([...new Set(samples.map((e) => e.kind))].sort(), [...KERNEL_EVENT_KINDS].sort());
    const streams = samples.filter((e) => e.kind === 'stream').map((e) => e.which);
    assert.deepEqual([...streams].sort(), [...KERNEL_STREAMS].sort());
  });

  for (const sample of samples) {
    const label = sample.kind === 'stream' ? `stream:${sample.which}` : sample.kind;
    it(`round-trips ${label}`, () => {
      assert.deepEqual(cloneSafetyProblems(sample, label), []);
      assert.deepEqual(structuredClone(sample), sample);
    });
  }

  it('lists exactly the request kinds the protocol defines', () => {
    const requests: readonly KernelRequest[] = [
      { kind: 'exec', requestId: 'r', terminalId: 't', source: 'gci', background: false },
      { kind: 'stdin', processId: 1, bytes: encoder.encode('in'), endOfFile: false },
      { kind: 'signal', processId: -1, signal: 'SIGINT' },
      { kind: 'resize', terminalId: 't', columns: 120, rows: 40 },
      { kind: 'cancel', requestId: 'r' },
    ];
    assert.deepEqual(requests.map((r) => r.kind), [...KERNEL_REQUEST_KINDS]);
    for (const request of requests) {
      assert.deepEqual(cloneSafetyProblems(request, request.kind), []);
      assert.deepEqual(structuredClone(request), request);
    }
  });
});

// ---------------------------------------------------------------------------
// the placeholder splitter
// ---------------------------------------------------------------------------

describe('splitPipeline', () => {
  it('splits on top-level pipes', () => {
    assert.deepEqual(splitPipeline('gci | sort | select'), ['gci', 'sort', 'select']);
  });

  it('does not split inside quotes', () => {
    // index.html's bare split('|') turns this into two commands. A splitter
    // that is wrong on a literal is worse than no splitter.
    assert.deepEqual(splitPipeline("Write-Output 'a|b'"), ["Write-Output 'a|b'"]);
    assert.deepEqual(splitPipeline('Write-Output "a|b" | sort'), ['Write-Output "a|b"', 'sort']);
  });

  it('drops empty stages and trims', () => {
    assert.deepEqual(splitPipeline('  '), []);
    assert.deepEqual(splitTokens('  gci   -Path  /home '), ['gci', '-Path', '/home']);
  });
});

// ---------------------------------------------------------------------------
// the kernel
// ---------------------------------------------------------------------------

function newKernel(options: ConstructorParameters<typeof Kernel>[0] = {}): {
  kernel: Kernel;
  events: KernelEvent[];
} {
  const kernel = new Kernel({ clock: () => 1_700_000_000_000, ...options });
  const events: KernelEvent[] = [];
  kernel.on((event) => events.push(event));
  return { kernel, events };
}

describe('running a command end to end', () => {
  it('creates a process, emits its objects, and exits 0', async () => {
    const { kernel, events } = newKernel();
    kernel.register(emitter('greet', ['hello', 42]));

    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: 'greet', background: false });
    await kernel.drain();

    assert.deepEqual(objectValues(events), ['hello', 42]);

    const exit = events.find((e) => e.kind === 'exit');
    assert.equal(exit?.exitCode, 0);
    assert.equal(exit?.requestId, 'r1');
    assert.equal(exit?.signalled, null);

    const states = events
      .filter((e) => e.kind === 'process-changed')
      .map((e) => e.snapshot.state);
    assert.deepEqual(states, ['created', 'running', 'exited']);

    const process = kernel.processes.get(1);
    assert.equal(process?.pid, 1);
    assert.equal(process?.name, 'greet');
    assert.equal(process?.commandLine, 'greet');
    assert.equal(process?.exitCode, 0);
    assert.equal(process?.startedAt, 1_700_000_000_000);
  });

  it('resolves a command case-insensitively and by alias', async () => {
    // PowerShell lookup is case-insensitive; a Map keyed on the exact string
    // would silently miss `get-childitem`.
    const { kernel } = newKernel();
    kernel.register(
      command({ name: 'get-childitem', display: 'Get-ChildItem', aliases: ['gci', 'ls'] }, async () => 0),
    );

    for (const token of ['Get-ChildItem', 'get-childitem', 'GCI', 'ls']) {
      assert.notEqual(kernel.resolve(token), undefined, token);
    }
    assert.equal(kernel.resolve('Get-Content'), undefined);
  });

  it('gives even an unknown command a pid, so every exec produces one exit', async () => {
    const { kernel, events } = newKernel();
    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: 'nope', background: false });
    await kernel.drain();

    const error = events.find((e) => e.kind === 'stream');
    assert.equal(error?.which, 'error');
    const record = error?.payload as { message: string; fullyQualifiedErrorId: string };
    assert.match(record.message, /is not recognized as a name of a cmdlet/u);
    // Scripts match on the composed id, so it is part of the observable contract.
    assert.equal(record.fullyQualifiedErrorId, 'CommandNotFoundException,nope');

    const exit = events.find((e) => e.kind === 'exit');
    assert.equal(exit?.exitCode, EXIT_COMMAND_NOT_FOUND);
    assert.equal(exit?.requestId, 'r1');
  });

  it('runs no stage of a pipeline whose later stage does not exist', async () => {
    // A shell that ran the first two would produce side effects for a command
    // line that was never going to work.
    const { kernel, events } = newKernel();
    let ran = false;
    kernel.register(
      command({ name: 'sideeffect', display: 'sideeffect' }, async () => {
        ran = true;
        return 0;
      }),
    );

    kernel.send({
      kind: 'exec',
      requestId: 'r1',
      terminalId: 't1',
      source: 'sideeffect | nope',
      background: false,
    });
    await kernel.drain();

    assert.equal(ran, false);
    assert.equal(events.find((e) => e.kind === 'exit')?.exitCode, EXIT_COMMAND_NOT_FOUND);
  });

  it('turns a thrown error into an ErrorRecord and exit 1', async () => {
    const { kernel, events } = newKernel();
    kernel.register(
      command({ name: 'boom', display: 'boom' }, () => {
        throw new RangeError('out of range');
      }),
    );

    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: 'boom', background: false });
    await kernel.drain();

    const error = events.find((e) => e.kind === 'stream');
    assert.equal(error?.which, 'error');
    assert.deepEqual(
      { message: (error?.payload as { message: string }).message, kind: error?.which },
      { message: 'out of range', kind: 'error' },
    );
    assert.equal(events.find((e) => e.kind === 'exit')?.exitCode, EXIT_FAILURE);
  });

  it('reports the terminal size through the environment', async () => {
    // Format-Table's widths come from here. A kernel that must run in a Worker
    // cannot measure a DOM, so the size has to be told to it.
    const { kernel } = newKernel();
    const seen: string[] = [];
    kernel.register(
      command({ name: 'probe', display: 'probe' }, async (context) => {
        seen.push(`${context.env.get('COLUMNS')}x${context.env.get('LINES')}`, context.env.get('PWD') ?? '');
        return 0;
      }),
    );

    kernel.send({ kind: 'resize', terminalId: 't1', columns: 132, rows: 43 });
    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: 'probe', background: false });
    await kernel.drain();

    // The seed tree's home. This asserted '/home/visitor' until the storage and
    // kernel branches were compared: the filesystem the host boots contains
    // /home/thc1006 and not /home/visitor, so the shell was starting in a
    // directory that does not exist.
    assert.deepEqual(seen, ['132x43', DEFAULT_HOME]);
    assert.deepEqual(kernel.terminalSize('t1'), { columns: 132, rows: 43 });
    assert.deepEqual(kernel.terminalSize('never-seen'), { columns: 80, rows: 24 });
  });

  it('delivers stdin as bytes and closes it on EOF', async () => {
    const { kernel } = newKernel();
    kernel.register(
      command({ name: 'cat', display: 'cat' }, async (context) => {
        const stdin = context.native?.stdin;
        if (stdin === null || stdin === undefined) return 1;
        const reader = stdin.getReader();
        const chunks: Uint8Array[] = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value !== undefined) chunks.push(value);
        }
        const joined = chunks.map((c) => new TextDecoder().decode(c)).join('');
        await context.streams.success.write(joined);
        return 0;
      }),
    );

    const { events } = { events: [] as KernelEvent[] };
    kernel.on((event) => events.push(event));
    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: 'cat', background: false });
    kernel.send({ kind: 'stdin', processId: 1, bytes: encoder.encode('one '), endOfFile: false });
    kernel.send({ kind: 'stdin', processId: 1, bytes: encoder.encode('two'), endOfFile: true });
    await kernel.drain();

    assert.deepEqual(objectValues(events), ['one two']);
  });
});

describe('pipelines', () => {
  it('feeds one stage into the next and shares one process group', async () => {
    const { kernel, events } = newKernel();
    kernel.register(emitter('produce', [1, 2, 3]));
    kernel.register(
      command({ name: 'double', display: 'double' }, async (context) => {
        for await (const value of context.input) {
          await context.streams.success.write((value as number) * 2);
        }
        return 0;
      }),
    );

    kernel.send({
      kind: 'exec',
      requestId: 'r1',
      terminalId: 't1',
      source: 'produce | double',
      background: false,
    });
    await kernel.drain();

    // Only the LAST stage's objects reach the terminal; the first stage's went
    // into the queue, which is what a pipeline is.
    assert.deepEqual(objectValues(events), [2, 4, 6]);

    const first = kernel.processes.get(1);
    const second = kernel.processes.get(2);
    assert.equal(first?.pgid, 1);
    assert.equal(second?.pgid, 1, 'the whole pipeline is one group');
    assert.equal(second?.ppid, 1);
    assert.equal(kernel.processes.membersOf(1).length, 2);
  });

  it('reports the LAST stage exit code, as POSIX and PowerShell both do', async () => {
    const { kernel, events } = newKernel();
    kernel.register(emitter('produce', [1]));
    kernel.register(command({ name: 'fail', display: 'fail' }, async () => 3));

    kernel.send({
      kind: 'exec',
      requestId: 'r1',
      terminalId: 't1',
      source: 'produce | fail',
      background: false,
    });
    await kernel.drain();

    // Sorted by pid, not by arrival: a downstream stage may finish first, the
    // same way `yes | head -1` ends with the reader gone before the writer.
    const exits = events
      .filter((e) => e.kind === 'exit')
      .map((e) => [e.processId, e.exitCode])
      .sort((a, b) => (a[0] as number) - (b[0] as number));
    assert.deepEqual(exits, [
      [1, 0],
      [2, 3],
    ]);
  });
});

describe('signals through the kernel', () => {
  it('Ctrl+C stops the foreground pipeline and leaves the background job alone', async () => {
    const { kernel, events } = newKernel();
    const foreground = gate();
    const background = gate();
    kernel.register(waiter('fg', foreground));
    kernel.register(waiter('bg', background));

    kernel.send({ kind: 'exec', requestId: 'r-fg', terminalId: 't1', source: 'fg', background: false });
    kernel.send({ kind: 'exec', requestId: 'r-bg', terminalId: 't1', source: 'bg', background: true });

    // The pids are allocated in order, so the foreground pipeline leads group 1
    // and the background job leads group 2.
    assert.equal(kernel.processes.get(1)?.background, false);
    assert.equal(kernel.processes.get(2)?.background, true);
    assert.equal(kernel.signals.foregroundGroup('t1'), 1);

    assert.deepEqual(kernel.interrupt('t1'), [1]);

    background.release();
    await kernel.drain();

    const exits = new Map(events.filter((e) => e.kind === 'exit').map((e) => [e.processId, e]));
    assert.equal(exits.get(1)?.exitCode, SIGNAL_EXIT_CODE.SIGINT);
    assert.equal(exits.get(1)?.signalled, 'SIGINT');
    // The whole reason process groups are modelled.
    assert.equal(exits.get(2)?.exitCode, 0);
    assert.equal(exits.get(2)?.signalled, null);

    // A background job's output is buffered for Receive-Job rather than printed,
    // because PowerShell does not print background output to the console.
    assert.deepEqual(objectValues(events), []);
    const job = kernel.jobs.list()[0];
    assert.equal(job?.state, 'Completed');
    assert.deepEqual(kernel.jobs.receive(job?.id ?? 0).values, ['bg-finished']);
  });

  it('accepts a negative pid as the group, which is how Ctrl+C is sent', async () => {
    const { kernel, events } = newKernel();
    const first = gate();
    const second = gate();
    kernel.register(waiter('a', first));
    kernel.register(waiter('b', second));

    kernel.send({
      kind: 'exec',
      requestId: 'r1',
      terminalId: 't1',
      source: 'a | b',
      background: false,
    });
    kernel.send({ kind: 'signal', processId: -1, signal: 'SIGINT' });
    await kernel.drain();

    const exits = events.filter((e) => e.kind === 'exit');
    assert.deepEqual(
      exits.map((e) => e.exitCode),
      [SIGNAL_EXIT_CODE.SIGINT, SIGNAL_EXIT_CODE.SIGINT],
    );
  });

  it('cancels by requestId, including before the process exists', async () => {
    // The window `cancel` exists for: a request has an id from the moment it is
    // sent, and a process only once the command name has resolved.
    const { kernel, events } = newKernel();
    const held = gate();
    kernel.register(waiter('hold', held));

    kernel.send({ kind: 'cancel', requestId: 'r1' });
    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: 'hold', background: false });
    await kernel.drain();

    assert.equal(events.find((e) => e.kind === 'exit')?.exitCode, SIGNAL_EXIT_CODE.SIGINT);
  });

  it('cancels a request that is already running', async () => {
    const { kernel, events } = newKernel();
    const held = gate();
    kernel.register(waiter('hold', held));

    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: 'hold', background: false });
    kernel.send({ kind: 'cancel', requestId: 'r1' });
    await kernel.drain();

    assert.equal(events.find((e) => e.kind === 'exit')?.signalled, 'SIGINT');
  });

  it('SIGKILL is not catchable: the process exits without the command unwinding', async () => {
    const { kernel, events } = newKernel();
    const held = gate();
    kernel.register(stubborn('ignores-signals', held));

    kernel.send({
      kind: 'exec',
      requestId: 'r1',
      terminalId: 't1',
      source: 'ignores-signals',
      background: false,
    });
    kernel.send({ kind: 'signal', processId: 1, signal: 'SIGKILL' });

    // No drain: the invocation is still running and will never notice. The
    // exit has already been reported, which is exactly the claim being made.
    const exit = events.find((e) => e.kind === 'exit');
    assert.equal(exit?.exitCode, SIGNAL_EXIT_CODE.SIGKILL);
    assert.equal(exit?.signalled, 'SIGKILL');
    assert.equal(kernel.processes.get(1)?.state, 'exited');

    // When it finally settles, its own exit code must lose — the kill happened
    // first and is what the user saw.
    held.release();
    await kernel.drain();
    assert.equal(events.filter((e) => e.kind === 'exit').length, 1);
    assert.equal(kernel.processes.get(1)?.exitCode, SIGNAL_EXIT_CODE.SIGKILL);
  });

  it('SIGTERM is cooperative: an unwinding command still reports 143', async () => {
    const { kernel, events } = newKernel();
    const held = gate();
    kernel.register(stubborn('ignores-signals', held));

    kernel.send({
      kind: 'exec',
      requestId: 'r1',
      terminalId: 't1',
      source: 'ignores-signals',
      background: false,
    });
    kernel.send({ kind: 'signal', processId: 1, signal: 'SIGTERM' });

    assert.equal(events.some((e) => e.kind === 'exit'), false, 'SIGTERM waits for the unwind');
    assert.equal(kernel.processes.get(1)?.state, 'stopping');

    held.release();
    await kernel.drain();

    const exit = events.find((e) => e.kind === 'exit');
    assert.equal(exit?.exitCode, SIGNAL_EXIT_CODE.SIGTERM);
    assert.equal(exit?.signalled, 'SIGTERM');
  });
});

describe('capabilities through the kernel', () => {
  const WRITER = command(
    {
      name: 'set-content',
      display: 'Set-Content',
      risk: 'write',
      fidelity: 'browser-backed',
      runtime: 'browser',
      capabilities: ['filesystem.write'],
    },
    async (context) => {
      context.requireCapability('filesystem.write');
      await context.streams.success.write('written');
      return 0;
    },
  );

  it('lets a granted command through and audits the write', async () => {
    const { kernel, events } = newKernel({ grants: ['filesystem.write'] });
    kernel.register(WRITER);

    kernel.send({
      kind: 'exec',
      requestId: 'r1',
      terminalId: 't1',
      source: 'Set-Content',
      background: false,
    });
    await kernel.drain();

    assert.deepEqual(objectValues(events), ['written']);
    assert.equal(events.find((e) => e.kind === 'exit')?.exitCode, 0);
    assert.deepEqual(
      kernel.audit.records.map((r) => [r.capability, r.decision, r.real]),
      [['filesystem.write', 'granted', true]],
    );
  });

  it('denies an ungranted command, and the denial actually reaches the terminal', async () => {
    const { kernel, events } = newKernel({ grants: [] });
    kernel.register(WRITER);

    kernel.send({
      kind: 'exec',
      requestId: 'r1',
      terminalId: 't1',
      source: 'Set-Content',
      background: false,
    });
    await kernel.drain();

    assert.deepEqual(objectValues(events), []);
    const error = events.find((e) => e.kind === 'stream');
    assert.equal(error?.which, 'error');
    const record = error?.payload as { message: string; category: string; targetObject?: unknown };
    assert.match(record.message, /requires the filesystem\.write capability/u);
    assert.equal(record.category, 'PermissionDenied');
    assert.equal(record.targetObject, 'filesystem.write');
    assert.equal(events.find((e) => e.kind === 'exit')?.exitCode, EXIT_FAILURE);

    assert.deepEqual(
      kernel.audit.denials().map((r) => r.decision),
      ['denied:not-granted'],
    );
  });

  it('throws CapabilityDeniedError from requireCapability itself', () => {
    // The kernel catches it, so the throw is asserted directly rather than
    // inferred from the exit code.
    const { kernel } = newKernel({ grants: [] });
    const scoped = kernel.capabilities.forCommand(WRITER.manifest, 1);
    assert.throws(() => scoped.require('filesystem.write'), CapabilityDeniedError);
  });
});

describe('everything a real session emits is clone-safe', () => {
  it('round-trips every event of a session that uses every channel', async () => {
    const { kernel, events } = newKernel();
    kernel.register(CHATTY);

    kernel.send({
      kind: 'exec',
      requestId: 'r1',
      terminalId: 't1',
      source: 'chatty',
      background: false,
    });
    await kernel.drain();

    // The kernel validates on the way out; this proves the real algorithm
    // agrees with our rules rather than only that our rules were applied.
    for (const event of events) {
      const label = event.kind === 'stream' ? `stream:${event.which}` : event.kind;
      assert.deepEqual(cloneSafetyProblems(event, label), [], label);
      assert.deepEqual(structuredClone(event), event, label);
    }

    assert.deepEqual(
      [...new Set(events.map((e) => e.kind))].sort(),
      [...KERNEL_EVENT_KINDS].sort(),
      'a real session should exercise every event kind',
    );
    assert.deepEqual(
      events.filter((e) => e.kind === 'stream').map((e) => e.which).sort(),
      [...KERNEL_STREAMS].sort(),
    );
  });

  it('refuses to emit an event carrying a host object', async () => {
    // Validation is on by default, so the failure names the command that built
    // the value rather than surfacing as a DataCloneError at postMessage. The
    // success stream is sanitised, so this is forced through a stream that is
    // not — an ErrorRecord's targetObject.
    const { kernel, events } = newKernel();
    kernel.register(
      command({ name: 'leaky', display: 'leaky' }, async (context) => {
        await context.streams.error.write(
          errorRecord('bad', 'Boom', 'leaky', 'InvalidData', {
            targetObject: psWrap({ X: 1 }, ['T'], new WeakMap()) as PSValue,
          }),
        );
        return 0;
      }),
    );

    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: 'leaky', background: false });
    await kernel.drain();

    // The throw is caught by the kernel and reported as a command failure,
    // which is what a bug in a command should look like.
    assert.equal(events.find((e) => e.kind === 'exit')?.exitCode, EXIT_FAILURE);
  });
});
