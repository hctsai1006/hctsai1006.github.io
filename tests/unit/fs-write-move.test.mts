/**
 * Move-Item, Rename-Item and mv.
 *
 * The three collision behaviours are the point of this file: Move-Item refuses
 * without -Force and obeys it, Rename-Item refuses WITH -Force too, and GNU mv
 * overwrites with no flag at all. Each was measured, and getting any of them by
 * analogy from the others would be wrong.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { moveItem, mv, renameItem } from '../../src/commands/fs-write/index.ts';
import { HOME, errorIds, prop, session, typeNamesOf } from './fs-write-harness.mts';

describe('Move-Item', () => {
  it('moves, emits nothing, and -PassThru emits the destination', async () => {
    const s = await session();
    await s.write(`${HOME}/m1.txt`, 'm');
    const quiet = await s.run(moveItem, { Path: 'm1.txt', Destination: 'm2.txt' });
    assert.deepEqual(quiet.values, []);
    assert.equal(await s.exists(`${HOME}/m1.txt`), false);
    assert.equal(await s.text(`${HOME}/m2.txt`), 'm');

    const loud = await s.run(moveItem, { Path: 'm2.txt', Destination: 'm3.txt', PassThru: true });
    assert.deepEqual(typeNamesOf(loud.values[0]).slice(0, 1), ['System.IO.FileInfo']);
    assert.equal(prop(loud.values[0], 'FullName'), `${HOME}/m3.txt`);
  });

  it('refuses a collision without -Force and obeys it with', async () => {
    // pwsh: MoveFileInfoItemIOError / WriteError / IOException, message
    // "Cannot create a file when that file already exists." (captured in zh-TW,
    // which is .NET's translation of exactly that sentence).
    const s = await session();
    await s.write(`${HOME}/victim.txt`, 'OLD');
    await s.write(`${HOME}/src.txt`, 'NEW');

    const refused = await s.run(moveItem, { Path: 'src.txt', Destination: 'victim.txt' });
    assert.deepEqual(errorIds(refused), [
      'MoveFileInfoItemIOError,Microsoft.PowerShell.Commands.MoveItemCommand',
    ]);
    assert.equal(refused.errors[0]?.message, 'Cannot create a file when that file already exists.');
    assert.equal(await s.text(`${HOME}/victim.txt`), 'OLD');
    assert.equal(await s.exists(`${HOME}/src.txt`), true);

    const forced = await s.run(moveItem, {
      Path: 'src.txt',
      Destination: 'victim.txt',
      Force: true,
    });
    assert.deepEqual(errorIds(forced), []);
    assert.equal(await s.text(`${HOME}/victim.txt`), 'NEW');
    assert.equal(await s.exists(`${HOME}/src.txt`), false);
  });

  it('moves a file and a directory INTO an existing directory', async () => {
    const s = await session();
    await s.write(`${HOME}/into.txt`, 'x');
    await s.write(`${HOME}/md-src/k.txt`, 'k');
    await s.makeDirectory(`${HOME}/dst`);

    await s.run(moveItem, { Path: 'into.txt', Destination: 'dst' });
    await s.run(moveItem, { Path: 'md-src', Destination: 'dst' });
    assert.deepEqual(await s.tree(`${HOME}/dst`), ['/into.txt', '/md-src/', '/md-src/k.txt']);
  });

  it('takes a PATH for -Destination, so it moves and renames at once', async () => {
    const s = await session();
    await s.write(`${HOME}/across.txt`, 'x');
    await s.makeDirectory(`${HOME}/other`);
    const run = await s.run(moveItem, { Path: 'across.txt', Destination: 'other/renamed.txt' });
    assert.deepEqual(errorIds(run), []);
    assert.equal(await s.text(`${HOME}/other/renamed.txt`), 'x');
  });

  it('reports a missing source as PathNotFound', async () => {
    const s = await session();
    const run = await s.run(moveItem, { Path: 'ghost.txt', Destination: 'z.txt' });
    assert.deepEqual(errorIds(run), ['PathNotFound,Microsoft.PowerShell.Commands.MoveItemCommand']);
    assert.equal(run.errors[0]?.message, `Cannot find path '${HOME}/ghost.txt' because it does not exist.`);
  });

  it('reports a missing destination parent with pwsh\'s path-less sentence', async () => {
    // pwsh really does print the bare sentence here, unlike every other
    // missing-parent message in this set.
    const s = await session();
    await s.write(`${HOME}/mdp.txt`, 'x');
    const run = await s.run(moveItem, { Path: 'mdp.txt', Destination: 'nodir3/x.txt' });
    assert.deepEqual(errorIds(run), [
      'MoveFileInfoItemIOError,Microsoft.PowerShell.Commands.MoveItemCommand',
    ]);
    assert.equal(run.errors[0]?.message, 'Could not find a part of the path.');
    assert.equal(await s.exists(`${HOME}/mdp.txt`), true);
  });

  it('refuses a directory into its own subdirectory', async () => {
    // pwsh: MoveItemArgumentError / InvalidArgument, and the storage layer
    // raises the same EINVAL rather than this command re-deriving it.
    const s = await session();
    await s.makeDirectory(`${HOME}/selfmove/inner`);
    const run = await s.run(moveItem, { Path: 'selfmove', Destination: 'selfmove/inner' });
    assert.deepEqual(errorIds(run), [
      'MoveItemArgumentError,Microsoft.PowerShell.Commands.MoveItemCommand',
    ]);
    assert.match(run.errors[0]?.message ?? '', /cannot be a subdirectory of the source/u);
    assert.deepEqual(await s.tree(`${HOME}/selfmove`), ['/inner/']);
  });

  it('treats a move onto itself as success and a no-op', async () => {
    const s = await session();
    await s.write(`${HOME}/same.txt`, 'x');
    const run = await s.run(moveItem, { Path: 'same.txt', Destination: 'same.txt' });
    assert.deepEqual(errorIds(run), []);
    assert.equal(run.exitCode, 0);
    assert.equal(await s.text(`${HOME}/same.txt`), 'x');
  });
});

describe('Rename-Item', () => {
  it('renames, emits nothing, and -PassThru emits the destination', async () => {
    const s = await session();
    await s.write(`${HOME}/r1.txt`, 'r');
    const quiet = await s.run(renameItem, { Path: 'r1.txt', NewName: 'r2.txt' });
    assert.deepEqual(quiet.values, []);
    assert.equal(await s.text(`${HOME}/r2.txt`), 'r');

    const loud = await s.run(renameItem, { Path: 'r2.txt', NewName: 'r3.txt', PassThru: true });
    assert.equal(prop(loud.values[0], 'FullName'), `${HOME}/r3.txt`);
  });

  describe('what -NewName may be', () => {
    it('accepts a name, ./name, and an absolute path in the SAME directory', async () => {
      // All three measured as accepted.
      const s = await session();
      await s.write(`${HOME}/a.txt`, 'x');
      assert.deepEqual(errorIds(await s.run(renameItem, { Path: 'a.txt', NewName: 'b.txt' })), []);
      assert.deepEqual(errorIds(await s.run(renameItem, { Path: 'b.txt', NewName: './c.txt' })), []);
      assert.deepEqual(
        errorIds(await s.run(renameItem, { Path: 'c.txt', NewName: `${HOME}/d.txt` })),
        [],
      );
      assert.equal(await s.text(`${HOME}/d.txt`), 'x');
    });

    it('refuses a relative path that lands elsewhere', async () => {
      // pwsh: Argument / InvalidArgument / PSArgumentException, exact wording.
      const s = await session();
      await s.write(`${HOME}/r4.txt`, 'r');
      await s.makeDirectory(`${HOME}/rdir`);
      const run = await s.run(renameItem, { Path: 'r4.txt', NewName: 'rdir/r5.txt' });
      assert.deepEqual(errorIds(run), ['Argument,Microsoft.PowerShell.Commands.RenameItemCommand']);
      assert.equal(
        run.errors[0]?.message,
        'Cannot rename the specified target, because it represents a path or device name.',
      );
      assert.equal(await s.exists(`${HOME}/r4.txt`), true);
    });

    it('refuses an ABSOLUTE path that lands elsewhere', async () => {
      // The check is "lands in the same directory", not "contains a separator" —
      // which is why the same-directory absolute path above is accepted and this
      // one is not. v1's /[\\/:]/ test gets this pair wrong.
      const s = await session();
      await s.write(`${HOME}/movable.txt`, 'x');
      await s.makeDirectory(`${HOME}/elsewhere`);
      const run = await s.run(renameItem, {
        Path: 'movable.txt',
        NewName: `${HOME}/elsewhere/moved.txt`,
      });
      assert.deepEqual(errorIds(run), ['Argument,Microsoft.PowerShell.Commands.RenameItemCommand']);
      assert.equal(await s.exists(`${HOME}/elsewhere/moved.txt`), false);
    });

    it('resolves the name against the ITEM\'s directory, not the working one', async () => {
      // v1 states this rule deliberately; the pwsh probes could not separate the
      // two readings because they coincided there.
      const s = await session();
      await s.write(`${HOME}/deep/here.txt`, 'x');
      const run = await s.run(renameItem, { Path: 'deep/here.txt', NewName: 'there.txt' });
      assert.deepEqual(errorIds(run), []);
      assert.equal(await s.text(`${HOME}/deep/there.txt`), 'x');
      assert.equal(await s.exists(`${HOME}/there.txt`), false);
    });
  });

  describe('renaming onto an existing name', () => {
    it('is refused, and -Force does NOT help', async () => {
      // The single most surprising measurement in this set: pwsh refused it with
      // and without the switch, both times leaving the source in place.
      const s = await session();
      await s.write(`${HOME}/r7.txt`, 'a');
      await s.write(`${HOME}/r8.txt`, 'b');

      for (const force of [false, true]) {
        const run = await s.run(renameItem, {
          Path: 'r7.txt',
          NewName: 'r8.txt',
          ...(force ? { Force: true } : {}),
        });
        assert.deepEqual(errorIds(run), [
          'RenameItemIOError,Microsoft.PowerShell.Commands.RenameItemCommand',
        ]);
        assert.equal(run.errors[0]?.message, 'Cannot create a file when that file already exists.');
        assert.equal(run.exitCode, 1);
      }
      assert.equal(await s.text(`${HOME}/r8.txt`), 'b');
      assert.equal(await s.text(`${HOME}/r7.txt`), 'a');
    });

    it('reports a non-empty destination directory with its own message', async () => {
      // pwsh: RenameItemIOError, "Cannot create '<p>' because a file or
      // directory with the same name already exists."
      const s = await session();
      await s.write(`${HOME}/rd-src/k.txt`, 'k');
      await s.makeDirectory(`${HOME}/rd-dst`);
      const run = await s.run(renameItem, { Path: 'rd-src', NewName: 'rd-dst' });
      assert.deepEqual(errorIds(run), [
        'RenameItemIOError,Microsoft.PowerShell.Commands.RenameItemCommand',
      ]);
      assert.equal(await s.exists(`${HOME}/rd-src/k.txt`), true);
    });
  });

  it('reports a missing source as PathNotFound', async () => {
    const s = await session();
    const run = await s.run(renameItem, { Path: 'ghost.txt', NewName: 'z.txt' });
    assert.deepEqual(errorIds(run), ['PathNotFound,Microsoft.PowerShell.Commands.RenameItemCommand']);
  });

  it('renames a directory, and a same-name rename is a silent no-op', async () => {
    const s = await session();
    await s.makeDirectory(`${HOME}/rd1`);
    assert.deepEqual(errorIds(await s.run(renameItem, { Path: 'rd1', NewName: 'rd2' })), []);
    assert.equal((await s.stat(`${HOME}/rd2`)).kind, 'directory');
    const same = await s.run(renameItem, { Path: 'rd2', NewName: 'rd2' });
    assert.deepEqual(errorIds(same), []);
    assert.equal(same.exitCode, 0);
  });
});

describe('mv', () => {
  it('OVERWRITES an existing destination with no flag at all', async () => {
    // v1: "GNU mv 預設就覆寫,不像 Move-Item 要 -Force". This is where the
    // coreutil and the cmdlet genuinely differ.
    const s = await session();
    await s.write(`${HOME}/a.txt`, 'NEW');
    await s.write(`${HOME}/b.txt`, 'OLD');
    const run = await s.run(mv, {}, { remaining: ['a.txt', 'b.txt'] });
    assert.deepEqual(errorIds(run), []);
    assert.equal(await s.text(`${HOME}/b.txt`), 'NEW');
    assert.equal(await s.exists(`${HOME}/a.txt`), false);
  });

  it('moves into an existing directory', async () => {
    const s = await session();
    await s.write(`${HOME}/x.txt`, 'x');
    await s.makeDirectory(`${HOME}/dst`);
    await s.run(mv, {}, { remaining: ['x.txt', 'dst'] });
    assert.equal(await s.text(`${HOME}/dst/x.txt`), 'x');
  });

  it('reports a missing source and a missing operand the way GNU does', async () => {
    const s = await session();
    const missing = await s.run(mv, {}, { remaining: ['ghost', 'out'] });
    assert.equal(missing.errors[0]?.message, "mv: cannot stat 'ghost': No such file or directory");
    const none = await s.run(mv, {}, { remaining: [] });
    assert.equal(none.errors[0]?.message, 'mv: missing file operand');
    const one = await s.run(mv, {}, { remaining: ['a'] });
    assert.equal(one.errors[0]?.message, 'mv: missing destination file operand');
  });

  it('refuses a directory into its own subtree', async () => {
    const s = await session();
    await s.makeDirectory(`${HOME}/tree/inner`);
    const run = await s.run(mv, {}, { remaining: ['tree', 'tree/inner'] });
    assert.equal(run.exitCode, 1);
    assert.deepEqual(await s.tree(`${HOME}/tree`), ['/inner/']);
  });

  it('ignores dash-led tokens rather than rejecting them, as v1 does', async () => {
    const s = await session();
    await s.write(`${HOME}/a.txt`, 'x');
    const run = await s.run(mv, {}, { remaining: ['-v', '--anything', 'a.txt', 'b.txt'] });
    assert.deepEqual(errorIds(run), []);
    assert.equal(await s.text(`${HOME}/b.txt`), 'x');
  });
});
