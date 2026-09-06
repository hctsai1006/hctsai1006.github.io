/**
 * run-browser-tests.mts — the browser gate, with the same refusals as the main one.
 *
 * "The same refusals" is now literally true. This file used to be a near-copy of
 * tools/run-tests.mts, and the reason given for the copy was sound: a second
 * suite needs its own guard rather than an assumption that the first one covers
 * it. But that argues for a second *invocation* — its own glob, its own leak
 * check, its own Chromium advice — and not for a second *decision*, and the copy
 * proved the difference the hard way. When the unit runner was taught to flush
 * its captured output before exiting, this file was not, so the two disagreed
 * about what a failing suite does. It kept the shape the other one had just been
 * fixed for:
 *
 *     process.stdout.write(output);
 *     if (result.status !== 0) process.exit(result.status ?? 1);
 *
 * MEASURED on node:24 in Docker, writing 8 MB to a pipe: that shape delivers
 * 65,536 bytes — one pipe buffer — and drops the rest. A failing browser run
 * would report its exit code and throw away the transcript that said which
 * replay diverged.
 *
 * So the decision moved to tools/test-gate.mts and both runners import it. What
 * stays here is everything genuinely specific to this suite.
 *
 * `node --test "tests/browser/**\/*.browser.mts"` exits 0 when the glob matches
 * nothing. So does a suite whose only file failed to import a browser and
 * skipped itself. Both are indistinguishable from success unless something reads
 * the counts back, which is what the shared gate does.
 *
 * WHY A SEPARATE SUITE AT ALL. `npm run verify` is asserted hermetic by
 * tests/unit/workflows.test.mts, and Chromium is a 130MB download. Folding the
 * replay into `npm test` would make a required, network-free gate depend on a
 * browser being present, and a required gate that fails for reasons unrelated
 * to the change under test is a gate that gets muted. The transcripts are
 * therefore checked twice: hermetically for coherence, and here for truth.
 *
 * Usage:
 *   node tools/run-browser-tests.mts
 */

import { globSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decideOutcome, type Refusal } from './test-gate.mts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every pattern must match at least one file, so a stale pattern is loud. */
const PATTERNS = ['tests/browser/**/*.browser.mts'] as const;

/** This suite's wording for each refusal the shared gate can return. */
function explain(refusal: Refusal, files: number): string {
  switch (refusal.kind) {
    case 'no-summary':
      return (
        '\n  the browser test runner exited 0 but reported no summary line.\n' +
        '  Refusing to call that a pass: nothing here can say whether it ran.\n\n'
      );
    case 'nothing-ran':
      return (
        `\n  ${files} browser test file(s) ran and produced ${refusal.tests} test(s), ` +
        `${refusal.pass} passing.\n` +
        '  A suite that asserts nothing exits 0. Refusing to report success.\n\n'
      );
    case 'contradiction':
      return (
        `\n  the browser test runner exited 0 but reported ${refusal.fail} failing test(s).\n` +
        '  Those two cannot both be true. Refusing to report success for a suite\n' +
        '  that contradicts itself.\n\n'
      );
    case 'disabled':
      return (
        `\n  ${refusal.skipped} skipped and ${refusal.todo} todo test(s).\n` +
        '  A browser test that skips itself when no browser is present is the same\n' +
        '  as no browser test. If Chromium is missing, install it:\n' +
        '      npx playwright install --with-deps chromium\n\n'
      );
  }
}

/** See tools/run-tests.mts for why this returns a code instead of exiting. */
function main(): number {
  const files: string[] = [];
  const empty: string[] = [];
  for (const pattern of PATTERNS) {
    const matched = globSync(pattern, { cwd: REPO }).sort();
    if (matched.length === 0) empty.push(pattern);
    files.push(...matched);
  }

  if (empty.length > 0) {
    process.stderr.write(
      `\n  no browser test files matched: ${empty.join(', ')}\n` +
        '  Either the tests moved or the pattern is wrong. Refusing to report success\n' +
        '  for a suite that did not run.\n\n',
    );
    return 2;
  }

  // The browser suite must not be reachable from the hermetic one. A file under
  // tests/browser/ named `*.test.mts` is picked up by tools/run-tests.mts's glob,
  // so the replay would start launching Chromium inside `npm run verify` on
  // machines that have none.
  //
  // THE FIRST VERSION OF THIS FILTERED `files`, which is the list the glob above
  // just produced — every entry of which ends in `.browser.mts` — so it could
  // never match and was a no-op. An adversarial pass dropped a `leak.test.mts`
  // next to the real one and this gate reported success. Scan the DIRECTORY, not
  // the matches.
  //
  // tests/unit/v1-transcripts.test.mts asserts the same property from the other
  // side, over every hermetic test file, which is the check that holds wherever
  // the leaked file happens to live.
  const leaked = globSync('tests/browser/**/*.test.mts', { cwd: REPO }).map((f) =>
    f.split(sep).join('/'),
  );
  if (leaked.length > 0) {
    process.stderr.write(
      `\n  these browser tests would also be picked up by the hermetic suite: ${leaked.join(', ')}\n` +
        '  Rename them: the hermetic gate must not need a browser.\n\n',
    );
    return 2;
  }

  process.stdout.write(`  running ${files.length} browser test file(s)\n`);
  process.stdout.write(
    '  this launches a real Chromium and replays every v1 command; expect minutes\n',
  );

  // Same scrub as tools/run-tests.mts. `NODE_OPTIONS=--test-only` with no `.only`
  // anywhere executed no test body at all and still reported every count this
  // gate checks.
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
  process.stdout.write(output);

  const outcome = decideOutcome(result.status, output);
  if (outcome.refusal !== undefined) process.stderr.write(explain(outcome.refusal, files.length));

  return outcome.code;
}

if (import.meta.main) {
  process.exitCode = main();
}
