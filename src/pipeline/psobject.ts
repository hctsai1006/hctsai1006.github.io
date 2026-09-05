/**
 * psobject.ts — the object model the pipeline carries.
 *
 * The single largest fidelity gap in the v1 terminal is that its pipeline
 * carries rendered lines. `Get-ChildItem | Sort-Object Length` there sorts the
 * formatted text — including the `UnixMode` prefix — because by the time the
 * sort runs, the objects are gone. Every downstream capability follows from
 * fixing that: Get-Member, Select-Object, Group-Object, ConvertTo-Json,
 * property-based completion, and any machine-readable output an AI or an MCP
 * tool could consume without scraping a terminal.
 *
 * PowerShell's real order is:
 *
 *   Get-Process   → ProcessInfo objects
 *   Where-Object  → filtered ProcessInfo objects
 *   Select-Object → PSCustomObject
 *   Format-Table  → formatting directives
 *   the terminal  → text
 *
 * Formatting is the LAST step, never something a command does to itself.
 *
 * Semantics deliberately modelled here, because getting them wrong is invisible
 * until it produces a subtly wrong answer:
 *
 *   - Property access is CASE-INSENSITIVE. `$p.name` and `$p.Name` are the same
 *     property. A Map keyed by the exact string would silently miss.
 *   - `-eq` on strings is case-insensitive; `-ceq` is the case-sensitive form.
 *     Modelling only the case-sensitive comparison would quietly disagree with
 *     the reference implementation on the most common operator there is.
 *   - Arrays unroll ONE LEVEL. `@(1, @(2,3))` sends the number and then the
 *     inner array intact; it does not flatten. `$null` flows as a value.
 *   - typeNames is a hierarchy, not a label. Formatting and `-is` both walk it.
 *
 * Every one of those was checked against pwsh 7.6.5 rather than assumed, and
 * three of them were wrong before that check. The corrections are recorded at
 * each site so the next reader does not re-introduce the guess.
 *
 * THE ONE THING THIS FILE IMPORTS, AND WHY IT IS NOT A LAYERING BREAK
 *
 * `"$x"` on a double is `.ToString("G15", InvariantCulture)`. There is no
 * second rule to model, so `toPSString` calls the formatter's `G` rather than
 * keeping a private copy of it: `src/formatting/numeric.ts` and
 * `src/formatting/culture.ts` are leaves — numeric imports one TYPE from
 * culture, culture imports a captured JSON, and neither imports anything from
 * the pipeline — so nothing here can close a cycle. The copy this replaced had
 * disagreed with the shared one on three of forty doubles.
 */

import { INVARIANT } from '../formatting/culture.ts';
import { formatGeneral } from '../formatting/numeric.ts';

/** A value that is not itself a PowerShell object. */
export type PSPrimitive = null | boolean | number | bigint | string | Date;

/**
 * Anything the pipeline can carry. `Uint8Array` is included deliberately: the
 * native byte channel must stay bytes, because decoding it once — wrongly — is
 * not recoverable.
 */
export type PSValue = PSPrimitive | Uint8Array | PSObject | readonly PSValue[];

export interface PSObject {
  /**
   * Most-derived first, e.g.
   * ['System.Diagnostics.Process', 'System.ComponentModel.Component', 'System.Object'].
   */
  readonly typeNames: readonly string[];
  readonly properties: Readonly<Record<string, PSValue>>;
  /** The underlying host value, when there is one. Never serialised. */
  readonly baseObject?: unknown;
}

// ---------------------------------------------------------------------------
// construction
// ---------------------------------------------------------------------------

/** The type name PowerShell reports for an object built from a property bag. */
export const PS_CUSTOM_OBJECT = 'System.Management.Automation.PSCustomObject';

export function psObject(
  properties: Readonly<Record<string, PSValue>>,
  typeNames: readonly string[] = [PS_CUSTOM_OBJECT, 'System.Object'],
): PSObject {
  // A plain bag, deliberately, and the reason is worth recording because the
  // safer-looking option does not work here.
  //
  // getProperty once read `properties[name]` before checking ownership, so
  // `Select-Object -Property constructor` handed the host Function constructor
  // out as pipeline data — in a file whose own comment says it "never calls eval
  // or new Function". It does not have to, if it gives the caller Function.
  //
  // The obvious fix is Object.create(null) here. It does not hold: structuredClone
  // NORMALISES a null-prototype object back to Object.prototype, so every object
  // crossing the worker boundary would arrive with the chain restored — and the
  // round-trip would stop being identity-preserving, which the protocol depends
  // on. So the guarantee lives where it survives: getProperty and hasProperty
  // gate on Object.hasOwn, which is true regardless of prototype, and the one
  // place that WRITES a caller-supplied property name (Select-Object) builds its
  // bag with a null prototype so `-Property __proto__` cannot re-parent it.
  return { typeNames, properties };
}

/** Wrap a host value, keeping it reachable for commands that need the original. */
export function psWrap(
  properties: Readonly<Record<string, PSValue>>,
  typeNames: readonly string[],
  baseObject: unknown,
): PSObject {
  return { typeNames, properties, baseObject };
}

export function isPSObject(value: unknown): value is PSObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as PSObject).typeNames) &&
    typeof (value as PSObject).properties === 'object'
  );
}

// ---------------------------------------------------------------------------
// property access
// ---------------------------------------------------------------------------

/**
 * Look a property up case-insensitively, as PowerShell does.
 *
 * Returns `undefined` for "no such property", which is distinct from a property
 * whose value is `null`. Collapsing the two would make `Where-Object { $_.X -eq
 * $null }` match objects that have no X at all.
 */
export function getProperty(target: PSValue, name: string): PSValue | undefined {
  if (!isPSObject(target)) return undefined;
  // Object.hasOwn FIRST, not as a fallback. Reading `properties[name]` before
  // checking ownership walks the prototype chain, so `getProperty(o, 'toString')`
  // returned the host Function — a JavaScript function escaping into PSValue,
  // which nothing downstream is typed for — and disagreed with hasProperty about
  // the same name. `Where-Object toString -ne $null` matched every object.
  const direct = Object.hasOwn(target.properties, name) ? target.properties[name] : undefined;
  if (direct !== undefined || Object.hasOwn(target.properties, name)) return direct;

  const lower = name.toLowerCase();
  for (const key of Object.keys(target.properties)) {
    if (key.toLowerCase() === lower) return target.properties[key];
  }
  return undefined;
}

export function hasProperty(target: PSValue, name: string): boolean {
  if (!isPSObject(target)) return false;
  if (Object.hasOwn(target.properties, name)) return true;
  const lower = name.toLowerCase();
  return Object.keys(target.properties).some((k) => k.toLowerCase() === lower);
}

/** Property names in declaration order — the order Format-Table follows. */
export function propertyNames(target: PSValue): readonly string[] {
  return isPSObject(target) ? Object.keys(target.properties) : [];
}

/**
 * Does this object's type hierarchy include the named type? Backs `-is` and the
 * formatter's type lookup. Matches on the full name or the last segment, so
 * both `System.Diagnostics.Process` and `Process` resolve.
 */
export function isOfType(target: PSValue, typeName: string): boolean {
  if (!isPSObject(target)) return false;
  const want = typeName.toLowerCase();
  return target.typeNames.some((t) => {
    const full = t.toLowerCase();
    return full === want || full.slice(full.lastIndexOf('.') + 1) === want;
  });
}

// ---------------------------------------------------------------------------
// the type name of any value
// ---------------------------------------------------------------------------

/** What `Get-Member` and `$x.GetType().FullName` report for a value. */
export function typeNameOf(value: PSValue): string {
  if (value === null) return 'System.Object';
  if (isPSObject(value)) return value.typeNames[0] ?? PS_CUSTOM_OBJECT;
  if (Array.isArray(value)) return 'System.Object[]';
  if (value instanceof Uint8Array) return 'System.Byte[]';
  if (value instanceof Date) return 'System.DateTime';
  switch (typeof value) {
    case 'boolean':
      return 'System.Boolean';
    case 'bigint':
      return 'System.Int64';
    case 'string':
      return 'System.String';
    case 'number':
      // PowerShell distinguishes these, and Get-Member showing Double for a
      // whole number would disagree with the reference implementation.
      //
      // Width matters too, and reporting Int32 for every whole number was
      // wrong: the differential harness caught it. Measured in pwsh 7.6.5,
      // literals widen at the Int32 boundary and again at the Int64 one —
      //   2147483647 -> System.Int32      2147483648 -> System.Int64
      //  -2147483648 -> System.Int32     -2147483649 -> System.Int64
      //   9223372036854775807 -> System.Int64
      //   9223372036854775808 -> System.Decimal
      //
      // Above Int64 this is a best effort and says so: a JS number that large
      // has already lost the precision the distinction is about, which is why
      // a caller who needs an exact Int64 should hold a bigint (mapped above).
      // Note also that pwsh widens ARITHMETIC differently from literals —
      // `2147483647 + 1` is System.Double, not Int64 — so an evaluator must
      // not reuse this function to type the result of a sum.
      if (!Number.isInteger(value)) return 'System.Double';
      if (value >= -2147483648 && value <= 2147483647) return 'System.Int32';
      // The Int64 bound cannot be written as a float64 literal: 9223372036854775807
      // and 9223372036854775808 are the SAME double, so the first version of this
      // classified its own documented Decimal example as Int64. 2**63 is exact.
      if (Math.abs(value) < 2 ** 63) return 'System.Int64';
      // Decimal is a narrow band above Int64, not everything above it. Without an
      // upper bound this reported System.Decimal for 1e30, where pwsh says
      // System.Double. Decimal.MaxValue is ~7.9228e28.
      if (Math.abs(value) <= 7.9228162514264337e28) return 'System.Decimal';
      return 'System.Double';
    default:
      return 'System.Object';
  }
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

/**
 * How a value becomes text — `"$x"`, the culture-INVARIANT conversion.
 *
 * This lives with the object model rather than in the formatting layer because
 * it is part of what a PSValue IS, and because everything that compares, sorts,
 * joins or groups needs it. It had drifted into three implementations —
 * `renderValue` in the cmdlets' support module, a copy in the formatting layer,
 * and bare `String()` inside the comparison fallbacks — and they disagreed on
 * the case that matters most:
 *
 *     String(0.1 + 0.2)      "0.30000000000000004"     JavaScript
 *     toPSString(0.1 + 0.2)  "0.3"                     pwsh 7.6.5
 *
 * `String()` was also wrong for arrays (`"1,2"` where PowerShell joins with a
 * space, so `'1 2' -eq @(1,2)` answered false) and for dates (a JavaScript date
 * string, so `@('a', $date) | Sort-Object` put them the wrong way round — the
 * example the sort comment itself cites).
 *
 * `.ToString()` is deliberately NOT this function: it follows the host culture,
 * so `(1.5).ToString()` is `1,5` under de-DE while `"$(1.5)"` stays `1.5`. It
 * also differs in kind — `@(1,2).ToString()` is `System.Object[]` and
 * `$null.ToString()` throws. That belongs with the method-call evaluator.
 */
export const DEFAULT_OFS = ' ';

/**
 * The invariant date form: `"$(Get-Date '2020-03-04T05:06:07')"` is
 * `03/04/2020 05:06:07`.
 *
 * THIS IS NOT A DIFFERENT QUESTION FROM `formatDate(value, 'G', INVARIANT)`.
 * It is the same one: `MM/dd/yyyy HH:mm:ss` is exactly the invariant culture's
 * captured `G` pattern, and `"$date"` really is that pattern rather than a
 * separate PowerShell invention. It is written out here anyway because the
 * engine sits ABOVE this file in the import graph — src/formatting/datetime.ts
 * needs `PSDateTime`, which needs this module — so calling it from here would
 * close a cycle.
 *
 * Six lines of duplication is the price, and the price is only worth paying if
 * a divergence is loud. So it is welded: a test asserts these two agree over
 * the whole date corpus, and it fails the moment either moves.
 */
function formatDateInvariant(value: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${p(value.getMonth() + 1)}/${p(value.getDate())}/${p(value.getFullYear(), 4)} ` +
    `${p(value.getHours())}:${p(value.getMinutes())}:${p(value.getSeconds())}`
  );
}

export function toPSString(value: PSValue, ofs: string = DEFAULT_OFS): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  // `"$x"` on a double is G15 against the INVARIANT culture — that is the whole
  // of it, and it is the formatter's `G` with a precision, not a rule of its
  // own. A second implementation lived here and was wrong twice: it went
  // exponential at `exponent < -5` where .NET's threshold is `< -4`
  // (`"$(0.00001)"` is `1E-05`, it answered `0.00001`), and it returned `0` for
  // negative zero where pwsh answers `-0`. Both measured on pwsh 7.6.5/Linux.
  if (typeof value === 'number') return formatGeneral(value, 15, INVARIANT, true);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return formatDateInvariant(value);
  if (value instanceof Uint8Array) return Array.from(value).join(ofs);
  if (Array.isArray(value)) return value.map((item) => toPSString(item as PSValue, ofs)).join(ofs);
  if (isPSObject(value)) {
    return `@{${Object.entries(value.properties)
      .map(([key, item]) => `${key}=${toPSString(item, ofs)}`)
      .join('; ')}}`;
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// comparison
// ---------------------------------------------------------------------------

/**
 * PowerShell's comparison, used by `-eq`/`-lt`/`-gt` and by Sort-Object.
 *
 * `caseSensitive` defaults to FALSE because PowerShell's `-eq` is
 * case-insensitive and `-ceq` is the explicit case-sensitive form. Defaulting
 * the other way would be wrong on the most-used operator in the language.
 *
 * String ordering is CULTURE-AWARE, because PowerShell's is. This was verified
 * rather than assumed, and the assumption was wrong: by code point "B" < "a"
 * (Ordinal compare returns -31), but pwsh 7.6.5 reports `'B' -lt 'a'` as False,
 * agreeing with culture-aware comparison (which returns 1). Sorting
 * b, A, a, B in the reference implementation yields A, a, b, B.
 *
 * The locale is PINNED to 'en' rather than taken from the host. That keeps the
 * ordering deterministic across machines — a differential test must not depend
 * on the runner's locale — while still matching the reference implementation on
 * every case probed. Collation outside the Latin script is a known limit and
 * belongs in known-differences.yml if it ever matters.
 */
const COLLATOR_INSENSITIVE = new Intl.Collator('en', { sensitivity: 'accent' });
const COLLATOR_SENSITIVE = new Intl.Collator('en', { sensitivity: 'variant' });

/**
 * Raised when the right operand cannot be converted to the left operand's type.
 * PowerShell's ordering operators throw here; `-eq` and `-ne` do not, which is
 * why they are separate functions below rather than a flag on this one.
 */
export class ComparisonTypeError extends Error {
  constructor(left: PSValue, right: PSValue) {
    super(
      `cannot compare ${typeNameOf(right)} with ${typeNameOf(left)}: ` +
        `"${String(right)}" is not convertible to ${typeNameOf(left)}`,
    );
    this.name = 'ComparisonTypeError';
  }
}

/**
 * Convert `b` to the type of `a`, as PowerShell does before comparing.
 * Returns the pair to compare, or throws if the conversion is impossible.
 */
function coerceToLeft(a: PSValue, b: PSValue): [PSValue, PSValue] {
  // Two opaque objects are not one value. pwsh reports False for `$a -eq $b` on
  // two distinct PSCustomObjects and raises "does not implement IComparable" for
  // `$a -lt $b`; comparing their text forms would call every pair equal, since
  // ToString() is the empty string for both.
  //
  // This has to run before the typeof shortcut below, because two PSObjects are
  // both 'object' and the shortcut would return first. But "opaque" is the whole
  // point: a value that is ALSO a Date has a comparable representation, and
  // PSDateTime is exactly that — a Date carrying pwsh's property set, so
  // isPSObject and `instanceof Date` are both true of it. Guarding on isPSObject
  // alone made two dates incomparable, which integration caught.
  const opaque = (v: PSValue): boolean =>
    isPSObject(v) && !(v instanceof Date) && !(v instanceof Uint8Array) && !Array.isArray(v);
  if (opaque(a) && opaque(b)) throw new ComparisonTypeError(a, b);

  if (typeof b === typeof a) return [a, b];

  if (typeof a === 'boolean') return [a, isTruthy(b)];

  if (typeof a === 'number' || typeof a === 'bigint') {
    if (typeof b === 'boolean') return [a, b ? 1 : 0];
    const text = typeof b === 'string' ? b.trim() : toPSString(b);

    // Int64 goes through BigInt directly, never through Number. The whole reason
    // the binder produces a bigint for Int64 is that a double cannot hold
    // 9223372036854775807 — and routing the comparison back through Number()
    // undid that on the first use: BigInt(Number('9223372036854775807')) is
    // ...808, so the value never equalled its own string form.
    if (typeof a === 'bigint' && /^[+-]?\d+$/.test(text)) return [a, BigInt(text)];

    const n = text === '' ? 0 : Number(text);
    if (!Number.isFinite(n)) throw new ComparisonTypeError(a, b);
    return typeof a === 'bigint' && Number.isInteger(n) ? [a, BigInt(n)] : [Number(a), n];
  }

  if (a instanceof Date) {
    const d = b instanceof Date ? b : new Date(String(b));
    if (Number.isNaN(d.getTime())) throw new ComparisonTypeError(a, b);
    return [a, d];
  }

  // Left is a string, an array, or an object: PowerShell compares as strings.
  return [a, b];
}

/**
 * PowerShell's ordering comparison — the semantics of `-lt`, `-gt`, `-le`,
 * `-ge`, and of `[LanguagePrimitives]::Compare`.
 *
 * THE RIGHT OPERAND IS CONVERTED TO THE LEFT OPERAND'S TYPE. This is the whole
 * rule, and getting it wrong is not a rounding error. The previous version fell
 * back to string collation whenever the JS types differed, so `10 -lt '9'`
 * answered True; real pwsh 7.6.5 answers False, because it compares 10 with the
 * number 9. Every comparison mixing a number with a numeric string was wrong,
 * and the differential harness is what found it rather than any amount of
 * reading the code.
 *
 * The rule is directional, which looks like a bug until you check:
 *   10 -lt '9'  is False   (right becomes the number 9)
 *   '9' -lt 10  is False   (right becomes the string '10'; '9' sorts after)
 * Both measured. It also explains why Sort-Object's output depends on the order
 * of its input — `@('2',10,'1',9)` sorts to 1 2 9 10 but `@(10,'2',9,'1')` to
 * 1 10 2 9 — which is an emergent consequence of pairwise coercion, not a
 * separate rule to implement.
 *
 * A conversion that cannot be done THROWS, matching the operator and
 * [LanguagePrimitives]::Compare, both of which raise on `1 -lt 'a'`. Sort-Object
 * does NOT throw there — it catches and orders numbers before strings — but that
 * is Sort-Object's behaviour to implement, not this function's to fake.
 *
 * `caseSensitive` defaults to FALSE because PowerShell's `-eq` is
 * case-insensitive and `-ceq` is the explicit case-sensitive form. Defaulting
 * the other way would be wrong on the most-used operator in the language.
 *
 * String ordering is CULTURE-AWARE, because PowerShell's is. This was verified
 * rather than assumed, and the assumption was wrong: by code point "B" < "a"
 * (Ordinal compare returns -31), but pwsh 7.6.5 reports `'B' -lt 'a'` as False,
 * agreeing with culture-aware comparison (which returns 1). Sorting
 * b, A, a, B in the reference implementation yields A, a, b, B.
 *
 * The locale is PINNED to 'en' rather than taken from the host. That keeps the
 * ordering deterministic across machines — a differential test must not depend
 * on the runner's locale — while still matching the reference implementation on
 * every case probed. Collation outside the Latin script is a known limit and
 * belongs in known-differences.yml if it ever matters.
 *
 * Known gap, recorded rather than hidden: pwsh accepts digit grouping, so
 * `[int]'1,000'` is 1000, while the conversion here reads '1,000' as
 * unconvertible. Nothing in the corpus depends on it yet.
 *
 * @throws ComparisonTypeError when the right operand cannot be converted.
 */
export function compareValues(a: PSValue, b: PSValue, caseSensitive = false): number {
  // $null sorts before everything and equals only itself. Measured: `$null -lt 1`
  // is True, `1 -gt $null` is True, and `'' -eq $null` is False — an empty
  // string is not null.
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;

  const [x, y] = coerceToLeft(a, b);

  if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : x > y ? 1 : 0;
  if (typeof x === 'bigint' && typeof y === 'bigint') return x < y ? -1 : x > y ? 1 : 0;
  if (typeof x === 'boolean' && typeof y === 'boolean') {
    return x === y ? 0 : x ? 1 : -1;
  }
  if (x instanceof Date && y instanceof Date) {
    const p = x.getTime();
    const q = y.getTime();
    return p < q ? -1 : p > q ? 1 : 0;
  }

  const collator = caseSensitive ? COLLATOR_SENSITIVE : COLLATOR_INSENSITIVE;
  const result = collator.compare(toPSString(x), toPSString(y));
  return result < 0 ? -1 : result > 0 ? 1 : 0;
}

/**
 * The TOTAL order the cmdlets use — Sort-Object, Measure-Object -Minimum/-Maximum,
 * Group-Object key ordering. Never throws.
 *
 * The operators and the cmdlets genuinely disagree, so this is a second function
 * rather than a flag. `1 -lt 'a'` throws, but `@(1,'a') | Sort-Object` succeeds
 * and yields `1 a`; a sort that raised on its own input would be useless.
 *
 * What the fallback is was measured, not guessed, and the obvious guess was
 * wrong. Ordering by type rank — numbers, then strings, then booleans — fits
 * `@('a',1)` -> `1 a` and `@(1,'a',$true)` -> `1 a True`, so it looked settled.
 * The discriminating case says otherwise:
 *
 *   @('zzz',$true) | Sort-Object   ->  True zzz
 *   @('aaa',$true) | Sort-Object   ->  aaa True
 *
 * A type rank cannot produce both. Comparing the string forms produces both, and
 * also every other case probed, including `@('a',(Get-Date))` putting the
 * DateTime first because its string form begins with a digit. So on a failed
 * conversion PowerShell simply compares the values as text.
 */
export function compareForSorting(a: PSValue, b: PSValue, caseSensitive = false): number {
  try {
    return compareValues(a, b, caseSensitive);
  } catch (error) {
    if (!(error instanceof ComparisonTypeError)) throw error;
    const collator = caseSensitive ? COLLATOR_SENSITIVE : COLLATOR_INSENSITIVE;
    const result = collator.compare(toPSString(a), toPSString(b));
    return result < 0 ? -1 : result > 0 ? 1 : 0;
  }
}

/**
 * `-eq` semantics.
 *
 * Separate from compareValues because the asymmetry is real and measured:
 * `10 -eq 'abc'` is False, while `10 -lt 'abc'` throws. Equality answers the
 * question "are these the same value", and two values of incompatible types are
 * simply not the same; ordering has no answer to give, so it refuses.
 */
export function valuesEqual(a: PSValue, b: PSValue, caseSensitive = false): boolean {
  try {
    return compareValues(a, b, caseSensitive) === 0;
  } catch (error) {
    if (error instanceof ComparisonTypeError) return false;
    throw error;
  }
}

/**
 * PowerShell truthiness, which is not JavaScript's.
 *
 * The differences that bite: an EMPTY ARRAY is false, a single-element array
 * takes the truthiness of its element, and the string "0" is TRUE (it is a
 * non-empty string) while the number 0 is false.
 */
export function isTruthy(value: PSValue): boolean {
  if (value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'bigint') return value !== 0n;
  if (typeof value === 'string') return value.length > 0;
  if (value instanceof Uint8Array) return value.length > 0;
  if (Array.isArray(value)) {
    if (value.length === 0) return false;
    if (value.length === 1) return isTruthy(value[0] as PSValue);
    return true;
  }
  return true;
}

// ---------------------------------------------------------------------------
// enumeration
// ---------------------------------------------------------------------------

/**
 * Unroll a value the way the pipeline does: ONE LEVEL, not recursively.
 *
 * Verified against pwsh 7.6.5, which corrected the original assumption here.
 * `@(1, @(2,3))` sends two things — the Int32 1, and the Object[] @(2,3) — so
 * a nested array arrives at the next command intact rather than flattened.
 * Recursing would have made `@(1,@(2,3)) | Measure-Object` report 3 where the
 * reference implementation reports 2.
 *
 * `$null` DOES flow: `@($null,1) | ForEach-Object` runs twice. It is
 * Measure-Object specifically that does not count nulls, which is that
 * command's behaviour and not the pipeline's.
 */
export function* enumerate(value: PSValue): Generator<PSValue> {
  if (Array.isArray(value)) {
    for (const item of value) yield item as PSValue;
    return;
  }
  yield value;
}
