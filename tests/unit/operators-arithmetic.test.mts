/**
 * Arithmetic and numeric widening, every expectation measured on pwsh 7.6.5 and
 * quoted beside the assertion.
 *
 * Predictions recorded BEFORE probing that turned out to be wrong, each with a
 * test of its own below:
 *
 *   P36  "1.0 / 0 throws like 1 / 0"   — it is Infinity. Only INTEGER and
 *        DECIMAL division by zero raises.
 *   P46  "-band on doubles gives Int32 or Int64" — it gives System.UInt64 for
 *        non-negative operands, a type nothing else in the language produces.
 *   P45  "the shift count is masked mod 32"  — right for Int32, but Int64 masks
 *        mod 64 and a NEGATIVE count masks rather than erroring.
 *   P41  "a duplicate hashtable key overwrites"  — it raises, and with a raw
 *        .NET ArgumentException whose error id is the type name.
 *
 * A note on `arithmetic()` returning `{ value, typeName }`: the type is real,
 * observable information that the value alone has lost, which is exactly what
 * `2147483647 + 1` demonstrates.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  arithmetic,
  bitwise,
  bitwiseNot,
  negate,
  numericDivide,
  parseNumericString,
  PSRuntimeError,
  roundHalfToEven,
  unaryPlus,
  widen,
} from '../../src/operators/index.ts';
import { psObject, type PSValue } from '../../src/pipeline/psobject.ts';

const t = (op: '+' | '-' | '*' | '/' | '%', a: PSValue, b: PSValue): [PSValue, string] => {
  const r = arithmetic(op, a, b);
  return [r.value, r.typeName];
};

const id = (error: unknown): string => {
  assert.ok(error instanceof PSRuntimeError);
  return error.record.fullyQualifiedErrorId;
};

// ---------------------------------------------------------------------------
// widening
// ---------------------------------------------------------------------------

describe('integer overflow escapes to Double, never to Int64', () => {
  it('2147483647 + 1 is a DOUBLE, though a literal of that size is an Int64', () => {
    // pwsh: 2147483647 + 1          ->  2147483648   System.Double
    // pwsh: 2147483648              ->  2147483648   System.Int64
    // pwsh: [int]2147483647 + [int]1 ->  2147483648  System.Double
    // The same number with two different types is the whole reason arithmetic()
    // reports a type instead of leaving it to be re-derived from the value.
    assert.deepEqual(t('+', 2147483647, 1), [2147483648, 'System.Double']);
    assert.deepEqual(t('+', 2147483646, 1), [2147483647, 'System.Int32']);
  });

  it('subtraction and multiplication escape the same way', () => {
    // pwsh: -2147483648 - 1  ->  -2147483649  System.Double
    // pwsh: 2147483647 * 2   ->  4294967294   System.Double
    // pwsh: 100000 * 100000  ->  10000000000  System.Double
    assert.deepEqual(t('-', -2147483648, 1), [-2147483649, 'System.Double']);
    assert.deepEqual(t('*', 2147483647, 2), [4294967294, 'System.Double']);
    assert.deepEqual(t('*', 100000, 100000), [10000000000, 'System.Double']);
  });

  it('escapes again at the Int64 boundary', () => {
    // pwsh: 4611686018427387904 * 2  ->  9.22337203685478E+18  System.Double
    // pwsh: 9223372036854775807 * 2  ->  1.84467440737095E+19  System.Double
    // pwsh: 2147483648 + 1           ->  2147483649            System.Int64
    // pwsh: 10000000000 / 2          ->  5000000000            System.Int64
    assert.equal(arithmetic('*', 4611686018427387904, 2).typeName, 'System.Double');
    assert.equal(arithmetic('*', 9223372036854775807, 2).typeName, 'System.Double');
    assert.deepEqual(t('+', 2147483648, 1), [2147483649, 'System.Int64']);
    assert.deepEqual(t('/', 10000000000, 2), [5000000000, 'System.Int64']);
  });

  it('RECORDS A LIMIT: Int64.MaxValue itself is not representable, so +0 diverges', () => {
    // pwsh: 9223372036854775807 + 0  ->  9223372036854775807  System.Int64
    // Here it answers Double, because the literal rounded to 2^63 before any
    // arithmetic saw it -- the same JavaScript number that 4611686018427387904*2
    // produces, which pwsh DOES call an overflow. No rule can separate them; the
    // exclusive bound is chosen so the genuine overflow above is detected.
    // Written down as a test so the trade is visible rather than folklore.
    assert.equal(arithmetic('+', 9223372036854775807, 0).typeName, 'System.Double');
    assert.equal(9223372036854775807, 9223372036854775808, 'the same double');
  });

  it('widens Decimal over Double, in both orders', () => {
    // pwsh: [decimal]1 + [double]1  ->  2  System.Decimal
    // pwsh: [double]1 + [decimal]1  ->  2  System.Decimal
    // Every other language reached for promotes to the wider FLOAT here.
    assert.equal(widen('System.Decimal', 'System.Double'), 'System.Decimal');
    assert.equal(widen('System.Double', 'System.Decimal'), 'System.Decimal');
    assert.equal(widen('System.Int32', 'System.Int64'), 'System.Int64');
    assert.equal(widen('System.Int32', 'System.Double'), 'System.Double');
  });
});

describe('division does not truncate, and does not always throw on zero', () => {
  it('an inexact integer quotient becomes a Double and an exact one stays integral', () => {
    // pwsh: 5 / 2   ->  2.5  System.Double
    // pwsh: 4 / 2   ->  2    System.Int32
    // pwsh: -5 / 2  ->  -2.5 System.Double
    // pwsh: 10000000000 / 2  ->  5000000000  System.Int64
    assert.deepEqual(t('/', 5, 2), [2.5, 'System.Double']);
    assert.deepEqual(t('/', 4, 2), [2, 'System.Int32']);
    assert.deepEqual(t('/', -5, 2), [-2.5, 'System.Double']);
    assert.deepEqual(t('/', 10000000000, 2), [5000000000, 'System.Int64']);
  });

  it('an integer division that overflows escapes to Double as well', () => {
    // pwsh: [int]::MinValue / -1  ->  2147483648  System.Double
    assert.deepEqual(t('/', -2147483648, -1), [2147483648, 'System.Double']);
  });

  it('1 / 0 raises with the id and message the corpus records', () => {
    // pwsh: 1 / 0
    //   FullyQualifiedErrorId : RuntimeException
    //   CategoryInfo.Category : NotSpecified
    //   Exception type        : System.Management.Automation.RuntimeException
    //   InnerException        : System.DivideByZeroException
    //   Message               : Attempted to divide by zero.
    assert.throws(
      () => arithmetic('/', 1, 0),
      (error: unknown) => {
        assert.ok(error instanceof PSRuntimeError);
        assert.equal(error.record.fullyQualifiedErrorId, 'RuntimeException');
        assert.equal(error.record.category, 'NotSpecified');
        assert.equal(error.record.exceptionType, 'System.Management.Automation.RuntimeException');
        assert.equal(error.record.message, 'Attempted to divide by zero.');
        return true;
      },
    );
    // pwsh: 1 % 0        ->  the same error
    // pwsh: 1 / $null    ->  the same error
    assert.equal(id(getError(() => arithmetic('%', 1, 0))), 'RuntimeException');
    assert.equal(id(getError(() => arithmetic('/', 1, null))), 'RuntimeException');
  });

  it('WRONG BEFORE PROBING: dividing a DOUBLE by zero is Infinity, not an error', () => {
    // Predicted that division by zero always raised. Only INTEGER and DECIMAL
    // division do; a Double is IEEE-754, exactly as .NET is.
    // pwsh: 2.5 / 0    ->  Infinity   System.Double
    // pwsh: -2.5 / 0   ->  -Infinity  System.Double
    // pwsh: 0.5 / 0    ->  Infinity   System.Double
    // pwsh: 2.5 % 0    ->  NaN        System.Double
    assert.deepEqual(t('/', 2.5, 0), [Infinity, 'System.Double']);
    assert.deepEqual(t('/', -2.5, 0), [-Infinity, 'System.Double']);
    assert.deepEqual(t('/', 0.5, 0), [Infinity, 'System.Double']);
    assert.ok(Number.isNaN(arithmetic('%', 2.5, 0).value as number));

    // The measured source was `1.0 / 0`, which this value model CANNOT spell:
    // JavaScript's 1.0 and 1 are the same number, so a whole Double is
    // indistinguishable from an Int32 -- psobject.ts's typeNameOf says the same.
    // The semantic rule is therefore exercised directly on typed operands.
    const double = (value: number): { value: number; typeName: 'System.Double' } => ({
      value,
      typeName: 'System.Double',
    });
    assert.deepEqual(numericDivide(double(1), double(0)), {
      value: Infinity,
      typeName: 'System.Double',
    });
    assert.ok(Number.isNaN(numericDivide(double(0), double(0)).value));
  });

  it('remainder takes the sign of the dividend, like .NET', () => {
    // pwsh: 5 % 2    ->  1    System.Int32
    // pwsh: -5 % 2   ->  -1   System.Int32
    // pwsh: 5.5 % 2  ->  1.5  System.Double
    // pwsh: 5 % 2.5  ->  0    System.Double
    assert.deepEqual(t('%', 5, 2), [1, 'System.Int32']);
    assert.deepEqual(t('%', -5, 2), [-1, 'System.Int32']);
    assert.deepEqual(t('%', 5.5, 2), [1.5, 'System.Double']);
    assert.deepEqual(t('%', 5, 2.5), [0, 'System.Double']);
  });
});

// ---------------------------------------------------------------------------
// mixed operands
// ---------------------------------------------------------------------------

describe('+ is four operators wearing one name, and the LEFT operand picks', () => {
  it("concatenates when the left is a string and adds when it is a number", () => {
    // pwsh: '1' + 2     ->  '12'  System.String
    // pwsh: 2 + '1'     ->  3     System.Int32
    // pwsh: 'abc' + 1   ->  abc1  System.String
    // pwsh: '1.5' + 1   ->  1.51  System.String
    assert.deepEqual(t('+', '1', 2), ['12', 'System.String']);
    assert.deepEqual(t('+', 2, '1'), [3, 'System.Int32']);
    assert.deepEqual(t('+', 'abc', 1), ['abc1', 'System.String']);
    assert.deepEqual(t('+', '1.5', 1), ['1.51', 'System.String']);
  });

  it('reads a numeric string as the type its LITERAL form would have', () => {
    // pwsh: 1 + '1.5'            ->  2.5          System.Double   <- NOT 3
    // pwsh: 1 + '2'              ->  3            System.Int32
    // pwsh: 1 + '2147483648'     ->  2147483649   System.Int64
    // pwsh: 1 + '1e3'            ->  1001         System.Double
    // pwsh: 1 + '0x10'           ->  17           System.Int32
    // pwsh: 1 + '1,000'          ->  1001         System.Int32
    // pwsh: 1 + ' 2 '            ->  3            System.Int32
    // pwsh: 1 + ''               ->  1            System.Int32
    // pwsh: 1 + '1.5d'           ->  2.5          System.Decimal
    assert.deepEqual(t('+', 1, '1.5'), [2.5, 'System.Double']);
    assert.deepEqual(t('+', 1, '2'), [3, 'System.Int32']);
    assert.deepEqual(t('+', 1, '2147483648'), [2147483649, 'System.Int64']);
    assert.deepEqual(t('+', 1, '1e3'), [1001, 'System.Double']);
    assert.deepEqual(t('+', 1, '0x10'), [17, 'System.Int32']);
    assert.deepEqual(t('+', 1, '1,000'), [1001, 'System.Int32']);
    assert.deepEqual(t('+', 1, ' 2 '), [3, 'System.Int32']);
    assert.deepEqual(t('+', 1, ''), [1, 'System.Int32']);
    assert.deepEqual(t('+', 1, '1.5d'), [2.5, 'System.Decimal']);
  });

  it("rejects 'Infinity' and 'NaN', which JavaScript's Number() would accept", () => {
    // pwsh: 1 + 'Infinity'  ->  Cannot convert value "Infinity" to type "System.Int32".
    // pwsh: 1 + 'NaN'       ->  the same shape
    assert.equal(parseNumericString('Infinity'), null);
    assert.equal(parseNumericString('NaN'), null);
    assert.equal(Number('Infinity'), Infinity, 'JavaScript disagrees, which is the point');
    assert.equal(id(getError(() => arithmetic('+', 1, 'Infinity'))), 'InvalidCastFromStringToInteger');
  });

  it('raises InvalidCastFromStringToInteger for a string that is not a number', () => {
    // pwsh: 1 + 'abc'
    //   id  = InvalidCastFromStringToInteger
    //   msg = Cannot convert value "abc" to type "System.Int32".
    //         Error: "The input string 'abc' was not in a correct format."
    assert.throws(
      () => arithmetic('+', 1, 'abc'),
      (error: unknown) => {
        assert.ok(error instanceof PSRuntimeError);
        assert.equal(error.record.fullyQualifiedErrorId, 'InvalidCastFromStringToInteger');
        assert.equal(
          error.record.message,
          'Cannot convert value "abc" to type "System.Int32". ' +
            'Error: "The input string \'abc\' was not in a correct format."',
        );
        return true;
      },
    );
  });

  it('appends to an array, and refuses to add an array to a number', () => {
    // pwsh: @(1,2) + 3       ->  Object[] [1,2,3]
    // pwsh: @(1,2) + @(3,4)  ->  Object[] [1,2,3,4]
    // pwsh: @(1,2) + $null   ->  Count 3      <- the null is APPENDED
    // pwsh: 3 + @(1,2)       ->  MethodNotFound: [System.Object[]] has no op_Addition
    assert.deepEqual(t('+', [1, 2], 3), [[1, 2, 3], 'System.Object[]']);
    assert.deepEqual(t('+', [1, 2], [3, 4]), [[1, 2, 3, 4], 'System.Object[]']);
    assert.equal((arithmetic('+', [1, 2], null).value as readonly unknown[]).length, 3);
    assert.equal(id(getError(() => arithmetic('+', 3, [1, 2]))), 'MethodNotFound');
    assert.match(
      getPSError(() => arithmetic('+', 3, [1, 2])).record.message,
      /\[System\.Object\[\]\] does not contain a method named 'op_Addition'/,
    );
  });

  it('merges hashtables, and WRONG BEFORE PROBING: a duplicate key RAISES', () => {
    // Predicted last-one-wins.
    // pwsh: @{a=1} + @{b=2}         ->  a hashtable with keys a, b
    // pwsh: @{a=1} + @{a=2}
    //   id   = System.ArgumentException     <- the TYPE NAME, as the id
    //   type = System.ArgumentException     <- NOT a RuntimeException
    //   msg  = Item has already been added. Key in dictionary: 'a'  Key being added: 'a'
    // pwsh: @{a=1} + @(1)  ->  id = AddHashTableToNonHashTable
    const merged = arithmetic('+', psObject({ a: 1 }), psObject({ b: 2 })).value;
    assert.deepEqual(Object.keys((merged as { properties: object }).properties), ['a', 'b']);

    const dup = getPSError(() => arithmetic('+', psObject({ a: 1 }), psObject({ a: 2 })));
    assert.equal(dup.record.fullyQualifiedErrorId, 'System.ArgumentException');
    assert.equal(dup.record.exceptionType, 'System.ArgumentException');
    assert.equal(
      dup.record.message,
      "Item has already been added. Key in dictionary: 'a'  Key being added: 'a'",
    );
    assert.equal(
      id(getError(() => arithmetic('+', psObject({ a: 1 }), [1]))),
      'AddHashTableToNonHashTable',
    );
  });

  it('treats $null as an identity, taking the other operand`s kind', () => {
    // pwsh: $null + 1    ->  1    System.Int32
    // pwsh: $null + 'a'  ->  a    System.String
    // pwsh: 1 + $null    ->  1    System.Int32
    // pwsh: 'a' + $null  ->  a    System.String
    assert.deepEqual(t('+', null, 1), [1, 'System.Int32']);
    assert.deepEqual(t('+', null, 'a'), ['a', 'System.String']);
    assert.deepEqual(t('+', 1, null), [1, 'System.Int32']);
    assert.deepEqual(t('+', 'a', null), ['a', 'System.String']);
  });

  it('converts booleans to 1 and 0', () => {
    // pwsh: 1 + $true  ->  2  System.Int32      $true + 1  ->  2  System.Int32
    // pwsh: 'a' + $true -> aTrue                'a' + 1.5  ->  a1.5
    assert.deepEqual(t('+', 1, true), [2, 'System.Int32']);
    assert.deepEqual(t('+', true, 1), [2, 'System.Int32']);
    assert.deepEqual(t('+', 'a', true), ['aTrue', 'System.String']);
    assert.deepEqual(t('+', 'a', 1.5), ['a1.5', 'System.String']);
  });
});

describe('* repeats strings and arrays; - / % are numeric only', () => {
  it('repeats', () => {
    // pwsh: 'ab' * 3   ->  ababab   System.String
    // pwsh: '1' * 2    ->  11       System.String
    // pwsh: 'ab' * 0   ->  ''
    // pwsh: 'ab' * 2.6 ->  ababab   (2.6 rounds to 3)
    // pwsh: 'ab' * '2' ->  abab
    // pwsh: @(1,2) * 2 ->  Object[] [1,2,1,2]
    // pwsh: @(1) * 2.6 ->  Count 3
    assert.deepEqual(t('*', 'ab', 3), ['ababab', 'System.String']);
    assert.deepEqual(t('*', '1', 2), ['11', 'System.String']);
    assert.deepEqual(t('*', 'ab', 0), ['', 'System.String']);
    assert.deepEqual(t('*', 'ab', 2.6), ['ababab', 'System.String']);
    assert.deepEqual(t('*', 'ab', '2'), ['abab', 'System.String']);
    assert.deepEqual(t('*', [1, 2], 2), [[1, 2, 1, 2], 'System.Object[]']);
    assert.equal((arithmetic('*', [1], 2.6).value as readonly unknown[]).length, 3);
  });

  it('raises DIFFERENT errors for a negative count on a string and on an array', () => {
    // pwsh: 'ab' * -1  ->  id = System.ArgumentOutOfRangeException
    //                      msg = times ('-1') must be a non-negative value. (Parameter 'times')
    // pwsh: @(1) * -1  ->  id = InvalidCastIConvertible, target System.UInt32
    assert.equal(id(getError(() => arithmetic('*', 'ab', -1))), 'System.ArgumentOutOfRangeException');
    assert.equal(id(getError(() => arithmetic('*', [1], -1))), 'InvalidCastIConvertible');
  });

  it('converts a string operand for -, / and % rather than concatenating', () => {
    // pwsh: '1' - 2  ->  -1   System.Int32
    // pwsh: '1' / 2  ->  0.5  System.Double
    // pwsh: 1 - '1.5' -> -0.5 System.Double
    // pwsh: 'a' - 'b' ->  Cannot convert value "a" to type "System.Int32".
    assert.deepEqual(t('-', '1', 2), [-1, 'System.Int32']);
    assert.deepEqual(t('/', '1', 2), [0.5, 'System.Double']);
    assert.deepEqual(t('-', 1, '1.5'), [-0.5, 'System.Double']);
    const err = getPSError(() => arithmetic('-', 'a', 'b'));
    assert.equal(err.record.fullyQualifiedErrorId, 'InvalidCastFromStringToInteger');
    assert.match(err.record.message, /Cannot convert value "a" to type "System\.Int32"/);
  });

  it('has no subtraction for arrays at all', () => {
    // pwsh: @(1,2) - 1  ->  MethodNotFound: [System.Object[]] has no op_Subtraction
    assert.equal(id(getError(() => arithmetic('-', [1, 2], 1))), 'MethodNotFound');
  });
});

// ---------------------------------------------------------------------------
// bitwise
// ---------------------------------------------------------------------------

describe('bitwise operators, including the type nobody expects', () => {
  it('stays Int32 for Int32 operands', () => {
    // pwsh: 5 -band 3  ->  1  System.Int32       5 -bor 3   ->  7  System.Int32
    // pwsh: 5 -bxor 3  ->  6  System.Int32       '5' -band 3 -> 1  System.Int32
    // pwsh: $true -band $true -> 1 System.Int32  $null -band 3 -> 0 System.Int32
    assert.deepEqual(bitwise('-band', 5, 3), { value: 1, typeName: 'System.Int32' });
    assert.deepEqual(bitwise('-bor', 5, 3), { value: 7, typeName: 'System.Int32' });
    assert.deepEqual(bitwise('-bxor', 5, 3), { value: 6, typeName: 'System.Int32' });
    assert.deepEqual(bitwise('-band', '5', 3), { value: 1, typeName: 'System.Int32' });
    assert.deepEqual(bitwise('-band', true, true), { value: 1, typeName: 'System.Int32' });
    assert.deepEqual(bitwise('-band', null, 3), { value: 0, typeName: 'System.Int32' });
  });

  it('WRONG BEFORE PROBING: a non-integer operand routes through UInt64', () => {
    // Predicted Int32 or Int64. Measured:
    //   [double]5.0 -band 3  ->  1  System.UInt64
    //   0.5 -band 3          ->  0  System.UInt64
    //   1.5 -band 2.5        ->  2  System.UInt64
    //   1.5 -bor 0           ->  2  System.UInt64
    //   1.5 -bxor 0          ->  2  System.UInt64
    //   1e19 -band 1         ->  0  System.UInt64
    // Nothing about -band suggests an unsigned 64-bit type should appear.
    // `5.0` is not spellable here (JavaScript's 5.0 IS 5), so the rows used are
    // the ones with a real fractional part; the rule is the same one.
    assert.deepEqual(bitwise('-band', 0.5, 3), { value: 0, typeName: 'System.UInt64' });
    assert.deepEqual(bitwise('-band', 1.5, 2.5), { value: 2, typeName: 'System.UInt64' });
    assert.deepEqual(bitwise('-bor', 1.5, 0), { value: 2, typeName: 'System.UInt64' });
    assert.deepEqual(bitwise('-bxor', 1.5, 0), { value: 2, typeName: 'System.UInt64' });
    assert.deepEqual(bitwise('-band', 1e19, 1), { value: 0, typeName: 'System.UInt64' });
  });

  it('flips to Int64 when ANY operand is negative, judged before rounding', () => {
    // pwsh: -5.4 -band 3           ->  3   System.Int64
    // pwsh: -0.5 -band 3           ->  0   System.Int64   <- -0.5 ROUNDS to 0, so
    //                                                        the sign test is on
    //                                                        the ORIGINAL value
    // pwsh: 5.5 -band -3           ->  4   System.Int64
    // pwsh: -5.5 -band 3           ->  2   System.Int64
    // pwsh: 2.5 -band -1           ->  2   System.Int64
    // pwsh: -1.5 -band -2.5        ->  -2  System.Int64
    assert.deepEqual(bitwise('-band', -5.4, 3), { value: 3, typeName: 'System.Int64' });
    assert.deepEqual(bitwise('-band', -0.5, 3), { value: 0, typeName: 'System.Int64' });
    assert.deepEqual(bitwise('-band', 5.5, -3), { value: 4, typeName: 'System.Int64' });
    assert.deepEqual(bitwise('-band', -5.5, 3), { value: 2, typeName: 'System.Int64' });
    assert.deepEqual(bitwise('-band', 2.5, -1), { value: 2, typeName: 'System.Int64' });
    assert.deepEqual(bitwise('-band', -1.5, -2.5), { value: -2, typeName: 'System.Int64' });
  });

  it('rounds half to EVEN before masking, not half up', () => {
    // pwsh: 5.4 -band 3  ->  1  (5.4 -> 5)
    // pwsh: 5.5 -band 3  ->  2  (5.5 -> 6, not 5)
    // pwsh: 6.5 -band 3  ->  2  (6.5 -> 6, not 7)
    // pwsh: 3.5 -band 3  ->  0  (3.5 -> 4)
    // pwsh: 2.5 -band 3  ->  2  (2.5 -> 2)
    assert.equal(bitwise('-band', 5.4, 3).value, 1);
    assert.equal(bitwise('-band', 5.5, 3).value, 2);
    assert.equal(bitwise('-band', 6.5, 3).value, 2);
    assert.equal(bitwise('-band', 3.5, 3).value, 0);
    assert.equal(bitwise('-band', 2.5, 3).value, 2);
    assert.equal(roundHalfToEven(0.5), 0);
    assert.equal(roundHalfToEven(1.5), 2);
    assert.equal(roundHalfToEven(-0.5), 0);
    assert.equal(roundHalfToEven(-1.5), -2);
    assert.notEqual(roundHalfToEven(2.5), Math.round(2.5));
  });

  it('raises naming System.UInt64 when the operand will not fit', () => {
    // pwsh: -bnot 1e20
    //   id  = ConvertToFinalInvalidCastException
    //   msg = Cannot convert the "1E+20" value of type "System.Double" to type "System.UInt64".
    // The id, the category and the TARGET type are exact. The FROM type reads
    // System.Decimal here and System.Double in pwsh, because psobject.ts types
    // any integral value above the Int64 range as Decimal, and every double big
    // enough to overflow UInt64 is integral in JavaScript. Recorded, not smoothed.
    const err = getPSError(() => bitwiseNot(1e20));
    assert.equal(err.record.fullyQualifiedErrorId, 'ConvertToFinalInvalidCastException');
    assert.ok(err.record.message.startsWith('Cannot convert the "1E+20" value of type '));
    assert.ok(err.record.message.endsWith('to type "System.UInt64".'));
  });
});

describe('shifts mask their count instead of clamping it', () => {
  it('masks against 31 for an Int32 and 63 for an Int64', () => {
    // pwsh: 1 -shl 1        ->  2            System.Int32
    // pwsh: 1 -shl 31       ->  -2147483648  System.Int32
    // pwsh: 1 -shl 32       ->  1            System.Int32   <- masked, not zero
    // pwsh: 1 -shl 33       ->  2            System.Int32
    // pwsh: 1 -shl 63       ->  -2147483648  System.Int32
    // pwsh: 2147483648 -shl 1 -> 4294967296  System.Int64
    assert.deepEqual(bitwise('-shl', 1, 1), { value: 2, typeName: 'System.Int32' });
    assert.deepEqual(bitwise('-shl', 1, 31), { value: -2147483648, typeName: 'System.Int32' });
    assert.deepEqual(bitwise('-shl', 1, 32), { value: 1, typeName: 'System.Int32' });
    assert.deepEqual(bitwise('-shl', 1, 33), { value: 2, typeName: 'System.Int32' });
    assert.deepEqual(bitwise('-shl', 1, 63), { value: -2147483648, typeName: 'System.Int32' });
    assert.deepEqual(bitwise('-shl', 2147483648, 1), { value: 4294967296, typeName: 'System.Int64' });
  });

  it('WRONG BEFORE PROBING: a NEGATIVE count masks rather than erroring', () => {
    // pwsh: 1 -shl -1  ->  -2147483648  System.Int32   (-1 masks to 31)
    assert.deepEqual(bitwise('-shl', 1, -1), { value: -2147483648, typeName: 'System.Int32' });
  });

  it('-shr propagates the sign', () => {
    // pwsh: -8 -shr 1        ->  -4  System.Int32
    // pwsh: -1 -shr 1        ->  -1  System.Int32
    // pwsh: -1 -shr 32       ->  -1  System.Int32
    // pwsh: 8 -shr 2         ->  2   System.Int32
    // pwsh: -2147483648 -shr 31 -> -1 System.Int32
    assert.equal(bitwise('-shr', -8, 1).value, -4);
    assert.equal(bitwise('-shr', -1, 1).value, -1);
    assert.equal(bitwise('-shr', -1, 32).value, -1);
    assert.equal(bitwise('-shr', 8, 2).value, 2);
    assert.equal(bitwise('-shr', -2147483648, 31).value, -1);
  });

  it('takes the width from the LEFT operand only, so 1.5 -shl 1 is Int32 not UInt64', () => {
    // pwsh: 1.5 -shl 1  ->  4  System.Int32     <- compare 1.5 -band 2 -> UInt64
    // pwsh: '2' -shl 1  ->  4  System.Int32
    // pwsh: 1 -shl 1.9  ->  4  System.Int32     (1.9 rounds to 2)
    // pwsh: 1 -shl $null ->  1  System.Int32
    // pwsh: $null -shl 1 ->  0  System.Int32
    assert.deepEqual(bitwise('-shl', 1.5, 1), { value: 4, typeName: 'System.Int32' });
    assert.deepEqual(bitwise('-shl', '2', 1), { value: 4, typeName: 'System.Int32' });
    assert.deepEqual(bitwise('-shl', 1, 1.9), { value: 4, typeName: 'System.Int32' });
    assert.deepEqual(bitwise('-shl', 1, null), { value: 1, typeName: 'System.Int32' });
    assert.deepEqual(bitwise('-shl', null, 1), { value: 0, typeName: 'System.Int32' });
  });
});

describe('-bnot is narrower than the binary bitwise operators', () => {
  it('answers Int32 unless the operand is already Int64', () => {
    // pwsh: -bnot 0          ->  -1           System.Int32
    // pwsh: -bnot 5          ->  -6           System.Int32
    // pwsh: -bnot -1         ->  0            System.Int32
    // pwsh: -bnot 2147483647 ->  -2147483648  System.Int32
    // pwsh: -bnot 2147483648 ->  -2147483649  System.Int64
    // pwsh: -bnot [long]0    ->  -1           System.Int64
    assert.deepEqual(bitwiseNot(0), { value: -1, typeName: 'System.Int32' });
    assert.deepEqual(bitwiseNot(5), { value: -6, typeName: 'System.Int32' });
    assert.deepEqual(bitwiseNot(-1), { value: 0, typeName: 'System.Int32' });
    assert.deepEqual(bitwiseNot(2147483647), { value: -2147483648, typeName: 'System.Int32' });
    assert.deepEqual(bitwiseNot(2147483648), { value: -2147483649, typeName: 'System.Int64' });
    assert.deepEqual(bitwiseNot(0n), { value: -1, typeName: 'System.Int64' });
  });

  it('rounds a non-integer operand but still answers Int32', () => {
    // pwsh: -bnot 1.5    ->  -3  System.Int32   (1.5 -> 2)
    // pwsh: -bnot 2.5    ->  -3  System.Int32   (2.5 -> 2)
    // pwsh: -bnot $true  ->  -2  System.Int32
    // pwsh: -bnot '5'    ->  -6  System.Int32
    // pwsh: -bnot $null  ->  -1  System.Int32
    assert.deepEqual(bitwiseNot(1.5), { value: -3, typeName: 'System.Int32' });
    assert.deepEqual(bitwiseNot(2.5), { value: -3, typeName: 'System.Int32' });
    assert.deepEqual(bitwiseNot(true), { value: -2, typeName: 'System.Int32' });
    assert.deepEqual(bitwiseNot('5'), { value: -6, typeName: 'System.Int32' });
    assert.deepEqual(bitwiseNot(null), { value: -1, typeName: 'System.Int32' });
  });

  it('WRONG BEFORE PROBING: a large operand answers UInt64 rather than raising', () => {
    // Predicted the cascade stopped at Int64 and that anything past it raised.
    // pwsh: -bnot 1e19  ->  8446744073709551615  System.UInt64
    assert.deepEqual(bitwiseNot(1e19), {
      value: 8446744073709551615,
      typeName: 'System.UInt64',
    });
  });
});

// ---------------------------------------------------------------------------
// unary
// ---------------------------------------------------------------------------

describe('unary - and +', () => {
  it('negates numbers and numeric strings', () => {
    // pwsh: -(1)     ->  -1  System.Int32
    // pwsh: -'1'     ->  -1  System.Int32
    // pwsh: -$true   ->  -1  System.Int32
    // pwsh: -(2147483648) -> -2147483648  System.Int64   <- stays Int64
    assert.deepEqual(negate(1), { value: -1, typeName: 'System.Int32' });
    assert.deepEqual(negate('1'), { value: -1, typeName: 'System.Int32' });
    assert.deepEqual(negate(true), { value: -1, typeName: 'System.Int32' });
    assert.deepEqual(negate(2147483648), { value: -2147483648, typeName: 'System.Int64' });
  });

  it('raises for a non-numeric string, and MethodNotFound for an array', () => {
    // pwsh: -'a'      ->  id = InvalidCastFromStringToInteger
    // pwsh: -@(1,2)   ->  id = MethodNotFound, naming op_Subtraction
    assert.equal(id(getError(() => negate('a'))), 'InvalidCastFromStringToInteger');
    const arr = getPSError(() => negate([1, 2]));
    assert.equal(arr.record.fullyQualifiedErrorId, 'MethodNotFound');
    assert.match(arr.record.message, /op_Subtraction/);
  });

  it("unary + CONVERTS rather than doing nothing", () => {
    // pwsh: +'1'  ->  1  System.Int32
    assert.deepEqual(unaryPlus('1'), { value: 1, typeName: 'System.Int32' });
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function getError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  assert.fail('expected a throw');
}

function getPSError(run: () => unknown): PSRuntimeError {
  const error = getError(run);
  assert.ok(error instanceof PSRuntimeError);
  return error;
}
