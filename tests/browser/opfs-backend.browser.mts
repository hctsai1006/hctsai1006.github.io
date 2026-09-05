/**
 * opfs-backend.browser.mts — the same expectations as the fake's conformance
 * suite, run against the real platform.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS SEPARATELY FROM THE UNIT TESTS
 * ---------------------------------------------------------------------------
 *
 * `tests/unit/opfs-conformance.test.mts` asserts a list of platform behaviours
 * against `tests/unit/opfs-fake.mts`. That proves the fake matches what one
 * browser was OBSERVED doing on one day; it cannot prove it still does, and it
 * cannot say anything at all about Firefox or Safari.
 *
 * This file is the same list, written against `navigator.storage`. Run it and
 * any row where the fake and the platform disagree fails HERE — and the browser
 * is right. That is the only way a fake stays honest.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT NEEDS IN ORDER TO RUN
 * ---------------------------------------------------------------------------
 *
 *   1. A DEDICATED WORKER. Not a Window, not a SharedWorker.
 *      `createSyncAccessHandle()` is `[Exposed=DedicatedWorker, SecureContext]`
 *      and this suite calls it directly. `runOpfsBrowserSuite` refuses to run
 *      anywhere else rather than reporting a pile of confusing failures.
 *   2. A SECURE CONTEXT: an https origin, or http://localhost.
 *   3. The `src/storage/` modules reachable as ES modules from that worker.
 *      They are plain TypeScript with erasable syntax only (the project sets
 *      `erasableSyntaxOnly`), so type-stripping is a sufficient transform — no
 *      bundler is required, and `tsc --module esnext` emit works.
 *
 * It deliberately does NOT depend on a test framework, a runner, or a
 * particular harness. It exports one function returning a plain array of
 * results, so whatever lands on `feat/browser` can call it and render the rows
 * however it likes:
 *
 *     import { runOpfsBrowserSuite } from './opfs-backend.browser.mts';
 *     const rows = await runOpfsBrowserSuite();
 *     const failed = rows.filter((row) => !row.ok);
 *
 * ---------------------------------------------------------------------------
 * WHAT IT STILL CANNOT PROVE
 * ---------------------------------------------------------------------------
 *
 * That flushed bytes survive a browser process being killed. Nothing short of
 * killing one proves that, and a test that kills its own browser cannot report
 * its result. `flush()` is called where durability is claimed because that is
 * what `flush` means, and that remains the one load-bearing assumption in this
 * layer taken from the specification rather than from a measurement.
 */

import { mountOpfsStorage } from '../../src/storage/index.ts';
import type { SeedSpec } from '../../src/storage/index.ts';
import type { OpfsDirectory, OpfsStorageManager } from '../../src/storage/opfs-platform.ts';

export interface BrowserCheck {
  readonly name: string;
  readonly ok: boolean;
  /** Why it failed, or what it observed. Always present on a failure. */
  readonly detail?: string;
}

const TEXT = new TextEncoder();

/** The directory this suite works in. Removed and recreated on every run. */
const SCRATCH = 'browsershell-conformance';

class Checks {
  readonly rows: BrowserCheck[] = [];

  async run(name: string, body: () => Promise<void> | void): Promise<void> {
    try {
      await body();
      this.rows.push({ name, ok: true });
    } catch (cause) {
      this.rows.push({
        name,
        ok: false,
        detail: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
      });
    }
  }

  equal(actual: unknown, expected: unknown, what: string): void {
    if (!Object.is(actual, expected)) {
      throw new Error(`${what}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
  }

  deepEqual(actual: readonly number[], expected: readonly number[], what: string): void {
    if (actual.length !== expected.length || actual.some((byte, index) => byte !== expected[index])) {
      throw new Error(`${what}: got [${actual.join(',')}], expected [${expected.join(',')}]`);
    }
  }
}

/** The exception name a call raises, or 'no-throw'. Names, not classes; see `exceptionName`. */
async function raises(body: () => unknown): Promise<string> {
  try {
    await body();
    return 'no-throw';
  } catch (cause) {
    const name = (cause as { name?: unknown }).name;
    return typeof name === 'string' ? name : 'not-a-dom-exception';
  }
}

/**
 * True only in a dedicated worker.
 *
 * `WorkerGlobalScope` exists in a SharedWorker too, so the discriminator is
 * `DedicatedWorkerGlobalScope`. Checking for `createSyncAccessHandle` instead
 * would be checking the thing under test.
 */
function inDedicatedWorker(): boolean {
  return (
    typeof DedicatedWorkerGlobalScope !== 'undefined' &&
    (globalThis as unknown as { constructor?: { name?: string } }).constructor?.name ===
      'DedicatedWorkerGlobalScope'
  );
}

const SEED: SeedSpec = {
  time: 1_600_000_000_000,
  entries: [
    { path: '/', kind: 'directory', mode: 0o755 },
    { path: '/home', kind: 'directory', mode: 0o755 },
    { path: '/home/me', kind: 'directory', mode: 0o755, owner: 'me', group: 'me' },
    { path: '/home/me/README.md', kind: 'file', content: 'seeded', owner: 'me', group: 'me' },
  ],
};

/**
 * Run everything. Returns one row per check; never throws.
 *
 * The scratch directory is removed first, so a previous run's leftovers cannot
 * make a check pass or fail for the wrong reason. The store test uses its own
 * directory under it for the same reason.
 */
export async function runOpfsBrowserSuite(): Promise<readonly BrowserCheck[]> {
  const checks = new Checks();

  if (!inDedicatedWorker()) {
    return [
      {
        name: 'environment',
        ok: false,
        detail:
          'this suite must run inside a DEDICATED worker: createSyncAccessHandle is ' +
          '[Exposed=DedicatedWorker, SecureContext], so a Window or a SharedWorker cannot call it',
      },
    ];
  }

  const manager = navigator.storage as unknown as OpfsStorageManager & {
    getDirectory(): Promise<OpfsDirectory>;
  };
  const origin = await manager.getDirectory();
  try {
    await origin.removeEntry(SCRATCH, { recursive: true });
  } catch {
    // Not there. The ordinary case on a clean profile.
  }
  const root = await origin.getDirectoryHandle(SCRATCH, { create: true });

  // -------------------------------------------------------------------------
  // the exclusive lock, which is what "two tabs cannot corrupt the tree" rests on
  // -------------------------------------------------------------------------

  await checks.run('a second sync access handle is NoModificationAllowedError', async () => {
    const dir = await root.getDirectoryHandle('lock', { create: true });
    const file = await dir.getFileHandle('a.bin', { create: true });
    const first = await file.createSyncAccessHandle();
    try {
      checks.equal(
        await raises(() => file.createSyncAccessHandle()),
        'NoModificationAllowedError',
        'a second handle on the same entry',
      );
    } finally {
      first.close();
    }
    const second = await file.createSyncAccessHandle();
    second.close();
  });

  await checks.run('removeEntry on a file with an open handle is refused', async () => {
    const dir = await root.getDirectoryHandle('lock2', { create: true });
    const file = await dir.getFileHandle('a.bin', { create: true });
    const handle = await file.createSyncAccessHandle();
    try {
      checks.equal(
        await raises(() => dir.removeEntry('a.bin')),
        'NoModificationAllowedError',
        'removeEntry while a handle is open',
      );
    } finally {
      handle.close();
    }
    await dir.removeEntry('a.bin');
  });

  await checks.run('getFile is allowed while a handle is open, and sees unflushed bytes', async () => {
    // The CORRECTION. An earlier reading of the transcript had this as
    // "visible only after flush". It is visible immediately; flush is about
    // durability. If this row ever fails, the comment in `SyncFile.flush` is
    // what has to change.
    const dir = await root.getDirectoryHandle('vis', { create: true });
    const file = await dir.getFileHandle('a.bin', { create: true });
    const handle = await file.createSyncAccessHandle();
    try {
      handle.write(TEXT.encode('unflushed'), { at: 0 });
      const snapshot = await file.getFile();
      checks.equal(snapshot.size, 9, 'getFile before any flush');
    } finally {
      handle.close();
    }
  });

  await checks.run('a handle to a removed entry raises NotFoundError', async () => {
    const dir = await root.getDirectoryHandle('gone', { create: true });
    const file = await dir.getFileHandle('a.bin', { create: true });
    await dir.removeEntry('a.bin');
    checks.equal(await raises(() => file.createSyncAccessHandle()), 'NotFoundError', 'reopen');
    checks.equal(await raises(() => file.getFile()), 'NotFoundError', 'getFile');

    const sub = await dir.getDirectoryHandle('sub', { create: true });
    await dir.removeEntry('sub', { recursive: true });
    checks.equal(
      await raises(() => sub.getFileHandle('n', { create: true })),
      'NotFoundError',
      'a child of a removed directory',
    );
  });

  // -------------------------------------------------------------------------
  // read / write / truncate
  // -------------------------------------------------------------------------

  const scratchHandle = async (name: string): Promise<FileSystemSyncAccessHandle> => {
    const dir = await root.getDirectoryHandle('rw', { create: true });
    const file = await dir.getFileHandle(name, { create: true });
    const handle = await file.createSyncAccessHandle();
    handle.truncate(0);
    return handle;
  };

  await checks.run('write returns its byte count and getSize is immediate', async () => {
    const handle = await scratchHandle('a.bin');
    try {
      checks.equal(handle.write(TEXT.encode('hello'), { at: 0 }), 5, 'write');
      checks.equal(handle.getSize(), 5, 'getSize before flush');
    } finally {
      handle.close();
    }
  });

  await checks.run('read leaves the tail of an over-long buffer alone', async () => {
    const handle = await scratchHandle('b.bin');
    try {
      handle.write(TEXT.encode('hello'), { at: 0 });
      const buffer = new Uint8Array(8).fill(0xee);
      checks.equal(handle.read(buffer, { at: 0 }), 5, 'bytes read');
      checks.deepEqual(Array.from(buffer.subarray(5)), [0xee, 0xee, 0xee], 'the untouched tail');
    } finally {
      handle.close();
    }
  });

  await checks.run('reads at and past EOF return 0', async () => {
    const handle = await scratchHandle('c.bin');
    try {
      handle.write(TEXT.encode('hello'), { at: 0 });
      checks.equal(handle.read(new Uint8Array(4), { at: 5 }), 0, 'at EOF');
      checks.equal(handle.read(new Uint8Array(4), { at: 99 }), 0, 'past EOF');
    } finally {
      handle.close();
    }
  });

  await checks.run('a write past the end zero-fills the gap', async () => {
    const handle = await scratchHandle('d.bin');
    try {
      handle.write(TEXT.encode('hello'), { at: 0 });
      checks.equal(handle.write(TEXT.encode('X'), { at: 10 }), 1, 'the gap write');
      checks.equal(handle.getSize(), 11, 'size after the gap write');
      const buffer = new Uint8Array(11);
      handle.read(buffer, { at: 0 });
      checks.deepEqual(
        Array.from(buffer),
        [104, 101, 108, 108, 111, 0, 0, 0, 0, 0, 88],
        'the zero-filled gap',
      );
    } finally {
      handle.close();
    }
  });

  await checks.run('truncate grows with zeros and shrinks by dropping the tail', async () => {
    const handle = await scratchHandle('e.bin');
    try {
      handle.write(TEXT.encode('hello'), { at: 0 });
      handle.truncate(8);
      checks.equal(handle.getSize(), 8, 'grown size');
      const grown = new Uint8Array(8);
      handle.read(grown, { at: 0 });
      checks.deepEqual(Array.from(grown.subarray(5)), [0, 0, 0], 'the zero padding');
      handle.truncate(3);
      checks.equal(handle.getSize(), 3, 'shrunk size');
      checks.equal(handle.read(new Uint8Array(8), { at: 0 }), 3, 'read after shrink');
    } finally {
      handle.close();
    }
  });

  await checks.run('read with no `at` follows the file position cursor', async () => {
    // THE TRAP. If this row ever changes, `SyncFile` must still pass `at`
    // everywhere — the point is that the default is not zero.
    const handle = await scratchHandle('f.bin');
    try {
      handle.write(TEXT.encode('abc'), { at: 0 });
      checks.equal(handle.read(new Uint8Array(3), { at: 0 }), 3, 'the absolute read');
      checks.equal(handle.read(new Uint8Array(3)), 0, 'the cursor is at 3, not 0');
    } finally {
      handle.close();
    }
  });

  await checks.run('a negative offset is a TypeError', async () => {
    const handle = await scratchHandle('g.bin');
    try {
      checks.equal(await raises(() => handle.read(new Uint8Array(4), { at: -1 })), 'TypeError', 'read');
      checks.equal(await raises(() => handle.truncate(-1)), 'TypeError', 'truncate');
    } finally {
      handle.close();
    }
  });

  await checks.run('close is idempotent and later calls are InvalidStateError', async () => {
    const handle = await scratchHandle('h.bin');
    handle.close();
    handle.close();
    checks.equal(await raises(() => handle.getSize()), 'InvalidStateError', 'getSize');
    checks.equal(await raises(() => handle.write(new Uint8Array([1]), { at: 0 })), 'InvalidStateError', 'write');
    checks.equal(await raises(() => handle.flush()), 'InvalidStateError', 'flush');
  });

  await checks.run('an empty write and a zero-length read both return 0', async () => {
    const handle = await scratchHandle('i.bin');
    try {
      checks.equal(handle.write(new Uint8Array(0), { at: 0 }), 0, 'empty write');
      checks.equal(handle.read(new Uint8Array(0), { at: 0 }), 0, 'zero-length read');
    } finally {
      handle.close();
    }
  });

  await checks.run('a write past the quota is QuotaExceededError', async () => {
    // The arm ENOSPC actually arrives through. A real origin quota is
    // gigabytes, so this reaches it by offset rather than by volume.
    const handle = await scratchHandle('j.bin');
    try {
      checks.equal(
        await raises(() => handle.write(new Uint8Array([1]), { at: Number.MAX_SAFE_INTEGER })),
        'QuotaExceededError',
        'a write past the end of the world',
      );
    } finally {
      handle.close();
    }
  });

  // -------------------------------------------------------------------------
  // names and directories
  // -------------------------------------------------------------------------

  await checks.run('the five refused names are refused', async () => {
    for (const name of ['', '.', '..', 'a/b', 'a\\b']) {
      const outcome = await raises(() => root.getFileHandle(name, { create: true }));
      if (outcome !== 'TypeError') {
        // A POSIX-hosted engine may well ACCEPT 'a\\b', since the spec says
        // "any other character used as path separator on the underlying
        // platform". That is a legitimate difference, and it is reported here
        // rather than treated as a failure of the store: the store uses fixed
        // ASCII names precisely so that no engine's answer matters.
        if (name === 'a\\b') continue;
        throw new Error(`${JSON.stringify(name)} was ${outcome}, expected TypeError`);
      }
    }
  });

  await checks.run('a lone surrogate in a name is silently replaced', async () => {
    // The measurement that ruled out mirroring the virtual tree into OPFS: two
    // distinct virtual names can become one entry with no error anywhere.
    const dir = await root.getDirectoryHandle('names', { create: true });
    const handle = await dir.getFileHandle('a\uD800b', { create: true });
    checks.equal(handle.name, 'a�b', 'the stored name');
  });

  await checks.run('the four directory error names', async () => {
    const dir = await root.getDirectoryHandle('dirs', { create: true });
    checks.equal(await raises(() => dir.getFileHandle('nope')), 'NotFoundError', 'missing file');
    checks.equal(await raises(() => dir.removeEntry('ghost')), 'NotFoundError', 'missing entry');
    await dir.getDirectoryHandle('sub', { create: true });
    checks.equal(await raises(() => dir.getFileHandle('sub')), 'TypeMismatchError', 'directory as file');
    await dir.getFileHandle('leaf', { create: true });
    checks.equal(await raises(() => dir.getDirectoryHandle('leaf')), 'TypeMismatchError', 'file as directory');
    const full = await dir.getDirectoryHandle('full', { create: true });
    await full.getFileHandle('x', { create: true });
    checks.equal(
      await raises(() => dir.removeEntry('full')),
      'InvalidModificationError',
      'non-empty directory',
    );
    await dir.removeEntry('full', { recursive: true });
  });

  // -------------------------------------------------------------------------
  // navigator.storage
  // -------------------------------------------------------------------------

  await checks.run('estimate reports numbers and persisted answers', async () => {
    const estimate = await manager.estimate();
    if (typeof estimate.usage !== 'number') throw new Error('estimate() reported no usage');
    if (estimate.quota !== undefined && typeof estimate.quota !== 'number') {
      throw new Error('estimate() reported a non-numeric quota');
    }
    if (manager.persisted !== undefined) {
      const persisted = await manager.persisted();
      if (typeof persisted !== 'boolean') throw new Error('persisted() did not answer with a boolean');
    }
  });

  // -------------------------------------------------------------------------
  // the store itself, end to end, on the real platform
  // -------------------------------------------------------------------------

  await checks.run('the store mounts, writes, and the write survives a remount', async () => {
    const clock = ((): (() => number) => {
      let value = 1_700_000_000_000;
      return () => {
        value += 1;
        return value;
      };
    })();

    const first = await mountOpfsStorage({
      root,
      directory: 'store',
      clock,
      seed: SEED,
      user: 'me',
      manager,
    });
    if (!first.ok) throw new Error(`the first mount failed: ${first.error.message}`);
    const written = await first.value.backend.writeText('/home/me/notes.txt', 'durable');
    if (!written.ok) throw new Error(`the write failed: ${written.error.message}`);
    const checkpointed = await first.value.backend.checkpoint();
    if (!checkpointed.ok) throw new Error(`the checkpoint failed: ${checkpointed.error.message}`);
    first.value.store.close();

    const second = await mountOpfsStorage({
      root,
      directory: 'store',
      clock,
      seed: SEED,
      user: 'me',
      manager,
    });
    if (!second.ok) throw new Error(`the second mount failed: ${second.error.message}`);
    const back = await second.value.backend.readText('/home/me/notes.txt');
    if (!back.ok) throw new Error(`the read failed: ${back.error.message}`);
    checks.equal(back.value, 'durable', 'the file after a remount');
    checks.equal(second.value.recovery.slot !== null, true, 'a checkpoint slot was found');
    // The seed is rebuilt from code, not restored from the checkpoint.
    const seeded = await second.value.backend.readText('/home/me/README.md');
    if (!seeded.ok) throw new Error(`the seed file was missing: ${seeded.error.message}`);
    checks.equal(seeded.value, 'seeded', 'the seed file');
    second.value.store.close();
  });

  await checks.run('a second mount is refused while the first holds the store', async () => {
    // The platform's own exclusion, exercised through the store rather than
    // through a bare handle: this is PR-09's "two tabs cannot corrupt the tree"
    // with no Web Locks involved at all.
    const clock = (): number => 1_700_000_000_000;
    const first = await mountOpfsStorage({
      root,
      directory: 'exclusive',
      clock,
      seed: SEED,
      user: 'me',
      manager,
    });
    if (!first.ok) throw new Error(`the first mount failed: ${first.error.message}`);
    try {
      const second = await mountOpfsStorage({
        root,
        directory: 'exclusive',
        clock,
        seed: SEED,
        user: 'me',
        manager,
      });
      checks.equal(second.ok, false, 'the second mount');
      checks.equal(second.ok ? '' : second.error.code, 'EIO', 'the code the platform refusal maps to');
    } finally {
      first.value.store.close();
    }
  });

  await checks.run('leader election tells the second asker it is a follower', async () => {
    // Web Locks IS available in a dedicated worker — measured — and this is the
    // orderly half of the two-tab story.
    const { requestLeadership } = await import('../../src/storage/opfs.ts');
    const first = await requestLeadership(navigator.locks, 'browsershell-conformance-lock');
    checks.equal(first.granted, true, 'the first asker');
    const second = await requestLeadership(navigator.locks, 'browsershell-conformance-lock');
    checks.equal(second.granted, false, 'the second asker');
    first.release();
    await first.done;
  });

  // Leave the profile as it was found.
  try {
    await origin.removeEntry(SCRATCH, { recursive: true });
  } catch {
    // A handle somewhere is still open, or the entry is already gone. Neither
    // changes a result that has already been recorded.
  }

  return checks.rows;
}
