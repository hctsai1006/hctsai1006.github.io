/**
 * Every expectation here was read off pwsh 7.6.5, under en-US, de-DE and zh-TW
 * where culture could plausibly matter. The probe output is quoted beside each
 * case so a future change has to argue with the reference implementation rather
 * than with an opinion.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { toPSString, formatDouble, DEFAULT_OFS } from '../../src/formatting/to-string.ts';
import { psObject } from '../../src/pipeline/psobject.ts';

describe('doubles use .NET G15, not JavaScript round-trip', () => {
  // This is the case that makes the whole file necessary: String(0.1 + 0.2) is
  // 0.30000000000000004 in JavaScript and 0.3 in PowerShell.
  it('0.1 + 0.2 prints as 0.3', () => {
    assert.equal(formatDouble(0.1 + 0.2), '0.3');
    assert.notEqual(String(0.1 + 0.2), '0.3');
  });

  it('1/3 keeps fifteen significant digits, not seventeen', () => {
    assert.equal(formatDouble(1 / 3), '0.333333333333333');
  });

  it('a whole double loses its point', () => {
    assert.equal(formatDouble(1.0), '1');
    assert.equal(formatDouble(-2.0), '-2');
  });

  it('goes exponential where .NET does, in .NET notation', () => {
    assert.equal(formatDouble(1e21), '1E+21');
  });

  it('names the non-finite values the way .NET does', () => {
    assert.equal(formatDouble(NaN), 'NaN');
    assert.equal(formatDouble(Infinity), 'Infinity');
    assert.equal(formatDouble(-Infinity), '-Infinity');
  });

  it('keeps ordinary decimals intact', () => {
    assert.equal(formatDouble(1.5), '1.5');
    assert.equal(formatDouble(1234.5), '1234.5');
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
