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
  compareForSorting,
  ComparisonTypeError,
  valuesEqual,
  toPSString,
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

/**
 * Comparison coercion.
 *
 * Every expectation below was read off pwsh 7.6.5. The differential harness
 * found this: compareValues used to fall back to string collation whenever the
 * two JavaScript types differed, so `10 -lt '9'` answered True where PowerShell
 * answers False, and every comparison mixing a number with a numeric string was
 * wrong.
 */
describe('comparison converts the right operand to the left operand type', () => {
  // The direction is the whole rule, and it is genuinely asymmetric.
  it('10 -lt "9" is False, because the right side becomes the number 9', () => {
    assert.ok(compareValues(10, '9') > 0);
  });

  it('"9" -lt 10 is also False, because the right side becomes the string "10"', () => {
    // Not a contradiction: '9' sorts after '10' as text.
    assert.ok(compareValues('9', 10) > 0);
  });

  it('accepts the numeric string forms PowerShell accepts', () => {
    assert.ok(valuesEqual(10, '10.0'), '10 -eq "10.0"');
    assert.ok(valuesEqual(10, '1e1'), '10 -eq "1e1"');
    assert.ok(compareValues(10, ' 11 ') < 0, '10 -lt " 11 " tolerates whitespace');
  });

  it('booleans take the left type too', () => {
    assert.ok(valuesEqual(true, 1), '$true -eq 1');
    assert.ok(compareValues(true, 2) === 0, '$true -lt 2 is False: 2 becomes $true');
    assert.ok(compareValues(true, false) > 0, '$true -gt $false');
    assert.ok(valuesEqual('true', true), '"true" -eq $true');
  });

  it('treats $null as less than everything, and "" as not null', () => {
    assert.ok(compareValues(null, 1) < 0, '$null -lt 1');
    assert.ok(compareValues(1, null) > 0, '1 -gt $null');
    assert.ok(!valuesEqual('', null), '"" -eq $null is False');
    assert.ok(valuesEqual(null, null), '$null -eq $null');
  });

  it('converts a string to a date when the left operand is one', () => {
    assert.ok(compareValues(new Date('2020-01-01'), '2021-01-01') < 0);
  });
});

describe('ordering throws where equality does not', () => {
  // Measured: `10 -eq 'abc'` is False, `10 -lt 'abc'` raises. Equality can
  // answer "not the same"; ordering has no answer, so it refuses.
  it('-eq returns false rather than throwing', () => {
    assert.equal(valuesEqual(10, 'abc'), false);
  });

  it('-lt throws ComparisonTypeError', () => {
    assert.throws(() => compareValues(10, 'abc'), ComparisonTypeError);
  });

  it('the sorting order never throws, because Sort-Object does not', () => {
    assert.doesNotThrow(() => compareForSorting(10, 'abc'));
  });
});

describe('the cmdlet sort order falls back to text, not to a type rank', () => {
  // A type rank (numbers, then strings, then booleans) fits some cases and is
  // the obvious guess. These two rule it out: only comparing the string forms
  // produces both results.
  it('puts $true before "zzz" but after "aaa"', () => {
    assert.ok(compareForSorting('zzz', true) > 0, '@("zzz",$true) sorts to True zzz');
    assert.ok(compareForSorting('aaa', true) < 0, '@("aaa",$true) sorts to aaa True');
  });

  it('puts a number before a non-numeric string', () => {
    assert.ok(compareForSorting(1, 'a') < 0, '@("a",1) sorts to 1 a');
  });

  it('orders a whole mixed list the way pwsh does', () => {
    // pwsh: @(1,'a',$true) | Sort-Object  ->  1 a True
    const sorted = [true, 'a', 1].sort((x, y) => compareForSorting(x, y));
    assert.deepEqual(sorted, [1, 'a', true]);
  });
});

describe('integer width', () => {
  // pwsh types a literal by its magnitude; reporting Int32 for everything made
  // Get-Member wrong for any value above 2147483647.
  it('widens at the Int32 boundary', () => {
    assert.equal(typeNameOf(2147483647), 'System.Int32');
    assert.equal(typeNameOf(2147483648), 'System.Int64');
    assert.equal(typeNameOf(-2147483648), 'System.Int32');
    assert.equal(typeNameOf(-2147483649), 'System.Int64');
  });

  it('still calls a non-integer Double', () => {
    assert.equal(typeNameOf(1.5), 'System.Double');
  });
});

/**
 * Regressions from an adversarial review. Every one of these was a real defect
 * found by attacking the object model rather than by reading it, and every
 * expectation is what pwsh 7.6.5 answers.
 */
describe('property access does not walk the prototype chain', () => {
  it('getProperty returns undefined for an inherited name', () => {
    // It read `properties[name]` before checking ownership, so this returned the
    // host Function — a JavaScript function escaping into PSValue — and
    // `Where-Object toString -ne $null` matched every object.
    const o = psObject({ a: 1 });
    assert.equal(getProperty(o, 'toString'), undefined);
    assert.equal(getProperty(o, 'constructor'), undefined);
    assert.equal(getProperty(o, '__proto__'), undefined);
  });

  it('getProperty and hasProperty agree about the same name', () => {
    const o = psObject({ a: 1 });
    for (const name of ['toString', 'constructor', 'valueOf', 'a', 'A', 'missing']) {
      assert.equal(
        getProperty(o, name) !== undefined,
        hasProperty(o, name),
        `${name}: the two must not disagree`,
      );
    }
  });
});

describe('Int64 survives comparison', () => {
  it('a bigint equals its own decimal string', () => {
    // The comparison went through BigInt(Number(text)), and
    // Number('9223372036854775807') is ...808 — so the one reason the binder
    // produces a bigint for Int64 was undone by the first comparison.
    assert.equal(valuesEqual(9223372036854775807n, '9223372036854775807'), true);
    assert.equal(compareValues(9223372036854775807n, '9223372036854775807'), 0);
  });

  it('still orders two adjacent Int64 values correctly', () => {
    assert.equal(compareValues(9007199254740993n, '9007199254740992'), 1);
  });
});

describe('the text fallback is PowerShell rendering, not JavaScript', () => {
  it('sorts a date ahead of "a", because its text form starts with a digit', () => {
    // pwsh: @('a',(Get-Date)) | Sort-Object -> the date first.
    // String(date) is "Sat Sep 05 2026 …", which sorted it after.
    assert.ok(compareForSorting('a', new Date(2026, 8, 5)) > 0);
  });

  it('compares an array against its space-joined form', () => {
    // pwsh: '1 2' -eq @(1,2) is True. String([1,2]) is "1,2", which said false.
    assert.equal(valuesEqual('1 2', [1, 2]), true);
    assert.equal(valuesEqual('1,2', [1, 2]), false);
  });

  it('uses G15 for doubles in a comparison, not JavaScript round-trip', () => {
    assert.equal(valuesEqual('0.3', 0.1 + 0.2), true);
  });
});

describe('integer width has both bounds', () => {
  it('classifies each side of the Int32 and Int64 boundaries', () => {
    assert.equal(typeNameOf(2147483647), 'System.Int32');
    assert.equal(typeNameOf(2147483648), 'System.Int64');
    // 9223372036854775807 and ...808 are the SAME double, so the bound has to be
    // 2**63 rather than a literal that rounds up past itself.
    assert.equal(typeNameOf(2 ** 63), 'System.Decimal');
    // Decimal is a narrow band above Int64, not everything above it.
    assert.equal(typeNameOf(1e30), 'System.Double');
  });
});

describe('two distinct objects are not one value', () => {
  it('-eq is false and ordering refuses', () => {
    // Both render ToString() as empty in pwsh, so a text comparison called every
    // pair equal. pwsh answers False for -eq and raises for -lt.
    const a = psObject({ a: 1 });
    const b = psObject({ b: 2 });
    assert.equal(valuesEqual(a, b), false);
    assert.throws(() => compareValues(a, b), ComparisonTypeError);
  });

  it('an object still compares against text', () => {
    assert.equal(valuesEqual(psObject({ a: 1 }), '@{a=1}'), true);
  });
});

describe('there is exactly one value-to-string implementation', () => {
  it('psobject and the formatting re-export are the same function', async () => {
    // Three renderings once existed and disagreed. This fails if a second one
    // is reintroduced behind the formatting module's name.
    const reexport = await import('../../src/formatting/to-string.ts');
    assert.equal(reexport.toPSString, toPSString);
  });
});
