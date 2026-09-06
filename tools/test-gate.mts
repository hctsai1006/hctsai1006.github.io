/**
 * test-gate.mts — deciding whether a `node --test` run may be called a pass.
 *
 * Both runners in this repository ask the same question and must answer it the
 * same way. They did not.
 *
 * `tools/run-browser-tests.mts` opens by calling itself "a near-copy of
 * tools/run-tests.mts ... with the same refusals as the main one", and the
 * reason it gives is sound: a second suite needs its own guard rather than an
 * assumption that the first one covers it. What that argues for is a second
 * *invocation* — its own glob, its own messages, its own Chromium advice. It
 * does not argue for a second *decision*, and the copy proved it: the unit
 * runner was taught to flush before exiting and the browser runner was not, so
 * for one release the two files disagreed about what a failing suite even does.
 *
 * The decision therefore lives here once. Each runner still spawns its own
 * child, keeps its own patterns, and writes its own wording.
 *
 * ## What the gates are for
 *
 * `node --test` exits 0 in several situations that are not success:
 *
 *   - the glob matched nothing (each runner checks this itself, before spawning)
 *   - every test was skipped, or the suite contains none at all
 *   - a `todo` test whose assertion is FALSE prints `✖ … # TODO` and counts as
 *     neither pass nor fail
 *
 * So the counts the reporter prints are read back and have to describe a run
 * that actually checked something.
 */

/** The counts the spec reporter prints in its trailing summary. */
export interface TestCounts {
  readonly tests: number;
  readonly pass: number;
  readonly fail: number;
  readonly skipped: number;
  readonly todo: number;
}

/**
 * Why a run is being refused, as data rather than prose.
 *
 * The two runners word these differently on purpose — the browser one can tell
 * you to install Chromium, which would be nonsense in the hermetic suite — so
 * the decision names the reason and the caller writes the sentence.
 */
export type Refusal =
  | { readonly kind: 'no-summary' }
  | { readonly kind: 'nothing-ran'; readonly tests: number; readonly pass: number }
  | { readonly kind: 'contradiction'; readonly fail: number }
  | { readonly kind: 'disabled'; readonly skipped: number; readonly todo: number };

export interface Outcome {
  /** The process exit code. Zero ONLY when the suite really ran and really passed. */
  readonly code: number;
  /** Absent when the child already printed its own reason. */
  readonly refusal?: Refusal;
  /** Present only on the success path, for the summary artifact. */
  readonly counts?: TestCounts;
}

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
export function reported(output: string, name: string): number | null {
  const all = [...output.matchAll(new RegExp(`^\\s*ℹ ${name} (\\d+)\\s*$`, 'gm'))];
  const last = all.at(-1);
  return last === undefined ? null : Number(last[1]);
}

/**
 * Turn the child's exit status and captured output into an exit code.
 *
 * Pure on purpose. The interesting cases are the ones where a suite lies about
 * itself, and those are far easier to write down as strings than to reproduce by
 * spawning a real runner — which is why this file had no test for so long, and
 * why the false pass in it went unnoticed.
 */
export function decideOutcome(status: number | null, output: string): Outcome {
  // The child already printed its own failures; a refusal line here would only
  // bury them. Forwarding a non-zero status is the whole job.
  //
  // A null status is what a signalled or killed child leaves. That is not a pass
  // either, so it forwards as 1.
  if (status !== 0) return { code: status ?? 1 };

  const tests = reported(output, 'tests');
  if (tests === null) return { code: 2, refusal: { kind: 'no-summary' } };

  // `tests > 0` alone is not enough, and an adversarial review proved it:
  // rewriting every `it(` to `it.skip(` across the whole suite produced
  //
  //     ℹ tests 561   ℹ pass 0   ℹ fail 0   ℹ skipped 561
  //
  // and the gate passed it, because 561 tests were still *reported*.
  const pass = reported(output, 'pass') ?? 0;
  const fail = reported(output, 'fail') ?? 0;
  const skipped = reported(output, 'skipped') ?? 0;
  const todo = reported(output, 'todo') ?? 0;

  if (tests === 0 || pass === 0) {
    return { code: 2, refusal: { kind: 'nothing-ran', tests, pass } };
  }

  // Defence in depth, and NOT hypothetical — this exact disagreement shipped.
  //
  // MEASURED, on a tree with one deliberately failing test: `spawnSync` returned
  // status 1 and the reporter printed `ℹ fail 1`, and the runner still exited 0,
  // because its early-exit branch was written as
  //
  //     process.stdout.write(text, () => { process.exit(code); });
  //
  // inside a helper annotated `: never`. `write` with a callback RETURNS
  // IMMEDIATELY, so the helper returned, the caller's next statement ran, and the
  // module continued to its own synchronous `process.exit(0)` — which always won
  // the race against a callback. Both the `: never` annotation and the comment
  // saying "nothing after a call to this runs" were false, and TypeScript cannot
  // catch it, because `return undefined as never` satisfies `never` by assertion.
  //
  // The structure fixes that. This gate is the belt to its braces: if a child
  // ever exits 0 while reporting failures, believe the failures.
  if (fail > 0) return { code: 2, refusal: { kind: 'contradiction', fail } };

  if (skipped > 0 || todo > 0) {
    return { code: 2, refusal: { kind: 'disabled', skipped, todo } };
  }

  return { code: 0, counts: { tests, pass, fail, skipped, todo } };
}
