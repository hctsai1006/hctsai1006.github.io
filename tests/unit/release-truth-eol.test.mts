/**
 * End-of-support classification, at the boundary.
 *
 * This suite exists because the boundary was WRONG and nothing could ask about
 * it. The classification was three lines inline behind `Date.now()`:
 *
 *     const daysLeft = Math.round((deadline - Date.now()) / 86_400_000);
 *     severity: daysLeft <= 0 ? 'error' : 'warning'
 *
 * A DISPLAY rounding was deciding a support question. Measured against the
 * deadline that same line computes for 7.4.19, `2026-11-10T00:00:00Z`:
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
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifySupport } from '../../tools/verify-release-truth.mts';

const DEADLINE = '2026-11-10';
const at = (iso: string) => Date.parse(iso);

describe('end of support is a timestamp comparison, not a rounded day count', () => {
  it('is still supported with one millisecond left', () => {
    const c = classifySupport(DEADLINE, at('2026-11-09T23:59:59.999Z'), 180);
    assert.ok(c !== null);
    assert.equal(c.remainingMs, 1);
    assert.equal(c.expired, false, 'one millisecond of support is still support');
    assert.equal(c.approaching, true);
  });

  it('is still supported at the half-day boundary that used to flip it', () => {
    // The exact instant the old `Math.round` crossed from 1 to 0.
    const c = classifySupport(DEADLINE, at('2026-11-09T12:00:00.001Z'), 180);
    assert.ok(c !== null);
    assert.equal(c.remainingMs, 43_199_999);
    assert.equal(c.expired, false);
    assert.equal(Math.round(c.remainingMs / 86_400_000), 0, 'and the rounded count really is 0 here');
  });

  it('expires exactly at the deadline, not before', () => {
    const before = classifySupport(DEADLINE, at('2026-11-09T23:59:59.999Z'), 180);
    const on = classifySupport(DEADLINE, at('2026-11-10T00:00:00.000Z'), 180);
    const after = classifySupport(DEADLINE, at('2026-11-10T00:00:00.001Z'), 180);
    assert.equal(before?.expired, false);
    assert.equal(on?.expired, true, 'zero remaining is expired');
    assert.equal(after?.expired, true);
  });

  it('never reports both expired and approaching', () => {
    // They drive severity and code respectively; a record that claimed both
    // would produce an `lts-out-of-support` error and an `lts-approaching-eol`
    // warning for one release.
    for (const iso of [
      '2026-05-01T00:00:00Z',
      '2026-11-09T23:59:59.999Z',
      '2026-11-10T00:00:00.000Z',
      '2027-01-01T00:00:00Z',
    ]) {
      const c = classifySupport(DEADLINE, at(iso), 180);
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
      (d) => classifySupport(DEADLINE, at(`${d}T00:00:00Z`), 180),
    );
    for (const c of days) {
      assert.ok(c !== null);
      assert.equal(c.expired, false);
      assert.equal(c.approaching, true, 'same state on every one of these days');
    }
  });

  it('leaves the horizon test to rounded days, which is what it is for', () => {
    const inside = classifySupport(DEADLINE, at('2026-05-15T00:00:00Z'), 180);
    const outside = classifySupport(DEADLINE, at('2026-01-01T00:00:00Z'), 180);
    assert.equal(inside?.approaching, true);
    assert.equal(outside?.approaching, false, 'beyond the horizon, nothing is reported');
    assert.equal(outside?.expired, false);
  });
});
