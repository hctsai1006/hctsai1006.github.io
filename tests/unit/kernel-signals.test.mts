/**
 * Tests for signals and process groups.
 *
 * The central assertion is that Ctrl+C interrupts the FOREGROUND group and
 * nothing else. That is not a nicety: without it the only available behaviours
 * are "kill everything" and "kill nothing", and both make backgrounding
 * useless. Every other test here exists to pin a property that behaviour
 * depends on.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PipelineStoppedError,
  SIGNAL_EXIT_CODE,
  SIGNAL_NUMBER,
  SignalController,
  VIRTUAL_SIGNALS,
  isPipelineStopped,
} from '../../src/kernel/signals.ts';

/** A foreground pipeline of three, plus a backgrounded job of one. */
function terminalWithBackgroundJob(): {
  signals: SignalController;
  foreground: readonly AbortSignal[];
  background: AbortSignal;
} {
  const signals = new SignalController();
  // The group leader is the first stage, as in POSIX; later stages join it.
  const foreground = [signals.register(1, 1), signals.register(2, 1), signals.register(3, 1)];
  const background = signals.register(4, 4);
  signals.setForeground('term-1', 1);
  return { signals, foreground, background };
}

describe('Ctrl+C', () => {
  it('interrupts the whole foreground pipeline and not the background job', () => {
    const { signals, foreground, background } = terminalWithBackgroundJob();

    const interrupted = signals.interrupt('term-1');

    assert.deepEqual(interrupted, [1, 2, 3]);
    for (const stage of foreground) assert.equal(stage.aborted, true);
    // The entire reason process groups are modelled at all.
    assert.equal(background.aborted, false);
    assert.equal(signals.deliveredTo(4), undefined);
  });

  it('stops a pipeline as a unit, not just the stage being watched', () => {
    // Interrupting only the last stage would leave the first two producing
    // into a sink nobody reads.
    const { signals, foreground } = terminalWithBackgroundJob();
    signals.interrupt('term-1');
    assert.deepEqual(
      foreground.map((s) => s.aborted),
      [true, true, true],
    );
  });

  it('does nothing when the terminal is sitting at a prompt', () => {
    // No foreground group means there is no process to signal. Clearing the
    // input line is a UI concern and deliberately not modelled as a signal.
    const { signals, foreground, background } = terminalWithBackgroundJob();
    signals.setForeground('term-1', null);

    assert.deepEqual(signals.interrupt('term-1'), []);
    for (const stage of [...foreground, background]) assert.equal(stage.aborted, false);
  });

  it('does not reach another terminal', () => {
    const signals = new SignalController();
    const first = signals.register(1, 1);
    const second = signals.register(2, 2);
    signals.setForeground('term-1', 1);
    signals.setForeground('term-2', 2);

    signals.interrupt('term-1');
    assert.equal(first.aborted, true);
    assert.equal(second.aborted, false);
  });
});

describe('delivery', () => {
  it('treats a negative pid as a group, as kill() does', () => {
    // This is how the protocol carries "the whole pipeline" in a field that is
    // still just a number, without a second field that could disagree.
    const { signals, foreground, background } = terminalWithBackgroundJob();

    assert.deepEqual(signals.deliver(-1, 'SIGTERM'), [1, 2, 3]);
    for (const stage of foreground) assert.equal(stage.aborted, true);
    assert.equal(background.aborted, false);
  });

  it('treats a positive pid as one process', () => {
    const { signals, foreground } = terminalWithBackgroundJob();

    assert.deepEqual(signals.deliver(2, 'SIGINT'), [2]);
    assert.deepEqual(
      foreground.map((s) => s.aborted),
      [false, true, false],
    );
  });

  it('reports nothing for a pid that does not exist', () => {
    const signals = new SignalController();
    assert.equal(signals.raise(9_999, 'SIGKILL'), false);
    assert.deepEqual(signals.deliver(9_999, 'SIGKILL'), []);
  });

  it('lets a later, harder signal win', () => {
    // PowerShell's own "press Ctrl+C again to force" escalation depends on the
    // second signal being recorded rather than dropped as redundant.
    const signals = new SignalController();
    signals.register(1);
    signals.raise(1, 'SIGINT');
    assert.equal(signals.deliveredTo(1), 'SIGINT');

    signals.raise(1, 'SIGKILL');
    assert.equal(signals.deliveredTo(1), 'SIGKILL');
  });

  it('tells listeners who was signalled, even mid-group', () => {
    const { signals } = terminalWithBackgroundJob();
    const heard: string[] = [];
    signals.onSignal((pid, signal) => heard.push(`${pid}:${signal}`));

    signals.interrupt('term-1');
    assert.deepEqual(heard, ['1:SIGINT', '2:SIGINT', '3:SIGINT']);
  });

  it('survives a listener that unregisters the process it is told about', () => {
    // The kernel's SIGKILL handler does exactly this. Mutating the membership
    // set mid-iteration would skip the next member, leaving half a pipeline
    // running.
    const signals = new SignalController();
    const stages = [signals.register(1, 1), signals.register(2, 1), signals.register(3, 1)];
    signals.onSignal((pid) => signals.unregister(pid));

    assert.deepEqual(signals.raiseGroup(1, 'SIGKILL'), [1, 2, 3]);
    for (const stage of stages) assert.equal(stage.aborted, true);
  });
});

describe('the abort reason', () => {
  it('is a PipelineStoppedError naming the signal and the process', () => {
    const signals = new SignalController();
    const signal = signals.register(7, 7);
    signals.raise(7, 'SIGINT');

    const reason: unknown = signal.reason;
    assert.equal(isPipelineStopped(reason), true);
    const stopped = reason as PipelineStoppedError;
    assert.equal(stopped.signal, 'SIGINT');
    assert.equal(stopped.pid, 7);
    // The category `$Error[0].CategoryInfo` reports in real PowerShell.
    assert.equal(stopped.category, 'OperationStopped');
  });
});

describe('registration', () => {
  it('returns the same AbortSignal for a pid registered twice', () => {
    const signals = new SignalController();
    assert.equal(signals.register(1, 1), signals.register(1, 1));
  });

  it('forgets a group once its last member is gone', () => {
    const signals = new SignalController();
    signals.register(1, 1);
    signals.register(2, 1);

    signals.unregister(1);
    assert.deepEqual(signals.members(1), [2]);
    signals.unregister(2);
    assert.deepEqual(signals.members(1), []);
    assert.equal(signals.groupOf(2), undefined);
  });
});

describe('exit codes', () => {
  it('uses the shell convention of 128 + signal number', () => {
    // Scripts test for 130. Inventing our own numbers would break them.
    assert.equal(SIGNAL_EXIT_CODE.SIGINT, 130);
    assert.equal(SIGNAL_EXIT_CODE.SIGKILL, 137);
    assert.equal(SIGNAL_EXIT_CODE.SIGTERM, 143);
    for (const signal of VIRTUAL_SIGNALS) {
      assert.equal(SIGNAL_EXIT_CODE[signal], 128 + SIGNAL_NUMBER[signal]);
    }
  });
});
