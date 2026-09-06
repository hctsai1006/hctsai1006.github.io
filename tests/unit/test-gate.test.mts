/**
 * The gate that decides whether a test suite may be called a pass.
 *
 * It had no test of its own, and a false pass shipped in it: on a tree with one
 * deliberately failing test, `node --run test` printed
 *
 *     ℹ tests 2655   ℹ pass 2654   ℹ fail 1
 *
 * and exited **0**. `spawnSync` had reported status 1 correctly; the runner threw
 * it away. The early-exit branch was written as
 *
 *     function writeThenExit(text, code) {
 *       process.stdout.write(text, () => { process.exit(code); });
 *       return undefined as never;
 *     }
 *
 * `write` with a callback returns immediately, so the helper returned, the
 * caller's next statement ran, and the module continued to its own synchronous
 * `process.exit(0)` — which always beat the callback. Both the `: never`
 * annotation and the comment saying "nothing after a call to this runs" were
 * false, and TypeScript cannot catch it: `return undefined as never` satisfies
 * `never` by assertion.
 *
 * That shape came from a real fix — exiting inside the callback was how a
 * truncated CI log got solved — which is the part worth keeping in mind: the
 * second fix broke a property the first one never had to think about, and no
 * test held either property down.
 *
 * So these pin the decision rather than the plumbing. Every case below is a way
 * a suite can lie about itself.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decideOutcome, reported } from '../../tools/test-gate.mts';
import { stripComments } from '../../tools/roadmap-evidence.mts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Both runners ask the shared gate the same question, so both are pinned here. */
const RUNNERS = ['tools/run-tests.mts', 'tools/run-browser-tests.mts'] as const;

function sourceOf(rel: string): string {
  return readFileSync(resolve(REPO, rel), 'utf8');
}

/** The spec reporter's trailing summary block, in its real shape. */
function summary(counts: {
  tests: number;
  pass: number;
  fail: number;
  skipped?: number;
  todo?: number;
}): string {
  return [
    '✔ some suite (1.234ms)',
    `ℹ tests ${counts.tests}`,
    'ℹ suites 12',
    `ℹ pass ${counts.pass}`,
    `ℹ fail ${counts.fail}`,
    'ℹ cancelled 0',
    `ℹ skipped ${counts.skipped ?? 0}`,
    `ℹ todo ${counts.todo ?? 0}`,
    'ℹ duration_ms 2400',
    '',
  ].join('\n');
}

describe('the suite really passed', () => {
  it('exits 0 and reports the counts for the summary artifact', () => {
    const outcome = decideOutcome(0, summary({ tests: 2645, pass: 2645, fail: 0 }));
    assert.equal(outcome.code, 0);
    assert.equal(outcome.refusal, undefined);
    assert.deepEqual(outcome.counts, { tests: 2645, pass: 2645, fail: 0, skipped: 0, todo: 0 });
  });
});

describe('the child said it failed', () => {
  // THE REGRESSION. Everything about this output looks like a pass — 2654 of
  // 2655 passing, nothing skipped, nothing todo — and the ONLY thing saying
  // otherwise is the exit status. The shipped runner read the counts, liked
  // them, and exited 0.
  it('forwards a non-zero status even when the counts look healthy', () => {
    assert.equal(decideOutcome(1, summary({ tests: 2655, pass: 2654, fail: 1 })).code, 1);
  });

  it('adds no refusal of its own, because the child already printed why', () => {
    assert.equal(decideOutcome(1, summary({ tests: 2655, pass: 2654, fail: 1 })).refusal, undefined);
  });

  it('forwards the child code rather than inventing one', () => {
    assert.equal(decideOutcome(7, summary({ tests: 5, pass: 4, fail: 1 })).code, 7);
  });

  it('refuses a null status, which is what a signalled child leaves', () => {
    assert.equal(decideOutcome(null, summary({ tests: 5, pass: 5, fail: 0 })).code, 1);
  });

  it('writes no summary artifact for a failing run', () => {
    assert.equal(decideOutcome(1, summary({ tests: 9, pass: 8, fail: 1 })).counts, undefined);
  });
});

describe('the child contradicts itself', () => {
  // Defence in depth: status 0 AND failures reported. Nothing should produce
  // this, which is exactly why it must not be believed if it ever appears.
  it('refuses a zero status that reports failing tests', () => {
    const outcome = decideOutcome(0, summary({ tests: 100, pass: 97, fail: 3 }));
    assert.equal(outcome.code, 2);
    assert.deepEqual(outcome.refusal, { kind: 'contradiction', fail: 3 });
  });
});

describe('the suite did not really run', () => {
  it('refuses output with no summary line at all', () => {
    const outcome = decideOutcome(0, 'nothing that looks like a summary\n');
    assert.equal(outcome.code, 2);
    assert.deepEqual(outcome.refusal, { kind: 'no-summary' });
  });

  it('refuses zero tests', () => {
    assert.equal(decideOutcome(0, summary({ tests: 0, pass: 0, fail: 0 })).code, 2);
  });

  it('refuses zero passing, which is what a fully skipped suite looks like', () => {
    const outcome = decideOutcome(0, summary({ tests: 561, pass: 0, fail: 0, skipped: 561 }));
    assert.equal(outcome.code, 2);
    assert.deepEqual(outcome.refusal, { kind: 'nothing-ran', tests: 561, pass: 0 });
  });

  it('refuses any skipped test', () => {
    const outcome = decideOutcome(0, summary({ tests: 100, pass: 99, fail: 0, skipped: 1 }));
    assert.equal(outcome.code, 2);
    assert.deepEqual(outcome.refusal, { kind: 'disabled', skipped: 1, todo: 0 });
  });

  it('refuses any todo test, whose failing assertion still exits 0', () => {
    assert.equal(decideOutcome(0, summary({ tests: 100, pass: 99, fail: 0, todo: 1 })).code, 2);
  });
});

describe('a test file printing counterfeit summary lines', () => {
  // A test's own stdout is interleaved BEFORE the reporter's summary, so the
  // last occurrence is the real one. Here a test file prints a healthy-looking
  // block and the real run underneath it is empty.
  const forged = [
    'ℹ tests 1291',
    'ℹ pass 1291',
    'ℹ fail 0',
    'ℹ skipped 0',
    'ℹ todo 0',
    summary({ tests: 0, pass: 0, fail: 0 }),
  ].join('\n');

  it('reads the last occurrence, not the first', () => {
    assert.equal(reported(forged, 'tests'), 0);
    assert.equal(reported(forged, 'pass'), 0);
  });

  it('refuses the run the forged block was hiding', () => {
    assert.equal(decideOutcome(0, forged).code, 2);
  });
});

describe('neither runner can exit early again', () => {
  /**
   * A source-level ratchet, not a behavioural one.
   *
   * The defect was structural: a `process.exit()` reached before the file had
   * finished deciding. Any `process.exit(` reintroduced in a runner is either an
   * early exit that discards buffered stdout on POSIX — MEASURED on node:24,
   * 8 MB to a pipe arrives as 65,536 bytes — or one that overtakes a pending
   * write. Those are the two halves of the bug this gate has now had twice, once
   * in each direction.
   *
   * Comments are stripped first, and that is not incidental: the first version
   * of this test FAILED, because both runners quote the broken line inside the
   * comment explaining why it is broken. A raw text search over a file that
   * documents its own defect finds the defect it documents. `stripComments`
   * already exists for the roadmap's absence ratchet, which had a subtler form
   * of the same problem, so this reuses it rather than growing a second one.
   *
   * This asserts the absence of something, which is worth stating plainly: it
   * cannot prove either file is correct, only that the one shape known to break
   * them is gone.
   */
  for (const runner of RUNNERS) {
    it(`${runner} calls process.exit nowhere and sets process.exitCode once`, () => {
      const source = stripComments(sourceOf(runner));
      assert.deepEqual(source.match(/process\.exit\(/g) ?? [], [], `process.exit() is back in ${runner}`);
      assert.equal((source.match(/process\.exitCode\s*=/g) ?? []).length, 1);
    });

    it(`${runner} decides with the shared gate rather than its own copy`, () => {
      const source = stripComments(sourceOf(runner));
      assert.match(source, /from '\.\/test-gate\.mts'/);
      // The counts must be read through the shared reader. A runner that grew
      // its own `ℹ` regex again would be the drift that caused this in the
      // first place: the two files disagreed for a release because one was
      // fixed and the other was a copy.
      assert.doesNotMatch(source, /ℹ \$\{name\}/);
    });
  }

  /**
   * The ratchet has to be able to fail, or it is decoration.
   *
   * `stripComments` blanks comments and leaves code, so feeding it the shape
   * that shipped must still find the call. Without this, a `stripComments` that
   * one day blanked everything would turn the tests above permanently green.
   */
  it('still finds process.exit in the shape that shipped', () => {
    const shipped = [
      '// process.exit(code) in a comment must NOT count',
      'function writeThenExit(text, code) {',
      '  process.stdout.write(text, () => { process.exit(code); });',
      '}',
    ].join('\n');
    assert.deepEqual(stripComments(shipped).match(/process\.exit\(/g), ['process.exit(']);
  });
});

describe('the browser runner keeps the advice only it can give', () => {
  // Sharing the DECISION must not flatten the WORDING. The browser suite is the
  // only one that can tell you a missing Chromium is why nothing ran, and that
  // sentence would be nonsense in the hermetic suite.
  it('still explains how to install Chromium when tests skip themselves', () => {
    assert.match(sourceOf('tools/run-browser-tests.mts'), /playwright install --with-deps chromium/);
  });

  it('does not offer that advice in the hermetic runner', () => {
    assert.doesNotMatch(sourceOf('tools/run-tests.mts'), /playwright install/);
  });
});
