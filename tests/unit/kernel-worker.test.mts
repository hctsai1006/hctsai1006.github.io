/**
 * kernel-worker.test.mts — the boundary, crossed for real.
 *
 * Everything the protocol claims about `postMessage` was, until this file,
 * asserted against `structuredClone` in ONE realm. That is the same algorithm
 * and it is genuinely useful — it catches a `DataCloneError` before a browser
 * does — but it is not a transport. The report from the work that built the
 * wire said so in as many words:
 *
 *     Could not verify: a real Worker. No postMessage in this environment; the
 *     boundary is exercised with Node's structuredClone (same algorithm) —
 *     real, but not a real transport.
 *
 * That limit no longer holds. `node:worker_threads` gives a genuine
 * `postMessage` with true structured clone semantics, and a genuine second JS
 * realm, in an ordinary test with no browser. So every property below is
 * asserted with a REAL WORKER THREAD between the two halves: the kernel and
 * every command run in `tests/unit/kernel-worker-fixture.mts`, this file holds
 * only a `KernelClient`, and nothing but messages passes between them.
 *
 * WHAT REMAINS UNPROVEN HERE, stated so nobody reads more into it: this is not
 * a BROWSER. `node:worker_threads` implements the same message contract, and
 * the browser adapter is type-checked against the real DOM types below, but
 * `Worker`, `DedicatedWorkerGlobalScope` and `MessagePort` themselves are not
 * exercised, and neither is a browser's own `DataCloneError`. Running this
 * suite in a browser is the only thing that would close that, and this
 * repository has no browser gate.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// Aliased so the DOM's own `Worker` stays reachable: the browser adapter is
// type-checked against it at the bottom of this file, and an unaliased import
// here would shadow exactly the type that proof needs.
import { Worker as WorkerThread } from 'node:worker_threads';

import { KernelClient } from '../../src/kernel/client.ts';
import type { ExecOutcome, ProtocolViolation } from '../../src/kernel/client.ts';
import type { KernelEvent } from '../../src/kernel/protocol.ts';
import { REQUEST_LIMITS } from '../../src/kernel/protocol.ts';
import { eventEmitterTransport, eventTargetTransport } from '../../src/kernel/transport.ts';
import type {
  KernelTransport,
  MessageEmitterLike,
  MessageEventTargetLike,
  TransportMessageListener,
} from '../../src/kernel/transport.ts';
import { serveKernel } from '../../src/kernel/serve.ts';
import { Kernel } from '../../src/kernel/kernel.ts';
import type { CommandModule } from '../../src/commands/invocation.ts';
import {
  SCRIPT_BLOCK_TYPE,
  asScriptBlock,
  scriptBlockHandleOf,
  scriptBlocks,
} from '../../src/commands/powershell/support.ts';
import { whereObject } from '../../src/commands/powershell/where-object.ts';
import { collectingStreams } from '../../src/pipeline/streams.ts';
import type { PSObject, PSValue } from '../../src/pipeline/psobject.ts';
import { HOME } from '../../src/storage/seed.ts';

const FIXTURE = new URL('./kernel-worker-fixture.mts', import.meta.url);

interface Harness {
  readonly client: KernelClient;
  readonly events: KernelEvent[];
  readonly violations: ProtocolViolation[];
  readonly workerErrors: Error[];
  dispose(): Promise<void>;
}

/**
 * Start a real worker thread and a client that can only talk to it.
 *
 * `worker` is handed to `eventEmitterTransport` through the structural type in
 * `transport.ts` and never touched again: nothing below reaches into the
 * worker, because there is nothing to reach with.
 */
async function spawn(workerData: Record<string, unknown> = {}): Promise<Harness> {
  const worker = new WorkerThread(FIXTURE, { workerData });
  const workerErrors: Error[] = [];
  worker.on('error', (error: Error) => workerErrors.push(error));

  const violations: ProtocolViolation[] = [];
  const events: KernelEvent[] = [];
  const client = new KernelClient(
    eventEmitterTransport(worker as unknown as MessageEmitterLike),
    { terminalId: 't1', onViolation: (violation) => violations.push(violation) },
  );
  client.on((event) => events.push(event));

  return {
    client,
    events,
    violations,
    workerErrors,
    dispose: async () => {
      client.close();
      await worker.terminate();
    },
  };
}

/** The first success value of a completed request, as a PSObject. */
function object(outcome: ExecOutcome): PSObject {
  const value = outcome.values[0];
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  return value as PSObject;
}

// ---------------------------------------------------------------------------
// the boundary is real
// ---------------------------------------------------------------------------

describe('a real worker thread is a real second realm', () => {
  it('runs commands somewhere this test cannot reach', async () => {
    const h = await spawn();
    try {
      const outcome = await h.client.run('emit-realm');
      assert.equal(outcome.exitCode, 0);
      const there = outcome.values[0];
      assert.equal(typeof there, 'string');
      // The realm id is minted per script-block registry, and a registry is
      // module state — one per realm. Two different ids is the evidence that
      // the module was instantiated twice, in two isolated globals.
      assert.notEqual(there, scriptBlocks.realm);
    } finally {
      await h.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// the graph properties that only ever held in one realm
// ---------------------------------------------------------------------------

describe('object identity survives a real postMessage', () => {
  it('preserves a cycle', async () => {
    // The sanitiser is a memoised graph copy for exactly this: an earlier
    // version recursed with no visited set and blew the stack on
    // `c.properties.self = c`. That it TERMINATES was testable in one realm;
    // that the cycle is still a cycle after the transport was not.
    const h = await spawn();
    try {
      const root = object(await h.client.run('emit-tangled'));
      assert.equal(root.properties['Self'], root, 'the self-reference is the same object');
      assert.equal(root.properties['Name'], 'root');
    } finally {
      await h.dispose();
    }
  });

  it('keeps a shared subgraph shared', async () => {
    // Two properties pointing at one object must still point at one object.
    // This held by ACCIDENT before the sanitiser was rewritten — an unchanged
    // value was returned by reference — so it stopped holding the moment
    // anything in the graph needed stripping.
    const h = await spawn();
    try {
      const root = object(await h.client.run('emit-tangled'));
      const left = root.properties['Left'];
      const right = root.properties['Right'];
      assert.equal(left, right, 'one object, reached two ways');
      assert.equal((left as PSObject).properties['Tag'], 'shared');
    } finally {
      await h.dispose();
    }
  });

  it('carries an own __proto__ property without re-parenting the bag', async () => {
    // `Select-Object -Property __proto__` builds a bag with a null prototype so
    // the key cannot become the prototype. structuredClone NORMALISES a null
    // prototype back to Object.prototype, so the guarantee has to survive as an
    // OWN PROPERTY rather than as a prototype — which is a claim about the
    // transport and could not be checked without one.
    const h = await spawn();
    try {
      const bag = object(await h.client.run('emit-proto-bag')).properties;
      assert.equal(Object.hasOwn(bag, '__proto__'), true, 'it is an own property');
      assert.equal(
        Object.getPrototypeOf(bag),
        Object.prototype,
        'and it did not become the prototype',
      );
      const descriptor = Object.getOwnPropertyDescriptor(bag, '__proto__');
      assert.equal(descriptor?.value, 'not a prototype');
      assert.equal(descriptor?.enumerable, true);
      assert.deepEqual(Object.keys(bag).sort(), ['Name', '__proto__']);
    } finally {
      await h.dispose();
    }
  });

  it('leaves no host value behind in baseObject', async () => {
    // `PSObject.baseObject` holds a File handle, a Response, a closure. The
    // sanitiser DROPS it rather than rejecting it, and until now nothing could
    // show that `postMessage` was never asked to carry one — a function reaching
    // the transport is a DataCloneError, which would surface as a worker error.
    const h = await spawn();
    try {
      const held = object(await h.client.run('emit-host-value'));
      assert.equal(Object.hasOwn(held, 'baseObject'), false);
      assert.equal(held.properties['Name'], 'holder');
      assert.deepEqual(h.workerErrors, [], 'nothing threw on the way out');
    } finally {
      await h.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// the script block, which is the one that mattered
// ---------------------------------------------------------------------------

describe('a script block crosses as a handle and not as a closure', () => {
  it('arrives as data, with the closure left in the worker', async () => {
    const h = await spawn();
    try {
      const block = object(await h.client.run('emit-script-block'));
      assert.equal(block.typeNames[0], SCRIPT_BLOCK_TYPE, 'it is still a script block');

      const handle = scriptBlockHandleOf(block);
      assert.notEqual(handle, undefined, 'and it still carries a handle');
      assert.equal(
        asScriptBlock(block),
        undefined,
        'whose closure is NOT in this realm, because closures do not cross',
      );
      // The realm prefix is what stops a handle resolving to somebody else's
      // block: two registries both counting from 1 would hand out the same id.
      assert.notEqual(handle?.id.split(':')[0], scriptBlocks.realm);
    } finally {
      await h.dispose();
    }
  });

  it('makes Where-Object FAIL rather than pass every object through', async () => {
    // This is the defect the whole handle design exists to prevent, now
    // reproduced with a real boundary instead of two registries in one realm.
    // An unresolvable handle used to leave `filter` undefined, and
    // Where-Object's no-filter branch keeps everything: a filter that silently
    // stops filtering.
    const h = await spawn();
    try {
      const block = object(await h.client.run('emit-script-block'));

      const streams = collectingStreams();
      const code = await whereObject.invoke(
        {
          profile: {
            displayVersion: '7.6.5',
            behavior: (_key, fallback) => fallback,
            scopedBehavior: (_key, whenUndeclared) => whenUndeclared,
          },
          streams,
          native: null,
          input: (async function* () {
            yield 1;
            yield 2;
            yield 3;
          })(),
          cwd: '/',
          env: new Map(),
          signal: new AbortController().signal,
          requireCapability: () => undefined,
          fs: null,
          providers: null,
          preferences: null,
          dialog: null,
        },
        { parameters: { FilterScript: block as PSValue }, parameterSet: '__AllParameterSets', remaining: [] },
      );

      assert.notEqual(code, 0, 'it failed');
      assert.deepEqual(streams.collected.success.values, [], 'and passed nothing through');
      assert.match(
        streams.collected.error.values[0]?.fullyQualifiedErrorId as string,
        /^ScriptBlockNotInThisRuntime,Where-Object$/u,
      );
    } finally {
      await h.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// ordering, through the transport
// ---------------------------------------------------------------------------

describe('the cross-stream sequence stays monotonic through the transport', () => {
  it('arrives strictly increasing and gap-free across four channels', async () => {
    const h = await spawn();
    try {
      await h.client.run('emit-interleaved');

      const seqs = h.events.map((event) => event.seq);
      assert.ok(seqs.length > 15, `saw ${seqs.length} events across success, warning and verbose`);
      for (let i = 1; i < seqs.length; i += 1) {
        assert.equal(seqs[i], (seqs[i - 1] as number) + 1, `seq ${String(seqs[i])} follows`);
      }
      assert.equal(h.client.lastSequence, seqs[seqs.length - 1]);
      // More than one kind of event, or the ordering claim is about one stream
      // ordering against itself, which was never in doubt.
      assert.ok(new Set(h.events.map((e) => e.kind)).size >= 3);
      assert.deepEqual(h.violations, []);
    } finally {
      await h.dispose();
    }
  });

  it('refuses an ordinal it has already seen instead of rendering it twice', async () => {
    // A worker that posts each event twice. The copies are well-formed — only
    // the ordinal gives them away, which is the whole reason the ordinal is
    // there.
    const h = await spawn({ misbehave: 'replay' });
    try {
      const outcome = await h.client.run('ping-back');
      assert.deepEqual(outcome.values, ['pong'], 'exactly once, not twice');

      const seqs = h.events.map((event) => event.seq);
      assert.deepEqual([...new Set(seqs)], seqs, 'no ordinal was delivered twice');
      assert.ok(h.violations.length > 0);
      assert.ok(
        h.violations.every((violation) => violation.dropped),
        'a replay is dropped, not merely reported',
      );
      assert.match(h.violations[0]?.problems[0] as string, /replay or a duplicate/u);
    } finally {
      await h.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// cancel and signal
// ---------------------------------------------------------------------------

/** Resolve when a predicate is satisfied by an event, or reject on timeout. */
function waitFor(
  client: KernelClient,
  predicate: (event: KernelEvent) => boolean,
): Promise<KernelEvent> {
  return new Promise<KernelEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('timed out waiting for an event from the worker'));
    }, 10_000);
    const unsubscribe = client.on((event) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
  });
}

describe('cancel and signal interrupt work that is running in the worker', () => {
  it('stops a command that has already started', async () => {
    const h = await spawn();
    try {
      const started = waitFor(
        h.client,
        (event) => event.kind === 'objects' && event.values[0] === 'started',
      );
      const pending = h.client.run('spin');
      const requestId = (await started as { requestId?: string }).requestId as string;

      h.client.cancel(requestId);
      const outcome = await pending;

      assert.equal(outcome.signalled, 'SIGINT');
      assert.equal(outcome.exitCode, 130);
      assert.equal(outcome.succeeded, false);
      assert.deepEqual(outcome.values, ['started'], 'it never reached its own finish line');
    } finally {
      await h.dispose();
    }
  });

  it('delivers a signal addressed to a process id', async () => {
    const h = await spawn();
    try {
      const running = waitFor(
        h.client,
        (event) => event.kind === 'process-changed' && event.snapshot.state === 'running',
      );
      const pending = h.client.run('spin');
      const event = await running;
      const pid = (event as { snapshot: { pid: number } }).snapshot.pid;

      h.client.signal(pid, 'SIGTERM');
      const outcome = await pending;

      assert.equal(outcome.signalled, 'SIGTERM');
      assert.equal(outcome.values.includes('finished-without-being-stopped'), false);
    } finally {
      await h.dispose();
    }
  });

  it('never starts a command whose cancel arrived first', async () => {
    // The messages arrive in the order they were posted, so the worker sees the
    // cancel before the exec. What must NOT happen is the command running and
    // then being reported as stopped: `spin` writes 'started' as its first act,
    // so an empty success stream is the evidence that `invoke` was never called.
    const h = await spawn();
    try {
      h.client.cancel('never-runs');
      const outcome = await h.client.run('spin', { requestId: 'never-runs' });

      assert.deepEqual(outcome.values, [], 'the command was never invoked');
      assert.equal(outcome.signalled, 'SIGINT');
      assert.equal(outcome.exitCode, 130);
    } finally {
      await h.dispose();
    }
  });

  it('leaves the worker able to run the next command', async () => {
    const h = await spawn();
    try {
      const started = waitFor(
        h.client,
        (event) => event.kind === 'objects' && event.values[0] === 'started',
      );
      const pending = h.client.run('spin');
      h.client.cancel((await started as { requestId?: string }).requestId as string);
      await pending;

      const after = await h.client.run('ping-back');
      assert.deepEqual(after.values, ['pong']);
      assert.deepEqual(h.workerErrors, []);
    } finally {
      await h.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// what the far side refuses
// ---------------------------------------------------------------------------

describe('a message the kernel will not act on is rejected, not thrown past', () => {
  it('rejects a malformed request and keeps running', async () => {
    const h = await spawn();
    try {
      const rejected = waitFor(h.client, (event) => event.kind === 'rejected');
      // Missing `background`, which decides whether Ctrl+C can reach the
      // process. Sent raw, because a typed API cannot express it.
      h.client.postRaw({
        kind: 'exec',
        requestId: 'malformed',
        terminalId: 't1',
        source: 'ping-back',
      });
      const event = (await rejected) as { requestId: string; problems: readonly string[] };

      assert.equal(event.requestId, 'malformed');
      assert.deepEqual(event.problems, ['background must be a boolean']);

      const after = await h.client.run('ping-back');
      assert.deepEqual(after.values, ['pong'], 'the worker survived it');
      assert.deepEqual(h.workerErrors, []);
    } finally {
      await h.dispose();
    }
  });

  it('rejects a source over the transport limit rather than allocating for it', async () => {
    const h = await spawn();
    try {
      const rejected = waitFor(h.client, (event) => event.kind === 'rejected');
      h.client.postRaw({
        kind: 'exec',
        requestId: 'huge',
        terminalId: 't1',
        source: 'x'.repeat(REQUEST_LIMITS.maxSourceLength + 1),
        background: false,
      });
      const event = (await rejected) as { problems: readonly string[] };
      assert.match(event.problems[0] as string, /source is longer than/u);

      const after = await h.client.run('ping-back');
      assert.deepEqual(after.values, ['pong']);
    } finally {
      await h.dispose();
    }
  });

  it('rejects an oversized stdin write', async () => {
    const h = await spawn();
    try {
      const rejected = waitFor(h.client, (event) => event.kind === 'rejected');
      h.client.postRaw({
        kind: 'stdin',
        processId: 1,
        bytes: new Uint8Array(REQUEST_LIMITS.maxStdinBytes + 1),
        endOfFile: false,
      });
      const event = (await rejected) as { problems: readonly string[] };
      assert.match(event.problems[0] as string, /over the .* limit for one write/u);
    } finally {
      await h.dispose();
    }
  });

  it('rejects an event-shaped wrapper, which is what a wrong adapter would send', async () => {
    // The failure mode of choosing the DOM adapter where the EventEmitter one
    // belongs: the kernel is handed a `MessageEvent` instead of the message.
    // Both sides are `unknown`, so no type check catches it — the decoder does,
    // and this is the assertion that says so.
    const h = await spawn();
    try {
      const rejected = waitFor(h.client, (event) => event.kind === 'rejected');
      h.client.postRaw({
        data: { kind: 'exec', requestId: 'wrapped', terminalId: 't1', source: 'ping-back', background: false },
      });
      const event = (await rejected) as { requestId: string | null; problems: readonly string[] };
      assert.equal(event.requestId, null);
      assert.deepEqual(event.problems, ['kind must be a string']);
    } finally {
      await h.dispose();
    }
  });

  it('refuses a requestId that has already been submitted', async () => {
    const h = await spawn();
    try {
      const first = await h.client.run('ping-back', { requestId: 'once' });
      assert.deepEqual(first.values, ['pong']);

      const second = await h.client.run('ping-back', { requestId: 'once' });
      assert.notEqual(second.rejected, null);
      assert.match(second.rejected?.[0] as string, /already been submitted/u);
      assert.deepEqual(second.values, [], 'nothing ran a second time');
      assert.equal(second.succeeded, false);
    } finally {
      await h.dispose();
    }
  });

  it('refuses a second run on an id that is still in flight, without sending it', async () => {
    const h = await spawn();
    try {
      const pending = h.client.run('spin', { requestId: 'inflight' });
      assert.throws(
        () => h.client.exec('ping-back', { requestId: 'inflight' }),
        /already has a request in flight/u,
      );
      h.client.cancel('inflight');
      await pending;
    } finally {
      await h.dispose();
    }
  });
});

describe('a message the client will not act on is recorded, not thrown past', () => {
  it('records what a misbehaving worker sent and keeps working', async () => {
    const h = await spawn({ misbehave: 'garbage' });
    try {
      const outcome = await h.client.run('ping-back');
      assert.deepEqual(outcome.values, ['pong'], 'the session survived');

      assert.equal(h.violations.length, 4);
      const problems = h.violations.flatMap((violation) => violation.problems);
      assert.match(problems.join('\n'), /kind must be one of/u);
      assert.match(problems.join('\n'), /an event must be an object/u);
      assert.match(problems.join('\n'), /seq must be an integer of at least 1/u);
      assert.ok(
        h.violations.every((violation) => violation.dropped),
        'nothing undecodable reached a listener',
      );
      assert.ok(
        h.events.every((event) => typeof event.seq === 'number'),
        'and every event that DID reach one was a real event',
      );
    } finally {
      await h.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// the byte channels, in both directions
// ---------------------------------------------------------------------------

describe('bytes stay bytes across the transport', () => {
  it('carries stdout and stderr as Uint8Array, unchanged', async () => {
    // Since PowerShell 7.4 the raw bytes between a native command and a file
    // are preserved rather than decoded and re-encoded. A UTF-16 round trip
    // through the boundary is the one thing that would undo that, and the
    // payload here is deliberately not valid UTF-8.
    const h = await spawn();
    try {
      await h.client.run('emit-bytes');
      const out = h.events.find((event) => event.kind === 'stdout');
      const err = h.events.find((event) => event.kind === 'stderr');

      assert.ok(out?.bytes instanceof Uint8Array, 'still a Uint8Array in this realm');
      assert.deepEqual([...(out?.bytes ?? [])], [0, 159, 146, 150, 255]);
      assert.deepEqual([...(err?.bytes ?? [])], [1, 2, 3]);
    } finally {
      await h.dispose();
    }
  });

  it('carries stdin the other way', async () => {
    const h = await spawn();
    try {
      const running = waitFor(
        h.client,
        (event) => event.kind === 'process-changed' && event.snapshot.state === 'running',
      );
      const pending = h.client.run('read-stdin');
      const pid = ((await running) as { snapshot: { pid: number } }).snapshot.pid;

      h.client.stdin(pid, new TextEncoder().encode('fed from the host'), true);
      const outcome = await pending;

      assert.deepEqual(outcome.values, ['fed from the host']);
    } finally {
      await h.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// the shell's location, as an event
// ---------------------------------------------------------------------------

describe('the terminal learns where it is from an event, not from prompt chrome', () => {
  it('reports a cd across the boundary and resolves the next relative path with it', async () => {
    // Roadmap 6.4, end to end. v1's `cd` reached into the page and rewrote the
    // prompt; a command in a Worker cannot, and does not need to.
    const h = await spawn({ withFilesystem: true });
    try {
      assert.equal(h.client.cwd('t1'), null, 'nothing has been said yet');

      const moved = await h.client.run('Set-Location sub');
      assert.equal(moved.exitCode, 0);
      assert.equal(h.client.cwd('t1'), `${HOME}/sub`);

      const changed = h.events.filter((event) => event.kind === 'cwd-changed');
      assert.equal(changed.length, 1);
      assert.equal(changed[0]?.terminalId, 't1');

      const read = await h.client.run('Get-Content note.txt');
      assert.deepEqual(read.values, ['read across the boundary']);
    } finally {
      await h.dispose();
    }
  });

  it('gives a second terminal its own location over the same files', async () => {
    const h = await spawn({ withFilesystem: true });
    try {
      await h.client.run('Set-Location sub');
      const elsewhere = await h.client.run(`Get-Content ${HOME}/sub/note.txt`, {
        terminalId: 't2',
      });
      assert.deepEqual(elsewhere.values, ['read across the boundary'], 'same files');

      const relative = await h.client.run('Get-Content note.txt', { terminalId: 't2' });
      assert.equal(relative.errors.length, 1, 'and its own location');
      assert.equal(h.client.cwd('t2'), null, 't2 was never told it moved');
    } finally {
      await h.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// a streaming command is an ordinary command (roadmap 6.3)
// ---------------------------------------------------------------------------

describe('a streaming command needs no special case', () => {
  it('arrives as many events rather than one blob, and composes in a pipeline', async () => {
    // v1 could not do this at all. `ping` returned null and printed itself
    // through an `asyncOut` global, so index.html REFUSED to put it in a
    // pipeline rather than model it:
    //
    //     這個指令是逐行串流輸出,不能用在管線中。
    //
    // Here it is a command that writes more than once, and the boundary carries
    // each write as its own event.
    const h = await spawn({ withRegistry: true });
    try {
      const before = h.events.length;
      const streamed = await h.client.run('ping example.com');
      assert.equal(streamed.exitCode, 0);
      const batches = h.events
        .slice(before)
        .filter((event) => event.kind === 'objects').length;
      assert.ok(batches > 1, `arrived in ${batches} separate events`);
      assert.ok(streamed.values.length > 1);

      // And the same command, as the left side of a pipeline.
      const piped = await h.client.run('ping example.com | Measure-Object');
      assert.equal(piped.exitCode, 0);
      assert.equal(piped.values.length, 1, 'one summary object out of a streaming source');
    } finally {
      await h.dispose();
    }
  });
});

describe('the boundary refuses a value it would have to empty', () => {
  it('errors on a Format-* record instead of delivering a blank one', async () => {
    // Found by the pipeline work, confirmed here across a real transport.
    // `src/formatting/records.ts` puts the whole FormatDocument in
    // `baseObject` — correct modelling, because pwsh's own format records
    // carry no readable properties either — and `baseObject` is exactly what
    // the wire drops. MEASURED before the refusal:
    //
    //   after wire: {"typeNames":["…Format.FormatEntryData","System.Object"],
    //                "properties":{}}
    //   still typed as a format record = true
    //
    // A renderer on this side would identify it and draw nothing, and no error
    // would be raised anywhere.
    const h = await spawn({ withRegistry: true });
    try {
      const outcome = await h.client.run('Write-Output hello | Format-Table');

      assert.deepEqual(outcome.values, [], 'nothing empty was delivered');
      assert.equal(outcome.errors.length, 1);
      const error = outcome.errors[0];
      assert.match(error?.fullyQualifiedErrorId as string, /^PipelineFailed,Format-Table$/u);
      assert.match(error?.message as string, /FormatEntryData/u);
      assert.match(error?.message as string, /baseObject, which the boundary drops/u);

      // And the pipeline says it failed. `??=` used to leave the stage's own
      // success in place — the stage DID succeed, the kernel could not carry
      // what it produced — so an error record went past under exit 0.
      assert.equal(outcome.exitCode, 1);
      assert.equal(outcome.succeeded, false);
    } finally {
      await h.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// the shape the transport must not decide: ordering under reentrancy
// ---------------------------------------------------------------------------

/**
 * Two transports wired directly to each other, IN ONE REALM.
 *
 * The hostile case for ordering, and the reason both `Kernel.#emit` and
 * `KernelClient` keep a queue. Across a real worker a reply always arrives on a
 * later task, so a naive dispatcher looks correct; here `post` reaches the far
 * side synchronously, so a listener that answers an event by sending a request
 * re-enters the dispatcher in the middle of its own delivery.
 */
function directPair(): { host: KernelTransport; worker: KernelTransport } {
  const toHost = new Set<TransportMessageListener>();
  const toWorker = new Set<TransportMessageListener>();
  const make = (mine: Set<TransportMessageListener>, theirs: Set<TransportMessageListener>) => ({
    post: (message: unknown) => {
      for (const listener of [...theirs]) listener(message);
    },
    listen: (listener: TransportMessageListener) => {
      mine.add(listener);
      return () => {
        mine.delete(listener);
      };
    },
    close: () => mine.clear(),
  });
  return { host: make(toHost, toWorker), worker: make(toWorker, toHost) };
}

function emitter(name: string, values: readonly PSValue[]): CommandModule {
  return {
    manifest: {
      name,
      display: name,
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
    },
    invoke: async (context) => {
      for (const value of values) await context.streams.success.write(value);
      return 0;
    },
  };
}

describe('a same-realm transport cannot reorder the stream either', () => {
  it('delivers in sequence order when a listener answers by sending a request', async () => {
    const { host, worker } = directPair();
    const kernel = new Kernel({ clock: () => 1 });
    kernel.register(emitter('one', ['a']));
    kernel.register(emitter('two', ['b']));
    serveKernel(kernel, worker);

    const client = new KernelClient(host, { terminalId: 't1' });
    const seen: number[] = [];
    let answered = false;
    client.on((event) => {
      seen.push(event.seq);
      if (event.kind !== 'objects' || answered) return;
      answered = true;
      // Re-enters the client's own dispatcher, synchronously, because `post`
      // reaches the kernel in this realm. Measured in the kernel before it had
      // a queue: delivery order of seq 1,2,4,3,5,6.
      client.exec('two', { requestId: 'second' });
    });

    client.exec('one', { requestId: 'first' });
    await kernel.drain();

    assert.ok(seen.length >= 8, `saw ${seen.length} events`);
    assert.deepEqual([...seen].sort((a, b) => a - b), seen, 'strictly in order');
    assert.deepEqual([...new Set(seen)], seen, 'and each exactly once');
    client.close();
  });

  it('settles a request whose whole life happened inside the send', async () => {
    // FOUND BY AN ADVERSARIAL PASS ON THIS CLIENT, and measured:
    //
    //     run() over a same-realm transport: settled
    //     run() of an unknown command:       hung
    //     run() of an empty line:            hung
    //
    // `run` used to send first and register its bookkeeping second, which works
    // only while the reply cannot arrive during the send. Across a real Worker
    // it cannot. Here `post` reaches the kernel synchronously, and a request the
    // kernel REFUSES — an unknown command, an empty line — emits every event it
    // will ever emit inside that call, before anything was listening. The
    // promise then never settled: a hang produced by a transport being faster
    // than expected, not by anything being wrong with the request.
    const { host, worker } = directPair();
    const kernel = new Kernel({ clock: () => 1 });
    kernel.register(emitter('one', ['a']));
    serveKernel(kernel, worker);
    const client = new KernelClient(host, { terminalId: 't1' });

    const ran = await client.run('one');
    assert.deepEqual(ran.values, ['a']);
    assert.equal(ran.exitCode, 0);

    const missing = await client.run('does-not-exist');
    assert.equal(missing.exitCode, 127, 'command not found still ends the request');
    assert.equal(missing.errors.length, 1);

    const empty = await client.run('   ');
    assert.deepEqual(empty.rejected, ['source contains no command']);
    assert.equal(empty.exitCode, null);

    client.close();
  });

  it('refuses a second run on an id in flight without disturbing the first', async () => {
    const { host, worker } = directPair();
    const kernel = new Kernel({ clock: () => 1 });
    kernel.register(emitter('one', ['a']));
    serveKernel(kernel, worker);
    const client = new KernelClient(host, { terminalId: 't1' });

    const pending = client.run('one', { requestId: 'shared' });
    assert.throws(
      () => client.run('one', { requestId: 'shared' }),
      /already has a request in flight/u,
    );
    // The refused call must not have consumed the entry the first one is
    // waiting on — the guard and the registration are the same id.
    assert.deepEqual((await pending).values, ['a']);
    client.close();
  });
});

describe('a post that fails does not stop the kernel', () => {
  it('is reported against the event it could not send, and leaves a visible gap', async () => {
    // `postMessage` throws `DataCloneError` on a value the algorithm refuses,
    // and a browser adds Worker states of its own. Before `Kernel.#emit`
    // contained a listener's failure, one such throw stopped execution
    // entirely: measured, `listener B saw: []` and `final seq: 1`, with the
    // process left in `created` forever. The transport's post IS a listener.
    const kernel = new Kernel({ clock: () => 1 });
    kernel.register(emitter('one', ['a', 'b', 'c']));

    const sent: unknown[] = [];
    const failures: { seq: number }[] = [];
    let refuseNext = false;
    const worker: KernelTransport = {
      post: (message) => {
        if (refuseNext) {
          refuseNext = false;
          throw new Error('DataCloneError: could not be cloned');
        }
        sent.push(message);
      },
      listen: () => () => undefined,
      close: () => undefined,
    };
    serveKernel(kernel, worker, {
      onPostFailure: (_error, event) => failures.push({ seq: event.seq }),
    });

    kernel.on((event) => {
      // Refuse exactly one event, in the middle of the stream.
      if (event.kind === 'objects' && event.values[0] === 'b') refuseNext = true;
    });

    kernel.send({ kind: 'exec', requestId: 'r1', terminalId: 't1', source: 'one', background: false });
    await kernel.drain();

    assert.equal(failures.length, 1, 'the failure was attributed to one event');
    assert.ok(sent.length > 5, `the rest of the session still went out (${sent.length} messages)`);
    // The kernel's own numbering is unbroken; what is missing is one message.
    // That is what makes the loss detectable on the far side rather than
    // silent, and it is the only thing that can make it detectable.
    const seqs = sent.map((message) => (message as { seq: number }).seq);
    assert.equal(seqs.includes(failures[0]?.seq as number), false, 'the refused event never arrived');
    assert.deepEqual([...seqs].sort((a, b) => a - b), seqs);
  });

  it('shows up on the receiving side as a reported gap', async () => {
    const { host, worker } = directPair();
    const kernel = new Kernel({ clock: () => 1 });
    kernel.register(emitter('one', ['a']));

    let dropNext = false;
    const lossy: KernelTransport = {
      post: (message) => {
        if (dropNext) {
          dropNext = false;
          throw new Error('DataCloneError: could not be cloned');
        }
        worker.post(message);
      },
      listen: (listener) => worker.listen(listener),
      close: () => worker.close(),
    };
    serveKernel(kernel, lossy, { onPostFailure: () => undefined });

    const violations: ProtocolViolation[] = [];
    const client = new KernelClient(host, { terminalId: 't1', onViolation: (v) => violations.push(v) });
    client.on((event) => {
      if (event.kind === 'process-changed' && event.snapshot.state === 'running') dropNext = true;
    });

    client.exec('one', { requestId: 'r1' });
    await kernel.drain();

    assert.equal(violations.length, 1);
    assert.match(violations[0]?.problems[0] as string, /seq jumped from \d+ to \d+/u);
    assert.equal(violations[0]?.dropped, false, 'a gap is reported, and what did arrive is kept');
    client.close();
  });
});

describe('a closed transport', () => {
  it('drops what it is asked to send instead of throwing during teardown', () => {
    const posted: unknown[] = [];
    const port: MessageEventTargetLike = {
      postMessage: (message) => {
        posted.push(message);
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    const transport = eventTargetTransport(port);
    transport.post('before');
    transport.close();
    // Shutdown races with events already in flight, and a real MessagePort
    // throws once closed — so the alternative is that closing a pane produces a
    // burst of errors about messages nobody was going to read.
    assert.doesNotThrow(() => transport.post('after'));
    assert.deepEqual(posted, ['before']);
    // And a late subscriber gets a working unsubscribe rather than a listener
    // that can never fire.
    assert.doesNotThrow(() => transport.listen(() => undefined)());
    assert.doesNotThrow(() => transport.close(), 'closing twice is not an error');
  });
});

// ---------------------------------------------------------------------------
// what a browser would use, checked as far as a type checker can check it
// ---------------------------------------------------------------------------

describe('the browser adapter accepts the real browser types', () => {
  it('type-checks against Worker, MessagePort and a dedicated worker scope', () => {
    // COMPILE-TIME ONLY, and that is the honest limit. `tsc` runs over this
    // file with lib DOM and WebWorker, so these assignments prove the
    // structural type in transport.ts describes the real APIs — a browser
    // `Worker` on the host side, a `MessagePort` for the SharedWorker case, and
    // a `DedicatedWorkerGlobalScope` inside the worker. What it does NOT prove
    // is that a browser's postMessage behaves as node:worker_threads' does.
    // Nothing short of running this in a browser would.
    function browserPortsAreTransports(
      worker: Worker,
      port: MessagePort,
      scope: DedicatedWorkerGlobalScope,
    ): readonly KernelTransport[] {
      return [
        eventTargetTransport(worker),
        eventTargetTransport(port),
        eventTargetTransport(scope),
      ];
    }
    void browserPortsAreTransports;

    // And one runtime check, on a stand-in with the same shape, so the adapter
    // itself is exercised rather than only its signature.
    const listeners = new Set<(event: { data: unknown }) => void>();
    let started = false;
    const fake: MessageEventTargetLike = {
      postMessage: (message) => {
        for (const listener of [...listeners]) listener({ data: message });
      },
      addEventListener: (_type, listener) => {
        listeners.add(listener);
      },
      removeEventListener: (_type, listener) => {
        listeners.delete(listener);
      },
      start: () => {
        started = true;
      },
    };
    const transport = eventTargetTransport(fake);
    const received: unknown[] = [];
    const off = transport.listen((message) => received.push(message));
    assert.equal(started, true, 'a MessagePort delivers nothing until start()');
    transport.post({ hello: 'world' });
    assert.deepEqual(received, [{ hello: 'world' }], 'and the event was unwrapped to its data');
    off();
    transport.post({ ignored: true });
    assert.equal(received.length, 1);
    transport.close();
  });
});
