/**
 * numeric.ts — PowerShell's numeric tower, as measured rather than as assumed.
 *
 * THE PROBLEM THIS SOLVES
 *
 * `typeNameOf` in psobject.ts types a VALUE: 2147483648 is Int64 because a
 * literal of that size is Int64. Arithmetic does not work that way, and the
 * comment there says so:
 *
 *   2147483647 + 1   ->  System.Double        <- NOT Int64
 *   2147483648       ->  System.Int64         <- the same magnitude, as a literal
 *
 * Both measured in pwsh 7.6.5. An Int32 sum that overflows retries in DOUBLE,
 * skipping Int64 entirely, so the result type cannot be recovered from the
 * result value. That is why arithmetic here returns `{ value, typeName }` and
 * not just a number: the type is real information that the value has lost.
 *
 * THE WIDENING TABLE, ALL MEASURED
 *
 *   Int32   + Int32    -> Int32,  overflow -> Double
 *   Int32   + Int64    -> Int64,  overflow -> Double
 *   Int64   + Int64    -> Int64,  overflow -> Double
 *   Int32   + Double   -> Double
 *   Decimal + Double   -> Decimal      <- decimal WINS over double, both orders
 *   byte/int16 pairs   -> Int32        (small types promote before adding)
 *
 * DIVISION IS THE ONE THAT SURPRISES PEOPLE
 *
 *   5 / 2               -> 2.5   Double        integer division is NOT truncating
 *   4 / 2               -> 2     Int32         but an EXACT quotient stays integral
 *   [long]5 / [long]2   -> 2.5   Double
 *   10000000000 / 2     -> 5000000000  Int64
 *   [int]::MinValue / -1 -> 2147483648 Double  (the overflow escape again)
 *   1 / 0               -> THROWS
 *   1.0 / 0             -> Infinity            <- does NOT throw
 *   1.0 % 0             -> NaN                 <- does NOT throw
 *
 * The last two were predicted wrong: only INTEGER and DECIMAL division by zero
 * raises. A double divided by zero is IEEE-754 and produces an infinity, exactly
 * as .NET does.
 *
 * WHAT IS NOT MODELLED, AND WHY IT IS SAID OUT LOUD
 *
 * Decimal is carried as a JavaScript double. `[decimal]1/3` in pwsh is
 * 0.3333333333333333333333333333 — twenty-eight significant digits, which a
 * binary64 cannot hold. Decimal is only reachable in this project through values
 * above the Int64 range (`typeNameOf` types those as Decimal), so the exposure
 * is small, but it is a real gap and it is recorded here rather than discovered
 * later. UInt32/UInt64/Byte/Int16/Single arise in pwsh only from explicit casts,
 * which this project has no syntax for — with ONE exception that is not optional
 * to model, because it is reachable without any cast at all: see `bitwiseTarget`.
 */

import { typeNameOf, type PSValue } from '../pipeline/psobject.ts';
import { toPSString } from '../formatting/to-string.ts';
import {
  convertToFinalInvalidCastError,
  decimalOverflowError,
  divideByZeroError,
  invalidCastFromStringError,
  raise,
} from './errors.ts';

/**
 * The .NET numeric types this project can actually produce.
 *
 * A string union rather than an enum: `erasableSyntaxOnly` forbids enums, and a
 * union that IS the type name means no second mapping table can drift from the
 * first.
 */
export type NumericTypeName =
  | 'System.Int32'
  | 'System.Int64'
  | 'System.Double'
  | 'System.Decimal'
  | 'System.UInt64';

/** A number that still knows what .NET would call it. */
export interface TypedNumber {
  readonly value: number;
  readonly typeName: NumericTypeName;
}

export const INT32_MIN = -2147483648;
export const INT32_MAX = 2147483647;
/**
 * Int64's bounds, as doubles.
 *
 * `Int64.MaxValue` is 2^63-1 and is NOT exactly representable as a double: the
 * nearest double is 2^63. So the Int64 range test here is `>= -2^63` and
 * `< 2^63`, EXCLUSIVE at the top, and that choice has a measured consequence in
 * each direction:
 *
 *   4611686018427387904 * 2  ->  System.Double   pwsh, and this agrees:
 *                                the product is exactly 2^63, a real overflow
 *   9223372036854775807 + 0  ->  System.Int64    pwsh; this answers Double,
 *                                because the literal ALREADY rounded to 2^63
 *                                before any arithmetic saw it
 *
 * The two inputs are the same JavaScript number, so no rule can get both right.
 * The exclusive bound is chosen because detecting a genuine overflow is the
 * behaviour being modelled, and an inclusive bound would make the Int64 overflow
 * escape unreachable — a rule that never fires is worse than one that fires
 * once too often on a value the value model could not hold in the first place.
 * psobject.ts already says the same thing about `typeNameOf` above Int64.
 */
export const INT64_MIN = -9223372036854775808;
export const INT64_LIMIT = 9223372036854775808;
export const UINT64_MAX = 18446744073709551615;

const isInt32 = (n: number): boolean => Number.isInteger(n) && n >= INT32_MIN && n <= INT32_MAX;
const isInt64 = (n: number): boolean =>
  Number.isInteger(n) && n >= INT64_MIN && n < INT64_LIMIT;
const isUInt64 = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= UINT64_MAX;

// ---------------------------------------------------------------------------
// getting a typed number out of a PSValue
// ---------------------------------------------------------------------------

/**
 * Parse a string the way PowerShell does when arithmetic forces it to.
 *
 * The type the string yields is the type its LITERAL FORM would have had, and
 * then normal widening applies. This is the rule that explains a result that
 * looks wrong:
 *
 *   1 + '2'      ->  3     Int32     '2' is an Int32 literal
 *   1 + '1.5'    ->  2.5   Double    '1.5' is a Double literal, so Int32+Double
 *   1 + '1.5d'   ->  2.5   Decimal   the d suffix makes it a Decimal literal
 *   1 + '2147483648' -> 2147483649  Int64
 *   1 + '0x10'   ->  17    Int32     hex is accepted
 *   1 + '1e3'    ->  1001  Double    exponent notation makes it a Double
 *   1 + '1,000'  ->  1001  Int32     digit grouping is accepted
 *   1 + ''       ->  1     Int32     empty string is zero
 *   1 + ' 2 '    ->  3     Int32     surrounding whitespace is trimmed
 *
 * All measured. Two that are NOT accepted, also measured:
 *
 *   1 + 'Infinity'  THROWS   1 + 'NaN'  THROWS
 *
 * which rules out handing the string to JavaScript's `Number()`, since that
 * accepts both.
 */
export function parseNumericString(text: string): TypedNumber | null {
  const trimmed = text.trim();
  if (trimmed === '') return { value: 0, typeName: 'System.Int32' };

  // .NET rejects these; JavaScript's Number() accepts them. Measured: pwsh
  // raises InvalidCastFromStringToInteger for both.
  if (/^[+-]?(Infinity|NaN)$/i.test(trimmed)) return null;

  const hex = /^([+-]?)0[xX]([0-9a-fA-F]+)$/.exec(trimmed);
  if (hex !== null) {
    const magnitude = Number.parseInt(hex[2] as string, 16);
    const value = hex[1] === '-' ? -magnitude : magnitude;
    return { value, typeName: isInt32(value) ? 'System.Int32' : 'System.Int64' };
  }

  // Digit grouping: pwsh reads '1,000' as 1000. psobject.ts records not doing
  // this as a known gap on the COMPARISON path; arithmetic does do it, because
  // that is what was measured.
  const ungrouped = trimmed.replace(/,/g, '');
  const suffix = /^(.*?)([dDlL])$/.exec(ungrouped);
  const body = suffix === null ? ungrouped : (suffix[1] as string);
  const kind = suffix === null ? '' : (suffix[2] as string).toLowerCase();

  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(body)) return null;
  const value = Number(body);
  if (!Number.isFinite(value)) return null;

  if (kind === 'd') return { value, typeName: 'System.Decimal' };
  if (kind === 'l') return { value, typeName: 'System.Int64' };
  // The literal form decides: a decimal point or an exponent makes it a Double
  // even when the value is whole. Measured: 1 + '1e3' is Double 1001.
  if (/[.eE]/.test(body)) return { value, typeName: 'System.Double' };
  if (isInt32(value)) return { value, typeName: 'System.Int32' };
  if (isInt64(value)) return { value, typeName: 'System.Int64' };
  return { value, typeName: 'System.Decimal' };
}

/**
 * Read a PSValue as a number, or return null if it is not number-shaped.
 *
 * `$null` is zero and Int32-typed: measured `$null + 1` is Int32 1 and
 * `$null -band 3` is Int32 0. Booleans are 1 and 0, also Int32.
 */
export function asTypedNumber(value: PSValue): TypedNumber | null {
  if (value === null) return { value: 0, typeName: 'System.Int32' };
  if (typeof value === 'boolean') return { value: value ? 1 : 0, typeName: 'System.Int32' };
  if (typeof value === 'bigint') return { value: Number(value), typeName: 'System.Int64' };
  if (typeof value === 'number') {
    const name = typeNameOf(value);
    // typeNameOf already encodes the literal-widening rule and is the single
    // source of truth for it, so this reuses it rather than restating it.
    if (name === 'System.Int32' || name === 'System.Int64' || name === 'System.Double' || name === 'System.Decimal') {
      return { value, typeName: name };
    }
    return { value, typeName: 'System.Double' };
  }
  if (typeof value === 'string') return parseNumericString(value);
  return null;
}

/**
 * Read a PSValue as a number, raising the error pwsh raises when it cannot.
 *
 * `targetType` is the type named in the message. Measured: the message names the
 * type the engine was converting TO — the left operand's type — while the error
 * ID says `InvalidCastFromStringToInteger` regardless.
 */
export function requireNumber(value: PSValue, targetType: string): TypedNumber {
  const n = asTypedNumber(value);
  if (n === null) raise(invalidCastFromStringError(toPSString(value), targetType));
  return n;
}

// ---------------------------------------------------------------------------
// widening
// ---------------------------------------------------------------------------

/**
 * The common type of two operands, before the operation runs.
 *
 * Decimal beating Double is the counter-intuitive row and it is measured in both
 * orders: `[decimal]1 + [double]1` and `[double]1 + [decimal]1` are both
 * Decimal. Every other language the author reached for promotes to the wider
 * FLOAT; PowerShell promotes to the wider DECIMAL.
 */
export function widen(a: NumericTypeName, b: NumericTypeName): NumericTypeName {
  if (a === b) return a;
  if (a === 'System.Decimal' || b === 'System.Decimal') return 'System.Decimal';
  if (a === 'System.Double' || b === 'System.Double') return 'System.Double';
  if (a === 'System.UInt64' || b === 'System.UInt64') {
    // UInt64 only meets a signed type on the bitwise path, and there the sign of
    // the operands has already decided. Reaching here means both were unsigned.
    return 'System.UInt64';
  }
  return 'System.Int64';
}

/** Does a value fit the type it claims, after the operation ran? */
function fits(value: number, type: NumericTypeName): boolean {
  switch (type) {
    case 'System.Int32':
      return isInt32(value);
    case 'System.Int64':
      return isInt64(value);
    case 'System.UInt64':
      return isUInt64(value);
    case 'System.Decimal':
    case 'System.Double':
      return Number.isFinite(value) || type === 'System.Double';
  }
}

/**
 * Apply PowerShell's overflow escape: an integer result that does not fit
 * becomes a Double.
 *
 * This is the rule behind `2147483647 + 1` being Double. Note what it does NOT
 * do: it never promotes Int32 to Int64. Measured — the sum above is Double, and
 * `[int]2147483647 + [int]1` is Double too, so the escape is not about the
 * literal widths of the operands.
 *
 * Decimal overflow does not escape; it throws. Measured:
 * `[decimal]::MaxValue + 1` raises "Value was either too large or too small for
 * a Decimal."
 */
function settle(value: number, type: NumericTypeName): TypedNumber {
  if (fits(value, type)) return { value, typeName: type };
  if (type === 'System.Decimal') raise(decimalOverflowError());
  return { value, typeName: 'System.Double' };
}

// ---------------------------------------------------------------------------
// the arithmetic itself
// ---------------------------------------------------------------------------

export function numericAdd(a: TypedNumber, b: TypedNumber): TypedNumber {
  return settle(a.value + b.value, widen(a.typeName, b.typeName));
}

export function numericSubtract(a: TypedNumber, b: TypedNumber): TypedNumber {
  return settle(a.value - b.value, widen(a.typeName, b.typeName));
}

export function numericMultiply(a: TypedNumber, b: TypedNumber): TypedNumber {
  return settle(a.value * b.value, widen(a.typeName, b.typeName));
}

/**
 * Division, including the two behaviours that are easy to get backwards.
 *
 * 1. Integer division is EXACT-OR-PROMOTE, never truncating. `5/2` is 2.5 and
 *    `4/2` is Int32 2. An implementation that truncated would answer 2 for both
 *    and be silently wrong on the first one anybody tries.
 * 2. Division by zero throws for integers and decimals and does NOT throw for
 *    doubles. `1/0` raises; `1.0/0` is Infinity. Predicted wrong; measured.
 */
export function numericDivide(a: TypedNumber, b: TypedNumber): TypedNumber {
  const type = widen(a.typeName, b.typeName);
  const isFloat = type === 'System.Double';
  if (b.value === 0 && !isFloat) raise(divideByZeroError());
  const quotient = a.value / b.value;
  if (isFloat) return { value: quotient, typeName: 'System.Double' };
  if (type === 'System.Decimal') return settle(quotient, type);
  // An integral quotient keeps the integer type; anything else becomes a Double.
  return Number.isInteger(quotient) && fits(quotient, type)
    ? { value: quotient, typeName: type }
    : { value: quotient, typeName: 'System.Double' };
}

/**
 * Remainder. Mirrors division on the zero case: `1 % 0` throws, `1.0 % 0` is
 * NaN. JavaScript's `%` already matches .NET's sign convention — both take the
 * sign of the DIVIDEND, so `-5 % 2` is -1 in each. Verified rather than assumed,
 * because languages disagree about this constantly.
 */
export function numericRemainder(a: TypedNumber, b: TypedNumber): TypedNumber {
  const type = widen(a.typeName, b.typeName);
  const isFloat = type === 'System.Double';
  if (b.value === 0 && !isFloat) raise(divideByZeroError());
  return settle(a.value % b.value, type);
}

// ---------------------------------------------------------------------------
// the bitwise conversion, which is its own world
// ---------------------------------------------------------------------------

/**
 * .NET's "round half to even" — banker's rounding — which is what PowerShell
 * applies before a bitwise operator sees a non-integer.
 *
 * Measured, and the midpoints are the whole point:
 *   5.5 -band 3  ->  2    (5.5 rounds to 6, not 5)
 *   6.5 -band 3  ->  2    (6.5 rounds to 6, not 7)
 *   1.5 -shl 1   ->  4    (1.5 rounds to 2)
 * JavaScript's Math.round would give 6, 7 and 4 — agreeing on two of the three,
 * which is exactly the kind of near-miss that survives a shallow test.
 */
export function roundHalfToEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * The integer type a bitwise operator converts its operands to.
 *
 * THIS IS THE FINDING THAT NO AMOUNT OF READING WOULD HAVE PRODUCED. A bitwise
 * operator given a non-integer converts through an UNSIGNED 64-bit integer, and
 * the result type follows:
 *
 *   [double]5.0 -band 3   ->  1   System.UInt64      <- not Int32, not Int64
 *   0.0  -band 3          ->  0   System.UInt64
 *   0.5  -band 3          ->  0   System.UInt64
 *   1.5  -band [long]2    ->  2   System.UInt64
 *   -5.4 -band 3          ->  3   System.Int64       <- a negative operand flips it
 *   -0.5 -band 3          ->  0   System.Int64       <- the ORIGINAL sign decides,
 *                                                       not the rounded value:
 *                                                       -0.5 rounds to 0
 *   5.0  -band -3         ->  5   System.Int64       <- either operand being
 *                                                       negative is enough
 *
 * So: if every operand is non-negative the target is UInt64, otherwise Int64.
 * The `-0.5` row is what forces the test to be on the original value — rounding
 * first and then testing the sign gets that one case wrong and every other case
 * right, which is precisely how it would have shipped.
 *
 * When both operands are already integers the ordinary widening applies and
 * UInt64 never appears: `5 -band 3` is Int32 and `[long]5 -band 3` is Int64.
 */
export function bitwiseTarget(operands: readonly TypedNumber[]): NumericTypeName {
  const anyFloat = operands.some(
    (o) => o.typeName === 'System.Double' || o.typeName === 'System.Decimal',
  );
  if (!anyFloat) {
    return operands.reduce<NumericTypeName>((acc, o) => widen(acc, o.typeName), 'System.Int32');
  }
  return operands.every((o) => o.value >= 0) ? 'System.UInt64' : 'System.Int64';
}

/**
 * Convert an operand to the integer a bitwise operator will use.
 *
 * Overflowing the target is a hard error, and the message names UInt64 — which
 * is how the unsigned route above was discovered in the first place:
 *
 *   -bnot 1e20  ->  Cannot convert the "1E+20" value of type "System.Double"
 *                   to type "System.UInt64".
 */
export function toBitwiseInteger(operand: TypedNumber, target: NumericTypeName): bigint {
  const rounded = roundHalfToEven(operand.value);
  const ok = target === 'System.UInt64' ? isUInt64(rounded) : isInt64(rounded);
  if (!ok) {
    raise(
      convertToFinalInvalidCastError(
        toPSString(operand.value),
        operand.typeName,
        // Measured: the message names UInt64 even for a value that overflowed
        // because it was too LARGE for the signed range.
        'System.UInt64',
      ),
    );
  }
  return BigInt(rounded);
}

/**
 * The integer type `-bnot` settles on: the NARROWEST of Int32, Int64, UInt64
 * that holds the rounded operand.
 *
 * That cascade is measured, and the last rung is the one that would never have
 * been guessed:
 *
 *   -bnot 0            ->  -1                   System.Int32
 *   -bnot 1.5          ->  -3                   System.Int32  (1.5 rounds to 2)
 *   -bnot 2147483648   ->  -2147483649          System.Int64
 *   -bnot 1e19         ->  8446744073709551615  System.UInt64 <- not an error,
 *                                                                and not signed
 *   -bnot 1e20         ->  THROWS, naming System.UInt64
 */
export function complementTarget(operand: TypedNumber): NumericTypeName {
  // An operand that is ALREADY an integer type keeps it, however small the
  // value. Measured: `-bnot [long]0` is System.Int64, not the System.Int32 the
  // value alone would suggest.
  if (operand.typeName === 'System.Int32' || operand.typeName === 'System.Int64') {
    return operand.typeName;
  }
  if (operand.typeName === 'System.UInt64') return 'System.UInt64';
  const rounded = roundHalfToEven(operand.value);
  if (isInt32(rounded)) return 'System.Int32';
  if (isInt64(rounded)) return 'System.Int64';
  return 'System.UInt64';
}

/** Wrap a bigint back into the target's range, the way a CLR cast would. */
export function wrapToType(value: bigint, target: NumericTypeName): number {
  switch (target) {
    case 'System.Int32':
      return Number(BigInt.asIntN(32, value));
    case 'System.UInt64':
      return Number(BigInt.asUintN(64, value));
    case 'System.Int64':
    case 'System.Double':
    case 'System.Decimal':
      return Number(BigInt.asIntN(64, value));
  }
}

/** The bit width a shift count is masked against. Int32 -> 31, everything else -> 63. */
export function shiftMask(target: NumericTypeName): bigint {
  return target === 'System.Int32' ? 31n : 63n;
}
