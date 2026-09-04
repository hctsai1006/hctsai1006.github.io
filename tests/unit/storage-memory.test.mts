/**
 * Tests for the in-memory backend.
 *
 * The happy path is asserted where it is cheap and then left alone. What is
 * actually defended here is the set of things that are easy to get wrong and
 * invisible when they are:
 *
 *   - a file where a directory was expected, and the reverse
 *   - removing a non-empty directory, renaming onto an existing path
 *   - a directory moved or copied into its own subtree, which is the shape that
 *     HUNG pwsh 7.6.5 during the probe for this PR (`Copy-Item dir dir\inner
 *     -Recurse` never returned and the process had to be killed)
 *   - `__proto__` as a filename
 *   - permission bits that actually deny something
 *   - a multi-step mutation that fails partway and must leave nothing behind
 *
 * The clock is injected everywhere. A test that asserts on `Date.now()` is a
 * test that passes on a fast machine.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DIRECTORY_SIZE,
  HOME,
  MemoryStorage,
  NullJournal,
  bootStorage,
  buildSeed,
  formatMode,
  parseMode,
} from '../../src/storage/index.ts';
import type {
  MemoryStorageOptions,
  Result,
  StorageErrorCode,
  VirtualFileSystem,
} from '../../src/storage/index.ts';

/** A clock the test drives by hand. */
function fakeClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    },
  };
}

function backend(overrides: Omit<MemoryStorageOptions, 'clock'> = {}): {
  store: MemoryStorage;
  clock: ReturnType<typeof fakeClock>;
} {
  const clock = fakeClock();
  const store = new MemoryStorage({ clock: clock.now, ...overrides });
  return { store, clock };
}

function code(outcome: Result<unknown>): StorageErrorCode {
  assert.ok(!outcome.ok, `expected a failure, got ${JSON.stringify(outcome)}`);
  return outcome.error.code;
}

function value<T>(outcome: Result<T>): T {
  assert.ok(outcome.ok, `expected success, got ${JSON.stringify(outcome)}`);
  return outcome.value;
}

async function seeded(): Promise<VirtualFileSystem> {
  const clock = fakeClock();
  const booted = await bootStorage({ clock: clock.now });
  return value(booted).vfs;
}

// ---------------------------------------------------------------------------

describe('mode formatting', () => {
  it('renders and parses the modes the seed actually uses', () => {
    assert.equal(formatMode(0o755, 'directory'), 'drwxr-xr-x');
    assert.equal(formatMode(0o644, 'file'), '-rw-r--r--');
    assert.equal(formatMode(0o700, 'directory'), 'drwx------');
    // /tmp. The sticky bit replaces the other-execute character with `t`.
    assert.equal(formatMode(0o1777, 'directory'), 'drwxrwxrwt');
    // Sticky WITHOUT other-execute is `T`, upper case. This is the detail that
    // gets left out, and leaving it out makes the two indistinguishable.
    assert.equal(formatMode(0o1666, 'directory'), 'drw-rw-rwT');
    assert.equal(formatMode(0o4755, 'file'), '-rwsr-xr-x');
    assert.equal(formatMode(0o4655, 'file'), '-rwSr-xr-x');

    assert.equal(parseMode('rwxr-xr-x'), 0o755);
    assert.equal(parseMode('drwxrwxrwt'), 0o1777);
    assert.equal(parseMode('rw-r--r--'), 0o644);
    assert.equal(parseMode('nonsense!'), null);
    assert.equal(parseMode('rwxr-xr-'), null);
  });
});

describe('determinism', () => {
  it('takes every timestamp from the injected clock', async () => {
    const { store, clock } = backend();
    await store.writeText('/a.txt', 'one');
    const first = value(await store.stat('/a.txt'));
    assert.equal(first.mtime, 1_700_000_000_000);

    clock.advance(5_000);
    await store.writeText('/b.txt', 'two');
    const second = value(await store.stat('/b.txt'));
    assert.equal(second.mtime, 1_700_000_005_000);
    // The first file did not move, and the second is strictly newer. Two files
    // written in the same millisecond would tie, which is why `ls -t` needs
    // this to be controllable rather than real.
    assert.equal(value(await store.stat('/a.txt')).mtime, first.mtime);
    assert.ok(second.mtime > first.mtime);
  });

  it('moves a directory mtime when a child is added or removed', async () => {
    const { store, clock } = backend();
    await store.mkdir('/d');
    const before = value(await store.stat('/d')).mtime;
    clock.advance(1_000);
    await store.writeText('/d/x', 'x');
    const afterCreate = value(await store.stat('/d')).mtime;
    assert.ok(afterCreate > before);
    clock.advance(1_000);
    await store.remove('/d/x');
    assert.ok(value(await store.stat('/d')).mtime > afterCreate);
  });

  it('does not touch atime on read (noatime semantics)', async () => {
    const { store, clock } = backend();
    await store.writeText('/a.txt', 'hello');
    const before = value(await store.stat('/a.txt'));
    clock.advance(60_000);
    await store.readText('/a.txt');
    const after = value(await store.stat('/a.txt'));
    // A read that dirtied the node would make every `cat` grow the overlay.
    assert.deepEqual([after.mtime, after.ctime], [before.mtime, before.ctime]);
  });
});

describe('names', () => {
  it('stores __proto__, constructor and prototype as ordinary filenames', async () => {
    // v1 needs `Object.create(null)` for exactly this; a Map makes the class of
    // bug unreachable. The failure it prevents is silent: the file disappears
    // on the next reload rather than erroring.
    const { store } = backend();
    for (const name of ['__proto__', 'constructor', 'prototype', 'toString']) {
      const written = await store.writeText(`/${name}`, name);
      assert.ok(written.ok, name);
    }
    const rows = value(await store.readdir('/')).map((row) => row.name).sort();
    assert.deepEqual(rows, ['__proto__', 'constructor', 'prototype', 'toString']);
    assert.equal(value(await store.readText('/__proto__')), '__proto__');
    assert.equal(Object.getPrototypeOf({}), Object.prototype);
  });

  it('accepts a newline, a tab and a quote in a filename', async () => {
    const { store } = backend();
    for (const name of ['a\nb', 'a\tb', '"quoted"', "it's", 'a\\b', 'a b']) {
      assert.ok((await store.writeText(`/${name}`, name)).ok, JSON.stringify(name));
      assert.equal(value(await store.readText(`/${name}`)), name);
    }
    assert.equal(value(await store.readdir('/')).length, 6);
  });

  it('is case-sensitive: README.md and readme.md are different files', async () => {
    const { store } = backend();
    await store.writeText('/README.md', 'upper');
    await store.writeText('/readme.md', 'lower');
    assert.equal(value(await store.readText('/README.md')), 'upper');
    assert.equal(value(await store.readText('/readme.md')), 'lower');
    assert.equal(value(await store.readdir('/')).length, 2);
  });
});

describe('bytes and text', () => {
  it('sizes a file in UTF-8 bytes, not UTF-16 code units', async () => {
    // v1 records the same trap: 蔡 must show as 3 bytes in `ls`, not 1.
    const { store } = backend();
    await store.writeText('/name.txt', '蔡');
    assert.equal(value(await store.stat('/name.txt')).size, 3);
    await store.writeText('/emoji.txt', '🐛');
    assert.equal(value(await store.stat('/emoji.txt')).size, 4);
  });

  it('strips a BOM from readText and keeps it in readBytes', async () => {
    const { store } = backend();
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]);
    await store.writeBytes('/bom.txt', withBom);
    assert.equal(value(await store.readText('/bom.txt')), 'hi');
    assert.deepEqual([...value(await store.readBytes('/bom.txt'))], [...withBom]);
  });

  it('replaces undecodable bytes rather than failing the read', async () => {
    // `cat` on a binary file shows mojibake; it does not error. readBytes is
    // the lossless form for anything that has to be exact.
    const { store } = backend();
    await store.writeBytes('/binary', new Uint8Array([0xff, 0xfe, 0x00, 0x41]));
    const text = value(await store.readText('/binary'));
    assert.ok(text.includes('�'));
    assert.equal(value(await store.readBytes('/binary')).length, 4);
  });

  it('hands out a copy, so a caller cannot mutate the file through it', async () => {
    const { store } = backend();
    await store.writeText('/a.txt', 'abc');
    const bytes = value(await store.readBytes('/a.txt'));
    bytes[0] = 0x7a;
    assert.equal(value(await store.readText('/a.txt')), 'abc');
  });

  it('appends without rereading, and reports the new size', async () => {
    const { store } = backend();
    await store.writeText('/log', 'one\n');
    const receipt = value(await store.appendText('/log', 'two\n'));
    assert.equal(receipt.created, false);
    assert.equal(receipt.size, 8);
    assert.equal(value(await store.readText('/log')), 'one\ntwo\n');
  });
});

describe('shape errors', () => {
  it('reports ENOTDIR when a path component is a file', async () => {
    const { store } = backend();
    await store.writeText('/file.txt', 'x');
    assert.equal(code(await store.stat('/file.txt/sub')), 'ENOTDIR');
    assert.equal(code(await store.readdir('/file.txt')), 'ENOTDIR');
    assert.equal(code(await store.mkdir('/file.txt/sub', { recursive: true })), 'ENOTDIR');
    // MEASURED: pwsh 7.6.5 does NOT distinguish this from a missing path — it
    // reports PathNotFound for `Get-ChildItem file.txt\sub`. The POSIX code is
    // kept because the command maps it; folding the two here would throw away
    // the distinction for every caller that does want it.
  });

  it('reports EISDIR when a directory is used as a file', async () => {
    const { store } = backend();
    await store.mkdir('/d');
    assert.equal(code(await store.readBytes('/d')), 'EISDIR');
    assert.equal(code(await store.writeText('/d', 'x')), 'EISDIR');
    assert.equal(code(await store.appendText('/d', 'x')), 'EISDIR');
  });

  it('reports ENOENT for a missing parent unless createParents is set', async () => {
    const { store } = backend();
    assert.equal(code(await store.writeText('/nope/x.txt', 'v')), 'ENOENT');
    assert.ok((await store.writeText('/nope/x.txt', 'v', { createParents: true })).ok);
    assert.equal(value(await store.stat('/nope')).kind, 'directory');
  });

  it('reports EEXIST for mkdir over an existing node, and not with recursive', async () => {
    const { store } = backend();
    await store.mkdir('/d');
    assert.equal(code(await store.mkdir('/d')), 'EEXIST');
    assert.ok((await store.mkdir('/d', { recursive: true })).ok);
    await store.writeText('/f', 'x');
    assert.equal(code(await store.mkdir('/f')), 'EEXIST');
    // `mkdir -p` over a FILE is still an error; only over a directory is it a
    // no-op. Treating both as success is the tempting shortcut.
    assert.equal(code(await store.mkdir('/f', { recursive: true })), 'ENOTDIR');
  });

  it('reports EEXIST for an exclusive write over an existing file', async () => {
    const { store } = backend();
    await store.writeText('/a', 'x');
    assert.equal(code(await store.writeText('/a', 'y', { exclusive: true })), 'EEXIST');
    assert.equal(value(await store.readText('/a')), 'x');
  });

  it('reports the directory size as 4096, as ext4 and v1 both do', async () => {
    const { store } = backend();
    await store.mkdir('/d');
    await store.writeText('/d/big', 'x'.repeat(10_000));
    // Not the recursive contents: `du` is a different question from `ls -l`.
    assert.equal(value(await store.stat('/d')).size, DIRECTORY_SIZE);
  });

  it('counts links the way ls -l does', async () => {
    const { store } = backend();
    await store.mkdir('/d');
    assert.equal(value(await store.stat('/d')).links, 2);
    await store.mkdir('/d/sub');
    await store.writeText('/d/file', 'x');
    // 2 for `.` and `..`, plus one per subdirectory's `..`. A file has no
    // hard links to count, so it is always 1.
    assert.equal(value(await store.stat('/d')).links, 3);
    assert.equal(value(await store.stat('/d/file')).links, 1);
  });
});

describe('remove', () => {
  it('refuses a non-empty directory without recursive, and names the count', async () => {
    const { store } = backend();
    await store.mkdir('/d');
    await store.writeText('/d/a', 'a');
    await store.writeText('/d/b', 'b');

    const refused = await store.remove('/d');
    assert.equal(code(refused), 'ENOTEMPTY');
    assert.ok(!refused.ok);
    assert.ok(refused.error.code === 'ENOTEMPTY' && refused.error.entries === 2);
    // MEASURED: pwsh 7.6.5 does not error here at all — it PROMPTS via
    // ShouldContinue, and under -NonInteractive that prompt becomes a
    // PSInvalidOperationException. The prompt is the command's decision; the
    // filesystem's job is to say the directory is not empty.
    assert.equal(value(await store.stat('/d')).kind, 'directory');
  });

  it('removes recursively, children before parents', async () => {
    const journal = new NullJournal();
    const { store } = backend({ journal });
    await store.mkdir('/d/e/f', { recursive: true });
    await store.writeText('/d/e/f/deep', 'x');
    assert.ok((await store.remove('/d', { recursive: true })).ok);
    assert.equal(await store.exists('/d'), false);

    const plan = journal.written.at(-1);
    assert.ok(plan !== undefined);
    const order = plan.steps.map((step) => step.path);
    // A journal replayed front-to-back must never try to delete a directory
    // that still has entries.
    assert.ok(order.indexOf('/d/e/f/deep') < order.indexOf('/d/e/f'));
    assert.ok(order.indexOf('/d/e/f') < order.indexOf('/d/e'));
    assert.ok(order.indexOf('/d/e') < order.indexOf('/d'));
  });

  it('treats a missing path as success only with force', async () => {
    const { store } = backend();
    assert.equal(code(await store.remove('/nope')), 'ENOENT');
    assert.ok((await store.remove('/nope', { force: true })).ok);
  });

  it('refuses to remove the mount root', async () => {
    const { store } = backend();
    assert.equal(code(await store.remove('/', { recursive: true })), 'EINVAL');
  });
});

describe('rename', () => {
  it('refuses to overwrite unless asked, and then only the same kind', async () => {
    const { store } = backend();
    await store.writeText('/a', 'a');
    await store.writeText('/b', 'b');
    await store.mkdir('/d');

    assert.equal(code(await store.rename('/a', '/b')), 'EEXIST');
    assert.ok((await store.rename('/a', '/b', { overwrite: true })).ok);
    assert.equal(value(await store.readText('/b')), 'a');
    assert.equal(await store.exists('/a'), false);

    await store.writeText('/c', 'c');
    // POSIX rename() refuses a type mismatch even with an overwrite. Silently
    // replacing a directory with a file destroys its contents irrecoverably.
    assert.equal(code(await store.rename('/c', '/d', { overwrite: true })), 'EISDIR');
    assert.equal(code(await store.rename('/d', '/c', { overwrite: true })), 'ENOTDIR');
  });

  it('refuses to overwrite a non-empty directory', async () => {
    const { store } = backend();
    await store.mkdir('/src');
    await store.mkdir('/dst');
    await store.writeText('/dst/keep', 'x');
    assert.equal(code(await store.rename('/src', '/dst', { overwrite: true })), 'ENOTEMPTY');
  });

  it('refuses to move a directory into its own subtree', async () => {
    // MEASURED: pwsh 7.6.5 reports MoveItemArgumentError / InvalidArgument.
    const { store } = backend();
    await store.mkdir('/d/e', { recursive: true });
    assert.equal(code(await store.rename('/d', '/d/e/inner')), 'EINVAL');
  });

  it('keeps birthtime across a rename, and moves only ctime', async () => {
    const { store, clock } = backend();
    await store.writeText('/a', 'x');
    const before = value(await store.stat('/a'));
    clock.advance(10_000);
    assert.ok((await store.rename('/a', '/b')).ok);
    const after = value(await store.stat('/b'));
    // A rename is not a copy plus a delete. Modelling it as one resets
    // birthtime, and `ls -lt` would reorder on a move.
    assert.equal(after.birthtime, before.birthtime);
    assert.equal(after.mtime, before.mtime);
    assert.ok(after.ctime > before.ctime);
  });
});

describe('copy', () => {
  it('needs recursive for a directory', async () => {
    const { store } = backend();
    await store.mkdir('/d');
    assert.equal(code(await store.copy('/d', '/e')), 'EISDIR');
    assert.ok((await store.copy('/d', '/e', { recursive: true })).ok);
  });

  it('refuses to copy a directory into its own subtree', async () => {
    // The probe for this PR ran `Copy-Item dir dir\inner -Recurse` against
    // pwsh 7.6.5 and it never returned; the process had to be killed. The
    // reference implementation not guarding this is a reason to guard it, not
    // a reason to reproduce it.
    const { store } = backend();
    await store.mkdir('/d/e', { recursive: true });
    await store.writeText('/d/f', 'x');
    assert.equal(code(await store.copy('/d', '/d/e/inner', { recursive: true })), 'EINVAL');
    assert.equal(code(await store.copy('/d', '/d', { recursive: true })), 'EINVAL');
  });

  it('leaves the destination untouched when a recursive copy fails partway', async () => {
    // The property a write-ahead log would otherwise have to provide. The plan
    // is built and validated in full before anything is applied, so a copy that
    // fails on its third file has written nothing at all.
    const journal = new NullJournal();
    const { store } = backend({ journal });
    await store.mkdir('/src');
    await store.writeText('/src/a', 'a');
    await store.writeText('/src/b', 'b');
    await store.writeText('/src/c', 'c');
    await store.chmod('/src/b', 0o000);

    const journaledBefore = journal.written.length;
    assert.equal(code(await store.copy('/src', '/dst', { recursive: true })), 'EACCES');
    assert.equal(await store.exists('/dst'), false);
    assert.equal(await store.exists('/dst/a'), false);
    // And nothing reached the journal either: a plan that does not validate is
    // never written, so recovery can never replay a partial operation.
    assert.equal(journal.written.length, journaledBefore);
  });

  it('journals the whole plan before applying it, and commits after', async () => {
    const journal = new NullJournal();
    const { store } = backend({ journal });
    await store.mkdir('/src/inner', { recursive: true });
    await store.writeText('/src/a', 'aa');
    await store.writeText('/src/inner/b', 'bbb');

    const before = journal.written.length;
    assert.ok((await store.copy('/src', '/dst', { recursive: true })).ok);
    const plan = journal.written.at(-1);
    assert.ok(plan !== undefined);
    assert.equal(journal.written.length, before + 1);
    assert.equal(plan.syscall, 'copy');
    // Insertion order, which is `/src/inner` before `/src/a` because mkdir ran
    // first. That is fine and it is deterministic — what a replay needs is only
    // that a parent is created before anything inside it, asserted below.
    assert.deepEqual(
      plan.steps.map((step) => `${step.op} ${step.path}`),
      ['create-directory /dst', 'create-directory /dst/inner', 'create-file /dst/inner/b', 'create-file /dst/a'],
    );
    const created = new Set<string>(['/']);
    for (const step of plan.steps) {
      const parent = step.path.slice(0, step.path.lastIndexOf('/')) || '/';
      assert.ok(created.has(parent), `${step.path} is planned before its parent ${parent}`);
      if (step.op === 'create-directory') created.add(step.path);
    }
    assert.equal(plan.byteDelta, 5);
    assert.deepEqual(await journal.pending(), { ok: true, value: [] });
  });

  it('copies content and mode but makes the copy a user node', async () => {
    const { store } = backend();
    await store.writeText('/a', 'hello', { mode: 0o600 });
    assert.ok((await store.copy('/a', '/b')).ok);
    const copied = value(await store.stat('/b'));
    assert.equal(value(await store.readText('/b')), 'hello');
    assert.equal(copied.mode, 0o600);
    assert.equal(copied.origin, 'user');
  });
});

describe('permissions', () => {
  it('denies traversal through a directory without the search bit', async () => {
    const { store } = backend();
    await store.mkdir('/private');
    await store.writeText('/private/secret', 'x');
    await store.chmod('/private', 0o600);
    // The execute bit on a directory is POSIX's search permission. Checking it
    // only at the target would let a path through an unreadable directory reach
    // a world-readable file.
    assert.equal(code(await store.stat('/private/secret')), 'EACCES');
    assert.equal(code(await store.readText('/private/secret')), 'EACCES');
  });

  it('denies readdir without the read bit even when search is allowed', async () => {
    const { store } = backend();
    await store.mkdir('/d');
    await store.writeText('/d/x', 'x');
    await store.chmod('/d', 0o300);
    assert.equal(code(await store.readdir('/d')), 'EACCES');
    // Search still works: naming the file directly is allowed.
    assert.equal(value(await store.readText('/d/x')), 'x');
  });

  it('requires ownership for chmod, not merely the write bit', async () => {
    // v1 checks the write bit, which lets anyone reopen a directory they were
    // locked out of. Real POSIX requires ownership.
    const { store } = backend({ user: 'visitor', group: 'visitor' });
    await store.installImage({
      time: 1,
      entries: [{ path: '/theirs', kind: 'file', content: 'x', mode: 0o666, owner: 'root' }],
    });
    assert.equal(code(await store.chmod('/theirs', 0o777)), 'EACCES');
  });

  it('blocks rm -rf ~ because /home belongs to root, exactly as on a real box', async () => {
    const vfs = await seeded();
    const refused = await vfs.remove(HOME, { recursive: true });
    assert.equal(code(refused), 'EACCES');
    assert.equal(await vfs.exists(HOME), true);
  });

  it('keeps /root private and /tmp world-writable', async () => {
    const vfs = await seeded();
    assert.equal(code(await vfs.readdir('/root')), 'EACCES');
    assert.equal(code(await vfs.stat('/root/anything')), 'EACCES');
    assert.equal(formatMode(value(await vfs.stat('/tmp')).mode, 'directory'), 'drwxrwxrwt');
    assert.ok((await vfs.writeText('/tmp/scratch', 'ok')).ok);
  });
});

describe('the seeded image', () => {
  it('installs the Ubuntu files v1 promises', async () => {
    const vfs = await seeded();
    assert.match(value(await vfs.readText('/etc/os-release')), /Ubuntu 24\.04\.4 LTS/);
    assert.equal(value(await vfs.readText('/etc/hostname')).trim(), 'thc1006-dev');
    // /etc/shells names both /bin/sh and /usr/bin/pwsh, so both have to exist
    // or the file describes a machine the emulator is not.
    const shells = value(await vfs.readText('/etc/shells'));
    for (const line of shells.split('\n')) {
      if (!line.startsWith('/')) continue;
      assert.equal(await vfs.exists(line), true, `${line} is named in /etc/shells but does not exist`);
    }
  });

  it('gives the home directory Ubuntu adduser mode 750, not 755', async () => {
    const vfs = await seeded();
    assert.equal(formatMode(value(await vfs.stat(HOME)).mode, 'directory'), 'drwxr-x---');
  });

  it('marks every seeded node as seed origin', async () => {
    const vfs = await seeded();
    assert.equal(value(await vfs.stat(`${HOME}/README.md`)).origin, 'seed');
    assert.ok((await vfs.writeText(`${HOME}/mine.txt`, 'x')).ok);
    assert.equal(value(await vfs.stat(`${HOME}/mine.txt`)).origin, 'user');
  });

  it('installs an image whose directories come before their contents', () => {
    // Order is load-bearing: a directory declared after a file inside it gets
    // created implicitly with the default mode, and the later declaration has
    // to correct a mode that was briefly wrong.
    const spec = buildSeed();
    const seen = new Set<string>();
    for (const entry of spec.entries) {
      const parent = entry.path.slice(0, entry.path.lastIndexOf('/')) || '/';
      if (entry.path !== '/') {
        assert.ok(seen.has(parent), `${entry.path} appears before its parent ${parent}`);
      }
      if (entry.kind === 'directory') seen.add(entry.path);
    }
  });
});

describe('touch', () => {
  it('creates a missing file and then only moves its mtime', async () => {
    const { store, clock } = backend();
    const created = value(await store.utimes('/note', {}));
    assert.equal(created.size, 0);
    assert.equal(created.mtime, 1_700_000_000_000);

    clock.advance(9_000);
    const touched = value(await store.utimes('/note', {}));
    assert.equal(touched.mtime, 1_700_000_009_000);
    assert.equal(touched.birthtime, created.birthtime);
    assert.equal(value(await store.readText('/note')), '');
  });

  it('does not create when told not to', async () => {
    const { store } = backend();
    assert.equal(code(await store.utimes('/nope', {}, false)), 'ENOENT');
    assert.equal(await store.exists('/nope'), false);
  });

  it('checks the parent the same way a write would', async () => {
    const { store } = backend();
    await store.mkdir('/locked');
    await store.chmod('/locked', 0o500);
    assert.equal(code(await store.utimes('/locked/new', {})), 'EACCES');
  });
});

describe('mkdir -p', () => {
  it('checks permission at the deepest EXISTING ancestor', async () => {
    // v1 makes the same point at `deepestExisting()`: building the intermediate
    // levels first and checking afterwards would let `mkdir -p` create a chain
    // rooted in a directory the user cannot write to.
    const { store } = backend();
    await store.mkdir('/locked');
    await store.chmod('/locked', 0o500);
    assert.equal(code(await store.mkdir('/locked/a/b/c', { recursive: true })), 'EACCES');
    assert.equal(await store.exists('/locked/a'), false);
  });

  it('creates the whole chain in one journalled plan', async () => {
    const journal = new NullJournal();
    const { store } = backend({ journal });
    assert.ok((await store.mkdir('/a/b/c/d', { recursive: true })).ok);
    const plan = journal.written.at(-1);
    assert.ok(plan !== undefined);
    assert.deepEqual(
      plan.steps.map((step) => step.path),
      ['/a', '/a/b', '/a/b/c', '/a/b/c/d'],
    );
    assert.equal(value(await store.stat('/a/b/c/d')).kind, 'directory');
  });

  it('creates parents on a write without a separate mkdir', async () => {
    const { store } = backend();
    assert.ok((await store.writeText('/x/y/z.txt', 'deep', { createParents: true })).ok);
    assert.equal(value(await store.readText('/x/y/z.txt')), 'deep');
    assert.equal(value(await store.stat('/x/y')).kind, 'directory');
  });
});

describe('Set-Location', () => {
  it('moves the cwd only when the target is an existing directory', async () => {
    const vfs = await seeded();
    assert.equal(vfs.location.path, HOME);

    assert.equal(code(await vfs.setLocation('/nope')), 'ENOENT');
    assert.equal(vfs.location.path, HOME, 'a failed cd must not move the cwd');

    assert.equal(code(await vfs.setLocation('/etc/hostname')), 'ENOTDIR');
    assert.equal(vfs.location.path, HOME);

    assert.ok((await vfs.setLocation('/etc')).ok);
    assert.equal(vfs.location.path, '/etc');
    // Relative paths now resolve against the new location.
    assert.equal(value(await vfs.readText('hostname')).trim(), 'thc1006-dev');
    assert.ok((await vfs.setLocation('~')).ok);
    assert.equal(vfs.location.path, HOME);
  });

  it('refuses to cd into a directory it cannot search', async () => {
    // POSIX chdir() needs EXECUTE on the target. A walk that only checks the
    // directories it crosses will happily stat /root, so `cd /root` would
    // succeed and every relative path afterwards would fail instead.
    const vfs = await seeded();
    assert.equal(code(await vfs.setLocation('/root')), 'EACCES');
    assert.equal(vfs.location.path, HOME);
  });

  it('separates cd from ls: --x is enterable and not listable', async () => {
    // The case that proves `access(execute)` is not just `readdir` spelled
    // differently. A 0o111 directory can be entered and its files named, but
    // its contents cannot be enumerated.
    const clock = fakeClock();
    const booted = value(await bootStorage({ clock: clock.now }));
    const vfs = booted.vfs;
    await vfs.mkdir(`${HOME}/opaque`);
    await vfs.writeText(`${HOME}/opaque/known.txt`, 'found me');
    await vfs.chmod(`${HOME}/opaque`, 0o111);

    assert.ok((await vfs.setLocation(`${HOME}/opaque`)).ok);
    assert.equal(code(await vfs.readdir('.')), 'EACCES');
    assert.equal(value(await vfs.readText('known.txt')), 'found me');
  });
});

describe('quota and faults', () => {
  it('refuses a write past capacity with ENOSPC and reports the usage', async () => {
    const { store } = backend({ capacity: 32 });
    assert.ok((await store.writeText('/a', 'x'.repeat(30))).ok);
    const refused = await store.writeText('/b', 'y'.repeat(10));
    assert.equal(code(refused), 'ENOSPC');
    assert.ok(!refused.ok && refused.error.code === 'ENOSPC');
    if (!refused.ok && refused.error.code === 'ENOSPC') {
      assert.equal(refused.error.usage.used, 30);
      assert.equal(refused.error.usage.quota, 32);
    }
    assert.equal(await store.exists('/b'), false);
  });

  it('counts a shrinking overwrite as freeing space', async () => {
    const { store } = backend({ capacity: 32 });
    await store.writeText('/a', 'x'.repeat(30));
    // byteDelta is the NET change; an overwrite that shrinks must not be
    // charged for its full new size or a nearly-full disk becomes unusable.
    assert.ok((await store.writeText('/a', 'y')).ok);
    assert.equal(value(await store.quota()).used, 1);
  });

  it('reports quota as unshared for memory, unlike OPFS', async () => {
    const { store } = backend({ capacity: 100 });
    const usage = value(await store.quota());
    assert.equal(usage.shared, false);
    assert.equal(usage.persisted, null);
  });

  it('raises EIO when the backend is told to fail', async () => {
    const { store } = backend({
      injectFault: (syscall, path) => (path === '/cursed' && syscall === 'read' ? 'evicted' : null),
    });
    await store.writeText('/cursed', 'x');
    assert.equal(code(await store.readBytes('/cursed')), 'EIO');
    // Only the injected syscall fails; the rest of the backend still works.
    assert.ok((await store.stat('/cursed')).ok);
  });

  it('raises EROFS on a read-only mount without touching the tree', async () => {
    const { store } = backend({ readOnly: true, name: 'frozen' });
    assert.equal(code(await store.writeText('/a', 'x')), 'EROFS');
    assert.equal(code(await store.mkdir('/d')), 'EROFS');
    assert.equal(code(await store.remove('/a')), 'EROFS');
    assert.equal(await store.exists('/a'), false);
  });
});
