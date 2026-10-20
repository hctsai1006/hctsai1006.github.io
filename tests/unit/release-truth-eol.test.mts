/**
 * End-of-support classification, at the boundary.
 *
 * This suite exists because the boundary was WRONG twice, and the first time
 * nothing could ask about it. The classification was three lines inline behind
 * `Date.now()`:
 *
 *     const daysLeft = Math.round((deadline - Date.now()) / 86_400_000);
 *     severity: daysLeft <= 0 ? 'error' : 'warning'
 *
 * A DISPLAY rounding was deciding a support question. Measured against the
 * deadline that same line computed for 7.4.19, `2026-11-10T00:00:00Z`:
 *
 *     2026-11-09T12:00:00.000Z   43,200,000 ms left   daysLeft 1   supported
 *     2026-11-09T12:00:00.001Z   43,199,999 ms left   daysLeft 0   EXPIRED   <- wrong
 *     2026-11-09T23:59:59.999Z            1 ms left   daysLeft 0   EXPIRED   <- wrong
 *
 * Up to twelve hours early, and `lts-out-of-support` carries severity `error`,
 * so it would have turned a required gate red for a profile that was still
 * supported.
 *
 * It went untested for a structural reason worth recording: `verify-release-
 * truth.mts` called `main()` at the top level, so importing it ran the whole
 * tool, network calls included. Nothing could import the function to ask it
 * about a chosen instant. `main()` is now behind `import.meta.main` and the
 * classification is a pure function, which is what makes this file possible.
 *
 * The second error was the deadline itself. An end-of-support date is the last
 * day of support: the lifecycle doc says 7.4 "is still supported until
 * 10-Nov-2026", the .NET team says .NET 8 and 9 "may each receive one final
 * update on that day", and .NET 6 shipped 6.0.36 on its end-of-support date.
 * A deadline at the START of the date made the 06:15 UTC sync on 2026-11-10
 * call 7.4 unsupported hours before its last update could ship. The deadline
 * is now the end of the date, so every instant below is one day later than in
 * the table above.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifySupport, supportCountdown } from '../../tools/verify-release-truth.mts';

const DATE = '2026-11-10';
const at = (iso: string) => Date.parse(iso);

describe('end of support is a timestamp comparison, not a rounded day count', () => {
  it('is still supported with one millisecond left', () => {
    const c = classifySupport(DATE, at('2026-11-10T23:59:59.999Z'), 180);
    assert.ok(c !== null);
    assert.equal(c.remainingMs, 1);
    assert.equal(c.expired, false, 'one millisecond of support is still support');
    assert.equal(c.approaching, true);
  });

  it('is still supported at the half-day boundary that used to flip it', () => {
    // The instant where the old `Math.round` crossed from 1 to 0, moved along
    // with the deadline.
    const c = classifySupport(DATE, at('2026-11-10T12:00:00.001Z'), 180);
    assert.ok(c !== null);
    assert.equal(c.remainingMs, 43_199_999);
    assert.equal(c.expired, false);
    assert.equal(Math.round(c.remainingMs / 86_400_000), 0, 'and the rounded count really is 0 here');
  });

  it('expires exactly at the deadline, not before', () => {
    const before = classifySupport(DATE, at('2026-11-10T23:59:59.999Z'), 180);
    const on = classifySupport(DATE, at('2026-11-11T00:00:00.000Z'), 180);
    const after = classifySupport(DATE, at('2026-11-11T00:00:00.001Z'), 180);
    assert.equal(before?.expired, false);
    assert.equal(on?.expired, true, 'zero remaining is expired');
    assert.equal(after?.expired, true);
  });

  it('counts the end-of-support date itself as supported', () => {
    // upstream-sync.yml runs at 06:15 UTC. On the date, the last update may
    // not have shipped yet.
    for (const iso of [
      '2026-11-10T00:00:00.000Z',
      '2026-11-10T06:15:00.000Z',
      '2026-11-10T18:00:00.000Z',
    ]) {
      assert.equal(classifySupport(DATE, at(iso), 180)?.expired, false, iso);
    }
    assert.equal(classifySupport(DATE, at('2026-11-11T06:15:00.000Z'), 180)?.expired, true);
  });

  it('never reports both expired and approaching', () => {
    // They drive severity and code respectively; a record that claimed both
    // would produce an `lts-out-of-support` error and an `lts-approaching-eol`
    // warning for one release.
    for (const iso of [
      '2026-05-01T00:00:00Z',
      '2026-11-10T23:59:59.999Z',
      '2026-11-11T00:00:00.000Z',
      '2027-01-01T00:00:00Z',
    ]) {
      const c = classifySupport(DATE, at(iso), 180);
      assert.ok(c !== null);
      assert.equal(c.expired && c.approaching, false, iso);
    }
  });

  it('refuses a date it cannot parse instead of classifying it', () => {
    // The old code produced NaN here and leaned on `Number.isFinite(daysLeft)`
    // further down to skip it. Returning null says so at the point of failure.
    assert.equal(classifySupport('not-a-date', Date.now(), 180), null);
    assert.equal(classifySupport('', Date.now(), 180), null);
  });

  it('does not change its answer as time advances within one support state', () => {
    // The stored lockfile projection must be stable while the state is. This is
    // the same property the countdown fix protected: a value derived from
    // `now` must not reach anything that is compared against a fresh fetch.
    const days = ['2026-06-01', '2026-07-01', '2026-08-01'].map(
      (d) => classifySupport(DATE, at(`${d}T00:00:00Z`), 180),
    );
    for (const c of days) {
      assert.ok(c !== null);
      assert.equal(c.expired, false);
      assert.equal(c.approaching, true, 'same state on every one of these days');
    }
  });

  it('leaves the horizon test to rounded days, which is what it is for', () => {
    const inside = classifySupport(DATE, at('2026-05-15T00:00:00Z'), 180);
    const outside = classifySupport(DATE, at('2026-01-01T00:00:00Z'), 180);
    assert.equal(inside?.approaching, true);
    assert.equal(outside?.approaching, false, 'beyond the horizon, nothing is reported');
    assert.equal(outside?.expired, false);
  });
});

describe('the countdown people read agrees with the verifier about the last day', () => {
  it('counts down to the date, then calls the date the last day', () => {
    assert.equal(supportCountdown(DATE, at('2026-10-20T07:26:47.206Z'), 180), '21 days left');
    assert.equal(supportCountdown(DATE, at('2026-11-09T06:15:00.000Z'), 180), '1 day left');
    assert.equal(supportCountdown(DATE, at('2026-11-10T06:15:00.000Z'), 180), 'last day');
  });

  it('gives one count for the whole of a UTC day', () => {
    // The explorer renders as of the lockfile's generation and the report as of
    // whenever it runs, so the count must depend on the date alone. A rounded
    // count says 2 in the morning and 1 late in the evening.
    for (const iso of ['2026-11-08T00:00:00.000Z', '2026-11-08T12:00:00.000Z', '2026-11-08T23:59:59.999Z']) {
      assert.equal(supportCountdown(DATE, at(iso), 180), '2 days left', iso);
    }
  });

  it('says ended after the date instead of a negative count', () => {
    // generate-compat-explorer.mts subtracted the dates itself and would have
    // printed "-1 days left" the day after.
    assert.equal(supportCountdown(DATE, at('2026-11-11T00:00:00.000Z'), 180), 'ended');
    assert.equal(supportCountdown(DATE, at('2026-11-11T06:15:00.000Z'), 180), 'ended');
    assert.equal(supportCountdown(DATE, at('2027-01-24T00:00:00.000Z'), 180), 'ended');
  });

  it('shows no negative count at any hour around the end', () => {
    const start = at(`${DATE}T00:00:00.000Z`);
    for (let h = -48; h <= 48; h++) {
      const now = start + h * 3_600_000;
      const text = supportCountdown(DATE, now, 180);
      assert.ok(text !== null, `hour ${h}`);
      assert.doesNotMatch(text, /-/, `hour ${h}: ${text}`);
      assert.equal(text === 'ended', classifySupport(DATE, now, 180)?.expired, `hour ${h}: ${text}`);
    }
  });

  it('says nothing beyond the horizon or for a date it cannot parse', () => {
    assert.equal(supportCountdown(DATE, at('2026-01-01T00:00:00Z'), 180), null);
    assert.equal(supportCountdown('not-a-date', at('2026-11-10T00:00:00Z'), 180), null);
  });
});
