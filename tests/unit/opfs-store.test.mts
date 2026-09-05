/**
 * opfs-store.test.mts — the durable store, driven through a fake OPFS.
 *
 * The fake is `opfs-fake.mts` and it models DURABILITY: a file has live bytes
 * and flushed bytes, and `crash()` throws the difference away and invalidates
 * every open handle. Without that, a write-ahead log looks correct no matter
 * where the flushes are — including nowhere — which is the one thing a test of
 * a WAL has to be able to catch.
 *
 * WHAT THIS FILE CANNOT PROVE. That flushed bytes actually survive a browser
 * dying. Nothing here has killed a browser. See `MODELLED_BEHAVIOURS` in the
 * fake for the four behaviours that are this project's own model rather than
 * something a probe observed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FakeOpfs, storePath } from './opfs-fake.mts';
import {
  MemoryStorage,
  OpfsStore,
  STORE_DIRECTORY,
  STORE_FILES,
  STORE_VERSION,
  decodePlan,
  decodeSlot,
  decodeSnapshot,
  encodeSlot,
  migrateDown,
  migrateUp,
  mountOpfsStorage,
  orderMigrations,
  parseWal,
  readFollowerView,
  WorkerStorageBackend,
  exportSnapshot,
  importSnapshot,
  requestLeadership,
  serveStorageWorker,
  walHeader,
  walRecord,
} from '../../src/storage/index.ts';
import type {
  LockManagerLike,
  Migration,
  MountReport,
  Result,
  SeedSpec,
  StorageErrorCode,
} from '../../src/storage/index.ts';

const DIRECTORY = 'browsershell';
const TEXT = new TextEncoder();

function clock(start = 1_700_000_000_000): () => number {
  let value = start;
  return () => {
    value += 1;
    return value;
  };
}

/** A seed small enough to read in an assertion. `/home/me` is where writes go. */
const SEED: SeedSpec = {
  time: 1_600_000_000_000,
  entries: [
    { path: '/', kind: 'directory', mode: 0o755 },
    { path: '/home', kind: 'directory', mode: 0o755 },
    { path: '/home/me', kind: 'directory', mode: 0o755, owner: 'me', group: 'me' },
    { path: '/home/me/README.md', kind: 'file', content: 'seeded', owner: 'me', group: 'me' },
  ],
};

function value<T>(result: Result<T>): T {
  assert.ok(result.ok, `expected ok, got ${result.ok ? '' : result.error.message}`);
  return result.value;
}

function code(result: Result<unknown>): StorageErrorCode | 'ok' {
  return result.ok ? 'ok' : result.error.code;
}

/**
 * The store a LEADER mount holds. Asserts it is there rather than using `!`.
 *
 * `MountReport.store` is null for a follower, and the type says so on purpose:
 * a follower holds no handles and has nothing to close or checkpoint. Every
 * mount in this file except the follower block is a leader, so this narrows
 * once and fails loudly if that ever stops being true.
 */
function leaderStore(report: MountReport): OpfsStore {
  assert.ok(report.store !== null, 'expected a leader mount, got a follower');
  return report.store;
}

/**
 * Two ports wired to each other, delivering asynchronously through a structured
 * clone — the same shape as `opfs-worker.test.mts`, because a boundary that is
 * only tested with a direct call is not a boundary.
 */
function portPair(): [
  { postMessage(m: unknown): void; addEventListener(t: 'message', l: (e: { data: unknown }) => void): void },
  { postMessage(m: unknown): void; addEventListener(t: 'message', l: (e: { data: unknown }) => void): void },
] {
  const listeners: [((event: { data: unknown }) => void)[], ((event: { data: unknown }) => void)[]] = [[], []];
  const make = (
    self: 0 | 1,
    other: 0 | 1,
  ): {
    postMessage(m: unknown): void;
    addEventListener(t: 'message', l: (e: { data: unknown }) => void): void;
  } => ({
    postMessage: (message: unknown): void => {
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

async function mount(
  fake: FakeOpfs,
  overrides: Partial<Parameters<typeof mountOpfsStorage>[0]> = {},
): Promise<MountReport> {
  return value(
    await mountOpfsStorage({
      root: fake.root,
      clock: clock(),
      seed: SEED,
      user: 'me',
      manager: fake,
      ...overrides,
    }),
  );
}

// ---------------------------------------------------------------------------
// the round trip everything else is a variation of
// ---------------------------------------------------------------------------

describe('OpfsStore: durability across a remount', () => {
  it('a first mount finds nothing and installs only the seed', async () => {
    const fake = new FakeOpfs();
    const mounted = await mount(fake);
    assert.equal(mounted.recovery.slot, null, 'no checkpoint existed');
    assert.equal(mounted.recovery.overlay, null);
    assert.deepEqual(mounted.recovery.replay, []);
    assert.equal(value(await mounted.backend.readText('/home/me/README.md')), 'seeded');
    // The mount ends with a checkpoint, so generation 1 is on disk before a
    // single command has run. That is what makes the next mount's recovery path
    // the ordinary one rather than a special case.
    assert.equal(leaderStore(mounted).generation, 1);
    mounted.store?.close();
  });

  it('a write survives a clean close and a remount', async () => {
    const fake = new FakeOpfs();
    const first = await mount(fake);
    assert.ok((await first.backend.writeText('/home/me/notes.txt', 'kept')).ok);
    assert.ok((await first.backend.checkpoint()).ok);
    first.store?.close();

    const second = await mount(fake);
    assert.equal(value(await second.backend.readText('/home/me/notes.txt')), 'kept');
    assert.equal(second.recovery.slot !== null, true);
    second.store?.close();
  });

  it('an edit to a SEEDED file survives, which is the defect three verbs shared', async () => {
    // `memory.ts` records this as measured and fixed for `writeText`, `copy` and
    // `Set-Content`: a user's rewrite of a seed file was thrown away on reload
    // because the node kept `origin: 'seed'` and the overlay records a seed
    // node's metadata but not its content. Durable storage is where that defect
    // becomes permanent rather than per-session, so it is pinned here too.
    const fake = new FakeOpfs();
    const first = await mount(fake);
    assert.ok((await first.backend.writeText('/home/me/README.md', 'mine now')).ok);
    assert.ok((await first.backend.checkpoint()).ok);
    first.store?.close();

    const second = await mount(fake);
    assert.equal(value(await second.backend.readText('/home/me/README.md')), 'mine now');
    second.store?.close();
  });

  it('the seed is rebuilt from code, not restored from the checkpoint', async () => {
    // The seed/overlay split, which PR-09 task 9.2 says to keep. A site update
    // has to reach a returning visitor, so an untouched seed file must come
    // from THIS build's seed and not from what was checkpointed last year.
    const fake = new FakeOpfs();
    const first = await mount(fake);
    assert.ok((await first.backend.writeText('/home/me/mine.txt', 'user data')).ok);
    assert.ok((await first.backend.checkpoint()).ok);
    first.store?.close();

    const updated: SeedSpec = {
      ...SEED,
      entries: SEED.entries.map((entry) =>
        entry.path === '/home/me/README.md' ? { ...entry, content: 'version two' } : entry,
      ),
    };
    const second = await mount(fake, { seed: updated });
    assert.equal(value(await second.backend.readText('/home/me/README.md')), 'version two');
    assert.equal(value(await second.backend.readText('/home/me/mine.txt')), 'user data');
    second.store?.close();
  });
});

// ---------------------------------------------------------------------------
// crash recovery
// ---------------------------------------------------------------------------

describe('OpfsStore: what a crash keeps and what it drops', () => {
  it('keeps every operation but the last, and says which', async () => {
    // THE CORE CONTRACT of one-flush-per-mutation. `write` flushes the plan;
    // `commit` appends the marker WITHOUT flushing and lets the next mutation's
    // flush carry it. So a crash keeps everything whose commit marker got
    // carried and drops the one in flight.
    //
    // Two flushes per mutation would keep B as well, at 0.75 ms of measured
    // cost on every write. See `OpfsJournal`.
    const fake = new FakeOpfs();
    const first = await mount(fake);
    assert.ok((await first.backend.writeText('/home/me/a.txt', 'A')).ok);
    assert.ok((await first.backend.writeText('/home/me/b.txt', 'B')).ok);
    fake.crash();

    const second = await mount(fake);
    assert.equal(value(await second.backend.readText('/home/me/a.txt')), 'A');
    assert.equal(await second.backend.exists('/home/me/b.txt'), false, 'B was in flight');
    assert.equal(second.recovery.replay.length, 1, 'exactly one committed plan replayed');
    second.store?.close();
  });

  it('sync() before the crash keeps the last one too', async () => {
    // What a `pagehide` handler buys, stated as a difference rather than a
    // claim: the same sequence, one `sync()` added, one more file survives.
    const fake = new FakeOpfs();
    const first = await mount(fake);
    assert.ok((await first.backend.writeText('/home/me/a.txt', 'A')).ok);
    assert.ok((await first.backend.writeText('/home/me/b.txt', 'B')).ok);
    assert.ok(first.backend.sync().ok);
    fake.crash();

    const second = await mount(fake);
    assert.equal(value(await second.backend.readText('/home/me/b.txt')), 'B');
    second.store?.close();
  });

  it('a checkpoint before the crash keeps everything with no replay at all', async () => {
    const fake = new FakeOpfs();
    const first = await mount(fake);
    assert.ok((await first.backend.writeText('/home/me/a.txt', 'A')).ok);
    assert.ok((await first.backend.checkpoint()).ok);
    fake.crash();

    const second = await mount(fake);
    assert.equal(value(await second.backend.readText('/home/me/a.txt')), 'A');
    assert.deepEqual(second.recovery.replay, [], 'the log was reset by the checkpoint');
    second.store?.close();
  });

  it('a torn record at the tail is dropped, and the truncation is reported', async () => {
    // MODELLED, not measured: `crash()` here truncates at a flush boundary, so
    // a HALF record needs to be made by hand. `parseWal` stops at the first
    // record whose length or checksum does not verify, and a real crash can
    // certainly leave one.
    const fake = new FakeOpfs();
    const first = await mount(fake);
    assert.ok((await first.backend.writeText('/home/me/a.txt', 'A')).ok);
    assert.ok((await first.backend.writeText('/home/me/b.txt', 'B')).ok);
    assert.ok(first.backend.sync().ok);
    const whole = fake.durableBytes(storePath(DIRECTORY, STORE_FILES.wal));
    fake.crash();
    fake.truncateTo(storePath(DIRECTORY, STORE_FILES.wal), whole.byteLength - 4);

    const second = await mount(fake);
    assert.ok(second.recovery.truncatedBytes > 0, 'the tear is reported, not hidden');
    assert.equal(value(await second.backend.readText('/home/me/a.txt')), 'A');
    second.store?.close();
  });

  it('a stale log from an older generation is discarded whole', async () => {
    // The window between "checkpoint slot flushed" and "log reset". Everything
    // in that log is already inside the new checkpoint, and the steps are
    // absolute — a `remove` replayed against an already-removed path fails —
    // so replaying it would report a corrupt store for a store that is fine.
    const fake = new FakeOpfs();
    const first = await mount(fake);
    assert.ok((await first.backend.writeText('/home/me/a.txt', 'A')).ok);
    assert.ok((await first.backend.checkpoint()).ok);
    const generation = leaderStore(first).generation;
    first.store?.close();

    // A log stamped one generation behind, carrying a plan that would remove a
    // file that no longer exists if it were replayed.
    const stale = new Uint8Array([
      ...walHeader(generation - 1),
      ...walRecord(
        1,
        TEXT.encode(
          JSON.stringify({
            id: 'stale-1',
            syscall: 'remove',
            steps: [{ op: 'remove', path: '/home/me/a.txt' }],
            byteDelta: -1,
          }),
        ),
      ),
      ...walRecord(2, TEXT.encode(JSON.stringify({ id: 'stale-1' }))),
    ]);
    fake.setDurableBytes(storePath(DIRECTORY, STORE_FILES.wal), stale);

    const second = await mount(fake);
    assert.deepEqual(second.recovery.replay, [], 'a log from another generation counts for nothing');
    assert.equal(value(await second.backend.readText('/home/me/a.txt')), 'A');
    second.store?.close();
  });

  it('falls back to the other slot when the newer one is corrupt', async () => {
    // Why there are two. Writing a checkpoint over the only copy loses
    // everything if the tab dies halfway, and OPFS has no atomic rename to dodge
    // that with — `FileSystemHandle.move()` is a Chromium extension, not in the
    // standard.
    const fake = new FakeOpfs();
    const first = await mount(fake);
    assert.ok((await first.backend.writeText('/home/me/a.txt', 'first')).ok);
    assert.ok((await first.backend.checkpoint()).ok);
    assert.ok((await first.backend.writeText('/home/me/a.txt', 'second')).ok);
    assert.ok((await first.backend.checkpoint()).ok);
    const active = leaderStore(first).activeSlot;
    first.store?.close();

    const path = storePath(DIRECTORY, active === 'a' ? STORE_FILES.slotA : STORE_FILES.slotB);
    const damaged = fake.durableBytes(path);
    damaged[SLOT_PAYLOAD_START] = (damaged[SLOT_PAYLOAD_START] ?? 0) ^ 0xff;
    fake.setDurableBytes(path, damaged);

    const second = await mount(fake);
    assert.deepEqual(second.recovery.damaged, [active], 'the damage is named');
    assert.equal(
      value(await second.backend.readText('/home/me/a.txt')),
      'first',
      'the older checkpoint is still a checkpoint',
    );
    second.store?.close();
  });

  it('reports a store whose slots are both unreadable rather than pretending', async () => {
    const fake = new FakeOpfs();
    const first = await mount(fake);
    assert.ok((await first.backend.writeText('/home/me/a.txt', 'gone')).ok);
    assert.ok((await first.backend.checkpoint()).ok);
    first.store?.close();

    for (const file of [STORE_FILES.slotA, STORE_FILES.slotB]) {
      fake.setDurableBytes(storePath(DIRECTORY, file), TEXT.encode('not a checkpoint at all'));
    }

    const second = await mount(fake);
    assert.deepEqual([...second.recovery.damaged].sort(), ['a', 'b']);
    assert.equal(second.recovery.overlay, null);
    assert.equal(await second.backend.exists('/home/me/a.txt'), false);
    // The seed still comes back, because the seed is code.
    assert.equal(value(await second.backend.readText('/home/me/README.md')), 'seeded');
    second.store?.close();
  });
});

/** Offset of the first payload byte in a slot. See `SLOT_HEADER_BYTES`. */
const SLOT_PAYLOAD_START = 28;

// ---------------------------------------------------------------------------
// framing
// ---------------------------------------------------------------------------

describe('OpfsStore: framing', () => {
  it('a slot round-trips and a flipped payload bit fails its checksum', async () => {
    const contents = { storeVersion: 3, generation: 7, payload: TEXT.encode('{"a":1}') };
    const encoded = encodeSlot(contents);
    const back = decodeSlot(encoded);
    assert.ok(back !== null);
    assert.equal(back.storeVersion, 3);
    assert.equal(back.generation, 7);
    assert.deepEqual(Array.from(back.payload), Array.from(contents.payload));

    const flipped = Uint8Array.from(encoded);
    flipped[SLOT_PAYLOAD_START] = (flipped[SLOT_PAYLOAD_START] ?? 0) ^ 0x01;
    assert.equal(decodeSlot(flipped), null, 'one bit is enough');
  });

  it('a log refuses a wrong magic and reports a torn tail as a byte count', () => {
    assert.equal(code(parseWal(TEXT.encode('not a log'))), 'EINVAL');

    const good = walRecord(1, TEXT.encode('{}'));
    const log = new Uint8Array([...walHeader(4), ...good, ...good.subarray(0, 5)]);
    const parsed = value(parseWal(log));
    assert.equal(parsed.generation, 4);
    assert.equal(parsed.records.length, 1, 'the whole record survives');
    assert.equal(parsed.truncatedBytes, 5, 'the half one is counted, not parsed');
  });

  it('refuses a record whose declared length is absurd, without allocating it', () => {
    // The length field comes out of a file a user can edit. Without the ceiling
    // this asks for a 4 GB allocation before the checksum has had a chance to
    // say the record is nonsense.
    const header = walHeader(1);
    const record = new Uint8Array(12);
    new DataView(record.buffer).setUint8(0, 1);
    new DataView(record.buffer).setUint32(4, 0xffffffff, true);
    const parsed = value(parseWal(new Uint8Array([...header, ...record])));
    assert.deepEqual(parsed.records, []);
    assert.equal(parsed.truncatedBytes, 12);
  });
});

// ---------------------------------------------------------------------------
// migrations
// ---------------------------------------------------------------------------

/** A migration that appends and removes a marker byte. Reversible on purpose. */
function marker(from: number, byte: number): Migration {
  return {
    from,
    to: from + 1,
    describe: `add marker ${String(byte)}`,
    up: (payload) => ({ ok: true, value: new Uint8Array([...payload, byte]) }),
    down: (payload) =>
      payload[payload.length - 1] === byte
        ? { ok: true, value: payload.slice(0, -1) }
        : {
            ok: false,
            error: {
              code: 'EINVAL',
              path: '<store>',
              syscall: 'restore',
              message: 'marker missing',
              reason: 'not-mine',
            },
          },
  };
}

describe('migrations', () => {
  it('walks up the ladder and reports each step', () => {
    const report = value(migrateUp(new Uint8Array([1]), 1, 3, [marker(1, 2), marker(2, 3)]));
    assert.deepEqual(Array.from(report.payload), [1, 2, 3]);
    assert.deepEqual(report.applied, ['add marker 2', 'add marker 3']);
  });

  it('rolls a successful migration back', () => {
    // PR-09's acceptance criterion, in one line: "A migration can be rolled
    // back."
    const up = value(migrateUp(new Uint8Array([1]), 1, 3, [marker(1, 2), marker(2, 3)]));
    const down = value(migrateDown(up.payload, 3, 1, [marker(1, 2), marker(2, 3)]));
    assert.deepEqual(Array.from(down.payload), [1]);
    assert.deepEqual(down.applied, ['add marker 3', 'add marker 2']);
  });

  it('a failing step leaves the caller holding the original bytes', () => {
    // Guarantee (1): a migration is a pure function and nothing is written
    // until the whole chain succeeds, so there is no half-migrated state to
    // repair and no window in which a crash creates one.
    const explode: Migration = {
      from: 1,
      to: 2,
      describe: 'always fails',
      up: () => ({
        ok: false,
        error: { code: 'EIO', path: '<store>', syscall: 'restore', message: 'nope', cause: 'test' },
      }),
      down: (payload) => ({ ok: true, value: payload }),
    };
    const original = new Uint8Array([9, 9]);
    const attempt = migrateUp(original, 1, 2, [explode]);
    assert.equal(code(attempt), 'EIO');
    assert.ok(!attempt.ok && attempt.error.message.includes('always fails'), 'the step is named');
    assert.deepEqual(Array.from(original), [9, 9]);
  });

  it('refuses a store written by a NEWER build instead of downgrading it', () => {
    // The rule `decodeSnapshot` already applies on the document axis, for the
    // same reason: an older reader must decline a newer file rather than
    // silently reinterpreting it. Running this build's `down` steps over a
    // format it has never seen would be inventing an inverse for a step that
    // does not exist here.
    const attempt = migrateUp(new Uint8Array([1]), 5, 1, [marker(1, 2)]);
    assert.equal(code(attempt), 'EINVAL');
    assert.ok(!attempt.ok && attempt.error.message.includes('Open the newer version'));
  });

  it('refuses a gap in the ladder rather than skipping it', () => {
    const attempt = migrateUp(new Uint8Array([1]), 1, 3, [marker(1, 2)]);
    assert.equal(code(attempt), 'EINVAL');
    assert.ok(!attempt.ok && attempt.error.message.includes('no migration from store version 2'));
  });

  it('refuses a chain that is not a simple ladder', () => {
    // A 1 -> 3 shortcut alongside 1 -> 2 and 2 -> 3 makes the result depend on
    // iteration order, and the two paths are not required to agree.
    const shortcut: Migration = { ...marker(1, 2), to: 3 };
    assert.equal(code(orderMigrations([shortcut])), 'EINVAL');
    assert.equal(code(orderMigrations([marker(1, 2), marker(1, 5)])), 'EINVAL');
  });

  it('migrates a real store forward on mount and keeps the user data', async () => {
    // End to end: write at store version N, then mount with a build that reads
    // N+1 and a migration between them.
    const fake = new FakeOpfs();
    const first = await mount(fake);
    assert.ok((await first.backend.writeText('/home/me/keep.txt', 'survives')).ok);
    assert.ok((await first.backend.checkpoint()).ok);
    const active = leaderStore(first).activeSlot;
    first.store?.close();

    // Restamp the slot as if an older build had written it.
    const path = storePath(DIRECTORY, active === 'a' ? STORE_FILES.slotA : STORE_FILES.slotB);
    const current = decodeSlot(fake.durableBytes(path));
    assert.ok(current !== null);
    fake.setDurableBytes(
      path,
      encodeSlot({ ...current, storeVersion: STORE_VERSION - 1 }),
    );

    let sawOldPayload = false;
    const bridge: Migration = {
      from: STORE_VERSION - 1,
      to: STORE_VERSION,
      describe: 'test bridge',
      up: (payload) => {
        // The payload really is the checkpoint document, which is what makes a
        // migration able to do anything useful.
        sawOldPayload = decodeSnapshot(payload).ok;
        return { ok: true, value: payload };
      },
      down: (payload) => ({ ok: true, value: payload }),
    };

    const second = await mount(fake, { migrations: [bridge] });
    assert.equal(sawOldPayload, true, 'a migration is handed the real document');
    assert.deepEqual(second.recovery.migrated, ['test bridge']);
    assert.equal(second.recovery.storeVersion, STORE_VERSION);
    assert.equal(value(await second.backend.readText('/home/me/keep.txt')), 'survives');
    second.store?.close();
  });

  it('rolls back an interrupted migration on the next mount', async () => {
    // The rollback copy is written and flushed BEFORE the migrated slot, so its
    // presence is the only evidence a migration started and did not finish.
    const fake = new FakeOpfs();
    const first = await mount(fake);
    assert.ok((await first.backend.writeText('/home/me/before.txt', 'pre-migration')).ok);
    assert.ok((await first.backend.checkpoint()).ok);
    const active = leaderStore(first).activeSlot;
    const slotPath = storePath(DIRECTORY, active === 'a' ? STORE_FILES.slotA : STORE_FILES.slotB);
    const preMigration = fake.durableBytes(slotPath);
    first.store?.close();

    // Hand-build the state a crash mid-migration leaves: the rollback copy
    // present, and the OTHER slot holding a newer generation the migration
    // wrote before dying.
    const otherPath = storePath(DIRECTORY, active === 'a' ? STORE_FILES.slotB : STORE_FILES.slotA);
    const parsed = decodeSlot(preMigration);
    assert.ok(parsed !== null);
    fake.setDurableBytes(
      otherPath,
      encodeSlot({
        storeVersion: STORE_VERSION,
        generation: parsed.generation + 1,
        payload: TEXT.encode('{"format":"broken"}'),
      }),
    );
    const rollback = new Uint8Array([...TEXT.encode(active), ...preMigration]);
    fake.setDurableBytes(storePath(DIRECTORY, STORE_FILES.rollback), rollback);

    const second = await mount(fake);
    assert.equal(
      value(await second.backend.readText('/home/me/before.txt')),
      'pre-migration',
      'the pre-migration checkpoint is what came back',
    );
    assert.equal(
      fake.has(storePath(DIRECTORY, STORE_FILES.rollback)),
      false,
      'and the evidence is cleared, so the next mount is ordinary',
    );
    second.store?.close();
  });

  it('rollbackTo undoes an applied migration and drops the log with it', async () => {
    const fake = new FakeOpfs();
    const mounted = await mount(fake, { migrations: [marker(STORE_VERSION, 7)] });
    const before = leaderStore(mounted).generation;
    const rolled = leaderStore(mounted).rollbackTo(STORE_VERSION - 1);
    // STORE_VERSION is 1, so rolling back below it needs a migration from 0.
    const outcome = await rolled;
    if (STORE_VERSION === 1) {
      assert.equal(code(outcome), 'EINVAL', 'there is no version 0 to go back to');
    } else {
      assert.ok(outcome.ok);
      assert.ok(leaderStore(mounted).generation > before);
    }
    mounted.store?.close();
  });
});

// ---------------------------------------------------------------------------
// leader election
// ---------------------------------------------------------------------------

/**
 * The part of `LockManager` the store uses, in one object.
 *
 * MEASURED behaviour it reproduces: `request(name, {ifAvailable: true}, cb)`
 * invokes the callback with `null` when the lock is held and with a lock when
 * it is free; the lock is released when the callback's promise settles.
 */
class FakeLocks implements LockManagerLike {
  readonly #held = new Set<string>();

  async request(
    name: string,
    options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<unknown> | unknown,
  ): Promise<unknown> {
    if (this.#held.has(name)) {
      if (options.ifAvailable === true) return callback(null);
      throw new Error('this fake does not queue; every caller asks with ifAvailable');
    }
    this.#held.add(name);
    try {
      return await callback({ name, mode: options.mode ?? 'exclusive' });
    } finally {
      this.#held.delete(name);
    }
  }

  get held(): readonly string[] {
    return [...this.#held];
  }
}

describe('leader election', () => {
  it('the first caller is granted and the second is told no, without waiting', async () => {
    const locks = new FakeLocks();
    const first = await requestLeadership(locks);
    assert.equal(first.granted, true);
    const second = await requestLeadership(locks);
    assert.equal(second.granted, false, 'ifAvailable means the callback gets null');
    first.release();
    await first.done;
    assert.deepEqual(locks.held, []);
    const third = await requestLeadership(locks);
    assert.equal(third.granted, true, 'and the lock is reusable once released');
    third.release();
    await third.done;
  });

  it('a second mount refuses with EROFS rather than colliding', async () => {
    // Two mechanisms, and this is the ORDERLY one. The platform would refuse
    // the second mount anyway — MEASURED across two real tabs, a second
    // context's `createSyncAccessHandle` on a held file raises
    // NoModificationAllowedError — but "another tab holds this" is a message a
    // user can act on, and an EIO wrapping a DOMException is not.
    const fake = new FakeOpfs();
    const locks = new FakeLocks();
    const first = await mount(fake, { locks });
    const second = await mountOpfsStorage({
      root: fake.root,
      clock: clock(),
      seed: SEED,
      locks,
    });
    assert.equal(code(second), 'EROFS');
    assert.ok(!second.ok && second.error.message.includes('another tab'));
    first.leadership?.release();
    first.store?.close();
  });

  it('the platform refuses a second store even when the lock is not consulted', async () => {
    // What safety actually rests on. No Web Locks anywhere in this test.
    const fake = new FakeOpfs();
    const first = await mount(fake);
    const second = await mountOpfsStorage({ root: fake.root, clock: clock(), seed: SEED });
    assert.equal(code(second), 'EIO');
    assert.ok(!second.ok && second.error.message.includes('locked by another context'));
    first.store?.close();
    // And once the first store gives the handles back, the second mount works.
    const third = await mount(fake);
    third.store?.close();
  });
});

// ---------------------------------------------------------------------------
// quota
// ---------------------------------------------------------------------------

describe('quota', () => {
  it('reports shared: true and the estimate the platform gave', async () => {
    // OPFS has no quota of its own. The Storage Standard's estimate is per
    // storage SHELF, so IndexedDB and Cache Storage are inside the same number.
    const fake = new FakeOpfs({ quota: 1_000_000 });
    const mounted = await mount(fake);
    const usage = value(await mounted.backend.quota());
    assert.equal(usage.shared, true);
    assert.equal(usage.quota, 1_000_000);
    assert.ok(usage.used > 0, 'the checkpoint itself is on disk');
    assert.equal(usage.persisted, false);
    mounted.store?.close();
  });

  it('reports quota: null when the platform declines to say', async () => {
    // Both `StorageEstimate` members are OPTIONAL in the IDL. A missing quota
    // must not read as zero, which would mean "full".
    const fake = new FakeOpfs();
    const mounted = await mount(fake);
    const usage = value(await mounted.backend.quota());
    assert.equal(usage.quota, null);
    mounted.store?.close();
  });

  it('warns once on the way past the threshold, and re-arms below it', async () => {
    // The fake starts UNBOUNDED so the mount's own checkpoint cannot warn
    // before the test has said anything. That is not test scaffolding: the
    // mount checkpoints, the checkpoint now asks about quota, and an adversarial
    // pass found that this test only passed before because the warning fired
    // nowhere except an explicit `quota()` call.
    const fake = new FakeOpfs();
    const warnings: number[] = [];
    const mounted = await mount(fake, {
      threshold: 0.5,
      onQuotaWarning: (warning) => warnings.push(warning.fraction),
    });
    fake.setQuota(1_000_000);
    assert.ok((await mounted.backend.quota()).ok);
    assert.deepEqual(warnings, [], 'nowhere near the ceiling');

    fake.setQuota(Math.max(1, fake.usedBytes() * 2 - 1));
    assert.ok((await mounted.backend.quota()).ok);
    assert.equal(warnings.length, 1, 'the crossing warns');
    assert.ok((await mounted.backend.quota()).ok);
    assert.equal(warnings.length, 1, 'and does not warn again while it stays over');

    fake.setQuota(1_000_000);
    assert.ok((await mounted.backend.quota()).ok);
    fake.setQuota(Math.max(1, fake.usedBytes() * 2 - 1));
    assert.ok((await mounted.backend.quota()).ok);
    assert.equal(warnings.length, 2, 'dropping back under re-arms it');
    mounted.store?.close();
  });

  it('a full origin is ENOSPC at the journal, with nothing applied', async () => {
    // The write-ahead log is the quota gate, and that ordering is what makes
    // the refusal clean: `journal.write` runs BETWEEN the last validation and
    // the apply, so a QuotaExceededError there means no step ever ran.
    const fake = new FakeOpfs();
    const mounted = await mount(fake);
    fake.setQuota(fake.usedBytes() + 8);
    const attempt = await mounted.backend.writeText('/home/me/big.txt', 'x'.repeat(500));
    assert.equal(code(attempt), 'ENOSPC');
    assert.equal(await mounted.backend.exists('/home/me/big.txt'), false, 'nothing was applied');
    mounted.store?.close();
  });
});

// ---------------------------------------------------------------------------
// concurrency
// ---------------------------------------------------------------------------

describe('OpfsStorage: overlapping calls', () => {
  it('a checkpoint never captures a tree that is half-mutated', async () => {
    // The reason `OpfsStorage` has a mutex of its own on top of the one inside
    // `MemoryStorage`. A checkpoint exports the whole tree through the async
    // read API — `createSnapshot` awaits between every `readdir` — so without
    // this lock a second mutation lands inside the walk, the document holds
    // half of it, and the log is then reset and the other half discarded.
    //
    // `checkpointBytes: 1` forces a checkpoint after every single mutation, so
    // this runs the race on every iteration rather than once in a while.
    const fake = new FakeOpfs();
    const mounted = await mount(fake, { checkpointBytes: 1 });
    const writes = [];
    for (let index = 0; index < 24; index += 1) {
      writes.push(mounted.backend.writeText(`/home/me/f${String(index)}.txt`, `body ${String(index)}`));
    }
    for (const outcome of await Promise.all(writes)) assert.equal(code(outcome), 'ok');
    assert.ok((await mounted.backend.checkpoint()).ok);
    mounted.store?.close();

    const second = await mount(fake);
    for (let index = 0; index < 24; index += 1) {
      assert.equal(
        value(await second.backend.readText(`/home/me/f${String(index)}.txt`)),
        `body ${String(index)}`,
        `file ${String(index)} did not survive`,
      );
    }
    second.store?.close();
  });

  it('a refused mutation does not trigger a checkpoint', async () => {
    const fake = new FakeOpfs();
    const mounted = await mount(fake, { checkpointBytes: 1 });
    const before = leaderStore(mounted).generation;
    assert.equal(code(await mounted.backend.readText('/home/me/missing.txt')), 'ENOENT');
    assert.equal(code(await mounted.backend.remove('/home/me/missing.txt')), 'ENOENT');
    assert.equal(leaderStore(mounted).generation, before, 'a failure writes no plan to fold in');
    mounted.store?.close();
  });
});

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

describe('OpfsStorage: reset', () => {
  it('clears the disk as well as the tree, so it does not undo itself on reload', async () => {
    // Clearing only the memory tree would leave a checkpoint that the next
    // mount restores, and `Reset-FileSystem` would appear to work and then come
    // back. Both slots are zeroed, not just the active one, or the older
    // generation is picked up instead.
    const fake = new FakeOpfs();
    const first = await mount(fake);
    assert.ok((await first.backend.writeText('/home/me/a.txt', 'one')).ok);
    assert.ok((await first.backend.checkpoint()).ok);
    assert.ok((await first.backend.writeText('/home/me/a.txt', 'two')).ok);
    assert.ok((await first.backend.checkpoint()).ok);
    assert.ok((await first.backend.reset()).ok);
    first.store?.close();

    const second = await mount(fake);
    assert.equal(await second.backend.exists('/home/me/a.txt'), false);
    assert.equal(second.recovery.slot, null, 'both slots were cleared');
    second.store?.close();
  });
});

// ---------------------------------------------------------------------------
// the memory backend is still the one deciding what a filesystem means
// ---------------------------------------------------------------------------

describe('OpfsStorage: forwarded semantics', () => {
  it('produces the same POSIX codes as the memory backend for the same shapes', async () => {
    // The point of delegating. If this class had reimplemented the walk, this
    // is where the two would start to disagree.
    const fake = new FakeOpfs();
    const mounted = await mount(fake);
    const memory = new MemoryStorage({ clock: clock(), user: 'me', group: 'me' });
    assert.ok((await memory.installImage(SEED)).ok);

    const shapes: readonly [string, (b: typeof memory) => Promise<Result<unknown>>][] = [
      ['missing file', (b) => b.readText('/home/me/nope')],
      ['read a directory', (b) => b.readText('/home/me')],
      ['walk through a file', (b) => b.readText('/home/me/README.md/inner')],
      ['mkdir over a file', (b) => b.mkdir('/home/me/README.md')],
      ['remove a non-empty dir', (b) => b.remove('/home/me')],
      ['copy a directory without recursive', (b) => b.copy('/home/me', '/home/copy')],
      ['rename onto an existing path', (b) => b.rename('/home/me/README.md', '/home/me')],
    ];

    for (const [label, run] of shapes) {
      assert.equal(
        code(await run(mounted.backend as unknown as typeof memory)),
        code(await run(memory)),
        `the two backends disagreed on: ${label}`,
      );
    }
    mounted.store?.close();
  });
});

// ---------------------------------------------------------------------------
// what an adversarial pass over this branch's own work found
// ---------------------------------------------------------------------------

describe('adversarial: findings against the first draft of the OPFS store', () => {
  it('a follower mounts read-only instead of failing', async () => {
    // FINDING 1. `allowFollower` was a flag that did nothing of what its name
    // said: it skipped the Web Locks refusal and then mounted as a leader
    // anyway, so the failure just arrived later and worse — as the platform's
    // NoModificationAllowedError wrapped in an EIO.
    //
    // A follower CAN read: `getFile()` is not refused while another context
    // holds a sync access handle, MEASURED across two real browser tabs, and it
    // returns unflushed bytes too. So the second tab shows the filesystem
    // read-only rather than an error.
    const fake = new FakeOpfs();
    const locks = new FakeLocks();
    const leader = await mount(fake, { locks });
    assert.equal(leader.role, 'leader');
    assert.ok((await leader.backend.writeText('/home/me/shared.txt', 'from the leader')).ok);
    assert.ok((await leader.backend.checkpoint()).ok);

    const follower = value(
      await mountOpfsStorage({
        root: fake.root,
        clock: clock(),
        seed: SEED,
        user: 'me',
        manager: fake,
        locks,
        allowFollower: true,
      }),
    );
    assert.equal(follower.role, 'follower');
    assert.equal(follower.store, null, 'a follower holds no handles, so there is nothing to close');
    assert.equal(follower.backend.readOnly, true);
    assert.equal(
      value(await follower.backend.readText('/home/me/shared.txt')),
      'from the leader',
      'the follower can read what the leader wrote',
    );
    assert.equal(value(await follower.backend.readText('/home/me/README.md')), 'seeded');

    // And every mutating verb is EROFS, not a platform exception.
    for (const [label, attempt] of [
      ['writeText', await follower.backend.writeText('/home/me/x', 'no')],
      ['appendText', await follower.backend.appendText('/home/me/shared.txt', 'no')],
      ['mkdir', await follower.backend.mkdir('/home/me/d')],
      ['remove', await follower.backend.remove('/home/me/shared.txt')],
      ['rename', await follower.backend.rename('/home/me/shared.txt', '/home/me/y')],
      ['copy', await follower.backend.copy('/home/me/shared.txt', '/home/me/y')],
      ['chmod', await follower.backend.chmod('/home/me/shared.txt', 0o600)],
      ['utimes', await follower.backend.utimes('/home/me/shared.txt', { mtime: 1 })],
      ['reset', await follower.backend.reset()],
      ['checkpoint', await follower.backend.checkpoint()],
      ['installImage', await follower.backend.installImage(SEED)],
    ] as const) {
      assert.equal(code(attempt), 'EROFS', `${label} should be EROFS on a follower`);
    }

    // The leader is untouched by any of it.
    assert.equal(value(await leader.backend.readText('/home/me/shared.txt')), 'from the leader');
    leader.leadership?.release();
    leaderStore(leader).close();
  });

  it('a leader and a follower agree on which directory the store is in', async () => {
    // Found in the second pass: the default directory was spelled as the
    // `STORE_DIRECTORY` constant in the follower's reader and as a bare string
    // literal in `OpfsStore.open`. They happened to match. If they ever stopped
    // matching, nothing would crash -- a second tab would show an EMPTY
    // filesystem and the user would conclude their files were gone.
    //
    // Asserting on the constant rather than on the literal is what makes the
    // two impossible to separate.
    const fake = new FakeOpfs();
    const locks = new FakeLocks();
    const leader = await mount(fake, { locks });
    assert.ok((await leader.backend.writeText('/home/me/proof.txt', 'here')).ok);
    assert.ok((await leader.backend.checkpoint()).ok);
    assert.equal(
      fake.has([STORE_DIRECTORY, STORE_FILES.slotA]),
      true,
      'the leader wrote into STORE_DIRECTORY',
    );

    const view = value(await readFollowerView({ root: fake.root }));
    assert.ok(view.overlay !== null, 'and the follower reader found it there');
    assert.equal(view.slot !== null, true);
    leader.leadership?.release();
    leaderStore(leader).close();
  });

  it("a follower sees the leader's uncheckpointed, committed writes", async () => {
    // The follower reads the log as well as the checkpoint, and applies the
    // same rule recovery does: committed plans only. One implementation of
    // "which of these plans counted" — `committedPlans` — is shared by both,
    // because two would drift and the way that is discovered is a lost file.
    const fake = new FakeOpfs();
    const locks = new FakeLocks();
    const leader = await mount(fake, { locks });
    assert.ok((await leader.backend.writeText('/home/me/one.txt', 'first')).ok);
    assert.ok((await leader.backend.writeText('/home/me/two.txt', 'second')).ok);

    const follower = value(
      await mountOpfsStorage({
        root: fake.root,
        clock: clock(),
        seed: SEED,
        user: 'me',
        manager: fake,
        locks,
        allowFollower: true,
      }),
    );
    assert.equal(value(await follower.backend.readText('/home/me/one.txt')), 'first');
    // AND `two.txt`, whose commit marker has NOT been flushed.
    //
    // This assertion was the other way round when it was written, on the
    // assumption that a follower sees only what a crash would keep. It does
    // not, and the reason is measured: `getFile()` returns UNFLUSHED bytes, so
    // a follower reads the log as the leader has it in hand rather than as the
    // disk has it. That is the better answer for a second tab — it wants the
    // leader's current state, not a crash-consistent one — but it is a real
    // difference from recovery and it is written down here rather than left to
    // be rediscovered.
    assert.equal(value(await follower.backend.readText('/home/me/two.txt')), 'second');
    leader.leadership?.release();
    leaderStore(leader).close();
  });

  it('an unreadable log is reported as such, not as an empty one', async () => {
    // FINDING 2. `RecoveryReport` reported `truncatedBytes: 0` for two
    // completely different situations: a clean log with nothing in it, and a
    // log whose header did not parse. The second is every mutation since the
    // last checkpoint being gone, and it was indistinguishable from the
    // ordinary case in everything the mount returned.
    const fake = new FakeOpfs();
    const first = await mount(fake);
    assert.ok((await first.backend.writeText('/home/me/a.txt', 'A')).ok);
    assert.ok((await first.backend.checkpoint()).ok);
    leaderStore(first).close();

    const clean = await mount(fake);
    assert.equal(clean.recovery.log, 'empty', 'a log with nothing in it');
    leaderStore(clean).close();

    fake.setDurableBytes(storePath(DIRECTORY, STORE_FILES.wal), TEXT.encode('WRECKED!'));
    const wrecked = await mount(fake);
    assert.equal(wrecked.recovery.log, 'unreadable', 'a log whose framing is gone');
    assert.equal(
      value(await wrecked.backend.readText('/home/me/a.txt')),
      'A',
      'the checkpoint still stands',
    );
    leaderStore(wrecked).close();
  });

  it('reports every other fate of the log by name', async () => {
    // EACH FATE GETS ITS OWN STORE. The first draft of this test reused one,
    // and every mount ends with a checkpoint that bumps the generation and
    // resets the log — so a log captured before one mount was already STALE by
    // the next, and the 'torn' case reported 'stale'. The test was wrong and
    // the code was right, which is the more useful half of an adversarial pass.
    const written = async (): Promise<{ bytes: Uint8Array; generation: number; fake: FakeOpfs }> => {
      const fake = new FakeOpfs();
      const first = await mount(fake);
      assert.ok((await first.backend.writeText('/home/me/a.txt', 'A')).ok);
      assert.ok((await first.backend.writeText('/home/me/b.txt', 'B')).ok);
      assert.ok(first.backend.sync().ok);
      const bytes = fake.durableBytes(storePath(DIRECTORY, STORE_FILES.wal));
      const generation = leaderStore(first).generation;
      leaderStore(first).close();
      return { bytes, generation, fake };
    };

    const cleanCase = await written();
    const clean = await mount(cleanCase.fake);
    assert.equal(clean.recovery.log, 'clean');
    // TWO, not one: `sync()` flushed the second commit marker as well, so both
    // writes are durable and both replay. Without the `sync()` this is 1 — see
    // 'keeps every operation but the last, and says which'.
    assert.equal(clean.recovery.replay.length, 2, 'sync() made both commit markers durable');
    leaderStore(clean).close();

    const tornCase = await written();
    tornCase.fake.setDurableBytes(
      storePath(DIRECTORY, STORE_FILES.wal),
      tornCase.bytes.slice(0, tornCase.bytes.byteLength - 3),
    );
    const torn = await mount(tornCase.fake);
    assert.equal(torn.recovery.log, 'torn');
    assert.ok(torn.recovery.truncatedBytes > 0);
    leaderStore(torn).close();

    const staleCase = await written();
    staleCase.fake.setDurableBytes(
      storePath(DIRECTORY, STORE_FILES.wal),
      walHeader(staleCase.generation - 1),
    );
    const stale = await mount(staleCase.fake);
    assert.equal(stale.recovery.log, 'stale');
    leaderStore(stale).close();
  });

  it('the quota warning arrives without anyone calling quota()', async () => {
    // FINDING 3. `#maybeWarn` was only reachable from `quota()`, so a session
    // that never asked filled the disk and got an ENOSPC with no warning at
    // all — which is PR-09 task 9.6 ("warn before the ceiling") not happening.
    // The checkpoint asks now, which is once per `checkpointBytes` of log.
    const fake = new FakeOpfs();
    const warnings: number[] = [];
    const mounted = await mount(fake, {
      checkpointBytes: 1,
      threshold: 0.5,
      onQuotaWarning: (warning) => warnings.push(warning.fraction),
    });
    assert.deepEqual(warnings, [], 'no quota, nothing to warn about');

    fake.setQuota(Math.max(1, fake.usedBytes() * 2 - 1));
    assert.ok((await mounted.backend.writeText('/home/me/a.txt', 'a')).ok);
    assert.equal(warnings.length, 1, 'a plain write warned, with no quota() call anywhere');
    leaderStore(mounted).close();
  });

  it('checkpointBytes counts log bytes, not the header that is always there', async () => {
    // FINDING 4, and the smallest of the four. `checkpointDue` compared
    // `journal.byteLength` — which INCLUDES the 16-byte header present in a
    // freshly reset, empty log — against the threshold. So an empty log was
    // already "due" for any threshold of 16 or less, and no value in 0..16
    // meant anything different from any other.
    //
    // The consequence is wasted work rather than lost data: a spurious
    // checkpoint rewrites the overlay and resets a log that was already empty.
    // It is fixed anyway because `checkpointBytes` is documented as bytes of
    // LOG, and an option whose units are wrong is one nobody can tune.
    //
    // The assertion is on the EMPTY log, because that is where the two
    // definitions differ by exactly the header and the boundary is crisp. A
    // behavioural assertion — "one small write does not trip a 4 KiB
    // threshold" — passes under both and proves nothing.
    const fake = new FakeOpfs();
    const mounted = await mount(fake, { checkpointBytes: 16 });
    assert.equal(
      leaderStore(mounted).checkpointDue,
      false,
      'a log with nothing in it is 0 bytes of log, not 16',
    );
    assert.ok((await mounted.backend.writeText('/home/me/a.txt', 'small')).ok);
    assert.equal(
      leaderStore(mounted).checkpointDue,
      false,
      'and after a checkpoint it is empty again',
    );
    leaderStore(mounted).close();
  });

  it('MemoryStorage.replay refuses a plan the tree cannot take, rather than throwing', async () => {
    // The recovery entry point, on the path that matters: a plan read off disk
    // was validated against a tree that may no longer exist. `types.ts` says
    // `#apply` returns an `Err` for exactly this, and without a caller the
    // sentence described something nobody could do.
    const store = new MemoryStorage({ clock: clock(), user: 'me', group: 'me' });
    assert.ok((await store.installImage(SEED)).ok);
    const outcome = await store.replay({
      id: 'stale-1',
      syscall: 'remove',
      steps: [{ op: 'remove', path: '/home/me/never-existed' }],
      byteDelta: 0,
    });
    assert.equal(code(outcome), 'ENOENT');

    const applied = await store.replay({
      id: 'good-1',
      syscall: 'write',
      steps: [{ op: 'create-file', path: '/home/me/replayed.txt', data: TEXT.encode('hi') }],
      byteDelta: 2,
    });
    assert.equal(code(applied), 'ok');
    assert.equal(value(await store.readText('/home/me/replayed.txt')), 'hi');
  });

  it('a failed replay stops the mount replaying the plans after it', async () => {
    // Losing the tail of a crashed session is a smaller loss than a middle that
    // never existed: each plan was validated against the tree its predecessor
    // left, so applying the next one after skipping this one applies it against
    // a tree it never saw.
    const fake = new FakeOpfs();
    const first = await mount(fake);
    assert.ok((await first.backend.writeText('/home/me/a.txt', 'A')).ok);
    assert.ok(first.backend.sync().ok);
    const generation = leaderStore(first).generation;
    leaderStore(first).close();

    // A log whose first plan cannot apply, followed by one that could.
    const bad = walRecord(
      1,
      TEXT.encode(
        JSON.stringify({
          id: 'bad-1',
          syscall: 'remove',
          steps: [{ op: 'remove', path: '/home/me/never-existed' }],
          byteDelta: 0,
        }),
      ),
    );
    const good = walRecord(
      1,
      TEXT.encode(
        JSON.stringify({
          id: 'good-1',
          syscall: 'write',
          steps: [{ op: 'create-file', path: '/home/me/after.txt', data: '' }],
          byteDelta: 0,
        }),
      ),
    );
    fake.setDurableBytes(
      storePath(DIRECTORY, STORE_FILES.wal),
      new Uint8Array([
        ...walHeader(generation),
        ...bad,
        ...walRecord(2, TEXT.encode(JSON.stringify({ id: 'bad-1' }))),
        ...good,
        ...walRecord(2, TEXT.encode(JSON.stringify({ id: 'good-1' }))),
      ]),
    );

    const second = await mount(fake);
    assert.equal(second.failures.length, 1, 'the failure is reported, not swallowed');
    assert.equal(second.failures[0]?.code, 'ENOENT');
    assert.equal(
      await second.backend.exists('/home/me/after.txt'),
      false,
      'and nothing after it was applied',
    );
    leaderStore(second).close();
  });

  it('a plan record that does not decode refuses the whole log', async () => {
    // Not "skip the bad one". The steps are ordered, and a hole in the middle
    // means the plans after it were validated against a tree this recovery is
    // not going to build.
    const fake = new FakeOpfs();
    const first = await mount(fake);
    assert.ok((await first.backend.writeText('/home/me/a.txt', 'A')).ok);
    assert.ok(first.backend.sync().ok);
    const generation = leaderStore(first).generation;
    leaderStore(first).close();

    fake.setDurableBytes(
      storePath(DIRECTORY, STORE_FILES.wal),
      new Uint8Array([
        ...walHeader(generation),
        ...walRecord(1, TEXT.encode('{"id":"x","syscall":"nonsense","steps":[],"byteDelta":0}')),
        ...walRecord(2, TEXT.encode(JSON.stringify({ id: 'x' }))),
      ]),
    );

    const outcome = await mountOpfsStorage({
      root: fake.root,
      clock: clock(),
      seed: SEED,
      user: 'me',
      manager: fake,
    });
    assert.equal(code(outcome), 'EINVAL');
    assert.ok(!outcome.ok && outcome.error.message.includes('unknown syscall'));
  });

  it('a move step with no source is refused at decode, before anything is applied', async () => {
    // `#apply` names this as the one malformed step it returns EINVAL for. The
    // decoder catches it first, so the refusal happens before the steps in
    // front of it have been applied.
    const outcome = decodePlan(
      TEXT.encode('{"id":"m","syscall":"rename","steps":[{"op":"move","path":"/a"}],"byteDelta":0}'),
    );
    assert.equal(code(outcome), 'EINVAL');
    assert.ok(!outcome.ok && outcome.error.message.includes('no source'));
  });
});

// ---------------------------------------------------------------------------
// second adversarial pass: the durability controls, and export
// ---------------------------------------------------------------------------

describe('adversarial pass 2: what the first pass left', () => {
  it('a page can checkpoint and sync through the worker boundary', async () => {
    // THE GAP. `StorageCall` is derived from `StorageBackend` so it cannot
    // drift from it — and `checkpoint` and `sync` are deliberately not on
    // `StorageBackend`, because no command has any business calling them. The
    // consequence, missed until a second pass: the PAGE owns `pagehide` and the
    // WORKER owns the store, so a page could not tell its own storage to flush
    // before the tab went away. The last operation of every session lost, for
    // want of a message.
    const [pageSide, workerSide] = portPair();
    const fake = new FakeOpfs();
    const mounted = await mount(fake);
    serveStorageWorker(workerSide, mounted.backend, {
      checkpoint: () => mounted.backend.checkpoint(),
      sync: () => mounted.backend.sync(),
    });
    const client = new WorkerStorageBackend({ port: pageSide });

    assert.equal(code(await client.writeText('/home/me/from-the-page.txt', 'across')), 'ok');
    const synced = await client.sync();
    assert.equal(code(synced), 'ok');
    const generation = await client.checkpoint();
    assert.ok(generation.ok);
    assert.equal(generation.value, leaderStore(mounted).generation);
    assert.equal(client.inFlight, 0);
    leaderStore(mounted).close();
  });

  it('a worker serving a backend with no durability says so instead of ignoring it', async () => {
    // Silence here is the dangerous answer: a page whose `pagehide` sync did
    // nothing would believe its data was safe.
    const [pageSide, workerSide] = portPair();
    const memory = new MemoryStorage({ clock: clock(), user: 'me', group: 'me' });
    serveStorageWorker(workerSide, memory);
    const client = new WorkerStorageBackend({ port: pageSide });
    await assert.rejects(() => client.sync(), /no sync/);
    await assert.rejects(() => client.checkpoint(), /no checkpoint/);
  });

  it('a full export survives a store that is then destroyed and re-imported', async () => {
    // PR-09's third acceptance condition: "Clearing site data is survivable via
    // export." OPFS is deleted when the user clears site data, with no warning
    // from the browser, so the only thing that survives is a file the user
    // holds. `exportSnapshot` already worked on any `StorageBackend`; what this
    // pins is that it works through THIS one, and that the document it makes is
    // enough to rebuild the filesystem in a store that has been wiped.
    const fake = new FakeOpfs();
    const first = await mount(fake);
    assert.ok((await first.backend.mkdir('/home/me/work', { recursive: true })).ok);
    assert.ok((await first.backend.writeText('/home/me/work/notes.md', 'irreplaceable')).ok);
    assert.ok((await first.backend.writeText('/home/me/README.md', 'my own README')).ok);
    assert.ok((await first.backend.chmod('/home/me/work/notes.md', 0o600)).ok);
    assert.ok((await first.backend.checkpoint()).ok);

    // FULL scope, not overlay: after a site-data clear there is no seed on disk
    // to rebuild from, and an overlay omits a seed node's content on purpose.
    const rescued = value(
      await exportSnapshot(first.backend, { scope: 'full', now: 2_000_000_000_000 }),
    );
    leaderStore(first).close();

    // The user clears site data. Everything OPFS held is gone.
    const wiped = new FakeOpfs();
    const second = await mount(wiped);
    assert.equal(await second.backend.exists('/home/me/work/notes.md'), false);

    const restored = value(await importSnapshot(second.backend, rescued, { seed: SEED }));
    assert.deepEqual(restored.failures, []);
    assert.equal(value(await second.backend.readText('/home/me/work/notes.md')), 'irreplaceable');
    assert.equal(value(await second.backend.readText('/home/me/README.md')), 'my own README');
    assert.equal(value(await second.backend.stat('/home/me/work/notes.md')).mode, 0o600);

    // And the rescue is itself durable: checkpoint, remount, still there.
    assert.ok((await second.backend.checkpoint()).ok);
    leaderStore(second).close();
    const third = await mount(wiped);
    assert.equal(value(await third.backend.readText('/home/me/work/notes.md')), 'irreplaceable');
    leaderStore(third).close();
  });

  it('a checkpoint that fails replaces the mutation result rather than lying', async () => {
    // The caller asked for a DURABLE write. If the disk could not keep up,
    // saying the write succeeded is the lie this whole layer exists to stop
    // telling. The mutation stays applied in memory; the error says so.
    const fake = new FakeOpfs();
    const mounted = await mount(fake, { checkpointBytes: 1 });
    fake.setQuota(fake.usedBytes() + 300);
    let refused: Result<unknown> | null = null;
    for (let index = 0; index < 40 && refused === null; index += 1) {
      const attempt = await mounted.backend.writeText(
        `/home/me/f${String(index)}.txt`,
        'x'.repeat(40),
      );
      if (!attempt.ok) refused = attempt;
    }
    assert.ok(refused !== null, 'the quota should have been reached');
    assert.equal(code(refused), 'ENOSPC');
    leaderStore(mounted).close();
  });
});
