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

const result = spawnSync(
  process.execPath,
  ['--test', '--test-reporter=spec', ...files.map((f) => relative(REPO, resolve(REPO, f)))],
  { cwd: REPO, stdio: 'inherit' },
);

if (result.error !== undefined) {
  process.stderr.write(`\n  could not start the test runner: ${result.error.message}\n\n`);
  process.exit(2);
}

process.exit(result.status ?? 1);
