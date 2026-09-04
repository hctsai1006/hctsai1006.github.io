/**
 * comparison.ts — `-eq -ne -lt -le -gt -ge` and the membership operators, with
 * the behaviour that makes them a different shape from a boolean operator.
 *
 * THE HEADLINE: AN ARRAY LEFT OPERAND FILTERS
 *
 *   @(1,2,3) -eq 2      ->  Object[] containing 2       NOT $true
 *   @(1,2,3) -ne 2      ->  Object[] containing 1, 3
 *   @(1,2,3) -lt 2      ->  Object[] containing 1
 *   @(1,2,3) -gt 5      ->  Object[] containing nothing
 *
 * All six order and equality operators do it, and so do `-like`, `-notlike`,
 * `-match` and `-notmatch` over in strings.ts. `-contains`, `-notcontains`,
 * `-in`, `-notin` and `-is` do NOT: they always answer a Boolean.
 *
 * The result is `System.Object[]` in every case, including one hit and zero
 * hits. It is never unwrapped to a scalar and never collapsed to `$null`:
 * measured, `$null -eq (@(1,2,3) -eq 9)` is False. Code that writes
 * `if ($arr -eq $x)` is therefore testing an ARRAY for emptiness, which is why
 * `if (@(1,2,3) -eq 2)` and `if (@(1,2,3) -eq 9)` take different branches.
 *
 * REFERENCE TYPES COMPARE BY REFERENCE, AND THAT IS NOT WHAT compareValues DOES
 *
 * `compareValues` in psobject.ts falls back to comparing string forms when the
 * types differ, which is right for the scalar cases it was built for and wrong
 * when the LEFT operand is an array or an object. Measured:
 *
 *   @{a=1} -eq @{a=1}          ->  False      (two hashtables, equal contents)
 *   $h -eq $h                  ->  True       (the same one)
 *   @(,@(1,2)) -contains @(1,2)->  False
 *   @(,$inner) -contains $inner->  True
 *
 * Comparing the string forms would answer True to all four. psobject.ts is not
 * changed for this — it is under review and its scalar contract is correct —
 * so the reference rule lives here, where the operator semantics live.
 *
 * The mirror case is different again, and also measured: when the left is a
 * SCALAR and the right is a reference, PowerShell converts the right to the
 * left's type, which succeeds for a string and fails for a number.
 *
 *   'abc' -eq @('abc')                          ->  True
 *   'System.Collections.Hashtable' -eq @{a=1}   ->  True
 *   1 -eq @(1)                                  ->  False
 *   1 -lt @(2)                                  ->  THROWS, id=ComparisonFailure
 *
 * KNOWN GAP, recorded rather than hidden: the string form PowerShell uses for a
 * collection is `.ToString()` per element, so `'abc' -eq ,@('abc')` is False
 * there (the inner array renders as `System.Object[]`) while `toPSString`
 * recurses and would say True. That needs the culture-dependent `.ToString()`
 * conversion to-string.ts deliberately does not provide.
 */

import { toPSString } from '../formatting/to-string.ts';
import {
  ComparisonTypeError,
  compareValues,
  isPSObject,
  typeNameOf,
  valuesEqual,
  type PSValue,
} from '../pipeline/psobject.ts';
import {
  comparisonFailureError,
  invalidCastFromStringError,
  notComparableError,
  raise,
} from './errors.ts';
import type { CaseFlag } from './strings.ts';

export type ComparisonOp = 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge';
export type MembershipOp = 'contains' | 'notcontains' | 'in' | 'notin';

const INSENSITIVE: CaseFlag = { caseSensitive: false };

/** Values PowerShell compares by identity rather than by content. */
const isReference = (value: PSValue): boolean => Array.isArray(value) || isPSObject(value);

const ORDERING: ReadonlySet<ComparisonOp> = new Set<ComparisonOp>(['lt', 'le', 'gt', 'ge']);

/**
 * Translate psobject's `ComparisonTypeError` into the record pwsh actually
 * produces.
 *
 * `ComparisonTypeError` is the right internal signal — it says the right operand
 * could not become the left's type — but it is a JavaScript Error with no
 * FullyQualifiedErrorId, and a script cannot catch it by id or by category. The
 * translation happens here rather than in psobject.ts so that comparison stays a
 * pure function there and the ErrorRecord vocabulary stays in the operator layer.
 */
function raiseComparisonFailure(left: PSValue, right: PSValue): never {
  if (typeof right === 'string') {
    // Measured: a string that will not parse names the string and the target
    // type, and its error id follows the target's width.
    raise(invalidCastFromStringError(right, typeNameOf(left)));
  }
  raise(
    comparisonFailureError(toPSString(left), toPSString(right), typeNameOf(right), typeNameOf(left)),
  );
}

/** Compare one pair, raising the errors pwsh raises. Never filters. */
function compareScalar(
  op: ComparisonOp,
  left: PSValue,
  right: PSValue,
  caseSensitive: boolean,
): boolean {
  if (isReference(left)) {
    // The right must become the left's reference type, and only the same
    // reference does. Measured: `$h -lt $h` is False and `$h -le $h` is True,
    // so identity orders as EQUAL rather than raising.
    const identical = left === right;
    if (op === 'eq') return identical;
    if (op === 'ne') return !identical;
    if (!identical) raise(notComparableError(typeNameOf(left)));
    return op === 'le' || op === 'ge';
  }

  if (isReference(right)) {
    if (typeof left !== 'string') {
      // A collection or an object cannot be converted to a number, a boolean or
      // a date. Measured: `1 -eq @(1)` is False and `1 -lt @(2)` throws.
      if (op === 'eq') return false;
      if (op === 'ne') return true;
      raiseComparisonFailure(left, right);
    }
    // A STRING left operand does convert it — through PowerShell's own
    // conversion, which joins with $OFS. Measured: `'1 2' -eq @(1,2)` is True,
    // so the separator is a SPACE. Handing the array to compareValues would let
    // JavaScript's String() render it as '1,2' and answer False; toPSString is
    // the conversion PowerShell actually uses.
    return compareScalar(op, left, toPSString(right), caseSensitive);
  }

  if (op === 'eq' || op === 'ne') {
    const equal = valuesEqual(left, right, caseSensitive);
    return op === 'eq' ? equal : !equal;
  }

  let sign: number;
  try {
    sign = compareValues(left, right, caseSensitive);
  } catch (error) {
    if (!(error instanceof ComparisonTypeError)) throw error;
    raiseComparisonFailure(left, right);
  }
  switch (op) {
    case 'lt':
      return sign < 0;
    case 'le':
      return sign <= 0;
    case 'gt':
      return sign > 0;
    case 'ge':
      return sign >= 0;
    default:
      return false;
  }
}

/**
 * `-eq -ne -lt -le -gt -ge` and their `c`/`i` spellings.
 *
 * Returns a Boolean for a scalar left operand and an `Object[]` of the surviving
 * ELEMENTS for an array one. The elements are the originals, not their string
 * forms — measured, `@(1,12,3) -match '1'` yields two Int32s, and the same holds
 * here.
 *
 * A comparison that fails inside a filter still THROWS; it is not skipped.
 * Measured: `@(1,2) -lt 'a'` raises rather than returning an empty array, while
 * `@('a') -lt 1` returns an empty array because 'a' -lt 1 is merely False.
 */
export function comparisonOperator(
  op: ComparisonOp,
  left: PSValue,
  right: PSValue,
  { caseSensitive }: CaseFlag = INSENSITIVE,
): PSValue {
  if (Array.isArray(left)) {
    return left.filter((item) => compareScalar(op, item as PSValue, right, caseSensitive));
  }
  return compareScalar(op, left, right, caseSensitive);
}

/** Is this operator one of the four that throw on an unconvertible operand? */
export function isOrderingOperator(op: ComparisonOp): boolean {
  return ORDERING.has(op);
}

// ---------------------------------------------------------------------------
// membership
// ---------------------------------------------------------------------------

/**
 * Which side is the LEFT operand of the underlying equality.
 *
 * This is not symmetric and the difference is observable, because `-eq`
 * converts the RIGHT to the LEFT's type. Measured:
 *
 *   @(1) -contains ' 1 '   ->  True     because  1 -eq ' 1 '   is True
 *   @(' 1 ') -contains 1   ->  False    because  ' 1 ' -eq 1   is False
 *
 * So the COLLECTION ELEMENT is the left operand and the searched-for value is
 * the right. `-in` is `-contains` with the operands swapped, which the two
 * mirror measurements confirm:
 *
 *   ' 1 ' -in @(1)  ->  True        1 -in @(' 1 ')  ->  False
 */
function collectionContains(
  collection: PSValue,
  value: PSValue,
  caseSensitive: boolean,
): boolean {
  // A scalar left operand behaves as a one-element collection. Measured:
  // 'abc' -contains 'abc' is True while 'abc' -contains 'a' is False, so it is
  // NOT enumerated as characters.
  const items: readonly PSValue[] = Array.isArray(collection) ? collection : [collection];
  return items.some((item) => compareScalar('eq', item as PSValue, value, caseSensitive));
}

/**
 * `-contains -notcontains -in -notin`, and their `c`/`i` spellings.
 *
 * These ALWAYS return a Boolean, even with an array on both sides — measured,
 * `@(1,2) -in @(1,2)` is False, because the question is whether the array itself
 * is an element, and it is not.
 */
export function membershipOperator(
  op: MembershipOp,
  left: PSValue,
  right: PSValue,
  { caseSensitive }: CaseFlag = INSENSITIVE,
): boolean {
  const found =
    op === 'contains' || op === 'notcontains'
      ? collectionContains(left, right, caseSensitive)
      : collectionContains(right, left, caseSensitive);
  return op === 'contains' || op === 'in' ? found : !found;
}
