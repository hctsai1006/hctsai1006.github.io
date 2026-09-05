/**
 * opfs-worker.test.mts — the `postMessage` boundary, driven over a fake pair of
 * ports.
 *
 * The boundary exists because of one line of IDL — `createSyncAccessHandle` is
 * `[Exposed=DedicatedWorker]` — and the risk it creates is that the two sides
 * drift: a method added to `StorageBackend` and not to the protocol is a
 * command that works in Node and fails in a browser, silently, in a thread
 * nothing can see into.
 *
 * Two things guard that, and only one of them is in this file. The other is a
 * COMPILE-TIME check in `opfs-worker.ts`: `Exhaustive` resolves to the name of
 * any callable member of `StorageBackend` missing from `STORAGE_OPS`, and
 * assigning `true` to it stops compiling. `npx tsc --noEmit` is that test.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MemoryStorage,
  STORAGE_OPS,
  WorkerStorageBackend,
  serveCoordinatorSharedWorker,
  serveStorageWorker,
  workerUnavailable,
} from '../../src/storage/index.ts';
import type { Result, StorageBackend, StorageErrorCode } from '../../src/storage/index.ts';

interface FakePort {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

/**
 * Two ports wired to each other, delivering asynchronously.
 *
 * `queueMicrotask` and not a direct call, because a synchronous delivery would
 * make every request resolve inside its own `postMessage` and hide exactly the
 * interleaving this boundary exists to survive — `types.ts` warns that in a
 * worker "every async handler runs concurrently by construction".
 */
function portPair(): [FakePort, FakePort] {
  const listeners: [((event: { data: unknown }) => void)[], ((event: { data: unknown }) => void)[]] = [
    [],
    [],
  ];
  const make = (self: 0 | 1, other: 0 | 1): FakePort => ({
    postMessage: (message: unknown): void => {
      // Structured clone, so anything that would not survive the real boundary
      // fails here too. A `StorageError` is plain data on purpose; an `Error`
      // subclass would lose its prototype and its own fields.
      const cloned = structuredClone(message);
      queueMicrotask(() => {
        for (const listener of listeners[other]) listener({ data: cloned });
      });
    },
    addEventListener: (_type: 'message', listener: (event: { data: unknown }) => void): void => {
      listeners[self].push(listener);
    },
  });
  return [make(0, 1), make(1, 0)];
}

function code(result: Result<unknown>): StorageErrorCode | 'ok' {
  return result.ok ? 'ok' : result.error.code;
}

function connected(): { client: WorkerStorageBackend; backend: MemoryStorage } {
  const [pageSide, workerSide] = portPair();
  const backend = new MemoryStorage({ clock: () => 1_700_000_000_000, user: 'me', group: 'me' });
  serveStorageWorker(workerSide, backend);
  return { client: new WorkerStorageBackend({ port: pageSide }), backend };
}

describe('the storage worker protocol', () => {
  it('names every callable member of StorageBackend', () => {
    // The runtime half of the guard. The compile-time half is in the module
    // itself; this one catches a name being MISSPELLED in the array, which the
    // type check would not — a typo makes `Missing` non-empty and would fail to
    // compile, but a typo plus a matching typo in the switch would not.
    const backend = new MemoryStorage({ clock: () => 0 });
    for (const op of STORAGE_OPS) {
      assert.equal(
        typeof (backend as unknown as Record<string, unknown>)[op],
        'function',
        `STORAGE_OPS names ${op}, which is not a method`,
      );
    }
    assert.equal(new Set(STORAGE_OPS).size, STORAGE_OPS.length, 'no duplicates');
  });

  it('round-trips a write and a read across the boundary', async () => {
    const { client } = connected();
    assert.equal(code(await client.mkdir('/home', { recursive: true })), 'ok');
    assert.equal(code(await client.writeText('/home/a.txt', 'across the wire')), 'ok');
    const back = await client.readText('/home/a.txt');
    assert.ok(back.ok);
    assert.equal(back.value, 'across the wire');
    assert.equal(client.inFlight, 0, 'every reply was matched to its request');
  });

  it('carries Uint8Array payloads intact in both directions', async () => {
    // `Uint8Array` is structured-cloneable; that is why `readBytes` can exist
    // across a worker at all. The high bytes are the interesting ones — a
    // payload that went through a string would come back mangled.
    const { client } = connected();
    const payload = new Uint8Array([0, 1, 127, 128, 200, 255]);
    assert.equal(code(await client.writeBytes('/bin', payload)), 'ok');
    const back = await client.readBytes('/bin');
    assert.ok(back.ok);
    assert.deepEqual(Array.from(back.value), [0, 1, 127, 128, 200, 255]);
  });

  it('carries a StorageError with its per-arm fields, not just a message', async () => {
    // The whole reason `StorageError` is a plain discriminated union rather than
    // an `Error` subclass. `types.ts`: "The extra fields per arm are not
    // decoration — each is something a caller has to have and would otherwise
    // re-derive with a second round trip."
    const { client } = connected();
    assert.equal(code(await client.mkdir('/d')), 'ok');
    assert.equal(code(await client.writeText('/d/f', 'x')), 'ok');

    const exists = await client.mkdir('/d/f');
    assert.ok(!exists.ok);
    assert.equal(exists.error.code, 'EEXIST');
    assert.equal(exists.error.code === 'EEXIST' ? exists.error.existing : null, 'file');

    const notEmpty = await client.remove('/d');
    assert.ok(!notEmpty.ok);
    assert.equal(notEmpty.error.code, 'ENOTEMPTY');
    assert.equal(notEmpty.error.code === 'ENOTEMPTY' ? notEmpty.error.entries : -1, 1);
  });

  it('returns a bare boolean for exists, not a Result', async () => {
    // `exists` is the one method whose return type is not a `Result`, and the
    // protocol has to carry that shape rather than normalising it.
    const { client } = connected();
    assert.equal(await client.exists('/nope'), false);
    assert.equal(code(await client.writeText('/yes', 'x')), 'ok');
    assert.equal(await client.exists('/yes'), true);
  });

  it('keeps replies matched when calls overlap', async () => {
    // Not serialised on purpose: the backend's own mutex orders the mutations,
    // and adding a queue here would give the boundary its own ordering rules.
    // What the boundary MUST get right is that reply 7 reaches caller 7.
    const { client } = connected();
    assert.equal(code(await client.mkdir('/many')), 'ok');
    const writes = [];
    for (let index = 0; index < 16; index += 1) {
      writes.push(client.writeText(`/many/f${String(index)}`, `body ${String(index)}`));
    }
    await Promise.all(writes);
    const reads = [];
    for (let index = 0; index < 16; index += 1) reads.push(client.readText(`/many/f${String(index)}`));
    const bodies = await Promise.all(reads);
    for (const [index, body] of bodies.entries()) {
      assert.ok(body.ok);
      assert.equal(body.value, `body ${String(index)}`, `reply ${String(index)} went to the wrong caller`);
    }
    assert.equal(client.inFlight, 0);
  });

  it('turns a genuine throw into a rejection rather than hanging', async () => {
    // A throw means a bug — every EXPECTED failure is a `Result` — but a
    // boundary that drops it leaves the caller's promise pending forever, which
    // is the worst possible way for a bug to present.
    const [pageSide, workerSide] = portPair();
    const exploding = {
      name: 'exploding',
      readOnly: false,
      readText: (): never => {
        throw new Error('the disk caught fire');
      },
    } as unknown as StorageBackend;
    serveStorageWorker(workerSide, exploding);
    const client = new WorkerStorageBackend({ port: pageSide });
    await assert.rejects(() => client.readText('/anything'), /the disk caught fire/);
    assert.equal(client.inFlight, 0, 'a rejected call is not left in the map');
  });

  it('installImage and reset cross too, because a durable backend needs them', async () => {
    const { client, backend } = connected();
    assert.equal(
      code(
        await client.installImage({
          time: 1_600_000_000_000,
          entries: [
            { path: '/', kind: 'directory', mode: 0o755 },
            { path: '/etc', kind: 'directory', mode: 0o755, owner: 'root', group: 'root' },
            { path: '/etc/os-release', kind: 'file', content: 'ID=browsershell', owner: 'root' },
          ],
        }),
      ),
      'ok',
    );
    const seeded = await client.readText('/etc/os-release');
    assert.ok(seeded.ok);
    assert.equal(seeded.value, 'ID=browsershell');
    assert.equal(code(await client.reset()), 'ok');
    assert.equal(await backend.exists('/etc/os-release'), false);
  });

  it('workerUnavailable gives a caller something to render', () => {
    const failure = workerUnavailable('SecurityError: not a secure context');
    assert.equal(code(failure), 'EIO');
    assert.ok(!failure.ok && failure.error.message.includes('not a secure context'));
  });
});

describe('the coordination hub', () => {
  it('repeats a message to the other ports and not back to the sender', async () => {
    // A repeater and nothing else. It holds no storage state and never touches
    // OPFS — it cannot, since `createSyncAccessHandle` is not exposed in a
    // SharedWorker, which the roadmap calls out as a constraint "worth stating
    // as a hard constraint so nobody 'simplifies' it later".
    const [aOuter, aInner] = portPair();
    const [bOuter, bInner] = portPair();

    const connects: ((event: { ports: readonly FakePort[] }) => void)[] = [];
    serveCoordinatorSharedWorker({
      addEventListener: (_type, listener) => {
        connects.push(listener);
      },
    });
    for (const listener of connects) listener({ ports: [aInner] });
    for (const listener of connects) listener({ ports: [bInner] });

    const seenByA: unknown[] = [];
    const seenByB: unknown[] = [];
    aOuter.addEventListener('message', (event) => seenByA.push(event.data));
    bOuter.addEventListener('message', (event) => seenByB.push(event.data));

    aOuter.postMessage({ kind: 'checkpoint', generation: 4 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(seenByB, [{ kind: 'checkpoint', generation: 4 }]);
    assert.deepEqual(seenByA, [], 'a sender does not hear its own announcement');
  });
});
