/**
 * run-tests.mts — run the test suite, and fail if there is no test suite.
 *
 * `node --test "tests/**\/*.test.mts"` exits 0 when the glob matches nothing:
 *
 *     $ node --test "tests/**\/*.nomatch.mts"
 *     ℹ tests 0 … exit 0
 *
 * So renaming a directory, moving a file, or mistyping the glob silently
 * disables the entire test gate while CI stays green. That is the same
 * failure this repo's release verifier is built to prevent — a check that
 * reports success because it never ran — reproduced inside the safety net
 * itself.
 *
 * This resolves the files first, refuses to run with an empty list, and asserts
 * afterwards that tests actually executed.
 *
 * That second half was a promise this file did not keep — it said it asserted
 * execution and then just forwarded the child's exit code. A review pointed out
 * the hole is still reachable one level down:
 *
 *     describe('everything', () => { /* someone commented the tests out *\/ });
 *     ℹ tests 0 … exit 0
 *
 * A suite of zero tests passes. So the reported count is now read back and has
 * to be greater than zero.
 *
 * What that does NOT catch, stated so nobody assumes otherwise: one file going
 * empty while the others still run. Catching that needs a per-file count, which
 * means running the files separately, and the whole-suite floor is what the
 * docstring claimed. If per-file coverage ever matters, that is the next step,
 * not a reason to believe this already does it.
 */

import { globSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `--summary <path>` writes the counts this file already reads back, as JSON.
 *
 * Not decoration. The pull request that introduced this runner stated "Tests |
 * 589, all passing" in its body; the run it was describing executed 592, and the
 * suite is at 1878 now. A count typed into prose is wrong the day after it is
 * typed, and nothing anywhere notices. Anything that wants to state a number now
 * reads it from here — see `renderBody` in tools/upstream-sync.mts, which omits
 * the sentence entirely rather than guess when this artifact is absent.
 */
const summaryPath = ((): string | null => {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--summary');
  const value = i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith('--summary='))?.slice(10);
  return value === undefined || value === '' ? null : resolve(REPO, value);
})();

/** Every pattern must match at least one file, so a stale pattern is loud. */
const PATTERNS = ['tests/**/*.test.mts'] as const;

const files: string[] = [];
const empty: string[] = [];

for (const pattern of PATTERNS) {
  const matched = globSync(pattern, { cwd: REPO }).sort();
  if (matched.length === 0) empty.push(pattern);
  files.push(...matched);
}

if (empty.length > 0) {
  process.stderr.write(
    `\n  no test files matched: ${empty.join(', ')}\n` +
      '  Either the tests moved or the pattern is wrong. Refusing to report success\n' +
      '  for a suite that did not run.\n\n',
  );
  process.exit(2);
}

process.stdout.write(`  running ${files.length} test file(s)\n`);

// Captured rather than inherited, so the summary can be read back. The cost is
// that output arrives at the end instead of streaming; for a suite that runs in
// about two seconds that is a fair trade for closing the hole above.
// NODE_OPTIONS is scrubbed of the flags that make the runner report success
// without running anything. `NODE_OPTIONS=--test-only` with no `.only` anywhere
// executed no test body at all and reported `tests 39, pass 39, fail 0,
// skipped 0, todo 0` — every condition this gate checks, from 1291 real tests
// none of which ran.
const SUPPRESSORS = /--test-only|--test-name-pattern(=\S*)?|--test-skip-pattern(=\S*)?/g;
const scrubbed = (process.env['NODE_OPTIONS'] ?? '').replace(SUPPRESSORS, '').trim();
if (scrubbed !== (process.env['NODE_OPTIONS'] ?? '').trim()) {
  process.stdout.write('  ignoring test-suppressing flags in NODE_OPTIONS\n');
}

const result = spawnSync(
  process.execPath,
  ['--test', '--test-reporter=spec', ...files.map((f) => relative(REPO, resolve(REPO, f)))],
  { cwd: REPO, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: scrubbed } },
);

if (result.error !== undefined) {
  process.stderr.write(`\n  could not start the test runner: ${result.error.message}\n\n`);
  process.exit(2);
}

const output = `${result.stdout ?? ''}`;
process.stdout.write(output);
if (result.stderr) process.stderr.write(result.stderr);

if (result.status !== 0) process.exit(result.status ?? 1);

/**
 * Read one `ℹ <name> <n>` line out of the spec reporter's summary.
 *
 * The LAST match, not the first. A test file's own stdout is interleaved into
 * this stream BEFORE the reporter's summary, so a file containing
 *
 *     console.log('ℹ tests 1291'); console.log('ℹ pass 1291');
 *     console.log('ℹ skipped 0');  console.log('ℹ todo 0');
 *     test.skip('the entire safety net', () => { assert.equal(1, 2); });
 *
 * handed this gate exactly the four numbers it wanted while every real test was
 * skipped, and it exited 0. The reporter writes its summary last, so the final
 * occurrence is the one that came from the runner rather than from a test.
 */
function reported(name: string): number | null {
  const all = [...output.matchAll(new RegExp(`^\\s*ℹ ${name} (\\d+)\\s*$`, 'gm'))];
  const last = all.at(-1);
  return last === undefined ? null : Number(last[1]);
}

const tests = reported('tests');
if (tests === null) {
  process.stderr.write(
    '\n  the test runner exited 0 but reported no summary line.\n' +
      '  Refusing to call that a pass: nothing here can say whether it ran.\n\n',
  );
  process.exit(2);
}

// `tests > 0` alone is not enough, and an adversarial review proved it: rewriting
// every `it(` to `it.skip(` across the whole suite produced
//
//     ℹ tests 561   ℹ pass 0   ℹ fail 0   ℹ skipped 561
//
// and this gate passed it, because 561 tests were still *reported*. `it.todo` is
// worse — a todo test whose assertion is FALSE prints `✖ … # TODO`, counts as
// neither pass nor fail, and exits 0. So the counts that mean "something was
// actually checked" are the ones to read.
const pass = reported('pass') ?? 0;
const skipped = reported('skipped') ?? 0;
const todo = reported('todo') ?? 0;

if (tests === 0 || pass === 0) {
  process.stderr.write(
    `\n  ${files.length} test file(s) ran and produced ${tests} test(s), ${pass} passing.\n` +
      '  A suite that asserts nothing exits 0, which is how a commented-out or\n' +
      '  skipped file keeps CI green. Refusing to report success.\n\n',
  );
  process.exit(2);
}

if (skipped > 0 || todo > 0) {
  process.stderr.write(
    `\n  ${skipped} skipped and ${todo} todo test(s).\n` +
      '  Both hide a check that is not happening, and a todo whose assertion\n' +
      '  fails still exits 0. If a test must be disabled, delete it and say why\n' +
      '  in the commit — a suite cannot report success for work it did not do.\n\n',
  );
  process.exit(2);
}

// Written only on the success path, and only after every gate above. A summary
// artifact recording a run that did not really pass would be a worse lie than
// the hand-written number it replaces.
if (summaryPath !== null) {
  mkdirSync(dirname(summaryPath), { recursive: true });
  writeFileSync(
    summaryPath,
    JSON.stringify(
      { files: files.length, tests, pass, fail: reported('fail') ?? 0, skipped, todo },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  process.stdout.write(`  wrote ${relative(REPO, summaryPath)}\n`);
}

process.exit(0);
