/**
 * Tests for the object model.
 *
 * Every expectation here was READ OFF pwsh 7.6.5 rather than reasoned about,
 * and each case that carries a `// pwsh:` note is one the reference
 * implementation contradicted during development. Three of them were wrong
 * before the check:
 *
 *   - enumeration was recursive; PowerShell unrolls one level
 *   - string ordering was by code point; PowerShell is culture-aware
 *   - Measure-Object skipping nulls was mistaken for the pipeline dropping them
 *
 * Keeping the probe output in the assertions is what stops those being
 * re-introduced by someone who reasons from first principles and gets the same
 * plausible wrong answers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  psObject,
  isPSObject,
  getProperty,
  hasProperty,
  propertyNames,
  isOfType,
  typeNameOf,
  compareValues,
  valuesEqual,
  isTruthy,
  enumerate,
  PS_CUSTOM_OBJECT,
} from '../../src/pipeline/psobject.ts';
import type { PSValue } from '../../src/pipeline/psobject.ts';

describe('property access', () => {
  const o = psObject({ Name: 'x', Length: 42 });

  it('is case-insensitive, as PowerShell is', () => {
    // pwsh: $o = [pscustomobject]@{Name='x'}; $o.name -eq 'x'  ->  True
    assert.equal(getProperty(o, 'Name'), 'x');
    assert.equal(getProperty(o, 'name'), 'x');
    assert.equal(getProperty(o, 'NAME'), 'x');
    assert.equal(hasProperty(o, 'lEnGtH'), true);
  });

  it('distinguishes a missing property from one holding null', () => {
    // Collapsing these would make `Where-Object { $_.X -eq $null }` match
    // objects that have no X at all.
    const withNull = psObject({ X: null });
    assert.equal(getProperty(withNull, 'X'), null);
    assert.equal(hasProperty(withNull, 'X'), true);
    assert.equal(getProperty(o, 'NoSuchThing'), undefined);
    assert.equal(hasProperty(o, 'NoSuchThing'), false);
  });

  it('keeps declaration order, which is the order Format-Table follows', () => {
    assert.deepEqual(propertyNames(psObject({ B: 1, A: 2, C: 3 })), ['B', 'A', 'C']);
  });

  it('returns undefined for non-objects rather than throwing', () => {
    assert.equal(getProperty('a string', 'Length'), undefined);
    assert.equal(getProperty(null, 'x'), undefined);
  });
});

describe('type names', () => {
  it('reports what pwsh reports', () => {
    // pwsh: (1).GetType().FullName -> System.Int32
    //       (1.5).GetType().FullName -> System.Double
    assert.equal(typeNameOf(1), 'System.Int32');
    assert.equal(typeNameOf(1.5), 'System.Double');
    assert.equal(typeNameOf('s'), 'System.String');
    assert.equal(typeNameOf(true), 'System.Boolean');
    assert.equal(typeNameOf(new Date()), 'System.DateTime');
    assert.equal(typeNameOf(new Uint8Array()), 'System.Byte[]');
    assert.equal(typeNameOf([1, 2]), 'System.Object[]');
    // pwsh: $o.PSObject.TypeNames[0] -> System.Management.Automation.PSCustomObject
    assert.equal(typeNameOf(psObject({})), PS_CUSTOM_OBJECT);
  });

  it('walks the hierarchy for -is, by full name or short name', () => {
    const p = psObject({ Id: 1 }, ['System.Diagnostics.Process', 'System.Object']);
    assert.equal(isOfType(p, 'System.Diagnostics.Process'), true);
    assert.equal(isOfType(p, 'Process'), true);
    assert.equal(isOfType(p, 'process'), true);
    assert.equal(isOfType(p, 'System.Object'), true);
    assert.equal(isOfType(p, 'System.IO.FileInfo'), false);
  });

  it('recognises a PSObject structurally', () => {
    assert.equal(isPSObject(psObject({})), true);
    assert.equal(isPSObject({ typeNames: 'no', properties: {} }), false);
    assert.equal(isPSObject(null), false);
    assert.equal(isPSObject('string'), false);
  });
});

describe('comparison', () => {
  it('is case-insensitive by default, because -eq is', () => {
    // pwsh: 'a' -eq 'A'  -> True
    //       'a' -ceq 'A' -> False
    assert.equal(valuesEqual('a', 'A'), true);
    assert.equal(valuesEqual('a', 'A', true), false);
  });

  it('orders strings by culture, not by code point', () => {
    // This is the correction that matters most. By code point 'B' < 'a'
    // (Ordinal compare returns -31), so a codepoint implementation would say
    // -1 here. pwsh 7.6.5 reports `'B' -lt 'a'` as False, i.e. B sorts AFTER a.
    assert.equal(compareValues('B', 'a'), 1);
    assert.equal(compareValues('B', 'a', true), 1);
    assert.equal(compareValues('a', 'B'), -1);
  });

  it('reproduces the reference implementation Sort-Object result', () => {
    // pwsh: @('b','A','a','B') | Sort-Object  ->  A,a,b,B
    // Case-insensitive and STABLE: A/a compare equal and keep input order, as
    // do b/B.
    const input = ['b', 'A', 'a', 'B'];
    const sorted = [...input].sort((x, y) => compareValues(x, y));
    assert.deepEqual(sorted, ['A', 'a', 'b', 'B']);
  });

  it('compares numbers and dates numerically, not as strings', () => {
    assert.equal(compareValues(9, 10), -1, '9 < 10, not "9" > "10"');
    assert.equal(compareValues(new Date(1), new Date(2)), -1);
    assert.equal(compareValues(2n, 10n), -1);
  });

  it('sorts null before everything', () => {
    assert.equal(compareValues(null, 'a'), -1);
    assert.equal(compareValues('a', null), 1);
    assert.equal(compareValues(null, null), 0);
  });
});

describe('truthiness', () => {
  it('matches PowerShell, which is not JavaScript', () => {
    // Each of these was read off pwsh 7.6.5.
    assert.equal(isTruthy([]), false, 'pwsh: [bool]@() -> False');
    assert.equal(isTruthy([0]), false, 'pwsh: [bool]@(0) -> False (takes the element)');
    assert.equal(isTruthy([1]), true, 'pwsh: [bool]@(1) -> True');
    assert.equal(isTruthy([0, 0]), true, 'pwsh: [bool]@(0,0) -> True (length > 1)');
    assert.equal(isTruthy('0'), true, 'pwsh: [bool]"0" -> True (non-empty string)');
    assert.equal(isTruthy(0), false, 'pwsh: [bool]0 -> False');
    assert.equal(isTruthy(''), false, 'pwsh: [bool]"" -> False');
    assert.equal(isTruthy(null), false, 'pwsh: [bool]$null -> False');
  });

  it('differs from JavaScript exactly where PowerShell does', () => {
    // The two cases a JS habit gets wrong in opposite directions.
    assert.notEqual(isTruthy([]), Boolean([]), 'JS says [] is truthy; PowerShell says false');
    assert.equal(isTruthy('0'), Boolean('0'), 'both agree "0" is truthy');
  });
});

describe('pipeline enumeration', () => {
  const drain = (v: PSValue): PSValue[] => [...enumerate(v)];

  it('unrolls exactly one level', () => {
    // pwsh: (@(1,@(2,3)) | Measure-Object).Count -> 2
    // and the second item arrives as Object[], not as 2 and 3.
    const out = drain([1, [2, 3]] as PSValue);
    assert.equal(out.length, 2);
    assert.equal(out[0], 1);
    assert.deepEqual(out[1], [2, 3], 'the inner array arrives intact');
  });

  it('does not flatten deeper nesting either', () => {
    // pwsh: (@(1,@(2,@(3,4))) | Measure-Object).Count -> 2
    assert.equal(drain([1, [2, [3, 4]]] as PSValue).length, 2);
  });

  it('passes null through as a value', () => {
    // pwsh: @($null,1) | ForEach-Object  runs TWICE.
    // Measure-Object reporting 1 is Measure-Object skipping nulls, which is
    // that command's behaviour rather than the pipeline dropping the value.
    assert.deepEqual(drain([null, 1] as PSValue), [null, 1]);
  });

  it('sends a non-array as itself', () => {
    assert.deepEqual(drain('one'), ['one']);
    assert.deepEqual(drain(null), [null]);
  });
});
