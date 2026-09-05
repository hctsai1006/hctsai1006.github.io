/**
 * opfs-conformance.test.mts — every row of the browser transcript, asserted
 * against the fake.
 *
 * THIS FILE HAS A TWIN. `tests/browser/opfs-backend.browser.mts` contains the
 * same expectations written against the real platform, so that when a browser
 * harness exists the two can be compared directly. A row that passes here and
 * fails there means the fake is wrong and the browser is right; that is the
 * whole reason both files are shaped the same way.
 *
 * The transcript these come from was captured on 2026-09-06 against
 * Chromium 152.0.0.0 (Playwright) on Windows NT 10.0 x64, inside a real
 * dedicated worker on an https origin. It is quoted in full in
 * `src/storage/opfs-platform.ts`.
 *
 * WHAT A GREEN RUN HERE PROVES: that the fake behaves the way one browser was
 * observed behaving, so the store built on top of it is being tested against
 * something with the right shape. WHAT IT DOES NOT PROVE: that Firefox or
 * Safari agree, or that any of it survives a real crash.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FakeOpfs } from './opfs-fake.mts';
import type { OpfsDirectory, OpfsSyncHandle } from '../../src/storage/opfs-platform.ts';
import { fnv1a32Bytes } from '../../src/storage/opfs-platform.ts';
import { fnv1a32 } from '../../src/storage/index.ts';

const TEXT = new TextEncoder();

async function thrown(run: () => unknown): Promise<string> {
  try {
    await run();
    return 'no-throw';
  } catch (cause) {
    const name = (cause as { name?: unknown }).name;
    return typeof name === 'string' ? name : 'not-a-dom-exception';
  }
}

async function scratch(): Promise<{ fake: FakeOpfs; dir: OpfsDirectory; handle: OpfsSyncHandle }> {
  const fake = new FakeOpfs();
  const dir = await fake.root.getDirectoryHandle('probe', { create: true });
  const file = await dir.getFileHandle('a.bin', { create: true });
  return { fake, dir, handle: await file.createSyncAccessHandle() };
}

// ---------------------------------------------------------------------------
// locking. This is the block PR-09's "two tabs cannot corrupt the tree" rests on.
// ---------------------------------------------------------------------------

describe('OPFS conformance: the exclusive lock on a file entry', () => {
  it('refuses a second sync access handle with NoModificationAllowedError', async () => {
    // MEASURED: "Access Handles cannot be created if there is another open
    // Access Handle or Writable stream". Same worker, a second worker, and a
    // second BROWSER TAB all produced this.
    const fake = new FakeOpfs();
    const dir = await fake.root.getDirectoryHandle('d', { create: true });
    const file = await dir.getFileHandle('a.bin', { create: true });
    const first = await file.createSyncAccessHandle();
    assert.equal(await thrown(() => file.createSyncAccessHandle()), 'NoModificationAllowedError');
    first.close();
    // And releasing it lets the next one in, which is what makes a tab that
    // closes cleanly hand the store over.
    const second = await file.createSyncAccessHandle();
    second.close();
  });

  it('refuses removeEntry on a file whose handle is open', async () => {
    // MEASURED: `NoModificationAllowedError`. Load-bearing twice over — the
    // store's own rollback file has to be closed before it can be deleted, and
    // `#writeRollbackCopy` closes it in a `finally` for exactly this reason.
    const fake = new FakeOpfs();
    const dir = await fake.root.getDirectoryHandle('d', { create: true });
    const file = await dir.getFileHandle('a.bin', { create: true });
    const handle = await file.createSyncAccessHandle();
    assert.equal(await thrown(() => dir.removeEntry('a.bin')), 'NoModificationAllowedError');
    handle.close();
    await dir.removeEntry('a.bin');
    assert.equal(fake.has(['d', 'a.bin']), false);
  });

  it('lets getFile through while a handle is open, and shows unflushed bytes', async () => {
    // MEASURED, and a CORRECTION to what the first probe seemed to show:
    // `getFile()` returns the unflushed bytes. Visibility is not gated on the
    // flush; durability is. See `SyncFile.flush`.
    const fake = new FakeOpfs();
    const dir = await fake.root.getDirectoryHandle('d', { create: true });
    const file = await dir.getFileHandle('a.bin', { create: true });
    const handle = await file.createSyncAccessHandle();
    handle.write(TEXT.encode('unflushed'), { at: 0 });
    const snapshot = await file.getFile();
    assert.equal(snapshot.size, 9);
    handle.close();
  });

  it('raises NotFoundError through a handle to a removed entry', async () => {
    // MEASURED for a removed file (reopen and getFile) and for a child of a
    // removed directory.
    const fake = new FakeOpfs();
    const dir = await fake.root.getDirectoryHandle('d', { create: true });
    const file = await dir.getFileHandle('gone.bin', { create: true });
    await dir.removeEntry('gone.bin');
    assert.equal(await thrown(() => file.createSyncAccessHandle()), 'NotFoundError');
    assert.equal(await thrown(() => file.getFile()), 'NotFoundError');

    const sub = await dir.getDirectoryHandle('deadsub', { create: true });
    await dir.removeEntry('deadsub', { recursive: true });
    assert.equal(await thrown(() => sub.getFileHandle('n', { create: true })), 'NotFoundError');
  });
});

// ---------------------------------------------------------------------------
// read / write / truncate
// ---------------------------------------------------------------------------

describe('OPFS conformance: FileSystemSyncAccessHandle', () => {
  it('write returns the byte count and getSize is immediate', async () => {
    // MEASURED: write -> 5, getSize() BEFORE any flush -> 5.
    const { handle } = await scratch();
    assert.equal(handle.write(TEXT.encode('hello'), { at: 0 }), 5);
    assert.equal(handle.getSize(), 5);
    handle.close();
  });

  it('read leaves the tail of an over-long buffer alone', async () => {
    // MEASURED: a 16-byte buffer over a 5-byte file returned 5 and the
    // remaining bytes were NOT zeroed. `SyncFile.read` allocates a fresh buffer
    // per call because of this; a reused one would hand stale bytes to a parser.
    const { handle } = await scratch();
    handle.write(TEXT.encode('hello'), { at: 0 });
    const buffer = new Uint8Array(8).fill(0xee);
    assert.equal(handle.read(buffer, { at: 0 }), 5);
    assert.deepEqual(Array.from(buffer.subarray(5)), [0xee, 0xee, 0xee]);
    handle.close();
  });

  it('reads at and past EOF return 0 rather than throwing', async () => {
    // MEASURED: at:5 on a 5-byte file -> 0; at:99 -> 0.
    const { handle } = await scratch();
    handle.write(TEXT.encode('hello'), { at: 0 });
    assert.equal(handle.read(new Uint8Array(4), { at: 5 }), 0);
    assert.equal(handle.read(new Uint8Array(4), { at: 99 }), 0);
    handle.close();
  });

  it('a write past the end zero-fills the gap', async () => {
    // MEASURED, byte for byte: write('X', {at:10}) on a 5-byte file gave
    // size 11 and [104,101,108,108,111,0,0,0,0,0,88].
    const { handle } = await scratch();
    handle.write(TEXT.encode('hello'), { at: 0 });
    assert.equal(handle.write(TEXT.encode('X'), { at: 10 }), 1);
    assert.equal(handle.getSize(), 11);
    const buffer = new Uint8Array(11);
    handle.read(buffer, { at: 0 });
    assert.deepEqual(Array.from(buffer), [104, 101, 108, 108, 111, 0, 0, 0, 0, 0, 88]);
    handle.close();
  });

  it('truncate grows with zeros and shrinks by dropping the tail', async () => {
    // MEASURED both directions.
    const { handle } = await scratch();
    handle.write(TEXT.encode('hello'), { at: 0 });
    handle.truncate(8);
    assert.equal(handle.getSize(), 8);
    const grown = new Uint8Array(8);
    handle.read(grown, { at: 0 });
    assert.deepEqual(Array.from(grown.subarray(5)), [0, 0, 0]);
    handle.truncate(3);
    assert.equal(handle.getSize(), 3);
    assert.equal(handle.read(new Uint8Array(8), { at: 0 }), 3);
    handle.close();
  });

  it('read with no `at` follows a file position cursor, not offset zero', async () => {
    // THE TRAP, MEASURED: `read(buffer)` returned 0 from a 3-byte file because
    // the previous read had advanced the cursor. SPEC: "If options["at"] exists,
    // let position be options["at"]. Otherwise, let position be handle's file
    // position cursor."
    //
    // Nothing in `src/` may rely on the cursor, and `SyncFile` passes `at`
    // everywhere. This test exists so the fake models the trap rather than
    // hiding it — a fake that defaulted `at` to 0 would make a forgotten `at`
    // pass here and fail in a browser.
    const { handle } = await scratch();
    handle.write(TEXT.encode('abc'), { at: 0 });
    assert.equal(handle.read(new Uint8Array(3), { at: 0 }), 3);
    assert.equal(handle.read(new Uint8Array(3)), 0, 'the cursor is at 3, not 0');
    handle.close();
  });

  it('rejects a negative offset with TypeError', async () => {
    // MEASURED: "Value is outside the 'unsigned long long' value range", both
    // for read({at:-1}) and for truncate(-1).
    const { handle } = await scratch();
    assert.equal(await thrown(() => handle.read(new Uint8Array(4), { at: -1 })), 'TypeError');
    assert.equal(await thrown(() => handle.truncate(-1)), 'TypeError');
    handle.close();
  });

  it('close is idempotent and every later call is InvalidStateError', async () => {
    // MEASURED: close() twice is fine; getSize/write/flush afterwards raise
    // InvalidStateError.
    const { handle } = await scratch();
    handle.close();
    handle.close();
    assert.equal(await thrown(() => handle.getSize()), 'InvalidStateError');
    assert.equal(await thrown(() => handle.write(new Uint8Array([1]), { at: 0 })), 'InvalidStateError');
    assert.equal(await thrown(() => handle.flush()), 'InvalidStateError');
  });

  it('an empty write and a zero-length read both return 0', async () => {
    // MEASURED.
    const { handle } = await scratch();
    assert.equal(handle.write(new Uint8Array(0), { at: 0 }), 0);
    assert.equal(handle.read(new Uint8Array(0), { at: 0 }), 0);
    handle.close();
  });

  it('raises QuotaExceededError when the origin is full', async () => {
    // MEASURED: writing one byte at offset 2**53-1 gave `QuotaExceededError`
    // with "No space available for this operation". That is the arm ENOSPC
    // actually arrives through.
    const fake = new FakeOpfs({ quota: 32 });
    const dir = await fake.root.getDirectoryHandle('d', { create: true });
    const file = await dir.getFileHandle('a.bin', { create: true });
    const handle = await file.createSyncAccessHandle();
    assert.equal(handle.write(new Uint8Array(16), { at: 0 }), 16);
    assert.equal(await thrown(() => handle.write(new Uint8Array(64), { at: 16 })), 'QuotaExceededError');
    handle.close();
  });
});

// ---------------------------------------------------------------------------
// names and directory operations
// ---------------------------------------------------------------------------

describe('OPFS conformance: names', () => {
  it('refuses the five names the spec and the platform both refuse', async () => {
    // MEASURED: '', '.', '..', 'a/b' and 'a\\b' are all TypeError "Name is not
    // allowed." SPEC: a valid file name "is not an empty string, is not equal to
    // '.' or '..', and does not contain '/' or any other character used as path
    // separator on the underlying platform" — the backslash is that last clause
    // on Windows.
    const fake = new FakeOpfs();
    for (const name of ['', '.', '..', 'a/b', 'a\\b']) {
      assert.equal(
        await thrown(() => fake.root.getFileHandle(name, { create: true })),
        'TypeError',
        `expected ${JSON.stringify(name)} to be refused`,
      );
    }
  });

  it('accepts names the store therefore never uses', async () => {
    // MEASURED as ACCEPTED, every one: ':' '*' '?' '|' '<' '"', a literal NUL,
    // 'CON', a trailing dot, a trailing space, 256 and 1024 characters, and a
    // lone surrogate that came back SILENTLY REPLACED with U+FFFD.
    //
    // This test asserts the fake is permissive here rather than that the store
    // relies on it. The store uses five fixed ASCII names precisely because the
    // surrogate replacement makes two distinct names collide into one entry
    // with no error anywhere, and because case folding is unspecified — 'Case'
    // and 'case' were distinct in Chromium and need not be elsewhere.
    const fake = new FakeOpfs();
    for (const name of ['a:b', 'a*b', 'a?b', 'a|b', 'a<b', 'a"b', 'CON', 'a.', 'a ', 'z'.repeat(1024)]) {
      const handle = await fake.root.getFileHandle(name, { create: true });
      assert.equal(handle.name, name);
    }
  });
});

describe('OPFS conformance: directory operations', () => {
  it('maps the four error names the store depends on', async () => {
    // MEASURED, all four.
    const fake = new FakeOpfs();
    const dir = await fake.root.getDirectoryHandle('d', { create: true });
    assert.equal(await thrown(() => dir.getFileHandle('nope')), 'NotFoundError');
    assert.equal(await thrown(() => dir.removeEntry('ghost')), 'NotFoundError');

    await dir.getDirectoryHandle('sub', { create: true });
    assert.equal(await thrown(() => dir.getFileHandle('sub')), 'TypeMismatchError');
    await dir.getFileHandle('leaf', { create: true });
    assert.equal(await thrown(() => dir.getDirectoryHandle('leaf')), 'TypeMismatchError');

    const nested = await dir.getDirectoryHandle('full', { create: true });
    await nested.getFileHandle('x', { create: true });
    assert.equal(await thrown(() => dir.removeEntry('full')), 'InvalidModificationError');
    await dir.removeEntry('full', { recursive: true });
    assert.equal(fake.has(['d', 'full']), false);
  });
});

// ---------------------------------------------------------------------------
// storage manager
// ---------------------------------------------------------------------------

describe('OPFS conformance: navigator.storage', () => {
  it('estimate reports usage and an optional quota', async () => {
    // MEASURED: { quota: 10737425705, usage: 7465, usageDetails: {...} }. Both
    // dictionary members are OPTIONAL in the IDL, which is why the fake can
    // omit `quota` and why `QuotaUsage.quota` is `number | null`.
    const fake = new FakeOpfs();
    const unbounded = await fake.estimate();
    assert.equal(unbounded.quota, undefined, 'an engine may decline to say');
    assert.equal(unbounded.usage, 0);

    fake.setQuota(1024);
    const dir = await fake.root.getDirectoryHandle('d', { create: true });
    const file = await dir.getFileHandle('a.bin', { create: true });
    const handle = await file.createSyncAccessHandle();
    handle.write(new Uint8Array(100), { at: 0 });
    handle.close();
    const bounded = await fake.estimate();
    assert.equal(bounded.quota, 1024);
    assert.equal(bounded.usage, 100);
  });

  it('persisted defaults to false', async () => {
    // MEASURED: `navigator.storage.persisted()` was false in the probe profile.
    const fake = new FakeOpfs();
    assert.equal(await fake.persisted(), false);
  });
});

// ---------------------------------------------------------------------------
// the checksum, which two files compute
// ---------------------------------------------------------------------------

describe('fnv1a32Bytes', () => {
  it('agrees with snapshot.ts for the same input', () => {
    // `snapshot.ts` hashes a STRING and returns hex; the WAL hashes BYTES and
    // returns the raw value, because a record's payload is already bytes.
    // Two implementations of one checksum drift; this is what stops them.
    for (const sample of ['', 'a', 'hello world', '{"id":"opfs-1"}', '中文-emoji']) {
      const bytes = new TextEncoder().encode(sample);
      assert.equal(
        fnv1a32Bytes(bytes).toString(16).padStart(8, '0'),
        fnv1a32(sample),
        `disagreed on ${JSON.stringify(sample)}`,
      );
    }
  });
});
