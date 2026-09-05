/**
 * The two delete commands, held to two different reference implementations.
 *
 *   Remove-Item   pwsh 7.6.5 on Win32NT
 *   rm            GNU coreutils 8.32
 *
 * Every `// measured:` comment below can be reproduced by running the tool it
 * names; the probes are recorded in the headers of the two command files. The
 * cases that matter most are the ones where the two tools DISAGREE, because
 * those are the ones a single shared implementation would have got wrong for
 * one of them.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStorage, MountTable, VirtualFileSystem } from '../../src/storage/index.ts';
import { brokeredFileSystem } from '../../src/commands/ports.ts';
import { CapabilityDeniedError } from '../../src/commands/invocation.ts';
import { CapabilityBroker } from '../../src/kernel/capabilities.ts';
import type { CommandManifest } from '../../src/commands/manifest.ts';
import { removeItem, rm } from '../../src/commands/fs-manage/index.ts';
import { TEST_HOME, firstError, rig } from './fs-manage-harness.mts';

// ---------------------------------------------------------------------------
// Remove-Item
// ---------------------------------------------------------------------------

describe('Remove-Item removes what it was pointed at', () => {
  it('takes a file and emits nothing at all', async () => {
    // measured (pwsh): @(Remove-Item $f).Count is 0 and the result is $null.
    // There is no -PassThru to make it emit — the parameter does not exist.
    const r = await rig({ tree: { files: { [`${TEST_HOME}/notes.txt`]: 'hello' } } });
    const code = await r.run(removeItem, { parameters: { Path: ['notes.txt'] } });

    assert.equal(code, 0);
    assert.deepEqual(r.values, []);
    assert.deepEqual(r.errors, []);
    assert.equal(await r.exists(`${TEST_HOME}/notes.txt`), false);
  });

  it('takes an EMPTY directory without -Recurse', async () => {
    // measured (pwsh): no error, and it is gone. GNU rm refuses the same call.
    const r = await rig({ tree: { directories: [`${TEST_HOME}/empty`] } });
    const code = await r.run(removeItem, { parameters: { Path: ['empty'] } });

    assert.equal(code, 0);
    assert.deepEqual(r.errors, []);
    assert.equal(await r.exists(`${TEST_HOME}/empty`), false);
  });

  it('takes a whole tree with -Recurse', async () => {
    const r = await rig({
      tree: {
        files: {
          [`${TEST_HOME}/docs/a.txt`]: 'a',
          [`${TEST_HOME}/docs/deep/b.txt`]: 'b',
          [`${TEST_HOME}/keep.txt`]: 'keep',
        },
      },
    });
    const code = await r.run(removeItem, { parameters: { Path: ['docs'], Recurse: true } });

    assert.equal(code, 0);
    assert.deepEqual(r.errors, []);
    assert.equal(await r.exists(`${TEST_HOME}/docs`), false);
    assert.equal(await r.read(`${TEST_HOME}/keep.txt`), 'keep');
  });
});

describe('Remove-Item on a non-empty directory without -Recurse', () => {
  // measured (pwsh, non-interactive): the directory SURVIVES and the failure is
  // InvalidOperation / PSInvalidOperationException — because pwsh wanted to
  // PROMPT and could not. `storage/types.ts` records the same finding.
  it('refuses, and leaves the directory alone', async () => {
    const r = await rig({ tree: { files: { [`${TEST_HOME}/docs/a.txt`]: 'a' } } });
    const code = await r.run(removeItem, { parameters: { Path: ['docs'] } });

    assert.equal(code, 1);
    const error = firstError(r.errors);
    assert.equal(error.fullyQualifiedErrorId, 'InvalidOperation,Remove-Item');
    assert.equal(error.category, 'InvalidOperation');
    assert.equal(error.exceptionType, 'System.Management.Automation.PSInvalidOperationException');
    assert.match(error.message, /has children and the Recurse parameter was not specified/u);
    assert.match(error.message, /Use -Recurse/u);
    assert.equal(await r.read(`${TEST_HOME}/docs/a.txt`), 'a');
  });

  it('still refuses with -Force, which does NOT imply -Recurse', async () => {
    // measured (pwsh): identical failure with -Force. v1 treats -Force as a
    // substitute for -Recurse; that is a v1 divergence and is not reproduced.
    const r = await rig({ tree: { files: { [`${TEST_HOME}/docs/a.txt`]: 'a' } } });
    const code = await r.run(removeItem, { parameters: { Path: ['docs'], Force: true } });

    assert.equal(code, 1);
    assert.equal(firstError(r.errors).category, 'InvalidOperation');
    assert.equal(await r.exists(`${TEST_HOME}/docs`), true);
  });
});

describe('Remove-Item and a path that is not there', () => {
  it('reports PathNotFound with the id, category and sentence pwsh uses', async () => {
    const r = await rig();
    const code = await r.run(removeItem, { parameters: { Path: ['nope.txt'] } });

    assert.equal(code, 1);
    const error = firstError(r.errors);
    assert.equal(error.fullyQualifiedErrorId, 'PathNotFound,Remove-Item');
    assert.equal(error.category, 'ObjectNotFound');
    assert.equal(error.exceptionType, 'System.Management.Automation.ItemNotFoundException');
    assert.equal(
      error.message,
      `Cannot find path '${TEST_HOME}/nope.txt' because it does not exist.`,
    );
  });

  it('STILL reports it with -Force — this is not rm -f', async () => {
    // measured (pwsh): -Force does not suppress PathNotFound. This is why
    // -Force is not mapped onto RemoveOptions.force, whose meaning is exactly
    // the suppression pwsh does not do.
    const r = await rig();
    const code = await r.run(removeItem, { parameters: { Path: ['nope.txt'], Force: true } });

    assert.equal(code, 1);
    assert.equal(firstError(r.errors).fullyQualifiedErrorId, 'PathNotFound,Remove-Item');
  });

  it('removes the paths it can and reports only the ones it cannot', async () => {
    // measured (pwsh): `Remove-Item @($g, missing)` removes $g, writes ONE
    // error, and carries on.
    const r = await rig({ tree: { files: { [`${TEST_HOME}/g.txt`]: 'g' } } });
    const code = await r.run(removeItem, { parameters: { Path: ['g.txt', 'missing.txt'] } });

    assert.equal(code, 1);
    assert.equal(r.errors.length, 1);
    assert.equal(await r.exists(`${TEST_HOME}/g.txt`), false);
  });
});

describe('Remove-Item and wildcards', () => {
  it('removes every match', async () => {
    const r = await rig({
      tree: {
        files: {
          [`${TEST_HOME}/w1.log`]: '1',
          [`${TEST_HOME}/w2.log`]: '2',
          [`${TEST_HOME}/keep.txt`]: 'k',
        },
      },
    });
    const code = await r.run(removeItem, { parameters: { Path: ['*.log'] } });

    assert.equal(code, 0);
    assert.deepEqual(await r.list(TEST_HOME), ['keep.txt']);
  });

  it('is SILENT when nothing matches', async () => {
    // measured (pwsh): no error, with or without -Force. "No such file" is a
    // property of how the path was written, not of the filesystem.
    const r = await rig({ tree: { files: { [`${TEST_HOME}/keep.txt`]: 'k' } } });
    const code = await r.run(removeItem, { parameters: { Path: ['*.nomatch'] } });

    assert.equal(code, 0);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(await r.list(TEST_HOME), ['keep.txt']);
  });

  it('treats -LiteralPath as a name, so a star there is PathNotFound', async () => {
    // measured (pwsh): -LiteralPath '*.log' looks for a file called '*.log'.
    const r = await rig({ tree: { files: { [`${TEST_HOME}/w1.log`]: '1' } } });
    const code = await r.run(removeItem, { parameters: { LiteralPath: ['*.log'] } });

    assert.equal(code, 1);
    assert.equal(firstError(r.errors).fullyQualifiedErrorId, 'PathNotFound,Remove-Item');
    assert.equal(await r.read(`${TEST_HOME}/w1.log`), '1');
  });

  it('names the PARENT when the parent does not exist', async () => {
    // measured (pwsh): `Remove-Item <root>/nope/*.log` says
    // "Cannot find path '<root>\nope' because it does not exist."
    const r = await rig();
    const code = await r.run(removeItem, { parameters: { Path: ['nope/*.log'] } });

    assert.equal(code, 1);
    const error = firstError(r.errors);
    assert.equal(error.fullyQualifiedErrorId, 'PathNotFound,Remove-Item');
    assert.equal(error.message, `Cannot find path '${TEST_HOME}/nope' because it does not exist.`);
  });

  it('refuses a wildcard in a middle component instead of misreading it', async () => {
    // A declared limit. pwsh expands one in any component; this does not, and
    // says so rather than removing something the visitor did not name.
    const r = await rig({ tree: { files: { [`${TEST_HOME}/a/b/t.txt`]: 't' } } });
    const code = await r.run(removeItem, { parameters: { Path: ['*/b/t.txt'] } });

    assert.equal(code, 1);
    const error = firstError(r.errors);
    assert.equal(error.category, 'NotImplemented');
    assert.equal(error.fullyQualifiedErrorId, 'WildcardNotSupportedInPathComponent,Remove-Item');
    assert.equal(await r.read(`${TEST_HOME}/a/b/t.txt`), 't');
  });

  it('matches case-sensitively, because the emulated machine is Linux', async () => {
    // Divergence from the Win32NT capture, declared: NTFS matched Upper.TXT
    // against *.txt. This backend's lookup is exact, so the pattern is too.
    const r = await rig({
      tree: { files: { [`${TEST_HOME}/lower.txt`]: 'l', [`${TEST_HOME}/Upper.TXT`]: 'u' } },
    });
    const code = await r.run(removeItem, { parameters: { Path: ['*.txt'] } });

    assert.equal(code, 0);
    assert.deepEqual(await r.list(TEST_HOME), ['Upper.TXT']);
  });
});

describe('Remove-Item and the directory the shell is standing in', () => {
  it('refuses, in pwsh\'s words, and does not move the location', async () => {
    // measured (pwsh): "Cannot remove the item at '<path>' because it is in
    // use.", InvalidOperation, and $PWD does not move. v1 deletes it and bounces
    // to HOME; this filesystem does not move `location` on remove, so following
    // v1 here would leave $PWD pointing at nothing.
    const r = await rig({
      tree: { files: { [`${TEST_HOME}/here/x.txt`]: 'x' } },
      cwd: `${TEST_HOME}/here`,
    });
    const code = await r.run(removeItem, { parameters: { Path: ['.'], Recurse: true } });

    assert.equal(code, 1);
    const error = firstError(r.errors);
    assert.equal(error.category, 'InvalidOperation');
    assert.equal(
      error.message,
      `Cannot remove the item at '${TEST_HOME}/here' because it is in use.`,
    );
    assert.equal(r.vfs.location.path, `${TEST_HOME}/here`);
    assert.equal(await r.read(`${TEST_HOME}/here/x.txt`), 'x');
  });

  it('refuses an ANCESTOR of the current directory too', async () => {
    const r = await rig({
      tree: { files: { [`${TEST_HOME}/tree/deep/x.txt`]: 'x' } },
      cwd: `${TEST_HOME}/tree/deep`,
    });
    const code = await r.run(removeItem, { parameters: { Path: [`${TEST_HOME}/tree`], Recurse: true } });

    assert.equal(code, 1);
    assert.match(firstError(r.errors).message, /because it is in use/u);
  });
});

describe('Remove-Item and the parameters it does not have', () => {
  it('reports the missing mandatory Path in pwsh\'s words', async () => {
    const r = await rig();
    const code = await r.run(removeItem);

    assert.equal(code, 1);
    const error = firstError(r.errors);
    assert.equal(error.fullyQualifiedErrorId, 'MissingMandatoryParameter,Remove-Item');
    assert.equal(
      error.message,
      'Cannot process command because of one or more missing mandatory parameters: Path.',
    );
  });

  for (const name of ['Filter', 'Include', 'Exclude', 'Stream', 'Credential'] as const) {
    it(`refuses -${name} rather than ignoring it`, async () => {
      // Silently dropping -Include from `Remove-Item .\* -Include '*.txt'`
      // would delete every file the filter was there to protect.
      const r = await rig({ tree: { files: { [`${TEST_HOME}/a.txt`]: 'a' } } });
      const code = await r.run(removeItem, {
        parameters: { Path: ['*'], [name]: name === 'Filter' ? '*.txt' : ['*.txt'] },
      });

      assert.equal(code, 1);
      assert.equal(firstError(r.errors).category, 'NotImplemented');
      assert.equal(await r.read(`${TEST_HOME}/a.txt`), 'a');
    });
  }
});

describe('a recursive delete stopped part way', () => {
  it('leaves a state it can describe, and says what is still there', async () => {
    const r = await rig({
      tree: {
        files: {
          [`${TEST_HOME}/tree/a.txt`]: 'a',
          [`${TEST_HOME}/tree/b.txt`]: 'b',
          [`${TEST_HOME}/tree/c.txt`]: 'c',
        },
      },
    });

    const seen: string[] = [];
    r.vfs.onRemove = (path) => {
      seen.push(path);
      // Ctrl+C after the first node. The walk checks the signal before every
      // `remove`, so the second one never happens.
      if (seen.length === 1) r.abort.abort();
    };

    const code = await r.run(removeItem, { parameters: { Path: ['tree'], Recurse: true } });

    assert.equal(code, 1);
    const error = firstError(r.errors);
    assert.equal(error.fullyQualifiedErrorId, 'RemoveItemStopped,Remove-Item');
    assert.equal(error.category, 'OperationStopped');
    assert.match(error.message, /was stopped after 1 item/u);
    assert.match(error.message, /and everything\s+above it are still there/u);

    // The describable state: exactly one file went, the directory did not, and
    // the message named where it stopped.
    assert.equal(seen.length, 1);
    assert.equal(await r.exists(`${TEST_HOME}/tree`), true);
    assert.equal((await r.list(`${TEST_HOME}/tree`)).length, 2);
  });

  it('could not have been interrupted by a single recursive remove', async () => {
    // The reason the walk is driven by the command rather than handed to
    // `remove(recursive: true)`: one atomic backend call has nowhere to check a
    // signal. This pins that the walk really is per node.
    const r = await rig({
      tree: { files: { [`${TEST_HOME}/t/a.txt`]: 'a', [`${TEST_HOME}/t/d/b.txt`]: 'b' } },
    });
    const seen: string[] = [];
    r.vfs.onRemove = (path) => seen.push(path);

    assert.equal(await r.run(removeItem, { parameters: { Path: ['t'], Recurse: true } }), 0);
    // four nodes: a.txt, d/b.txt, d, t — children before parents.
    assert.equal(seen.length, 4);
    assert.ok(seen.indexOf(`${TEST_HOME}/t/d/b.txt`) < seen.indexOf(`${TEST_HOME}/t/d`));
    assert.equal(seen.at(-1), `${TEST_HOME}/t`);
  });
});

// ---------------------------------------------------------------------------
// the capability, which is the whole reason this command was blocked
// ---------------------------------------------------------------------------

describe('filesystem.delete is not part of filesystem.write', () => {
  it('a command declaring only read and write cannot remove one byte', async () => {
    // Gate 1, against the real broker: the capability is not in the manifest,
    // so it is denied even though the session granted everything.
    const backend = new MemoryStorage({ clock: () => 0 });
    const vfs = new VirtualFileSystem(new MountTable(backend), { home: '/home/visitor' });
    const writer: CommandManifest = {
      ...removeItem.manifest,
      name: 'pretend-writer',
      display: 'Pretend-Writer',
      capabilities: ['filesystem.read', 'filesystem.write'],
    };
    const broker = new CapabilityBroker({
      grants: ['filesystem.read', 'filesystem.write', 'filesystem.delete'],
    });
    const scoped = broker.forCommand(writer, 1);
    const port = brokeredFileSystem(vfs, (capability) => {
      scoped.require(capability);
    });

    assert.ok((await port.mkdir('/home/visitor', { recursive: true })).ok);
    assert.ok((await port.writeText('/home/visitor/a.txt', 'hello')).ok);
    await assert.rejects(() => port.remove('/home/visitor/a.txt'), CapabilityDeniedError);
    assert.equal(await port.exists('/home/visitor/a.txt'), true);

    const denial = broker.audit.denials().at(-1);
    assert.equal(denial?.decision, 'denied:undeclared');
    assert.equal(denial?.capability, 'filesystem.delete');
  });

  it('Remove-Item reports a denial as an ErrorRecord and removes nothing', async () => {
    // Gate 2: declared, but this session did not grant it. The refusal has to
    // arrive as PowerShell's usual failure shape rather than as a crash.
    const r = await rig({
      tree: { files: { [`${TEST_HOME}/notes.txt`]: 'hello' } },
      granted: ['filesystem.read', 'filesystem.write'],
    });
    const code = await r.run(removeItem, { parameters: { Path: ['notes.txt'] } });

    assert.equal(code, 1);
    const error = firstError(r.errors);
    assert.equal(error.fullyQualifiedErrorId, 'CapabilityDenied,Remove-Item');
    assert.equal(error.category, 'PermissionDenied');
    assert.match(error.message, /filesystem\.delete/u);
    assert.equal(await r.read(`${TEST_HOME}/notes.txt`), 'hello');
  });

  it('audits the delete, because deletion is audited by capability AND by risk', async () => {
    const r = await rig({ tree: { files: { [`${TEST_HOME}/x.txt`]: 'x' } } });
    await r.run(removeItem, { parameters: { Path: ['x.txt'] } });

    const deletes = r.audit.filter((record) => record.capability === 'filesystem.delete');
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0]?.decision, 'granted');
    assert.equal(deletes[0]?.real, true);
    assert.equal(deletes[0]?.risk, 'destructive');
  });
});

describe('Remove-Item without a filesystem', () => {
  it('says so rather than crashing', async () => {
    const r = await rig({ withFileSystem: false });
    const code = await r.run(removeItem, { parameters: { Path: ['x'] } });

    assert.equal(code, 1);
    const error = firstError(r.errors);
    assert.equal(error.fullyQualifiedErrorId, 'FileSystemUnavailable,Remove-Item');
    assert.equal(error.category, 'ResourceUnavailable');
  });
});

// ---------------------------------------------------------------------------
// rm, which is GNU coreutils and not Remove-Item
// ---------------------------------------------------------------------------

describe('rm is the GNU tool', () => {
  it('has its own manifest rather than being an alias of Remove-Item', () => {
    // measured (pwsh): `Get-Alias -Definition Remove-Item` lists rm. v1 does
    // not, because it models a Linux box with the native tools unaliased, and
    // manifests.json follows v1.
    assert.equal(rm.manifest.name, 'rm');
    assert.equal(rm.manifest.display, 'rm');
    assert.ok(!removeItem.manifest.aliases.includes('rm'));
    assert.deepEqual([...removeItem.manifest.aliases].sort(), ['del', 'erase', 'rd', 'ri', 'rmdir']);
  });

  it('removes a file and says nothing', async () => {
    const r = await rig({ tree: { files: { [`${TEST_HOME}/f`]: 'f' } } });
    assert.equal(await r.run(rm, { remaining: ['f'] }), 0);
    assert.deepEqual(r.values, []);
    assert.equal(await r.exists(`${TEST_HOME}/f`), false);
  });

  it('refuses an EMPTY directory, where Remove-Item would take it', async () => {
    // measured (GNU rm 8.32): `rm d` on an empty directory is still
    // "Is a directory". rm has no rmdir behaviour; emptiness never enters into
    // it. The two tools genuinely disagree, and both are reproduced.
    const r = await rig({ tree: { directories: [`${TEST_HOME}/d`] } });
    const code = await r.run(rm, { remaining: ['d'] });

    assert.equal(code, 1);
    assert.equal(firstError(r.errors).message, "rm: cannot remove 'd': Is a directory");
    assert.equal(await r.exists(`${TEST_HOME}/d`), true);
  });

  it('is not helped by -f on a directory', async () => {
    // measured (GNU): -f suppresses "no such file", never "is a directory".
    const r = await rig({ tree: { files: { [`${TEST_HOME}/d/x`]: 'x' } } });
    assert.equal(await r.run(rm, { remaining: ['-f', 'd'] }), 1);
    assert.match(firstError(r.errors).message, /Is a directory/u);
  });

  it('takes a non-empty tree with -r', async () => {
    const r = await rig({ tree: { files: { [`${TEST_HOME}/d/x`]: 'x', [`${TEST_HOME}/d/e/y`]: 'y' } } });
    assert.equal(await r.run(rm, { remaining: ['-rf', 'd'] }), 0);
    assert.equal(await r.exists(`${TEST_HOME}/d`), false);
  });

  it('accepts the long forms v1 supported', async () => {
    const r = await rig({ tree: { files: { [`${TEST_HOME}/h/i`]: 'i' } } });
    assert.equal(await r.run(rm, { remaining: ['--recursive', '--force', 'h'] }), 0);
    assert.equal(await r.exists(`${TEST_HOME}/h`), false);
  });
});

describe('rm and its usage failures', () => {
  it('reports a missing operand in two lines, as GNU does', async () => {
    const r = await rig();
    const code = await r.run(rm);

    assert.equal(code, 1);
    assert.equal(
      firstError(r.errors).message,
      "rm: missing operand\nTry 'rm --help' for more information.",
    );
  });

  it('is silent about a missing operand when -f is given', async () => {
    // measured (GNU): `rm -f` alone exits 0 and prints nothing.
    const r = await rig();
    assert.equal(await r.run(rm, { remaining: ['-f'] }), 0);
    assert.deepEqual(r.errors, []);
  });

  it('reports a missing file, and -f silences exactly that', async () => {
    const r = await rig();
    assert.equal(await r.run(rm, { remaining: ['nope'] }), 1);
    assert.equal(
      firstError(r.errors).message,
      "rm: cannot remove 'nope': No such file or directory",
    );

    const quiet = await rig();
    assert.equal(await quiet.run(rm, { remaining: ['-f', 'nope'] }), 0);
    assert.deepEqual(quiet.errors, []);
  });

  it('refuses an option it does not know, rather than ignoring the letter', async () => {
    // measured (GNU): `rm -z b` is "unknown option -- z". v1 walks the cluster
    // and ignores anything that is not r/R/f, so `rm -i x` deleted without
    // asking. An ignored flag on a delete is what costs someone a file.
    const r = await rig({ tree: { files: { [`${TEST_HOME}/b`]: 'b' } } });
    const code = await r.run(rm, { remaining: ['-z', 'b'] });

    assert.equal(code, 1);
    assert.equal(
      firstError(r.errors).message,
      "rm: unknown option -- z\nTry 'rm --help' for more information.",
    );
    assert.equal(await r.read(`${TEST_HOME}/b`), 'b');
  });

  it('removes EVERY operand, and reports each failure separately', async () => {
    // measured (GNU): `rm a missing c` removes a and writes two errors. v1's
    // parser keeps only the last operand, which is a bug and is not reproduced.
    const r = await rig({ tree: { files: { [`${TEST_HOME}/a`]: 'a', [`${TEST_HOME}/b`]: 'b' } } });
    const code = await r.run(rm, { remaining: ['a', 'missing', 'b'] });

    assert.equal(code, 1);
    assert.equal(r.errors.length, 1);
    assert.equal(await r.exists(`${TEST_HOME}/a`), false);
    assert.equal(await r.exists(`${TEST_HOME}/b`), false);
  });

  it('honours -- so a file whose name starts with a dash is addressable', async () => {
    const r = await rig({ tree: { files: { [`${TEST_HOME}/-weird`]: 'w' } } });
    assert.equal(await r.run(rm, { remaining: ['--', '-weird'] }), 0);
    assert.equal(await r.exists(`${TEST_HOME}/-weird`), false);
  });
});

describe('rm and the two paths GNU protects', () => {
  it('reports "Is a directory" for / without -r, and the failsafe with it', async () => {
    // measured (GNU): the directory check runs FIRST, so `rm /` never reaches
    // --preserve-root. v1 has the same order.
    const plain = await rig();
    assert.equal(await plain.run(rm, { remaining: ['/'] }), 1);
    assert.equal(firstError(plain.errors).message, "rm: cannot remove '/': Is a directory");

    const recursive = await rig();
    assert.equal(await recursive.run(rm, { remaining: ['-rf', '/'] }), 1);
    assert.equal(
      firstError(recursive.errors).message,
      "rm: it is dangerous to operate recursively on '/'\n" +
        'rm: use --no-preserve-root to override this failsafe',
    );
    assert.equal(await recursive.exists(TEST_HOME), true);
  });

  it('refuses . and .. by the name that was typed', async () => {
    // measured (GNU): "refusing to remove '.' or '..' directory: skipping '.'"
    const r = await rig({ tree: { files: { [`${TEST_HOME}/here/x`]: 'x' } }, cwd: `${TEST_HOME}/here` });
    const code = await r.run(rm, { remaining: ['-rf', '.'] });

    assert.equal(code, 1);
    assert.equal(
      firstError(r.errors).message,
      "rm: refusing to remove '.' or '..' directory: skipping '.'",
    );
    assert.equal(await r.read(`${TEST_HOME}/here/x`), 'x');
  });
});

describe('rm stopped part way', () => {
  it('reports what it removed and what is still standing', async () => {
    const r = await rig({
      tree: { files: { [`${TEST_HOME}/t/a`]: 'a', [`${TEST_HOME}/t/b`]: 'b' } },
    });

    let seen = 0;
    r.vfs.onRemove = () => {
      seen += 1;
      if (seen === 1) r.abort.abort();
    };

    const code = await r.run(rm, { remaining: ['-rf', 't'] });

    assert.equal(code, 1);
    const error = firstError(r.errors);
    assert.equal(error.fullyQualifiedErrorId, 'RemoveStopped,rm');
    assert.equal(error.category, 'OperationStopped');
    assert.match(error.message, /rm: stopped after removing 1 item from 't'/u);
    assert.equal(await r.exists(`${TEST_HOME}/t`), true);
  });
});

describe('rm and the prompt it just deleted', () => {
  it('returns the location to HOME, which v1 also does', async () => {
    // GNU leaves the shell's cwd on a deleted inode; a real kernel can express
    // that and this VirtualFileSystem cannot — measured, `remove` does not move
    // `location` and `stat('.')` afterwards is ENOENT.
    const r = await rig({ tree: { files: { [`${TEST_HOME}/here/x`]: 'x' } }, cwd: `${TEST_HOME}/here` });
    const code = await r.run(rm, { remaining: ['-rf', `${TEST_HOME}/here`] });

    assert.equal(code, 0);
    assert.equal(await r.exists(`${TEST_HOME}/here`), false);
    assert.equal(r.vfs.location.path, TEST_HOME);
  });
});
