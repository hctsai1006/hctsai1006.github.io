/**
 * Tests for the roadmap evidence gate.
 *
 * The gate exists because `roadmap/roadmap.data.mts` was consulted to answer
 * "is everything built?", answered "34 of 104", and was wrong: a dozen tasks
 * marked `todo` had shipped months earlier. Nothing checked, because everything
 * the roadmap validated was about its own internal shape.
 *
 * So the interesting tests here are the REFUSALS. A gate that only proves the
 * current data passes is the check-that-never-ran waiting to happen: it would
 * stay green after any change that quietly stopped it evaluating anything. Each
 * case below is a way to claim `done` without having done it, and each one has
 * to come back red.
 *
 * The last group is the ratchet, which is the only mechanism here that fails in
 * the direction the roadmap actually failed — a `todo` whose absence check
 * starts matching means somebody built the thing and did not say so.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkEvidence,
  declaredTests,
  exportedSymbols,
  fsRepo,
  parseTap,
  stripComments,
} from '../../tools/roadmap-evidence.mts';
import type { Repo, TestRunner } from '../../tools/roadmap-evidence.mts';
import { WORK } from '../../roadmap/roadmap.data.mts';
import type { Evidence, Status, Task, WorkItem } from '../../roadmap/roadmap.data.mts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

/**
 * A miniature glob for the in-memory repo: `**` matches any number of
 * directories, `*` matches any run inside one segment, everything else is
 * literal. Written without a regex on purpose — the escaping is where a
 * hand-rolled matcher goes wrong, and a glob that silently matched nothing
 * would make every test below agree with a checker that had stopped looking.
 */
/** One path segment, where `*` stands for any run of characters inside it. */
function segmentMatches(pattern: string, name: string): boolean {
  const parts = pattern.split('*');
  if (parts.length === 1) return pattern === name;
  const first = parts[0] ?? '';
  const last = parts[parts.length - 1] ?? '';
  if (!name.startsWith(first) || !name.endsWith(last)) return false;
  let at = first.length;
  for (let i = 1; i < parts.length - 1; i += 1) {
    const part = parts[i] ?? '';
    const found = name.indexOf(part, at);
    if (found < 0) return false;
    at = found + part.length;
  }
  return name.length - at >= last.length;
}

function globMatches(pattern: string, path: string): boolean {
  const pat = pattern.split('/');
  const seg = path.split('/');
  const walk = (pi: number, si: number): boolean => {
    if (pi === pat.length) return si === seg.length;
    if (pat[pi] === '**') {
      for (let k = si; k <= seg.length; k += 1) if (walk(pi + 1, k)) return true;
      return false;
    }
    if (si >= seg.length) return false;
    return segmentMatches(pat[pi] ?? '', seg[si] ?? '') && walk(pi + 1, si + 1);
  };
  return walk(0, 0);
}

function fakeRepo(files: Record<string, string>): Repo {
  const names = Object.keys(files).sort();
  return {
    exists: (rel) => rel in files,
    read: (rel) => files[rel] ?? null,
    glob: (pattern) => names.filter((n) => globMatches(pattern, n)),
  };
}

/** Reports whatever it is told to. The real one spawns `node --test`. */
function fakeRunner(passed: readonly string[], notPassed: readonly string[] = []): TestRunner {
  return {
    run: () => ({ passed: new Set(passed), notPassed: new Set(notPassed), error: null }),
  };
}

/** A runner that produced nothing, which must never read as success. */
const brokenRunner: TestRunner = {
  run: () => ({ passed: new Set(), notPassed: new Set(), error: 'parsed no TAP results' }),
};

function itemWith(tasks: readonly Task[]): WorkItem {
  return {
    n: 1,
    phase: 'Core',
    slug: 'fixture',
    title: 'fixture',
    why: 'fixture',
    status: 'in-progress',
    dependsOn: [],
    tasks: [...tasks],
    acceptance: ['fixture'],
  };
}

function task(id: string, status: Status, evidence?: readonly Evidence[], detail?: string): Task {
  return {
    id,
    title: 'fixture task',
    status,
    ...(evidence === undefined ? {} : { evidence }),
    ...(detail === undefined ? {} : { detail }),
  };
}

interface RunOptions {
  files?: Record<string, string>;
  runner?: TestRunner;
}

function run(tasks: readonly Task[], options: RunOptions = {}): ReturnType<typeof checkEvidence> {
  return checkEvidence({
    repo: fakeRepo({
      'package.json': JSON.stringify({ scripts: { verify: 'node x' } }),
      'tests/unit/placeholder.test.mts': "import assert from 'node:assert';\nit('x', () => assert.ok(1));\n",
      ...options.files,
    }),
    runner: options.runner ?? fakeRunner([]),
    items: [itemWith(tasks)],
  });
}

const messages = (r: ReturnType<typeof checkEvidence>): string =>
  r.findings.map((f) => `${f.where}: ${f.message}`).join('\n');

// ---------------------------------------------------------------------------
// a claim with nothing behind it
// ---------------------------------------------------------------------------

describe('a status is a claim, and a claim needs a citation', () => {
  it('refuses a done task that names no evidence', () => {
    const r = run([task('1.1', 'done')]);
    assert.equal(r.findings.length, 1);
    assert.match(messages(r), /names no evidence/);
  });

  it('refuses a partial task that names no evidence', () => {
    const r = run([task('1.1', 'partial', undefined, 'half of it exists')]);
    assert.match(messages(r), /names no evidence/);
  });

  it('refuses a partial task that does not say what is missing', () => {
    const r = run([
      task('1.1', 'partial', [{ kind: 'script', name: 'verify' }]),
    ]);
    assert.match(messages(r), /says what is missing/);
  });

  it('refuses a done task carried only by supporting evidence', () => {
    // `script` and `code` are cheap to satisfy and cannot stand alone.
    const r = run([task('1.1', 'done', [{ kind: 'script', name: 'verify' }])], {});
    assert.match(messages(r), /needs at least one of/);
  });

  it('accepts a done task with one strong item', () => {
    const r = run([task('1.1', 'done', [{ kind: 'script', name: 'verify' }, { kind: 'json', file: 'package.json', path: 'scripts.verify' }])]);
    assert.deepEqual(r.findings, []);
    assert.deepEqual(r.fatal, []);
  });

  it('does not require evidence from a task that claims nothing', () => {
    const r = run([task('1.1', 'todo')]);
    assert.deepEqual(r.findings, []);
  });
});

// ---------------------------------------------------------------------------
// export evidence
// ---------------------------------------------------------------------------

describe('export evidence is read off the AST, not grepped', () => {
  const withSource = (src: string): RunOptions => ({ files: { 'src/x.ts': src } });
  const cite: Evidence[] = [{ kind: 'export', file: 'src/x.ts', symbol: 'Widget' }];

  it('accepts a real exported const', () => {
    const r = run([task('1.1', 'done', cite)], withSource('export const Widget = 1;\n'));
    assert.deepEqual(r.findings, []);
  });

  it('accepts an exported type alias, which has no runtime existence', () => {
    const r = run([task('1.1', 'done', cite)], withSource("export type Widget = 'a' | 'b';\n"));
    assert.deepEqual(r.findings, []);
  });

  it('refuses a symbol that appears only in a comment', () => {
    const r = run(
      [task('1.1', 'done', cite)],
      withSource('// Widget is planned for later.\nexport const other = 1;\n'),
    );
    assert.match(messages(r), /does not export "Widget"/);
  });

  it('refuses a symbol that is only imported, never exported', () => {
    const r = run(
      [task('1.1', 'done', cite)],
      withSource("import { Widget } from './y.ts';\nexport const other = Widget;\n"),
    );
    assert.match(messages(r), /does not export "Widget"/);
  });

  it('refuses a symbol declared but not exported', () => {
    const r = run([task('1.1', 'done', cite)], withSource('const Widget = 1;\nexport const o = Widget;\n'));
    assert.match(messages(r), /does not export "Widget"/);
  });

  it('refuses a file that does not exist', () => {
    const r = run([task('1.1', 'done', cite)], { files: {} });
    assert.match(messages(r), /no such file: src\/x\.ts/);
  });

  it('refuses a file that exists but is empty', () => {
    const r = run([task('1.1', 'done', cite)], withSource('   \n\n'));
    assert.match(messages(r), /exists but is empty/);
  });

  it('refuses a file that is nothing but a comment about the work', () => {
    const r = run([task('1.1', 'done', cite)], withSource('/* export const Widget = 1; one day */\n'));
    assert.match(messages(r), /no code, only comments/);
  });

  it('follows a barrel so an index file can be cited', () => {
    const r = run([task('1.1', 'done', [{ kind: 'export', file: 'src/index.ts', symbol: 'Widget' }])], {
      files: {
        'src/index.ts': "export * from './x.ts';\n",
        'src/x.ts': 'export const Widget = 1;\n',
      },
    });
    assert.deepEqual(r.findings, []);
  });

  it('says so when a re-export could not be followed, rather than passing', () => {
    const r = run([task('1.1', 'done', [{ kind: 'export', file: 'src/index.ts', symbol: 'Widget' }])], {
      files: { 'src/index.ts': "export * from './gone.ts';\n" },
    });
    assert.match(messages(r), /could not be followed/);
  });
});

// ---------------------------------------------------------------------------
// test evidence
// ---------------------------------------------------------------------------

describe('test evidence has to name a test that runs, asserts and passes', () => {
  const TEST_FILE = 'tests/unit/thing.test.mts';
  const cite: Evidence[] = [{ kind: 'test', file: TEST_FILE, name: 'does the thing' }];
  const body = (source: string): RunOptions => ({ files: { [TEST_FILE]: source } });

  it('accepts a real, asserting, passing test', () => {
    const r = run([task('1.1', 'done', cite)], {
      ...body("it('does the thing', () => { assert.equal(1, 1); });\n"),
      runner: fakeRunner(['does the thing']),
    });
    assert.deepEqual(r.findings, []);
    assert.equal(r.citedTestsRun, 1);
  });

  it('refuses a name the file does not declare', () => {
    const r = run([task('1.1', 'done', cite)], {
      ...body("it('does something else', () => { assert.ok(1); });\n"),
      runner: fakeRunner(['does the thing']),
    });
    assert.match(messages(r), /declares no test named "does the thing"/);
  });

  it('refuses a skipped test', () => {
    const r = run([task('1.1', 'done', cite)], {
      ...body("it.skip('does the thing', () => { assert.ok(1); });\n"),
      runner: fakeRunner(['does the thing']),
    });
    assert.match(messages(r), /is skipped or todo/);
  });

  it('refuses a test nested inside a skipped describe', () => {
    const r = run([task('1.1', 'done', cite)], {
      ...body("describe.skip('group', () => { it('does the thing', () => { assert.ok(1); }); });\n"),
      runner: fakeRunner(['does the thing']),
    });
    assert.match(messages(r), /is skipped or todo/);
  });

  it('refuses a test with no assertion in it', () => {
    const r = run([task('1.1', 'done', cite)], {
      ...body("it('does the thing', () => { const x = 1; return x; });\n"),
      runner: fakeRunner(['does the thing']),
    });
    assert.match(messages(r), /contains no assertion/);
  });

  it('refuses a test in a file the runner never globs', () => {
    const r = run(
      [task('1.1', 'done', [{ kind: 'test', file: 'tests/unit/helper.mts', name: 'does the thing' }])],
      {
        files: { 'tests/unit/helper.mts': "it('does the thing', () => { assert.ok(1); });\n" },
        runner: fakeRunner(['does the thing']),
      },
    );
    assert.match(messages(r), /is not matched by tests/);
  });

  it('refuses a cited test that did not pass', () => {
    const r = run([task('1.1', 'done', cite)], {
      ...body("it('does the thing', () => { assert.ok(1); });\n"),
      runner: fakeRunner([], ['does the thing']),
    });
    assert.match(messages(r), /did not pass/);
  });

  it('refuses a cited test that produced no result at all', () => {
    const r = run([task('1.1', 'done', cite)], {
      ...body("it('does the thing', () => { assert.ok(1); });\n"),
      runner: fakeRunner(['some other test']),
    });
    assert.match(messages(r), /produced no result/);
  });

  it('treats a run that yielded nothing as could-not-run, not as clean', () => {
    const r = run([task('1.1', 'done', cite)], {
      ...body("it('does the thing', () => { assert.ok(1); });\n"),
      runner: brokenRunner,
    });
    assert.equal(r.fatal.length, 1);
    assert.match(r.fatal.join('\n'), /could not run the cited tests/);
  });

  it('refuses to guess when one name is cited from two files', () => {
    const r = checkEvidence({
      repo: fakeRepo({
        'package.json': '{}',
        'tests/unit/a.test.mts': "it('shared name', () => { assert.ok(1); });\n",
        'tests/unit/b.test.mts': "it('shared name', () => { assert.ok(1); });\n",
      }),
      runner: fakeRunner(['shared name']),
      items: [
        itemWith([
          task('1.1', 'done', [{ kind: 'test', file: 'tests/unit/a.test.mts', name: 'shared name' }]),
          task('1.2', 'done', [{ kind: 'test', file: 'tests/unit/b.test.mts', name: 'shared name' }]),
        ]),
      ],
    });
    assert.match(r.fatal.join('\n'), /cited from two files/);
  });
});

// ---------------------------------------------------------------------------
// absence — the ratchet
// ---------------------------------------------------------------------------

describe('absence evidence, which is what catches under-claiming', () => {
  it('accepts a pattern that really is nowhere', () => {
    const r = run([task('1.1', 'todo', [{ kind: 'absent', glob: 'src/**/*.ts', pattern: 'EncodingBroker' }])], {
      files: { 'src/a.ts': 'export const a = 1;\n' },
    });
    assert.deepEqual(r.findings, []);
    assert.equal(r.ratcheted, 1);
    assert.deepEqual(r.unratcheted, []);
  });

  it('goes red the moment the work lands, which is the whole point', () => {
    const r = run([task('1.1', 'todo', [{ kind: 'absent', glob: 'src/**/*.ts', pattern: 'EncodingBroker' }])], {
      files: { 'src/a.ts': 'export class EncodingBroker {}\n' },
    });
    assert.match(messages(r), /the task status is stale/);
  });

  it('is not fooled by the plan for the thing appearing in a comment', () => {
    const r = run([task('1.1', 'todo', [{ kind: 'absent', glob: 'src/**/*.ts', pattern: 'EncodingBroker' }])], {
      files: { 'src/a.ts': '// TODO: an EncodingBroker goes here.\nexport const a = 1;\n' },
    });
    assert.deepEqual(r.findings, []);
  });

  it('refuses an absence check that had nothing to search', () => {
    // A grep over zero files succeeds trivially. That is the failure this
    // repository is organised against, arriving disguised as evidence.
    const r = run([task('1.1', 'todo', [{ kind: 'absent', glob: 'nowhere/**/*.ts', pattern: 'x' }])], {
      files: { 'src/a.ts': 'export const a = 1;\n' },
    });
    assert.match(messages(r), /matched no files/);
  });

  it('counts open tasks that carry no ratchet, rather than leaving the gap implicit', () => {
    const r = run([task('1.1', 'todo'), task('1.2', 'blocked')]);
    assert.equal(r.ratcheted, 0);
    assert.deepEqual([...r.unratcheted], ['1.1', '1.2']);
  });
});

describe('no-files evidence, for work that has not been started', () => {
  const files = { 'tests/conformance/corpus.json': '[]', 'tests/conformance/report.json': '{}' };
  const cite = (glob: string, within: string): Task[] => [
    task('1.1', 'todo', [{ kind: 'no-files', glob, within }]),
  ];

  it('accepts a directory that really is not there', () => {
    const r = run(cite('tests/conformance/fixtures/v1/**/*', 'tests/conformance/**/*'), { files });
    assert.deepEqual(r.findings, []);
    assert.equal(r.ratcheted, 1);
  });

  it('goes red once the files appear', () => {
    const r = run(cite('tests/conformance/fixtures/v1/**/*', 'tests/conformance/**/*'), {
      files: { ...files, 'tests/conformance/fixtures/v1/ls.txt': 'total 0' },
    });
    assert.match(messages(r), /the task status is stale/);
  });

  it('refuses to accept an absence measured in an area that does not exist either', () => {
    // The trap: a renamed parent directory makes every glob under it match
    // nothing, and "nothing was found" then means "we did not look".
    const r = run(cite('tests/gone/fixtures/**/*', 'tests/gone/**/*'), { files });
    assert.match(messages(r), /matched no files, so/);
  });
});

// ---------------------------------------------------------------------------
// json and script evidence
// ---------------------------------------------------------------------------

describe('json evidence', () => {
  const files = {
    'compat/p.json': JSON.stringify({
      engineLimits: { nativePowerShellEngine: false, unimplementedAstNodes: [] },
      behaviors: { newGuid: { defaultVersion: 7 } },
      empty: '',
    }),
  };
  const citing = (path: string): Task[] => [
    task('1.1', 'done', [{ kind: 'json', file: 'compat/p.json', path }]),
  ];

  it('accepts a nested value', () => {
    assert.deepEqual(run(citing('behaviors.newGuid.defaultVersion'), { files }).findings, []);
  });

  it('accepts false, because false is an answer', () => {
    assert.deepEqual(run(citing('engineLimits.nativePowerShellEngine'), { files }).findings, []);
  });

  it('refuses an empty array, which is a field that exists and says nothing', () => {
    assert.match(messages(run(citing('engineLimits.unimplementedAstNodes'), { files })), /resolves to/);
  });

  it('refuses an empty string', () => {
    assert.match(messages(run(citing('empty'), { files })), /resolves to/);
  });

  it('refuses a path that does not resolve', () => {
    assert.match(messages(run(citing('behaviors.nope.deeper'), { files })), /resolves to/);
  });
});

describe('script evidence', () => {
  it('refuses a script package.json does not declare', () => {
    const r = run([
      task('1.1', 'partial', [{ kind: 'script', name: 'nonexistent' }], 'half built'),
    ]);
    assert.match(messages(r), /declares no script "nonexistent"/);
  });
});

// ---------------------------------------------------------------------------
// code evidence, and the comment-blanking it depends on
// ---------------------------------------------------------------------------

describe('code evidence ignores comments', () => {
  it('matches real code', () => {
    const r = run(
      [
        task('1.1', 'done', [
          { kind: 'export', file: 'src/x.ts', symbol: 'a' },
          { kind: 'code', file: 'src/x.ts', pattern: 'keyCode\\s*===\\s*229' },
        ]),
      ],
      { files: { 'src/x.ts': 'export const a = (e: KeyboardEvent) => e.keyCode === 229;\n' } },
    );
    assert.deepEqual(r.findings, []);
  });

  it('does not match the same text inside a comment', () => {
    const r = run(
      [
        task('1.1', 'done', [
          { kind: 'export', file: 'src/x.ts', symbol: 'a' },
          { kind: 'code', file: 'src/x.ts', pattern: 'keyCode\\s*===\\s*229' },
        ]),
      ],
      { files: { 'src/x.ts': '// guard on keyCode === 229 one day\nexport const a = 1;\n' } },
    );
    assert.match(messages(r), /outside comments/);
  });

  it('blanks comments without moving anything else', () => {
    const src = 'const a = 1; // note\n/* block */ const b = 2;\n';
    const out = stripComments(src);
    assert.equal(out.length, src.length);
    assert.equal(out.split('\n').length, src.split('\n').length);
    assert.ok(!out.includes('note'));
    assert.ok(out.includes('const b = 2;'));
  });
});

// ---------------------------------------------------------------------------
// the small readers, tested directly
// ---------------------------------------------------------------------------

describe('the readers behind the evidence kinds', () => {
  it('collects every export form the codebase actually uses', () => {
    const repo = fakeRepo({
      'src/x.ts':
        'export const a = 1;\nexport function b(): void {}\nexport interface C { x: number }\n' +
        "export type D = 'x';\nconst e = 2;\nexport { e };\nexport const { f, g } = { f: 1, g: 2 };\n",
    });
    const { names } = exportedSymbols(repo, 'src/x.ts');
    assert.deepEqual([...names].sort(), ['C', 'D', 'a', 'b', 'e', 'f', 'g']);
  });

  it('reads test names, their inertness and whether they assert', () => {
    const found = declaredTests(
      'tests/unit/x.test.mts',
      "describe('group', () => {\n  it('asserts', () => { assert.ok(1); });\n" +
        "  it.todo('does not');\n});\n",
    );
    const byName = new Map(found.map((t) => [t.name, t]));
    assert.equal(byName.get('asserts')?.asserts, true);
    assert.equal(byName.get('asserts')?.inert, false);
    assert.equal(byName.get('does not')?.inert, true);
  });

  it('reads TAP results at any nesting depth, and never counts a SKIP as a pass', () => {
    const { passed, notPassed } = parseTap(
      ['TAP version 13', '    ok 1 - deep pass', 'ok 2 - shallow pass', 'not ok 3 - a failure', 'ok 4 - skipped one # SKIP'].join('\n'),
    );
    assert.deepEqual([...passed].sort(), ['deep pass', 'shallow pass']);
    assert.deepEqual([...notPassed].sort(), ['a failure', 'skipped one']);
  });
});

// ---------------------------------------------------------------------------
// the real plan
// ---------------------------------------------------------------------------

describe('the plan in roadmap.data.mts', () => {
  /**
   * The static half against the real tree. The cited tests are run for real by
   * `npm run roadmap:evidence`; re-running them here too would double the
   * suite's cost to re-prove what `npm test` already proves, so the runner is
   * stubbed to report the cited names as passing and this asserts everything
   * else — every symbol, every data path, every absence.
   */
  it('cites evidence that resolves against this checkout', () => {
    const items = WORK as readonly WorkItem[];
    const cited = items.flatMap((i) =>
      i.tasks.flatMap((t) => (t.evidence ?? []).filter((e) => e.kind === 'test').map((e) => e.name)),
    );
    const report = checkEvidence({
      repo: fsRepo(REPO_ROOT),
      runner: fakeRunner(cited),
      items,
    });
    assert.deepEqual(report.fatal, []);
    assert.deepEqual(
      report.findings.map((f) => `${f.where}: ${f.message}`),
      [],
    );
    // A checker that quietly evaluated nothing would also report no findings.
    assert.ok(report.evidenceChecked > 50, `only ${String(report.evidenceChecked)} evidence items`);
    assert.equal(report.tasksChecked, report.tasksRequiringEvidence);
  });

  it('makes every done and partial task carry a citation', () => {
    for (const item of WORK as readonly WorkItem[]) {
      for (const t of item.tasks) {
        if (t.status !== 'done' && t.status !== 'partial') continue;
        assert.ok((t.evidence ?? []).length > 0, `task ${t.id} is ${t.status} with no evidence`);
      }
    }
  });
});
