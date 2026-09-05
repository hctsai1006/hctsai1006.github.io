/**
 * mkdir, touch, chmod and chown, plus the invariants that hold across all
 * twelve: the manifests are the generated ones, a null filesystem is an error
 * rather than a crash, a cancelled write stops somewhere describable, and the
 * broker is genuinely in the path.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import manifestsJson from '../../src/commands/manifests.json' with { type: 'json' };

/**
 * The generated file, read back with a declared shape rather than whatever TS
 * infers from the literal — the same arrangement `simulated/support.ts` uses,
 * and for the same reason: a widened `CommandManifest` must not silently widen
 * what this cast is claiming.
 */
interface ManifestRow {
  readonly name: string;
  readonly display: string;
  readonly aliases: readonly string[];
  readonly capabilities: readonly string[];
  readonly fidelity: string;
  readonly risk: string;
  readonly parameters: readonly unknown[];
}
const MANIFEST_ROWS: readonly ManifestRow[] = (
  manifestsJson as unknown as { readonly commands: readonly ManifestRow[] }
).commands;

import {
  FS_WRITE_COMMANDS,
  applyMode,
  chmod,
  chown,
  copyItem,
  mkdir,
  moveItem,
  newItem,
  setContent,
  touch,
} from '../../src/commands/fs-write/index.ts';
import { CapabilityDeniedError } from '../../src/commands/invocation.ts';
import { DEFAULT_FILE_MODE, formatMode } from '../../src/storage/index.ts';
import { HOME, abortAfter, errorIds, session } from './fs-write-harness.mts';

describe('mkdir', () => {
  it('makes a directory and needs an operand', async () => {
    const s = await session();
    assert.deepEqual(errorIds(await s.run(mkdir, {}, { remaining: ['d'] })), []);
    assert.equal((await s.stat(`${HOME}/d`)).kind, 'directory');

    const none = await s.run(mkdir, {}, { remaining: [] });
    assert.equal(none.exitCode, 1);
    assert.match(none.errors[0]?.message ?? '', /^mkdir: missing operand\nTry 'mkdir --help'/u);
  });

  it('refuses a missing parent without -p and builds the chain with it', async () => {
    // v1: "No such file or directory" without -p; fsMkdirp with it.
    const s = await session();
    const bare = await s.run(mkdir, {}, { remaining: ['a/b/c'] });
    assert.equal(
      bare.errors[0]?.message,
      "mkdir: cannot create directory 'a/b/c': No such file or directory",
    );
    assert.equal(await s.exists(`${HOME}/a`), false);

    const parents = await s.run(mkdir, {}, { remaining: ['-p', 'a/b/c'] });
    assert.deepEqual(errorIds(parents), []);
    assert.equal((await s.stat(`${HOME}/a/b/c`)).kind, 'directory');
  });

  it('is silent with -p for an existing DIRECTORY but not an existing FILE', async () => {
    // v1's exact GNU rule, called out in its own comment.
    const s = await session();
    await s.makeDirectory(`${HOME}/there`);
    await s.write(`${HOME}/afile`, 'x');

    assert.deepEqual(errorIds(await s.run(mkdir, {}, { remaining: ['-p', 'there'] })), []);
    const onFile = await s.run(mkdir, {}, { remaining: ['-p', 'afile'] });
    assert.equal(onFile.errors[0]?.message, "mkdir: cannot create directory 'afile': File exists");
    assert.equal(onFile.exitCode, 1);
  });

  it('reports File exists without -p', async () => {
    const s = await session();
    await s.makeDirectory(`${HOME}/there`);
    const run = await s.run(mkdir, {}, { remaining: ['there'] });
    assert.equal(run.errors[0]?.message, "mkdir: cannot create directory 'there': File exists");
  });

  it('parses clustered flags and prints v1\'s verbose line', async () => {
    const s = await session();
    const run = await s.run(mkdir, {}, { remaining: ['-pv', 'x/y'] });
    assert.deepEqual(run.values, ["mkdir: created directory 'x/y'"]);
    assert.equal(await s.exists(`${HOME}/x/y`), true);
  });

  it('ignores unknown long options rather than rejecting them, as v1 does', async () => {
    const s = await session();
    const run = await s.run(mkdir, {}, { remaining: ['--mode=0700', 'm'] });
    assert.deepEqual(errorIds(run), []);
    assert.equal(await s.exists(`${HOME}/m`), true);
  });

  it('continues past a failing target', async () => {
    const s = await session();
    await s.makeDirectory(`${HOME}/dup`);
    const run = await s.run(mkdir, {}, { remaining: ['one', 'dup', 'two'] });
    assert.equal(run.errors.length, 1);
    assert.equal(await s.exists(`${HOME}/one`), true);
    assert.equal(await s.exists(`${HOME}/two`), true);
  });
});

describe('touch', () => {
  it('creates a missing file and updates an existing mtime', async () => {
    // v1: "真 touch 對既有檔案就是更新 mtime,不是什麼都不做".
    const s = await session();
    assert.deepEqual(errorIds(await s.run(touch, {}, { remaining: ['t.txt'] })), []);
    assert.equal(await s.text(`${HOME}/t.txt`), '');

    // Age the file, then touch it back to the fixed clock's instant.
    assert.ok((await s.port.utimes(`${HOME}/t.txt`, { mtime: 1000 }, false)).ok);
    assert.equal((await s.stat(`${HOME}/t.txt`)).mtime, 1000);
    await s.run(touch, {}, { remaining: ['t.txt'] });
    assert.notEqual((await s.stat(`${HOME}/t.txt`)).mtime, 1000);
  });

  it('updates a DIRECTORY rather than refusing it', async () => {
    const s = await session();
    await s.makeDirectory(`${HOME}/d`);
    assert.ok((await s.port.utimes(`${HOME}/d`, { mtime: 1000 }, false)).ok);
    const run = await s.run(touch, {}, { remaining: ['d'] });
    assert.deepEqual(errorIds(run), []);
    assert.notEqual((await s.stat(`${HOME}/d`)).mtime, 1000);
    assert.equal((await s.stat(`${HOME}/d`)).kind, 'directory');
  });

  it('takes several operands', async () => {
    const s = await session();
    await s.run(touch, {}, { remaining: ['a', 'b', 'c'] });
    assert.deepEqual(await s.tree(HOME), ['/a', '/b', '/c']);
  });

  it('needs an operand', async () => {
    const s = await session();
    const run = await s.run(touch, {}, { remaining: [] });
    assert.equal(run.errors[0]?.message, 'touch: missing file operand');
  });

  it('reports a missing parent in GNU\'s words', async () => {
    const s = await session();
    const run = await s.run(touch, {}, { remaining: ['no/x.txt'] });
    assert.equal(
      run.errors[0]?.message,
      "touch: cannot touch 'no/x.txt': No such file or directory",
    );
  });

  it('is silent for a missing file with -c', async () => {
    const s = await session();
    const run = await s.run(touch, {}, { remaining: ['-c', 'ghost.txt'] });
    assert.deepEqual(errorIds(run), []);
    assert.equal(run.exitCode, 0);
    assert.equal(await s.exists(`${HOME}/ghost.txt`), false);
  });
});

describe('chmod', () => {
  it('applies an octal mode, and a four-digit one carries the special bits', async () => {
    const s = await session();
    await s.write(`${HOME}/f`, 'x');
    await s.run(chmod, {}, { remaining: ['700', 'f'] });
    assert.equal(await s.mode(`${HOME}/f`), '-rwx------');
    await s.run(chmod, {}, { remaining: ['4755', 'f'] });
    assert.equal(await s.mode(`${HOME}/f`), '-rwsr-xr-x');
    // v1: a three-digit spec CLEARS the special bits.
    await s.run(chmod, {}, { remaining: ['755', 'f'] });
    assert.equal(await s.mode(`${HOME}/f`), '-rwxr-xr-x');
  });

  it('applies the symbolic form and keeps a setuid bit through +x / -x', async () => {
    // v1's comment at this site: 別把 setuid 位洗掉. Here setuid and execute are
    // separate bits, so the rule holds by construction.
    const s = await session();
    await s.write(`${HOME}/f`, 'x');
    await s.run(chmod, {}, { remaining: ['4644', 'f'] });
    assert.equal(await s.mode(`${HOME}/f`), '-rwSr--r--');
    await s.run(chmod, {}, { remaining: ['u+x', 'f'] });
    assert.equal(await s.mode(`${HOME}/f`), '-rwsr--r--');
    await s.run(chmod, {}, { remaining: ['u-x', 'f'] });
    assert.equal(await s.mode(`${HOME}/f`), '-rwSr--r--');
    await s.run(chmod, {}, { remaining: ['a+r', 'f'] });
    assert.equal(await s.mode(`${HOME}/f`), '-rwSr--r--');
  });

  it('really enforces the bits it sets', async () => {
    // Not decoration: the storage layer honours the mode, so a directory you
    // chmod 000 is one you can no longer write into.
    const s = await session();
    await s.makeDirectory(`${HOME}/locked`);
    await s.run(chmod, {}, { remaining: ['000', 'locked'] });
    const denied = await s.run(setContent, { Path: 'locked/x.txt', Value: 'v' });
    assert.equal(denied.exitCode, 1);
    assert.equal(denied.errors[0]?.category, 'PermissionDenied');
  });

  describe('a chmod on something that does not exist', () => {
    it('reports GNU\'s "cannot access" and changes nothing', async () => {
      // v1: `chmod: cannot access 'X': No such file or directory`
      const s = await session();
      const run = await s.run(chmod, {}, { remaining: ['755', 'ghost'] });
      assert.equal(run.exitCode, 1);
      assert.equal(
        run.errors[0]?.message,
        "chmod: cannot access 'ghost': No such file or directory",
      );
      assert.equal(run.errors[0]?.category, 'ObjectNotFound');
    });
  });

  it('rejects an unparseable mode', async () => {
    const s = await session();
    await s.write(`${HOME}/f`, 'x');
    const run = await s.run(chmod, {}, { remaining: ['sausage', 'f'] });
    assert.equal(run.errors[0]?.message, "chmod: invalid mode: 'sausage'");
    assert.equal(await s.mode(`${HOME}/f`), formatMode(DEFAULT_FILE_MODE, 'file'));
  });

  it('REFUSES -R rather than quietly doing one path', async () => {
    // A recursive chmod that changed only the named path would look like it had
    // worked, and nothing downstream could tell the subtree was skipped.
    const s = await session();
    await s.makeDirectory(`${HOME}/tree/inner`);
    const run = await s.run(chmod, {}, { remaining: ['-R', '700', 'tree'] });
    assert.equal(run.exitCode, 1);
    assert.equal(run.errors[0]?.category, 'NotImplemented');
    assert.equal(await s.mode(`${HOME}/tree`), 'drwxr-xr-x');
  });

  it('needs both operands', async () => {
    const s = await session();
    const run = await s.run(chmod, {}, { remaining: ['755'] });
    assert.match(run.errors[0]?.message ?? '', /^chmod: missing operand/u);
  });

  it('takes several files', async () => {
    const s = await session();
    await s.write(`${HOME}/a`, 'x');
    await s.write(`${HOME}/b`, 'x');
    await s.run(chmod, {}, { remaining: ['600', 'a', 'b'] });
    assert.equal(await s.mode(`${HOME}/a`), '-rw-------');
    assert.equal(await s.mode(`${HOME}/b`), '-rw-------');
  });

  it('computes modes the way v1 does', () => {
    // The pure function, checked against v1's string arithmetic case by case.
    assert.equal(applyMode(0o644, '700'), 0o700);
    assert.equal(applyMode(0o4755, '755'), 0o755);
    assert.equal(applyMode(0o644, '1777'), 0o1777);
    assert.equal(applyMode(0o644, 'a+x'), 0o755);
    assert.equal(applyMode(0o755, 'go-w'), 0o755);
    assert.equal(applyMode(0o666, 'go-w'), 0o644);
    assert.equal(applyMode(0o755, 'u+s'), 0o4755);
    assert.equal(applyMode(0o4755, 'u-s'), 0o755);
    assert.equal(applyMode(0o755, '+t'), 0o1755);
    assert.equal(applyMode(0o644, 'nonsense'), null);
    assert.equal(applyMode(0o644, '9999'), null);
  });
});

describe('chown', () => {
  it('changes nothing and says why', async () => {
    // v1: "changing ownership of 'X': Operation not permitted", plus a line
    // naming the single user. Both sentences travel in one ErrorRecord.
    const s = await session();
    await s.write(`${HOME}/f`, 'x');
    const before = await s.stat(`${HOME}/f`);
    const run = await s.run(chown, {}, { remaining: ['root', 'f'] });
    assert.equal(run.exitCode, 1);
    assert.equal(run.errors[0]?.category, 'PermissionDenied');
    assert.match(run.errors[0]?.message ?? '', /Operation not permitted/u);
    assert.match(run.errors[0]?.message ?? '', /single user/u);
    assert.equal((await s.stat(`${HOME}/f`)).owner, before.owner);
  });

  it('says "cannot access" for a target that is not there', async () => {
    // The one thing this adds over v1, and what makes its declared
    // filesystem.read capability something the broker actually records.
    const s = await session();
    const run = await s.run(chown, {}, { remaining: ['root', 'ghost'] });
    assert.equal(
      run.errors[0]?.message,
      "chown: cannot access 'ghost': No such file or directory",
    );
  });

  it('needs a target', async () => {
    const s = await session();
    const run = await s.run(chown, {}, { remaining: ['root'] });
    assert.equal(run.errors[0]?.message, 'chown: missing operand');
  });
});

describe('every fs-write command', () => {
  it('is one of the twelve the generated manifests declare', () => {
    const declared = MANIFEST_ROWS
      .filter(
        (command) =>
          command.capabilities.includes('filesystem.write') &&
          !['nano', 'vi', 'vim'].includes(command.name),
      )
      .map((command) => command.name)
      .sort();
    const implemented = FS_WRITE_COMMANDS.map((module) => module.manifest.name).sort();
    assert.equal(implemented.length, 12);
    assert.deepEqual(implemented, declared);
  });

  it('carries the generated manifest verbatim, plus a note', () => {
    for (const module of FS_WRITE_COMMANDS) {
      const generated = MANIFEST_ROWS.find((c) => c.name === module.manifest.name);
      assert.ok(generated !== undefined, module.manifest.name);
      assert.equal(module.manifest.display, generated.display);
      assert.deepEqual([...module.manifest.aliases], [...generated.aliases]);
      assert.equal(module.manifest.fidelity, 'browser-backed');
      assert.equal(module.manifest.risk, 'write');
      assert.deepEqual([...module.manifest.capabilities], [...generated.capabilities]);
      assert.equal(module.manifest.parameters.length, generated.parameters.length);
      // The note is the one thing declared in code, and it is required.
      assert.ok((module.manifest.notes ?? '').length > 80, module.manifest.name);
    }
  });

  it('claims no name or alias twice', () => {
    const seen = new Set<string>();
    for (const module of FS_WRITE_COMMANDS) {
      for (const name of [module.manifest.name, ...module.manifest.aliases]) {
        assert.equal(seen.has(name.toLowerCase()), false, name);
        seen.add(name.toLowerCase());
      }
    }
    // The aliases the generated file gives them, spelled out so a change to
    // manifests.json cannot silently move one.
    assert.deepEqual([...seen].sort(), [
      'ac',
      'add-content',
      'chmod',
      'chown',
      'ci',
      'copy',
      'copy-item',
      'cp',
      'md',
      'mi',
      'mkdir',
      'move',
      'move-item',
      'mv',
      'new-item',
      'ni',
      'ren',
      'rename-item',
      'rni',
      'sc',
      'set-content',
      'touch',
    ]);
  });

  it('reports a clear error instead of crashing when there is no filesystem', async () => {
    const s = await session();
    for (const module of FS_WRITE_COMMANDS) {
      const run = await s.run(
        module,
        { Path: 'x', NewName: 'y', Destination: 'z', Value: 'v' },
        { fs: null, remaining: ['755', 'x', 'y'] },
      );
      assert.equal(run.exitCode, 1, module.manifest.name);
      assert.deepEqual(run.values, [], module.manifest.name);
      assert.equal(run.errors.length, 1, module.manifest.name);
      assert.match(run.errors[0]?.message ?? '', /has no filesystem/u, module.manifest.name);
      assert.equal(run.errors[0]?.category, 'ResourceUnavailable');
    }
  });

  it('is refused every write when only filesystem.read was granted', async () => {
    // The broker is in the path for these commands too. `ports.test.mts` proves
    // the port refuses; this proves the commands go THROUGH it, which is the
    // claim that would otherwise rest on nobody having written a shortcut.
    const s = await session({ granted: ['filesystem.read'] });
    // The subjects have to EXIST, or a command would refuse at the read step and
    // never reach the write the broker is meant to stop. `session.write` goes
    // through the VirtualFileSystem directly, which is ungated on purpose.
    await s.write(`${HOME}/a.txt`, 'x');
    for (const [module, parameters, remaining] of [
      [newItem, { Path: 'brand-new.txt', ItemType: 'File' }, []],
      [setContent, { Path: 'a.txt', Value: 'v' }, []],
      [copyItem, { Path: 'a.txt', Destination: 'c.txt' }, []],
      [moveItem, { Path: 'a.txt', Destination: 'b.txt' }, []],
      [mkdir, {}, ['d']],
      [touch, {}, ['t']],
      [chmod, {}, ['700', 'a.txt']],
    ] as const) {
      await assert.rejects(
        () => s.run(module, parameters, { remaining }),
        CapabilityDeniedError,
        module.manifest.name,
      );
    }
  });
});

describe('a write cancelled by the signal', () => {
  it('stops mkdir after the first directory and names it', async () => {
    const s = await session();
    const controller = new AbortController();
    const run = await s.run(
      mkdir,
      {},
      {
        fs: abortAfter(s.port, 1, controller),
        signal: controller.signal,
        remaining: ['one', 'two', 'three'],
      },
    );
    assert.equal(run.exitCode, 1);
    assert.equal(run.errors[0]?.category, 'OperationStopped');
    assert.match(run.errors[0]?.message ?? '', /cancelled after writing 1 item\(s\)/u);
    assert.match(run.errors[0]?.message ?? '', new RegExp(`${HOME}/one`.replaceAll('/', '\\/'), 'u'));
    // And the filesystem agrees with what the message said.
    assert.equal(await s.exists(`${HOME}/one`), true);
    assert.equal(await s.exists(`${HOME}/two`), false);
    assert.equal(await s.exists(`${HOME}/three`), false);
  });

  it('stops Set-Content between paths', async () => {
    const s = await session();
    const controller = new AbortController();
    const run = await s.run(
      setContent,
      { Path: ['a.txt', 'b.txt', 'c.txt'], Value: 'v' },
      { fs: abortAfter(s.port, 1, controller), signal: controller.signal },
    );
    assert.equal(run.exitCode, 1);
    assert.equal(run.errors[0]?.category, 'OperationStopped');
    assert.equal(await s.text(`${HOME}/a.txt`), 'v\n');
    assert.equal(await s.exists(`${HOME}/b.txt`), false);
  });

  it('writes nothing at all when the signal is already aborted', async () => {
    const s = await session();
    const controller = new AbortController();
    controller.abort();
    const run = await s.run(
      copyItem,
      { Path: 'src', Destination: 'dst', Recurse: true },
      { signal: controller.signal },
    );
    assert.equal(run.exitCode, 1);
    assert.equal(run.errors[0]?.category, 'OperationStopped');
    assert.match(run.errors[0]?.message ?? '', /before anything was written/u);
    assert.equal(await s.exists(`${HOME}/dst`), false);
  });
});
