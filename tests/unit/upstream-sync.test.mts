/**
 * Tests for the scheduled upstream-sync workflow's decisions.
 *
 * The whole reason this logic lives in a .mts file instead of in the workflow's
 * shell steps is that a workflow step can only be executed by running the
 * workflow — from the default branch, on a schedule, with `contents: write` and
 * `pull-requests: write`. That is the worst possible place to discover that a
 * branch of the logic was never right. Both defects these tests cover were found
 * by reading, not by running, because running was not available.
 *
 * `publishBranch` is tested against a REAL git repository with a real bare
 * remote, not a mocked runner. The behaviour under test is exactly the part a
 * mock would have to assume: what `git checkout -B`, `git diff --cached
 * --quiet` and a force-push actually do on the second run.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyExit,
  planPullRequests,
  renderBody,
  publishBranch,
  reconcile,
  SyncFailure,
  realRunner,
} from '../../tools/upstream-sync.mts';
import type { CommandResult, OpenPullRequest, Runner } from '../../tools/upstream-sync.mts';

const BOT = '41898282+github-actions[bot]@users.noreply.github.com';

// ---------------------------------------------------------------------------
// DEFECT 2 — fail-open on unexpected exit codes
// ---------------------------------------------------------------------------

describe('classifyExit', () => {
  it('maps the four documented codes to their documented meanings', () => {
    assert.equal(classifyExit('0').decision, 'clean');
    assert.equal(classifyExit('1').decision, 'drift');
    assert.equal(classifyExit('2').decision, 'fail');
    assert.equal(classifyExit('3').decision, 'fail');
  });

  it('never describes a tool error as upstream drift', () => {
    // The distinction the workflow's comment claims to preserve. A rate limit is
    // not "upstream moved", and a pull request headed "Upstream moved." that was
    // actually caused by a 403 is worse than no pull request.
    assert.match(classifyExit('2').explanation, /not upstream drift/i);
  });

  it('fails closed on the codes that used to go green', () => {
    // The old workflow failed only on '2' and '3'. Everything here fell through
    // the failure step, the regeneration step and the pull-request step, and the
    // job reported success.
    for (const code of ['4', '124', '126', '127', '137', '139', '143', '255']) {
      const c = classifyExit(code);
      assert.equal(c.decision, 'fail', `exit ${code} must fail closed`);
      assert.equal(c.label, 'unexpected-exit-code');
    }
  });

  it('names the shell codes an operator would otherwise have to look up', () => {
    assert.match(classifyExit('127').explanation, /command not found/i);
    assert.match(classifyExit('137').explanation, /OOM/i);
    assert.match(classifyExit('126').explanation, /not executable/i);
  });

  it('fails closed when the step recorded no exit code at all', () => {
    // A cancelled step leaves the output empty. `'' == '2' || '' == '3'` is
    // false, so the old workflow carried on as though the verifier said clean.
    for (const missing of ['', '   ', undefined, null]) {
      const c = classifyExit(missing);
      assert.equal(c.decision, 'fail');
      assert.equal(c.label, 'missing-exit-code');
    }
  });

  it('fails closed on something that is not a number', () => {
    const c = classifyExit('exit=1');
    assert.equal(c.decision, 'fail');
    assert.equal(c.label, 'unparseable-exit-code');
  });

  it('accepts a number as readily as a string, since $? arrives as both', () => {
    assert.equal(classifyExit(1).decision, 'drift');
    assert.equal(classifyExit(137).decision, 'fail');
  });
});

// ---------------------------------------------------------------------------
// DEFECT 1 — a new pull request every day
// ---------------------------------------------------------------------------

const BRANCH = 'automation/upstream-release-truth';

function pr(number: number, headRefName = BRANCH): OpenPullRequest {
  return { number, headRefName, url: `https://example.invalid/pull/${number}` };
}

describe('planPullRequests', () => {
  it('creates one when drift is new and nothing is open', () => {
    assert.deepEqual(planPullRequests({ drifted: true, branch: BRANCH, open: [] }), [
      { kind: 'create' },
    ]);
  });

  it('UPDATES the existing one on the second day instead of opening a second', () => {
    // This is the defect. With the old date+run_id branch name, day two produced
    // a branch nothing had seen and a pull request nobody had asked for.
    assert.deepEqual(planPullRequests({ drifted: true, branch: BRANCH, open: [pr(7)] }), [
      { kind: 'update', number: 7 },
    ]);
  });

  it('is idempotent across a hundred runs — the count of open PRs stays one', () => {
    let open = [pr(7)];
    for (let day = 0; day < 100; day++) {
      const ops = planPullRequests({ drifted: true, branch: BRANCH, open });
      assert.deepEqual(ops, [{ kind: 'update', number: 7 }]);
      open = open.filter((p) => !ops.some((o) => o.kind === 'close' && o.number === p.number));
    }
    assert.equal(open.length, 1);
  });

  it('closes everything it finds when the drift is gone', () => {
    assert.deepEqual(planPullRequests({ drifted: false, branch: BRANCH, open: [pr(7)] }), [
      { kind: 'close', number: 7, reason: 'resolved', deleteBranch: true },
    ]);
  });

  it('does nothing at all when there is no drift and nothing open', () => {
    assert.deepEqual(planPullRequests({ drifted: false, branch: BRANCH, open: [] }), []);
  });

  it('collapses an accumulated pile down to one, keeping the oldest', () => {
    const ops = planPullRequests({ drifted: true, branch: BRANCH, open: [pr(9), pr(7), pr(8)] });
    assert.deepEqual(ops, [
      { kind: 'update', number: 7 },
      { kind: 'close', number: 8, reason: 'superseded', deleteBranch: false },
      { kind: 'close', number: 9, reason: 'superseded', deleteBranch: false },
    ]);
  });

  it('never deletes the head branch while a pull request is still open on it', () => {
    // Every open pull request here shares ONE branch. `gh pr close
    // --delete-branch` on a superseded duplicate would delete the branch that
    // the pull request this same run had just updated is built on.
    const ops = planPullRequests({ drifted: true, branch: BRANCH, open: [pr(7), pr(8)] });
    assert.ok(ops.every((o) => o.kind !== 'close' || !o.deleteBranch));
  });

  it('deletes the shared branch exactly once, on the final close', () => {
    const ops = planPullRequests({ drifted: false, branch: BRANCH, open: [pr(7), pr(8), pr(9)] });
    const deleting = ops.filter((o) => o.kind === 'close' && o.deleteBranch);
    assert.equal(deleting.length, 1);
    assert.deepEqual(deleting[0], {
      kind: 'close',
      number: 9,
      reason: 'resolved',
      deleteBranch: true,
    });
  });

  it('ignores pull requests from any other head, whatever the query returned', () => {
    // A dropped --head would otherwise let this close unrelated work.
    const ops = planPullRequests({
      drifted: false,
      branch: BRANCH,
      open: [pr(4, 'feat/someone-elses-branch'), pr(5)],
    });
    assert.deepEqual(ops, [
      { kind: 'close', number: 5, reason: 'resolved', deleteBranch: true },
    ]);
  });
});

// ---------------------------------------------------------------------------
// the pull-request body
// ---------------------------------------------------------------------------

const BODY_INPUT = {
  branch: BRANCH,
  channels: { lts: 'v7.6.5', preview: 'v7.7.0-preview.4', next: 'v7.7.0-preview.5' },
  discrepancies: [
    { severity: 'warning', code: 'docs-axis-confusion', message: 'the docs name the SDK' },
    { severity: 'error', code: 'tag-moved', message: 'v7.6.5 points at a different commit' },
  ],
  generatedAt: '2026-09-05T06:15:00.000Z',
  log: 'verifier said things',
  runUrl: null,
  testSummary: null,
};

describe('renderBody', () => {
  it('states the CURRENT GitHub behaviour for a GITHUB_TOKEN-authored pull request', () => {
    // Verified against docs.github.com on 2026-09-05. The previous body said
    // "Pull requests opened with GITHUB_TOKEN do not trigger on: pull_request,
    // so this one arrives with no CI signal … close and reopen the PR to trigger
    // the checks." GitHub changed that in June 2026: the runs ARE created, for
    // opened/synchronize/reopened, in an approval-required state.
    const body = renderBody(BODY_INPUT);
    assert.match(body, /approval-required/i);
    assert.match(body, /Approve workflows to run/);
    assert.doesNotMatch(body, /do not trigger/i);
    assert.doesNotMatch(body, /close and reopen/i);
  });

  it('counts discrepancies instead of asserting a number someone typed', () => {
    const body = renderBody(BODY_INPUT);
    assert.match(body, /1 error, 1 warning, 0 info/);
    assert.match(body, /`tag-moved`/);
  });

  it('omits the test count entirely when there is no machine-readable summary', () => {
    // A hand-written count is wrong the day after it is written. Either it comes
    // from the runner's artifact or it is not stated at all.
    assert.doesNotMatch(renderBody(BODY_INPUT), /passing/);
    const withSummary = renderBody({ ...BODY_INPUT, testSummary: { tests: 1878, pass: 1878 } });
    assert.match(withSummary, /1878\/1878 passing/);
  });

  it('explains that the branch is workflow-owned and force-pushed', () => {
    assert.match(renderBody(BODY_INPUT), /updated in place/);
    assert.match(renderBody(BODY_INPUT), new RegExp(BRANCH.replace('/', '\\/')));
  });

  it('trims a runaway verifier log rather than letting GitHub reject the body', () => {
    const body = renderBody({ ...BODY_INPUT, log: 'x'.repeat(200_000) });
    assert.ok(body.length < 65_536, `body was ${body.length} characters`);
    assert.match(body, /characters trimmed/);
  });
});

// ---------------------------------------------------------------------------
// publishBranch — against a real repository
// ---------------------------------------------------------------------------

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}\n${r.stderr}`);
  return r.stdout;
}

/** A work repo with a bare `origin`, one commit on `main`, nothing else. */
function scratchRepo(): { work: string; origin: string } {
  const root = mkdtempSync(join(tmpdir(), 'upstream-sync-repo-'));
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  mkdirSync(origin);
  mkdirSync(work);
  git(origin, 'init', '--bare', '--initial-branch=main');
  git(work, 'init', '--initial-branch=main');
  git(work, 'config', 'user.name', 'seed');
  git(work, 'config', 'user.email', 'seed@example.invalid');
  git(work, 'remote', 'add', 'origin', origin);
  writeFileSync(join(work, 'lock.json'), '{"n":0}\n', 'utf8');
  git(work, 'add', 'lock.json');
  git(work, 'commit', '-m', 'seed');
  git(work, 'push', 'origin', 'main');
  return { work, origin };
}

const publishOpts = (work: string, message: string) => ({
  cwd: work,
  branch: BRANCH,
  paths: ['lock.json'],
  message,
  botName: 'github-actions[bot]',
  botEmail: BOT,
});

describe('publishBranch', () => {
  it('reports no change when staging produced nothing', () => {
    // truth:check exits 1 for an error-severity discrepancy as well as for
    // drift, and a discrepancy alone leaves the lockfile byte-identical. The old
    // workflow's `git diff --quiet` guard existed for this; losing it would open
    // a pull request headed "Upstream moved." describing no movement.
    const { work } = scratchRepo();
    const r = publishBranch(publishOpts(work, 'no-op'));
    assert.equal(r.changed, false);
    assert.equal(r.sha, null);
  });

  it('publishes the branch on the first run', () => {
    const { work, origin } = scratchRepo();
    writeFileSync(join(work, 'lock.json'), '{"n":1}\n', 'utf8');
    const r = publishBranch(publishOpts(work, 'sync 1'));
    assert.equal(r.changed, true);
    assert.equal(r.forced, false);
    assert.equal(git(origin, 'rev-parse', BRANCH).trim(), r.sha);
  });

  it('rebuilds from the base on the second run — one commit ahead, never two', () => {
    // The branch must not accumulate a commit per day: the diff would grow
    // without bound and "files changed" would stop meaning "what merging does".
    const { work, origin } = scratchRepo();
    writeFileSync(join(work, 'lock.json'), '{"n":1}\n', 'utf8');
    publishBranch(publishOpts(work, 'sync 1'));

    git(work, 'checkout', 'main');
    writeFileSync(join(work, 'lock.json'), '{"n":2}\n', 'utf8');
    const second = publishBranch(publishOpts(work, 'sync 2'));

    assert.equal(second.forced, true);
    const ahead = git(origin, 'rev-list', '--count', `main..${BRANCH}`).trim();
    assert.equal(ahead, '1');
    assert.equal(git(origin, 'rev-parse', BRANCH).trim(), second.sha);
  });

  it('refuses to push when it cannot tell whether the remote branch exists', () => {
    // The hole this closes: the first version inferred "the branch does not
    // exist" from a failed fetch, which is also what a network blip looks like.
    // Reading a transient failure as "first run" skips the authorship guard and
    // force-pushes over whatever is really there.
    const { work } = scratchRepo();
    writeFileSync(join(work, 'lock.json'), '{"n":9}\n', 'utf8');
    const pushed: string[][] = [];
    const runner: Runner = (cmd, args, cwd) => {
      if (args[0] === 'ls-remote') return { status: 128, stdout: '', stderr: 'could not read from remote' };
      if (args[0] === 'push') pushed.push([...args]);
      const r = spawnSync(cmd, [...args], { cwd, encoding: 'utf8' });
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };
    assert.throws(
      () => publishBranch({ ...publishOpts(work, 'sync 9'), run: runner }),
      (e: unknown) =>
        e instanceof SyncFailure && /unknown remote state/.test((e as Error).message),
    );
    assert.deepEqual(pushed, [], 'nothing may be pushed when the remote state is unknown');
  });

  it('refuses to force-push over a commit it did not author', () => {
    // --force-with-lease cannot catch this: publishBranch fetches the remote ref
    // immediately beforehand, so a human commit pushed an hour ago satisfies the
    // lease and is destroyed. Authorship is the question the lease is reaching
    // for, so ask it directly.
    const { work } = scratchRepo();
    git(work, 'checkout', '-B', BRANCH);
    writeFileSync(join(work, 'lock.json'), '{"human":true}\n', 'utf8');
    git(work, 'add', 'lock.json');
    git(work, 'commit', '-m', 'a human was here');
    git(work, 'push', 'origin', BRANCH);
    git(work, 'checkout', 'main');

    writeFileSync(join(work, 'lock.json'), '{"n":3}\n', 'utf8');
    assert.throws(
      () => publishBranch(publishOpts(work, 'sync 3')),
      (e: unknown) =>
        e instanceof SyncFailure && /not by this workflow/.test((e as Error).message),
    );
  });
});

// ---------------------------------------------------------------------------
// reconcile — with a fake gh
// ---------------------------------------------------------------------------

interface FakeGh {
  runner: Runner;
  calls: string[][];
}

function fakeGh(replies: Record<string, CommandResult>): FakeGh {
  const calls: string[][] = [];
  const runner: Runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = `${cmd} ${args[0] ?? ''} ${args[1] ?? ''}`.trim();
    return replies[key] ?? { status: 0, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

const reconcileOpts = {
  repo: 'owner/repo',
  branch: BRANCH,
  base: 'main',
  title: 'Sync upstream release truth',
  body: 'body',
  label: 'upstream-sync',
  headSha: null,
  log: (): void => {},
};

const listed = (rows: unknown): CommandResult => ({
  status: 0,
  stdout: JSON.stringify(rows),
  stderr: '',
});

describe('reconcile', () => {
  it('creates when nothing is open', () => {
    const gh = fakeGh({ 'gh pr list': listed([]) });
    const r = reconcile({ ...reconcileOpts, drifted: true, run: gh.runner });
    assert.deepEqual(r.performed, ['create']);
    assert.ok(gh.calls.some((c) => c[1] === 'pr' && c[2] === 'create'));
  });

  it('edits, and never creates, when one is already open', () => {
    const gh = fakeGh({ 'gh pr list': listed([{ number: 7, headRefName: BRANCH, url: 'u' }]) });
    const r = reconcile({ ...reconcileOpts, drifted: true, run: gh.runner });
    assert.deepEqual(r.performed, ['update:7']);
    assert.ok(!gh.calls.some((c) => c[2] === 'create'));
  });

  it('does not even edit when the open pull request already says exactly this', () => {
    const gh = fakeGh({
      'gh pr list': listed([
        { number: 7, headRefName: BRANCH, url: 'u', title: reconcileOpts.title, body: 'body' },
      ]),
    });
    const r = reconcile({ ...reconcileOpts, drifted: true, run: gh.runner });
    assert.deepEqual(r.performed, ['unchanged:7']);
    assert.ok(!gh.calls.some((c) => c[2] === 'edit'));
  });

  it('comments and closes when the drift is gone', () => {
    const gh = fakeGh({ 'gh pr list': listed([{ number: 7, headRefName: BRANCH, url: 'u' }]) });
    const r = reconcile({ ...reconcileOpts, drifted: false, run: gh.runner });
    assert.deepEqual(r.performed, ['close:7']);
    assert.ok(gh.calls.some((c) => c[2] === 'comment'));
    assert.ok(gh.calls.some((c) => c[2] === 'close'));
  });

  it('fails closed when the pull-request query fails, instead of creating a duplicate', () => {
    // A rate-limited `gh pr list` returning non-zero must not be read as "there
    // is no open pull request". That is exactly how the second one gets opened.
    const gh = fakeGh({
      'gh pr list': { status: 1, stdout: '', stderr: 'HTTP 403: API rate limit exceeded' },
    });
    assert.throws(
      () => reconcile({ ...reconcileOpts, drifted: true, run: gh.runner }),
      (e: unknown) =>
        e instanceof SyncFailure && /an unanswered query is not an empty answer/.test(
          (e as Error).message,
        ),
    );
    assert.ok(!gh.calls.some((c) => c[2] === 'create'));
  });

  it('fails closed when gh returns something that is not JSON', () => {
    const gh = fakeGh({ 'gh pr list': { status: 0, stdout: 'gh: not logged in', stderr: '' } });
    assert.throws(
      () => reconcile({ ...reconcileOpts, drifted: true, run: gh.runner }),
      SyncFailure,
    );
  });

  it('names the exact repository setting when Actions may not create pull requests', () => {
    // The prerequisite cannot be queried: GITHUB_TOKEN has no `administration`
    // permission and `permissions:` cannot grant one. So the only honest option
    // is to fail with the switch a human has to flip, rather than with a 403.
    const gh = fakeGh({
      'gh pr list': listed([]),
      'gh pr create': {
        status: 1,
        stdout: '',
        stderr: 'pull request create failed: GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)',
      },
    });
    assert.throws(
      () => reconcile({ ...reconcileOpts, drifted: true, run: gh.runner }),
      (e: unknown) => {
        const m = (e as Error).message;
        return (
          e instanceof SyncFailure &&
          /Allow GitHub Actions to create and approve pull requests/.test(m) &&
          /settings\/actions/.test(m)
        );
      },
    );
  });

  it('says what happened when two runs race past the concurrency group', () => {
    const gh = fakeGh({
      'gh pr list': listed([]),
      'gh pr create': {
        status: 1,
        stdout: '',
        stderr: 'pull request create failed: GraphQL: A pull request already exists for owner:automation/upstream-release-truth.',
      },
    });
    assert.throws(
      () => reconcile({ ...reconcileOpts, drifted: true, run: gh.runner }),
      (e: unknown) =>
        e instanceof SyncFailure && /Nothing was duplicated/.test((e as Error).message),
    );
  });

  it('does not reopen a pull request a human closed for exactly this commit', () => {
    const gh = fakeGh({
      'gh pr list': listed([]),
    });
    // The second `gh pr list` (state closed) needs a different reply than the
    // first, so drive it by call order.
    let call = 0;
    const runner: Runner = (cmd, args) => {
      gh.calls.push([cmd, ...args]);
      if (args[0] === 'pr' && args[1] === 'list') {
        call++;
        return call === 1
          ? listed([])
          : listed([{ number: 4, headRefOid: 'deadbeef', state: 'CLOSED', url: 'u' }]);
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const r = reconcile({ ...reconcileOpts, drifted: true, headSha: 'deadbeef', run: runner });
    assert.deepEqual(r.performed, []);
    assert.ok(!gh.calls.some((c) => c[2] === 'create'));
  });

  it('does open a new one when the proposal changed since the human closed it', () => {
    let call = 0;
    const calls: string[][] = [];
    const runner: Runner = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === 'pr' && args[1] === 'list') {
        call++;
        return call === 1
          ? listed([])
          : listed([{ number: 4, headRefOid: 'oldsha', state: 'CLOSED', url: 'u' }]);
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const r = reconcile({ ...reconcileOpts, drifted: true, headSha: 'newsha', run: runner });
    assert.deepEqual(r.performed, ['create']);
  });
});

describe('the same proposal is published once, not once a day', () => {
  it('keeps the existing head when the tree has not changed', () => {
    // The staged diff answers "does this differ from MAIN", which stays true
    // for as long as main has not accepted the proposal. It says nothing about
    // whether the branch already carries this content. A commit object embeds
    // author and committer dates, so an identical tree on an identical parent
    // still produces a different sha — so the old code committed and
    // force-pushed on every run, for ever, for a proposal nobody had changed.
    const { work, origin } = scratchRepo();
    writeFileSync(join(work, 'lock.json'), '{"n":1}\n', 'utf8');

    const first = publishBranch(publishOpts(work, 'sync 1'));
    assert.equal(first.changed, true);
    assert.equal(first.alreadyProposed, false);
    const publishedSha = git(origin, 'rev-parse', BRANCH).trim();
    assert.equal(publishedSha, first.sha);

    // A second run, same drift, same content. Nothing about the proposal moved.
    //
    // Back to main first, because that is what the workflow does: every run is
    // a fresh checkout of the base branch. Reusing the tree the previous run
    // left behind is what a developer does, not what CI does — and it hides the
    // defect entirely, because `checkout -B` would reset the branch to ITSELF
    // and the staged diff would come back empty for the wrong reason.
    git(work, 'checkout', 'main');
    writeFileSync(join(work, 'lock.json'), '{"n":1}\n', 'utf8');
    const second = publishBranch(publishOpts(work, 'sync 1 again'));
    assert.equal(second.alreadyProposed, true, 'recognised as already published');
    assert.equal(second.forced, false, 'and therefore nothing was force-pushed');
    assert.equal(
      git(origin, 'rev-parse', BRANCH).trim(),
      publishedSha,
      'the remote head is untouched, so no synchronize event and no new approval-required run',
    );
    assert.equal(second.sha, publishedSha, 'and it reports the head that stands');
  });

  it('still publishes when the proposal itself changes', () => {
    // The counterpart: idempotence must not become inertness.
    const { work, origin } = scratchRepo();
    writeFileSync(join(work, 'lock.json'), '{"n":1}\n', 'utf8');
    const first = publishBranch(publishOpts(work, 'sync 1'));

    git(work, 'checkout', 'main');
    writeFileSync(join(work, 'lock.json'), '{"n":2}\n', 'utf8');
    const second = publishBranch(publishOpts(work, 'sync 2'));

    assert.equal(second.alreadyProposed, false);
    assert.equal(second.changed, true);
    assert.notEqual(second.sha, first.sha);
    assert.equal(git(origin, 'rev-parse', BRANCH).trim(), second.sha);
    // Still exactly one commit ahead of main, not two.
    assert.equal(git(work, 'rev-list', '--count', `main..${BRANCH}`).trim(), '1');
  });
});

describe('the branch is updated by compare-and-swap, not by blind force', () => {
  it('sends a lease naming the sha it fetched', () => {
    // The author check is a check, not a lock: it runs before the push and
    // nothing stops the branch moving in between. The lease makes the update
    // conditional on the remote still being exactly what was fetched.
    const { work } = scratchRepo();
    writeFileSync(join(work, 'lock.json'), '{"n":1}\n', 'utf8');
    const first = publishBranch(publishOpts(work, 'sync 1'));

    const pushes: string[][] = [];
    git(work, 'checkout', 'main');
    writeFileSync(join(work, 'lock.json'), '{"n":2}\n', 'utf8');
    publishBranch({
      ...publishOpts(work, 'sync 2'),
      run: (cmd, args, cwd) => {
        if (cmd === 'git' && args[0] === 'push') pushes.push([...args]);
        return realRunner(cmd, args, cwd);
      },
    });

    assert.equal(pushes.length, 1, 'exactly one push');
    const lease = pushes[0]?.find((a) => a.startsWith('--force-with-lease='));
    assert.ok(lease !== undefined, `expected a lease, got: ${JSON.stringify(pushes[0])}`);
    assert.equal(
      lease,
      `--force-with-lease=refs/heads/${BRANCH}:${String(first.sha)}`,
      'the lease names the sha that was fetched, so a branch that moved is refused',
    );
    assert.ok(!pushes[0]?.includes('--force'), 'and never a bare --force');
  });

  it('requires the branch not to exist when creating it', () => {
    // An empty expected value is the correct assertion for the create case:
    // "this branch is not there". A bare force would happily overwrite one that
    // appeared between the existence probe and the push.
    const { work } = scratchRepo();
    writeFileSync(join(work, 'lock.json'), '{"n":1}\n', 'utf8');

    const pushes: string[][] = [];
    publishBranch({
      ...publishOpts(work, 'sync 1'),
      run: (cmd, args, cwd) => {
        if (cmd === 'git' && args[0] === 'push') pushes.push([...args]);
        return realRunner(cmd, args, cwd);
      },
    });

    assert.equal(
      pushes[0]?.find((a) => a.startsWith('--force-with-lease=')),
      `--force-with-lease=refs/heads/${BRANCH}:`,
    );
  });
});
