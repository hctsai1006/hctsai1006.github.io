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
 */

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
  const direct = target.properties[name];
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
      return Number.isInteger(value) ? 'System.Int32' : 'System.Double';
    default:
      return 'System.Object';
  }
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
export function compareValues(a: PSValue, b: PSValue, caseSensitive = false): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;

  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    const x = BigInt(a as bigint | number);
    const y = BigInt(b as bigint | number);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (a instanceof Date && b instanceof Date) {
    const x = a.getTime();
    const y = b.getTime();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return a === b ? 0 : a ? 1 : 0 - 1;
  }

  const collator = caseSensitive ? COLLATOR_SENSITIVE : COLLATOR_INSENSITIVE;
  const result = collator.compare(String(a), String(b));
  return result < 0 ? -1 : result > 0 ? 1 : 0;
}

/** `-eq` semantics. */
export const valuesEqual = (a: PSValue, b: PSValue, caseSensitive = false): boolean =>
  compareValues(a, b, caseSensitive) === 0;

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
