/**
 * Tests for the process model: pid allocation, the table, and jobs.
 *
 * The pid tests are the load-bearing ones. Pid identity is a kernel invariant,
 * and the reason it is asserted rather than assumed is recorded at the
 * allocator: PowerShell 7.7 changes `New-Guid` to emit UUIDv7 instead of
 * UUIDv4, so an identifier taken from a guid generator would change shape with
 * the compatibility profile. These tests pin the properties a counter has and a
 * guid does not — integral, ordered, and ordered WITHOUT reference to a clock.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ProcessTable } from '../../src/kernel/process/table.ts';
import type { ProcessSpec } from '../../src/kernel/process/table.ts';
import { isFailure, isTerminated, PROCESS_STATES } from '../../src/kernel/process/snapshot.ts';
import type { ProcessSnapshot } from '../../src/kernel/process/snapshot.ts';
import {
  JOB_ERROR_LIMIT,
  JOB_VALUE_LIMIT,
  JobManager,
  isJobFinished,
} from '../../src/kernel/process/jobs.ts';
import { KERNEL_PID } from '../../src/kernel/ids.ts';
import { errorRecord } from '../../src/pipeline/streams.ts';

function spec(overrides: Partial<ProcessSpec> = {}): ProcessSpec {
  return {
    name: 'Get-ChildItem',
    commandLine: 'gci /home',
    cwd: '/home/visitor',
    runtime: 'semantic',
    terminalId: 'term-1',
    requestId: 'req-1',
    background: false,
    ...overrides,
  };
}

describe('pid allocation', () => {
  it('hands out monotonically increasing integers starting at 1', () => {
    const table = new ProcessTable(() => 1_000);
    const pids = [table.create(spec()).pid, table.create(spec()).pid, table.create(spec()).pid];

    assert.deepEqual(pids, [1, 2, 3]);
    for (const pid of pids) assert.equal(Number.isInteger(pid), true);
    // 0 is the kernel. A falsy pid would make `if (pid)` a wrong liveness check.
    assert.equal(pids.includes(KERNEL_PID), false);
  });

  it('orders pids without consulting a clock', () => {
    // The property a UUIDv4 does not have and a UUIDv7 has only because it
    // embeds a timestamp. A counter has it unconditionally, which is why the
    // kernel does not inherit `New-Guid`'s version-dependent default: freeze
    // time completely and the ordering still holds.
    const frozen = new ProcessTable(() => 0);
    const a = frozen.create(spec());
    const b = frozen.create(spec());

    assert.equal(a.startedAt, b.startedAt);
    assert.equal(a.pid < b.pid, true);
    assert.deepEqual(
      frozen.list().map((p) => p.pid),
      [a.pid, b.pid],
    );
  });

  it('never reuses a pid, even after the process is reaped', () => {
    // Reuse is the classic "signal delivered to the wrong process" bug: a UI
    // holding a stale pid must get "no such process", not somebody else's
    // pipeline.
    const table = new ProcessTable(() => 5);
    const first = table.create(spec());
    table.exit(first.pid, 0);
    assert.equal(table.reap(first.pid), true);
    assert.equal(table.get(first.pid), undefined);

    const second = table.create(spec());
    assert.equal(second.pid, first.pid + 1);
  });

  it('refuses to reap a process that is still running', () => {
    const table = new ProcessTable(() => 5);
    const live = table.create(spec());
    assert.equal(table.reap(live.pid), false);
    assert.notEqual(table.get(live.pid), undefined);
  });

  it('makes a lone process its own group leader and the kernel its parent', () => {
    const table = new ProcessTable(() => 5);
    const process = table.create(spec());
    assert.equal(process.pgid, process.pid);
    assert.equal(process.ppid, KERNEL_PID);
  });

  it('lets a pipeline share one group', () => {
    const table = new ProcessTable(() => 5);
    const leader = table.create(spec({ name: 'Get-Content' }));
    const second = table.create(spec({ name: 'Select-String', pgid: leader.pid, ppid: leader.pid }));
    const third = table.create(spec({ name: 'Select-Object', pgid: leader.pid, ppid: leader.pid }));

    assert.deepEqual(
      [leader.pgid, second.pgid, third.pgid],
      [leader.pid, leader.pid, leader.pid],
    );
    assert.deepEqual(
      table.membersOf(leader.pid).map((p) => p.pid),
      [leader.pid, second.pid, third.pid],
    );
  });
});

describe('process state', () => {
  it('reports every change to a listener', () => {
    const table = new ProcessTable(() => 7);
    const seen: string[] = [];
    table.onChange((s) => seen.push(s.state));

    const process = table.create(spec());
    table.transition(process.pid, 'running');
    table.exit(process.pid, 0);

    assert.deepEqual(seen, ['created', 'running', 'exited']);
  });

  it('starts as `created`, which is already signallable', () => {
    // The window between being allocated a pid and the first await is exactly
    // where a fast Ctrl+C lands, so it needs a state of its own rather than
    // being indistinguishable from "not yet a process".
    const table = new ProcessTable(() => 7);
    const process = table.create(spec());
    assert.equal(process.state, 'created');
    assert.equal(PROCESS_STATES.includes(process.state), true);
  });

  it('will not move a process out of `exited`', () => {
    const table = new ProcessTable(() => 7);
    const process = table.create(spec());
    table.exit(process.pid, 3);
    table.transition(process.pid, 'running');

    const after = table.get(process.pid) as ProcessSnapshot;
    assert.equal(after.state, 'exited');
    assert.equal(after.exitCode, 3);
  });

  it('keeps the FIRST exit code, because a kill happens before the unwind', () => {
    const table = new ProcessTable(() => 7);
    const process = table.create(spec());
    table.exit(process.pid, 137, 'SIGKILL');
    // The abandoned invocation settles later and tries to report its own code.
    table.exit(process.pid, 0);

    const after = table.get(process.pid) as ProcessSnapshot;
    assert.equal(after.exitCode, 137);
    assert.equal(after.signalled, 'SIGKILL');
  });

  it('does not call a signalled process a failure', () => {
    // PowerShell separates "the pipeline was stopped" from "the command
    // errored". Collapsing them would set `$?` to False on every Ctrl+C.
    const table = new ProcessTable(() => 7);
    const stopped = table.exit(table.create(spec()).pid, 130, 'SIGINT') as ProcessSnapshot;
    const broken = table.exit(table.create(spec()).pid, 1, null) as ProcessSnapshot;

    assert.equal(isTerminated(stopped), true);
    assert.equal(isFailure(stopped), false);
    assert.equal(isFailure(broken), true);
  });

  it('produces frozen snapshots, so a listener cannot corrupt the table', () => {
    const table = new ProcessTable(() => 7);
    const process = table.create(spec());
    assert.equal(Object.isFrozen(process), true);
  });
});

describe('jobs', () => {
  it('numbers jobs in their own space, not the pid space', () => {
    // `Stop-Job 3` must mean job 3. Sharing a counter with the process table
    // would let it stop an unrelated foreground pipeline that got pid 3.
    const table = new ProcessTable(() => 1);
    const jobs = new JobManager(() => 1);
    for (let i = 0; i < 5; i += 1) table.create(spec());

    const process = table.create(spec({ background: true }));
    const job = jobs.start(process.pid, 'Start-Sleep 60');

    assert.equal(process.pid, 6);
    assert.equal(job.id, 1);
    assert.equal(job.name, 'Job1');
    assert.equal(job.pid, process.pid);
  });

  it('buffers output so Receive-Job has something to return', () => {
    const jobs = new JobManager(() => 1);
    const job = jobs.start(50, 'gci');
    assert.equal(job.hasMoreData, false);

    jobs.record(50, 'alpha');
    jobs.record(50, 'beta');
    jobs.recordError(50, errorRecord('nope', 'Boom', 'gci'));
    assert.equal((jobs.get(job.id) as { hasMoreData: boolean }).hasMoreData, true);

    const received = jobs.receive(job.id);
    assert.deepEqual(received.values, ['alpha', 'beta']);
    assert.equal(received.errors.length, 1);
    assert.equal(received.errors[0]?.fullyQualifiedErrorId, 'Boom,gci');

    // Destructive by default, exactly as `Receive-Job` is.
    assert.deepEqual(jobs.receive(job.id).values, []);
    assert.equal((jobs.get(job.id) as { hasMoreData: boolean }).hasMoreData, false);
  });

  it('keeps the buffer for Receive-Job -Keep', () => {
    const jobs = new JobManager(() => 1);
    const job = jobs.start(50, 'gci');
    jobs.record(50, 'alpha');

    assert.deepEqual(jobs.receive(job.id, true).values, ['alpha']);
    assert.deepEqual(jobs.receive(job.id, true).values, ['alpha']);
  });

  it('calls a stopped job Stopped and a broken one Failed', () => {
    const jobs = new JobManager(() => 1);
    const stopped = jobs.start(1, 'a');
    const failed = jobs.start(2, 'b');
    const done = jobs.start(3, 'c');

    jobs.finish(1, 130, true);
    jobs.finish(2, 1, false);
    jobs.finish(3, 0, false);

    assert.equal(jobs.get(stopped.id)?.state, 'Stopped');
    assert.equal(jobs.get(failed.id)?.state, 'Failed');
    assert.equal(jobs.get(done.id)?.state, 'Completed');
    for (const state of ['Stopped', 'Failed', 'Completed'] as const) {
      assert.equal(isJobFinished(state), true);
    }
    assert.equal(isJobFinished('Running'), false);
  });

  it('will not remove a running job without -Force', () => {
    const jobs = new JobManager(() => 1);
    const job = jobs.start(1, 'a');
    jobs.record(1, 'unreceived');

    assert.equal(jobs.remove(job.id), false);
    assert.equal(jobs.remove(job.id, true), true);
    assert.equal(jobs.get(job.id), undefined);
  });

  it('mints no GUID for a job, for the same reason pids are not GUIDs', () => {
    // PowerShell's Job carries an InstanceId GUID. Deliberately absent: a guid
    // in kernel state would inherit `New-Guid`'s version-dependent shape.
    const jobs = new JobManager(() => 1);
    const job = jobs.start(1, 'a');
    assert.equal(Object.hasOwn(job, 'instanceId'), false);
    assert.equal(Number.isInteger(job.id), true);
  });
});

describe('a job that nobody receives', () => {
  it('stops growing, and says how much it dropped', () => {
    // The buffer was unbounded. `receive`'s own docstring said it "would grow
    // without bound in a tab that stays open for days" and offered the
    // destructive default of Receive-Job as the answer -- which is only an
    // answer if somebody runs it. Real pwsh is unbounded too, and that is fine
    // on a desktop; here the runaway takes the page down with it, including the
    // terminal the user would have used to stop the job.
    const jobs = new JobManager(() => 1);
    const job = jobs.start(1, 'Start-Job { 1..100000 }');

    const overshoot = 250;
    for (let i = 0; i < JOB_VALUE_LIMIT + overshoot; i += 1) jobs.record(1, i);

    const out = jobs.receive(job.id, true);
    assert.equal(out.values.length, JOB_VALUE_LIMIT, 'bounded');
    assert.equal(out.droppedValues, overshoot, 'and it counted what it dropped');

    // The OLDEST went, so what remains is what the job is doing now.
    assert.equal(out.values[0], overshoot);
    assert.equal(out.values.at(-1), JOB_VALUE_LIMIT + overshoot - 1);
  });

  it('never lets a runaway success stream push out an error', () => {
    // Errors are rarer and worth more, so they get their own room. One flood of
    // objects must not be able to evict the error that explains it.
    const jobs = new JobManager(() => 1);
    const job = jobs.start(1, 'noisy');
    jobs.recordError(1, errorRecord('the one that matters', 'Boom', 'noisy'));
    for (let i = 0; i < JOB_VALUE_LIMIT * 2; i += 1) jobs.record(1, i);

    const out = jobs.receive(job.id, true);
    assert.equal(out.errors.length, 1);
    assert.equal(out.errors[0]?.message, 'the one that matters');
    assert.equal(out.droppedErrors, 0);
    assert.ok(out.droppedValues > 0);
  });

  it('keeps the count after a drain, so a second receive cannot look complete', () => {
    const jobs = new JobManager(() => 1);
    const job = jobs.start(1, 'x');
    for (let i = 0; i < JOB_VALUE_LIMIT + 5; i += 1) jobs.record(1, i);

    const first = jobs.receive(job.id);
    assert.equal(first.droppedValues, 5);

    const second = jobs.receive(job.id);
    assert.equal(second.values.length, 0, 'drained');
    assert.equal(
      second.droppedValues,
      5,
      'but still incomplete, and still says so -- zeroing this would let a ' +
        'second Receive-Job report a complete answer for a job that lost output',
    );
    assert.equal(jobs.get(job.id)?.droppedValues, 5, 'and Get-Job can see it too');
  });

  it('bounds errors on their own limit', () => {
    const jobs = new JobManager(() => 1);
    const job = jobs.start(1, 'failing');
    for (let i = 0; i < JOB_ERROR_LIMIT + 3; i += 1) {
      jobs.recordError(1, errorRecord(`e${String(i)}`, 'Boom', 'failing'));
    }
    const out = jobs.receive(job.id, true);
    assert.equal(out.errors.length, JOB_ERROR_LIMIT);
    assert.equal(out.droppedErrors, 3);
    assert.equal(out.errors[0]?.message, 'e3', 'the oldest went');
  });
});
