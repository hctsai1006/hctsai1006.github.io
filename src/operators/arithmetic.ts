/**
 * arithmetic.ts — `+ - * / %`, the bitwise operators, and the unary forms.
 *
 * `arithmetic()` returns `{ value, typeName }` rather than a bare value, because
 * the .NET type of a result is real, observable information that the value alone
 * has lost. The case that forces it:
 *
 *   2147483647 + 1   ->  2147483648  System.Double
 *   2147483648       ->  2147483648  System.Int64
 *
 * Same number, different types, and `typeNameOf` can only see the number. See
 * numeric.ts for the widening table; this file is about which operands the
 * operators accept and what they do with the ones that are not numbers.
 *
 * THE LEFT OPERAND DECIDES, AND `+` IS FOUR OPERATORS WEARING ONE NAME
 *
 *   '1' + 2         ->  '12'          String     concatenation
 *   2 + '1'         ->  3             Int32      the string became a number
 *   @(1,2) + 3      ->  Object[]      array append
 *   @{a=1} + @{b=2} ->  Hashtable     merge
 *   1 + 'abc'       ->  THROWS
 *   3 + @(1,2)      ->  THROWS  MethodNotFound on [System.Object[]]
 *
 * `*` is three: numeric, string repetition (`'ab' * 3` is 'ababab') and array
 * repetition (`@(1,2) * 2` has four elements). `-`, `/` and `%` are numeric
 * only — `'1' - 2` is Int32 -1, because the string is converted rather than
 * concatenated, and `'a' - 'b'` throws.
 *
 * $null IS AN IDENTITY, NOT A ZERO
 *
 *   $null + 1    ->  1     Int32       the RIGHT operand's kind wins
 *   $null + 'a'  ->  'a'   String
 *   1 + $null    ->  1     Int32
 *   'a' + $null  ->  'a'   String
 *
 * Treating `$null` as the number 0 gets the first two wrong.
 */

import { toPSString } from '../formatting/to-string.ts';
import { isPSObject, psObject, typeNameOf, type PSValue } from '../pipeline/psobject.ts';
import {
  addHashTableToNonHashTableError,
  duplicateHashKeyError,
  invalidCastFromStringError,
  negativeArrayRepeatError,
  negativeStringRepeatError,
  operatorMethodNotFoundError,
  raise,
} from './errors.ts';
import {
  asTypedNumber,
  bitwiseTarget,
  complementTarget,
  numericAdd,
  numericDivide,
  numericMultiply,
  numericRemainder,
  numericSubtract,
  requireNumber,
  roundHalfToEven,
  shiftMask,
  toBitwiseInteger,
  wrapToType,
  type NumericTypeName,
  type TypedNumber,
} from './numeric.ts';

export type ArithmeticOp = '+' | '-' | '*' | '/' | '%';
export type BitwiseOp = '-band' | '-bor' | '-bxor' | '-shl' | '-shr';

/** A value together with the .NET type name the reference implementation reports. */
export interface TypedValue {
  readonly value: PSValue;
  readonly typeName: string;
}

const typed = (n: TypedNumber): TypedValue => ({ value: n.value, typeName: n.typeName });

/** The .NET operator method named in a MethodNotFound message. */
const OP_METHOD: Readonly<Record<ArithmeticOp, string>> = {
  '+': 'op_Addition',
  '-': 'op_Subtraction',
  '*': 'op_Multiply',
  '/': 'op_Division',
  '%': 'op_Modulus',
};

/**
 * Merge two property bags — `@{a=1} + @{b=2}`.
 *
 * A duplicate key is an ERROR, not a last-one-wins overwrite. Measured:
 * `@{a=1} + @{a=2}` raises, and it raises a raw .NET ArgumentException whose
 * FullyQualifiedErrorId is the type name itself.
 *
 * The project models a hashtable as a PSObject property bag, so this cannot
 * distinguish `@{...}` from `[pscustomobject]@{...}`. pwsh does — a
 * PSCustomObject has no `+` at all — and that limit is recorded here rather than
 * papered over.
 */
function mergeBags(left: PSValue, right: PSValue): PSValue {
  if (!isPSObject(right)) raise(addHashTableToNonHashTableError());
  const leftBag = (left as { properties: Readonly<Record<string, PSValue>> }).properties;
  // Object.create(null): `merged[key] = value` with key '__proto__' on a plain
  // object invokes the setter, so `@{a=1} + @{__proto__=@{...}}` replaced the
  // result's prototype with the right operand's data instead of adding a member,
  // and the duplicate-key guard never fired because Object.hasOwn was false.
  const merged: Record<string, PSValue> = Object.fromEntries(Object.entries(leftBag));
  for (const [key, value] of Object.entries(right.properties)) {
    if (Object.hasOwn(merged, key)) raise(duplicateHashKeyError(key));
    // defineProperty, not assignment: `merged['__proto__'] = v` invokes the
    // setter, so `@{a=1} + @{__proto__=@{...}}` replaced the result's prototype
    // with the right operand's data instead of adding a member — and the
    // duplicate-key guard above never fired, because Object.hasOwn was false.
    Object.defineProperty(merged, key, { value, writable: true, enumerable: true, configurable: true });
  }
  return psObject(merged);
}

/**
 * `+`.
 *
 * The dispatch order is the measured one and it matters: the LEFT operand picks
 * the meaning, and only then is the right converted.
 */
function add(left: PSValue, right: PSValue): TypedValue {
  // $null takes the shape of the other operand rather than becoming 0.
  if (left === null) {
    if (right === null) return { value: 0, typeName: 'System.Int32' };
    return typeof right === 'string' || Array.isArray(right) || isPSObject(right)
      ? { value: right, typeName: typeNameOf(right) }
      : typed(requireNumber(right, 'System.Int32'));
  }
  if (typeof left === 'string') {
    return { value: left + toPSString(right), typeName: 'System.String' };
  }
  if (Array.isArray(left)) {
    // An array grows by one element for a scalar and by n for an array.
    // Measured: @(1,2) + $null has THREE elements, so a null is appended rather
    // than ignored.
    const tail: readonly PSValue[] = Array.isArray(right) ? right : [right];
    return { value: [...left, ...tail], typeName: 'System.Object[]' };
  }
  if (isPSObject(left)) return { value: mergeBags(left, right), typeName: typeNameOf(left) };

  // A numeric left operand cannot take a collection on the right: the engine
  // gives up looking for an op_Addition on the RIGHT operand's type.
  if (Array.isArray(right) || isPSObject(right)) {
    raise(operatorMethodNotFoundError(typeNameOf(right), OP_METHOD['+']));
  }
  const a = requireNumber(left, typeNameOf(left));
  const b = requireNumber(right, a.typeName);
  return typed(numericAdd(a, b));
}

/**
 * `*`.
 *
 * String and array repetition both round the count half-to-even — measured,
 * `'ab' * 2.6` is 'ababab' and `@(1) * 2.6` has three elements — and both reject
 * a negative count, with DIFFERENT errors: a string raises
 * ArgumentOutOfRangeException while an array raises InvalidCastIConvertible for
 * a failed conversion to UInt32.
 */
function multiply(left: PSValue, right: PSValue): TypedValue {
  if (typeof left === 'string') {
    const times = roundHalfToEven(requireNumber(right, 'System.Int32').value);
    if (times < 0) raise(negativeStringRepeatError(times));
    return { value: left.repeat(times), typeName: 'System.String' };
  }
  if (Array.isArray(left)) {
    const times = roundHalfToEven(requireNumber(right, 'System.Int32').value);
    if (times < 0) raise(negativeArrayRepeatError(times));
    const out: PSValue[] = [];
    for (let i = 0; i < times; i++) out.push(...left);
    return { value: out, typeName: 'System.Object[]' };
  }
  if (Array.isArray(right) || isPSObject(right)) {
    raise(operatorMethodNotFoundError(typeNameOf(right), OP_METHOD['*']));
  }
  if (isPSObject(left)) raise(operatorMethodNotFoundError(typeNameOf(left), OP_METHOD['*']));
  const a = requireNumber(left, typeNameOf(left));
  const b = requireNumber(right, a.typeName);
  return typed(numericMultiply(a, b));
}

/** `-`, `/`, `%` — numeric only, whatever the operands look like. */
function numericOnly(op: '-' | '/' | '%', left: PSValue, right: PSValue): TypedValue {
  if (Array.isArray(left) || isPSObject(left)) {
    raise(operatorMethodNotFoundError(typeNameOf(left), OP_METHOD[op]));
  }
  if (Array.isArray(right) || isPSObject(right)) {
    raise(operatorMethodNotFoundError(typeNameOf(right), OP_METHOD[op]));
  }
  // The target type named in a conversion failure is the LEFT operand's, which
  // is why `'a' - 'b'` says System.Int32: 'a' fails first, and a bare string is
  // typed as Int32 for this purpose.
  const a = requireNumber(left, 'System.Int32');
  const b = requireNumber(right, a.typeName);
  if (op === '-') return typed(numericSubtract(a, b));
  if (op === '/') return typed(numericDivide(a, b));
  return typed(numericRemainder(a, b));
}

/**
 * `+ - * / %`.
 *
 * @returns the value AND the .NET type name, because the two are independent.
 * @throws PSRuntimeError carrying a real ErrorRecord.
 */
export function arithmetic(op: ArithmeticOp, left: PSValue, right: PSValue): TypedValue {
  if (op === '+') return add(left, right);
  if (op === '*') return multiply(left, right);
  return numericOnly(op, left, right);
}

// ---------------------------------------------------------------------------
// bitwise
// ---------------------------------------------------------------------------

/**
 * `-band -bor -bxor -shl -shr`.
 *
 * The result type is the surprise and it is documented in full at
 * `bitwiseTarget`: a non-integer operand routes the whole operation through an
 * UNSIGNED 64-bit integer, so `[double]5.0 -band 3` is `System.UInt64`, while
 * `-5.4 -band 3` is `System.Int64` because an operand was negative. Nothing
 * about `-band` suggests that either type should appear.
 *
 * Shifts differ from the logical operators in two ways, both measured:
 *  - the count is MASKED, not clamped: `1 -shl 32` is 1, not 0, and
 *    `[long]1 -shl 64` is 1. The mask is 31 for an Int32 and 63 otherwise, so
 *    `1 -shl -1` is Int32.MinValue (-1 masks to 31).
 *  - the LEFT operand alone picks the width; the count does not widen anything.
 *    `1.5 -shl 1` is Int32 4, NOT the UInt64 that `1.5 -band 2` would give.
 */
export function bitwise(op: BitwiseOp, left: PSValue, right: PSValue): TypedValue {
  const a = requireNumber(left, 'System.Int32');
  const b = requireNumber(right, 'System.Int32');

  if (op === '-shl' || op === '-shr') {
    // Only the left operand's type is considered. Measured: 1.5 -shl 1 is Int32.
    const target: NumericTypeName =
      a.typeName === 'System.Int64' ? 'System.Int64' : 'System.Int32';
    const value = toBitwiseInteger(a, target);
    const count = toBitwiseInteger(b, 'System.Int64') & shiftMask(target);
    const shifted = op === '-shl' ? value << count : value >> count;
    return { value: wrapToType(shifted, target), typeName: target };
  }

  const target = bitwiseTarget([a, b]);
  const x = toBitwiseInteger(a, target);
  const y = toBitwiseInteger(b, target);
  const result = op === '-band' ? x & y : op === '-bor' ? x | y : x ^ y;
  return { value: wrapToType(result, target), typeName: target };
}

/**
 * `-bnot`.
 *
 * Follows its OWN type rule, not the one the binary bitwise operators use: the
 * narrowest of Int32, Int64, UInt64 that holds the rounded operand. Measured:
 *
 *   -bnot 0            ->  -1                   Int32
 *   -bnot 1.5          ->  -3                   Int32   (1.5 rounds to 2)
 *   -bnot $true        ->  -2                   Int32
 *   -bnot 2147483648   ->  -2147483649          Int64
 *   -bnot 1e19         ->  8446744073709551615  UInt64  <- NOT an error, and
 *                                                          not signed either
 *   -bnot 1e20         ->  THROWS, naming System.UInt64
 *
 * `-bnot 1e19` is the row that pins the cascade down. A model that stopped at
 * Int64 would have to raise there, and it does not: it produces a large positive
 * UInt64, which is also how the unsigned route was found at all. Contrast
 * `1.5 -band 2`, which is UInt64 for a value that fits Int32 comfortably — the
 * two operators genuinely disagree about types.
 */
export function bitwiseNot(operand: PSValue): TypedValue {
  const a = requireNumber(operand, 'System.Int32');
  const target = complementTarget(a);
  const value = toBitwiseInteger(a, target === 'System.UInt64' ? 'System.UInt64' : 'System.Int64');
  return { value: wrapToType(~value, target), typeName: target };
}

// ---------------------------------------------------------------------------
// unary
// ---------------------------------------------------------------------------

/**
 * Unary `-`.
 *
 * Numeric only. Measured: `-'1'` is Int32 -1, `-'a'` throws, `-$true` is Int32
 * -1, and `-@(1,2)` throws MethodNotFound naming op_Subtraction — the engine
 * models negation as `0 - x` and reports the subtraction method.
 */
export function negate(operand: PSValue): TypedValue {
  if (Array.isArray(operand) || isPSObject(operand)) {
    raise(operatorMethodNotFoundError(typeNameOf(operand), OP_METHOD['-']));
  }
  const a = asTypedNumber(operand);
  if (a === null) raise(invalidCastFromStringError(toPSString(operand), 'System.Int32'));
  // -(2147483648) stays Int64 rather than escaping to Double: the operand was
  // already Int64 and the result fits. Measured.
  return typed({ value: -a.value, typeName: a.typeName });
}

/** Unary `+`. Measured: `+'1'` is Int32 1 — it CONVERTS rather than being a no-op. */
export function unaryPlus(operand: PSValue): TypedValue {
  const a = asTypedNumber(operand);
  if (a === null) raise(invalidCastFromStringError(toPSString(operand), 'System.Int32'));
  return typed(a);
}
