/**
 * run-tests.mts — run the hermetic test suite, and fail if there is no test suite.
 *
 * `node --test "tests/**\/*.test.mts"` exits 0 when the glob matches nothing:
 *
 *     $ node --test "tests/**\/*.nomatch.mts"
 *     ℹ tests 0 … exit 0
 *
 * So renaming a directory, moving a file, or mistyping the glob silently
 * disables the entire test gate while CI stays green. That is the same failure
 * this repo's release verifier is built to prevent — a check that reports
 * success because it never ran — reproduced inside the safety net itself.
 *
 * This resolves the files first and refuses to run with an empty list. Whether
 * the run that follows counts as a pass is decided by `tools/test-gate.mts`,
 * shared with the browser runner so the two cannot drift; the wording of each
 * refusal stays here, because it is specific to this suite.
 *
 * What that does NOT catch, stated so nobody assumes otherwise: one file going
 * empty while the others still run. Catching that needs a per-file count, which
 * means running the files separately, and the whole-suite floor is what this
 * docstring claims. If per-file coverage ever matters, that is the next step,
 * not a reason to believe this already does it.
 */

import { globSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decideOutcome, type Refusal } from './test-gate.mts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every pattern must match at least one file, so a stale pattern is loud. */
const PATTERNS = ['tests/**/*.test.mts'] as const;

/**
 * `--summary <path>` writes the counts this file already reads back, as JSON.
 *
 * Not decoration. The pull request that introduced this runner stated "Tests |
 * 589, all passing" in its body; the run it was describing executed 592, and the
 * suite is far past that now. A count typed into prose is wrong the day after it
 * is typed, and nothing anywhere notices. Anything that wants to state a number
 * reads it from here — see `renderBody` in tools/upstream-sync.mts, which omits
 * the sentence entirely rather than guess when this artifact is absent.
 */
function summaryPathFrom(argv: readonly string[]): string | null {
  const i = argv.indexOf('--summary');
  const value = i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith('--summary='))?.slice(10);
  return value === undefined || value === '' ? null : resolve(REPO, value);
}

/** This suite's wording for each refusal the shared gate can return. */
function explain(refusal: Refusal, files: number): string {
  switch (refusal.kind) {
    case 'no-summary':
      return (
        '\n  the test runner exited 0 but reported no summary line.\n' +
        '  Refusing to call that a pass: nothing here can say whether it ran.\n\n'
      );
    case 'nothing-ran':
      return (
        `\n  ${files} test file(s) ran and produced ${refusal.tests} test(s), ` +
        `${refusal.pass} passing.\n` +
        '  A suite that asserts nothing exits 0, which is how a commented-out or\n' +
        '  skipped file keeps CI green. Refusing to report success.\n\n'
      );
    case 'contradiction':
      return (
        `\n  the test runner exited 0 but reported ${refusal.fail} failing test(s).\n` +
        '  Those two cannot both be true. Refusing to report success for a suite\n' +
        '  that contradicts itself.\n\n'
      );
    case 'disabled':
      return (
        `\n  ${refusal.skipped} skipped and ${refusal.todo} todo test(s).\n` +
        '  Both hide a check that is not happening, and a todo whose assertion\n' +
        '  fails still exits 0. If a test must be disabled, delete it and say why\n' +
        '  in the commit — a suite cannot report success for work it did not do.\n\n'
      );
  }
}

/**
 * `process.exitCode` and a natural exit, never `process.exit()`.
 *
 * On POSIX, stdout to a pipe is ASYNCHRONOUS, and `process.exit()` discards
 * whatever has not drained. On Windows it is synchronous, so code that exits
 * eagerly looks correct there — which is how the original survived review: it
 * was written and tested on Windows and destroyed evidence only on CI.
 *
 * MEASURED on node:24 in Docker, 8 MB written to a pipe, expecting 8,388,630
 * bytes:
 *
 *     write(big); process.exit(1)      ->  65,536 bytes   (one pipe buffer)
 *     write(big); process.exitCode = 1 ->   8,388,630 bytes, exit code 1
 *
 * The first number is why a `verify` failure on Linux CI once arrived cut off
 * mid-line, 74,536 bytes with no summary and no failing-test name: the suite had
 * genuinely failed, and the line reporting it threw away the only thing that
 * could say why.
 *
 * An earlier fix exited from inside `write`'s completion callback. That flushed,
 * but `write` returns immediately, so the module kept running and reached its own
 * `process.exit(0)` first — trading a truncated failure for a silent pass. Setting
 * `exitCode` and returning solves both at once: pending writes keep the stream
 * referenced so Node stays alive until they drain, and there is no early exit
 * left to overtake them.
 */
function main(argv: readonly string[]): number {
  const summaryPath = summaryPathFrom(argv);

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
    return 2;
  }

  process.stdout.write(`  running ${files.length} test file(s)\n`);

  // Captured rather than inherited, so the summary can be read back. The cost is
  // that output arrives at the end instead of streaming; for a suite that runs in
  // a few seconds that is a fair trade for closing the hole above.
  //
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
    return 2;
  }

  const output = `${result.stdout ?? ''}`;
  if (result.stderr) process.stderr.write(result.stderr);
  // Unconditionally, and BEFORE the decision: on every path the child's own
  // output is the only thing that can say what went wrong.
  process.stdout.write(output);

  const outcome = decideOutcome(result.status, output);
  if (outcome.refusal !== undefined) process.stderr.write(explain(outcome.refusal, files.length));

  // Written only on the success path, and only after every gate above. A summary
  // artifact recording a run that did not really pass would be a worse lie than
  // the hand-written number it replaces.
  if (outcome.code === 0 && outcome.counts !== undefined && summaryPath !== null) {
    mkdirSync(dirname(summaryPath), { recursive: true });
    writeFileSync(
      summaryPath,
      JSON.stringify({ files: files.length, ...outcome.counts }, null, 2) + '\n',
      'utf8',
    );
    process.stdout.write(`  wrote ${relative(REPO, summaryPath)}\n`);
  }

  return outcome.code;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
