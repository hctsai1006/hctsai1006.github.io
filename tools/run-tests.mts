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

import { globSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
const result = spawnSync(
  process.execPath,
  ['--test', '--test-reporter=spec', ...files.map((f) => relative(REPO, resolve(REPO, f)))],
  { cwd: REPO, encoding: 'utf8' },
);

if (result.error !== undefined) {
  process.stderr.write(`\n  could not start the test runner: ${result.error.message}\n\n`);
  process.exit(2);
}

const output = `${result.stdout ?? ''}`;
process.stdout.write(output);
if (result.stderr) process.stderr.write(result.stderr);

if (result.status !== 0) process.exit(result.status ?? 1);

const reported = /^\s*ℹ tests (\d+)\s*$/m.exec(output);
if (reported === null) {
  process.stderr.write(
    '\n  the test runner exited 0 but reported no summary line.\n' +
      '  Refusing to call that a pass: nothing here can say whether it ran.\n\n',
  );
  process.exit(2);
}
if (Number(reported[1]) === 0) {
  process.stderr.write(
    `\n  ${files.length} test file(s) ran and produced 0 tests.\n` +
      '  A suite with nothing in it exits 0, which is how a commented-out file\n' +
      '  keeps CI green. Refusing to report success.\n\n',
  );
  process.exit(2);
}

process.exit(0);
