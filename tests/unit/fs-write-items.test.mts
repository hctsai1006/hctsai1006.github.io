/**
 * New-Item, Set-Content and Add-Content, against a real MemoryStorage.
 *
 * Every expectation here has a `// pwsh:` note naming what the reference
 * implementation did on 2026-09-05. Where there is no note the behaviour comes
 * from v1 or from the storage layer, and says so.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { addContent, newItem, setContent } from '../../src/commands/fs-write/index.ts';
import { HOME, errorIds, prop, session, typeNamesOf } from './fs-write-harness.mts';

describe('New-Item', () => {
  it('creates a file and emits a FileInfo, with no -PassThru', async () => {
    const s = await session();
    // pwsh: New-Item -ItemType File -Path a.txt -> one System.IO.FileInfo
    const run = await s.run(newItem, { Path: 'a.txt', ItemType: 'File' });
    assert.equal(run.exitCode, 0);
    assert.equal(run.values.length, 1);
    assert.deepEqual(typeNamesOf(run.values[0]).slice(0, 2), [
      'System.IO.FileInfo',
      'System.IO.FileSystemInfo',
    ]);
    assert.equal(prop(run.values[0], 'FullName'), `${HOME}/a.txt`);
    assert.equal(prop(run.values[0], 'Length'), 0);
    assert.equal(prop(run.values[0], 'PSIsContainer'), false);
    assert.equal(await s.text(`${HOME}/a.txt`), '');
  });

  it('defaults to a file when no -ItemType is given', async () => {
    // pwsh: New-Item -Path b in a script created a FILE, not a directory.
    const s = await session();
    await s.run(newItem, { Path: 'b' });
    assert.equal((await s.stat(`${HOME}/b`)).kind, 'file');
  });

  it('matches -ItemType by prefix, case-insensitively', async () => {
    // pwsh: 'd', 'di', 'dire', 'DIRECTORY' all made a directory; 'f', 'fi',
    // 'FILE' all made a file.
    const s = await session();
    for (const [type, kind] of [
      ['d', 'directory'],
      ['di', 'directory'],
      ['DIRECTORY', 'directory'],
      ['f', 'file'],
      ['FILE', 'file'],
    ] as const) {
      await s.run(newItem, { Path: `t-${type}`, ItemType: type });
      assert.equal((await s.stat(`${HOME}/t-${type}`)).kind, kind, type);
    }
  });

  it('refuses an unknown -ItemType with pwsh\'s own sentence', async () => {
    const s = await session();
    const run = await s.run(newItem, { Path: 's.txt', ItemType: 'Sausage' });
    // pwsh: Argument / InvalidArgument / PSArgumentException
    assert.deepEqual(errorIds(run), ['Argument,Microsoft.PowerShell.Commands.NewItemCommand']);
    assert.equal(run.errors[0]?.category, 'InvalidArgument');
    assert.match(run.errors[0]?.message ?? '', /not a known type for the file system/u);
    assert.equal(await s.exists(`${HOME}/s.txt`), false);
  });

  it('refuses a link type rather than quietly making a file', async () => {
    // There are no links in this filesystem; storage/types.ts says why.
    const s = await session();
    const run = await s.run(newItem, { Path: 'l', ItemType: 'symboliclink', Value: '/etc' });
    assert.equal(run.errors[0]?.category, 'NotImplemented');
    assert.equal(await s.exists(`${HOME}/l`), false);
  });

  describe('the two "already exists" errors', () => {
    it('gives NewItemIOError / WriteError for a file onto a file', async () => {
      const s = await session();
      await s.write(`${HOME}/a.txt`, 'x');
      const run = await s.run(newItem, { Path: 'a.txt', ItemType: 'File' });
      // pwsh: NewItemIOError,…NewItemCommand / WriteError / IOException
      assert.deepEqual(errorIds(run), [
        'NewItemIOError,Microsoft.PowerShell.Commands.NewItemCommand',
      ]);
      assert.equal(run.errors[0]?.category, 'WriteError');
      assert.equal(run.errors[0]?.exceptionType, 'System.IO.IOException');
      assert.equal(run.errors[0]?.message, `The file '${HOME}/a.txt' already exists.`);
      assert.equal(run.exitCode, 1);
      assert.equal(await s.text(`${HOME}/a.txt`), 'x');
    });

    it('gives DirectoryExist / ResourceExists for a directory onto a directory', async () => {
      const s = await session();
      await s.makeDirectory(`${HOME}/d1`);
      const run = await s.run(newItem, { Path: 'd1', ItemType: 'Directory' });
      // pwsh: DirectoryExist,…NewItemCommand / ResourceExists / IOException
      assert.deepEqual(errorIds(run), [
        'DirectoryExist,Microsoft.PowerShell.Commands.NewItemCommand',
      ]);
      assert.equal(run.errors[0]?.category, 'ResourceExists');
      assert.equal(run.errors[0]?.message, `An item with the specified name ${HOME}/d1 already exists.`);
    });

    it('gives DirectoryExist for a DIRECTORY onto an existing FILE — the id follows the ask', async () => {
      // pwsh, measured: the error id is chosen by the type requested, not by
      // the type that is in the way.
      const s = await session();
      await s.write(`${HOME}/a.txt`, 'x');
      const run = await s.run(newItem, { Path: 'a.txt', ItemType: 'Directory' });
      assert.deepEqual(errorIds(run), [
        'DirectoryExist,Microsoft.PowerShell.Commands.NewItemCommand',
      ]);
    });

    it('gives a PERMISSION error for a FILE onto an existing DIRECTORY', async () => {
      // pwsh: NewItemUnauthorizedAccessError / PermissionDenied /
      // UnauthorizedAccessException — not an "is a directory" error.
      const s = await session();
      await s.makeDirectory(`${HOME}/d1`);
      const run = await s.run(newItem, { Path: 'd1', ItemType: 'File' });
      assert.deepEqual(errorIds(run), [
        'NewItemUnauthorizedAccessError,Microsoft.PowerShell.Commands.NewItemCommand',
      ]);
      assert.equal(run.errors[0]?.category, 'PermissionDenied');
      assert.equal(run.errors[0]?.message, `Access to the path '${HOME}/d1' is denied.`);
    });
  });

  describe('-Force', () => {
    it('truncates an existing file', async () => {
      // pwsh: 11 bytes before, 0 after.
      const s = await session();
      await s.write(`${HOME}/a.txt`, 'PRESERVE ME');
      const run = await s.run(newItem, { Path: 'a.txt', ItemType: 'File', Force: true });
      assert.deepEqual(errorIds(run), []);
      assert.equal(await s.text(`${HOME}/a.txt`), '');
      assert.equal(run.values.length, 1);
    });

    it('leaves an existing directory\'s contents alone and emits it', async () => {
      const s = await session();
      await s.write(`${HOME}/d1/inner.txt`, 'x');
      const run = await s.run(newItem, { Path: 'd1', ItemType: 'Directory', Force: true });
      assert.deepEqual(errorIds(run), []);
      assert.equal(await s.text(`${HOME}/d1/inner.txt`), 'x');
      assert.deepEqual(typeNamesOf(run.values[0]).slice(0, 1), ['System.IO.DirectoryInfo']);
    });

    it('emits NOTHING and raises nothing for a DIRECTORY onto an existing FILE', async () => {
      // pwsh, measured twice: no object, no error, and the file is untouched.
      // It looks like a bug and it is what 7.6.5 does.
      const s = await session();
      await s.write(`${HOME}/f.txt`, 'keep me');
      const run = await s.run(newItem, { Path: 'f.txt', ItemType: 'Directory', Force: true });
      assert.deepEqual(errorIds(run), []);
      assert.deepEqual(run.values, []);
      assert.equal(run.exitCode, 0);
      assert.equal(await s.text(`${HOME}/f.txt`), 'keep me');
    });

    it('creates the parent chain for a file', async () => {
      const s = await session();
      const run = await s.run(newItem, { Path: 'nope2/x.txt', ItemType: 'File', Force: true });
      assert.deepEqual(errorIds(run), []);
      assert.equal(await s.exists(`${HOME}/nope2/x.txt`), true);
    });
  });

  describe('missing parents', () => {
    it('is an error for a FILE without -Force — writing into a missing directory', async () => {
      const s = await session();
      const run = await s.run(newItem, { Path: 'nope/x.txt', ItemType: 'File' });
      // pwsh: NewItemIOError / WriteError / DirectoryNotFoundException
      assert.deepEqual(errorIds(run), [
        'NewItemIOError,Microsoft.PowerShell.Commands.NewItemCommand',
      ]);
      assert.equal(run.errors[0]?.exceptionType, 'System.IO.DirectoryNotFoundException');
      assert.equal(
        run.errors[0]?.message,
        `Could not find a part of the path '${HOME}/nope/x.txt'.`,
      );
      assert.equal(await s.exists(`${HOME}/nope`), false);
    });

    it('is NOT an error for a DIRECTORY, even without -Force', async () => {
      // pwsh: New-Item -ItemType Directory deep/er/est built all three.
      const s = await session();
      const run = await s.run(newItem, { Path: 'deep/er/est', ItemType: 'Directory' });
      assert.deepEqual(errorIds(run), []);
      assert.equal((await s.stat(`${HOME}/deep/er/est`)).kind, 'directory');
    });

    it('stays an error when the parent is a FILE, with or without -Force', async () => {
      const s = await session();
      await s.write(`${HOME}/g.txt`, 'x');
      for (const force of [false, true]) {
        const run = await s.run(newItem, {
          Path: 'g.txt/child.txt',
          ItemType: 'File',
          ...(force ? { Force: true } : {}),
        });
        assert.deepEqual(errorIds(run), [
          'NewItemIOError,Microsoft.PowerShell.Commands.NewItemCommand',
        ]);
      }
      assert.equal(await s.text(`${HOME}/g.txt`), 'x');
    });
  });

  describe('-Value', () => {
    it('writes ToString() with NO trailing newline', async () => {
      // pwsh: -Value 'hello' is exactly five bytes.
      const s = await session();
      await s.run(newItem, { Path: 'c.txt', ItemType: 'File', Value: 'hello' });
      assert.equal((await s.bytes(`${HOME}/c.txt`)).length, 5);
      assert.equal(await s.text(`${HOME}/c.txt`), 'hello');
    });

    it('renders non-strings the way PowerShell does', async () => {
      // pwsh: 42 -> '42', $true -> 'True'.
      const s = await session();
      await s.run(newItem, { Path: 'v1.txt', ItemType: 'File', Value: 42 });
      await s.run(newItem, { Path: 'v2.txt', ItemType: 'File', Value: true });
      assert.equal(await s.text(`${HOME}/v1.txt`), '42');
      assert.equal(await s.text(`${HOME}/v2.txt`), 'True');
    });

    it('writes the literal text System.Object[] for an array', async () => {
      // pwsh, measured: fifteen bytes, because -Value is a scalar System.Object
      // and Object[].ToString() is its type name. Reproduced deliberately.
      const s = await session();
      await s.run(newItem, { Path: 'arr.txt', ItemType: 'File', Value: ['a', 'b'] });
      assert.equal(await s.text(`${HOME}/arr.txt`), 'System.Object[]');
    });

    it('is ignored for a directory', async () => {
      const s = await session();
      const run = await s.run(newItem, { Path: 'dv', ItemType: 'Directory', Value: 'ignored' });
      assert.deepEqual(errorIds(run), []);
      assert.equal((await s.stat(`${HOME}/dv`)).kind, 'directory');
    });
  });

  it('takes -Name relative to -Path, and -Name alone relative to the cwd', async () => {
    const s = await session();
    await s.makeDirectory(`${HOME}/d1`);
    await s.run(newItem, { Path: 'd1', Name: 'named.txt', ItemType: 'File' });
    await s.run(newItem, { Name: 'nameonly.txt', ItemType: 'File' });
    assert.equal(await s.exists(`${HOME}/d1/named.txt`), true);
    assert.equal(await s.exists(`${HOME}/nameonly.txt`), true);
  });

  it('continues past a failing path and emits one object per success', async () => {
    // pwsh: New-Item n1,exists,n3 created n1 and n3, emitted two objects and
    // raised exactly one error.
    const s = await session();
    await s.write(`${HOME}/exists.txt`, 'x');
    const run = await s.run(newItem, {
      Path: ['n1.txt', 'exists.txt', 'n3.txt'],
      ItemType: 'File',
    });
    assert.equal(run.values.length, 2);
    assert.equal(run.errors.length, 1);
    assert.equal(run.exitCode, 1);
    assert.equal(await s.exists(`${HOME}/n1.txt`), true);
    assert.equal(await s.exists(`${HOME}/n3.txt`), true);
  });
});

describe('Set-Content and Add-Content', () => {
  it('both create a missing file and emit nothing without -PassThru', async () => {
    // pwsh: emitted-count 0 for both; the file exists afterwards.
    for (const [module, name] of [
      [setContent, 'sc1.txt'],
      [addContent, 'ac1.txt'],
    ] as const) {
      const s = await session();
      const run = await s.run(module, { Path: name, Value: 'hello' });
      assert.deepEqual(run.values, [], name);
      assert.deepEqual(errorIds(run), [], name);
      assert.equal(await s.text(`${HOME}/${name}`), 'hello\n', name);
    }
  });

  it('writes one LF per element, and none at all with -NoNewline', async () => {
    // pwsh: @('a','b','c') -> a<t>b<t>c<t>; with -NoNewline -> the three bytes
    // 'abc'. The terminator is LF here rather than the capture host's CRLF —
    // the emulated machine is Ubuntu and format/out-string.ts pins the same.
    const s = await session();
    await s.run(setContent, { Path: 'arr.txt', Value: ['a', 'b', 'c'] });
    await s.run(setContent, { Path: 'arrn.txt', Value: ['a', 'b', 'c'], NoNewline: true });
    assert.equal(await s.text(`${HOME}/arr.txt`), 'a\nb\nc\n');
    assert.equal(await s.text(`${HOME}/arrn.txt`), 'abc');
  });

  it('flattens a nested array all the way down', async () => {
    // pwsh: @('a', @('b','c'), 'd') is four lines, not three.
    const s = await session();
    await s.run(setContent, { Path: 'nest.txt', Value: ['a', ['b', 'c'], 'd'] });
    assert.equal(await s.text(`${HOME}/nest.txt`), 'a\nb\nc\nd\n');
  });

  it('renders values with PowerShell ToString', async () => {
    // pwsh: 42 -> '42', $true -> 'True'.
    const s = await session();
    await s.run(setContent, { Path: 'v.txt', Value: [42, true] });
    assert.equal(await s.text(`${HOME}/v.txt`), '42\nTrue\n');
  });

  it('creates an empty file for an empty value', async () => {
    // pwsh: Set-Content -Value @() and -Value $null both leave a 0-byte file.
    const s = await session();
    await s.run(setContent, { Path: 'empty.txt', Value: [] });
    assert.equal((await s.bytes(`${HOME}/empty.txt`)).length, 0);
  });

  it('takes its value from the pipeline when -Value is unbound', async () => {
    // pwsh: 'p1','p2' | Set-Content -Path pipe.txt wrote two lines.
    const s = await session();
    await s.run(setContent, { Path: 'pipe.txt' }, { input: ['p1', 'p2'] });
    assert.equal(await s.text(`${HOME}/pipe.txt`), 'p1\np2\n');
  });

  it('appends with no separator of its own', async () => {
    // pwsh: 'ab' + Add-Content 'CD' is 'abCD' + terminator, not 'ab\nCD'.
    const s = await session();
    await s.run(setContent, { Path: 'ac2.txt', Value: 'ab', NoNewline: true });
    await s.run(addContent, { Path: 'ac2.txt', Value: 'CD' });
    assert.equal(await s.text(`${HOME}/ac2.txt`), 'abCD\n');
  });

  describe('writing into a missing directory', () => {
    it('is an error for both, and -Force does NOT fix it', async () => {
      // pwsh: GetContentWriterDirectoryNotFoundError / ObjectNotFound, with and
      // without -Force. -Force overrides a read-only file, not a missing parent.
      for (const [module, command] of [
        [setContent, 'SetContentCommand'],
        [addContent, 'AddContentCommand'],
      ] as const) {
        const s = await session();
        for (const force of [false, true]) {
          const run = await s.run(module, {
            Path: 'no/x.txt',
            Value: 'v',
            ...(force ? { Force: true } : {}),
          });
          assert.deepEqual(errorIds(run), [
            `GetContentWriterDirectoryNotFoundError,Microsoft.PowerShell.Commands.${command}`,
          ]);
          assert.equal(run.errors[0]?.category, 'ObjectNotFound');
          assert.equal(
            run.errors[0]?.message,
            `Could not find a part of the path '${HOME}/no/x.txt'.`,
          );
        }
        assert.equal(await s.exists(`${HOME}/no`), false);
      }
    });
  });

  describe('writing onto a directory', () => {
    it('gives DIFFERENT errors for the two commands', async () => {
      // pwsh, both measured on the same path: Set-Content reports a
      // NotSupportedException about CLEARING; Add-Content reports
      // WriteContainerContentException about WRITING.
      const s = await session();
      await s.makeDirectory(`${HOME}/dd`);

      const set = await s.run(setContent, { Path: 'dd', Value: 'x' });
      assert.deepEqual(errorIds(set), [
        'System.NotSupportedException,Microsoft.PowerShell.Commands.SetContentCommand',
      ]);
      assert.match(set.errors[0]?.message ?? '', /Clear-Content is only supported on files/u);

      const add = await s.run(addContent, { Path: 'dd', Value: 'x' });
      assert.deepEqual(errorIds(add), [
        'WriteContainerContentException,Microsoft.PowerShell.Commands.AddContentCommand',
      ]);
      assert.equal(add.errors[0]?.category, 'InvalidOperation');
      assert.equal(
        add.errors[0]?.message,
        `Unable to write content because it is a directory: '${HOME}/dd'.`,
      );
    });
  });

  it('continues past a failing path', async () => {
    // pwsh: s1 and s3 were written and one error was raised.
    const s = await session();
    const run = await s.run(setContent, {
      Path: ['s1.txt', 'no/s2.txt', 's3.txt'],
      Value: 'v',
    });
    assert.equal(run.errors.length, 1);
    assert.equal(await s.exists(`${HOME}/s1.txt`), true);
    assert.equal(await s.exists(`${HOME}/s3.txt`), true);
  });

  it('emits the -Value object once per successful path with -PassThru', async () => {
    // pwsh: two paths and -Value @('x','y') produced TWO System.Object[]; a run
    // where one of two paths failed produced ONE.
    const s = await session();
    const run = await s.run(setContent, {
      Path: ['p1.txt', 'p2.txt'],
      Value: ['x', 'y'],
      PassThru: true,
    });
    assert.equal(run.values.length, 2);
    assert.deepEqual(run.values[0], ['x', 'y']);

    const partial = await s.run(setContent, {
      Path: ['q1.txt', 'no/q2.txt'],
      Value: 'z',
      PassThru: true,
    });
    assert.deepEqual(partial.values, ['z']);
  });

  describe('-Encoding', () => {
    it('defaults to UTF-8 with no BOM', async () => {
      // pwsh: 'abc' is 97,98,99 + terminator, no BOM.
      const s = await session();
      await s.run(setContent, { Path: 'enc.txt', Value: 'abc' });
      assert.deepEqual([...(await s.bytes(`${HOME}/enc.txt`))], [97, 98, 99, 10]);
    });

    it('writes a BOM for utf8BOM', async () => {
      // pwsh: 239,187,191 then the text.
      const s = await session();
      await s.run(setContent, { Path: 'encb.txt', Value: 'abc', Encoding: 'utf8BOM' });
      assert.deepEqual([...(await s.bytes(`${HOME}/encb.txt`))], [239, 187, 191, 97, 98, 99, 10]);
    });

    it('replaces non-ASCII with a question mark for ascii', async () => {
      const s = await session();
      await s.run(setContent, { Path: 'enca.txt', Value: 'aé', Encoding: 'ascii' });
      assert.equal(await s.text(`${HOME}/enca.txt`), 'a?\n');
    });

    it('refuses a recognised encoding it cannot store faithfully', async () => {
      const s = await session();
      const run = await s.run(setContent, { Path: 'encu.txt', Value: 'ab', Encoding: 'unicode' });
      assert.equal(run.errors[0]?.category, 'NotImplemented');
      assert.equal(await s.exists(`${HOME}/encu.txt`), false);
    });

    it('reports an unknown encoding as a binding transformation failure', async () => {
      // pwsh: ParameterArgumentTransformationError / InvalidData.
      const s = await session();
      const run = await s.run(setContent, { Path: 'x.txt', Value: 'a', Encoding: 'sausage' });
      assert.deepEqual(errorIds(run), [
        'ParameterArgumentTransformationError,Microsoft.PowerShell.Commands.SetContentCommand',
      ]);
      assert.equal(run.errors[0]?.category, 'InvalidData');
    });
  });
});
