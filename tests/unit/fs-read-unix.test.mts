/**
 * The five coreutils programs — `ls`, `cat`, `grep`, `tree`, `which`.
 *
 * THESE ARE NOT MEASURED AGAINST pwsh, AND THAT IS THE POINT. PowerShell on
 * Linux and macOS deliberately leaves `ls`, `cat`, `cp`, `mv`, `rm`, `man`,
 * `mount` and `ps` undefined so that the native executables run;
 * `src/commands/manifests.json` records each of these as its own command with no
 * aliases, next to the cmdlets they superficially resemble. So the specification
 * here is the archived v1 terminal — `legacy/terminal-v1.html` — and every
 * expectation below quotes the v1 source line it comes from.
 *
 * The one place the two families were compared IS measured, because it is the
 * difference users trip over:
 *
 *   pwsh: Select-String -Pattern 'gamma'  matches the line 'Gamma alpha'
 *   v1:   grep builds `new RegExp(pat, ci?'i':'')` — case SENSITIVE by default
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cat, grep, ls, tree, which } from '../../src/commands/fs-read/index.ts';
import { HOME, errorIds, harness, run } from './fs-read-harness.mts';

const TREE = {
  files: {
    [`${HOME}/alpha.txt`]: 'one\ntwo\nthree\n',
    [`${HOME}/notrail.txt`]: 'solo',
    [`${HOME}/empty.txt`]: '',
    [`${HOME}/.hidden`]: 'hidden\n',
    [`${HOME}/sub/inner.txt`]: 'inner one\ninner two\n',
    [`${HOME}/sub/deeper/deep.txt`]: 'deep\n',
  },
  directories: [`${HOME}/emptydir`],
} as const;

describe('ls', () => {
  it('joins names with two spaces on one line', async () => {
    // v1: `return one ? names.map(...) : [line('', names.join('  '))]`
    // and the ordering is v1's plain `Object.keys(n.ch).sort()` — ORDINAL,
    // where Get-ChildItem's is the culture-aware collation.
    const { port } = await harness(TREE);
    const result = await run(ls, {}, { port });
    assert.deepEqual(result.values, ['alpha.txt  empty.txt  emptydir  notrail.txt  sub']);
  });

  it('sorts ordinally, where Get-ChildItem collates', async () => {
    // v1's `.sort()` puts every upper-case name before every lower-case one.
    // Get-ChildItem, measured against pwsh, gives `a.txt | B.txt`; this gives
    // the opposite, and the divergence is real rather than a bug.
    const { port } = await harness({ files: { [`${HOME}/a.txt`]: 'x', [`${HOME}/B.txt`]: 'x' } });
    const result = await run(ls, {}, { port });
    assert.deepEqual(result.values, ['B.txt  a.txt']);
  });

  it('-1 puts one name per line', async () => {
    const { port } = await harness({ files: { [`${HOME}/b`]: 'x', [`${HOME}/a`]: 'x' } });
    const result = await run(ls, {}, { port, remaining: ['-1'] });
    assert.deepEqual(result.values, ['a', 'b']);
  });

  it('hides dot-files, and -a adds . and .. while -A does not', async () => {
    // v1: `if(!all) names = names.filter(k => k.charAt(0) !== '.');`
    //     `else if(!almostAll) names = ['.','..'].concat(names);`
    const { port } = await harness(TREE);
    const plain = await run(ls, {}, { port });
    assert.equal(String(plain.values[0]).includes('.hidden'), false);

    const all = await run(ls, {}, { port, remaining: ['-a'] });
    assert.equal(String(all.values[0]).startsWith('.  ..  .hidden'), true);

    const almost = await run(ls, {}, { port, remaining: ['-A'] });
    assert.equal(String(almost.values[0]).startsWith('.hidden'), true);
    assert.equal(String(almost.values[0]).includes('.  ..'), false);
  });

  it('-l prints total and one padded row per entry', async () => {
    // v1: `[line('','total '+blocks)].concat(rows.map(...))` with
    // `blocks = sum(ceil(size/1024))`, and the row is
    // `mode nlink owner group size time name`.
    // The timestamp is rendered in UTC here where v1 used the host's local
    // time; a listing that changes when the laptop crosses a border is not
    // something a differential test can hold still.
    const { port } = await harness({ files: { [`${HOME}/alpha.txt`]: 'one\ntwo\nthree\n' } });
    const result = await run(ls, {}, { port, remaining: ['-l'] });
    assert.equal(result.values[0], 'total 1');
    // The fixture clock is 2026-03-04T05:06:07Z.
    assert.equal(result.values[1], '-rw-r--r-- 1 thc1006 thc1006 14 Mar  4 05:06 alpha.txt');
  });

  it('-l on a FILE prints that file’s long row, not just its name', async () => {
    // v1's own comment: "ls -l <file> 要給該檔的長格式,不是只印檔名".
    const { port } = await harness(TREE);
    const long = await run(ls, {}, { port, remaining: ['-l', `${HOME}/notrail.txt`] });
    assert.equal(long.values.length, 1);
    assert.match(String(long.values[0]), /^-rw-r--r-- 1 thc1006 thc1006 4 .* notrail\.txt$/u);

    const short = await run(ls, {}, { port, remaining: [`${HOME}/notrail.txt`] });
    assert.deepEqual(short.values, ['notrail.txt']);
  });

  it('-h abbreviates the size', async () => {
    // v1: `if(s>=1024) return (s/1024).toFixed(1)+'K';`
    const { port } = await harness({ files: { [`${HOME}/big.txt`]: 'x'.repeat(2048) } });
    const result = await run(ls, {}, { port, remaining: ['-lh', `${HOME}/big.txt`] });
    assert.match(String(result.values[0]), / 2\.0K /u);
  });

  it('reports a missing path in coreutils wording and exits 2', async () => {
    // v1: `ls: cannot access '<t>': No such file or directory`
    const { port } = await harness(TREE);
    const result = await run(ls, {}, { port, remaining: [`${HOME}/nope`] });
    assert.equal(result.exitCode, 2);
    assert.equal(result.errors[0]?.message, `ls: cannot access '${HOME}/nope': No such file or directory`);
    assert.deepEqual(result.values, []);
  });

  it('emits nothing for an empty directory', async () => {
    // v1: `if(!names.length) return [];`
    const { port } = await harness(TREE);
    const result = await run(ls, {}, { port, remaining: [`${HOME}/emptydir`] });
    assert.deepEqual(result.values, []);
    assert.equal(result.exitCode, 0);
  });

  it('explains itself when the host has no filesystem', async () => {
    const result = await run(ls, {}, { port: null });
    assert.equal(result.exitCode, 2);
    assert.equal(result.errors[0]?.fullyQualifiedErrorId, 'FileSystemUnavailable,ls');
  });
});

describe('cat', () => {
  it('concatenates several files in order', async () => {
    const { port } = await harness(TREE);
    const result = await run(cat, {}, {
      port,
      remaining: [`${HOME}/notrail.txt`, `${HOME}/alpha.txt`],
    });
    assert.deepEqual(result.values, ['solo', 'one', 'two', 'three']);
  });

  it('reports a missing file and KEEPS GOING', async () => {
    // v1's comment: "cat 會串接所有指定的檔案;讀不到的檔印錯誤後繼續下一個".
    // A cat that stopped at the first bad name would lose the second file.
    const { port } = await harness(TREE);
    const result = await run(cat, {}, {
      port,
      remaining: [`${HOME}/nope.txt`, `${HOME}/notrail.txt`],
    });
    assert.deepEqual(result.values, ['solo']);
    assert.equal(result.errors[0]?.message, `cat: ${HOME}/nope.txt: No such file or directory`);
    assert.equal(result.exitCode, 1);
  });

  it('reports a directory with the coreutils sentence', async () => {
    // v1: `cat: <t>: Is a directory`
    const { port } = await harness(TREE);
    const result = await run(cat, {}, { port, remaining: [`${HOME}/sub`] });
    assert.equal(result.errors[0]?.message, `cat: ${HOME}/sub: Is a directory`);
  });

  it('emits nothing for an empty file', async () => {
    const { port } = await harness(TREE);
    const result = await run(cat, {}, { port, remaining: [`${HOME}/empty.txt`] });
    assert.deepEqual(result.values, []);
    assert.equal(result.exitCode, 0);
  });

  it('prints usage with no operands', async () => {
    // v1: `if(!files.length) return [line('muted','Usage: cat [FILE]...')]`
    const { port } = await harness(TREE);
    const result = await run(cat, {}, { port, remaining: [] });
    assert.deepEqual(result.values, ['Usage: cat [FILE]...']);
    assert.equal(result.exitCode, 1);
  });

  it('reports an unreadable file as Permission denied', async () => {
    const { port } = await harness({
      files: { '/t/locked.txt': 'secret\n' },
      modes: { '/t/locked.txt': 0o000 },
    });
    const result = await run(cat, {}, { port, remaining: ['/t/locked.txt'] });
    assert.equal(result.errors[0]?.message, 'cat: /t/locked.txt: Permission denied');
    assert.equal(result.errors[0]?.category, 'PermissionDenied');
  });
});

describe('grep', () => {
  const POEM = { files: { [`${HOME}/poem.txt`]: 'alpha beta\nGamma alpha\ndelta\n' } };

  it('is case SENSITIVE by default, and -i opts out', async () => {
    // v1: `re = new RegExp(pat, ci ? 'i' : '')`, with
    //     `ci = x === '--ignore-case' || /^-[A-Za-z]*i/.test(x)`.
    // Select-String, measured against pwsh, is the other way round. That is the
    // whole reason these are two commands and not one alias.
    const { port } = await harness(POEM);
    const strict = await run(grep, {}, { port, remaining: ['gamma', `${HOME}/poem.txt`] });
    assert.deepEqual(strict.values, []);
    assert.equal(strict.exitCode, 1, 'GNU grep exits 1 when nothing matched');

    const loose = await run(grep, {}, { port, remaining: ['-i', 'gamma', `${HOME}/poem.txt`] });
    assert.deepEqual(loose.values, ['Gamma alpha']);
    assert.equal(loose.exitCode, 0);
  });

  it('walks the whole tree when given no file, printing path: line', async () => {
    // v1: `(function walk(node,path){ ... })(ROOT,'')` — the search starts at the
    // ROOT, not the working directory, and prints `path + ': ' + line`.
    const { port } = await harness({
      files: { '/a/one.txt': 'needle here\n', '/b/two.txt': 'nothing\n' },
    });
    const result = await run(grep, {}, { port, remaining: ['needle'] });
    assert.deepEqual(result.values, ['/a/one.txt: needle here']);
  });

  it('truncates a long line at 56 characters in the whole-tree form', async () => {
    // v1: `t.length > 56 ? t.slice(0,56)+'...' : t`
    const long = `${'x'.repeat(60)}needle`;
    const { port } = await harness({ files: { '/a/long.txt': `${long}\n` } });
    const result = await run(grep, {}, { port, remaining: ['needle'] });
    assert.equal(result.values[0], `/a/long.txt: ${'x'.repeat(56)}...`);
  });

  it('stops after twenty hits', async () => {
    // v1: `hits.slice(0,20)`
    const files: Record<string, string> = {};
    for (let index = 0; index < 40; index += 1) files[`/a/f${String(index)}.txt`] = 'needle\n';
    const { port } = await harness({ files });
    const result = await run(grep, {}, { port, remaining: ['needle'] });
    assert.equal(result.values.length, 20);
  });

  it('does NOT truncate when a file was named', async () => {
    // v1's file branch pushes `line('', t)` with no slice.
    const long = `${'x'.repeat(80)}needle`;
    const { port } = await harness({ files: { '/a/long.txt': `${long}\n` } });
    const result = await run(grep, {}, { port, remaining: ['needle', '/a/long.txt'] });
    assert.deepEqual(result.values, [long]);
  });

  it('reports a missing file and a directory, and exits 2', async () => {
    // v1: `grep: <f>: No such file or directory` and `grep: <f>: Is a directory`
    const { port } = await harness(TREE);
    const missing = await run(grep, {}, { port, remaining: ['a', `${HOME}/nope.txt`] });
    assert.equal(missing.errors[0]?.message, `grep: ${HOME}/nope.txt: No such file or directory`);
    assert.equal(missing.exitCode, 2);

    const directory = await run(grep, {}, { port, remaining: ['a', `${HOME}/sub`] });
    assert.equal(directory.errors[0]?.message, `grep: ${HOME}/sub: Is a directory`);
    assert.equal(directory.exitCode, 2);
  });

  it('prints usage with no pattern and refuses a 201-character one', async () => {
    // v1: the two usage lines, and `if(pat.length>200) ... 'grep: pattern too long'`
    const { port } = await harness(TREE);
    const usage = await run(grep, {}, { port, remaining: [] });
    assert.deepEqual(usage.values, [
      'Usage: grep [OPTION]... PATTERNS [FILE]...',
      "Try 'grep --help' for more information.",
    ]);
    assert.equal(usage.exitCode, 2);

    const long = await run(grep, {}, { port, remaining: ['a'.repeat(201)] });
    assert.equal(long.errors[0]?.message, 'grep: pattern too long');
    assert.equal(long.exitCode, 2);
  });

  it('refuses an invalid regular expression', async () => {
    // v1: `catch(e){ return [line('err','grep: invalid regular expression')] }`
    const { port } = await harness(TREE);
    const result = await run(grep, {}, { port, remaining: ['[', `${HOME}/alpha.txt`] });
    assert.equal(result.errors[0]?.message, 'grep: invalid regular expression');
    assert.equal(result.exitCode, 2);
  });

  it('skips a directory it may not read rather than failing the walk', async () => {
    const { port } = await harness({
      files: { '/a/open.txt': 'needle\n', '/locked/hidden.txt': 'needle\n' },
      modes: { '/locked': 0o000 },
    });
    const result = await run(grep, {}, { port, remaining: ['needle'] });
    assert.deepEqual(result.values, ['/a/open.txt: needle']);
    assert.deepEqual(result.errors, []);
  });

  it('stops the whole-tree walk when the signal aborts', async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 200; index += 1) files[`/a/d${String(index)}/f.txt`] = 'needle\n';
    const { port } = await harness({ files });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => run(grep, {}, { port, remaining: ['needle'], signal: controller.signal }),
      /cancelled|Cancelled/u,
    );
  });
});

describe('tree', () => {
  it('prints the directory, then the connectors v1 draws', async () => {
    // v1: `line('', CWD)` then `prefix + (last ? '└── ' : '├── ') + k`, with
    // directories first and each group ordered by lower-cased name.
    const { port } = await harness(TREE);
    const result = await run(tree, {}, { port });
    assert.deepEqual(result.values, [
      HOME,
      '├── emptydir',
      '├── sub',
      '│   ├── deeper',
      '│   │   └── deep.txt',
      '│   └── inner.txt',
      '├── .hidden',
      '├── alpha.txt',
      '├── empty.txt',
      '└── notrail.txt',
    ]);
  });

  it('shows dot-files, where GNU tree hides them', async () => {
    // v1 walks `Object.keys(n.ch)` with no filtering, so `.hidden` is listed.
    const { port } = await harness({ files: { '/t/.dot': 'x' } });
    const result = await run(tree, {}, { port, remaining: ['/t'] });
    assert.deepEqual(result.values, ['/t', '└── .dot']);
  });

  it('stops after three levels', async () => {
    // v1: `if(c.t==='d' && prefix.length<8) walk(...)`, and the prefix grows by
    // four per level — so depth-3 entries are printed and their children are not.
    const { port } = await harness({ files: { '/t/a/b/c/d/deep.txt': 'x' } });
    const result = await run(tree, {}, { port, remaining: ['/t'] });
    assert.deepEqual(result.values, [
      '/t',
      '└── a',
      '    └── b',
      '        └── c',
    ]);
  });
});

describe('which', () => {
  it('prefers a real file under /usr/bin', async () => {
    // v1's comment: "以檔案系統為準,pwsh/sh/bash 才找得到" — the filesystem is
    // authoritative, which is how `pwsh` is found even though this shell does
    // not implement a command by that name.
    const { port } = await harness({ files: { '/usr/bin/pwsh': '' } });
    const result = await run(which, {}, { port, remaining: ['pwsh'] });
    assert.deepEqual(result.values, ['/usr/bin/pwsh']);
    assert.equal(result.exitCode, 0);
  });

  it('reports a cmdlet as a cmdlet', async () => {
    // v1: `return [line('', String(t) + ': PowerShell cmdlet')]`
    const { port } = await harness();
    const result = await run(which, {}, { port, remaining: ['Get-ChildItem'] });
    assert.deepEqual(result.values, ['Get-ChildItem: PowerShell cmdlet']);
  });

  it('resolves an alias to the cmdlet it names', async () => {
    const { port } = await harness();
    const result = await run(which, {}, { port, remaining: ['gci'] });
    assert.deepEqual(result.values, ['gci: PowerShell cmdlet']);
  });

  it('reports an Application as a path under /usr/bin', async () => {
    // `commandTypeOf` is imported rather than reimplemented, so the
    // Cmdlet/Application judgement is made in exactly one place.
    const { port } = await harness();
    const result = await run(which, {}, { port, remaining: ['grep'] });
    assert.deepEqual(result.values, ['/usr/bin/grep']);
  });

  it('says NOTHING when it finds nothing, and exits non-zero', async () => {
    // v1: `if(!c) return null;` — "GNU which 找不到時安靜回非零".
    const { port } = await harness();
    const result = await run(which, {}, { port, remaining: ['no-such-command-xyz'] });
    assert.deepEqual(result.values, []);
    assert.deepEqual(result.errors, []);
    assert.equal(result.exitCode, 1);
  });

  it('prints usage with no operand', async () => {
    const { port } = await harness();
    const result = await run(which, {}, { port, remaining: [] });
    assert.deepEqual(result.values, ['Usage: which <command>']);
    assert.equal(result.exitCode, 1);
  });

  it('explains itself when the host has no filesystem', async () => {
    const result = await run(which, {}, { port: null, remaining: ['pwsh'] });
    assert.deepEqual(errorIds(result.errors), ['FileSystemUnavailable,which']);
  });
});
