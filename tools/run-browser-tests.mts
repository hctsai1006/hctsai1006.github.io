/**
 * run-browser-tests.mts — the browser gate, with the same refusals as the main one.
 *
 * This is deliberately a near-copy of tools/run-tests.mts rather than a call
 * into it, and the reason is the one that file documents at length: a test
 * runner that exits 0 having run nothing is the failure this repository is
 * organised against, and a second suite needs the same guard rather than an
 * assumption that the first one covers it.
 *
 * `node --test "tests/browser/**\/*.browser.mts"` exits 0 when the glob matches
 * nothing. So does a suite whose only file failed to import a browser and
 * skipped itself. Both are indistinguishable from success unless something
 * reads the counts back, which is what happens below.
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
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every pattern must match at least one file, so a stale pattern is loud. */
const PATTERNS = ['tests/browser/**/*.browser.mts'] as const;

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
  process.exit(2);
}

// The browser suite must not be reachable from the hermetic one. If a file ever
// ends in BOTH `.browser.mts` and `.test.mts` — or someone renames one — the
// replay would start running inside `npm run verify` on machines with no
// Chromium, and the hermetic gate would begin failing for a reason that has
// nothing to do with the change under test.
const leaked = files.filter((f) => f.endsWith('.test.mts'));
if (leaked.length > 0) {
  process.stderr.write(
    `\n  these browser tests would also be picked up by the hermetic suite: ${leaked.join(', ')}\n` +
      '  Rename them: the hermetic gate must not need a browser.\n\n',
  );
  process.exit(2);
}

process.stdout.write(`  running ${String(files.length)} browser test file(s)\n`);
process.stdout.write('  this launches a real Chromium and replays every v1 command; expect minutes\n');

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
  process.exit(2);
}

const output = `${result.stdout ?? ''}`;
process.stdout.write(output);
if (result.stderr) process.stderr.write(result.stderr);

if (result.status !== 0) process.exit(result.status ?? 1);

/**
 * The LAST `ℹ <name> <n>` line, not the first: a test file's own stdout is
 * interleaved into this stream before the reporter's summary, so a file that
 * printed four convincing numbers of its own would otherwise be believed.
 */
function reported(name: string): number | null {
  const all = [...output.matchAll(new RegExp(`^\\s*ℹ ${name} (\\d+)\\s*$`, 'gm'))];
  const last = all.at(-1);
  return last === undefined ? null : Number(last[1]);
}

const tests = reported('tests');
if (tests === null) {
  process.stderr.write(
    '\n  the browser test runner exited 0 but reported no summary line.\n' +
      '  Refusing to call that a pass: nothing here can say whether it ran.\n\n',
  );
  process.exit(2);
}

const pass = reported('pass') ?? 0;
const skipped = reported('skipped') ?? 0;
const todo = reported('todo') ?? 0;

if (tests === 0 || pass === 0) {
  process.stderr.write(
    `\n  ${String(files.length)} browser test file(s) ran and produced ${String(tests)} test(s), ` +
      `${String(pass)} passing.\n` +
      '  A suite that asserts nothing exits 0. Refusing to report success.\n\n',
  );
  process.exit(2);
}

if (skipped > 0 || todo > 0) {
  process.stderr.write(
    `\n  ${String(skipped)} skipped and ${String(todo)} todo test(s).\n` +
      '  A browser test that skips itself when no browser is present is the same\n' +
      '  as no browser test. If Chromium is missing, install it:\n' +
      '      npx playwright install --with-deps chromium\n\n',
  );
  process.exit(2);
}

process.exit(0);
