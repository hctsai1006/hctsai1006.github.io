/**
 * The comparison and membership operators, and the array-filtering shape that
 * makes them different from a boolean operator.
 *
 * `comparison.array-eq-filters` in the conformance corpus is the case this file
 * exists to make implementable: pwsh records
 *
 *   $r = @(1,2,3) -eq 2; "$($r.GetType().FullName)=$r"  ->  System.Object[]=2
 *
 * so the answer is an ARRAY containing 2, not the Boolean True.
 *
 * Predictions recorded before probing that were wrong:
 *
 *   P29/P30  right that -eq filters and -contains does not, but wrong about the
 *            ARGUMENT ORDER inside -contains: the collection ELEMENT is the left
 *            operand of the underlying -eq, and that is observable
 *   "arrays compare by content"  — they compare by REFERENCE, so two equal
 *            hashtables are not -eq
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  comparisonOperator,
  membershipOperator,
  PSRuntimeError,
} from '../../src/operators/index.ts';
import { psObject, type PSValue } from '../../src/pipeline/psobject.ts';

const SENSITIVE = { caseSensitive: true } as const;

// ---------------------------------------------------------------------------
// the filtering shape
// ---------------------------------------------------------------------------

describe('an array left operand FILTERS rather than answering a boolean', () => {
  it('@(1,2,3) -eq 2 returns Object[] holding 2', () => {
    // pwsh: $r = @(1,2,3) -eq 2; "$($r.GetType().FullName)=$r"
    //         ->  System.Object[]=2
    const r = comparisonOperator('eq', [1, 2, 3], 2);
    assert.ok(Array.isArray(r));
    assert.deepEqual(r, [2]);
    assert.notEqual(r, true, 'it is an array, not the boolean True');
  });

  it('does it for every one of the six', () => {
    // pwsh: @(1,2,3) -ne 2  ->  1, 3
    // pwsh: @(1,2,3) -lt 2  ->  1
    // pwsh: @(1,2,3) -le 2  ->  1, 2
    // pwsh: @(1,2,3) -gt 2  ->  3
    // pwsh: @(1,2,3) -ge 2  ->  2, 3
    assert.deepEqual(comparisonOperator('ne', [1, 2, 3], 2), [1, 3]);
    assert.deepEqual(comparisonOperator('lt', [1, 2, 3], 2), [1]);
    assert.deepEqual(comparisonOperator('le', [1, 2, 3], 2), [1, 2]);
    assert.deepEqual(comparisonOperator('gt', [1, 2, 3], 2), [3]);
    assert.deepEqual(comparisonOperator('ge', [1, 2, 3], 2), [2, 3]);
  });

  it('returns an EMPTY array, not $null, when nothing matches', () => {
    // pwsh: @(1,2,3) -eq 9  ->  Object[] with Count 0
    // pwsh: $null -eq (@(1,2,3) -eq 9)  ->  False
    const r = comparisonOperator('eq', [1, 2, 3], 9);
    assert.deepEqual(r, []);
    assert.notEqual(r, null);
  });

  it('keeps the ORIGINAL elements and preserves their casing', () => {
    // pwsh: @('a','B','c') -eq 'b'  ->  B      <- the stored casing, not the query's
    // pwsh: @('a','A') -ceq 'a'     ->  a
    // pwsh: @('a','A') -cne 'a'     ->  A
    assert.deepEqual(comparisonOperator('eq', ['a', 'B', 'c'], 'b'), ['B']);
    assert.deepEqual(comparisonOperator('eq', ['a', 'A'], 'a', SENSITIVE), ['a']);
    assert.deepEqual(comparisonOperator('ne', ['a', 'A'], 'a', SENSITIVE), ['A']);
  });

  it('filters $null elements the way -eq $null does', () => {
    // pwsh: @(1,$null,2) -eq $null  ->  Count 1 (the null)
    // pwsh: @(1,$null,2) -ne $null  ->  1, 2
    // pwsh: @() -eq $null           ->  Count 0
    assert.deepEqual(comparisonOperator('eq', [1, null, 2], null), [null]);
    assert.deepEqual(comparisonOperator('ne', [1, null, 2], null), [1, 2]);
    assert.deepEqual(comparisonOperator('eq', [], null), []);
  });

  it('THROWS from inside a filter rather than skipping the element', () => {
    // pwsh: @(1,2) -lt 'a'  ->  Cannot convert value "a" to type "System.Int32".
    // pwsh: @('a') -lt 1    ->  Count 0        (no error: 'a' -lt '1' is just False)
    assert.throws(
      () => comparisonOperator('lt', [1, 2], 'a'),
      (error: unknown) => {
        assert.ok(error instanceof PSRuntimeError);
        assert.equal(error.record.fullyQualifiedErrorId, 'InvalidCastFromStringToInteger');
        return true;
      },
    );
    assert.deepEqual(comparisonOperator('lt', ['a'], 1), []);
    // pwsh: @('a',1) -gt 0  ->  a, 1
    assert.deepEqual(comparisonOperator('gt', ['a', 1], 0), ['a', 1]);
  });
});

// ---------------------------------------------------------------------------
// scalars
// ---------------------------------------------------------------------------

describe('a scalar left operand answers a boolean', () => {
  it('converts the RIGHT operand to the LEFT operand`s type', () => {
    // pwsh: 1 -eq ' 1 '   ->  True     (' 1 ' becomes the number 1)
    // pwsh: ' 1 ' -eq 1   ->  False    ('1' is not ' 1 ')
    // pwsh: 10 -lt '9'    ->  False    '9' becomes the number 9
    // pwsh: '10' -lt '9'  ->  True     both are strings
    assert.equal(comparisonOperator('eq', 1, ' 1 '), true);
    assert.equal(comparisonOperator('eq', ' 1 ', 1), false);
    assert.equal(comparisonOperator('lt', 10, '9'), false);
    assert.equal(comparisonOperator('lt', '10', '9'), true);
  });

  it('is case-insensitive by default and sensitive with the c form', () => {
    // pwsh: 'a' -eq 'A'   ->  True        'a' -ceq 'A'  ->  False
    assert.equal(comparisonOperator('eq', 'a', 'A'), true);
    assert.equal(comparisonOperator('eq', 'a', 'A', SENSITIVE), false);
  });

  it('raises for ordering and answers False for equality when the types will not convert', () => {
    // pwsh: 1 -eq 'a'   ->  False
    // pwsh: 1 -lt 'a'   ->  id  = InvalidCastFromStringToInteger
    //                       msg = Cannot convert value "a" to type "System.Int32".
    //                             Error: "The input string 'a' was not in a correct format."
    // pwsh: 1.5 -lt 'a' ->  id  = InvalidCastFromStringToDoubleOrSingle
    assert.equal(comparisonOperator('eq', 1, 'a'), false);
    const err = expectError(() => comparisonOperator('lt', 1, 'a'));
    assert.equal(err.record.fullyQualifiedErrorId, 'InvalidCastFromStringToInteger');
    assert.equal(
      err.record.message,
      'Cannot convert value "a" to type "System.Int32". ' +
        'Error: "The input string \'a\' was not in a correct format."',
    );
    assert.equal(
      expectError(() => comparisonOperator('lt', 1.5, 'a')).record.fullyQualifiedErrorId,
      'InvalidCastFromStringToDoubleOrSingle',
    );
  });

  it('raises ComparisonFailure — a DIFFERENT id — for an array right operand', () => {
    // pwsh: 1 -lt @(2)
    //   id  = ComparisonFailure
    //   msg = Could not compare "1" to "2". Error: "Cannot convert the
    //         "System.Object[]" value of type "System.Object[]" to type "System.Int32"."
    // pwsh: 1 -eq @(1)  ->  False       (equality never raises)
    // pwsh: 1 -ne @(2)  ->  True
    const err = expectError(() => comparisonOperator('lt', 1, [2]));
    assert.equal(err.record.fullyQualifiedErrorId, 'ComparisonFailure');
    assert.equal(
      err.record.message,
      'Could not compare "1" to "2". Error: "Cannot convert the "2" value of ' +
        'type "System.Object[]" to type "System.Int32"."',
    );
    assert.equal(comparisonOperator('eq', 1, [1]), false);
    assert.equal(comparisonOperator('eq', 1, [1, 2]), false);
    assert.equal(comparisonOperator('ne', 1, [2]), true);
  });

  it('DOES stringify an array right operand when the left is a string', () => {
    // pwsh: 'abc' -eq @('abc')                        ->  True
    // pwsh: '1 2' -eq @(1,2)                          ->  True
    // pwsh: '' -eq @()                                ->  True
    // pwsh: 'x' -lt @{a=1}                            ->  False
    assert.equal(comparisonOperator('eq', 'abc', ['abc']), true);
    assert.equal(comparisonOperator('eq', '1 2', [1, 2]), true);
    assert.equal(comparisonOperator('eq', '', []), true);
    assert.equal(comparisonOperator('lt', 'x', psObject({ a: 1 })), false);
  });
});

// ---------------------------------------------------------------------------
// reference identity
// ---------------------------------------------------------------------------

describe('WRONG BEFORE PROBING: reference values compare by IDENTITY', () => {
  it('two hashtables with equal contents are not -eq', () => {
    // Predicted content equality, which is what comparing string forms would
    // give — both render as @{a=1}.
    // pwsh: @{a=1} -eq @{a=1}   ->  False
    // pwsh: $h -eq $h           ->  True
    const h = psObject({ a: 1 });
    assert.equal(comparisonOperator('eq', h, psObject({ a: 1 })), false);
    assert.equal(comparisonOperator('eq', h, h), true);
    assert.equal(comparisonOperator('ne', h, psObject({ a: 1 })), true);
  });

  it('orders a reference against ITSELF instead of raising', () => {
    // pwsh: $h -lt $h  ->  False       $h -le $h  ->  True
    const h = psObject({ a: 1 });
    assert.equal(comparisonOperator('lt', h, h), false);
    assert.equal(comparisonOperator('le', h, h), true);
    assert.equal(comparisonOperator('ge', h, h), true);
  });

  it('raises NotIcomparable for two different references', () => {
    // pwsh: @{a=1} -lt @{b=2}
    //   id  = NotIcomparable                 <- the reference implementation's own
    //                                           spelling, lowercase c and all
    //   msg = Cannot compare "System.Collections.Hashtable" because it is not IComparable.
    const err = expectError(() =>
      comparisonOperator('lt', psObject({ a: 1 }), psObject({ b: 2 })),
    );
    assert.equal(err.record.fullyQualifiedErrorId, 'NotIcomparable');
    assert.match(err.record.message, /because it is not IComparable\.$/);
  });

  it('carries the identity rule into the filtering form', () => {
    // pwsh: $inner = @(1,2); @(,$inner) -eq $inner  ->  Count 1
    const inner: PSValue = [1, 2];
    assert.deepEqual(comparisonOperator('eq', [inner], inner), [inner]);
    assert.deepEqual(comparisonOperator('eq', [[1, 2]], [1, 2]), []);
  });
});

// ---------------------------------------------------------------------------
// membership
// ---------------------------------------------------------------------------

describe('-contains -notcontains -in -notin always answer a boolean', () => {
  it('never filters, even with an array on both sides', () => {
    // pwsh: @(1,2) -contains 1     ->  True
    // pwsh: @(1,2) -notcontains 1  ->  False
    // pwsh: @(1,2) -in @(1,2)      ->  False   <- the ARRAY is not an element
    // pwsh: @(1,2) -notin @(1,2)   ->  True
    assert.equal(membershipOperator('contains', [1, 2], 1), true);
    assert.equal(membershipOperator('notcontains', [1, 2], 1), false);
    assert.equal(membershipOperator('in', [1, 2], [1, 2]), false);
    assert.equal(membershipOperator('notin', [1, 2], [1, 2]), true);
  });

  it('WRONG BEFORE PROBING: the ELEMENT is the left operand of the underlying -eq', () => {
    // Predicted the searched-for value was the left operand. The two are
    // distinguishable because -eq converts the RIGHT to the LEFT's type:
    // pwsh: @(1) -contains ' 1 '   ->  True    because  1 -eq ' 1 '  is True
    // pwsh: @(' 1 ') -contains 1   ->  False   because  ' 1 ' -eq 1  is False
    // pwsh: ' 1 ' -in @(1)         ->  True    -in is -contains with the operands swapped
    // pwsh: 1 -in @(' 1 ')         ->  False
    assert.equal(membershipOperator('contains', [1], ' 1 '), true);
    assert.equal(membershipOperator('contains', [' 1 '], 1), false);
    assert.equal(membershipOperator('in', ' 1 ', [1]), true);
    assert.equal(membershipOperator('in', 1, [' 1 ']), false);
  });

  it('is case-insensitive by default', () => {
    // pwsh: @('a') -contains 'A'   ->  True     @('a') -ccontains 'A'  ->  False
    // pwsh: 'A' -in @('a')         ->  True     'A' -cin @('a')        ->  False
    assert.equal(membershipOperator('contains', ['a'], 'A'), true);
    assert.equal(membershipOperator('contains', ['a'], 'A', SENSITIVE), false);
    assert.equal(membershipOperator('in', 'A', ['a']), true);
    assert.equal(membershipOperator('in', 'A', ['a'], SENSITIVE), false);
  });

  it('treats a scalar left operand as a one-element collection, NOT as characters', () => {
    // pwsh: 'abc' -contains 'abc'  ->  True
    // pwsh: 'abc' -contains 'a'    ->  False
    // pwsh: 'abc' -in 'abc'        ->  True
    // pwsh: 'a' -in 'abc'          ->  False
    // pwsh: 1 -in 1                ->  True
    assert.equal(membershipOperator('contains', 'abc', 'abc'), true);
    assert.equal(membershipOperator('contains', 'abc', 'a'), false);
    assert.equal(membershipOperator('in', 'abc', 'abc'), true);
    assert.equal(membershipOperator('in', 'a', 'abc'), false);
    assert.equal(membershipOperator('in', 1, 1), true);
  });

  it('coerces the way -eq does', () => {
    // pwsh: @(1,2,3) -contains '2'   ->  True
    // pwsh: @('1','2') -contains 2   ->  True
    // pwsh: @(1,2) -contains 1.0     ->  True
    // pwsh: @($true) -contains 'true'->  True
    // pwsh: @('a') -contains $true   ->  False
    // pwsh: @('a') -contains 'A '    ->  False
    assert.equal(membershipOperator('contains', [1, 2, 3], '2'), true);
    assert.equal(membershipOperator('contains', ['1', '2'], 2), true);
    assert.equal(membershipOperator('contains', [1, 2], 1.0), true);
    assert.equal(membershipOperator('contains', [true], 'true'), true);
    assert.equal(membershipOperator('contains', ['a'], true), false);
    assert.equal(membershipOperator('contains', ['a'], 'A '), false);
  });

  it('finds $null only when the collection really holds one', () => {
    // pwsh: @(1,2) -contains $null      ->  False
    // pwsh: @(1,$null) -contains $null  ->  True
    // pwsh: $null -in @(1,$null)        ->  True
    assert.equal(membershipOperator('contains', [1, 2], null), false);
    assert.equal(membershipOperator('contains', [1, null], null), true);
    assert.equal(membershipOperator('in', null, [1, null]), true);
  });

  it('compares nested collections by reference', () => {
    // pwsh: @(,@(1,2)) -contains @(1,2)   ->  False
    // pwsh: $inner = @(1,2); @(,$inner) -contains $inner  ->  True
    // pwsh: @($h) -contains @{a=1}        ->  False
    const inner: PSValue = [1, 2];
    assert.equal(membershipOperator('contains', [inner], inner), true);
    assert.equal(membershipOperator('contains', [[1, 2]], [1, 2]), false);
    const h = psObject({ a: 1 });
    assert.equal(membershipOperator('contains', [h], h), true);
    assert.equal(membershipOperator('contains', [h], psObject({ a: 1 })), false);
  });
});

function expectError(run: () => unknown): PSRuntimeError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof PSRuntimeError, 'expected a PSRuntimeError');
    return error;
  }
  assert.fail('expected a throw');
}
