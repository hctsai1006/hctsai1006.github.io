/**
 * Every expectation here was read off pwsh 7.6.5, under en-US, de-DE and zh-TW
 * where culture could plausibly matter. The probe output is quoted beside each
 * case so a future change has to argue with the reference implementation rather
 * than with an opinion.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { toPSString, DEFAULT_OFS } from '../../src/formatting/to-string.ts';
import { INVARIANT } from '../../src/formatting/culture.ts';
import { formatGeneral } from '../../src/formatting/numeric.ts';
import { psObject } from '../../src/pipeline/psobject.ts';

/**
 * These used to call a `formatDouble` exported from psobject.ts. It is gone —
 * it was a second G15 that disagreed with `formatGeneral` on three of forty
 * doubles — so the same cases now go through the public conversion, which is
 * where every caller actually meets it.
 */
describe('doubles use .NET G15, not JavaScript round-trip', () => {
  // This is the case that makes the whole file necessary: String(0.1 + 0.2) is
  // 0.30000000000000004 in JavaScript and 0.3 in PowerShell.
  it('0.1 + 0.2 prints as 0.3', () => {
    assert.equal(toPSString(0.1 + 0.2), '0.3');
    assert.notEqual(String(0.1 + 0.2), '0.3');
  });

  it('1/3 keeps fifteen significant digits, not seventeen', () => {
    assert.equal(toPSString(1 / 3), '0.333333333333333');
  });

  it('a whole double loses its point', () => {
    assert.equal(toPSString(1.0), '1');
    assert.equal(toPSString(-2.0), '-2');
  });

  it('goes exponential where .NET does, in .NET notation', () => {
    assert.equal(toPSString(1e21), '1E+21');
  });

  it('names the non-finite values the way .NET does', () => {
    assert.equal(toPSString(NaN), 'NaN');
    assert.equal(toPSString(Infinity), 'Infinity');
    assert.equal(toPSString(-Infinity), '-Infinity');
  });

  it('keeps ordinary decimals intact', () => {
    assert.equal(toPSString(1.5), '1.5');
    assert.equal(toPSString(1234.5), '1234.5');
  });

  it('switches to exponential at 1e-5, not 1e-6', () => {
    // pwsh 7.6.5 on LINUX (docker pwsh-linux:7.6.5, .NET 10.0.11):
    //   "$(0.0001)"   0.0001
    //   "$(0.00001)"  1E-05
    //   "$(0.000001)" 1E-06
    // The deleted formatDouble answered `0.00001` for the middle one, because
    // its threshold was `exponent < -5` where .NET's is `< -4`.
    assert.equal(toPSString(0.0001), '0.0001');
    assert.equal(toPSString(0.00001), '1E-05');
    assert.equal(toPSString(0.000001), '1E-06');
  });

  it('keeps the sign on negative zero', () => {
    // pwsh 7.6.5 on LINUX: "$([double]::NegativeZero)" is -0, not 0.
    assert.equal(toPSString(-0), '-0');
    assert.equal(toPSString(0), '0');
  });

  it('is the same function the formatter uses for G15', () => {
    // One implementation, asserted rather than hoped for. `"$x"` IS
    // ToString("G15", InvariantCulture); if these ever diverge, one of them is
    // a second engine again.
    for (const value of [0.1 + 0.2, 1 / 3, 1e21, 0.00001, -0, 1234.5, NaN, -Infinity]) {
      assert.equal(toPSString(value), formatGeneral(value, 15, INVARIANT, true));
    }
  });
});

describe('"$x" — the culture-invariant conversion', () => {
  it('turns $null into an empty string, not "null"', () => {
    assert.equal(toPSString(null), '');
  });

  it('capitalises booleans', () => {
    // pwsh: "$true" => True
    assert.equal(toPSString(true), 'True');
    assert.equal(toPSString(false), 'False');
  });

  it('joins an array with $OFS, defaulting to a space', () => {
    // pwsh: "$(@(1,2,3))" => 1 2 3
    assert.equal(toPSString([1, 2, 3]), '1 2 3');
    assert.equal(DEFAULT_OFS, ' ');
  });

  it('honours a changed $OFS', () => {
    // pwsh: $OFS = '-'; "$(@(1,2,3))" => 1-2-3
    assert.equal(toPSString([1, 2, 3], '-'), '1-2-3');
  });

  it('gives an empty array an empty string', () => {
    // pwsh: "[$(@())]" => []
    assert.equal(toPSString([]), '');
  });

  it('keeps the separator around a null element', () => {
    // pwsh: "$(@($null,1))" => " 1" — the null becomes "", the space remains
    assert.equal(toPSString([null, 1]), ' 1');
  });

  it('prints a PSCustomObject as @{...}', () => {
    // pwsh: "$([pscustomobject]@{a=1})" => @{a=1}
    assert.equal(toPSString(psObject({ a: 1 })), '@{a=1}');
  });

  it('recurses into nested values', () => {
    assert.equal(toPSString([[1, 2], 3]), '1 2 3');
  });

  it('passes a string through unchanged', () => {
    assert.equal(toPSString('already text'), 'already text');
  });

  it('flattens bytes the same way as any other array', () => {
    // pwsh: "$([byte[]](1,2))" => 1 2
    assert.equal(toPSString(new Uint8Array([1, 2])), '1 2');
  });

  it('formats a date in the invariant form', () => {
    // pwsh: "$(Get-Date '2020-03-04T05:06:07')" => 03/04/2020 05:06:07
    assert.equal(toPSString(new Date(2020, 2, 4, 5, 6, 7)), '03/04/2020 05:06:07');
  });
});
