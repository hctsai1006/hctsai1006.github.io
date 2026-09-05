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
import type { FileSystemPort } from '../../src/commands/ports.ts';
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
  decodeKernelRequest,
  isCloneSafe,
  REQUEST_LIMITS,
  sanitizeErrorRecord,
  sanitizePSValue,
} from '../../src/kernel/protocol.ts';
import type {
  KernelEvent,
  KernelEventBody,
  KernelRequest,
  ObjectsEvent,
} from '../../src/kernel/protocol.ts';
import {
  EXIT_COMMAND_NOT_FOUND,
  EXIT_FAILURE,
  Kernel,
  splitPipeline,
  splitTokens,
} from '../../src/kernel/kernel.ts';
import { SIGNAL_EXIT_CODE } from '../../src/kernel/signals.ts';
import { KERNEL_PID } from '../../src/kernel/ids.ts';
import { CapabilityBroker } from '../../src/kernel/capabilities.ts';

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

/**
 * A `FileSystemPort` that is nothing but a current directory.
 *
 * A stub rather than the real VFS because what is being pinned is the KERNEL's
 * reconciliation of the shell's location, not `Set-Location`'s behaviour. The
 * real command over a real filesystem is exercised across a real Worker in
 * kernel-worker.test.mts.
 */
function movingPort(start: string): FileSystemPort {
  let full = start;
  return {
    get location() {
      return { full } as unknown as ReturnType<FileSystemPort['resolve']>;
    },
    setLocation: async (path: string) => {
      full = path;
      return { ok: true as const, value: { full } };
    },
  } as unknown as FileSystemPort;
}

/** Moves the port and emits nothing, which is exactly what `Set-Location` does. */
function mover(to = '/home/thc1006/sub'): CommandModule {
  return command({ name: 'cd', display: 'cd' }, async (context) => {
    await context.fs?.setLocation(to);
    return 0;
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
    .filter((event): event is ObjectsEvent & { seq: number } => event.kind === 'objects')
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

  it('returns a NEW graph even when nothing needed stripping', () => {
    // This used to return the input by reference "so the common case costs one
    // walk and no allocation". That is where the shared-subgraph property came
    // from — by accident — and it meant every guarantee the sanitiser appears to
    // give held only for inputs that were already clean. See kernel-wire.test.mts
    // for the properties that replaced it.
    const plain = psObject({ Name: 'x' });
    const safe = sanitizePSValue(plain);
    assert.notEqual(safe, plain);
    assert.deepEqual(safe, plain);
  });
});

describe('every KernelEvent survives structuredClone', () => {
  /**
   * One of every variant of the union, including all four `stream` shapes.
   *
   * Typed as the BODY rather than the event: only `Kernel.#emit` may assign a
   * sequence number, and a test that could invent one would be asserting about
   * a shape the kernel never produces.
   */
  const samples: readonly KernelEventBody[] = [
    {
      kind: 'objects',
      requestId: 'r1',
      // Through the sanitiser, because that is the only way a PSObject becomes a
      // WireValue: the two types are deliberately not the same type.
      values: [sanitizePSValue(psObject({ Name: 'a', Size: 1 })), null, 'text'],
    },
    { kind: 'stdout', processId: 1, bytes: encoder.encode('out') },
    { kind: 'stderr', processId: 1, bytes: encoder.encode('err') },
    {
      kind: 'stream',
      processId: 1,
      which: 'error',
      payload: sanitizeErrorRecord(
        errorRecord('bad', 'Boom', 'Test-Command', 'InvalidData', { targetObject: 'x' }),
      ),
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
    {
      kind: 'exit',
      processId: 1,
      requestId: 'r1',
      exitCode: 0,
      succeeded: true,
      nativeExitCode: null,
      signalled: null,
    },
    { kind: 'rejected', requestId: 'r1', requestKind: 'resize', problems: ['columns must be an integer'] },
    { kind: 'cwd-changed', terminalId: 't1', cwd: '/home/thc1006/sub' },
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
      // Every well-formed request must also DECODE, or the decoder and the
      // type have drifted apart and one of them is lying.
      const decoded = decodeKernelRequest(request);
      assert.equal(decoded.ok, true, request.kind);
      if (decoded.ok) assert.deepEqual(decoded.value, request);
    }
  });
});

// ---------------------------------------------------------------------------
// decoding what arrives from outside
// ---------------------------------------------------------------------------

describe('decodeKernelRequest', () => {
  it('refuses anything that is not an object with a known kind', () => {
    for (const bad of [null, 42, 'exec', [], { kind: 7 }, { kind: 'evaluate' }]) {
      assert.equal(decodeKernelRequest(bad).ok, false, JSON.stringify(bad));
    }
  });

  it('collects every problem rather than throwing on the first', () => {
    // A UI that has to fix its message one field per round trip is a UI that
    // will stop checking.
    const decoded = decodeKernelRequest({ kind: 'exec', requestId: '', terminalId: 1, source: null });
    assert.equal(decoded.ok, false);
    if (!decoded.ok) {
      assert.equal(decoded.problems.length, 4);
      assert.deepEqual(decoded.problems, [
        'requestId must not be empty',
        'terminalId must be a string',
        'source must be a string',
        'background must be a boolean',
      ]);
    }
  });

  it('refuses a resize that is not a usable geometry', () => {
    const cases: readonly [string, unknown][] = [
      ['zero columns', { kind: 'resize', terminalId: 't', columns: 0, rows: 24 }],
      ['negative rows', { kind: 'resize', terminalId: 't', columns: 80, rows: -1 }],
      ['fractional', { kind: 'resize', terminalId: 't', columns: 80.5, rows: 24 }],
      ['NaN', { kind: 'resize', terminalId: 't', columns: Number.NaN, rows: 24 }],
      ['Infinity', { kind: 'resize', terminalId: 't', columns: 80, rows: Number.POSITIVE_INFINITY }],
      [
        'absurd',
        { kind: 'resize', terminalId: 't', columns: REQUEST_LIMITS.maxColumns + 1, rows: 24 },
      ],
    ];
    for (const [label, message] of cases) {
      assert.equal(decodeKernelRequest(message).ok, false, label);
    }
    assert.equal(
      decodeKernelRequest({ kind: 'resize', terminalId: 't', columns: 1, rows: 1 }).ok,
      true,
    );
  });

  it('refuses stdin that is not bytes, or is more bytes than one write may carry', () => {
    assert.equal(
      decodeKernelRequest({ kind: 'stdin', processId: 1, bytes: 'text', endOfFile: false }).ok,
      false,
    );
    // A duck-typed check would accept this and then enqueue it into a byte stream.
    assert.equal(
      decodeKernelRequest({ kind: 'stdin', processId: 1, bytes: { length: 3 }, endOfFile: false }).ok,
      false,
    );
    const oversized = {
      kind: 'stdin',
      processId: 1,
      bytes: new Uint8Array(REQUEST_LIMITS.maxStdinBytes + 1),
      endOfFile: false,
    };
    const decoded = decodeKernelRequest(oversized);
    assert.equal(decoded.ok, false);
    if (!decoded.ok) assert.match(decoded.problems[0] as string, /over the .* limit for one write/u);
  });

  it('refuses an unknown signal name but keeps the negative pid convention', () => {
    assert.equal(decodeKernelRequest({ kind: 'signal', processId: 1, signal: 'SIGHUP' }).ok, false);
    assert.equal(decodeKernelRequest({ kind: 'signal', processId: -3, signal: 'SIGINT' }).ok, true);
  });

  it('refuses an id or a source that is unboundedly long', () => {
    assert.equal(
      decodeKernelRequest({
        kind: 'cancel',
        requestId: 'x'.repeat(REQUEST_LIMITS.maxIdLength + 1),
      }).ok,
      false,
    );
    assert.equal(
      decodeKernelRequest({
        kind: 'exec',
        requestId: 'r',
        terminalId: 't',
        source: 'x'.repeat(REQUEST_LIMITS.maxSourceLength + 1),
        background: false,
      }).ok,
      false,
    );
  });

  it('drops fields the protocol does not define, rather than carrying them through', () => {
    const decoded = decodeKernelRequest({
      kind: 'cancel',
      requestId: 'r1',
      extra: () => undefined,
    });
    assert.equal(decoded.ok, true);
    if (decoded.ok) assert.deepEqual(decoded.value, { kind: 'cancel', requestId: 'r1' });
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
    // `peek`, not `receive`: the public job view has no destructive read, so
    // nothing holding a Kernel can empty the buffer before Receive-Job does.
    assert.deepEqual(kernel.jobs.peek(job?.id ?? 0).values, ['bg-finished']);
    // And peeking twice still returns it, which is the point of the rename.
    assert.deepEqual(kernel.jobs.peek(job?.id ?? 0).values, ['bg-finished']);
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
    //
    // It goes through a broker built here rather than through
    // `kernel.capabilities`, because `forCommand` is no longer on the kernel's
    // public view: the scoped object it returns writes audit records under a
    // caller-supplied manifest and pid, and only a real invocation should be
    // able to attribute a line to a command. The kernel's own wiring of this
    // path is covered by the two tests above, which read the denial off the
    // audit log and off the error event the terminal received.
    const broker = new CapabilityBroker({ grants: [] });
    const scoped = broker.forCommand(WRITER.manifest, 1);
    assert.throws(() => scoped.require('filesystem.write'), CapabilityDeniedError);
    // The same decision, reached through the read-only view the kernel does
    // expose — no audit record, no throw.
    const { kernel } = newKernel({ grants: [] });
    assert.equal(
      kernel.capabilities.evaluate(WRITER.manifest, 'filesystem.write'),
      'denied:not-granted',
    );
    assert.equal(kernel.audit.size, 0);
  });
});

describe('everything a real session emits is clone-safe', () => {
  it('round-trips every event of a session that uses every channel', async () => {
    const { kernel, events } = newKernel({ fs: movingPort(DEFAULT_HOME), cwd: DEFAULT_HOME });
    kernel.register(CHATTY);
    kernel.register(mover());

    kernel.send({
      kind: 'exec',
      requestId: 'r1',
      terminalId: 't1',
      source: 'chatty',
      background: false,
    });
    // A malformed message is part of what a real session emits, because a real
    // session is talking to a page. It must come back as an event like any
    // other, and must survive the boundary like any other.
    kernel.send({ kind: 'resize', terminalId: 't1', columns: 0, rows: 24 });
    // And so is moving the shell, which is the one event a terminal renders as
    // chrome rather than as output.
    kernel.send({ kind: 'exec', requestId: 'r2', terminalId: 't1', source: 'cd', background: false });
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

  it('carries an ErrorRecord that names a host object, by sanitising it', async () => {
    // This used to be a command FAILURE: targetObject is a PSValue, the error
    // stream was only clone-CHECKED rather than sanitised, and so an error that
    // named the object it was about took the command down with it. The record
    // now crosses with the host handle stripped, which is what the success
    // stream had always done.
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

    assert.equal(events.find((e) => e.kind === 'exit')?.exitCode, 0);
    const error = events.find((e) => e.kind === 'stream' && e.which === 'error');
    assert.ok(error?.kind === 'stream' && error.which === 'error');
    assert.deepEqual(cloneSafetyProblems(error), []);
    const target = error.payload.targetObject as { properties: Record<string, unknown> };
    assert.deepEqual(target.properties, { X: 1 });
    assert.equal(Object.hasOwn(target, 'baseObject'), false);
  });

  it('refuses to emit an event carrying a host object', async () => {
    // Validation is on by default, so the failure names the command that built
    // the value rather than surfacing as a DataCloneError at postMessage. Every
    // stream carrying a PSValue is now sanitised, so this is forced through one
    // that carries text — where a host object can only arrive through a cast,
    // which is exactly the case the check exists to catch.
    const { kernel, events } = newKernel();
    kernel.register(
      command({ name: 'leaky', display: 'leaky' }, async (context) => {
        await context.streams.warning.write(new WeakMap() as unknown as string);
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

// ---------------------------------------------------------------------------
// cross-stream ordering
// ---------------------------------------------------------------------------

describe('the sequence that makes interleaving reconstructable', () => {
  /** Writes to four different channels in a known order, several times over. */
  function interleaver(name: string, rounds: number): CommandModule {
    return command({ name, display: name }, async (context) => {
      for (let round = 0; round < rounds; round += 1) {
        await context.streams.success.write(`out-${round}`);
        await context.streams.error.write(errorRecord(`err-${round}`, 'E', name));
        await context.streams.warning.write(`warn-${round}`);
        const stdout = context.native?.stdout.getWriter();
        if (stdout !== undefined) {
          await stdout.write(encoder.encode(`bytes-${round}`));
          stdout.releaseLock();
        }
      }
      return 0;
    });
  }

  it('numbers every event, densely and strictly increasing', async () => {
    const { kernel, events } = newKernel();
    kernel.register(interleaver('noisy', 3));
    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: 'noisy', background: false });
    await kernel.drain();

    assert.ok(events.length > 10, 'the session has to be long enough to be worth ordering');
    assert.deepEqual(
      events.map((e) => e.seq),
      events.map((_unused, index) => index + 1),
      'dense from 1: a gap would mean an event was minted somewhere other than #emit',
    );
    assert.equal(kernel.sequence, events.length);
  });

  it('preserves the true interleaving of four independent channels', async () => {
    // This is the thing that could not be done before. Every event carried a
    // pid; none carried an order. Success travels keyed by requestId, error and
    // warning by pid, stdout as bytes — four channels arriving at one renderer
    // with no common ordinal can be printed in any order at all, so
    // `command 2>&1` and a transcript were both unreconstructable.
    const { kernel, events } = newKernel();
    kernel.register(interleaver('noisy', 3));
    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: 'noisy', background: false });
    await kernel.drain();

    const decoder = new TextDecoder();
    const transcript = [...events]
      .sort((a, b) => a.seq - b.seq)
      .flatMap((event) => {
        if (event.kind === 'objects') return event.values.map((v) => String(v));
        if (event.kind === 'stdout') return [decoder.decode(event.bytes)];
        if (event.kind === 'stream' && event.which === 'error') return [event.payload.message];
        if (event.kind === 'stream' && event.which === 'warning') return [event.payload];
        return [];
      });

    assert.deepEqual(transcript, [
      'out-0', 'err-0', 'warn-0', 'bytes-0',
      'out-1', 'err-1', 'warn-1', 'bytes-1',
      'out-2', 'err-2', 'warn-2', 'bytes-2',
    ]);
  });

  it('does not reset between requests, or between foreground and background', async () => {
    const { kernel, events } = newKernel();
    kernel.register(emitter('greet', ['a']));

    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: 'greet', background: false });
    await kernel.drain();
    const afterFirst = kernel.sequence;
    assert.ok(afterFirst > 0);

    kernel.send({ kind: 'exec', requestId: 'r2', terminalId: 't1', source: 'greet', background: true });
    await kernel.drain();
    kernel.send({ kind: 'exec', requestId: 'r3', terminalId: 't2', source: 'greet', background: false });
    await kernel.drain();

    const numbers = events.map((e) => e.seq);
    assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b));
    assert.equal(new Set(numbers).size, numbers.length, 'no number is used twice');
    assert.ok(kernel.sequence > afterFirst);
  });

  it('numbers a rejection too, so a bad message has its place in the transcript', () => {
    const { kernel, events } = newKernel();
    kernel.register(emitter('greet', ['a']));
    kernel.send({ kind: 'resize', terminalId: 't1', columns: -1, rows: 24 });
    assert.equal(events[0]?.seq, 1);
  });

  it('starts at 1, so 0 can mean "nothing yet"', () => {
    const { kernel, events } = newKernel();
    assert.equal(kernel.sequence, 0);
    kernel.send({ kind: 'resize', terminalId: 't1', columns: 0, rows: 0 });
    assert.equal(events[0]?.seq, 1);
  });
});

describe('requests the kernel will not act on', () => {
  it('answers a malformed request with a rejection instead of acting or ignoring', () => {
    const { kernel, events } = newKernel();
    kernel.register(emitter('greet', ['hello']));

    // Missing `background`, which decides whether Ctrl+C can reach the process.
    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: 'greet' });

    const rejected = events.find((e) => e.kind === 'rejected');
    assert.equal(rejected?.requestId, 'r1');
    assert.equal(rejected?.requestKind, 'exec');
    assert.deepEqual(rejected?.problems, ['background must be a boolean']);
    assert.equal(events.some((e) => e.kind === 'process-changed'), false, 'nothing ran');
  });

  it('reports a rejection with a null requestId when there is nothing to correlate', () => {
    const { kernel, events } = newKernel();
    kernel.send('not a request at all');
    const rejected = events.find((e) => e.kind === 'rejected');
    assert.equal(rejected?.requestId, null);
    assert.equal(rejected?.requestKind, null);
  });

  it('refuses a requestId that has already been submitted', async () => {
    // A correlation id that names two executions correlates nothing: the second
    // run's objects, errors and exit would all arrive labelled as the first's.
    const { kernel, events } = newKernel();
    kernel.register(emitter('greet', ['hello']));

    const request: KernelRequest = {
      kind: 'exec',
      requestId: 'r1',
      terminalId: 't1',
      source: 'greet',
      background: false,
    };
    kernel.send(request);
    kernel.send(request);
    await kernel.drain();

    const rejected = events.filter((e) => e.kind === 'rejected');
    assert.equal(rejected.length, 1);
    assert.match(rejected[0]?.problems[0] as string, /already been submitted/u);
    assert.equal(events.filter((e) => e.kind === 'exit').length, 1, 'only one execution happened');
  });

  it('still refuses a reused id after the first execution has exited', async () => {
    // Uniqueness has to hold against the whole transcript, not just against
    // what is currently running — otherwise a UI can reuse an id the moment a
    // command finishes and quietly relabel the previous run's transcript.
    const { kernel, events } = newKernel();
    kernel.register(emitter('greet', ['hello']));
    const request: KernelRequest = {
      kind: 'exec',
      requestId: 'r1',
      terminalId: 't1',
      source: 'greet',
      background: false,
    };
    kernel.send(request);
    await kernel.drain();
    kernel.send(request);
    await kernel.drain();

    assert.equal(events.filter((e) => e.kind === 'rejected').length, 1);
    assert.equal(events.filter((e) => e.kind === 'exit').length, 1);
  });

  it('does not resize a terminal from an invalid geometry', () => {
    const { kernel } = newKernel();
    kernel.send({ kind: 'resize', terminalId: 't1', columns: 120, rows: 40 });
    kernel.send({ kind: 'resize', terminalId: 't1', columns: 0, rows: Number.NaN });
    assert.deepEqual(kernel.terminalSize('t1'), { columns: 120, rows: 40 });
  });

  it('rejects an exec whose source contains no command, instead of going silent', async () => {
    // MEASURED before this: a whitespace-only source produced ZERO events and
    // left `sequence` at 0, while the requestId was already spent in the
    // kernel's submitted set. Nothing could be retried and nothing would ever
    // arrive, so a caller waiting for the request to finish waited forever.
    const { kernel, events } = newKernel();
    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: '   ', background: false });
    await kernel.drain();

    const rejected = events.filter((e) => e.kind === 'rejected');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]?.requestId, 'r1');
    assert.equal(rejected[0]?.requestKind, 'exec');
    assert.deepEqual(rejected[0]?.problems, ['source contains no command']);
    assert.equal(events.some((e) => e.kind === 'process-changed'), false, 'nothing ran');
  });

  it('rejects a source that is only a pipe, for the same reason', async () => {
    const { kernel, events } = newKernel();
    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: ' | ', background: false });
    await kernel.drain();
    assert.equal(events.filter((e) => e.kind === 'rejected').length, 1);
  });
});

describe('the shell moving, as an event rather than as prompt chrome', () => {
  /**
   * Roadmap 6.4. v1's `cd` sets a global and then repaints the prompt itself:
   *
   *     CWD = p; ... document.getElementById('prompt').textContent = shortCwd()
   *
   * A command that repaints the prompt cannot run in a Worker. Here the command
   * moves the FILESYSTEM and the kernel notices; the terminal owns the prompt.
   *
   * The port is a stub rather than the real VFS on purpose: what is being
   * pinned is the KERNEL's reconciliation, not `Set-Location`'s. The real
   * command, over a real filesystem, is exercised across a real Worker in
   * kernel-worker.test.mts.
   */
  it('emits cwd-changed, and emits it before the exit that ends the request', async () => {
    // MEASURED before this existed: the port moved to /home/thc1006/sub while
    // `kernel.cwd('t1')` still answered /home/thc1006, the NEXT process was
    // created with the stale directory in its snapshot and in $PWD, and no
    // event was emitted either way. Two sources of truth, disagreeing.
    const port = movingPort('/home/thc1006');
    const { kernel, events } = newKernel({ fs: port, cwd: '/home/thc1006' });
    kernel.register(mover());

    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: 'cd', background: false });
    await kernel.drain();

    const changed = events.filter((e) => e.kind === 'cwd-changed');
    assert.equal(changed.length, 1);
    assert.equal(changed[0]?.terminalId, 't1');
    assert.equal(changed[0]?.cwd, '/home/thc1006/sub');
    assert.equal(kernel.cwd('t1'), '/home/thc1006/sub');

    const exit = events.find((e) => e.kind === 'exit');
    assert.ok(
      (changed[0]?.seq ?? 0) < (exit?.seq ?? 0),
      'a prompt rendered on exit must already know where it is',
    );
  });

  it('gives the next process the new directory, in its snapshot and in $PWD', async () => {
    const port = movingPort('/home/thc1006');
    const { kernel, events } = newKernel({ fs: port, cwd: '/home/thc1006' });
    kernel.register(mover());
    let sawPwd: string | undefined;
    kernel.register(
      command({ name: 'pwd', display: 'pwd' }, async (context) => {
        sawPwd = context.env.get('PWD');
        return 0;
      }),
    );

    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: 'cd', background: false });
    await kernel.drain();
    kernel.send({ kind: 'exec', requestId: 'r2', terminalId: 't1', source: 'pwd', background: false });
    await kernel.drain();

    assert.equal(sawPwd, '/home/thc1006/sub');
    const second = events
      .filter((e) => e.kind === 'process-changed')
      .map((e) => e.snapshot)
      .find((s) => s.name === 'pwd');
    assert.equal(second?.cwd, '/home/thc1006/sub');
  });

  it('says nothing when the command did not move anything', async () => {
    const port = movingPort('/home/thc1006');
    const { kernel, events } = newKernel({ fs: port, cwd: '/home/thc1006' });
    kernel.register(emitter('greet', ['hello']));

    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: 'greet', background: false });
    await kernel.drain();

    assert.equal(events.some((e) => e.kind === 'cwd-changed'), false);
  });

  it('does not need a filesystem at all', async () => {
    // The kernel ships with `fs: null` in every test above this one; the poll
    // must be a no-op rather than a crash in `#drive`'s finally.
    const { kernel, events } = newKernel();
    kernel.register(emitter('greet', ['hello']));
    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: 'greet', background: false });
    await kernel.drain();
    assert.equal(events.some((e) => e.kind === 'cwd-changed'), false);
    assert.equal(events.filter((e) => e.kind === 'exit').length, 1);
  });

  it('still reports the exits when the port’s location getter throws', async () => {
    // `#syncLocation` runs inside `#drive`'s finally, so a throwing getter
    // would cost the pipeline every `exit` it was about to emit.
    const port = {
      get location(): never {
        throw new Error('the backend went away');
      },
      setLocation: async () => ({ ok: true as const, value: { full: '/x' } }),
    } as unknown as FileSystemPort;
    const { kernel, events } = newKernel({ fs: port });
    kernel.register(emitter('greet', ['hello']));

    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: 'greet', background: false });
    await kernel.drain();

    assert.equal(events.filter((e) => e.kind === 'exit').length, 1);
    assert.equal(events.some((e) => e.kind === 'cwd-changed'), false);
  });
});

describe('cancelling something that has not started yet', () => {
  /**
   * Counts INVOCATIONS, not exit codes, and that is the whole design of these
   * tests. A kernel that runs the command and then reports 130 passes any
   * assertion about the exit code while having already committed whatever side
   * effects the command performs — which is the thing a Ctrl+C before the
   * command starts is supposed to prevent.
   */
  function counter(name: string, calls: { n: number }): CommandModule {
    return command({ name, display: name }, async (context) => {
      calls.n += 1;
      context.signal.throwIfAborted();
      await context.streams.success.write('ran');
      return 0;
    });
  }

  it('does not invoke the command when the cancel arrived first', async () => {
    // MEASURED before the reordering: `invocations = 1`. The check used to run
    // AFTER `#track(#drive(...))`, and `#drive` is an async function — calling
    // it executes as far as its first await, which is far enough to enter the
    // first stage.
    const calls = { n: 0 };
    const { kernel, events } = newKernel();
    kernel.register(counter('work', calls));

    kernel.send({ kind: 'cancel', requestId: 'r1' });
    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: 'work', background: false });
    await kernel.drain();

    assert.equal(calls.n, 0, 'the command must not have run at all');
    assert.deepEqual(objectValues(events), []);
    const exit = events.find((e) => e.kind === 'exit');
    assert.equal(exit?.signalled, 'SIGINT');
    assert.equal(exit?.exitCode, SIGNAL_EXIT_CODE.SIGINT);
    assert.equal(exit?.succeeded, false);
  });

  it('honours a cancel sent from a process-changed listener', async () => {
    // The window this closes: `#exec` creates every snapshot before registering
    // any abort controller, so there is a moment when a process is in the table
    // — findable — and unreachable by a signal. The old code branched on
    // findability, so the cancel was neither remembered nor delivered.
    // MEASURED before the fix:
    //
    //   invocations = 1   exits = [{"code":0,"signalled":null}]
    //
    // A Ctrl+C that vanished, and a command that reported success.
    const calls = { n: 0 };
    const { kernel, events } = newKernel();
    kernel.register(counter('work', calls));

    let cancelled = false;
    kernel.on((event) => {
      if (event.kind !== 'process-changed' || cancelled) return;
      cancelled = true;
      kernel.send({ kind: 'cancel', requestId: 'r1' });
    });

    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: 'work', background: false });
    await kernel.drain();

    assert.equal(calls.n, 0, 'the command must not have run at all');
    assert.equal(events.find((e) => e.kind === 'exit')?.signalled, 'SIGINT');
  });

  it('still produces exactly one exit per stage of the abandoned pipeline', async () => {
    const calls = { n: 0 };
    const { kernel, events } = newKernel();
    kernel.register(counter('a', calls));
    kernel.register(counter('b', calls));

    kernel.send({ kind: 'cancel', requestId: 'r1' });
    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: 'a | b', background: false });
    await kernel.drain();

    assert.equal(calls.n, 0);
    const exits = events.filter((e) => e.kind === 'exit');
    assert.equal(exits.length, 2, 'one exit per process, cancelled or not');
    assert.deepEqual(exits.map((e) => e.signalled), ['SIGINT', 'SIGINT']);
  });

  it('does not leave the cancellation lying around for the next request', async () => {
    const calls = { n: 0 };
    const { kernel } = newKernel();
    kernel.register(counter('work', calls));

    kernel.send({ kind: 'cancel', requestId: 'r1' });
    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: 'work', background: false });
    await kernel.drain();
    assert.equal(calls.n, 0);

    kernel.send({ kind: 'exec', requestId: 'r2', terminalId: 't1', source: 'work', background: false });
    await kernel.drain();
    assert.equal(calls.n, 1, 'a different request must not inherit the cancellation');
  });
});

describe('the status a process exits with is readable when the exit arrives', () => {
  it('commits $? before publishing the exit that describes it', async () => {
    // MEASURED before the reorder: `lastSucceeded at exit = true`, `after drain
    // = false`. A listener reading the kernel on the event that says "this
    // finished" was shown the PREVIOUS request's answer. A sequence number
    // orders events; it cannot make an unwritten state readable.
    const { kernel } = newKernel();
    kernel.register(command({ name: 'fail', display: 'fail' }, async () => 3));

    let atExit: { succeeded: boolean } | null = null;
    kernel.on((event) => {
      if (event.kind === 'exit') atExit = { succeeded: kernel.lastSucceeded('t1') };
    });

    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: 'fail', background: false });
    await kernel.drain();

    assert.deepEqual(atExit, { succeeded: false });
    assert.equal(kernel.lastSucceeded('t1'), false);
  });

  it('is still right when the listener submits the next request on the spot', async () => {
    // The autopilot case: a listener that answers `exit` by sending the next
    // `exec`. The second request's own teardown must not be able to reach back
    // and overwrite the first's answer before the first listener has read it.
    const { kernel } = newKernel();
    kernel.register(command({ name: 'fail', display: 'fail' }, async () => 3));
    kernel.register(emitter('ok', ['done']));

    const observed: boolean[] = [];
    kernel.on((event) => {
      if (event.kind !== 'exit') return;
      observed.push(kernel.lastSucceeded('t1'));
      if (event.requestId === 'r1') {
        kernel.send({ kind: 'exec', requestId: 'r2', terminalId: 't1', source: 'ok', background: false });
      }
    });

    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: 'fail', background: false });
    await kernel.drain();

    assert.deepEqual(observed, [false, true], 'each exit saw its own request’s result');
  });

  it('does not let a background job rewrite the terminal it was started from', async () => {
    // MEASURED in pwsh 7.6.5 on this machine, via tools-free probe:
    //
    //   after Get-Date   : $? = True
    //   job state        : Failed
    //   after Wait-Job   : $? = True          <- the failure did NOT move it
    //   after native job exit 42 : $LASTEXITCODE = <unset>
    //
    // A job is isolated from the session that started it. Before this, a
    // background failure flipped the foreground terminal's `$?`.
    const { kernel } = newKernel();
    kernel.register(emitter('ok', ['done']));
    kernel.register(command({ name: 'bad', display: 'bad' }, async () => 1));

    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: 'ok', background: false });
    await kernel.drain();
    assert.equal(kernel.lastSucceeded('t1'), true);

    kernel.send({ kind: 'exec', requestId: 'r2', terminalId: 't1', source: 'bad', background: true });
    await kernel.drain();
    assert.equal(kernel.lastSucceeded('t1'), true, 'the job failed; the session did not');

    // And the job itself still reports what happened, which is where the
    // failure is supposed to be visible.
    assert.equal(kernel.jobs.list()[0]?.state, 'Failed');
  });

  it('does not let a background command-not-found rewrite it either', async () => {
    // Found by an adversarial pass on the fix above: `#teardown` stopped
    // recording status for a background pipeline, but the two paths that report
    // a request which never RAN — an unknown command, a binding failure — went
    // on doing it, and marked their process as foreground while they were at
    // it. MEASURED before this:
    //
    //     after BACKGROUND unknown: $? = false
    //     its snapshot says background = false
    const { kernel } = newKernel();
    kernel.register(emitter('ok', ['done']));

    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: 'ok', background: false });
    await kernel.drain();
    assert.equal(kernel.lastSucceeded('t1'), true);

    kernel.send({
      kind: 'exec',
      requestId: 'r2',
      terminalId: 't1',
      source: 'does-not-exist',
      background: true,
    });
    await kernel.drain();

    assert.equal(kernel.lastSucceeded('t1'), true, 'the job failed; the session did not');
    const snapshot = [...kernel.processes.list()].find((p) => p.requestId === 'r2');
    assert.equal(snapshot?.background, true, 'and it was a background process');
    // The failure has to be visible SOMEWHERE, and a job is where.
    assert.equal(kernel.jobs.list()[0]?.state, 'Failed');
  });

  it('does not let a background binding failure rewrite it either', async () => {
    const { kernel } = newKernel();
    kernel.register(emitter('ok', ['done']));
    kernel.register(
      command(
        {
          name: 'strict',
          display: 'strict',
          parameterSource: 'declared',
          parameters: [
            {
              name: 'Path',
              aliases: [],
              type: 'System.String',
              isSwitch: false,
              sets: {
                __AllParameterSets: { position: 0, mandatory: false, valueFromPipeline: false },
              },
              mandatoryInAnySet: false,
              mandatoryInEverySet: false,
              firstPosition: 0,
              valueFromPipelineInAnySet: false,
              validation: [],
              verified: false,
            },
          ],
        },
        async () => 0,
      ),
    );

    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: 'ok', background: false });
    await kernel.drain();

    kernel.send({
      kind: 'exec',
      requestId: 'r2',
      terminalId: 't1',
      source: 'strict -NoSuchParameter x',
      background: true,
    });
    await kernel.drain();

    assert.equal(kernel.lastSucceeded('t1'), true);
    assert.equal(kernel.jobs.list()[0]?.state, 'Failed');
  });
});

describe('a listener that throws', () => {
  /**
   * The transport's `postMessage` IS a listener, and `postMessage` throws
   * `DataCloneError`. Before this was contained, one throwing listener took the
   * kernel down with it. MEASURED against the shipped class:
   *
   *     send() threw: listener blew up
   *     listener A saw: [1]     listener B saw: []     final seq: 1
   *
   * — the second listener was never told about the event at all, and `#exec`
   * aborted between creating the process and starting it.
   */
  it('does not stop the other listeners, the queue, or the execution', async () => {
    const failures: unknown[] = [];
    const kernel = new Kernel({
      clock: () => 1_700_000_000_000,
      onListenerError: (error) => failures.push(error),
    });
    kernel.register(emitter('greet', ['hello']));

    const first: number[] = [];
    const second: number[] = [];
    kernel.on((event) => {
      first.push(event.seq);
      if (event.kind === 'process-changed') throw new Error('listener blew up');
    });
    kernel.on((event) => second.push(event.seq));

    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: 'greet', background: false });
    await kernel.drain();

    assert.deepEqual(second, first, 'the listener after the failing one saw every event');
    assert.ok(first.length >= 4, `the pipeline ran to completion, saw ${first.length} events`);
    assert.ok(failures.length > 0, 'and the failures were reported rather than swallowed');
    assert.equal((failures[0] as Error).message, 'listener blew up');
  });

  it('survives a reporter that throws as well', () => {
    const kernel = new Kernel({
      clock: () => 1_700_000_000_000,
      onListenerError: () => {
        throw new Error('the reporter is broken too');
      },
    });
    const seen: number[] = [];
    kernel.on(() => {
      throw new Error('listener blew up');
    });
    kernel.on((event) => seen.push(event.seq));

    // Doubly broken: the listener throws and so does the sink the throw is
    // reported to. Delivery still has to continue, or a bug in a log line ends
    // the session — the exact failure the containment exists to prevent.
    assert.doesNotThrow(() => {
      kernel.send({ kind: 'resize', terminalId: 't1', columns: 0, rows: 0 });
    });
    assert.deepEqual(seen, [1], 'the second listener still got the rejection');
  });
});
