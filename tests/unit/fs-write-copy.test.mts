/**
 * Copy-Item and cp.
 *
 * The two tests that matter most are at the bottom: the quota failure partway
 * through a nine-file copy, and the directory copied into its own subtree.
 * `copy-item.ts` claims a specific state after a partial failure and a specific
 * divergence from pwsh; both are asserted here rather than described.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { copyItem, cp } from '../../src/commands/fs-write/index.ts';
import { HOME, errorIds, prop, session, typeNamesOf } from './fs-write-harness.mts';
import type { Session } from './fs-write-harness.mts';

/** `src/` with a file at the top and one in a subdirectory. */
async function withTree(s: Session): Promise<void> {
  await s.write(`${HOME}/src/a.txt`, 'A');
  await s.write(`${HOME}/src/sub/b.txt`, 'B');
}

describe('Copy-Item', () => {
  it('emits nothing, and -PassThru emits the DESTINATION', async () => {
    // pwsh: emitted 0 without -PassThru; with it, one System.IO.FileInfo whose
    // ToString() is the destination path.
    const s = await session();
    await s.write(`${HOME}/f1.txt`, 'one');

    const quiet = await s.run(copyItem, { Path: 'f1.txt', Destination: 'f2.txt' });
    assert.deepEqual(quiet.values, []);
    assert.equal(await s.text(`${HOME}/f2.txt`), 'one');

    const loud = await s.run(copyItem, { Path: 'f1.txt', Destination: 'f3.txt', PassThru: true });
    assert.equal(loud.values.length, 1);
    assert.deepEqual(typeNamesOf(loud.values[0]).slice(0, 1), ['System.IO.FileInfo']);
    assert.equal(prop(loud.values[0], 'FullName'), `${HOME}/f3.txt`);
  });

  it('copies a file INTO an existing directory', async () => {
    // pwsh, confirmed as the brief asked: dst/f1.txt exists afterwards.
    const s = await session();
    await s.write(`${HOME}/f1.txt`, 'one');
    await s.makeDirectory(`${HOME}/dst`);
    const run = await s.run(copyItem, { Path: 'f1.txt', Destination: 'dst' });
    assert.deepEqual(errorIds(run), []);
    assert.equal(await s.text(`${HOME}/dst/f1.txt`), 'one');
  });

  it('overwrites an existing FILE silently, with no -Force', async () => {
    // pwsh: the destination held 'one' afterwards and no error was raised.
    const s = await session();
    await s.write(`${HOME}/f1.txt`, 'one');
    await s.write(`${HOME}/victim.txt`, 'OLD');
    const run = await s.run(copyItem, { Path: 'f1.txt', Destination: 'victim.txt' });
    assert.deepEqual(errorIds(run), []);
    assert.equal(await s.text(`${HOME}/victim.txt`), 'one');
  });

  it('copies into the CURRENT directory when -Destination is missing', async () => {
    // pwsh: `Copy-Item ../f1.txt` from an empty directory left f1.txt in it.
    const s = await session();
    await s.write(`${HOME}/outer/f1.txt`, 'one');
    const run = await s.run(copyItem, { Path: 'outer/f1.txt' });
    assert.deepEqual(errorIds(run), []);
    assert.equal(await s.text(`${HOME}/f1.txt`), 'one');
  });

  it('makes an EMPTY directory without -Recurse', async () => {
    // pwsh: copy-norec existed and was empty; no error.
    const s = await session();
    await withTree(s);
    const run = await s.run(copyItem, { Path: 'src', Destination: 'norec' });
    assert.deepEqual(errorIds(run), []);
    assert.deepEqual(await s.tree(`${HOME}/norec`), []);
  });

  it('copies the whole tree with -Recurse', async () => {
    const s = await session();
    await withTree(s);
    const run = await s.run(copyItem, { Path: 'src', Destination: 'rec', Recurse: true });
    assert.deepEqual(errorIds(run), []);
    assert.deepEqual(await s.tree(`${HOME}/rec`), ['/a.txt', '/sub/', '/sub/b.txt']);
    assert.equal(await s.text(`${HOME}/rec/sub/b.txt`), 'B');
  });

  it('copies a directory INTO an existing directory, under its own name', async () => {
    const s = await session();
    await withTree(s);
    await s.makeDirectory(`${HOME}/dst`);
    const run = await s.run(copyItem, { Path: 'src', Destination: 'dst', Recurse: true });
    assert.deepEqual(errorIds(run), []);
    assert.deepEqual(await s.tree(`${HOME}/dst`), [
      '/src/',
      '/src/a.txt',
      '/src/sub/',
      '/src/sub/b.txt',
    ]);
  });

  it('overwrites the files but reports every directory already there', async () => {
    // pwsh, measured precisely: a second recursive copy over the same tree
    // replaced BOTH files and raised TWO DirectoryExist errors — parent first —
    // while the copy proceeded. -Force suppresses exactly those.
    const s = await session();
    await withTree(s);
    await s.makeDirectory(`${HOME}/dst`);
    await s.run(copyItem, { Path: 'src', Destination: 'dst', Recurse: true });
    await s.write(`${HOME}/dst/src/a.txt`, 'CHANGED');
    await s.write(`${HOME}/dst/src/sub/b.txt`, 'CHANGED');

    const again = await s.run(copyItem, { Path: 'src', Destination: 'dst', Recurse: true });
    assert.deepEqual(errorIds(again), [
      'DirectoryExist,Microsoft.PowerShell.Commands.CopyItemCommand',
      'DirectoryExist,Microsoft.PowerShell.Commands.CopyItemCommand',
    ]);
    assert.equal(again.errors[0]?.message, `An item with the specified name ${HOME}/dst/src already exists.`);
    assert.equal(await s.text(`${HOME}/dst/src/a.txt`), 'A');
    assert.equal(await s.text(`${HOME}/dst/src/sub/b.txt`), 'B');

    await s.write(`${HOME}/dst/src/a.txt`, 'CHANGED');
    const forced = await s.run(copyItem, {
      Path: 'src',
      Destination: 'dst',
      Recurse: true,
      Force: true,
    });
    assert.deepEqual(errorIds(forced), []);
    assert.equal(await s.text(`${HOME}/dst/src/a.txt`), 'A');
  });

  it('reports a missing source as PathNotFound and copies the others', async () => {
    // pwsh: one PathNotFound, and c1 and c3 both arrived.
    const s = await session();
    await s.write(`${HOME}/c1.txt`, '1');
    await s.write(`${HOME}/c3.txt`, '3');
    await s.makeDirectory(`${HOME}/cdst`);
    const run = await s.run(copyItem, {
      Path: ['c1.txt', 'ghost.txt', 'c3.txt'],
      Destination: 'cdst',
    });
    assert.deepEqual(errorIds(run), ['PathNotFound,Microsoft.PowerShell.Commands.CopyItemCommand']);
    assert.equal(run.errors[0]?.category, 'ObjectNotFound');
    assert.equal(await s.exists(`${HOME}/cdst/c1.txt`), true);
    assert.equal(await s.exists(`${HOME}/cdst/c3.txt`), true);
  });

  it('refuses a FILE into a missing destination directory', async () => {
    // pwsh: CopyFileInfoItemIOError / WriteError / DirectoryNotFoundException,
    // and nothing was created.
    const s = await session();
    await s.write(`${HOME}/f1.txt`, 'one');
    const run = await s.run(copyItem, { Path: 'f1.txt', Destination: 'nodir/x.txt' });
    assert.deepEqual(errorIds(run), [
      'CopyFileInfoItemIOError,Microsoft.PowerShell.Commands.CopyItemCommand',
    ]);
    assert.equal(await s.exists(`${HOME}/nodir`), false);
  });

  it('CREATES a missing destination directory for a recursive copy', async () => {
    // pwsh, and the asymmetry with the file case above is real and measured.
    const s = await session();
    await withTree(s);
    const run = await s.run(copyItem, {
      Path: 'src',
      Destination: 'missing/here',
      Recurse: true,
    });
    assert.deepEqual(errorIds(run), []);
    assert.equal(await s.text(`${HOME}/missing/here/a.txt`), 'A');
  });

  it('refuses a container onto an existing leaf', async () => {
    // pwsh: CopyContainerItemToLeafError / InvalidArgument, exact wording.
    const s = await session();
    await withTree(s);
    await s.write(`${HOME}/leaf.txt`, 'x');
    const run = await s.run(copyItem, { Path: 'src', Destination: 'leaf.txt', Recurse: true });
    assert.deepEqual(errorIds(run), [
      'CopyContainerItemToLeafError,Microsoft.PowerShell.Commands.CopyItemCommand',
    ]);
    assert.equal(run.errors[0]?.message, 'Container cannot be copied onto existing leaf item.');
    assert.equal(await s.text(`${HOME}/leaf.txt`), 'x');
  });

  it('refuses copying an item onto itself', async () => {
    // pwsh: CopyError / WriteError, "Cannot overwrite the item <p> with itself."
    const s = await session();
    await s.write(`${HOME}/f1.txt`, 'one');
    const run = await s.run(copyItem, { Path: 'f1.txt', Destination: 'f1.txt' });
    assert.deepEqual(errorIds(run), ['CopyError,Microsoft.PowerShell.Commands.CopyItemCommand']);
    assert.equal(
      run.errors[0]?.message,
      `Cannot overwrite the item ${HOME}/f1.txt with itself.`,
    );
  });

  describe('a directory copied into itself', () => {
    it('is refused, which real pwsh does NOT do', async () => {
      // MEASURED: `Copy-Item tree -Destination tree\inner -Recurse` in pwsh
      // 7.6.5 never returns. The probe was killed at 90 seconds having built
      // 1154 nested directories and a 6412-character path. Refusing is a
      // deliberate divergence; hanging a browser tab is not fidelity worth
      // having, and MemoryStorage.copy makes the same call.
      const s = await session();
      await s.write(`${HOME}/tree/leaf.txt`, 'leaf');
      await s.makeDirectory(`${HOME}/tree/inner`);

      const run = await s.run(copyItem, {
        Path: 'tree',
        Destination: 'tree/inner',
        Recurse: true,
      });
      assert.deepEqual(errorIds(run), [
        'CopyItemArgumentError,Microsoft.PowerShell.Commands.CopyItemCommand',
      ]);
      assert.equal(run.errors[0]?.category, 'InvalidArgument');
      assert.match(run.errors[0]?.message ?? '', /cannot be a subdirectory of the source/u);
      // The tree is exactly as it was: no nesting happened at all.
      assert.deepEqual(await s.tree(`${HOME}/tree`), ['/inner/', '/leaf.txt']);
    });

    it('is refused for the exact-same-path case too, with pwsh\'s own wording', async () => {
      const s = await session();
      await s.write(`${HOME}/tree/leaf.txt`, 'leaf');
      const run = await s.run(copyItem, { Path: 'tree', Destination: 'tree', Recurse: true });
      assert.deepEqual(errorIds(run), ['CopyError,Microsoft.PowerShell.Commands.CopyItemCommand']);
    });
  });

  describe('a copy that runs out of quota partway', () => {
    it('writes the first eight of nine files and says which they were', async () => {
      // The state after a partial copy has to be DESCRIBABLE, because
      // FileSystemPort exposes no `copy` and the storage layer's atomic
      // plan/validate/apply is unreachable from a command. This is the test
      // copy-item.ts's header points at.
      //
      // 9 files x 10 bytes = 90 bytes of source. A 175-byte quota leaves room
      // for exactly eight copies (90 + 80 = 170); the ninth would need 180.
      const s = await session({ capacity: 175 });
      for (let index = 1; index <= 9; index += 1) {
        await s.write(`${HOME}/src/f${String(index)}`, '0123456789');
      }

      const run = await s.run(copyItem, { Path: 'src', Destination: 'dst', Recurse: true });

      assert.equal(run.exitCode, 1);
      assert.deepEqual(errorIds(run), [
        'QuotaExceeded,Microsoft.PowerShell.Commands.CopyItemCommand',
      ]);
      const message = run.errors[0]?.message ?? '';
      assert.equal(run.errors[0]?.category, 'QuotaExceeded');
      // The visitor is TOLD, with the numbers, and is told what remains.
      assert.match(message, /not enough space/u);
      assert.match(message, /170 bytes are in use of a 175 byte quota/u);
      // Nine, not eight: the destination DIRECTORY is a written item too, and
      // the message names every one of them so the tree can be reconstructed
      // from the error alone.
      assert.match(message, /9 item\(s\) were already written and remain/u);
      assert.match(message, new RegExp(`${HOME}/dst/f8`.replaceAll('/', '\\/'), 'u'));

      // And the filesystem agrees with the message, exactly.
      assert.deepEqual(await s.tree(`${HOME}/dst`), [
        '/f1',
        '/f2',
        '/f3',
        '/f4',
        '/f5',
        '/f6',
        '/f7',
        '/f8',
      ]);
    });

    it('writes NOTHING when the source cannot be read', async () => {
      // The atomic half that survives: the plan reads everything before the
      // apply writes anything, so an unreadable source leaves no partial tree.
      const s = await session();
      await s.write(`${HOME}/src/a.txt`, 'A');
      await s.makeDirectory(`${HOME}/src/locked`);
      await s.write(`${HOME}/src/locked/secret.txt`, 'S');
      // 0o000 on the subdirectory: unreadable and unsearchable.
      assert.ok((await s.port.chmod(`${HOME}/src/locked`, 0o000)).ok);

      const run = await s.run(copyItem, { Path: 'src', Destination: 'dst', Recurse: true });
      assert.equal(run.exitCode, 1);
      assert.equal(run.errors[0]?.category, 'PermissionDenied');
      assert.equal(await s.exists(`${HOME}/dst`), false);
    });
  });
});

describe('cp', () => {
  it('refuses a directory without -r, in GNU\'s words', async () => {
    // v1: `cp: -r not specified; omitting directory 'X'`. Copy-Item copies an
    // empty directory instead, which is where the two genuinely differ.
    const s = await session();
    await withTree(s);
    const run = await s.run(cp, {}, { remaining: ['src', 'out'] });
    assert.equal(run.exitCode, 1);
    assert.equal(run.errors[0]?.message, "cp: -r not specified; omitting directory 'src'");
    assert.equal(await s.exists(`${HOME}/out`), false);
  });

  it('copies a tree with -r', async () => {
    const s = await session();
    await withTree(s);
    const run = await s.run(cp, {}, { remaining: ['-r', 'src', 'out'] });
    assert.deepEqual(errorIds(run), []);
    assert.deepEqual(await s.tree(`${HOME}/out`), ['/a.txt', '/sub/', '/sub/b.txt']);
  });

  it('merges into an existing directory without complaining', async () => {
    // GNU cp says nothing about directories that are already there, unlike
    // Copy-Item, which reports each one.
    const s = await session();
    await withTree(s);
    await s.makeDirectory(`${HOME}/out`);
    await s.run(cp, {}, { remaining: ['-r', 'src', 'out'] });
    const again = await s.run(cp, {}, { remaining: ['-r', 'src', 'out'] });
    assert.deepEqual(errorIds(again), []);
  });

  it('reports a missing source the way GNU does', async () => {
    const s = await session();
    const run = await s.run(cp, {}, { remaining: ['ghost', 'out'] });
    assert.equal(run.errors[0]?.message, "cp: cannot stat 'ghost': No such file or directory");
    assert.equal(run.errors[0]?.fullyQualifiedErrorId, 'CpPathNotFound,cp');
  });

  it('needs two operands', async () => {
    const s = await session();
    const none = await s.run(cp, {}, { remaining: [] });
    assert.equal(none.errors[0]?.message, 'cp: missing file operand');
    const one = await s.run(cp, {}, { remaining: ['a'] });
    assert.equal(one.errors[0]?.message, 'cp: missing destination file operand');
  });

  it('refuses a directory into its own subtree, as Copy-Item does', async () => {
    const s = await session();
    await s.write(`${HOME}/tree/leaf.txt`, 'leaf');
    await s.makeDirectory(`${HOME}/tree/inner`);
    const run = await s.run(cp, {}, { remaining: ['-r', 'tree', 'tree/inner'] });
    assert.equal(run.exitCode, 1);
    assert.match(run.errors[0]?.message ?? '', /cannot copy a directory/u);
    assert.deepEqual(await s.tree(`${HOME}/tree`), ['/inner/', '/leaf.txt']);
  });
});
