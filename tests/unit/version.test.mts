/**
 * Tests for version comparison.
 *
 * Every case here corresponds to a bug that actually existed and was silent.
 * The values are real: they are taken from the live PowerShell releases feed and
 * the .NET release metadata, not invented.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseVersion,
  compareVersions,
  featureBand,
  versionsAgree,
  byCodepoint,
} from '../../tools/version.mts';

/** compareVersions on two raw strings, failing loudly if either is unparseable. */
function cmp(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  assert.ok(pa !== null, `unparseable: ${a}`);
  assert.ok(pb !== null, `unparseable: ${b}`);
  return compareVersions(pa, pb);
}

/**
 * Normalise a comparator result to -1/0/1. Needed because `assert.equal` is
 * Object.is-based for primitives, and negating a zero yields -0, which is not
 * strictly equal to 0.
 */
const sign = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0);

describe('parseVersion', () => {
  it('parses the real shapes seen in upstream data', () => {
    assert.deepEqual(parseVersion('7.6.5')?.pre, null);
    assert.deepEqual(parseVersion('7.7.0-preview.4')?.pre, { kind: 'preview', n: 4 });
    assert.deepEqual(parseVersion('7.6.0-rc.1')?.pre, { kind: 'rc', n: 1 });

    const sdk = parseVersion('11.0.100-preview.6.26359.118');
    assert.equal(sdk?.patch, 100);
    assert.deepEqual(sdk?.pre, { kind: 'preview', n: 6 });
    assert.deepEqual(sdk?.build, [26359, 118]);
  });

  it('returns null rather than guessing', () => {
    // Callers must decide what an unparseable version means. None of them may
    // treat it as "probably fine" — that is how a check silently stops running.
    // Number('') === 0, so a looser build group parsed "1.2.3.4.." as build
    // [4,0,0] — guessing, which this function's contract forbids.
    for (const bad of ['', 'latest', '7.6', 'v7.6.5', 'undefined', null, undefined,
                       '1.2.3.4..', '1.2.3.4.', '1.2.3.']) {
      assert.equal(parseVersion(bad as string), null, `should not parse: ${String(bad)}`);
    }
  });
});

describe('compareVersions', () => {
  it('TRAP D: rc outranks preview', () => {
    // Folding rc into preview made 7.6.0-rc.1 compare as OLDER than a preview,
    // during exactly the window before a GA when the answer matters most.
    assert.equal(cmp('7.6.0-rc.1', '7.6.0-preview.4'), 1);
    assert.equal(cmp('7.6.0-rc.1', '7.6.0-preview.1'), 1);
    assert.equal(
      cmp('10.0.100-rc.2.25502.107', '10.0.100-preview.7.25380.108'),
      1,
    );
  });

  it('a stable release outranks any pre-release of the same triple', () => {
    assert.equal(cmp('7.6.0', '7.6.0-rc.1'), 1);
    assert.equal(cmp('7.6.0', '7.6.0-preview.4'), 1);
    assert.equal(cmp('7.6.0-rc.1', '7.6.0'), -1);
  });

  it('orders pre-release numbers numerically, not as strings', () => {
    // "preview.10" sorts before "preview.6" as a string.
    assert.equal(cmp('7.7.0-preview.10', '7.7.0-preview.6'), 1);
  });

  it('orders by build components when the pre-release is identical', () => {
    assert.equal(
      cmp('11.0.0-preview.6.26359.118', '11.0.0-preview.6.26359.117'),
      1,
    );
    assert.equal(
      cmp('11.0.0-preview.7.26381.103', '11.0.0-preview.6.26359.118'),
      1,
    );
  });

  it('is antisymmetric and reflexive across the real .NET 11 preview train', () => {
    const train = [
      '11.0.0-preview.1.26104.118',
      '11.0.0-preview.2.26159.112',
      '11.0.0-preview.3.26207.106',
      '11.0.0-preview.4.26230.115',
      '11.0.0-preview.5.26302.115',
      '11.0.0-preview.6.26359.118',
      '11.0.0-preview.7.26381.103',
    ];
    for (const v of train) assert.equal(cmp(v, v), 0, `${v} should equal itself`);
    for (let i = 0; i < train.length; i++) {
      for (let j = 0; j < train.length; j++) {
        const a = train[i];
        const b = train[j];
        assert.ok(a !== undefined && b !== undefined);
        const expected = i === j ? 0 : i < j ? -1 : 1;
        assert.equal(cmp(a, b), expected, `${a} vs ${b}`);
        assert.equal(sign(cmp(a, b)), sign(-cmp(b, a)), `antisymmetry: ${a} vs ${b}`);
      }
    }
  });

  it('sorts the real releases feed into version order', () => {
    // The feed itself is ordered by created_at, which is neither publish order
    // nor version order (TRAP E).
    const tags = ['v7.6.5', 'v7.5.10', 'v7.7.0-preview.4', 'v7.4.19', 'v7.6.0-rc.1'];
    const sorted = [...tags].sort((a, b) => {
      const pa = parseVersion(a.replace(/^v/, ''));
      const pb = parseVersion(b.replace(/^v/, ''));
      assert.ok(pa !== null && pb !== null);
      return -compareVersions(pa, pb);
    });
    assert.deepEqual(sorted, [
      'v7.7.0-preview.4',
      'v7.6.5',
      'v7.6.0-rc.1',
      'v7.5.10',
      'v7.4.19',
    ]);
  });
});

describe('featureBand', () => {
  it('extracts the band from real SDK versions', () => {
    // .NET release 10.0.11 ships all three of these at once.
    assert.equal(featureBand('10.0.400'), '4xx');
    assert.equal(featureBand('10.0.303'), '3xx');
    assert.equal(featureBand('10.0.111'), '1xx');
    assert.equal(featureBand('11.0.100-preview.6.26359.118'), '1xx');
  });

  it('returns null for unparseable input rather than a plausible-looking band', () => {
    assert.equal(featureBand('not-a-version'), null);
  });
});

describe('versionsAgree', () => {
  it('accepts a documentation abbreviation of a full SDK version', () => {
    // The 7.7 doc writes "11.0.100-preview.6" for the pinned SDK
    // "11.0.100-preview.6.26359.118".
    assert.equal(versionsAgree('11.0.100-preview.6', '11.0.100-preview.6.26359.118'), true);
    assert.equal(versionsAgree('10.0.11', '10.0.11'), true);
  });

  it('never treats an rc as agreeing with a preview', () => {
    // These are different .NET releases. Accepting them as equal suppressed a
    // genuine docs/global.json mismatch.
    assert.equal(versionsAgree('10.0.100-rc.2', '10.0.100-preview.2'), false);
  });

  it('rejects genuinely different versions', () => {
    // The category error at the heart of TRAP A: an SDK and a runtime that
    // happen to share a major.
    assert.equal(versionsAgree('10.0.11', '10.0.303'), false);
    assert.equal(versionsAgree('11.0.0-preview.6', '11.0.100-preview.6'), false);
  });
});

describe('byCodepoint', () => {
  it('orders deterministically regardless of locale', () => {
    assert.equal(byCodepoint('a', 'b'), -1);
    assert.equal(byCodepoint('b', 'a'), 1);
    assert.equal(byCodepoint('a', 'a'), 0);
    // Swedish collation actually agrees with codepoint order here (both -1);
    // it is the DEFAULT locale that disagrees, so this pair is what catches a
    // bare localeCompare.
    assert.equal(byCodepoint('z', 'ä'), -1);
    // And this pair catches the locale-pinned form localeCompare(a, b, 'sv'),
    // which the previous assertion would have passed unchanged.
    assert.equal(byCodepoint('a', 'B'), 1);
  });
});
