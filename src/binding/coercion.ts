/**
 * coercion.ts — turning an argument token into the declared .NET type.
 *
 * The binder receives text. Every parameter declares a .NET type. Between those
 * two sits .NET's string conversion, which is NOT JavaScript's and is wrong in
 * ways that are invisible until they produce a plausible wrong number.
 *
 * Read off pwsh 7.6.5, and four of these contradicted the obvious guess:
 *
 *   "5.5" → [int]  is 6, but "2.5" → [int] is 2 and "4.5" → [int] is 4.
 *                  .NET rounds half to EVEN. `Math.round` gives 3 and 5.
 *   "0x10" → 16, "0b101" → 5, "1e3" → 1000. Hex, binary and exponent all parse.
 *   "1,000" → 1000, and so does "1,0,0" and "12,34" — .NET drops group
 *                  separators without checking that the grouping is sensible.
 *   "" → 0.        An empty string is a zero, not a failure.
 *   [bool]"false" → True.  A non-empty string is truthy; only the LITERAL
 *                  token `$false` is false. This is why `-Flag:$false` and
 *                  `-Flag:'false'` are different things.
 *
 * THE TOKEN CONTRACT. This module is handed `readonly string[]` — the lexer is
 * somebody else's job — so `$true` and `$false` reach us as those five and six
 * characters. We treat exactly those two texts (case-insensitively) as boolean
 * literals, because without that rule `-Force:$false` cannot be modelled at
 * all, and modelling it is the whole point of the version-aware binder. A
 * caller that has already evaluated variables should pass `$true`/`$false`;
 * a caller that wants the four-letter STRING "false" cannot express it here,
 * which is a known and documented limit of taking pre-tokenised input.
 */

import type { PSValue } from '../pipeline/psobject.ts';

export type CoercionResult =
  | { readonly ok: true; readonly value: PSValue }
  /** `reason` is the inner half of pwsh's nested conversion error. */
  | { readonly ok: false; readonly reason: string };

const ok = (value: PSValue): CoercionResult => ({ ok: true, value });
const fail = (reason: string): CoercionResult => ({ ok: false, reason });

// ---------------------------------------------------------------------------
// boolean literals
// ---------------------------------------------------------------------------

/**
 * `$true` / `$false` as the lexer would hand them over, or null for anything
 * else. Case-insensitive because PowerShell's variables are.
 */
export function booleanLiteral(token: string): boolean | null {
  const lower = token.toLowerCase();
  if (lower === '$true') return true;
  if (lower === '$false') return false;
  return null;
}

// ---------------------------------------------------------------------------
// .NET type names
// ---------------------------------------------------------------------------

export const SWITCH_TYPE = 'System.Management.Automation.SwitchParameter';

/** Integer types, with the range .NET enforces on conversion. */
const INTEGER_RANGES = new Map<string, { readonly min: bigint; readonly max: bigint }>([
  ['System.SByte', { min: -128n, max: 127n }],
  ['System.Byte', { min: 0n, max: 255n }],
  ['System.Int16', { min: -32768n, max: 32767n }],
  ['System.UInt16', { min: 0n, max: 65535n }],
  ['System.Int32', { min: -2147483648n, max: 2147483647n }],
  ['System.UInt32', { min: 0n, max: 4294967295n }],
  ['System.Int64', { min: -9223372036854775808n, max: 9223372036854775807n }],
  ['System.UInt64', { min: 0n, max: 18446744073709551615n }],
]);

/**
 * 64-bit types become `bigint`, narrower ones become `number`.
 *
 * Not a stylistic choice: `[long]'9223372036854775807'` binds exactly in pwsh,
 * and a JS number would silently round it to …808. psobject.ts already maps
 * bigint to System.Int64, so the pipeline agrees.
 */
const WIDE_INTEGERS = new Set(['System.Int64', 'System.UInt64']);

const FLOAT_TYPES = new Set(['System.Single', 'System.Double', 'System.Decimal']);

/** Short .NET name for the "too large or too small" message, e.g. `Int32`. */
const shortTypeName = (typeName: string): string =>
  typeName.slice(typeName.lastIndexOf('.') + 1);

/**
 * Split `System.String[]` into its element type. An assembly-qualified generic
 * such as ``FlagsExpression`1[[System.IO.FileAttributes, …]]`` also ends in
 * `]]`, so the test is a literal `[]` suffix rather than "contains a bracket".
 */
export function elementTypeOf(typeName: string): string | null {
  return typeName.endsWith('[]') ? typeName.slice(0, -2) : null;
}

// ---------------------------------------------------------------------------
// number parsing
// ---------------------------------------------------------------------------

/** `1,000` → `1000`. .NET does not check the grouping; verified with `12,34`. */
const GROUPED = /^[+-]?[\d,]*\d[\d,]*$/;

function parseNumeric(text: string): number | null {
  const trimmed = text.trim();
  // Verified: `[int]' 5 '` is 5, and `[int]''` is 0.
  if (trimmed === '') return 0;
  const ungrouped = GROUPED.test(trimmed) ? trimmed.replaceAll(',', '') : trimmed;
  const value = Number(ungrouped);
  // `Number('Infinity')` is Infinity; pwsh rejects it, as it does '1e400'.
  if (!Number.isFinite(value)) return null;
  return value;
}

/**
 * .NET's midpoint rule, which is ToEven and not away-from-zero.
 *
 * Verified: 2.5→2, 3.5→4, 4.5→4, 5.5→6. `Math.round` gets three of those wrong.
 */
export function roundHalfToEven(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction > 0.5) return floor + 1;
  if (fraction < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** `-0` is a value JavaScript distinguishes and PowerShell does not. */
const normaliseZero = (value: number): number => (value === 0 ? 0 : value);

// ---------------------------------------------------------------------------
// the conversion itself
// ---------------------------------------------------------------------------

const notAFormat = (text: string, typeName: string): string =>
  `Cannot convert value "${text}" to type "${typeName}". ` +
  `Error: "The input string '${text}' was not in a correct format."`;

const outOfRange = (text: string, typeName: string): string =>
  `Cannot convert value "${text}" to type "${typeName}". ` +
  `Error: "Value was either too large or too small for an ${shortTypeName(typeName)}."`;

function coerceInteger(text: string, typeName: string): CoercionResult {
  const range = INTEGER_RANGES.get(typeName);
  if (range === undefined) return fail(notAFormat(text, typeName));

  const numeric = parseNumeric(text);
  if (numeric === null) return fail(notAFormat(text, typeName));

  const rounded = roundHalfToEven(numeric);
  // Beyond 2^53 the double has already lost the digits, so re-read the text for
  // the wide types rather than trusting the rounded double.
  if (WIDE_INTEGERS.has(typeName)) {
    const exact = exactBigInt(text, rounded);
    if (exact === null) return fail(notAFormat(text, typeName));
    if (exact < range.min || exact > range.max) return fail(outOfRange(text, typeName));
    return ok(exact);
  }

  if (BigInt(rounded) < range.min || BigInt(rounded) > range.max) {
    return fail(outOfRange(text, typeName));
  }
  return ok(normaliseZero(rounded));
}

/**
 * Prefer the digits the caller actually typed over the double we rounded, so a
 * 19-digit Int64 survives. Falls back to the double for anything that is not a
 * plain integer literal (`1e3`, `0x10`, `2.5`).
 */
function exactBigInt(text: string, rounded: number): bigint | null {
  const trimmed = text.trim();
  const ungrouped = GROUPED.test(trimmed) ? trimmed.replaceAll(',', '') : trimmed;
  if (/^[+-]?\d+$/.test(ungrouped)) return BigInt(ungrouped);
  if (!Number.isSafeInteger(rounded)) return null;
  return BigInt(rounded);
}

function coerceFloat(text: string, typeName: string): CoercionResult {
  const numeric = parseNumeric(text);
  if (numeric === null) return fail(notAFormat(text, typeName));
  return ok(normaliseZero(numeric));
}

/**
 * `[bool]` is not `[switch]`.
 *
 * Verified on 7.6.5: `-Flag:0` binds False and `-Flag:1` binds True, but
 * `[bool]'0'` — the STRING zero — is True because it is a non-empty string.
 * We resolve the ambiguity the way an unquoted token would be read by the
 * parser: a bare numeric token is a number.
 */
function coerceBoolean(text: string): CoercionResult {
  const literal = booleanLiteral(text);
  if (literal !== null) return ok(literal);
  const numeric = parseNumeric(text);
  if (numeric !== null && text.trim() !== '') return ok(numeric !== 0);
  return ok(text.length > 0);
}

/**
 * `[switch]` accepts ONLY a boolean.
 *
 * Verified, and the reference implementation contradicts its own error text
 * here: the message says "Boolean parameters accept only Boolean values and
 * numbers, such as $True, $False, 1 or 0", yet `-Force:0` fails in 7.6.5 with
 * "Cannot convert the "0" value of type "System.Int32"". We follow the
 * behaviour, not the advice, and reject everything but the two literals.
 */
export function coerceSwitchArgument(text: string): CoercionResult {
  const literal = booleanLiteral(text);
  if (literal !== null) return ok(literal);
  return fail(
    `Cannot convert value "${text}" to type "${SWITCH_TYPE}". ` +
      'Boolean parameters accept only Boolean values and numbers, such as $True, $False, 1 or 0.',
  );
}

/**
 * Convert one argument token toward a declared .NET type.
 *
 * Anything we do not model — enums, `FlagsExpression`, `PSObject`, provider
 * types — passes through as the original string. That is deliberate: inventing
 * a conversion would be a fiction, whereas the string is exactly what the user
 * typed and a command can still interpret it.
 */
export function coerceScalar(text: string, typeName: string): CoercionResult {
  if (typeName === SWITCH_TYPE) return coerceSwitchArgument(text);
  if (typeName === 'System.Boolean') return coerceBoolean(text);
  if (typeName === 'System.String') return ok(text);
  if (typeName === 'System.Char') {
    return text.length === 1 ? ok(text) : fail(notAFormat(text, typeName));
  }
  if (INTEGER_RANGES.has(typeName)) return coerceInteger(text, typeName);
  if (FLOAT_TYPES.has(typeName)) return coerceFloat(text, typeName);
  return ok(text);
}

/**
 * Convert an argument list toward a parameter's type, wrapping a single value
 * in an array when the parameter is array-typed.
 *
 * `Test-Pos -Path 'one'` binds `@('one')` — a one-element String[], not a
 * String. Commands rely on that: `foreach ($p in $Path)` must iterate once,
 * not over the characters.
 */
export function coerceArgument(values: readonly string[], typeName: string): CoercionResult {
  const element = elementTypeOf(typeName);
  if (element === null) {
    const first = values[0];
    if (first === undefined) return fail(notAFormat('', typeName));
    return coerceScalar(first, typeName);
  }

  const out: PSValue[] = [];
  for (const value of values) {
    const result = coerceScalar(value, element);
    if (!result.ok) return result;
    out.push(result.value);
  }
  return ok(out);
}
