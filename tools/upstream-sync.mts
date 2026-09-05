/**
 * upstream-sync.mts — the decisions the scheduled upstream-sync workflow makes,
 * in a file that can be tested, instead of in YAML that cannot.
 *
 * Two defects motivated pulling this out of the workflow's shell steps. Both
 * were found by review rather than by the workflow, because nothing in the
 * workflow could be executed anywhere except on a scheduled run against the
 * default branch — the one place where being wrong is expensive.
 *
 * DEFECT 1 — a new pull request every single day.
 *
 *   The branch name was built as
 *
 *       BRANCH="upstream-sync/$(date -u +%Y-%m-%d)-${{ github.run_id }}"
 *
 *   so every run produced a branch nothing had ever seen, and nothing looked for
 *   an already-open sync pull request. Drift that is not merged within a day
 *   produces a second near-identical pull request, then a third. The
 *   `concurrency` group does not help: it prevents two runs OVERLAPPING, not two
 *   runs on consecutive days each opening their own PR.
 *
 *   The fix is one workflow-owned branch, rebuilt from the base on every run and
 *   force-pushed, plus a lookup for the open PR from that branch: update it if it
 *   exists, create it if it does not, close it when the drift is gone. The count
 *   of open sync PRs is then bounded at one by construction rather than by luck.
 *
 * DEFECT 2 — fail-open on unexpected exit codes.
 *
 *   The check step ran under `set +e`, wrote `$?` to an output, and the workflow
 *   then failed only on
 *
 *       if: steps.check.outputs.exit == '2' || steps.check.outputs.exit == '3'
 *
 *   Every other value fell through every subsequent `if`, so a verifier that died
 *   on 127 (command not found), 126 (not executable), 137 (OOM-killed) or 124
 *   (timeout) skipped the failure step, skipped the regeneration, skipped the PR,
 *   and the job went GREEN. The most alarming outcomes were the only ones that
 *   produced no signal at all.
 *
 *   `classifyExit` is total: every known code gets known handling and everything
 *   else is a failure. Fail-closed is the default, not a branch someone
 *   remembered to write.
 *
 * Usage (all subcommands are used by .github/workflows/upstream-sync.yml):
 *
 *   node tools/upstream-sync.mts decide --exit <code>
 *   node tools/upstream-sync.mts publish --branch <b> --message <m> --path <p>...
 *   node tools/upstream-sync.mts reconcile --branch <b> --base <b> [--drifted]
 *
 * Exit codes:
 *   0  the decision was made and any effects succeeded
 *   1  fail closed — an unexpected verifier exit, a refused force-push, a gh
 *      failure, or a missing repository prerequisite
 *   2  this tool was invoked wrongly (bad or missing arguments)
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// exit-code classification  (DEFECT 2)
// ---------------------------------------------------------------------------

export type ExitDecision = 'clean' | 'drift' | 'fail';

export interface ExitClassification {
  decision: ExitDecision;
  /** The parsed code, or null when the input was not a number at all. */
  code: number | null;
  /** A short stable label, suitable for a workflow output and for a log grep. */
  label: string;
  explanation: string;
}

/**
 * Shell codes worth naming. They do not change the decision — everything not in
 * {0,1,2,3} fails — but an operator reading a red job should not have to look up
 * what 137 means while deciding whether upstream broke or the runner did.
 */
const SHELL_CODES = new Map<number, string>([
  [124, 'the command timed out (GNU timeout)'],
  [125, 'the command could not be executed'],
  [126, 'found but not executable — a permissions or interpreter problem'],
  [127, 'command not found — the interpreter or the script is missing'],
  [128, 'invalid exit argument'],
  [130, 'terminated by SIGINT'],
  [137, 'killed by SIGKILL — on a runner this is almost always the OOM killer'],
  [139, 'segmentation fault'],
  [143, 'terminated by SIGTERM'],
]);

export function classifyExit(raw: string | number | undefined | null): ExitClassification {
  const text = typeof raw === 'number' ? String(raw) : (raw ?? '').trim();

  if (text === '') {
    // A step that was cancelled, or never ran, leaves the output empty. The old
    // workflow compared '' against '2' and '3', got false for both, and carried
    // on as though the verifier had said "clean".
    return {
      decision: 'fail',
      code: null,
      label: 'missing-exit-code',
      explanation:
        'the verifier step recorded no exit code at all. It was cancelled, killed, or never ran; ' +
        'nothing here knows whether upstream moved.',
    };
  }

  if (!/^\d+$/.test(text)) {
    return {
      decision: 'fail',
      code: null,
      label: 'unparseable-exit-code',
      explanation: `the verifier step recorded "${text}", which is not an exit code.`,
    };
  }

  const code = Number(text);
  switch (code) {
    case 0:
      return {
        decision: 'clean',
        code,
        label: 'clean',
        explanation: 'the committed lockfile still matches upstream.',
      };
    case 1:
      return {
        decision: 'drift',
        code,
        label: 'drift',
        explanation:
          'upstream moved, or a source disagrees at error severity. Regenerate and propose it.',
      };
    case 2:
      return {
        decision: 'fail',
        code,
        label: 'verifier-could-not-run',
        explanation:
          'the verifier could not do its job — network, rate limit, or an upstream payload whose ' +
          'shape changed. This is not upstream drift and must not be described as such.',
      };
    case 3:
      return {
        decision: 'fail',
        code,
        label: 'verifier-bug',
        explanation: 'an unexpected internal error in the verifier. This is our defect.',
      };
    default:
      return {
        decision: 'fail',
        code,
        label: 'unexpected-exit-code',
        explanation:
          `the verifier exited ${code}, which it never returns deliberately` +
          (SHELL_CODES.has(code) ? ` — ${SHELL_CODES.get(code) ?? ''}` : '') +
          '. Treating an unknown code as "nothing to do" is how a job that never ran goes green.',
      };
  }
}

// ---------------------------------------------------------------------------
// pull-request planning  (DEFECT 1)
// ---------------------------------------------------------------------------

export interface OpenPullRequest {
  number: number;
  headRefName: string;
  url: string;
  title?: string;
  body?: string;
}

export type PrOperation =
  | { kind: 'create' }
  | { kind: 'update'; number: number }
  | {
      kind: 'close';
      number: number;
      reason: 'resolved' | 'superseded';
      /**
       * Every open pull request here shares ONE head branch, so deleting it is
       * only safe on the very last close, and never while an `update` is keeping
       * a pull request alive on it. `gh pr close --delete-branch` on a
       * superseded duplicate would have pulled the branch out from under the
       * pull request this run had just updated.
       */
      deleteBranch: boolean;
    };

/**
 * Reduce whatever is open down to at most one pull request.
 *
 * GitHub will not normally allow two open PRs with the same head and base, so
 * the multi-PR branch looks unreachable — but it is reachable via a second PR
 * onto a different base, and via anything that changes the query. The plan is
 * written to be total over the input it is given rather than over the input it
 * expects, because "that cannot happen" is what produced the daily-duplicate bug
 * in the first place.
 */
export function planPullRequests(input: {
  drifted: boolean;
  branch: string;
  open: readonly OpenPullRequest[];
}): PrOperation[] {
  // Defensive: a mis-scoped `gh pr list` (a dropped --head, say) would otherwise
  // let this close or rewrite pull requests it has nothing to do with.
  const mine = input.open
    .filter((p) => p.headRefName === input.branch)
    .slice()
    .sort((a, b) => a.number - b.number);

  if (!input.drifted) {
    // Nothing is left pointing at the branch afterwards, so the last close
    // takes it with it. Tomorrow's drift rebuilds it from the base.
    return mine.map(
      (p, idx): PrOperation => ({
        kind: 'close',
        number: p.number,
        reason: 'resolved',
        deleteBranch: idx === mine.length - 1,
      }),
    );
  }

  const [keep, ...extra] = mine;
  if (keep === undefined) return [{ kind: 'create' }];

  return [
    { kind: 'update', number: keep.number },
    ...extra.map(
      (p): PrOperation => ({
        kind: 'close',
        number: p.number,
        reason: 'superseded',
        // Never: #keep is still open on this same branch.
        deleteBranch: false,
      }),
    ),
  ];
}

// ---------------------------------------------------------------------------
// the pull-request body
// ---------------------------------------------------------------------------

export interface BodyInput {
  branch: string;
  channels: { lts: string; preview: string; next: string | null };
  discrepancies: ReadonlyArray<{ severity: string; code: string; message: string }>;
  generatedAt: string;
  /** Raw verifier output. Truncated here, not by GitHub. */
  log: string;
  runUrl: string | null;
  /**
   * Read from a machine-readable artifact or omitted entirely. A hand-written
   * count in prose is wrong the day after it is written: the body of the pull
   * request that introduced the test runner claimed 589 tests, the run it
   * described executed 592, and the suite is at 1878 now.
   */
  testSummary: { tests: number; pass: number } | null;
}

/** GitHub caps a PR body at 65536 characters; leave room for everything else. */
const LOG_BUDGET = 20_000;

export function renderBody(i: BodyInput): string {
  const counts = new Map<string, number>();
  for (const d of i.discrepancies) counts.set(d.severity, (counts.get(d.severity) ?? 0) + 1);
  const errors = i.discrepancies.filter((d) => d.severity === 'error');

  const log =
    i.log.length <= LOG_BUDGET
      ? i.log
      : `…${i.log.length - LOG_BUDGET} characters trimmed…\n` + i.log.slice(-LOG_BUDGET);

  const out: string[] = [];
  const w = (s = ''): void => void out.push(s);

  w('Upstream moved. This pull request only updates the recorded truth; it does **not**');
  w('change which profile the site boots into.');
  w();
  w('| channel | tag |');
  w('| --- | --- |');
  w(`| LTS | \`${i.channels.lts}\` |`);
  w(`| preview | \`${i.channels.preview}\` |`);
  if (i.channels.next !== null) w(`| declared next | \`${i.channels.next}\` (not released) |`);
  w();
  w(
    `Recorded at \`${i.generatedAt}\`. Discrepancies: ` +
      `${counts.get('error') ?? 0} error, ${counts.get('warning') ?? 0} warning, ` +
      `${counts.get('info') ?? 0} info.`,
  );
  if (errors.length > 0) {
    w();
    w('**Error-severity discrepancies — read these before merging:**');
    w();
    for (const d of errors) w(`- \`${d.code}\` — ${d.message}`);
  }
  if (i.testSummary !== null) {
    w();
    w(
      `Test suite at the time of writing: ${i.testSummary.pass}/${i.testSummary.tests} passing ` +
        "(read from the runner's summary artifact, not typed in).",
    );
  }
  w();
  w('<details><summary>verifier output</summary>');
  w();
  w('```');
  w(log.trimEnd());
  w('```');
  w();
  w('</details>');
  w();
  w('Before merging: check that no discrepancy above is an `error`, and that any');
  w('behaviour change implied by a new release has a compatibility-profile entry and');
  w('a conformance fixture.');
  w();
  w('---');
  w();
  w(`This pull request is **updated in place**, from the workflow-owned branch \`${i.branch}\`.`);
  w('It is force-pushed from the base branch on every run, so the diff is always');
  w('"base → today\'s truth" and there is never more than one of these open. Do not');
  w('commit to that branch by hand: the workflow refuses to force-push over a commit');
  w('it did not author, which turns your work into a failed scheduled run.');
  w();
  // Verified against the live documentation on 2026-09-05, not from memory. The
  // previous wording ("PRs opened with GITHUB_TOKEN do not trigger on:
  // pull_request … close and reopen the PR to trigger the checks") described
  // behaviour GitHub changed in June 2026 and is now wrong in both halves.
  w('> **CI on this pull request starts in an approval-required state.** Since June 2026,');
  w('> a `pull_request` event *is* created for the `opened`, `synchronize` and `reopened`');
  w('> activity types when a workflow using `GITHUB_TOKEN` creates or updates a pull');
  w('> request — but GitHub holds those runs until a user with write access selects');
  w('> **Approve workflows to run** in the merge box. Until someone does, this pull');
  w('> request carries no CI signal. Approve the runs, or run `npm run verify` locally.');
  if (i.runUrl !== null) {
    w();
    w(`<sub>Opened by [this workflow run](${i.runUrl}).</sub>`);
  }
  w();
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// running things
// ---------------------------------------------------------------------------

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type Runner = (cmd: string, args: readonly string[], cwd?: string) => CommandResult;

export const realRunner: Runner = (cmd, args, cwd) => {
  const r = spawnSync(cmd, [...args], { cwd, encoding: 'utf8', shell: false });
  if (r.error !== undefined) {
    return { status: null, stdout: '', stderr: r.error.message };
  }
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

export class SyncFailure extends Error {}

function must(run: Runner, cmd: string, args: readonly string[], cwd?: string): string {
  const r = run(cmd, args, cwd);
  if (r.status !== 0) {
    throw new SyncFailure(
      `${cmd} ${args.join(' ')} failed (exit ${r.status ?? 'null'})\n${r.stderr || r.stdout}`.trim(),
    );
  }
  return r.stdout;
}

// ---------------------------------------------------------------------------
// publishing the workflow-owned branch
// ---------------------------------------------------------------------------

export interface PublishOptions {
  cwd: string;
  branch: string;
  paths: readonly string[];
  message: string;
  botName: string;
  botEmail: string;
  remote?: string;
  push?: boolean;
  run?: Runner;
}

export interface PublishResult {
  /** False when staging produced nothing — a discrepancy with no actual drift. */
  changed: boolean;
  sha: string | null;
  /** True when an existing remote branch was overwritten. */
  forced: boolean;
}

/**
 * Rebuild the workflow-owned branch at the current HEAD and publish it.
 *
 * Rebuilt, not extended. A branch that accumulates one commit per day makes the
 * pull request's diff grow without bound and its "files changed" stop meaning
 * "what merging this does". HEAD here is the base branch the workflow just
 * checked out, so the published branch is always exactly one commit ahead of it.
 *
 * The force-push is guarded by authorship rather than by --force-with-lease.
 * A lease compares against the remote-tracking ref, and this function has just
 * fetched that ref — so a human commit pushed an hour ago satisfies the lease
 * perfectly and gets destroyed. Asking who wrote the tip is the check that
 * actually answers the question the lease is reaching for.
 */
export function publishBranch(o: PublishOptions): PublishResult {
  const run = o.run ?? realRunner;
  const remote = o.remote ?? 'origin';
  const git = (...args: string[]): string => must(run, 'git', args, o.cwd);

  git('config', 'user.name', o.botName);
  git('config', 'user.email', o.botEmail);

  // Ask whether the branch exists BEFORE fetching, and treat the three answers
  // as three answers.
  //
  // The first version of this function fetched and then inferred existence from
  // whether the remote-tracking ref had appeared. That conflates "the branch is
  // not there" with "the fetch failed", and the two have opposite safe
  // behaviours: the first means push, the second means stop. A transient network
  // failure would have been read as "first run", skipping the authorship guard
  // below and force-pushing over whatever was actually there.
  //
  // `git ls-remote --exit-code` separates them: 0 found, 2 not found, anything
  // else is a real error.
  const probe = run('git', ['ls-remote', '--exit-code', '--heads', remote, o.branch], o.cwd);
  if (probe.status !== 0 && probe.status !== 2) {
    throw new SyncFailure(
      `could not ask ${remote} whether ${o.branch} exists (exit ${probe.status ?? 'null'}).\n` +
        `${(probe.stderr || probe.stdout).trim()}\n` +
        '  Refusing to force-push against an unknown remote state.',
    );
  }
  const remoteExists = probe.status === 0;

  const remoteRef = `refs/remotes/${remote}/${o.branch}`;
  if (remoteExists) {
    // Now the fetch MUST succeed: the branch is known to be there, so a failure
    // here is a failure, not an absence.
    must(run, 'git', ['fetch', '--no-tags', remote, `+refs/heads/${o.branch}:${remoteRef}`], o.cwd);
  }

  if (remoteExists) {
    const author = run('git', ['log', '-1', '--format=%ae', remoteRef], o.cwd).stdout.trim();
    if (author !== o.botEmail) {
      throw new SyncFailure(
        `${remote}/${o.branch} was last written by ${author || '(unknown)'}, not by this workflow ` +
          `(${o.botEmail}).\n` +
          '  This branch is rebuilt and force-pushed on every run, so pushing now would destroy ' +
          'that commit.\n' +
          '  Move the work to a branch of your own, then delete or reset ' +
          `${remote}/${o.branch}.`,
      );
    }
  }

  git('checkout', '-B', o.branch);
  git('add', '--', ...o.paths);

  if (run('git', ['diff', '--cached', '--quiet'], o.cwd).status === 0) {
    // Reachable and not an error: `truth:check` reports exit 1 for an
    // error-severity discrepancy as well as for drift, and a discrepancy alone
    // leaves the lockfile byte-identical. There is nothing to propose.
    return { changed: false, sha: null, forced: false };
  }

  git('commit', '-m', o.message);
  const sha = git('rev-parse', 'HEAD').trim();

  if (o.push !== false) {
    git('push', '--force', remote, `${o.branch}:refs/heads/${o.branch}`);
  }
  return { changed: true, sha, forced: remoteExists };
}

// ---------------------------------------------------------------------------
// reconciling the one pull request
// ---------------------------------------------------------------------------

/**
 * The repository setting this workflow cannot query and cannot work without.
 *
 * `GITHUB_TOKEN` has no `administration` permission and `permissions:` cannot
 * grant one, so there is no preflight available: the setting is only observable
 * by trying. What is available is refusing to fail obscurely — this maps the
 * API's message onto the exact switch a human has to flip.
 */
const PR_CREATION_FORBIDDEN = /not permitted to create or approve pull requests/i;

function prerequisiteMessage(repo: string): string {
  return (
    'GitHub Actions is not allowed to create pull requests in this repository, so this workflow ' +
    'cannot do the one thing it exists to do.\n' +
    `  Fix: https://github.com/${repo}/settings/actions → "Workflow permissions" →\n` +
    '       tick "Allow GitHub Actions to create and approve pull requests" → Save.\n' +
    '  New repositories in a personal account default to NOT allowing it; in an organization ' +
    'the repository setting is inherited from the organization and may have to be enabled there ' +
    'first.'
  );
}

export interface ReconcileOptions {
  repo: string;
  branch: string;
  base: string;
  drifted: boolean;
  title: string;
  body: string;
  label: string;
  /** The sha just published, used to respect a pull request a human closed. */
  headSha: string | null;
  run?: Runner;
  cwd?: string;
  log?: (line: string) => void;
}

export interface ReconcileResult {
  operations: PrOperation[];
  performed: string[];
}

export function reconcile(o: ReconcileOptions): ReconcileResult {
  const run = o.run ?? realRunner;
  const say = o.log ?? ((line: string): void => void process.stdout.write(line + '\n'));
  const performed: string[] = [];

  const gh = (...args: string[]): CommandResult => run('gh', args, o.cwd);

  const listed = gh(
    'pr', 'list',
    '--repo', o.repo,
    '--state', 'open',
    '--head', o.branch,
    '--base', o.base,
    '--limit', '100',
    '--json', 'number,headRefName,url,title,body',
  );
  if (listed.status !== 0) {
    // Fail closed. Treating "I could not ask" as "there is none" is precisely
    // how a duplicate pull request gets opened.
    throw new SyncFailure(
      `could not list open pull requests for ${o.branch} (exit ${listed.status ?? 'null'}).\n` +
        `${listed.stderr || listed.stdout}\n` +
        '  Refusing to continue: an unanswered query is not an empty answer, and acting on one ' +
        'is how a second pull request gets opened.',
    );
  }

  let open: OpenPullRequest[];
  try {
    open = JSON.parse(listed.stdout || '[]') as OpenPullRequest[];
  } catch (cause) {
    throw new SyncFailure(`gh returned output that is not JSON: ${(cause as Error).message}`);
  }

  const operations = planPullRequests({ drifted: o.drifted, branch: o.branch, open });
  const byNumber = new Map(open.map((p) => [p.number, p]));

  for (const op of operations) {
    switch (op.kind) {
      case 'create': {
        if (respectsClosedVeto(gh, o, say)) {
          say('  a human closed the pull request for exactly this head commit; not reopening it.');
          break;
        }
        // A missing label fails the create, so make sure it exists first. Its
        // absence is not itself a problem worth failing on.
        gh('label', 'create', o.label,
           '--repo', o.repo,
           '--description', 'Automated upstream release-truth sync',
           '--color', '0E8A16');

        const bodyFile = writeTemp(o.body);
        const created = gh(
          'pr', 'create',
          '--repo', o.repo,
          '--title', o.title,
          '--body-file', bodyFile,
          '--base', o.base,
          '--head', o.branch,
          '--label', o.label,
        );
        if (created.status !== 0) {
          const text = `${created.stderr}${created.stdout}`;
          if (PR_CREATION_FORBIDDEN.test(text)) {
            throw new SyncFailure(prerequisiteMessage(o.repo));
          }
          if (/pull request already exists/i.test(text)) {
            // Reachable if two runs ever get past the concurrency group — a
            // manually re-run job, say. GitHub refuses the second create, which
            // is the outcome to want: one pull request exists and the duplicate
            // did not happen. Say so instead of leaving a bare 422, and fail
            // anyway, because a create that did not create is not a success.
            throw new SyncFailure(
              'a pull request for this head already exists — two runs raced past the ' +
                'concurrency group.\n' +
                '  Nothing was duplicated: GitHub refused the second create. The next ' +
                'scheduled run will find that pull request and update it in place.\n' +
                `${text.trim()}`,
            );
          }
          throw new SyncFailure(
            `gh pr create failed (exit ${created.status ?? 'null'})\n${text.trim()}`,
          );
        }
        performed.push('create');
        say(`  opened ${created.stdout.trim()}`);
        break;
      }

      case 'update': {
        const current = byNumber.get(op.number);
        if (current?.title === o.title && current?.body === o.body) {
          say(`  #${op.number} already says exactly this; left alone.`);
          performed.push(`unchanged:${op.number}`);
          break;
        }
        const bodyFile = writeTemp(o.body);
        const edited = gh(
          'pr', 'edit', String(op.number),
          '--repo', o.repo,
          '--title', o.title,
          '--body-file', bodyFile,
        );
        if (edited.status !== 0) {
          throw new SyncFailure(
            `gh pr edit #${op.number} failed (exit ${edited.status ?? 'null'})\n` +
              `${edited.stderr || edited.stdout}`.trim(),
          );
        }
        performed.push(`update:${op.number}`);
        say(`  updated #${op.number} in place — no second pull request.`);
        break;
      }

      case 'close': {
        const why =
          op.reason === 'resolved'
            ? 'Upstream no longer differs from the committed lockfile — either this was merged, ' +
              'or upstream moved back, or the lockfile was regenerated another way. ' +
              'Closing so nothing stale accumulates. The scheduled run will open a new one if ' +
              'drift returns.'
            : 'Superseded: this branch now has one pull request that is updated in place. ' +
              'Closing the extra so there is never more than one.';
        const commented = gh('pr', 'comment', String(op.number), '--repo', o.repo, '--body', why);
        if (commented.status !== 0) {
          say(`  could not comment on #${op.number}; closing it anyway.`);
        }
        const closed = gh(
          'pr', 'close', String(op.number),
          '--repo', o.repo,
          ...(op.deleteBranch ? ['--delete-branch'] : []),
        );
        if (closed.status !== 0) {
          throw new SyncFailure(
            `gh pr close #${op.number} failed (exit ${closed.status ?? 'null'})\n` +
              `${closed.stderr || closed.stdout}`.trim(),
          );
        }
        performed.push(`close:${op.number}`);
        say(`  closed #${op.number} (${op.reason}).`);
        break;
      }
    }
  }

  if (operations.length === 0) say('  nothing open and nothing to propose.');
  return { operations, performed };
}

/**
 * Did a human already close a pull request for exactly this head commit?
 *
 * If so, reopening it every morning is nagging, not automation. A different
 * head sha means the proposal genuinely changed, and a new pull request is
 * right.
 */
function respectsClosedVeto(
  gh: (...args: string[]) => CommandResult,
  o: ReconcileOptions,
  say: (line: string) => void,
): boolean {
  if (o.headSha === null) return false;
  const closed = gh(
    'pr', 'list',
    '--repo', o.repo,
    '--state', 'closed',
    '--head', o.branch,
    '--limit', '20',
    '--json', 'number,headRefOid,state,url',
  );
  if (closed.status !== 0) {
    // Not fatal: the worst case is opening a pull request a human had closed,
    // which is visible and reversible. Silently NOT opening one would hide drift.
    say('  could not check for a previously closed pull request; proceeding.');
    return false;
  }
  try {
    const rows = JSON.parse(closed.stdout || '[]') as Array<{
      headRefOid?: string;
      state?: string;
      url?: string;
    }>;
    return rows.some((r) => r.state === 'CLOSED' && r.headRefOid === o.headSha);
  } catch {
    return false;
  }
}

function writeTemp(body: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'upstream-sync-')), 'body.md');
  writeFileSync(path, body, 'utf8');
  return path;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function arg(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3);
}

function required(argv: readonly string[], name: string): string {
  const v = arg(argv, name);
  if (v === undefined || v.startsWith('--')) {
    process.stderr.write(`\n  upstream-sync: --${name} is required\n\n`);
    process.exit(2);
  }
  return v;
}

function emit(key: string, value: string): void {
  const out = process.env['GITHUB_OUTPUT'];
  if (out !== undefined && out !== '') {
    // Multi-line-safe even though these values are single-line today; a value
    // that grows a newline would otherwise inject arbitrary workflow outputs.
    const eof = `EOF_${Math.random().toString(36).slice(2)}`;
    writeFileSync(out, `${key}<<${eof}\n${value}\n${eof}\n`, { flag: 'a' });
  }
  process.stdout.write(`  ${key}=${value}\n`);
}

function readJsonIf<T>(path: string | undefined): T | null {
  if (path === undefined || path === '' || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function cli(argv: string[]): void {
  const sub = argv[0];

  if (sub === 'decide') {
    const c = classifyExit(arg(argv, 'exit'));
    process.stdout.write(`  verifier exit ${c.code ?? '(none)'} → ${c.label}: ${c.explanation}\n`);
    emit('decision', c.decision);
    emit('label', c.label);
    if (c.decision === 'fail') {
      process.stdout.write(`::error::upstream-sync: ${c.label} — ${c.explanation}\n`);
      process.exit(1);
    }
    return;
  }

  if (sub === 'publish') {
    const paths = argv.filter((_a, i) => argv[i - 1] === '--path');
    if (paths.length === 0) {
      process.stderr.write('\n  upstream-sync: at least one --path is required\n\n');
      process.exit(2);
    }
    const result = publishBranch({
      cwd: arg(argv, 'cwd') ?? process.cwd(),
      branch: required(argv, 'branch'),
      paths,
      message: required(argv, 'message'),
      botName: arg(argv, 'bot-name') ?? 'github-actions[bot]',
      botEmail: arg(argv, 'bot-email') ?? '41898282+github-actions[bot]@users.noreply.github.com',
      push: !argv.includes('--no-push'),
    });
    emit('changed', String(result.changed));
    emit('sha', result.sha ?? '');
    return;
  }

  if (sub === 'reconcile') {
    const lockPath = required(argv, 'lock');
    const lock = readJsonIf<{
      channels: { lts: string; preview: string; next: string | null };
      discrepancies: Array<{ severity: string; code: string; message: string }>;
      generatedAt: string;
    }>(lockPath);
    if (lock === null) {
      process.stderr.write(`\n  upstream-sync: could not read the lockfile at ${lockPath}\n\n`);
      process.exit(2);
    }
    const logPath = arg(argv, 'log');
    const branch = required(argv, 'branch');
    const drifted = argv.includes('--drifted');

    const body = renderBody({
      branch,
      channels: lock.channels,
      discrepancies: lock.discrepancies,
      generatedAt: lock.generatedAt,
      log:
        logPath !== undefined && existsSync(logPath)
          ? readFileSync(logPath, 'utf8')
          : '(no verifier output was captured)',
      runUrl: arg(argv, 'run-url') ?? null,
      testSummary: readJsonIf<{ tests: number; pass: number }>(arg(argv, 'test-summary')),
    });

    const result = reconcile({
      repo: required(argv, 'repo'),
      branch,
      base: required(argv, 'base'),
      drifted,
      title: `Sync upstream release truth (${lock.channels.lts} / ${lock.channels.preview})`,
      body,
      label: arg(argv, 'label') ?? 'upstream-sync',
      headSha: arg(argv, 'head-sha') ?? null,
    });
    emit('operations', result.performed.join(',') || 'none');
    return;
  }

  process.stderr.write(
    `\n  upstream-sync: unknown subcommand ${sub === undefined ? '(none)' : `"${sub}"`}\n` +
      '  known: decide, publish, reconcile\n\n',
  );
  process.exit(2);
}

// Only run the CLI when invoked as a program. Importing this file for its
// exported decisions — which is what the tests do — must have no effect.
const invokedDirectly =
  process.argv[1] !== undefined &&
  /upstream-sync\.mts$/.test(process.argv[1].replace(/\\/g, '/'));

if (invokedDirectly) {
  try {
    cli(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`\n  upstream-sync: ${(err as Error).message}\n\n`);
    process.stdout.write(`::error::upstream-sync: ${(err as Error).message.split('\n')[0] ?? ''}\n`);
    process.exit(1);
  }
}
