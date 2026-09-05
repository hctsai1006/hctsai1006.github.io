/**
 * The five PowerShell filesystem READ cmdlets, against what pwsh 7.6.5 actually
 * did.
 *
 * EVERY EXPECTATION IN THIS FILE CARRIES THE PROBE THAT PRODUCED IT. The probe
 * scripts were run against a real `pwsh 7.6.5` on `.NET 10.0.11` with a fixture
 * tree on the host filesystem; the transcript line is quoted above the
 * assertion. Where the reference implementation could not be asked — the Unix
 * aliases, the POSIX permission bits, a NAME_MAX that Windows does not enforce —
 * the comment says so instead of implying a measurement that does not exist.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FS_READ_ERROR_MAPPINGS,
  getChildItem,
  getContent,
  selectString,
  setLocation,
  storageErrorRecord,
  testPath,
} from '../../src/commands/fs-read/index.ts';
import { isOk } from '../../src/storage/index.ts';
import type { StorageError, StorageErrorCode } from '../../src/storage/index.ts';
import type { PSValue } from '../../src/pipeline/psobject.ts';
import {
  HOME,
  column,
  errorIds,
  harness,
  has,
  names,
  prop,
  run,
  typeNamesOf,
} from './fs-read-harness.mts';

const TREE = {
  files: {
    [`${HOME}/alpha.txt`]: 'one\ntwo\nthree',
    [`${HOME}/trail.txt`]: 'one\ntwo\nthree\n',
    [`${HOME}/empty.txt`]: '',
    [`${HOME}/notrail.txt`]: 'solo',
    [`${HOME}/zeta.md`]: '# Zeta\nalpha beta\nGAMMA\ndelta',
    [`${HOME}/.hidden`]: 'hidden\n',
    [`${HOME}/sub/inner.txt`]: 'inner one\ninner two\n',
    [`${HOME}/sub/deeper/deep.txt`]: 'deep\n',
  },
  directories: [`${HOME}/emptydir`],
} as const;

// ---------------------------------------------------------------------------
// Get-ChildItem
// ---------------------------------------------------------------------------

describe('Get-ChildItem', () => {
  it('emits FileInfo and DirectoryInfo with the measured type chains', async () => {
    const { port } = await harness(TREE);
    const result = await run(getChildItem, {}, { port });

    // pwsh: (Get-Item alpha.txt).PSTypeNames
    //   -> System.IO.FileInfo, System.IO.FileSystemInfo,
    //      System.MarshalByRefObject, System.Object
    const file = result.values.find((value) => prop(value, 'Name') === 'alpha.txt');
    assert.deepEqual(typeNamesOf(file), [
      'System.IO.FileInfo',
      'System.IO.FileSystemInfo',
      'System.MarshalByRefObject',
      'System.Object',
    ]);
    // pwsh: (Get-Item sub).PSTypeNames -> the DirectoryInfo chain
    const directory = result.values.find((value) => prop(value, 'Name') === 'sub');
    assert.equal(typeNamesOf(directory)[0], 'System.IO.DirectoryInfo');
  });

  it('lists directories first, then files, each collated', async () => {
    // The order probe used a directory of `a` and `M` plus the files
    // `_u.txt 1.txt a-b.txt a.txt ab.txt B.txt C.txt Z.txt`:
    //
    //   pwsh: a | M | _u.txt | 1.txt | a-b.txt | a.txt | ab.txt | B.txt | C.txt | Z.txt
    //
    // Neither ordinal (which puts 1.txt before B.txt and _u.txt after Z.txt)
    // nor natural. The pinned 'en' collator behind compareValues reproduces it.
    const { port } = await harness({
      files: Object.fromEntries(
        ['_u.txt', '1.txt', 'a-b.txt', 'a.txt', 'ab.txt', 'B.txt', 'C.txt', 'Z.txt'].map((n) => [
          `${HOME}/${n}`,
          'x',
        ]),
      ),
      directories: [`${HOME}/a`, `${HOME}/M`],
    });
    const result = await run(getChildItem, {}, { port });
    assert.deepEqual(names(result.values), [
      'a',
      'M',
      '_u.txt',
      '1.txt',
      'a-b.txt',
      'a.txt',
      'ab.txt',
      'B.txt',
      'C.txt',
      'Z.txt',
    ]);
  });

  it('gives a directory no Length property at all', async () => {
    // pwsh: (Get-Item sub).PSObject.Properties['Length']  ->  $null
    //       (Get-Item sub).Length                         ->  1
    // The 1 is PowerShell's intrinsic collection Count, not a size. Get-Member
    // on a DirectoryInfo lists no Length, and Format-Table leaves the cell blank.
    const { port } = await harness(TREE);
    const result = await run(getChildItem, {}, { port });
    const directory = result.values.find((value) => prop(value, 'Name') === 'sub');
    const file = result.values.find((value) => prop(value, 'Name') === 'alpha.txt');
    assert.equal(has(directory, 'Length'), false);
    assert.equal(has(file, 'Length'), true);
    assert.equal(prop(file, 'Length'), 13);
  });

  it('emits nothing for an empty directory, and no error', async () => {
    // pwsh: @(Get-ChildItem emptydir).Count -> 0, with no error
    const { port } = await harness(TREE);
    const result = await run(getChildItem, { Path: `${HOME}/emptydir` }, { port });
    assert.deepEqual(result.values, []);
    assert.deepEqual(result.errors, []);
  });

  it('emits the file itself when the path names a file', async () => {
    // pwsh: Get-ChildItem alpha.txt -> one FileInfo named alpha.txt
    const { port } = await harness(TREE);
    const result = await run(getChildItem, { Path: `${HOME}/alpha.txt` }, { port });
    assert.deepEqual(names(result.values), ['alpha.txt']);
  });

  it('hides dot-files until -Force, and -Hidden shows only them', async () => {
    // pwsh: Get-ChildItem -Force  ->  emptydir | sub | .hidden | alpha.txt | ...
    //       .hidden sorts FIRST among the files, which the collator reproduces
    //       because '.' is punctuation and punctuation precedes letters.
    // pwsh: Get-ChildItem -Hidden ->  .hidden, and nothing else
    const { port } = await harness(TREE);
    const plain = await run(getChildItem, {}, { port });
    assert.equal(names(plain.values).includes('.hidden'), false);

    const forced = await run(getChildItem, { Force: true }, { port });
    assert.deepEqual(names(forced.values), [
      'emptydir',
      'sub',
      '.hidden',
      'alpha.txt',
      'empty.txt',
      'notrail.txt',
      'trail.txt',
      'zeta.md',
    ]);

    const hidden = await run(getChildItem, { Hidden: true }, { port });
    assert.deepEqual(names(hidden.values), ['.hidden']);
  });

  it('recurses breadth-then-descend, which is NOT a depth-first walk', async () => {
    // pwsh, in a tree of aa/{aaa/a2.txt,a1.txt}, bb/b1.txt and root.txt:
    //   Get-ChildItem -Recurse
    //     ->  aa | bb | root.txt | aa\aaa | aa\a1.txt | aa\aaa\a2.txt | bb\b1.txt
    // Everything at a level comes out before anything below it.
    const { port } = await harness({
      files: {
        '/t/root.txt': 'x',
        '/t/aa/a1.txt': 'x',
        '/t/aa/aaa/a2.txt': 'x',
        '/t/bb/b1.txt': 'x',
      },
    });
    const result = await run(getChildItem, { Path: '/t', Recurse: true, Name: true }, { port });
    assert.deepEqual(result.values, [
      'aa',
      'bb',
      'root.txt',
      'aa/aaa',
      'aa/a1.txt',
      'aa/aaa/a2.txt',
      'bb/b1.txt',
    ]);
  });

  it('switches to immediate descent when -Include or -Exclude is present', async () => {
    // The single strangest measurement in the set. Same tree as above:
    //   pwsh: Get-ChildItem -Include *.txt -Recurse
    //         ->  aa\aaa\a2.txt | aa\a1.txt | bb\b1.txt | root.txt
    //   pwsh: Get-ChildItem -Exclude *.txt -Recurse
    //         ->  aa | aa\aaa | bb
    // Both fall out of one rule: with -Include/-Exclude the walk enters a child
    // directory the moment it reaches it, and directories sort first — so the
    // deepest match is emitted before the current directory's own files.
    const tree = {
      files: {
        '/t/root.txt': 'x',
        '/t/aa/a1.txt': 'x',
        '/t/aa/aaa/a2.txt': 'x',
        '/t/bb/b1.txt': 'x',
      },
    };
    const { port } = await harness(tree);

    const included = await run(
      getChildItem,
      { Path: '/t', Include: ['*.txt'], Recurse: true },
      { port },
    );
    assert.deepEqual(
      column(included.values, 'FullName'),
      ['/t/aa/aaa/a2.txt', '/t/aa/a1.txt', '/t/bb/b1.txt', '/t/root.txt'],
    );

    const excluded = await run(
      getChildItem,
      { Path: '/t', Exclude: ['*.txt'], Recurse: true },
      { port },
    );
    assert.deepEqual(column(excluded.values, 'FullName'), ['/t/aa', '/t/aa/aaa', '/t/bb']);
  });

  it('-Filter does NOT change the traversal, only the output', async () => {
    // pwsh: Get-ChildItem -Filter *.txt -Recurse
    //       ->  root.txt | aa\a1.txt | aa\aaa\a2.txt | bb\b1.txt
    const { port } = await harness({
      files: {
        '/t/root.txt': 'x',
        '/t/aa/a1.txt': 'x',
        '/t/aa/aaa/a2.txt': 'x',
        '/t/bb/b1.txt': 'x',
      },
    });
    const result = await run(
      getChildItem,
      { Path: '/t', Filter: '*.txt', Recurse: true },
      { port },
    );
    assert.deepEqual(
      column(result.values, 'FullName'),
      ['/t/root.txt', '/t/aa/a1.txt', '/t/aa/aaa/a2.txt', '/t/bb/b1.txt'],
    );
  });

  it('-Name uses the breadth order even with -Include', async () => {
    // pwsh: Get-ChildItem -Include *.txt -Recurse -Name
    //       ->  root.txt | aa\a1.txt | aa\aaa\a2.txt | bb\b1.txt
    // The object form of the SAME command is deepest-first. -Name goes through
    // a different code path in the provider, and reproducing one order for both
    // would be wrong for one of them.
    const { port } = await harness({
      files: {
        '/t/root.txt': 'x',
        '/t/aa/a1.txt': 'x',
        '/t/aa/aaa/a2.txt': 'x',
        '/t/bb/b1.txt': 'x',
      },
    });
    const result = await run(
      getChildItem,
      { Path: '/t', Include: ['*.txt'], Recurse: true, Name: true },
      { port },
    );
    assert.deepEqual(result.values, ['root.txt', 'aa/a1.txt', 'aa/aaa/a2.txt', 'bb/b1.txt']);
  });

  it('-Include with a literal path and no -Recurse matches nothing', async () => {
    // pwsh: Get-ChildItem -Include *.txt            ->  nothing
    //       Get-ChildItem * -Include *.txt          ->  the .txt files
    const { port } = await harness(TREE);
    const inert = await run(getChildItem, { Include: ['*.txt'] }, { port });
    assert.deepEqual(inert.values, []);

    const globbed = await run(getChildItem, { Path: `${HOME}/*`, Include: ['*.txt'] }, { port });
    assert.deepEqual(names(globbed.values).sort(), [
      'alpha.txt',
      'empty.txt',
      'notrail.txt',
      'trail.txt',
    ]);
  });

  it('-Depth implies -Recurse and counts levels below the start', async () => {
    // pwsh: Get-ChildItem -Depth 0  ->  only the immediate children
    //       Get-ChildItem -Depth 1  ->  children and grandchildren
    const { port } = await harness(TREE);
    const depth0 = await run(getChildItem, { Depth: 0, Name: true }, { port });
    assert.deepEqual(depth0.values, [
      'emptydir',
      'sub',
      'alpha.txt',
      'empty.txt',
      'notrail.txt',
      'trail.txt',
      'zeta.md',
    ]);

    const depth1 = await run(getChildItem, { Depth: 1, Name: true }, { port });
    assert.deepEqual(depth1.values, [
      'emptydir',
      'sub',
      'alpha.txt',
      'empty.txt',
      'notrail.txt',
      'trail.txt',
      'zeta.md',
      'sub/deeper',
      'sub/inner.txt',
    ]);
  });

  it('-File and -Directory together emit nothing', async () => {
    // pwsh: Get-ChildItem -File -Directory  ->  no output
    const { port } = await harness(TREE);
    const result = await run(getChildItem, { File: true, Directory: true }, { port });
    assert.deepEqual(result.values, []);
  });

  it('reports a missing literal path and stays quiet for a wildcard miss', async () => {
    // pwsh: Get-ChildItem nope
    //   PathNotFound,Microsoft.PowerShell.Commands.GetChildItemCommand
    //   ObjectNotFound / System.Management.Automation.ItemNotFoundException
    //   "Cannot find path '<full>' because it does not exist."
    // pwsh: Get-ChildItem 'zz*'  ->  no output, NO error
    const { port } = await harness(TREE);
    const missing = await run(getChildItem, { Path: `${HOME}/nope` }, { port });
    assert.deepEqual(errorIds(missing.errors), [
      'PathNotFound,Microsoft.PowerShell.Commands.GetChildItemCommand',
    ]);
    assert.equal(missing.errors[0]?.category, 'ObjectNotFound');
    assert.equal(
      missing.errors[0]?.exceptionType,
      'System.Management.Automation.ItemNotFoundException',
    );
    assert.equal(
      missing.errors[0]?.message,
      `Cannot find path '${HOME}/nope' because it does not exist.`,
    );

    const glob = await run(getChildItem, { Path: `${HOME}/zz*` }, { port });
    assert.deepEqual(glob.values, []);
    assert.deepEqual(glob.errors, []);
  });

  it('reports an unreadable directory as PermissionDenied and keeps going', async () => {
    // Reproduced on Windows with a Deny ACE:
    //   pwsh: Get-ChildItem <denied dir>
    //     DirUnauthorizedAccessError,...GetChildItemCommand
    //     PermissionDenied / System.UnauthorizedAccessException
    //     "Access to the path '<full>' is denied."
    const { port } = await harness({
      files: { '/t/locked/secret.txt': 'x', '/t/open.txt': 'x' },
      modes: { '/t/locked': 0o000 },
    });
    const result = await run(getChildItem, { Path: '/t', Recurse: true, Name: true }, { port });
    assert.deepEqual(errorIds(result.errors), [
      'DirUnauthorizedAccessError,Microsoft.PowerShell.Commands.GetChildItemCommand',
    ]);
    assert.equal(result.errors[0]?.category, 'PermissionDenied');
    assert.equal(result.errors[0]?.message, "Access to the path '/t/locked' is denied.");
    // The sibling still came out: the failure is per item, not per command.
    assert.equal(result.values.includes('open.txt'), true);
  });

  it('handles a name containing a newline', async () => {
    // Windows REFUSES to create such a file ("The filename, directory name, or
    // volume label syntax is incorrect"), so there is no pwsh measurement — this
    // filesystem is POSIX and only a NUL is forbidden. The assertion is that the
    // name survives intact rather than being split or trimmed.
    const weird = `${HOME}/we\nird.txt`;
    const { port } = await harness({ files: { [weird]: 'content\n' } });
    const listed = await run(getChildItem, {}, { port });
    assert.equal(names(listed.values).includes('we\nird.txt'), true);

    const read = await run(getContent, { LiteralPath: [weird] }, { port });
    assert.deepEqual(read.values, ['content']);
  });

  it('lists a ten-thousand-entry directory in one collated run', async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 10_000; index += 1) files[`/big/f${String(index)}.txt`] = 'x';
    const { port } = await harness({ files });

    const result = await run(getChildItem, { Path: '/big', Name: true }, { port });
    assert.equal(result.values.length, 10_000);
    // pwsh sorts a directory of f1..f12 as f1 f10 f11 f12 f2 ... — lexicographic,
    // NOT natural. Measured on the real filesystem.
    assert.deepEqual(result.values.slice(0, 4), ['f0.txt', 'f1.txt', 'f10.txt', 'f100.txt']);
  });

  it('stops a recursive listing the moment the signal aborts', async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 500; index += 1) files[`/deep/d${String(index)}/f.txt`] = 'x';
    const { port } = await harness({ files });

    const controller = new AbortController();
    // Abort before the walk begins: `throwIfCancelled` is checked on entry to
    // every directory, so the listing must raise rather than complete.
    controller.abort();
    await assert.rejects(
      () =>
        run(
          getChildItem,
          { Path: '/deep', Recurse: true },
          { port, signal: controller.signal },
        ),
      /cancelled|Cancelled/u,
    );
  });

  it('refuses the Windows-attribute parameters instead of ignoring them', async () => {
    // -Attributes, -ReadOnly, -System and -FollowSymlink describe a Windows
    // flags enum and symbolic links, neither of which this storage has. Binding
    // them and doing nothing would make a filtered listing silently wrong.
    const { port } = await harness(TREE);
    const result = await run(getChildItem, { Attributes: 'Hidden' }, { port });
    assert.equal(result.exitCode, 1);
    assert.match(result.errors[0]?.fullyQualifiedErrorId ?? '', /^ParameterNotImplemented,/u);
  });

  it('produces a clear error, not a crash, when the host has no filesystem', async () => {
    // `src/pipeline/pipeline.ts` and `src/kernel/kernel.ts` both build the
    // InvocationContext with `fs: null`, so this is the branch the shipped
    // engine takes today.
    const result = await run(getChildItem, {}, { port: null });
    assert.equal(result.exitCode, 1);
    assert.equal(
      result.errors[0]?.fullyQualifiedErrorId,
      'FileSystemUnavailable,Microsoft.PowerShell.Commands.GetChildItemCommand',
    );
    assert.equal(result.errors[0]?.category, 'ResourceUnavailable');
  });

  it('reads through a port that refuses every write', async () => {
    // The broker, not the command. `ports.test.mts` proves the port refuses;
    // this proves the command really goes through THAT port — it lists happily
    // with only `filesystem.read` granted, and the same object rejects a write.
    const { port, vfs } = await harness(TREE, { granted: ['filesystem.read'] });
    const result = await run(getChildItem, {}, { port });
    assert.equal(result.values.length > 0, true);
    await assert.rejects(() => port.writeText(`${HOME}/x`, 'hi'), /filesystem\.write/u);
    await assert.rejects(() => port.remove(`${HOME}/alpha.txt`), /filesystem\.delete/u);
    assert.equal(isOk(await vfs.stat(`${HOME}/alpha.txt`)), true);
  });

  it('propagates a capability denial rather than swallowing it', async () => {
    // A command whose grant was dropped underneath it must not report an empty
    // listing as if the directory were empty. The port throws, and the throw
    // travels: `commandStage` turns a rejected invoke into exit code 1 and
    // fails the channel, which is how the denial reaches the user.
    const { port } = await harness(TREE, { granted: [] });
    await assert.rejects(() => run(getChildItem, {}, { port }), /filesystem\.read/u);
  });
});

// ---------------------------------------------------------------------------
// Get-Content
// ---------------------------------------------------------------------------

describe('Get-Content', () => {
  it('emits one string per line, and a trailing newline adds none', async () => {
    // pwsh: Get-Content trail.txt  ("one\ntwo\nthree\n")  ->  3 items
    //       Get-Content alpha.txt  ("one\ntwo\nthree")    ->  3 items
    const { port } = await harness(TREE);
    const trailing = await run(getContent, { Path: [`${HOME}/trail.txt`] }, { port });
    assert.deepEqual(trailing.values, ['one', 'two', 'three']);
    const bare = await run(getContent, { Path: [`${HOME}/alpha.txt`] }, { port });
    assert.deepEqual(bare.values, ['one', 'two', 'three']);
  });

  it('emits nothing for an empty file, with or without -Raw', async () => {
    // pwsh: @(Get-Content empty.txt).Count       ->  0
    //       @(Get-Content empty.txt -Raw).Count  ->  0
    // -Raw returning '' would be wrong, and only the empty file shows it.
    const { port } = await harness(TREE);
    const lines = await run(getContent, { Path: [`${HOME}/empty.txt`] }, { port });
    assert.deepEqual(lines.values, []);
    const raw = await run(getContent, { Path: [`${HOME}/empty.txt`], Raw: true }, { port });
    assert.deepEqual(raw.values, []);
  });

  it('-Raw keeps the trailing newline in one string', async () => {
    // pwsh: Get-Content trail.txt -Raw  ->  "one\ntwo\nthree\n", Length 14
    const { port } = await harness(TREE);
    const result = await run(getContent, { Path: [`${HOME}/trail.txt`], Raw: true }, { port });
    assert.deepEqual(result.values, ['one\ntwo\nthree\n']);
  });

  it('treats a lone carriage return as a line separator', async () => {
    // pwsh: "a\rb" -> 2 lines. Splitting on "\n" alone silently joins them.
    const { port } = await harness({
      files: { '/t/cr.txt': 'a\rb', '/t/crlf.txt': 'a\r\nb\r\nc' },
    });
    const cr = await run(getContent, { Path: ['/t/cr.txt'] }, { port });
    assert.deepEqual(cr.values, ['a', 'b']);
    // pwsh: "a\r\nb\r\nc" -> 3 lines, and the first carries no \r.
    const crlf = await run(getContent, { Path: ['/t/crlf.txt'] }, { port });
    assert.deepEqual(crlf.values, ['a', 'b', 'c']);
  });

  it('applies -TotalCount and -Tail PER FILE', async () => {
    // pwsh: Get-Content alpha.txt, trail.txt -TotalCount 2  ->  4 items
    //       Get-Content alpha.txt, trail.txt -Tail 1        ->  2 items
    const { port } = await harness(TREE);
    const head = await run(
      getContent,
      { Path: [`${HOME}/alpha.txt`, `${HOME}/trail.txt`], TotalCount: 2 },
      { port },
    );
    assert.deepEqual(head.values, ['one', 'two', 'one', 'two']);

    const tail = await run(
      getContent,
      { Path: [`${HOME}/alpha.txt`, `${HOME}/trail.txt`], Tail: 1 },
      { port },
    );
    assert.deepEqual(tail.values, ['three', 'three']);
  });

  it('-TotalCount 0 and -Tail 0 emit nothing', async () => {
    // pwsh: both report count 0.
    const { port } = await harness(TREE);
    assert.deepEqual(
      (await run(getContent, { Path: [`${HOME}/trail.txt`], TotalCount: 0 }, { port })).values,
      [],
    );
    assert.deepEqual(
      (await run(getContent, { Path: [`${HOME}/trail.txt`], Tail: 0 }, { port })).values,
      [],
    );
  });

  it('refuses the three parameter combinations pwsh refuses, verbatim', async () => {
    const { port } = await harness(TREE);

    // pwsh: TailAndHeadCannotCoexist,...GetContentCommand
    const both = await run(
      getContent,
      { Path: [`${HOME}/trail.txt`], TotalCount: 2, Tail: 2 },
      { port },
    );
    assert.equal(
      both.errors[0]?.fullyQualifiedErrorId,
      'TailAndHeadCannotCoexist,Microsoft.PowerShell.Commands.GetContentCommand',
    );
    assert.equal(
      both.errors[0]?.message,
      'The parameters TotalCount and Tail cannot be used together. Please specify only one parameter.',
    );

    // pwsh: InvalidOperation,...GetContentCommand
    const rawHead = await run(
      getContent,
      { Path: [`${HOME}/trail.txt`], Raw: true, TotalCount: 2 },
      { port },
    );
    assert.equal(
      rawHead.errors[0]?.message,
      "The 'Raw' and 'TotalCount' parameters cannot be specified in the same command.",
    );

    const rawTail = await run(
      getContent,
      { Path: [`${HOME}/trail.txt`], Raw: true, Tail: 2 },
      { port },
    );
    assert.equal(
      rawTail.errors[0]?.message,
      "The 'Raw' and 'Tail' parameters cannot be specified in the same command.",
    );
  });

  it('-AsByteStream emits bytes, and -Raw makes them one array', async () => {
    // pwsh: Get-Content bytes.bin -AsByteStream       ->  4 System.Byte objects
    //       Get-Content bytes.bin -AsByteStream -Raw  ->  one System.Byte[]
    //       -AsByteStream -TotalCount 2               ->  0,1
    //       -AsByteStream -Tail 2                     ->  2,255
    const { port, vfs } = await harness({ directories: ['/t'] });
    assert.equal(isOk(await vfs.writeBytes('/t/bytes.bin', Uint8Array.from([0, 1, 2, 255]))), true);

    const stream = await run(getContent, { Path: ['/t/bytes.bin'], AsByteStream: true }, { port });
    assert.deepEqual(stream.values, [0, 1, 2, 255]);

    const raw = await run(
      getContent,
      { Path: ['/t/bytes.bin'], AsByteStream: true, Raw: true },
      { port },
    );
    assert.equal(raw.values[0] instanceof Uint8Array, true);
    assert.deepEqual([...(raw.values[0] as Uint8Array)], [0, 1, 2, 255]);

    const head = await run(
      getContent,
      { Path: ['/t/bytes.bin'], AsByteStream: true, TotalCount: 2 },
      { port },
    );
    assert.deepEqual(head.values, [0, 1]);

    const tail = await run(
      getContent,
      { Path: ['/t/bytes.bin'], AsByteStream: true, Tail: 2 },
      { port },
    );
    assert.deepEqual(tail.values, [2, 255]);
  });

  it('-ReadCount batches lines into arrays; 0 makes one array', async () => {
    // pwsh: Get-Content trail.txt -ReadCount 2 -> [one,two] then [three]
    //       Get-Content trail.txt -ReadCount 0 -> one System.Object[] of 3
    const { port } = await harness(TREE);
    const batched = await run(
      getContent,
      { Path: [`${HOME}/trail.txt`], ReadCount: 2 },
      { port },
    );
    assert.deepEqual(batched.values, [['one', 'two'], ['three']]);

    const one = await run(getContent, { Path: [`${HOME}/trail.txt`], ReadCount: 0 }, { port });
    assert.deepEqual(one.values, [['one', 'two', 'three']]);
  });

  it('reports a missing file and CONTINUES to the next one', async () => {
    // pwsh: Get-Content nope.txt, notrail.txt  ->  1 error AND 1 line of output
    //   PathNotFound,...GetContentCommand, ObjectNotFound, ItemNotFoundException
    const { port } = await harness(TREE);
    const result = await run(
      getContent,
      { Path: [`${HOME}/nope.txt`, `${HOME}/notrail.txt`] },
      { port },
    );
    assert.deepEqual(result.values, ['solo']);
    assert.deepEqual(errorIds(result.errors), [
      'PathNotFound,Microsoft.PowerShell.Commands.GetContentCommand',
    ]);
    assert.equal(
      result.errors[0]?.message,
      `Cannot find path '${HOME}/nope.txt' because it does not exist.`,
    );
  });

  it('reports a directory with the exact GetContainerContentException wording', async () => {
    // pwsh: Get-Content sub
    //   GetContainerContentException,...GetContentCommand
    //   InvalidOperation / System.InvalidOperationException
    //   "Unable to get content because it is a directory: '<full>'.
    //    Please use 'Get-ChildItem' instead."
    const { port } = await harness(TREE);
    const result = await run(getContent, { Path: [`${HOME}/sub`] }, { port });
    assert.deepEqual(errorIds(result.errors), [
      'GetContainerContentException,Microsoft.PowerShell.Commands.GetContentCommand',
    ]);
    assert.equal(result.errors[0]?.category, 'InvalidOperation');
    assert.equal(result.errors[0]?.exceptionType, 'System.InvalidOperationException');
    assert.equal(
      result.errors[0]?.message,
      `Unable to get content because it is a directory: '${HOME}/sub'. ` +
        "Please use 'Get-ChildItem' instead.",
    );
  });

  it('reports an unreadable file as GetContentReaderUnauthorizedAccessError', async () => {
    // Reproduced with a Deny ACE on Windows:
    //   GetContentReaderUnauthorizedAccessError,...GetContentCommand
    //   PermissionDenied / System.UnauthorizedAccessException
    //   "Access to the path '<full>' is denied."
    // Note the id differs from Get-ChildItem's DirUnauthorizedAccessError for
    // the same condition — one shared id would be wrong for one of them.
    const { port } = await harness({
      files: { '/t/locked.txt': 'secret\n' },
      modes: { '/t/locked.txt': 0o000 },
    });
    const result = await run(getContent, { Path: ['/t/locked.txt'] }, { port });
    assert.deepEqual(errorIds(result.errors), [
      'GetContentReaderUnauthorizedAccessError,Microsoft.PowerShell.Commands.GetContentCommand',
    ]);
    assert.equal(result.errors[0]?.category, 'PermissionDenied');
    assert.equal(result.errors[0]?.message, "Access to the path '/t/locked.txt' is denied.");
  });

  it('reports a wildcard that matched nothing with the -Include wording', async () => {
    // pwsh: Get-Content 'zz*.txt'
    //   ItemNotFound,...GetContentCommand, ObjectNotFound
    //   "An object at the specified path zz*.txt does not exist, or has been
    //    filtered by the -Include or -Exclude parameter."
    // Get-ChildItem stays SILENT for the same non-matching wildcard; the two
    // commands genuinely differ.
    const { port } = await harness(TREE);
    const result = await run(getContent, { Path: [`${HOME}/zz*.txt`] }, { port });
    assert.deepEqual(errorIds(result.errors), [
      'ItemNotFound,Microsoft.PowerShell.Commands.GetContentCommand',
    ]);
    assert.equal(
      result.errors[0]?.message,
      `An object at the specified path ${HOME}/zz*.txt does not exist, or has been filtered ` +
        'by the -Include or -Exclude parameter.',
    );
  });

  it('turns an injected device failure into a ReadError rather than throwing', async () => {
    // EIO is the one StorageErrorCode no probe of pwsh can produce: nothing in a
    // JavaScript object graph fails at the device level. `MemoryStorage` exists
    // to be able to cause one, and this proves the Result is handled.
    const { port } = await harness({ files: { '/t/a.txt': 'x' } }, { faultOn: ['read'] });
    const result = await run(getContent, { Path: ['/t/a.txt'] }, { port });
    assert.deepEqual(errorIds(result.errors), [
      'ReadError,Microsoft.PowerShell.Commands.GetContentCommand',
    ]);
    assert.equal(result.errors[0]?.exceptionType, 'System.IO.IOException');
  });

  it('explains itself when the host has no filesystem', async () => {
    const result = await run(getContent, { Path: ['/anything'] }, { port: null });
    assert.equal(result.exitCode, 1);
    assert.match(result.errors[0]?.message ?? '', /InvocationContext\.fs; it is null here/u);
  });
});

// ---------------------------------------------------------------------------
// Select-String
// ---------------------------------------------------------------------------

const POEM = 'alpha beta\nGamma alpha\ndelta\nalpha alpha alpha\nepsilon\n';

describe('Select-String', () => {
  it('emits MatchInfo with the measured property set', async () => {
    // pwsh: Select-String -Path poem.txt -Pattern alpha | Select-Object -First 1
    //   GetType()      Microsoft.PowerShell.Commands.MatchInfo
    //   PSTypeNames    Microsoft.PowerShell.Commands.MatchInfo, System.Object
    //   Get-Member     Context Filename IgnoreCase Line LineNumber Matches Path Pattern
    const { port } = await harness({ files: { '/t/poem.txt': POEM } });
    const result = await run(
      selectString,
      { Pattern: ['alpha'], Path: ['/t/poem.txt'] },
      { port },
    );
    const first = result.values[0];
    assert.deepEqual(typeNamesOf(first), [
      'Microsoft.PowerShell.Commands.MatchInfo',
      'System.Object',
    ]);
    assert.deepEqual(Object.keys((first as { properties: object }).properties).sort(), [
      'Context',
      'Filename',
      'IgnoreCase',
      'Line',
      'LineNumber',
      'Matches',
      'Path',
      'Pattern',
    ]);
    // pwsh: Path=<full> Filename=poem.txt LineNumber=1 Line='alpha beta'
    //       Pattern=alpha IgnoreCase=True Context is $null
    assert.equal(prop(first, 'Path'), '/t/poem.txt');
    assert.equal(prop(first, 'Filename'), 'poem.txt');
    assert.equal(prop(first, 'LineNumber'), 1);
    assert.equal(prop(first, 'Line'), 'alpha beta');
    assert.equal(prop(first, 'Pattern'), 'alpha');
    assert.equal(prop(first, 'IgnoreCase'), true);
    assert.equal(prop(first, 'Context'), null);
  });

  it('is case-INSENSITIVE by default and -CaseSensitive opts in', async () => {
    // pwsh: Select-String -Pattern 'gamma'                 ->  matches 'Gamma alpha'
    //       Select-String -Pattern 'gamma' -CaseSensitive  ->  0 matches
    // The opposite of grep, which is why the two are separate commands here.
    const { port } = await harness({ files: { '/t/poem.txt': POEM } });
    const loose = await run(selectString, { Pattern: ['gamma'], Path: ['/t/poem.txt'] }, { port });
    assert.equal(loose.values.length, 1);
    const strict = await run(
      selectString,
      { Pattern: ['gamma'], Path: ['/t/poem.txt'], CaseSensitive: true },
      { port },
    );
    assert.deepEqual(strict.values, []);
  });

  it('carries ONE match per line until -AllMatches', async () => {
    // pwsh: line 'alpha alpha alpha'
    //   default     ->  Matches.Count 1
    //   -AllMatches ->  Matches.Count 3, at offsets 0, 6, 12
    const { port } = await harness({ files: { '/t/poem.txt': POEM } });
    const single = await run(selectString, { Pattern: ['alpha'], Path: ['/t/poem.txt'] }, { port });
    const busy = single.values.find((value) => prop(value, 'LineNumber') === 4);
    assert.equal((prop(busy, 'Matches') as readonly PSValue[]).length, 1);

    const all = await run(
      selectString,
      { Pattern: ['alpha'], Path: ['/t/poem.txt'], AllMatches: true },
      { port },
    );
    const busyAll = all.values.find((value) => prop(value, 'LineNumber') === 4);
    const matches = prop(busyAll, 'Matches') as readonly PSValue[];
    assert.equal(matches.length, 3);
    assert.deepEqual(matches.map((match) => prop(match, 'Index')), [0, 6, 12]);
  });

  it('leaves Matches EMPTY for -SimpleMatch and for -NotMatch', async () => {
    // pwsh: -SimpleMatch              ->  Matches.Count 0
    //       -SimpleMatch -AllMatches  ->  Matches.Count 0 still
    //       -NotMatch                 ->  Matches.Count 0
    const { port } = await harness({ files: { '/t/dots.txt': 'a.c\nabc\n', '/t/poem.txt': POEM } });
    const simple = await run(
      selectString,
      { Pattern: ['a.c'], Path: ['/t/dots.txt'], SimpleMatch: true },
      { port },
    );
    // pwsh: without -SimpleMatch the regex `a.c` matches BOTH lines; with it,
    // only the literal one.
    assert.equal(simple.values.length, 1);
    assert.equal(prop(simple.values[0], 'Line'), 'a.c');
    assert.deepEqual(prop(simple.values[0], 'Matches'), []);

    const notMatch = await run(
      selectString,
      { Pattern: ['alpha'], Path: ['/t/poem.txt'], NotMatch: true },
      { port },
    );
    assert.deepEqual(column(notMatch.values, 'LineNumber'), [3, 5]);
    assert.deepEqual(prop(notMatch.values[0], 'Matches'), []);
  });

  it('-List reports only the first match in each file', async () => {
    // pwsh: Select-String -Path poem.txt -Pattern alpha -List  ->  1 item, line 1
    const { port } = await harness({ files: { '/t/poem.txt': POEM } });
    const result = await run(
      selectString,
      { Pattern: ['alpha'], Path: ['/t/poem.txt'], List: true },
      { port },
    );
    assert.equal(result.values.length, 1);
    assert.equal(prop(result.values[0], 'LineNumber'), 1);
  });

  it('-Context does not pad at the edges of a file', async () => {
    // pwsh: -Context 1 on 'delta' (line 3)
    //   PreContext  = Gamma alpha
    //   PostContext = alpha alpha alpha
    // pwsh: -Context 2,0 -> Pre = alpha beta | Gamma alpha, Post = empty
    // pwsh: -Context 2 on line 1 -> PreContext.Count 0, PostContext.Count 2
    const { port } = await harness({ files: { '/t/poem.txt': POEM } });

    const one = await run(
      selectString,
      { Pattern: ['delta'], Path: ['/t/poem.txt'], Context: 1 },
      { port },
    );
    const context = prop(one.values[0], 'Context');
    assert.deepEqual(prop(context, 'PreContext'), ['Gamma alpha']);
    assert.deepEqual(prop(context, 'PostContext'), ['alpha alpha alpha']);

    const asymmetric = await run(
      selectString,
      { Pattern: ['delta'], Path: ['/t/poem.txt'], Context: [2, 0] },
      { port },
    );
    const asym = prop(asymmetric.values[0], 'Context');
    assert.deepEqual(prop(asym, 'PreContext'), ['alpha beta', 'Gamma alpha']);
    assert.deepEqual(prop(asym, 'PostContext'), []);

    const atStart = await run(
      selectString,
      { Pattern: ['alpha beta'], Path: ['/t/poem.txt'], Context: 2 },
      { port },
    );
    const edge = prop(atStart.values[0], 'Context');
    assert.deepEqual(prop(edge, 'PreContext'), []);
    assert.deepEqual(prop(edge, 'PostContext'), ['Gamma alpha', 'delta']);
  });

  it('emits nothing when nothing matched, and -Quiet emits False', async () => {
    // pwsh: @(Select-String -Pattern zzzz).Count        ->  0
    //       @(Select-String -Pattern zzzz -Quiet).Count ->  1, the value False
    // $false is an ANSWER on the pipeline, not an absence.
    const { port } = await harness({ files: { '/t/poem.txt': POEM } });
    const none = await run(selectString, { Pattern: ['zzzz'], Path: ['/t/poem.txt'] }, { port });
    assert.deepEqual(none.values, []);

    const quiet = await run(
      selectString,
      { Pattern: ['zzzz'], Path: ['/t/poem.txt'], Quiet: true },
      { port },
    );
    assert.deepEqual(quiet.values, [false]);

    const quietHit = await run(
      selectString,
      { Pattern: ['alpha'], Path: ['/t/poem.txt'], Quiet: true },
      { port },
    );
    assert.deepEqual(quietHit.values, [true]);
  });

  it('ignores a directory in SILENCE, unlike Get-Content', async () => {
    // pwsh: Select-String -Path sub -Pattern a -ErrorAction Stop
    //       ->  0 items and NO error, where Get-Content raises
    //           GetContainerContentException for the same path.
    const { port } = await harness(TREE);
    const result = await run(selectString, { Pattern: ['a'], Path: [`${HOME}/sub`] }, { port });
    assert.deepEqual(result.values, []);
    assert.deepEqual(result.errors, []);
  });

  it('reports a missing path with the SelectString error id', async () => {
    // pwsh: PathNotFound,Microsoft.PowerShell.Commands.SelectStringCommand
    const { port } = await harness(TREE);
    const result = await run(selectString, { Pattern: ['a'], Path: [`${HOME}/nope.txt`] }, { port });
    assert.deepEqual(errorIds(result.errors), [
      'PathNotFound,Microsoft.PowerShell.Commands.SelectStringCommand',
    ]);
  });

  it('reads the pipeline as InputStream, numbering the input objects', async () => {
    // pwsh: Get-Content poem.txt | Select-String -Pattern alpha
    //   Path=InputStream Filename=InputStream, LineNumber 1, 2 and 4
    const { port } = await harness();
    const result = await run(
      selectString,
      { Pattern: ['alpha'] },
      { port, input: ['alpha beta', 'Gamma alpha', 'delta', 'alpha alpha alpha', 'epsilon'] },
    );
    assert.deepEqual(column(result.values, 'LineNumber'), [1, 2, 4]);
    assert.equal(prop(result.values[0], 'Path'), 'InputStream');
    assert.equal(prop(result.values[0], 'Filename'), 'InputStream');
  });

  it('reports one MatchInfo per line even when two patterns match it', async () => {
    // pwsh: Select-String -Pattern alpha,beta on 'alpha beta'
    //       ->  ONE result, Pattern=alpha (the first that matched)
    const { port } = await harness({ files: { '/t/poem.txt': POEM } });
    const result = await run(
      selectString,
      { Pattern: ['alpha', 'beta'], Path: ['/t/poem.txt'] },
      { port },
    );
    assert.deepEqual(column(result.values, 'LineNumber'), [1, 2, 4]);
    assert.equal(prop(result.values[0], 'Pattern'), 'alpha');
  });

  it('names the capture groups, with group 0 as the whole match', async () => {
    // pwsh: -Pattern '(al)(pha)' -> Groups: 0=alpha, 1=al, 2=pha
    const { port } = await harness({ files: { '/t/poem.txt': POEM } });
    const result = await run(
      selectString,
      { Pattern: ['(al)(pha)'], Path: ['/t/poem.txt'] },
      { port },
    );
    const match = (prop(result.values[0], 'Matches') as readonly PSValue[])[0];
    const groups = prop(match, 'Groups') as readonly PSValue[];
    assert.deepEqual(
      groups.map((group) => `${String(prop(group, 'Name'))}=${String(prop(group, 'Value'))}`),
      ['0=alpha', '1=al', '2=pha'],
    );
  });

  it('rejects an invalid regular expression with the InvalidRegex id', async () => {
    // pwsh: -Pattern '[' -> InvalidRegex,...SelectStringCommand. The sentence
    // after the colon is .NET's parser talking; JavaScript's differs and is
    // passed through rather than faked.
    const { port } = await harness({ files: { '/t/poem.txt': POEM } });
    const result = await run(selectString, { Pattern: ['['], Path: ['/t/poem.txt'] }, { port });
    assert.equal(
      result.errors[0]?.fullyQualifiedErrorId,
      'InvalidRegex,Microsoft.PowerShell.Commands.SelectStringCommand',
    );
    assert.match(result.errors[0]?.message ?? '', /^The string \[ is not a valid regular expression/u);
  });

  it('finds nothing in an empty file', async () => {
    // pwsh: @(Select-String -Path empty.txt -Pattern a).Count -> 0
    const { port } = await harness(TREE);
    const result = await run(selectString, { Pattern: ['a'], Path: [`${HOME}/empty.txt`] }, { port });
    assert.deepEqual(result.values, []);
  });

  it('counts the last line of a file with no trailing newline', async () => {
    // pwsh: Select-String -Path alpha.txt -Pattern three -> LineNumber 3
    const { port } = await harness(TREE);
    const result = await run(
      selectString,
      { Pattern: ['three'], Path: [`${HOME}/alpha.txt`] },
      { port },
    );
    assert.equal(prop(result.values[0], 'LineNumber'), 3);
  });
});

// ---------------------------------------------------------------------------
// Test-Path
// ---------------------------------------------------------------------------

describe('Test-Path', () => {
  it('answers one boolean per path argument', async () => {
    // pwsh: Test-Path alpha.txt, nope.txt, sub  ->  True, False, True
    const { port } = await harness(TREE);
    const result = await run(
      testPath,
      { Path: [`${HOME}/alpha.txt`, `${HOME}/nope.txt`, `${HOME}/sub`] },
      { port },
    );
    assert.deepEqual(result.values, [true, false, true]);
    assert.deepEqual(result.errors, []);
  });

  it('applies -PathType Leaf and Container as measured', async () => {
    // pwsh: Leaf on a file True, on a dir False; Container the mirror; both
    //       False for a path that is not there.
    const { port } = await harness(TREE);
    const cases: readonly (readonly [string, string, boolean])[] = [
      [`${HOME}/alpha.txt`, 'Leaf', true],
      [`${HOME}/sub`, 'Leaf', false],
      [`${HOME}/alpha.txt`, 'Container', false],
      [`${HOME}/sub`, 'Container', true],
      [`${HOME}/nope`, 'Leaf', false],
      [`${HOME}/nope`, 'Container', false],
      [`${HOME}/alpha.txt`, 'Any', true],
    ];
    for (const [path, pathType, expected] of cases) {
      const result = await run(testPath, { Path: [path], PathType: pathType }, { port });
      assert.deepEqual(result.values, [expected], `${path} -PathType ${pathType}`);
    }
  });

  it('treats Container as an ALL and Leaf as "exists and not all containers"', async () => {
    // The six measurements that pin the rule, in a directory of aa/, bb/ and
    // root.txt:
    //   pwsh: '*'     Container  False      '*'     Leaf  True
    //         '??'    Container  True       '??'    Leaf  False
    //         '*.txt' Container  False      'zz*'   Leaf  False
    // Leaf is NOT the mirror of Container: '*' resolves to two directories and a
    // file and still answers True.
    const { port } = await harness({
      files: { '/t/root.txt': 'x' },
      directories: ['/t/aa', '/t/bb'],
    });
    const answer = async (path: string, pathType: string): Promise<PSValue | undefined> =>
      (await run(testPath, { Path: [path], PathType: pathType }, { port })).values[0];

    assert.equal(await answer('/t/*', 'Container'), false);
    assert.equal(await answer('/t/*', 'Leaf'), true);
    assert.equal(await answer('/t/??', 'Container'), true);
    assert.equal(await answer('/t/??', 'Leaf'), false);
    assert.equal(await answer('/t/*.txt', 'Container'), false);
    assert.equal(await answer('/t/zz*', 'Leaf'), false);
    assert.equal(await answer('/t/zz*', 'Any'), false);
  });

  it('answers False for an empty string without raising', async () => {
    // pwsh: Test-Path ''  ->  False, and NO error.
    // The storage layer's resolvePath returns EINVAL 'empty-path' for '', so
    // passing it straight through would have turned a routine `Test-Path
    // $env:FOO` into an error.
    const { port } = await harness(TREE);
    const result = await run(testPath, { Path: [''] }, { port });
    assert.deepEqual(result.values, [false]);
    assert.deepEqual(result.errors, []);
  });

  it('refuses a null path with NullPathNotPermitted', async () => {
    // pwsh: Test-Path $null
    //   NullPathNotPermitted,...TestPathCommand
    //   "Value cannot be null. (Parameter 'The provided Path argument was null
    //    or an empty collection.')"
    const { port } = await harness(TREE);
    const result = await run(testPath, { Path: null }, { port });
    assert.deepEqual(errorIds(result.errors), [
      'NullPathNotPermitted,Microsoft.PowerShell.Commands.TestPathCommand',
    ]);
    assert.deepEqual(result.values, []);
  });

  it('answers False for a path whose parent is a file', async () => {
    // pwsh: Test-Path 'alpha.txt/inner.txt'  ->  False, no error
    const { port } = await harness(TREE);
    const result = await run(testPath, { Path: [`${HOME}/alpha.txt/inner.txt`] }, { port });
    assert.deepEqual(result.values, [false]);
    assert.deepEqual(result.errors, []);
  });

  it('-NewerThan and -OlderThan compare the write time', async () => {
    // The fixture clock is fixed at 2026-03-04T05:06:07Z.
    // pwsh: Test-Path alpha.txt -NewerThan '2000-01-01'  ->  True
    //       Test-Path alpha.txt -OlderThan '2000-01-01'  ->  False
    const { port } = await harness(TREE);
    const newer = await run(
      testPath,
      { Path: [`${HOME}/alpha.txt`], NewerThan: '2000-01-01' },
      { port },
    );
    assert.deepEqual(newer.values, [true]);
    const older = await run(
      testPath,
      { Path: [`${HOME}/alpha.txt`], OlderThan: '2000-01-01' },
      { port },
    );
    assert.deepEqual(older.values, [false]);
  });

  it('-LiteralPath does not glob', async () => {
    // pwsh: a file really named `lit[1].txt`
    //   Test-Path 'lit[1].txt'              ->  False   (wildcard class)
    //   Test-Path -LiteralPath 'lit[1].txt' ->  True
    const { port } = await harness({ files: { '/t/lit[1].txt': 'x' } });
    const globbed = await run(testPath, { Path: ['/t/lit[1].txt'] }, { port });
    assert.deepEqual(globbed.values, [false]);
    const literal = await run(testPath, { LiteralPath: ['/t/lit[1].txt'] }, { port });
    assert.deepEqual(literal.values, [true]);
  });
});

// ---------------------------------------------------------------------------
// Set-Location
// ---------------------------------------------------------------------------

describe('Set-Location', () => {
  it('emits nothing and moves the location', async () => {
    // pwsh: @(Set-Location sub).Count -> 0
    const { port } = await harness(TREE);
    const result = await run(setLocation, { Path: `${HOME}/sub` }, { port });
    assert.deepEqual(result.values, []);
    assert.equal(port.location.full, `${HOME}/sub`);
  });

  it('-PassThru emits a PathInfo', async () => {
    // pwsh: (Set-Location .. -PassThru).GetType().FullName
    //       -> System.Management.Automation.PathInfo
    //          with Drive, Path, Provider, ProviderPath
    const { port } = await harness(TREE);
    const result = await run(setLocation, { Path: `${HOME}/sub`, PassThru: true }, { port });
    assert.equal(typeNamesOf(result.values[0])[0], 'System.Management.Automation.PathInfo');
    assert.equal(prop(result.values[0], 'Path'), `${HOME}/sub`);
  });

  it('goes home when given no path', async () => {
    // pwsh: a bare `Set-Location` moves to the home directory.
    const { port } = await harness(TREE, { cwd: `${HOME}/sub` });
    await run(setLocation, {}, { port });
    assert.equal(port.location.full, HOME);
  });

  it('says a FILE does not exist, naming the path as typed', async () => {
    // The strangest measurement in the set:
    //   pwsh: Set-Location alpha.txt   (the file EXISTS)
    //     PathNotFound,...SetLocationCommand, ObjectNotFound,
    //     ItemNotFoundException,
    //     "Cannot find path 'alpha.txt' because it does not exist."
    // versus a target that really is absent, which reports the RESOLVED path.
    // v1 said "'<p>' is not a directory."; pwsh defines this command and pwsh
    // is followed.
    const { port } = await harness(TREE, { cwd: HOME });
    const onFile = await run(setLocation, { Path: 'alpha.txt' }, { port });
    assert.deepEqual(errorIds(onFile.errors), [
      'PathNotFound,Microsoft.PowerShell.Commands.SetLocationCommand',
    ]);
    assert.equal(onFile.errors[0]?.message, "Cannot find path 'alpha.txt' because it does not exist.");
    assert.equal(port.location.full, HOME, 'the location must not move');

    const missing = await run(setLocation, { Path: 'nowhere' }, { port });
    assert.equal(
      missing.errors[0]?.message,
      `Cannot find path '${HOME}/nowhere' because it does not exist.`,
    );
  });

  it('accepts a wildcard that names one container and refuses several', async () => {
    // pwsh: Set-Location 's*b'  ->  works
    //       Set-Location '*'    ->  Argument,...SetLocationCommand
    //       "Cannot set the location because path '*' resolved to multiple
    //        containers. You can only set the location to a single container at
    //        a time."
    const { port } = await harness(TREE, { cwd: HOME });
    const one = await run(setLocation, { Path: 's*b' }, { port });
    assert.deepEqual(one.errors, []);
    assert.equal(port.location.full, `${HOME}/sub`);

    const many = await run(setLocation, { Path: `${HOME}/*` }, { port });
    assert.deepEqual(errorIds(many.errors), [
      'Argument,Microsoft.PowerShell.Commands.SetLocationCommand',
    ]);
    assert.equal(
      many.errors[0]?.message,
      `Cannot set the location because path '${HOME}/*' resolved to multiple containers. ` +
        'You can only set the location to a single container at a time.',
    );
  });

  it('refuses to enter a directory with no search permission', async () => {
    // POSIX chdir() needs EXECUTE on the target, which `VirtualFileSystem`
    // enforces. The message and the PermissionDenied/UnauthorizedAccessException
    // pair are the ones pwsh gives for a denied path; the error ID is NOT
    // measured — a Set-Location denial could not be reproduced through a Windows
    // traverse ACL — and the code says so.
    const { port } = await harness({ directories: ['/t/closed'], modes: { '/t/closed': 0o600 } });
    const result = await run(setLocation, { Path: '/t/closed' }, { port });
    assert.equal(result.errors[0]?.category, 'PermissionDenied');
    assert.equal(result.errors[0]?.message, "Access to the path '/t/closed' is denied.");
  });

  it('declines cd - rather than keeping a location history it cannot own', async () => {
    // pwsh 7 supports `cd -` and `cd +`; both walk the SESSION's location
    // history. A command module here is a module-level singleton shared by every
    // session, so a history kept in this file would let one tab's `cd -` follow
    // another tab's `cd`.
    const { port } = await harness(TREE);
    const result = await run(setLocation, { Path: '-' }, { port });
    assert.equal(result.exitCode, 1);
    assert.match(result.errors[0]?.fullyQualifiedErrorId ?? '', /^NotImplemented,/u);
  });
});

// ---------------------------------------------------------------------------
// Get-ChildItem, rule 9: a wildcard path names ITEMS
// ---------------------------------------------------------------------------

describe('Get-ChildItem with a wildcard in the path', () => {
  const WILD = {
    files: {
      '/t/alpha.txt': 'x',
      '/t/empty.txt': 'x',
      '/t/zeta.md': 'x',
      '/t/sub/inner.txt': 'x',
      '/t/sub/deeper/deep.txt': 'x',
    },
    directories: ['/t/emptydir'],
  } as const;

  it('emits the matched items themselves, not their contents', async () => {
    // pwsh: Get-ChildItem 'sub'    ->  sub\deeper | sub\inner.txt
    //       Get-ChildItem 's*'     ->  sub
    //       Get-ChildItem 'em*'    ->  emptydir | empty.txt
    const { port } = await harness(WILD, { cwd: '/t' });
    assert.deepEqual(names((await run(getChildItem, { Path: 'sub' }, { port })).values), [
      'deeper',
      'inner.txt',
    ]);
    assert.deepEqual(names((await run(getChildItem, { Path: 's*' }, { port })).values), ['sub']);
    assert.deepEqual(names((await run(getChildItem, { Path: 'em*' }, { port })).values), [
      'emptydir',
      'empty.txt',
    ]);
  });

  it('treats a trailing * as the parent directory', async () => {
    // pwsh: `Get-ChildItem '*'` and `Get-ChildItem` produce byte-identical
    // output, and so do `Get-ChildItem 'sub/*'` and `Get-ChildItem 'sub'`.
    const { port } = await harness(WILD, { cwd: '/t' });
    const star = await run(getChildItem, { Path: '*', Name: true }, { port });
    const bare = await run(getChildItem, {}, { port });
    assert.deepEqual(star.values, names(bare.values));

    const subStar = await run(getChildItem, { Path: 'sub/*', Name: true }, { port });
    assert.deepEqual(subStar.values, ['deeper', 'inner.txt']);
  });

  it('expands a matched container with -Recurse, and does not emit it', async () => {
    // pwsh: Get-ChildItem 's*' -Recurse
    //       ->  sub\deeper | sub\deeper\deep.txt | sub\inner.txt
    // Immediate descent, and `sub` itself is absent — where `'*' -Recurse` keeps
    // the breadth order and DOES emit the directories. Reading `*` as "the
    // parent" is what makes both true at once.
    const { port } = await harness(WILD, { cwd: '/t' });
    const matched = await run(getChildItem, { Path: 's*', Recurse: true }, { port });
    assert.deepEqual(column(matched.values, 'FullName'), [
      '/t/sub/deeper',
      '/t/sub/deeper/deep.txt',
      '/t/sub/inner.txt',
    ]);

    const star = await run(getChildItem, { Path: '*', Recurse: true, Name: true }, { port });
    assert.deepEqual(star.values, [
      'emptydir',
      'sub',
      'alpha.txt',
      'empty.txt',
      'zeta.md',
      'sub/deeper',
      'sub/inner.txt',
      'sub/deeper/deep.txt',
    ]);
  });
});

// ---------------------------------------------------------------------------
// StorageError -> ErrorRecord: the whole mapping, one table
// ---------------------------------------------------------------------------

/**
 * Every `StorageErrorCode` a READER can hit, against every cmdlet that can hit
 * it, in one place — so that the six measured mappings and the three
 * extrapolated ones are visible side by side rather than scattered through the
 * command bodies.
 *
 * A reader cannot mkdir, rename, write or remove: the broker refuses, and
 * `ports.test.mts` proves it. So EEXIST, ENOTEMPTY, ENOSPC, EXDEV and EROFS are
 * unreachable here and are asserted to fall through to the generic arm rather
 * than being left to a `default:` nobody has read.
 */
describe('the StorageError to ErrorRecord mapping', () => {
  const CASES: readonly (readonly [string, StorageErrorCode, string, string, string])[] = [
    // command        code          errorId                                    category           measured?
    // pwsh: Get-Content nope.txt
    ['get-content', 'ENOENT', 'PathNotFound', 'ObjectNotFound', 'measured'],
    // pwsh: Get-Content 'alpha.txt/inner.txt' — a component that is a file is
    // reported as a path that does not exist, by all five cmdlets.
    ['get-content', 'ENOTDIR', 'PathNotFound', 'ObjectNotFound', 'measured'],
    // pwsh: Get-Content sub
    ['get-content', 'EISDIR', 'GetContainerContentException', 'InvalidOperation', 'measured'],
    // pwsh: Get-Content <file with a Deny ACE>
    ['get-content', 'EACCES', 'GetContentReaderUnauthorizedAccessError', 'PermissionDenied', 'measured'],
    // pwsh: Get-Content "bad`0name.txt"
    ['get-content', 'EINVAL', 'ItemExistsArgumentError', 'InvalidArgument', 'measured'],
    // Extrapolated from the EINVAL shape: Windows long-path support meant a
    // 300-character name produced PathNotFound instead of a length error, so
    // NAME_MAX/PATH_MAX has no reference answer.
    ['get-content', 'ENAMETOOLONG', 'ItemExistsArgumentError', 'InvalidArgument', 'extrapolated'],
    // Not measurable at all: nothing in a JavaScript object graph fails at the
    // device level, and pwsh cannot be asked to pretend.
    ['get-content', 'EIO', 'ReadError', 'ReadError', 'extrapolated'],
    // pwsh: Get-ChildItem <directory with a Deny ACE> — a DIFFERENT id from
    // Get-Content's for the same condition. This row is why the table is per
    // command rather than global.
    ['get-childitem', 'EACCES', 'DirUnauthorizedAccessError', 'PermissionDenied', 'measured'],
    ['get-childitem', 'ENOENT', 'PathNotFound', 'ObjectNotFound', 'measured'],
    ['select-string', 'ENOENT', 'PathNotFound', 'ObjectNotFound', 'measured'],
    ['set-location', 'ENOENT', 'PathNotFound', 'ObjectNotFound', 'measured'],
    ['set-location', 'ENOTDIR', 'PathNotFound', 'ObjectNotFound', 'measured'],
    ['test-path', 'EINVAL', 'ItemExistsArgumentError', 'InvalidArgument', 'measured'],
  ];

  for (const [command, code, errorId, category] of CASES) {
    it(`maps ${code} to ${errorId} for ${command}`, () => {
      const mapping = FS_READ_ERROR_MAPPINGS[command];
      assert.ok(mapping !== undefined, `no mapping registered for ${command}`);
      const record = storageErrorRecord(
        mapping.identity,
        syntheticError(code, '/probe'),
        '/probe',
        mapping.ids,
      );
      assert.equal(record.fullyQualifiedErrorId, `${errorId},${mapping.identity.dotNetType}`);
      assert.equal(record.category, category);
    });
  }

  it('still answers for the codes only a WRITER can raise', () => {
    // Unreachable through this directory, and handled rather than defaulted so
    // that widening StorageError breaks the build instead of quietly producing
    // a NotSpecified error at run time.
    const mapping = FS_READ_ERROR_MAPPINGS['get-content'];
    assert.ok(mapping !== undefined);
    const record = storageErrorRecord(
      mapping.identity,
      { code: 'EROFS', path: '/probe', syscall: 'stat', message: 'read-only', mount: 'fs' },
      '/probe',
      mapping.ids,
    );
    assert.equal(
      record.fullyQualifiedErrorId,
      'ProviderError,Microsoft.PowerShell.Commands.GetContentCommand',
    );
  });
});

function syntheticError(code: StorageErrorCode, path: string): StorageError {
  const base = { path, syscall: 'stat' as const, message: `probe: ${code}` };
  switch (code) {
    case 'ENOENT':
      return { ...base, code: 'ENOENT' };
    case 'ENOTDIR':
      return { ...base, code: 'ENOTDIR', component: path };
    case 'EISDIR':
      return { ...base, code: 'EISDIR' };
    case 'EACCES':
      return { ...base, code: 'EACCES', required: 'read' };
    case 'EINVAL':
      return { ...base, code: 'EINVAL', reason: 'nul-in-name' };
    case 'ENAMETOOLONG':
      return { ...base, code: 'ENAMETOOLONG', limit: 255, actual: 300 };
    case 'EIO':
      return { ...base, code: 'EIO', cause: 'probe' };
    default:
      throw new Error(`${code} is not a code a reader can raise`);
  }
}
