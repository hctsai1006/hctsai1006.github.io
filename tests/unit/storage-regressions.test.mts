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
  RecordingJournal,
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  bootStorage,
  buildSeed,
  createSnapshot,
  decodeSnapshot,
  encodeSnapshot,
  exportSnapshot,
  fnv1a32,
  importSnapshot,
  restoreSnapshot,
  snapshotPayload,
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
 * Sign a document the way `createSnapshot` does. Version 2 covers the whole
 * document, not just `entries`, so a fixture that hand-rolls the old hash is
 * indistinguishable from a tampered file — which is the point.
 */
function signed(unsigned: Omit<SnapshotDocument, 'checksum'>): SnapshotDocument {
  return { ...unsigned, checksum: fnv1a32(snapshotPayload(unsigned)) };
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
    const journal = new RecordingJournal();
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
// RecordingJournal.pending(), across a serialisation boundary
// ---------------------------------------------------------------------------

describe('RecordingJournal.pending', () => {
  it('matches on plan identity, not object identity', async () => {
    // A durable journal replays DESERIALISED plans, so `Array.includes` on the
    // object reference reports every committed plan as still pending. Replacing
    // pending() with `return ok([])` killed zero tests before this one existed.
    const journal = new RecordingJournal();
    const store = backend({ journal });
    await store.writeText('/a', 'hello');
    assert.deepEqual(await journal.pending(), { ok: true, value: [] });

    const [written] = journal.written;
    assert.ok(written !== undefined);
    const roundTripped = JSON.parse(JSON.stringify({ ...written, steps: [] })) as typeof written;
    const replayed = new RecordingJournal();
    await replayed.write(written);
    await replayed.commit(roundTripped);
    assert.deepEqual(await replayed.pending(), { ok: true, value: [] }, 'a deserialised plan is the same plan');
  });

  it('gives every plan a distinct id', async () => {
    const journal = new RecordingJournal();
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
    // A fifty-fold difference, and the claim is about COMPLEXITY — the walk is
    // O(tree) per write, so the whole loop is O(n squared) — not about latency.
    //
    // IT USED TO ASSERT AN ABSOLUTE TIME (`elapsed < 800`) AND IT FLAKED.
    // Measured on this machine at the commit that introduced it, ten runs of
    // this file alone, milliseconds:
    //
    //     386  418  503  277  397  1567  499  435  357  290
    //
    // Two over the bound in five, one at nearly twice it, with nothing wrong.
    // Under the full suite — seventy files in parallel processes — it is worse.
    // A gate that fails when the machine is busy is a gate people learn to
    // re-run, which is the same as not having it.
    //
    // So it measures the RATIO instead, which is what the claim was always
    // about. Both halves run on the same machine at the same load, so the noise
    // that made the absolute bound useless cancels. The defect makes this ~50;
    // fixed it is about 1; the bound is 6, which no amount of scheduling noise
    // reaches and no version of the defect survives.
    const N = 8000;
    const body = 'x'.repeat(10);

    const checked = backend({ capacity: 10_000_000 });
    const checkedStart = performance.now();
    for (let index = 0; index < N; index += 1) {
      await checked.writeText(`/f${String(index)}`, body);
    }
    const checkedMs = performance.now() - checkedStart;

    const unchecked = backend();
    const uncheckedStart = performance.now();
    for (let index = 0; index < N; index += 1) {
      await unchecked.writeText(`/f${String(index)}`, body);
    }
    // A floor of one millisecond, so a run fast enough to measure as zero
    // divides into a ratio rather than into infinity.
    const uncheckedMs = Math.max(1, performance.now() - uncheckedStart);

    const ratio = checkedMs / uncheckedMs;
    assert.ok(
      ratio < 6,
      `capacity-checked writes were ${ratio.toFixed(1)}x the unchecked ones ` +
        `(${checkedMs.toFixed(0)} ms against ${uncheckedMs.toFixed(0)} ms). ` +
        'The capacity check is walking the tree again.',
    );
    assert.equal(value(await checked.quota()).used, 80_000);
    assert.equal(value(await unchecked.quota()).used, 80_000);
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
    const forged = signed({
      format: SNAPSHOT_FORMAT,
      version: SNAPSHOT_VERSION,
      scope: 'full',
      createdAt: 1,
      seedTime: null,
      entries,
      skipped: [],
    });

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
    // Passed through UNTOUCHED. `{ ...overlay, skipped: [] }` used to work here
    // and no longer does: from version 2 the checksum covers `skipped` too, so
    // editing any field without re-signing is a refusal. The real overlay names
    // /root as skipped, because a visitor cannot read a root-owned 0o700 tree.
    assert.deepEqual(overlay.skipped, ['/root']);
    const second = value(await bootStorage({ clock, seed, overlay: encodeSnapshot(overlay) }));
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
    const document = signed({
      format: SNAPSHOT_FORMAT,
      version: SNAPSHOT_VERSION,
      scope: 'full',
      createdAt: 1,
      seedTime: null,
      entries,
      skipped: [],
    });
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
    const document = signed({
      format: SNAPSHOT_FORMAT,
      version: SNAPSHOT_VERSION,
      scope: 'overlay',
      createdAt: 1,
      seedTime: seed.time,
      entries,
      skipped: [],
    });
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
    const document = signed({
      format: SNAPSHOT_FORMAT,
      version: SNAPSHOT_VERSION,
      scope: 'full',
      createdAt: 1,
      seedTime: null,
      entries,
      skipped: [],
    });
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

// ---------------------------------------------------------------------------
// Third review pass: arm (e). Both pre-existing, both silent data loss.
// ---------------------------------------------------------------------------

describe('editing a seed file', () => {
  it('keeps the edit across a reboot, instead of silently reverting it', async () => {
    // No attacker in this one. `~/README.md` ships in the seed, owned by the
    // visitor at 0o644, so writing to it succeeds — and then the seed/overlay
    // contract threw the edit away: the node kept `origin: 'seed'`, so the
    // overlay recorded its metadata WITHOUT content, and the next boot's
    // `installImage` put the original bytes back. `failures: []` throughout.
    const seed = buildSeed();
    const clock = fakeClock().now;
    const first = value(await bootStorage({ clock, seed }));
    const readme = `${HOME}/README.md`;
    const mine = '# MY OWN EDIT, an hour of work\n';
    assert.ok((await first.vfs.writeText(readme, mine)).ok);
    assert.equal(
      value(await first.backend.stat(readme)).origin,
      'user',
      'writing content to a seed file makes it the user’s',
    );

    const overlay = value(await createSnapshot(first.backend, { scope: 'overlay', now: 2, seed }));
    const row = overlay.entries.find((entry) => entry.p === readme);
    assert.ok(row !== undefined && row.c !== undefined, 'the overlay must carry the edited content');

    const second = value(await bootStorage({ clock, seed, overlay: encodeSnapshot(overlay) }));
    assert.deepEqual(second.restore?.failures, []);
    assert.equal(value(await second.backend.readText(readme)), mine, 'the edit must survive the reboot');
  });

  it('still lets a metadata-only change stay a small seed entry', async () => {
    // The other half of the trade: `chmod` and `utimes` go through `set-meta`
    // and must NOT claim the file, or every touched seed file would start
    // carrying its whole content in the overlay.
    const seed = buildSeed();
    const clock = fakeClock().now;
    const booted = value(await bootStorage({ clock, seed }));
    const readme = `${HOME}/README.md`;
    assert.ok((await booted.vfs.chmod(readme, 0o600)).ok);
    assert.equal(value(await booted.backend.stat(readme)).origin, 'seed');

    const overlay = value(await createSnapshot(booted.backend, { scope: 'overlay', now: 2, seed }));
    const row = overlay.entries.find((entry) => entry.p === readme);
    assert.ok(row !== undefined);
    assert.equal(row.s, 1, 'it is still a seed node');
    assert.equal(row.c, undefined, 'and carries no content');
    assert.equal(row.m, 0o600, 'only the mode the user changed');
  });
});

describe('the checksum covers what the restore acts on', () => {
  it('refuses a document whose scope was flipped after signing', async () => {
    // `scope` decides what `s: 1` MEANS — restore the metadata and let the seed
    // own the content, or materialise this entry with `c ?? empty`. Version 1
    // hashed `entries` alone, so changing the single word `overlay` to `full`
    // in a stored overlay was accepted and TRUNCATED every seed file it named.
    const seed = buildSeed();
    const clock = fakeClock().now;
    const booted = value(await bootStorage({ clock, seed }));
    const readme = `${HOME}/README.md`;
    const original = value(await booted.backend.readText(readme));
    assert.ok(original.length > 0);
    await booted.vfs.utimes(readme, { mtime: 1_650_000_000_000 });

    const overlay = value(await createSnapshot(booted.backend, { scope: 'overlay', now: 2, seed }));
    assert.ok(overlay.entries.some((entry) => entry.p === readme && entry.s === 1 && entry.c === undefined));

    const tampered = { ...overlay, scope: 'full' as const };
    const decoded = decodeSnapshot(encodeSnapshot(tampered));
    assert.ok(!decoded.ok && decoded.error.code === 'EINVAL');
    assert.ok(!decoded.ok && decoded.error.code === 'EINVAL' && decoded.error.reason === 'checksum-mismatch');

    // And the boot that would have applied it refuses rather than truncating.
    assert.ok(!(await bootStorage({ clock, seed, overlay: encodeSnapshot(tampered) })).ok);
    assert.equal(value(await booted.backend.readText(readme)), original);
  });

  it('gives the two scopes different checksums for identical entries', async () => {
    const entries: SnapshotEntry[] = [{ t: 'f', p: '/a', s: 1 }];
    const base = {
      format: SNAPSHOT_FORMAT,
      version: SNAPSHOT_VERSION,
      createdAt: 1,
      seedTime: null,
      entries,
      skipped: [],
    } as const;
    const asOverlay = fnv1a32(snapshotPayload({ ...base, scope: 'overlay' }));
    const asFull = fnv1a32(snapshotPayload({ ...base, scope: 'full' }));
    assert.notEqual(asOverlay, asFull, 'scope must change the checksum');
  });
});

// ---------------------------------------------------------------------------
// Fourth pass. Two of these are the previous pass's fixes being incomplete.
// ---------------------------------------------------------------------------

describe('every verb that overwrites a seed file claims it', () => {
  // The previous fix went into `#write` only, so `copy` still lost the data.
  // MEASURED across all four verbs through a real two-boot cycle: writeText,
  // appendText and rename survived; copy came back as the seed's text.
  const verbs = ['writeText', 'appendText', 'copy', 'rename'] as const;
  for (const verb of verbs) {
    it(`survives a reboot after ${verb}`, async () => {
      const seed = buildSeed();
      const clock = fakeClock().now;
      const first = value(await bootStorage({ clock, seed }));
      const readme = `${HOME}/README.md`;
      const mine = `# VIA ${verb}, an hour of work\n`;

      if (verb === 'writeText') {
        assert.ok((await first.vfs.writeText(readme, mine)).ok);
      } else if (verb === 'appendText') {
        assert.ok((await first.vfs.writeText(readme, '')).ok);
        assert.ok((await first.vfs.appendText(readme, mine)).ok);
      } else {
        assert.ok((await first.vfs.writeText(`${HOME}/mine.md`, mine)).ok);
        const source = `${HOME}/mine.md`;
        assert.ok(
          verb === 'copy'
            ? (await first.vfs.copy(source, readme, { overwrite: true })).ok
            : (await first.vfs.rename(source, readme, { overwrite: true })).ok,
        );
      }

      assert.equal(value(await first.backend.stat(readme)).origin, 'user', 'the node is the user’s now');
      const overlay = value(await createSnapshot(first.backend, { scope: 'overlay', now: 2, seed }));
      const row = overlay.entries.find((entry) => entry.p === readme);
      assert.ok(row !== undefined && row.c !== undefined, 'the overlay must carry the content');

      const second = value(await bootStorage({ clock, seed, overlay: encodeSnapshot(overlay) }));
      assert.equal(value(await second.backend.readText(readme)), mine);
    });
  }
});

describe('a contentless file entry is never materialised', () => {
  it('does not truncate even when the scope flip is re-signed', async () => {
    // Widening the checksum only raised the cost of the edit to one line:
    // `snapshotPayload` is exported and FNV-1a is not a MAC, so re-signing is
    // trivial and the truncation came straight back. The guard that actually
    // closes it does not depend on the document's integrity at all.
    const seed = buildSeed();
    const clock = fakeClock().now;
    const booted = value(await bootStorage({ clock, seed }));
    const readme = `${HOME}/README.md`;
    const original = value(await booted.backend.readText(readme));
    assert.ok(original.length > 0);
    await booted.vfs.utimes(readme, { mtime: 1_650_000_000_000 });

    const overlay = value(await createSnapshot(booted.backend, { scope: 'overlay', now: 2, seed }));
    const row = overlay.entries.find((entry) => entry.p === readme);
    assert.ok(row !== undefined && row.s === 1 && row.c === undefined);

    const { checksum: _discarded, ...rest } = overlay;
    const tampered = { ...rest, scope: 'full' as const };
    const resigned: SnapshotDocument = { ...tampered, checksum: fnv1a32(snapshotPayload(tampered)) };
    // It decodes — a recomputed checksum is a valid checksum, and this file has
    // never claimed otherwise.
    assert.ok(decodeSnapshot(encodeSnapshot(resigned)).ok);

    const after = value(await bootStorage({ clock, seed, overlay: encodeSnapshot(resigned) }));
    assert.equal(
      value(await after.backend.readText(readme)),
      original,
      'the seed content must be intact, not truncated to empty',
    );
  });
});

describe('the signer and the verifier are the same function', () => {
  it('round-trips a document this build wrote, whatever the clock did', async () => {
    // `createSnapshot` signed the raw timestamps and `decodeSnapshot`
    // normalised before hashing, so a build with a broken clock produced
    // documents its own decoder called corrupt — sending anyone debugging it
    // to look for bit rot. `now` and `seed.time` are unconstrained numbers.
    for (const [label, now, seedTime] of [
      ['now=1', 1, null],
      ['now=0', 0, null],
      ['now=-1', -1, null],
      ['now=NaN', Number.NaN, null],
      ['now=Infinity', Number.POSITIVE_INFINITY, null],
      ['seed.time=0', 1, 0],
      ['seed.time=-1', 1, -1],
    ] as const) {
      const store = backend();
      const exported = value(
        await exportSnapshot(store, {
          scope: 'full',
          now,
          ...(seedTime === null ? {} : { seed: { time: seedTime, entries: [] } }),
        }),
      );
      assert.ok(decodeSnapshot(exported).ok, `${label} produced a document this build refuses`);
    }
  });
});

describe('the exporter never writes what the importer refuses', () => {
  it('survives an mtime the format cannot represent', async () => {
    // `utimes` stores mtime 0 — the epoch, an ordinary date — and `isSaneTime`
    // wants > 0, so ONE `touch -d @0` made the user's entire backup
    // undecodable: the export succeeded, so they believed they had one.
    const store = backend();
    await store.writeText('/keep', 'important user data');
    await store.writeText('/odd', 'also important');
    assert.ok((await store.utimes('/odd', { mtime: 0 }, false)).ok);
    assert.equal(value(await store.stat('/odd')).mtime, 0);

    const exported = value(await exportSnapshot(store, { scope: 'full', now: 1 }));
    const decoded = decodeSnapshot(exported);
    assert.ok(decoded.ok, 'the whole document must still decode');

    const rebuilt = backend();
    assert.ok((await importSnapshot(rebuilt, exported)).ok);
    assert.equal(value(await rebuilt.readText('/keep')), 'important user data');
    assert.equal(value(await rebuilt.readText('/odd')), 'also important', 'the content survives');
  });

  it('survives a mode the format cannot represent', async () => {
    // `chmod` stores any number; `isSaneMode` caps at 0o7777. 0o10644 is still
    // readable, so the file is exported rather than skipped, and the entry then
    // failed validation on the way back in.
    const store = backend();
    await store.writeText('/keep', 'important user data');
    await store.writeText('/f', 'x');
    assert.ok((await store.chmod('/f', 0o10644)).ok);

    const exported = value(await exportSnapshot(store, { scope: 'full', now: 1 }));
    assert.ok(decodeSnapshot(exported).ok, 'the whole document must still decode');
    const rebuilt = backend();
    assert.ok((await importSnapshot(rebuilt, exported)).ok);
    assert.equal(value(await rebuilt.readText('/keep')), 'important user data');
  });

  it('still carries mode and mtime when they are representable', async () => {
    // The guard must drop only the unrepresentable value, never the ordinary one.
    const store = backend();
    await store.writeText('/f', 'x', { mode: 0o600 });
    await store.utimes('/f', { mtime: 1_650_000_000_000 }, false);
    const exported = value(await createSnapshot(store, { scope: 'full', now: 1 }));
    const row = exported.entries.find((entry) => entry.p === '/f');
    assert.ok(row !== undefined);
    assert.equal(row.m, 0o600);
    assert.equal(row.mt, 1_650_000_000_000);
  });
});

describe('renaming a seed node away', () => {
  it('keeps a renamed seed FILE across a reboot', async () => {
    // The third sibling of the same defect. `#apply`'s move branch relocates
    // the node and never touched origin, so `mv ~/README.md ~/README.bak` left
    // README.bak marked seed; the overlay recorded it as `s: 1` with no
    // content, and the next boot dropped it. The file was gone and `~/projects`
    // was back where it started, so the move did not even stick.
    const seed = buildSeed();
    const clock = fakeClock().now;
    const first = value(await bootStorage({ clock, seed }));
    const original = value(await first.vfs.readText(`${HOME}/README.md`));
    assert.ok((await first.vfs.rename(`${HOME}/README.md`, `${HOME}/README.bak`)).ok);
    assert.equal(value(await first.backend.stat(`${HOME}/README.bak`)).origin, 'user');

    const overlay = value(await createSnapshot(first.backend, { scope: 'overlay', now: 2, seed }));
    const second = value(await bootStorage({ clock, seed, overlay: encodeSnapshot(overlay) }));
    assert.deepEqual(second.restore?.dropped, []);
    assert.equal(value(await second.backend.readText(`${HOME}/README.bak`)), original);
  });

  it('keeps a renamed seed DIRECTORY, including an empty one, with its own mode', async () => {
    // A renamed directory used to survive only as a side effect of its children
    // being restored with `createParents: true` — so its own mode and mtime
    // were lost, and an EMPTY one disappeared altogether.
    const seed = buildSeed();
    const clock = fakeClock().now;
    const first = value(await bootStorage({ clock, seed }));
    assert.ok((await first.vfs.rename(`${HOME}/projects`, `${HOME}/work`)).ok);
    assert.ok((await first.vfs.chmod(`${HOME}/work`, 0o750)).ok);
    assert.deepEqual(value(await first.vfs.readdir(`${HOME}/work`)), [], 'the seed ships it empty');

    const overlay = value(await createSnapshot(first.backend, { scope: 'overlay', now: 2, seed }));
    const second = value(await bootStorage({ clock, seed, overlay: encodeSnapshot(overlay) }));
    assert.deepEqual(second.restore?.dropped, []);
    const moved = value(await second.backend.stat(`${HOME}/work`));
    assert.equal(moved.kind, 'directory', 'an empty renamed directory must not vanish');
    assert.equal(moved.mode, 0o750, 'and it keeps the mode the user gave it');
  });
});

describe('a node claiming seed origin that the seed never declared', () => {
  it('is exported with its content, so the next boot does not drop it', async () => {
    // `WriteOptions.origin` is public, so a caller can mark its OWN file as a
    // seed node. Believed by the exporter, the overlay recorded it with no
    // content and the next boot dropped it — the same forgery the s:1 import
    // gate refuses, arriving by the direct route. The exporter now applies the
    // same authority check.
    const seed = buildSeed();
    const clock = fakeClock().now;
    const first = value(await bootStorage({ clock, seed }));
    const forged = `${HOME}/forged.md`;
    assert.ok((await first.vfs.writeText(forged, 'my data', { origin: 'seed' })).ok);

    const overlay = value(await createSnapshot(first.backend, { scope: 'overlay', now: 2, seed }));
    const row = overlay.entries.find((entry) => entry.p === forged);
    assert.ok(row !== undefined, 'it must be exported');
    assert.equal(row.s, undefined, 'not as a seed node');
    assert.ok(row.c !== undefined, 'and with its content');

    const second = value(await bootStorage({ clock, seed, overlay: encodeSnapshot(overlay) }));
    assert.deepEqual(second.restore?.dropped, []);
    assert.equal(value(await second.backend.readText(forged)), 'my data');
  });

  it('still exports a REAL seed node as a contentless seed entry', async () => {
    // The control: the whole point of the overlay is that a genuine seed file
    // costs a handful of bytes, not its whole content.
    const seed = buildSeed();
    const clock = fakeClock().now;
    const booted = value(await bootStorage({ clock, seed }));
    const readme = `${HOME}/README.md`;
    assert.ok((await booted.vfs.chmod(readme, 0o600)).ok);
    const overlay = value(await createSnapshot(booted.backend, { scope: 'overlay', now: 2, seed }));
    const row = overlay.entries.find((entry) => entry.p === readme);
    assert.ok(row !== undefined);
    assert.equal(row.s, 1);
    assert.equal(row.c, undefined);
  });
});

// ---------------------------------------------------------------------------
// buffer ownership: a resolved write must not still depend on the caller's array
// ---------------------------------------------------------------------------

describe('buffer ownership', () => {
  // MEASURED against the code before the fix. `writeBytes` queued the caller's
  // array, `#apply` stored that same array, and `#newFile` kept what it was
  // handed:
  //
  //     const input = new Uint8Array([65, 66]);
  //     await st.writeBytes('/file', input);   // resolves
  //     input[0] = 90;
  //     await st.readBytes('/file')  ->  [90, 66]
  //
  // A stored file changed with no syscall, no mtime bump, no journal record and
  // no quota accounting. Every guarantee about mutations being planned,
  // validated and applied was one assignment away from being bypassed.
  //
  // The tests below walk the MATRIX rather than the one path the defect was
  // demonstrated on, because that is how this repository has been bitten
  // before: `writeBytes` and `appendBytes` reach different arms of `#write`
  // (overwrite versus create), `copy` builds its own step, and `readBytes` is
  // the same defect facing the other way.
  //
  // WHICH OF THESE ARE LOAD-BEARING, measured by reverting each fix and
  // watching the suite, rather than assumed:
  //
  //   revert `own()` in #writeEntry only   -> 3 red (the first, second, fourth)
  //   revert `own()` in readBytes only     -> 0 red
  //   revert `own()` in the copy planner   -> 0 red
  //   revert all three                     -> 5 red (the two above join in)
  //
  // The read and copy sites are DEFENCE IN DEPTH, and this comment says so
  // rather than letting five green tests imply five independent guarantees.
  // They are unreachable today only because owning at the write boundary makes
  // every stored array a plain `Uint8Array`, whose `.slice()` does copy. That
  // is a property of one line in another method; the moment a byte array
  // reaches `MemoryFile.data` by some other route — a replayed journal step, a
  // seed built from something other than `TextEncoder` — the `.slice()`s become
  // live defects again. Two ends of one ownership rule should not be enforced
  // by two different mechanisms.

  it('writeBytes: mutating the caller array afterwards does not change the file', async () => {
    const store = backend();
    const input = new Uint8Array([65, 66]);
    assert.ok((await store.writeBytes('/file', input)).ok);
    input[0] = 90;
    assert.deepEqual(Array.from(value(await store.readBytes('/file'))), [65, 66]);
  });

  it('appendBytes onto a MISSING file: the create arm owns its bytes too', async () => {
    // A different branch of `#write`: `existing === undefined` builds a
    // `create-file` step, so fixing only the overwrite arm leaves this open.
    const store = backend();
    const input = new Uint8Array([1, 2]);
    assert.ok((await store.appendBytes('/new', input)).ok);
    input[0] = 99;
    assert.deepEqual(Array.from(value(await store.readBytes('/new'))), [1, 2]);
  });

  it('appendBytes onto an EXISTING file: unaffected, and that is the control', async () => {
    // Green before the fix as well as after: the append-onto-existing arm goes
    // through `concat`, which allocates. Kept because "this arm was always
    // fine" is a claim worth holding still — if `concat` is ever optimised into
    // an in-place grow, this is what notices.
    const store = backend();
    assert.ok((await store.writeBytes('/f', new Uint8Array([1]))).ok);
    const input = new Uint8Array([2, 3]);
    assert.ok((await store.appendBytes('/f', input)).ok);
    input[0] = 77;
    assert.deepEqual(Array.from(value(await store.readBytes('/f'))), [1, 2, 3]);
  });

  it('writeBytes accepts a Buffer without aliasing it', async () => {
    // A Node `Buffer` IS a `Uint8Array` and satisfies the signature. It is also
    // exactly what any caller that read a file off disk will hand over.
    const store = backend();
    const buffer = Buffer.from([7, 8, 9]);
    assert.ok((await store.writeBytes('/buf', buffer)).ok);
    buffer[0] = 200;
    assert.deepEqual(Array.from(value(await store.readBytes('/buf'))), [7, 8, 9]);
  });

  it('readBytes hands back a copy, even when the stored array came in as a Buffer', async () => {
    // The other direction, and a defect the review that found the write side
    // did not name. `readBytes` returned `data.slice()`, and
    // `Buffer.prototype.slice` is an alias for `subarray` — a VIEW. MEASURED
    // before the fix:
    //
    //     await st.writeBytes('/buf', Buffer.from([7, 8, 9]));
    //     const a = await st.readBytes('/buf');  a.value[0] = 200;
    //     await st.readBytes('/buf')  ->  [200, 8, 9]
    const store = backend();
    assert.ok((await store.writeBytes('/buf', Buffer.from([7, 8, 9]))).ok);
    const first = value(await store.readBytes('/buf'));
    first[0] = 200;
    assert.deepEqual(Array.from(value(await store.readBytes('/buf'))), [7, 8, 9]);
  });

  it('copy does not alias the destination to the source', async () => {
    // `#planCopy` used `node.data.slice()`, which aliases for a Buffer. Two
    // files sharing one array means a read of either can be written through to
    // the other. Both ends are now `own()`, and this pins the pair.
    const store = backend();
    assert.ok((await store.writeBytes('/a', Buffer.from([1, 2, 3]))).ok);
    assert.ok((await store.copy('/a', '/b')).ok);
    const fromA = value(await store.readBytes('/a'));
    fromA[0] = 250;
    assert.deepEqual(Array.from(value(await store.readBytes('/b'))), [1, 2, 3]);
    assert.deepEqual(Array.from(value(await store.readBytes('/a'))), [1, 2, 3]);
  });

  it('writeText is unaffected, which is the control', async () => {
    const store = backend();
    assert.ok((await store.writeText('/t', 'hello')).ok);
    assert.equal(value(await store.readText('/t')), 'hello');
  });
});

// ---------------------------------------------------------------------------
// the default journal must not retain payloads
// ---------------------------------------------------------------------------

describe('NullJournal retention', () => {
  // MEASURED against the code before the fix. `NullJournal` pushed every plan
  // onto two arrays that nothing ever cleared, and `MemoryStorage` installs it
  // BY DEFAULT. `MutationStep.data` is file content, so every version of every
  // file written in the process stayed reachable. Sixteen overwrites of one
  // 64 KiB file, then `remove('/big')`, then `reset()`:
  //
  //     plans retained in journal.written   : 17
  //     plans retained in journal.committed : 17
  //     distinct payload buffers referenced : 16
  //     bytes still referenced              : 1,048,576
  //     live file exists                    : false
  //     quota.used reports                  : 0
  //
  // A megabyte pinned and invisible to the accounting that is meant to be the
  // authority on this backend's footprint, for an empty filesystem.

  it('reports nothing pending after an uncommitted write', async () => {
    // The semantic claim, and the one that goes red if the retention comes
    // back: a store that cannot survive an interruption has nothing for a log
    // to recover to, so there is never anything pending. Before the fix this
    // returned the plan.
    //
    // The payload here is 8 bytes, not the 64 KiB of the measurement above,
    // and deliberately: on the FAILURE path `assert.deepEqual` formats the
    // whole array for its diff, and a 64 KiB payload turned a red test into a
    // 78-second hang. A test that fails slowly is a test people stop running.
    const journal = new NullJournal();
    const plan = {
      id: 'test-1',
      syscall: 'write' as const,
      steps: [{ op: 'create-file' as const, path: '/x', data: new Uint8Array(8) }],
      byteDelta: 8,
    };
    assert.ok((await journal.write(plan)).ok);
    assert.deepEqual(await journal.pending(), { ok: true, value: [] });
  });

  it('exposes no accessor that could hold a payload', () => {
    // Structural, and deliberately so. The leak was not a behaviour anyone
    // could observe through `MutationJournal`; it was two fields kept for a
    // test's benefit. Asserting the accessors are gone is what stops them being
    // added back "just for debugging".
    const journal = new NullJournal();
    assert.equal('written' in journal, false);
    assert.equal('committed' in journal, false);
  });

  it('a default store reports an empty filesystem after churn — a control', async () => {
    // GREEN BEFORE THE FIX TOO, and it is listed as a control rather than
    // dressed up as coverage. It exercises the shape the leak was measured on —
    // sixteen overwrites, a remove, a default journal — and asserts everything
    // this test can honestly reach.
    //
    // WHAT IS NOT TESTED, stated so nobody assumes it is: that the bytes are
    // released. Proving that needs the garbage collector, and every way to ask
    // it from a test — `WeakRef` polling, heap-usage thresholds — is a
    // stopwatch race dressed as an assertion. This repository already has one
    // timing-sensitive test and it flakes under a parallel suite. The two tests
    // above are the ones that go red when the retention returns; this one holds
    // the surrounding behaviour still.
    const store = backend();
    const payload = new Uint8Array(64 * 1024).fill(3);
    for (let index = 0; index < 16; index += 1) {
      assert.ok((await store.writeBytes('/big', payload)).ok);
    }
    assert.ok((await store.remove('/big')).ok);
    assert.equal(value(await store.quota()).used, 0);
    assert.equal(await store.exists('/big'), false);
  });

  it('RecordingJournal still records, because tests depend on it', async () => {
    // The other half of the split. If someone ever "simplifies" this into
    // NullJournal, the seam tests above lose their subject silently.
    const journal = new RecordingJournal();
    const store = backend({ journal });
    assert.ok((await store.writeText('/a', 'hello')).ok);
    assert.equal(journal.written.length, 1);
    assert.equal(journal.committed.length, 1);
    journal.clear();
    assert.equal(journal.written.length, 0);
  });
});
