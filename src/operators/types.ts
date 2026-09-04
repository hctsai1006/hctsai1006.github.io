/**
 * types.ts — `-is`, `-isnot`, `-as`, `-not`/`!`, and the member access that
 * `$null` refuses.
 *
 * `-as` VERSUS A CAST IS A REAL, TESTABLE DIFFERENCE
 *
 *   'abc' -as [int]   ->  $null      no error, no output, just nothing
 *   [int]'abc'        ->  THROWS     InvalidCastFromStringToInteger
 *
 * Same conversion, same failure, two different control flows. `-as` is how a
 * script asks "is this convertible?" without a try/catch, and an implementation
 * that made it throw would break that idiom silently.
 *
 * But `-as` does NOT swallow everything. An unknown TYPE still throws, in both
 * forms — measured, `'abc' -as [nosuchtype]` raises `TypeNotFound`. The null is
 * for a failed conversion, not for a failed lookup.
 *
 * WHAT `-is` SAYS ABOUT $null, WHICH IS NOT WHAT .NET WOULD SAY
 *
 *   $null -is [object]   ->  False
 *   $null -is [string]   ->  False
 *
 * $null is not an instance of anything. psobject.ts's `typeNameOf` deliberately
 * returns `System.Object` for null so that callers never have to guard it, and
 * that total-function choice is already recorded in known-differences.yml; `-is`
 * must NOT inherit it, so null is handled before the type table is consulted.
 *
 * `-as` and `-is` conversions are banker's-rounded like everything else:
 * `1.9 -as [int]` is 2 and `2.5 -as [int]` is 2, not 3.
 */

import { toPSString } from '../formatting/to-string.ts';
import { isPSObject, isTruthy, isOfType, type PSValue } from '../pipeline/psobject.ts';
import { methodOnNullError, raise, typeNotFoundError } from './errors.ts';
import { asTypedNumber, roundHalfToEven } from './numeric.ts';

/**
 * The type names `[...]` accepts, mapped to what `.GetType().FullName` reports.
 *
 * PowerShell's own accelerators, not an invented set. Both spellings of each
 * name resolve — measured, `1 -is [int]`, `1 -is [int32]` and
 * `1 -is 'System.Int32'` are all True, and a bare string works as well as a type
 * literal.
 */
const TYPE_ALIASES: Readonly<Record<string, string>> = {
  int: 'System.Int32',
  int32: 'System.Int32',
  long: 'System.Int64',
  int64: 'System.Int64',
  short: 'System.Int16',
  int16: 'System.Int16',
  byte: 'System.Byte',
  double: 'System.Double',
  single: 'System.Single',
  float: 'System.Single',
  decimal: 'System.Decimal',
  string: 'System.String',
  char: 'System.Char',
  bool: 'System.Boolean',
  boolean: 'System.Boolean',
  datetime: 'System.DateTime',
  hashtable: 'System.Collections.Hashtable',
  array: 'System.Array',
  'object[]': 'System.Object[]',
  object: 'System.Object',
  psobject: 'System.Management.Automation.PSObject',
  pscustomobject: 'System.Management.Automation.PSCustomObject',
  valuetype: 'System.ValueType',
  regex: 'System.Text.RegularExpressions.Regex',
  scriptblock: 'System.Management.Automation.ScriptBlock',
  type: 'System.Type',
  guid: 'System.Guid',
  version: 'System.Version',
  uri: 'System.Uri',
  xml: 'System.Xml.XmlDocument',
};

/** Resolve a type name, raising `TypeNotFound` the way pwsh does. */
export function resolveTypeName(name: PSValue): string {
  const text = toPSString(name).trim();
  const key = text.toLowerCase();
  const resolved = TYPE_ALIASES[key];
  if (resolved !== undefined) return resolved;
  // A fully-qualified name that is not in the table is accepted if it looks like
  // one: refusing every unknown System.* would make -is useless for the types
  // this project models but does not accelerate.
  if (text.includes('.')) return text;
  raise(typeNotFoundError(text));
}

/**
 * The .NET hierarchy for the values this project carries, most-derived first.
 *
 * Deliberately shallow: only the ancestry that `-is` is actually asked about.
 * Inventing a full CLR type graph would be a lot of unverified detail, and every
 * row here corresponds to a measured `-is` answer.
 */
function hierarchyOf(value: PSValue): readonly string[] {
  if (typeof value === 'boolean') return ['System.Boolean', 'System.ValueType', 'System.Object'];
  if (typeof value === 'bigint') return ['System.Int64', 'System.ValueType', 'System.Object'];
  if (typeof value === 'string') return ['System.String', 'System.Object'];
  if (value instanceof Date) return ['System.DateTime', 'System.ValueType', 'System.Object'];
  if (value instanceof Uint8Array) {
    return ['System.Byte[]', 'System.Array', 'System.Object'];
  }
  if (Array.isArray(value)) return ['System.Object[]', 'System.Array', 'System.Object'];
  if (typeof value === 'number') {
    const name = Number.isInteger(value)
      ? value >= -2147483648 && value <= 2147483647
        ? 'System.Int32'
        : 'System.Int64'
      : 'System.Double';
    return [name, 'System.ValueType', 'System.Object'];
  }
  return ['System.Object'];
}

/**
 * `-is` / `-isnot`.
 *
 * Does NOT filter, even with an array left operand: measured, `@(1,2) -is
 * [array]` is the single Boolean True rather than a filtered collection.
 */
export function isOperator(value: PSValue, typeName: PSValue, negated = false): boolean {
  const target = resolveTypeName(typeName);
  // $null is an instance of nothing. Measured, and it is the one place -is must
  // not reuse typeNameOf.
  if (value === null) return negated;
  const answer = isPSObject(value)
    ? isOfType(value, target) || target === 'System.Object' ||
      target === 'System.Management.Automation.PSObject'
    : hierarchyOf(value).includes(target);
  return answer !== negated;
}

/**
 * `-as`.
 *
 * Returns `$null` when the conversion fails — the difference from a cast that
 * this whole file exists to make testable. Only the conversions this project's
 * value model can actually perform are attempted; anything else answers null
 * rather than pretending.
 */
export function asOperator(value: PSValue, typeName: PSValue): PSValue {
  const target = resolveTypeName(typeName);

  if (target === 'System.String') return toPSString(value);

  if (
    target === 'System.Int32' ||
    target === 'System.Int64' ||
    target === 'System.Int16' ||
    target === 'System.Byte'
  ) {
    const n = asTypedNumber(value);
    if (n === null) return null;
    // Measured: '1.5' -as [int] is 2 and '2.5' -as [int] is 2 — banker's
    // rounding, not truncation and not round-half-up.
    return roundHalfToEven(n.value);
  }

  if (target === 'System.Double' || target === 'System.Decimal' || target === 'System.Single') {
    const n = asTypedNumber(value);
    return n === null ? null : n.value;
  }

  if (target === 'System.Boolean') return isTruthy(value);

  if (target === 'System.DateTime') {
    if (value instanceof Date) return value;
    const parsed = new Date(toPSString(value));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  if (target === 'System.Object') return value;

  // A type this value model cannot produce. Answering null is the honest result
  // and is also what pwsh answers for a conversion it cannot perform.
  return null;
}

/**
 * `-not` / `!`.
 *
 * Uses PowerShell truthiness, which is not JavaScript's — an empty array is
 * false, a single-element array takes its element's truthiness, and the string
 * "0" is TRUE. All of that lives in psobject.ts's `isTruthy`; this is the
 * operator over it. Measured checks that it is the same function:
 *
 *   -not @()      ->  True      -not @(0)   ->  True
 *   -not @(0,0)   ->  False     -not '0'    ->  False
 *   -not @{}      ->  False     an empty hashtable is truthy
 */
export function notOperator(value: PSValue): boolean {
  return !isTruthy(value);
}

/**
 * Invoking a method — modelled only far enough to raise the error `$null.Foo()`
 * raises, which is a corpus case.
 *
 * PROPERTY access on null is NOT an error and must not route through here:
 * measured, `$null.Length` succeeds and produces nothing, while `$null.Foo()`
 * raises `InvokeMethodOnNull`. Conflating the two would make a common null-safe
 * property read start throwing.
 */
export function invokeMethod(target: PSValue, methodName: string): never {
  if (target === null) raise(methodOnNullError(methodName));
  // Every other method invocation belongs to an evaluator this project does not
  // have yet. Saying so is better than returning a plausible wrong answer.
  raise({
    message: `Method invocation failed because [${
      isPSObject(target) ? target.typeNames[0] ?? 'System.Object' : typeof target
    }] does not contain a method named '${methodName}'.`,
    fullyQualifiedErrorId: 'MethodNotFound',
    category: 'InvalidOperation',
    exceptionType: 'System.Management.Automation.RuntimeException',
  });
}
