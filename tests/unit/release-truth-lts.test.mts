/**
 * Which declared LTS line is current, and what its end of support means.
 *
 * metadata.json declares two LTS lines only while one overlaps the next, and
 * it keeps declaring the older one for a while after it ends: v7.2.24 stayed
 * in LTSReleaseTag from 7.2's end of support on 2024-11-08 until 2025-01-24.
 * The lockfile records whatever upstream says today, so the two-line case and
 * the after-the-end case are tested here with fixtures. A roadmap citation of
 * the lockfile's previous line would stop resolving the day upstream drops it.
 *
 * The rule under test: the CURRENT line is what the LTS profile and the command
 * manifests are built from, so its end of support is an error. A PREVIOUS line
 * feeds nothing, so its end of support is a warning, and the sync pull request
 * stays mergeable while upstream catches up.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyLtsSupport, rankDeclaredLts } from '../../tools/verify-release-truth.mts';
import type { SupportLine } from '../../tools/verify-release-truth.mts';

const feed = ['v7.7.0-preview.5', 'v7.6.7', 'v7.5.12', 'v7.4.21'].map((tag_name) => ({ tag_name }));
const tags = (rs: ReadonlyArray<{ tag_name: string }>) => rs.map((r) => r.tag_name);

describe('the declared LTS lines', () => {
  it('keeps every declared LTS line, newest first', () => {
    // metadata.json on 2026-10-20.
    const r = rankDeclaredLts(['v7.4.21', 'v7.6.7'], feed);
    assert.deepEqual(tags(r.ranked), ['v7.6.7', 'v7.4.21']);
    assert.deepEqual(r.missing, []);
    assert.deepEqual(r.unrankable, []);
  });

  it('orders by version, not by where metadata.json lists a tag', () => {
    assert.deepEqual(tags(rankDeclaredLts(['v7.6.7', 'v7.4.21'], feed).ranked), ['v7.6.7', 'v7.4.21']);
  });

  it('reports a declared tag that the feed does not have', () => {
    const r = rankDeclaredLts(['v7.4.22', 'v7.6.7'], feed);
    assert.deepEqual(tags(r.ranked), ['v7.6.7']);
    assert.deepEqual(r.missing, ['v7.4.22']);
  });

  it('leaves out a tag it cannot rank, and says which', () => {
    const r = rankDeclaredLts(['v7.6.7', 'v7.6-hotfix'], [...feed, { tag_name: 'v7.6-hotfix' }]);
    assert.deepEqual(tags(r.ranked), ['v7.6.7']);
    assert.deepEqual(r.unrankable, ['v7.6-hotfix']);
  });

  it('has one line once upstream stops declaring the old one', () => {
    const r = rankDeclaredLts(['v7.6.7'], feed);
    assert.deepEqual(tags(r.ranked), ['v7.6.7']);
  });
});

const current: SupportLine = {
  tag: 'v7.6.7',
  supportedUntil: '2028-11-14',
  dotnet: { channelVersion: '10.0', supportPhase: 'active' },
};
const previous: SupportLine = {
  tag: 'v7.4.21',
  supportedUntil: '2026-11-10',
  dotnet: { channelVersion: '8.0', supportPhase: 'maintenance' },
};
const at = (iso: string) => Date.parse(iso);
const both = (iso: string) => classifyLtsSupport(current, [previous], at(iso), 180);

describe('end of support for each declared LTS line', () => {
  it('warns that the previous line is ending without asking for a profile change', () => {
    const { findings, retired } = both('2026-10-20T07:26:47Z');
    assert.equal(findings.length, 1);
    const [f] = findings;
    assert.ok(f !== undefined);
    assert.equal(f.severity, 'warning');
    assert.equal(f.code, 'lts-approaching-eol');
    assert.match(f.message, /^v7\.4\.21 loses support on 2026-11-10 \(\.NET 8\.0 is in maintenance\)\. /);
    assert.match(f.message, /no profile is built from it/);
    assert.deepEqual(retired, []);
  });

  it('still counts the previous line as supported on its last day', () => {
    const { findings, retired } = both('2026-11-10T06:15:00Z');
    assert.deepEqual(findings.map((f) => f.code), ['lts-approaching-eol']);
    assert.deepEqual(retired, []);
  });

  it('retires the previous line with a warning once it has ended', () => {
    const { findings, retired } = both('2026-11-11T06:15:00Z');
    assert.deepEqual(
      findings.map((f) => [f.severity, f.code]),
      [['warning', 'previous-lts-out-of-support']],
    );
    assert.deepEqual(retired, ['v7.4.21']);
  });

  it('raises no error while upstream keeps declaring an ended previous line', () => {
    // 7.2 stayed declared for 77 days after it ended. Every day of an equally
    // long wait for 7.4 must leave the sync pull request mergeable.
    const first = at('2026-11-11T06:15:00Z');
    for (let day = 0; day < 77; day++) {
      const { findings } = classifyLtsSupport(current, [previous], first + day * 86_400_000, 180);
      assert.ok(findings.every((f) => f.severity !== 'error'), `day ${day}`);
    }
  });

  it('is an error when the line the profile is built from has ended', () => {
    const { findings, retired } = classifyLtsSupport(current, [], at('2028-11-15T06:15:00Z'), 180);
    assert.deepEqual(findings.map((f) => [f.severity, f.code]), [['error', 'lts-out-of-support']]);
    assert.deepEqual(retired, [], 'the current line is never retired quietly');
  });

  it('asks for the profile to move when the current line nears its end', () => {
    const { findings } = classifyLtsSupport(current, [], at('2028-06-01T00:00:00Z'), 180);
    assert.equal(findings.length, 1);
    assert.match(findings[0]?.message ?? '', /move the profile to the next LTS/);
  });

  it('records the same findings on every day of one support state', () => {
    // The messages are stored in the lockfile and compared against a fresh
    // fetch, so a finding that changed with the date would be drift every day.
    for (const [a, b] of [
      ['2026-10-20T06:15:00Z', '2026-11-09T06:15:00Z'],
      ['2026-11-11T06:15:00Z', '2027-01-24T06:15:00Z'],
    ] as const) {
      assert.deepEqual(both(a), both(b), `${a} vs ${b}`);
    }
  });
});
