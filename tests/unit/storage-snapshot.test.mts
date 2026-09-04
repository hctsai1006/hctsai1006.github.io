/**
 * Tests for export, import, and the seed/overlay graft.
 *
 * PR-09's risk section: "OPFS is deleted on site-data clear with no warning
 * from the browser; export/import must land in the same PR." So the claims
 * being defended are (a) a full export really does survive losing the store,
 * and (b) the overlay really does let a portfolio update reach a returning
 * visitor without eating the files they wrote.
 *
 * The refusals get as much attention as the successes. A restore that half-works
 * on a file it does not understand is worse than one that declines: the decline
 * is recoverable, and the user still has the file.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  HOME,
  MemoryStorage,
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  bootStorage,
  buildSeed,
  createSnapshot,
  decodeSnapshot,
  encodeSnapshot,
  exportSnapshot,
  fnv1a32,
  formatMode,
  fromBase64,
  importSnapshot,
  restoreSnapshot,
  toBase64,
} from '../../src/storage/index.ts';
import type {
  Result,
  SnapshotDocument,
  SnapshotEntry,
  StorageBackend,
} from '../../src/storage/index.ts';

const NOW = 1_700_000_000_000;
const clock = (): number => NOW;

function value<T>(outcome: Result<T>): T {
  assert.ok(outcome.ok, `expected success, got ${JSON.stringify(outcome)}`);
  return outcome.value;
}

function failureReason(outcome: Result<unknown>): string {
  assert.ok(!outcome.ok, 'expected a refusal');
  assert.equal(outcome.error.code, 'EINVAL');
  return outcome.error.code === 'EINVAL' ? outcome.error.reason : '';
}

/** Re-sign a mutated document so only the field under test is wrong. */
function sign(document: SnapshotDocument, entries: readonly SnapshotEntry[]): SnapshotDocument {
  return { ...document, entries, checksum: fnv1a32(JSON.stringify(entries)) };
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/** Every path in a tree, so two trees can be compared without walking twice. */
async function inventory(backend: StorageBackend, root = '/'): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (path: string): Promise<void> => {
    const rows = await backend.readdir(path);
    if (!rows.ok) return;
    for (const row of [...rows.value].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (row.stat.kind === 'directory') {
        out.set(row.stat.path, `d ${String(row.stat.mode)}`);
        await walk(row.stat.path);
      } else {
        const bytes = await backend.readBytes(row.stat.path);
        out.set(row.stat.path, bytes.ok ? `f ${String(row.stat.mode)} ${DECODER.decode(bytes.value)}` : 'f ?');
      }
    }
  };
  await walk(root);
  return out;
}

// ---------------------------------------------------------------------------

describe('base64', () => {
  it('round-trips every remainder length, including empty', () => {
    for (let length = 0; length < 40; length += 1) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) bytes[i] = (i * 37 + 11) & 0xff;
      const encoded = toBase64(bytes);
      assert.equal(encoded.length % 4, 0, `length ${String(length)} is not padded`);
      const decoded = fromBase64(encoded);
      assert.ok(decoded !== null, `length ${String(length)} failed to decode`);
      assert.deepEqual([...decoded], [...bytes], `length ${String(length)}`);
    }
  });

  it('round-trips every byte value', () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) all[i] = i;
    assert.deepEqual([...(fromBase64(toBase64(all)) ?? [])], [...all]);
  });

  it('agrees with the platform encoder, so the hand-rolled one is not merely self-consistent', () => {
    // A round-trip test passes for any bijection, including a wrong one. This
    // is what pins it to the actual base64 alphabet.
    const bytes = ENCODER.encode('hello 蔡 🐛');
    const reference = Buffer.from(bytes).toString('base64');
    assert.equal(toBase64(bytes), reference);
  });

  it('returns null rather than garbage for malformed input', () => {
    // The blob is user-editable; v1 learned to validate everything on the way
    // back in for the same reason.
    assert.equal(fromBase64('abc'), null);
    assert.equal(fromBase64('!!!!'), null);
    assert.equal(fromBase64('a b!'), null);
  });
});

describe('checksum', () => {
  it('is stable and changes when the payload does', () => {
    assert.equal(fnv1a32('hello'), fnv1a32('hello'));
    assert.notEqual(fnv1a32('hello'), fnv1a32('hellp'));
    assert.match(fnv1a32(''), /^[0-9a-f]{8}$/);
  });
});

describe('a full export', () => {
  it('survives losing the store entirely', async () => {
    const original = new MemoryStorage({ clock });
    await original.mkdir('/work/deep', { recursive: true });
    await original.writeText('/work/notes.md', '# notes\n蔡 🐛\n');
    await original.writeText('/work/deep/b.txt', 'bee', { mode: 0o600 });
    await original.writeBytes('/work/raw', new Uint8Array([0, 1, 254, 255]));

    const bytes = value(await exportSnapshot(original, { scope: 'full', now: NOW }));

    // The store is gone. This is the site-data clear the risk section is about.
    const rebuilt = new MemoryStorage({ clock });
    const report = value(await importSnapshot(rebuilt, bytes));
    assert.equal(report.failures.length, 0);

    assert.deepEqual(await inventory(rebuilt), await inventory(original));
    assert.deepEqual([...value(await rebuilt.readBytes('/work/raw'))], [0, 1, 254, 255]);
    assert.equal(value(await rebuilt.stat('/work/deep/b.txt')).mode, 0o600);
  });

  it('round-trips the seed/user origin, so the next overlay behaves the same', async () => {
    const seed = buildSeed();
    const booted = value(await bootStorage({ clock, seed }));
    await booted.vfs.writeText(`${HOME}/mine.md`, 'mine');
    const full = value(await exportSnapshot(booted.backend, { scope: 'full', now: NOW }));

    const rebuilt = new MemoryStorage({ clock });
    value(await importSnapshot(rebuilt, full));
    assert.equal(value(await rebuilt.stat(`${HOME}/README.md`)).origin, 'seed');
    assert.equal(value(await rebuilt.stat(`${HOME}/mine.md`)).origin, 'user');

    // And so an overlay taken from the restored tree carries the same paths as
    // one taken from the original. Losing origin would make the first overlay
    // after a disaster restore carry the entire seed.
    const before = value(await createSnapshot(booted.backend, { scope: 'overlay', now: NOW, seed }));
    const after = value(await createSnapshot(rebuilt, { scope: 'overlay', now: NOW, seed }));
    assert.deepEqual(
      after.entries.map((entry) => entry.p),
      before.entries.map((entry) => entry.p),
    );
  });

  it('produces identical bytes for identical trees', async () => {
    // A snapshot whose bytes depend on insertion order cannot be diffed, and
    // "did anything change since the last save?" becomes unanswerable.
    const build = async (order: readonly string[]): Promise<Uint8Array> => {
      const store = new MemoryStorage({ clock });
      for (const name of order) await store.writeText(`/${name}`, name);
      return value(await exportSnapshot(store, { scope: 'full', now: NOW }));
    };
    const forwards = await build(['a', 'b', 'c']);
    const backwards = await build(['c', 'b', 'a']);
    assert.deepEqual([...forwards], [...backwards]);
  });

  it('skips a subtree it cannot read instead of failing the whole export', async () => {
    const booted = value(await bootStorage({ clock }));
    const document = value(await createSnapshot(booted.backend, { scope: 'full', now: NOW }));
    // /root is 0o700 and root-owned. A visitor genuinely cannot read it, and
    // failing the export over it would mean nobody ever gets one.
    assert.ok(document.skipped.includes('/root'), JSON.stringify(document.skipped));
    assert.ok(document.entries.some((entry) => entry.p === '/etc/os-release'));
  });

  it('restores content, mode and mtime but not ownership', async () => {
    const source = new MemoryStorage({ clock });
    await source.installImage({
      time: 1_600_000_000_000,
      entries: [{ path: '/theirs.txt', kind: 'file', content: 'x', mode: 0o644, owner: 'root' }],
    });
    const bytes = value(await exportSnapshot(source, { scope: 'full', now: NOW }));

    const target = new MemoryStorage({ clock, user: 'visitor', group: 'visitor' });
    value(await importSnapshot(target, bytes));
    const restored = value(await target.stat('/theirs.txt'));
    // A restore runs as the user, through the ordinary write API. If it could
    // set ownership, a snapshot someone handed you could grant itself access.
    assert.equal(restored.owner, 'visitor');
    assert.equal(restored.mtime, 1_600_000_000_000);
    assert.equal(value(await target.readText('/theirs.txt')), 'x');
  });

  it('restores a directory mode without locking itself out of the tree', async () => {
    const source = new MemoryStorage({ clock });
    await source.mkdir('/vault');
    await source.writeText('/vault/secret', 'shh');
    await source.chmod('/vault', 0o500);
    const bytes = value(await exportSnapshot(source, { scope: 'full', now: NOW }));

    const target = new MemoryStorage({ clock });
    const report = value(await importSnapshot(target, bytes));
    // One pass would chmod /vault to 0o500 and then fail to write the file
    // inside it. Metadata is applied children-first, after everything exists.
    assert.deepEqual(report.failures, []);
    assert.equal(formatMode(value(await target.stat('/vault')).mode, 'directory'), 'dr-x------');
    assert.equal(value(await target.readText('/vault/secret')), 'shh');
  });

  it('restores a directory mtime that adding its children would have moved', async () => {
    const source = new MemoryStorage({ clock });
    await source.mkdir('/d');
    await source.writeText('/d/x', 'x');
    await source.utimes('/d', { mtime: 1_500_000_000_000 }, false);
    const bytes = value(await exportSnapshot(source, { scope: 'full', now: NOW }));

    const target = new MemoryStorage({ clock });
    value(await importSnapshot(target, bytes));
    // Stamping the directory before writing its child would have the child's
    // creation overwrite the stamp — which is how a restored tree ends up with
    // every directory dated "now".
    assert.equal(value(await target.stat('/d')).mtime, 1_500_000_000_000);
  });
});

describe('the seed and overlay', () => {
  it('carries user files and not seed content', async () => {
    const seed = buildSeed();
    const booted = value(await bootStorage({ clock, seed }));
    await booted.vfs.writeText(`${HOME}/mine.md`, 'my own file');

    const document = value(await createSnapshot(booted.backend, { scope: 'overlay', now: NOW, seed }));
    const paths = document.entries.map((entry) => entry.p);
    assert.ok(paths.includes(`${HOME}/mine.md`));
    assert.ok(!paths.includes(`${HOME}/README.md`), 'an untouched seed file must not be carried');
    assert.ok(!paths.includes('/etc/os-release'));

    const mine = document.entries.find((entry) => entry.p === `${HOME}/mine.md`);
    assert.ok(mine !== undefined && mine.c !== undefined);
    assert.equal(DECODER.decode(fromBase64(mine.c) ?? new Uint8Array()), 'my own file');
  });

  it('shows a returning visitor the NEW seed while keeping their files', async () => {
    // The whole reason the seed is rebuilt rather than persisted. v1 abandoned
    // the persist-everything model because a returning visitor stayed frozen on
    // the tree from the day they first loaded the page.
    const oldSeed = buildSeed({ readme: 'version one' });
    const first = value(await bootStorage({ clock, seed: oldSeed }));
    await first.vfs.writeText(`${HOME}/mine.md`, 'still here');
    const overlay = value(
      await exportSnapshot(first.backend, { scope: 'overlay', now: NOW, seed: oldSeed }),
    );

    const newSeed = buildSeed({ readme: 'version two, with a new file' });
    const second = value(await bootStorage({ clock, seed: newSeed, overlay }));

    assert.equal(value(await second.vfs.readText(`${HOME}/README.md`)), 'version two, with a new file');
    assert.equal(value(await second.vfs.readText(`${HOME}/mine.md`)), 'still here');
  });

  it('keeps a chmod on a seed file across a reboot', async () => {
    const seed = buildSeed();
    const first = value(await bootStorage({ clock, seed }));
    assert.ok((await first.vfs.chmod(`${HOME}/README.md`, 0o600)).ok);
    const overlay = value(await exportSnapshot(first.backend, { scope: 'overlay', now: NOW, seed }));

    const second = value(await bootStorage({ clock, seed, overlay }));
    // v1 records this precisely: without carrying the deviation, a chmod'd
    // seed file silently reverts on reload while `saved()` reported success.
    assert.equal(value(await second.vfs.stat(`${HOME}/README.md`)).mode, 0o600);
    assert.equal(value(await second.vfs.stat(`${HOME}/README.md`)).origin, 'seed');
  });

  it('does NOT persist the deletion of a seed file, and this is documented', async () => {
    // The known limitation the overlay format inherits from v1. Recorded as a
    // test so it is a decision rather than a surprise: the fix is tombstones,
    // which is a snapshot version 2.
    const seed = buildSeed();
    const first = value(await bootStorage({ clock, seed }));
    assert.ok((await first.vfs.remove(`${HOME}/README.md`)).ok);
    const overlay = value(await exportSnapshot(first.backend, { scope: 'overlay', now: NOW, seed }));

    const second = value(await bootStorage({ clock, seed, overlay }));
    assert.equal(await second.vfs.exists(`${HOME}/README.md`), true);
  });

  it('drops an overlay entry for a seed file the site has removed', async () => {
    const oldSeed = buildSeed({ documents: [{ path: 'projects/gone.md', content: 'old' }] });
    const first = value(await bootStorage({ clock, seed: oldSeed }));
    assert.ok((await first.vfs.chmod(`${HOME}/projects/gone.md`, 0o600)).ok);
    const overlay = value(
      await exportSnapshot(first.backend, { scope: 'overlay', now: NOW, seed: oldSeed }),
    );

    const newSeed = buildSeed();
    const second = value(await bootStorage({ clock, seed: newSeed, overlay }));
    // v1 materialises a file whose content reads "(seed content unavailable)",
    // which leaves a broken file in the home directory forever. If the site
    // removed it, it is gone — and the report says so.
    assert.ok(second.restore !== null);
    assert.ok(second.restore.dropped.includes(`${HOME}/projects/gone.md`));
    assert.equal(await second.vfs.exists(`${HOME}/projects/gone.md`), false);
  });

  it('lets the seed win when it replaced a user path with the other kind', async () => {
    const plainSeed = buildSeed();
    const first = value(await bootStorage({ clock, seed: plainSeed }));
    await first.vfs.mkdir(`${HOME}/notes`);
    await first.vfs.writeText(`${HOME}/notes/a.md`, 'a');
    const overlay = value(
      await exportSnapshot(first.backend, { scope: 'overlay', now: NOW, seed: plainSeed }),
    );

    // The site now ships a FILE at that path.
    const clashingSeed = buildSeed({ documents: [{ path: 'notes', content: 'now a file' }] });
    const second = value(await bootStorage({ clock, seed: clashingSeed, overlay }));
    assert.ok(second.restore !== null);
    assert.ok(second.restore.conflicts.includes(`${HOME}/notes`));
    assert.equal(value(await second.vfs.stat(`${HOME}/notes`)).kind, 'file');
  });

  it('restores as the user, so a crafted snapshot cannot write into /etc', async () => {
    const seed = buildSeed();
    const booted = value(await bootStorage({ clock, seed }));
    const document = value(await createSnapshot(booted.backend, { scope: 'overlay', now: NOW, seed }));
    const crafted = sign(document, [
      ...document.entries,
      { t: 'f', p: '/etc/evil', c: toBase64(ENCODER.encode('pwned')) },
    ]);

    const target = value(await bootStorage({ clock, seed }));
    const report = value(await restoreSnapshot(target.backend, crafted));
    assert.equal(await target.vfs.exists('/etc/evil'), false);
    assert.ok(report.failures.some((failure) => failure.path === '/etc/evil'));
    assert.equal(report.failures[0]?.error.code, 'EACCES');
  });
});

describe('refusing to restore', () => {
  async function baseline(): Promise<SnapshotDocument> {
    const store = new MemoryStorage({ clock });
    await store.writeText('/a.txt', 'a');
    return value(await createSnapshot(store, { scope: 'full', now: NOW }));
  }

  it('refuses bytes that are not a snapshot at all', () => {
    assert.equal(failureReason(decodeSnapshot(ENCODER.encode('not json'))), 'not-json');
    assert.equal(failureReason(decodeSnapshot(ENCODER.encode('[]'))), 'wrong-format');
    assert.equal(
      failureReason(decodeSnapshot(ENCODER.encode('{"format":"something.else"}'))),
      'wrong-format',
    );
  });

  it('refuses a version it does not understand rather than guessing', async () => {
    const document = await baseline();
    const future = encodeSnapshot({ ...document, version: SNAPSHOT_VERSION + 1 });
    const outcome = decodeSnapshot(future);
    assert.equal(failureReason(outcome), 'unsupported-version');
    assert.ok(!outcome.ok);
    // The message has to name both numbers, or the user cannot tell whether to
    // upgrade the page or find an older export.
    assert.match(outcome.error.message, new RegExp(String(SNAPSHOT_VERSION)));
    assert.match(outcome.error.message, new RegExp(String(SNAPSHOT_VERSION + 1)));

    // And an older one is refused too. Forward compatibility is not silently
    // assumed in either direction.
    assert.equal(failureReason(decodeSnapshot(encodeSnapshot({ ...document, version: 0 }))), 'unsupported-version');
  });

  it('refuses a corrupt payload', async () => {
    const document = await baseline();
    const tampered: SnapshotDocument = {
      ...document,
      entries: [...document.entries, { t: 'f', p: '/added', c: toBase64(ENCODER.encode('x')) }],
    };
    // Entries changed, checksum not recomputed: exactly what a truncated write
    // or a hand edit looks like.
    assert.equal(failureReason(decodeSnapshot(encodeSnapshot(tampered))), 'checksum-mismatch');
  });

  it('refuses a malformed entry', async () => {
    const document = await baseline();
    const cases: readonly [string, unknown][] = [
      ['relative path', { t: 'f', p: 'not-absolute' }],
      ['unknown kind', { t: 'l', p: '/x' }],
      ['mode out of range', { t: 'f', p: '/x', m: 0o10000 }],
      ['negative mtime', { t: 'f', p: '/x', mt: -1 }],
      ['not an object', 'nope'],
    ];
    for (const [label, entry] of cases) {
      const broken = sign(document, [entry as SnapshotEntry]);
      assert.equal(failureReason(decodeSnapshot(encodeSnapshot(broken))), 'bad-entry', label);
    }
  });

  it('refuses an unknown scope and a missing checksum', async () => {
    const document = await baseline();
    assert.equal(
      failureReason(
        decodeSnapshot(encodeSnapshot({ ...document, scope: 'partial' as SnapshotDocument['scope'] })),
      ),
      'unknown-scope',
    );
    const { checksum: _dropped, ...withoutChecksum } = document;
    assert.equal(
      failureReason(decodeSnapshot(ENCODER.encode(JSON.stringify(withoutChecksum)))),
      'no-checksum',
    );
  });

  it('writes nothing when it refuses', async () => {
    const document = await baseline();
    const store = new MemoryStorage({ clock });
    const refused = await importSnapshot(store, encodeSnapshot({ ...document, version: 99 }));
    assert.ok(!refused.ok);
    // All three refusals happen before a single node is touched.
    assert.deepEqual(value(await store.readdir('/')), []);
  });

  it('accepts what it just produced', async () => {
    const document = await baseline();
    const decoded = value(decodeSnapshot(encodeSnapshot(document)));
    assert.equal(decoded.format, SNAPSHOT_FORMAT);
    assert.equal(decoded.version, SNAPSHOT_VERSION);
    assert.deepEqual(decoded.entries, document.entries);
  });
});
