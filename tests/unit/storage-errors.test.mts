/**
 * Every error code in the union must be producible.
 *
 * This is the anti-decoration test. `types.ts` claims that `STORAGE_ERROR_CODES`
 * contains no member that nothing can raise, and the argument for that claim is
 * that an unreachable code makes callers write handling that is never exercised,
 * and makes the union look more finished than the implementation is. A comment
 * saying so is worth nothing; iterating the union and demanding a producer for
 * each member is worth something, and it fails loudly the day someone adds a
 * code speculatively.
 *
 * It also pins down which POSIX code each condition gets, which is the contract
 * the 28 commands map to PowerShell error records. `types.ts` records the
 * measurement behind that split: pwsh 7.6.5 gives the same condition a
 * different FullyQualifiedErrorId per command (New-Item alone uses two, with
 * two different categories), so the error id belongs to the command and the
 * condition belongs here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MemoryStorage,
  MountTable,
  NAME_MAX,
  STORAGE_ERROR_CODES,
  VirtualFileSystem,
  hasCode,
} from '../../src/storage/index.ts';
import type { Result, StorageError, StorageErrorCode } from '../../src/storage/index.ts';

const clock = (): number => 1_700_000_000_000;

function failure(outcome: Result<unknown>): StorageError {
  assert.ok(!outcome.ok, `expected a failure, got ${JSON.stringify(outcome)}`);
  return outcome.error;
}

/**
 * One producer per code, each a real operation on a real backend.
 *
 * Written as a Record over the union, so adding a code to
 * `STORAGE_ERROR_CODES` fails to compile until it has a producer here — the
 * same trick `kernel/capabilities.ts` uses to stop a capability being
 * introduced unclassified.
 */
const PRODUCERS: Record<StorageErrorCode, () => Promise<StorageError>> = {
  ENOENT: async () => {
    const store = new MemoryStorage({ clock });
    return failure(await store.stat('/nope'));
  },

  EEXIST: async () => {
    const store = new MemoryStorage({ clock });
    await store.mkdir('/d');
    return failure(await store.mkdir('/d'));
  },

  ENOTDIR: async () => {
    const store = new MemoryStorage({ clock });
    await store.writeText('/f', 'x');
    return failure(await store.stat('/f/inside'));
  },

  EISDIR: async () => {
    const store = new MemoryStorage({ clock });
    await store.mkdir('/d');
    return failure(await store.readBytes('/d'));
  },

  ENOTEMPTY: async () => {
    const store = new MemoryStorage({ clock });
    await store.mkdir('/d');
    await store.writeText('/d/x', 'x');
    return failure(await store.remove('/d'));
  },

  EACCES: async () => {
    const store = new MemoryStorage({ clock });
    await store.mkdir('/locked');
    await store.chmod('/locked', 0o000);
    return failure(await store.readdir('/locked'));
  },

  ENOSPC: async () => {
    const store = new MemoryStorage({ clock, capacity: 4 });
    return failure(await store.writeText('/big', 'xxxxxxxx'));
  },

  EINVAL: async () => {
    const store = new MemoryStorage({ clock });
    return failure(await store.stat('/a\u0000b'));
  },

  ENAMETOOLONG: async () => {
    const store = new MemoryStorage({ clock });
    return failure(await store.stat(`/${'x'.repeat(NAME_MAX + 1)}`));
  },

  EXDEV: async () => {
    const mounts = new MountTable(new MemoryStorage({ clock }));
    mounts.mount('Scratch', new MemoryStorage({ clock }));
    const vfs = new VirtualFileSystem(mounts, { home: '/', cwd: '/' });
    await vfs.writeText('/a', 'x');
    return failure(await vfs.rename('/a', 'Scratch:/a'));
  },

  EROFS: async () => {
    const store = new MemoryStorage({ clock, readOnly: true, name: 'frozen' });
    return failure(await store.writeText('/a', 'x'));
  },

  EIO: async () => {
    const store = new MemoryStorage({ clock, injectFault: () => 'the store was evicted' });
    return failure(await store.stat('/anything'));
  },
};

describe('the error union', () => {
  it('lists every code exactly once', () => {
    assert.equal(new Set(STORAGE_ERROR_CODES).size, STORAGE_ERROR_CODES.length);
  });

  for (const expected of STORAGE_ERROR_CODES) {
    it(`can actually produce ${expected}`, async () => {
      const produce = PRODUCERS[expected];
      const error = await produce();
      assert.equal(error.code, expected);
      // A code with no message and no syscall is a code a command cannot report.
      assert.ok(error.message.length > 0, 'the error has no message');
      assert.ok(error.syscall.length > 0, 'the error has no syscall');
      assert.ok(error.path.length > 0, 'the error has no path');
    });
  }

  it('carries the extra field each arm promises', async () => {
    const notEmpty = await PRODUCERS.ENOTEMPTY();
    assert.ok(hasCode(notEmpty, 'ENOTEMPTY') && notEmpty.entries === 1);

    const exists = await PRODUCERS.EEXIST();
    assert.ok(hasCode(exists, 'EEXIST') && exists.existing === 'directory');

    const denied = await PRODUCERS.EACCES();
    assert.ok(hasCode(denied, 'EACCES') && denied.required === 'read');

    const tooLong = await PRODUCERS.ENAMETOOLONG();
    assert.ok(hasCode(tooLong, 'ENAMETOOLONG') && tooLong.limit === NAME_MAX);
    assert.ok(hasCode(tooLong, 'ENAMETOOLONG') && tooLong.actual === NAME_MAX + 1);

    const notDir = await PRODUCERS.ENOTDIR();
    assert.ok(hasCode(notDir, 'ENOTDIR') && notDir.component.length > 0);

    const crossMount = await PRODUCERS.EXDEV();
    assert.ok(hasCode(crossMount, 'EXDEV') && crossMount.from === '/a');
    assert.ok(hasCode(crossMount, 'EXDEV') && crossMount.to === 'Scratch:\\a');

    const readOnly = await PRODUCERS.EROFS();
    assert.ok(hasCode(readOnly, 'EROFS') && readOnly.mount === 'frozen');

    const device = await PRODUCERS.EIO();
    assert.ok(hasCode(device, 'EIO') && device.cause === 'the store was evicted');

    const full = await PRODUCERS.ENOSPC();
    assert.ok(hasCode(full, 'ENOSPC') && full.usage.quota === 4);

    const invalid = await PRODUCERS.EINVAL();
    assert.ok(hasCode(invalid, 'EINVAL') && invalid.reason === 'nul-in-name');
  });

  it('is plain data, so it can cross a worker boundary', async () => {
    // The OPFS backend has to postMessage this out of a dedicated worker.
    // A class instance or an Error subclass would not survive structured
    // clone with its fields intact, which is why StorageError is a union of
    // object types and not an exception hierarchy.
    for (const expected of STORAGE_ERROR_CODES) {
      const produce = PRODUCERS[expected];
      const error = await produce();
      assert.equal(Object.getPrototypeOf(error), Object.prototype, expected);
      assert.ok(!(error instanceof Error), expected);
      const cloned = structuredClone(error);
      assert.deepEqual(cloned, error, expected);
    }
  });
});
