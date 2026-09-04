/**
 * to-string.ts — how a value becomes text.
 *
 * PowerShell has TWO conversions and they disagree, which is the whole reason
 * this file exists rather than a call to `String(x)`.
 *
 *   "$x"          culture-INVARIANT   the pipeline, string interpolation, -join
 *   $x.ToString() culture-DEPENDENT   an explicit method call
 *
 * Measured in pwsh 7.6.5 under en-US, de-DE and zh-TW:
 *
 *   culture   "$(1.5)"   (1.5).ToString()
 *   en-US     1.5        1.5
 *   de-DE     1.5        1,5          <-- they differ
 *   zh-TW     1.5        1.5
 *
 * Only `toPSString` is implemented here, because only the invariant form is
 * what the pipeline uses. A `.ToString()` that follows the host culture belongs
 * with the method-call evaluator, and it must NOT reuse this function.
 *
 * Every expectation below is a measurement, not a guess. The probe script is in
 * the scratchpad; the values are reproduced in to-string.test.mts so a future
 * change has to argue with pwsh rather than with an opinion.
 */

import { isPSObject, typeNameOf, type PSValue } from '../pipeline/psobject.ts';

/**
 * The separator PowerShell puts between array elements when it flattens one
 * into a string. It is a real variable — `$OFS = '-'` changes it — so this is a
 * parameter rather than a constant, and the default is a single space.
 */
export const DEFAULT_OFS = ' ';

/**
 * .NET's default double formatting is "G15": fifteen significant digits, not
 * the shortest round-trippable form JavaScript produces.
 *
 * This is not a detail. `"$(0.1 + 0.2)"` is `0.3` in PowerShell and
 * `0.30000000000000004` from JavaScript's `String()`, and `"$(1/3)"` is
 * `0.333333333333333` rather than `0.3333333333333333`. A terminal that printed
 * the JavaScript form would be visibly wrong on the first arithmetic anyone
 * tried.
 */
export function formatDouble(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  if (value === 0) return Object.is(value, -0) ? '0' : '0';
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);

  // .NET switches G-format to exponential when the exponent is below -5 or at
  // or above the precision. Measured: 1e21 prints as 1E+21, 0.00001 as 1E-05.
  const exponent = Math.floor(Math.log10(Math.abs(value)));
  if (exponent < -5 || exponent >= 15) {
    const [mantissa, exp] = value.toExponential(14).split('e') as [string, string];
    const trimmed = mantissa.includes('.') ? mantissa.replace(/0+$/, '').replace(/\.$/, '') : mantissa;
    const sign = exp.startsWith('-') ? '-' : '+';
    const digits = exp.replace(/^[+-]/, '').padStart(2, '0');
    return `${trimmed}E${sign}${digits}`;
  }

  const fixed = value.toPrecision(15);
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

/**
 * The invariant date format PowerShell uses when it flattens a DateTime into a
 * string. Measured: `"$(Get-Date '2020-03-04T05:06:07')"` is
 * `03/04/2020 05:06:07` regardless of culture, while `.ToString()` under en-US
 * gives `3/4/2020 12:00:00 AM` — a different format, not just different
 * separators.
 */
function formatDate(value: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${p(value.getMonth() + 1)}/${p(value.getDate())}/${p(value.getFullYear(), 4)} ` +
    `${p(value.getHours())}:${p(value.getMinutes())}:${p(value.getSeconds())}`
  );
}

/** `@{a=1; b=2}`, the form PowerShell prints for a PSCustomObject. */
function formatPSObject(properties: Readonly<Record<string, PSValue>>, ofs: string): string {
  const body = Object.entries(properties)
    .map(([key, value]) => `${key}=${toPSString(value, ofs)}`)
    .join('; ');
  return `@{${body}}`;
}

/**
 * `"$x"` — the culture-invariant conversion the pipeline uses.
 *
 * The cases that are not obvious, each measured:
 *
 *   $null                 ""            an empty string, not "null"
 *   @()                   ""            an empty array is an empty string
 *   @(1,2,3)              "1 2 3"       joined with $OFS
 *   @($null,1)            " 1"          the null becomes "", the separator stays
 *   $true                 "True"        capitalised, unlike JavaScript
 *   1.0                   "1"           a whole double loses its point
 *   [pscustomobject]@{a=1} "@{a=1}"     while .ToString() gives ""
 *   @{a=1}                a hashtable prints its TYPE, not its contents
 */
export function toPSString(value: PSValue, ofs: string = DEFAULT_OFS): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return formatDouble(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return formatDate(value);
  if (value instanceof Uint8Array) return Array.from(value).join(ofs);
  if (Array.isArray(value)) return value.map((item) => toPSString(item as PSValue, ofs)).join(ofs);

  if (isPSObject(value)) {
    // A PSCustomObject prints its properties. Anything with a real .NET type
    // behind it prints the type name, which is what a Hashtable does.
    const name = typeNameOf(value);
    if (name === 'System.Management.Automation.PSCustomObject' || name === 'PSCustomObject') {
      return formatPSObject(value.properties, ofs);
    }
    return name;
  }

  return String(value);
}

/**
 * `$x.ToString()` — deliberately NOT implemented here.
 *
 * It follows the host culture, so under de-DE `(1.5).ToString()` is `1,5`, and
 * an evaluator that reused `toPSString` for it would silently make the two
 * conversions agree when the reference implementation says they do not. It also
 * differs in kind, not only in separators: `@(1,2).ToString()` is
 * `System.Object[]` where `"$(@(1,2))"` is `1 2`, and `$null.ToString()` throws
 * where `"$null"` is empty.
 *
 * Left here as a signpost so nobody wires the wrong one in.
 */
export const TO_STRING_IS_CULTURE_DEPENDENT = true;
