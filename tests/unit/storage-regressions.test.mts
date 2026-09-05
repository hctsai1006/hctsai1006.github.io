/**
 * storage-regressions.test.mts — one failing test per defect an adversarial
 * review proved, written BEFORE the fix and kept as the thing that catches it
 * coming back.
 *
 * Every claim about `cp` semantics below is MEASURED against GNU coreutils
 * 8.32 on this machine, and the transcript is quoted at the test that depends
 * on it. Where the measurement could not be trusted — Git Bash on NTFS silently
 * ignores `chmod 0555` on a DIRECTORY, though it honours 0444 on a FILE — the
 * test asserts only what the reference actually demonstrated.
 *
 * The concurrency block is the reason this file exists at all. `types.ts`
 * claimed "MemoryStorage mutates only inside synchronous critical sections with
 * no `await` between the last validation and the last write", and `#commit`
 * awaited the journal in exactly that gap. Every test in that block failed
 * before the mutex went in, and three of them failed by THROWING out of an API
 * whose whole contract is that it returns a `Result`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  HOME,
  MemoryStorage,
  NullJournal,
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  bootStorage,
  buildSeed,
  createSnapshot,
  decodeSnapshot,
  encodeSnapshot,
  fnv1a32,
  restoreSnapshot,
  toBase64,
} from '../../src/storage/index.ts';
import type {
  MemoryStorageOptions,
  Result,
  SnapshotDocument,
  SnapshotEntry,
  StorageErrorCode,
} from '../../src/storage/index.ts';

function fakeClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    },
  };
}

function backend(overrides: Omit<MemoryStorageOptions, 'clock'> = {}): MemoryStorage {
  return new MemoryStorage({ clock: fakeClock().now, ...overrides });
}

function code(result: Result<unknown>): StorageErrorCode | 'ok' {
  return result.ok ? 'ok' : result.error.code;
}

function value<T>(result: Result<T>): T {
  assert.ok(result.ok, `expected ok, got ${result.ok ? '' : result.error.message}`);
  return result.value;
}

/**
 * Settle a promise without letting a rejection escape, so a test can assert
 * "this returned an Err" separately from "this threw", which is the entire
 * distinction three of these defects turned on.
 */
async function settle<T>(promise: Promise<T>): Promise<{ threw: false; value: T } | { threw: true; error: unknown }> {
  try {
    return { threw: false, value: await promise };
  } catch (error) {
    return { threw: true, error };
  }
}

// ---------------------------------------------------------------------------
// 1. copy with overwrite, against a destination of the other kind
// ---------------------------------------------------------------------------

describe('copy: a destination subtree is not collateral', () => {
  it('ARM A: refuses a source FILE onto a destination DIRECTORY, and keeps the subtree', async () => {
    // MEASURED, GNU coreutils 8.32:
    //   $ cp -r src/. dst/
    //   cp: cannot overwrite directory 'dst/./x' with non-directory
    //   exit 1; dst/x is still a directory and dst/x/precious still exists.
    // `cp -rf` gives the identical refusal, so --force is NOT the difference:
    // there is no cp flag that turns this into a remove-then-create. REFUSE is
    // the semantics, which is why the planner refuses rather than planning a
    // `remove` first.
    const store = backend();
    await store.mkdir('/src');
    await store.writeText('/src/x', 'file from source');
    await store.mkdir('/dst');
    await store.mkdir('/dst/x');
    await store.writeText('/dst/x/precious', 'DO NOT LOSE ME');

    const copied = await store.copy('/src', '/dst', { recursive: true, overwrite: true });

    assert.equal(code(copied), 'EISDIR', 'a file may not replace a directory');
    assert.equal(value(await store.stat('/dst/x')).kind, 'directory');
    assert.equal(value(await store.readText('/dst/x/precious')), 'DO NOT LOSE ME');
  });

  it('ARM B: refuses a source DIRECTORY onto a destination FILE, and applies NOTHING', async () => {
    // MEASURED, GNU coreutils 8.32:
    //   $ cp -r src/. dst/
    //   cp: cannot overwrite non-directory 'dst/./zzz' with directory 'src/./zzz'
    //   exit 1 — but dst/aaa WAS created. GNU cp is best-effort per file.
    //
    // This backend is deliberately STRONGER than the reference, because
    // `MutationPlan` in types.ts promises it is: the refusal is discovered
    // while PLANNING, so no step is ever applied. `/dst/aaa` must not exist.
    const journal = new NullJournal();
    const store = backend({ journal });
    await store.mkdir('/src');
    await store.writeText('/src/aaa', 'applied first');
    await store.mkdir('/src/zzz');
    await store.writeText('/src/zzz/inner', 'never reached');
    await store.mkdir('/dst');
    await store.writeText('/dst/zzz', 'a plain file where the source has a directory');

    const journaledBefore = journal.written.length;
    const attempt = await settle(store.copy('/src', '/dst', { recursive: true, overwrite: true }));

    assert.equal(attempt.threw, false, 'a Result API must not throw');
    assert.ok(!attempt.threw);
    assert.equal(code(attempt.value), 'ENOTDIR', 'a directory may not replace a file');
    assert.equal(await store.exists('/dst/aaa'), false, 'nothing may be applied when the plan is refused');
    assert.equal(value(await store.readText('/dst/zzz')), 'a plain file where the source has a directory');
    assert.equal(journal.written.length, journaledBefore, 'a refused plan is never journalled');
  });

  it('still merges when both sides are directories, and clobbers a file with a file', async () => {
    // MEASURED: `cp -r s/. d/` with d/f present exits 0 and d/f becomes the
    // source's content. Merging is the default and must survive the fix.
    const store = backend();
    await store.mkdir('/src/keep', { recursive: true });
    await store.writeText('/src/f', 'NEW');
    await store.writeText('/src/keep/deep', 'deep');
    await store.mkdir('/dst/keep', { recursive: true });
    await store.writeText('/dst/f', 'OLD');
    await store.writeText('/dst/keep/untouched', 'mine');

    assert.ok((await store.copy('/src', '/dst', { recursive: true, overwrite: true })).ok);
    assert.equal(value(await store.readText('/dst/f')), 'NEW');
    assert.equal(value(await store.readText('/dst/keep/deep')), 'deep');
    assert.equal(value(await store.readText('/dst/keep/untouched')), 'mine', 'a merge adds, it does not truncate');
  });
});

// ---------------------------------------------------------------------------
// 3. copy with overwrite: the write bit, and the byte delta
// ---------------------------------------------------------------------------

describe('copy: overwriting respects permissions and counts bytes net', () => {
  it('refuses to overwrite a 0444 file, exactly as writeText already did', async () => {
    // MEASURED, GNU coreutils 8.32 (this one IS honoured on NTFS for files):
    //   $ chmod 0444 ro && cp src ro
    //   cp: cannot create regular file 'ro': Permission denied
    //   exit 1; `cat ro` still prints the old content.
    const store = backend();
    await store.writeText('/source', 'replacement');
    await store.writeText('/target', 'original');
    await store.chmod('/target', 0o444);

    assert.equal(code(await store.copy('/source', '/target', { overwrite: true })), 'EACCES');
    assert.equal(value(await store.readText('/target')), 'original');
  });

  it('refuses when an overwritten DESCENDANT is read-only, and applies nothing', async () => {
    // MEASURED: `cp -r s/. d/` with d/f at 0444 →
    //   cp: cannot create regular file 'd/./f': Permission denied
    const store = backend();
    await store.mkdir('/src');
    await store.writeText('/src/a', 'a');
    await store.writeText('/src/f', 'NEW');
    await store.mkdir('/dst');
    await store.writeText('/dst/f', 'OLD');
    await store.chmod('/dst/f', 0o444);

    assert.equal(code(await store.copy('/src', '/dst', { recursive: true, overwrite: true })), 'EACCES');
    assert.equal(value(await store.readText('/dst/f')), 'OLD');
    assert.equal(await store.exists('/dst/a'), false, 'the whole plan is refused, not just the one file');
  });

  it('charges an overwriting copy the NET byte change, not the gross', async () => {
    // 80 bytes used, capacity 100, copying /a (40) over /b (40): net change is
    // zero and it must fit. Charging the gross 40 reported ENOSPC "120 > 100".
    const store = backend({ capacity: 100 });
    await store.writeText('/a', 'x'.repeat(40));
    await store.writeText('/b', 'y'.repeat(40));
    assert.equal(value(await store.quota()).used, 80);

    assert.ok((await store.copy('/a', '/b', { overwrite: true })).ok, 'a net-zero copy must fit');
    assert.equal(value(await store.quota()).used, 80);
    assert.equal(value(await store.readText('/b')), 'x'.repeat(40));
  });
});

// ---------------------------------------------------------------------------
// 2. serialisation: one operation at a time per mount
// ---------------------------------------------------------------------------

describe('concurrency: the backend serialises mutations', () => {
  it('does not lose an append when two appends overlap', async () => {
    const store = backend();
    await store.writeText('/log', '');
    await Promise.all([store.appendText('/log', 'AAA\n'), store.appendText('/log', 'BBB\n')]);
    const text = value(await store.readText('/log'));
    assert.ok(text.includes('AAA\n'), `AAA was lost: ${JSON.stringify(text)}`);
    assert.ok(text.includes('BBB\n'), `BBB was lost: ${JSON.stringify(text)}`);
    assert.equal(text.length, 8);
  });

  it('makes O_EXCL actually exclusive', async () => {
    const store = backend();
    const results = await Promise.all([
      store.writeText('/only', 'first', { exclusive: true }),
      store.writeText('/only', 'second', { exclusive: true }),
    ]);
    assert.equal(results.filter((r) => r.ok).length, 1, 'exactly one exclusive create may win');
    assert.equal(results.filter((r) => !r.ok && r.error.code === 'EEXIST').length, 1);
  });

  it('lets exactly one non-recursive mkdir win', async () => {
    const store = backend();
    const results = await Promise.all([store.mkdir('/d'), store.mkdir('/d')]);
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(results.filter((r) => !r.ok && r.error.code === 'EEXIST').length, 1);
  });

  it('does not throw when a subtree and its parent are removed at once', async () => {
    // Before the mutex this THREW `plan referenced a missing node` out of a
    // Result API, with the tree left half-applied.
    const store = backend();
    await store.mkdir('/d/e/f', { recursive: true });
    await store.writeText('/d/e/f/deep', 'x');

    const outcomes = await Promise.all([
      settle(store.remove('/d/e', { recursive: true })),
      settle(store.remove('/d', { recursive: true })),
    ]);
    for (const outcome of outcomes) {
      assert.equal(outcome.threw, false, `a Result API threw: ${String(outcome.threw && outcome.error)}`);
    }
    assert.equal(await store.exists('/d'), false);
  });

  it('does not let two writes overshoot the capacity', async () => {
    const store = backend({ capacity: 10 });
    const results = await Promise.all([
      store.writeText('/a', 'a'.repeat(8)),
      store.writeText('/b', 'b'.repeat(8)),
    ]);
    assert.equal(results.filter((r) => r.ok).length, 1, 'only one 8-byte write fits in 10 bytes');
    const usage = value(await store.quota());
    assert.ok(usage.used <= 10, `quota overshot: used ${String(usage.used)} of 10`);
  });

  it('does not throw when a chmod races an unrelated remove', async () => {
    const store = backend();
    await store.mkdir('/d/e', { recursive: true });
    await store.writeText('/d/e/f', 'x');
    await store.writeText('/other', 'y');

    const outcomes = await Promise.all([
      settle(store.chmod('/other', 0o600)),
      settle(store.remove('/d', { recursive: true })),
    ]);
    for (const outcome of outcomes) {
      assert.equal(outcome.threw, false, `a Result API threw: ${String(outcome.threw && outcome.error)}`);
      assert.ok(!outcome.threw);
      assert.ok(outcome.value.ok, 'both operations are independent and must both succeed');
    }
  });

  it('serialises a copy against a concurrent remove of its source', async () => {
    const store = backend();
    await store.mkdir('/src/inner', { recursive: true });
    await store.writeText('/src/inner/a', 'aaa');
    await store.writeText('/src/b', 'bbb');

    const outcomes = await Promise.all([
      settle(store.copy('/src', '/dst', { recursive: true })),
      settle(store.remove('/src', { recursive: true })),
    ]);
    for (const outcome of outcomes) {
      assert.equal(outcome.threw, false, `a Result API threw: ${String(outcome.threw && outcome.error)}`);
    }
    // The copy is ordered first, so it sees a whole tree or none of it — never
    // a tree being dismantled underneath it.
    assert.ok(!outcomes[0]?.threw && outcomes[0].value.ok);
    assert.equal(value(await store.readText('/dst/inner/a')), 'aaa');
  });
});

// ---------------------------------------------------------------------------
// NullJournal.pending(), across a serialisation boundary
// ---------------------------------------------------------------------------

describe('NullJournal.pending', () => {
  it('matches on plan identity, not object identity', async () => {
    // A durable journal replays DESERIALISED plans, so `Array.includes` on the
    // object reference reports every committed plan as still pending. Replacing
    // pending() with `return ok([])` killed zero tests before this one existed.
    const journal = new NullJournal();
    const store = backend({ journal });
    await store.writeText('/a', 'hello');
    assert.deepEqual(await journal.pending(), { ok: true, value: [] });

    const [written] = journal.written;
    assert.ok(written !== undefined);
    const roundTripped = JSON.parse(JSON.stringify({ ...written, steps: [] })) as typeof written;
    const replayed = new NullJournal();
    await replayed.write(written);
    await replayed.commit(roundTripped);
    assert.deepEqual(await replayed.pending(), { ok: true, value: [] }, 'a deserialised plan is the same plan');
  });

  it('gives every plan a distinct id', async () => {
    const journal = new NullJournal();
    const store = backend({ journal });
    await store.writeText('/a', 'one');
    await store.writeText('/b', 'two');
    const ids = journal.written.map((plan) => plan.id);
    assert.equal(new Set(ids).size, ids.length, `plan ids collided: ${ids.join(', ')}`);
  });
});

// ---------------------------------------------------------------------------
// quota: the spread, and the re-walk
// ---------------------------------------------------------------------------

describe('quota', () => {
  it('survives a directory too wide for a spread argument list', async () => {
    // `stack.push(...node.children.values())` is a RangeError at ~125k entries.
    const store = backend();
    const wide = 130_000;
    for (let index = 0; index < wide; index += 1) {
      await store.writeText(`/f${String(index)}`, '');
    }
    const usage = await settle(store.quota());
    assert.equal(usage.threw, false, `quota threw on a wide directory: ${String(usage.threw && usage.error)}`);
    assert.ok(!usage.threw);
    assert.equal(value(usage.value).used, 0);
  });

  it('does not re-walk the tree on every capacity-checked write', async () => {
    // MEASURED before the fix: 8000 writes took 1749 ms with a capacity set and
    // 35 ms without, because `#checkCapacity` walked the whole tree each time.
    // The bound below is ~20x the fixed cost, so it fails loudly on a
    // regression without being a stopwatch race.
    const store = backend({ capacity: 10_000_000 });
    const started = performance.now();
    for (let index = 0; index < 8000; index += 1) {
      await store.writeText(`/f${String(index)}`, 'x'.repeat(10));
    }
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 800, `8000 capacity-checked writes took ${elapsed.toFixed(0)} ms`);
    assert.equal(value(await store.quota()).used, 80_000);
  });

  it('keeps the running total honest across every mutation', async () => {
    const store = backend({ capacity: 1000 });
    await store.writeText('/a', 'x'.repeat(100));
    await store.writeText('/b', 'y'.repeat(50));
    assert.equal(value(await store.quota()).used, 150);
    await store.appendText('/a', 'z'.repeat(25));
    assert.equal(value(await store.quota()).used, 175);
    await store.writeText('/a', 'q');
    assert.equal(value(await store.quota()).used, 51);
    await store.mkdir('/d');
    await store.copy('/b', '/d/b');
    assert.equal(value(await store.quota()).used, 101);
    await store.rename('/d/b', '/d/c');
    assert.equal(value(await store.quota()).used, 101, 'a rename moves no bytes');
    await store.writeText('/d/victim', 'v'.repeat(30));
    await store.rename('/a', '/d/victim', { overwrite: true });
    assert.equal(value(await store.quota()).used, 101, 'a rename that overwrites frees the target');

    // The cross-check that matters: `installImage` is one of the two paths that
    // does NOT go through `#apply`, so it recomputes the total by walking the
    // tree. Handing it an empty image therefore replaces the running total with
    // the authoritative one — if the two disagree, the number moves here.
    await store.installImage({ time: 1_700_000_000_000, entries: [] });
    assert.equal(value(await store.quota()).used, 101, 'the running total matches a full walk');

    // `/d` now holds /d/c (50) and the renamed /d/victim (1). `/b` (50) is all
    // that is left outside it.
    await store.remove('/d', { recursive: true });
    assert.equal(value(await store.quota()).used, 50);
    await store.reset();
    assert.equal(value(await store.quota()).used, 0);
  });
});

// ---------------------------------------------------------------------------
// snapshot: the discarded skipped list, and the forgeable seed flag
// ---------------------------------------------------------------------------

describe('decodeSnapshot', () => {
  it('carries the skipped list the export wrote', async () => {
    // `skipped: []` was hard-coded, so an importer could never learn their
    // backup was incomplete — the one field that says "this is not everything".
    const store = backend();
    await store.mkdir('/private');
    await store.writeText('/private/secret', 'x');
    await store.writeText('/readable', 'y');
    await store.chmod('/private', 0o000);

    const exported = value(await createSnapshot(store, { scope: 'full', now: 1 }));
    assert.deepEqual(exported.skipped, ['/private'], 'the export must name what it could not read');

    const decoded = value(decodeSnapshot(encodeSnapshot(exported)));
    assert.deepEqual(decoded.skipped, ['/private'], 'and the import must report it');
  });

  it('refuses a malformed skipped list rather than silently emptying it', () => {
    const entries: SnapshotEntry[] = [{ t: 'f', p: '/a', c: toBase64(new Uint8Array([1])) }];
    const forged = {
      format: SNAPSHOT_FORMAT,
      version: SNAPSHOT_VERSION,
      scope: 'full',
      createdAt: 1,
      seedTime: null,
      checksum: fnv1a32(JSON.stringify(entries)),
      entries,
      skipped: [{ not: 'a string' }],
    };
    const decoded = decodeSnapshot(new TextEncoder().encode(JSON.stringify(forged)));
    assert.equal(code(decoded), 'EINVAL');
  });
});

describe('restoreSnapshot', () => {
  it('will not let a crafted import mark the user own data as seed', async () => {
    // The exploit, end to end and on the route it actually travels: a document
    // declaring `scope: 'full'` is handed to `bootStorage` as the overlay, and
    // claims `s: 1` for a path the real seed has never heard of.
    //
    // Believed, the node lands with origin 'seed'. The NEXT overlay export then
    // omits its content — a seed node's content is the next boot's job to
    // rebuild — and the boot after that finds no such path in the seed and
    // files it under `dropped`. The user's own file, deleted two boots later,
    // by one flag. Every step below is asserted, because the middle of the
    // chain is where it looks harmless.
    const seed = buildSeed();
    const notes = `${HOME}/notes.txt`;
    const entries: SnapshotEntry[] = [
      {
        t: 'f',
        p: notes,
        c: toBase64(new TextEncoder().encode('my notes')),
        s: 1,
        m: 0o644,
        mt: 1_700_000_000_000,
      },
    ];
    const forged: SnapshotDocument = {
      format: SNAPSHOT_FORMAT,
      version: SNAPSHOT_VERSION,
      scope: 'full',
      createdAt: 1,
      seedTime: null,
      checksum: fnv1a32(JSON.stringify(entries)),
      entries,
      skipped: [],
    };

    const clock = fakeClock().now;
    const first = value(await bootStorage({ clock, seed, overlay: encodeSnapshot(forged) }));
    assert.deepEqual(first.restore?.failures, []);
    assert.equal(
      value(await first.backend.stat(notes)).origin,
      'user',
      'a snapshot may not promote a path the seed does not own',
    );

    // Link two: the overlay the page persists must still carry the content.
    const overlay = value(await createSnapshot(first.backend, { scope: 'overlay', now: 2, seed }));
    const row = overlay.entries.find((entry) => entry.p === notes);
    assert.ok(row !== undefined, 'the file must survive into the overlay');
    assert.ok(row.c !== undefined, 'and it must carry its content, not just its mode');

    // Link three: the boot after that gets the file back rather than dropping it.
    const second = value(
      await bootStorage({ clock, seed, overlay: encodeSnapshot({ ...overlay, skipped: [] }) }),
    );
    assert.deepEqual(second.restore?.dropped, [], 'the user file must not be dropped');
    assert.equal(value(await second.backend.readText(notes)), 'my notes');
  });

  it('does not grant seed origin to a path under a root prefix', async () => {
    // The gate keyed on the document's own path, but a restore with `root` puts
    // the node somewhere else. So a document legitimately claiming
    // `/etc/hostname` — a real seed path — restored under `root: '/tmp'`
    // produced a seed-origin `/tmp/etc/hostname`, which the seed has never
    // owned and will never rebuild. The lookup now uses the landing path.
    const seed = buildSeed();
    const store = backend();
    assert.ok((await store.installImage(seed)).ok);
    const entries: SnapshotEntry[] = [
      { t: 'd', p: '/etc', s: 1, m: 0o755 },
      { t: 'f', p: '/etc/hostname', c: toBase64(new TextEncoder().encode('pwned')), s: 1, m: 0o644 },
    ];
    const document: SnapshotDocument = {
      format: SNAPSHOT_FORMAT,
      version: SNAPSHOT_VERSION,
      scope: 'full',
      createdAt: 1,
      seedTime: null,
      checksum: fnv1a32(JSON.stringify(entries)),
      entries,
      skipped: [],
    };
    // /tmp is 1777 in the seed, so the write itself genuinely succeeds.
    const report = value(await restoreSnapshot(store, document, { seed, root: '/tmp' }));
    assert.deepEqual(report.failures, []);
    assert.equal(value(await store.stat('/tmp/etc')).origin, 'user');
    assert.equal(value(await store.stat('/tmp/etc/hostname')).origin, 'user');
    // The real seed node is untouched by any of this.
    assert.equal(value(await store.stat('/etc/hostname')).origin, 'seed');
  });

  it('honours s:1 when the seed spec really declares the path', async () => {
    const seed = buildSeed();
    // A seed file the VISITOR owns. `/etc/hostname` is root-owned, and a
    // user-level restore correctly cannot chmod it — that refusal is a
    // different (and already correct) rule, and would mask this one.
    const readme = `${HOME}/README.md`;
    const entries: SnapshotEntry[] = [{ t: 'f', p: readme, s: 1, m: 0o600, mt: 1_700_000_000_001 }];
    const document: SnapshotDocument = {
      format: SNAPSHOT_FORMAT,
      version: SNAPSHOT_VERSION,
      scope: 'overlay',
      createdAt: 1,
      seedTime: seed.time,
      checksum: fnv1a32(JSON.stringify(entries)),
      entries,
      skipped: [],
    };
    const clock = fakeClock().now;
    const booted = value(await bootStorage({ clock, seed, overlay: encodeSnapshot(document) }));
    assert.deepEqual(booted.restore?.dropped, []);
    assert.deepEqual(booted.restore?.failures, []);
    const stat = value(await booted.backend.stat(readme));
    assert.equal(stat.origin, 'seed', 'a path the seed declares keeps its seed origin');
    assert.equal(stat.mode, 0o600, 'and the user mode change is restored on top of it');
  });

  it('still honours s:1 for a path this build genuinely seeded', async () => {
    const store = backend();
    await store.installImage({
      time: 1_700_000_000_000,
      entries: [
        { path: '/etc', kind: 'directory', mode: 0o755, owner: 'root' },
        { path: '/etc/motd', kind: 'file', content: 'hello', mode: 0o644, owner: 'root' },
      ],
    });
    assert.equal(value(await store.stat('/etc/motd')).origin, 'seed');

    const entries: SnapshotEntry[] = [
      { t: 'd', p: '/etc', s: 1, m: 0o755, mt: 1_700_000_000_000 },
      { t: 'f', p: '/etc/motd', c: toBase64(new TextEncoder().encode('hello')), s: 1, m: 0o644, mt: 1_700_000_000_000 },
    ];
    const document: SnapshotDocument = {
      format: SNAPSHOT_FORMAT,
      version: SNAPSHOT_VERSION,
      scope: 'full',
      createdAt: 1,
      seedTime: null,
      checksum: fnv1a32(JSON.stringify(entries)),
      entries,
      skipped: [],
    };
    assert.ok((await restoreSnapshot(store, document)).ok);
    assert.equal(value(await store.stat('/etc/motd')).origin, 'seed', 'a real seed node stays a seed node');
  });
});

// ---------------------------------------------------------------------------
// Second review pass. Four more, all reproduced before they were fixed.
// ---------------------------------------------------------------------------

describe('installImage that fails part way', () => {
  it('re-authorises the byte total on the FAILING exit too', async () => {
    // The recompute sat on the last line of the happy path, so every early
    // return left `#used` stale — and `#checkCapacity` reads it. The first
    // entry lands, the second returns ENOTDIR, and the mount then believes it
    // holds nothing.
    const store = backend({ capacity: 100 });
    const installed = await store.installImage({
      time: 1_700_000_000_000,
      entries: [
        { path: '/big', kind: 'file', content: 'x'.repeat(90) },
        { path: '/big/under', kind: 'file', content: 'boom' },
      ],
    });
    assert.equal(code(installed), 'ENOTDIR', 'a file cannot be a path component');
    assert.equal(value(await store.quota()).used, 90, 'the bytes that DID land must be counted');
    // And the capacity check must act on that: 90 + 90 does not fit in 100.
    assert.equal(code(await store.writeText('/more', 'y'.repeat(90))), 'ENOSPC');
    assert.equal(value(await store.quota()).used, 90);
  });
});

describe('a directory that is writable but not searchable', () => {
  /** mode 0o644 on a DIRECTORY: rw-, no execute. Real Linux refuses entry creation. */
  const unsearchable = async (store: MemoryStorage): Promise<void> => {
    await store.mkdir('/e');
    await store.mkdir('/e/sub');
    await store.chmod('/e/sub', 0o644);
  };

  it('refuses mkdir BEFORE creating, not after', async () => {
    // `mkdir` checked only the write bit, so `#apply` created the node and the
    // trailing `stat` — which checks execute on every directory it crosses —
    // then failed. The caller got an Err for a mutation that had happened,
    // which is precisely the "Err means the tree is untouched" claim broken.
    const store = backend();
    await unsearchable(store);
    assert.equal(code(await store.mkdir('/e/sub/w')), 'EACCES');
    await store.chmod('/e/sub', 0o755);
    assert.deepEqual(value(await store.readdir('/e/sub')).map((row) => row.name), []);
  });

  it('refuses to plant an entry there through write or copy', async () => {
    // Both used to succeed, leaving files that could not be stat'd or removed.
    const store = backend();
    await unsearchable(store);
    await store.mkdir('/srcdir');
    await store.writeText('/srcdir/f', 'z');

    assert.equal(code(await store.writeText('/e/sub/planted', 'x')), 'EACCES');
    assert.equal(code(await store.copy('/srcdir', '/e/sub/c', { recursive: true })), 'EACCES');
    await store.chmod('/e/sub', 0o755);
    assert.deepEqual(value(await store.readdir('/e/sub')).map((row) => row.name), []);
  });

  it('still reports the missing bit as write when write is what is missing', async () => {
    // The order matters: every refusal that already said 'write' must keep
    // saying it, or the new check is a silent change to an existing contract.
    const store = backend();
    await store.mkdir('/locked');
    await store.chmod('/locked', 0o500);
    const refused = await store.mkdir('/locked/a');
    assert.ok(!refused.ok && refused.error.code === 'EACCES' && refused.error.required === 'write');
  });
});

describe('copy builds its own target paths', () => {
  it('refuses one past PATH_MAX instead of creating an unreachable node', async () => {
    // `#guardWrite` bounds `from` and `to`, but the planner CONSTRUCTS every
    // descendant path. A 2040-deep source under a long destination name made a
    // 4201-character path: created, then permanently unreachable, because
    // `stat` refuses it with ENAMETOOLONG.
    const store = backend();
    let deep = '';
    while (deep.length + 2 <= 4000) deep += '/a';
    await store.mkdir(deep, { recursive: true });
    await store.writeText(`${deep}/f`, 'deep');

    const target = `/${'p'.repeat(200)}`;
    assert.equal(code(await store.copy('/a', target, { recursive: true })), 'ENAMETOOLONG');
    assert.equal(await store.exists(target), false, 'and nothing is created');
  });
});
