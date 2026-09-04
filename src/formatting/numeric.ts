/**
 * numeric.ts — .NET's numeric format specifiers, rounded the way .NET rounds.
 *
 * TWO THINGS HERE ARE NOT THE OBVIOUS IMPLEMENTATION, and both were measured.
 *
 * 1. THE ROUNDING IS HALF-EVEN, ON THE EXACT BINARY VALUE.
 *
 *      pwsh: '{0:N0}' -f 2.5     ->  2      JavaScript: (2.5).toFixed(0) -> "3"
 *      pwsh: '{0:N0}' -f 3.5     ->  4
 *      pwsh: '{0:F2}' -f 0.125   ->  0.12
 *      pwsh: '{0:F2}' -f 0.135   ->  0.14
 *
 *    The last two are the pair that proves it has to be exact rather than
 *    approximate: 0.125 is exactly representable and ties to even (down), while
 *    0.135 is really 0.13500000000000000888… and rounds UP. A `toFixed` or a
 *    `Math.round(x * 100) / 100` gets one of them wrong whichever way it leans.
 *    So the value is decomposed into its IEEE-754 mantissa and exponent and the
 *    rounding is done in exact BigInt arithmetic. `1.005` -> `1.00` (the double
 *    is below the tie) and `2.675` -> `2.67` fall out of the same machinery.
 *
 * 2. `'{0}'` WITH NO SPECIFIER IS NOT `"$x"`.
 *
 *      '{0}' -f (0.1 + 0.2)   ->  0.30000000000000004
 *      "$(0.1 + 0.2)"         ->  0.3
 *
 *    PowerShell's own conversion is G15 (see to-string.ts). The format operator
 *    goes through String.Format, which is .NET Core's shortest round-trippable
 *    form — the same digits JavaScript's String() produces. What differs is
 *    when it switches to exponential notation:
 *
 *      value      .NET            JavaScript String()
 *      0.0001     0.0001          0.0001
 *      0.00001    1E-05           0.00001      <-- differ
 *      1e16       10000000000000000            same
 *      1e17       1E+17           100000000000000000  <-- differ
 *
 *    Measured: .NET goes exponential below 1e-4 and at or above 1e17;
 *    JavaScript below 1e-6 and at or above 1e21. So the digits are taken from
 *    JavaScript and the presentation is rebuilt.
 */

import type { CultureData } from './culture.ts';

/** Raised when a format specifier cannot be applied to the value. */
export class NumericFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NumericFormatError';
  }
}

// ---------------------------------------------------------------------------
// exact arithmetic on a double
// ---------------------------------------------------------------------------

const SCRATCH = new DataView(new ArrayBuffer(8));

/** A finite double as `(-1)^negative * mantissa * 2^exponent`, exactly. */
function decompose(value: number): { negative: boolean; mantissa: bigint; exponent: number } {
  SCRATCH.setFloat64(0, value);
  const hi = SCRATCH.getUint32(0);
  const lo = SCRATCH.getUint32(4);
  const negative = (hi & 0x80000000) !== 0;
  const rawExponent = (hi >>> 20) & 0x7ff;
  const rawMantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  // Subnormals have no implicit leading bit and a fixed exponent.
  if (rawExponent === 0) return { negative, mantissa: rawMantissa, exponent: -1074 };
  return { negative, mantissa: rawMantissa | (1n << 52n), exponent: rawExponent - 1075 };
}

const TEN = 10n;
const pow10 = (n: number): bigint => TEN ** BigInt(n);

/**
 * `round(|value| * 10^scale)` with ties going to even, computed exactly.
 *
 * `scale` may be negative, which is what the E specifier needs when the value
 * is large: rounding 1234.5 to three significant digits is a scale of -1.
 */
function roundScaled(value: number, scale: number): bigint {
  const { mantissa, exponent } = decompose(value);
  if (mantissa === 0n) return 0n;

  let numerator = mantissa;
  let denominator = 1n;

  if (exponent >= 0) numerator <<= BigInt(exponent);
  else denominator <<= BigInt(-exponent);

  if (scale >= 0) numerator *= pow10(scale);
  else denominator *= pow10(-scale);

  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;

  const twice = remainder * 2n;
  if (twice > denominator) return quotient + 1n;
  if (twice < denominator) return quotient;
  // Exactly halfway: to even.
  return quotient % 2n === 0n ? quotient : quotient + 1n;
}

/**
 * `|value|` as an integer part and exactly `digits` fraction digits.
 * The sign is reported separately, because .NET keeps it even when the rounded
 * magnitude is zero: `'{0:N2}' -f -0.001` is `-0.00`, measured.
 */
function fixedDigits(value: number, digits: number): { negative: boolean; whole: string; fraction: string } {
  const negative = value < 0 || Object.is(value, -0);
  const scaled = roundScaled(value, digits).toString();
  const padded = scaled.padStart(digits + 1, '0');
  const cut = padded.length - digits;
  return {
    negative,
    whole: padded.slice(0, cut),
    fraction: digits === 0 ? '' : padded.slice(cut),
  };
}

/** Insert the culture's group separator. Every culture measured groups by 3. */
function group(whole: string, culture: CultureData): string {
  const size = culture.numberGroupSizes[0] ?? 3;
  if (size <= 0 || whole.length <= size) return whole;
  const parts: string[] = [];
  let index = whole.length;
  while (index > size) {
    parts.unshift(whole.slice(index - size, index));
    index -= size;
  }
  parts.unshift(whole.slice(0, index));
  return parts.join(culture.numberGroupSeparator);
}

/**
 * NaN and the infinities ignore every specifier — `'{0:N2}' -f [double]::NaN`
 * is `NaN`, not `NaN.00`. Note the symbols: .NET Core on ICU reports `∞`,
 * not the word "Infinity" the .NET Framework used.
 */
function nonFinite(value: number, culture: CultureData): string | null {
  if (Number.isNaN(value)) return culture.nan;
  if (value === Infinity) return culture.positiveInfinity;
  if (value === -Infinity) return culture.negativeInfinity;
  return null;
}

// ---------------------------------------------------------------------------
// the pieces each specifier is built from
// ---------------------------------------------------------------------------

/** `F` — fixed point, no group separators. */
export function formatFixed(value: number, digits: number, culture: CultureData): string {
  const special = nonFinite(value, culture);
  if (special !== null) return special;
  const { negative, whole, fraction } = fixedDigits(value, digits);
  const body = fraction === '' ? whole : `${whole}${culture.numberDecimalSeparator}${fraction}`;
  return negative ? culture.negativeSign + body : body;
}

/** `N` — fixed point with group separators. */
export function formatNumber(value: number, digits: number, culture: CultureData): string {
  const special = nonFinite(value, culture);
  if (special !== null) return special;
  const { negative, whole, fraction } = fixedDigits(value, digits);
  const grouped = group(whole, culture);
  const body = fraction === '' ? grouped : `${grouped}${culture.numberDecimalSeparator}${fraction}`;
  return negative ? culture.negativeSign + body : body;
}

/**
 * `P` — percent. The value is multiplied by 100 first, and the symbol's
 * placement comes from the culture's pattern:
 *
 *   en-US  '{0:P1}' -f 0.1234  ->  12.3%      (pattern 1, "n%")
 *   de-DE  '{0:P1}' -f 0.1234  ->  12,3 %     (pattern 0, "n %", U+0020)
 *
 * The separating space was read as a code point rather than eyeballed: it is 32,
 * not a non-breaking 160, and a wrong one would fail a byte comparison while
 * looking identical in a diff.
 */
export function formatPercent(value: number, digits: number, culture: CultureData): string {
  const special = nonFinite(value, culture);
  if (special !== null) return special;
  const scaled = value * 100;
  const { negative } = fixedDigits(scaled, digits);
  const magnitude = formatNumber(Math.abs(scaled), digits, culture);
  const symbol = culture.percentSymbol;
  const positioned =
    culture.percentPositivePattern === 0
      ? `${magnitude} ${symbol}`
      : culture.percentPositivePattern === 1
        ? `${magnitude}${symbol}`
        : culture.percentPositivePattern === 2
          ? `${symbol}${magnitude}`
          : `${symbol} ${magnitude}`;
  return negative ? culture.negativeSign + positioned : positioned;
}

/**
 * `C` — currency.
 *
 *   en-US  '{0:C}' -f 1234.5   ->  $1,234.50    '{0:C}' -f -1234.5  ->  -$1,234.50
 *   de-DE  '{0:C}' -f 1234.5   ->  1.234,50 €   '{0:C}' -f -1234.5  ->  -1.234,50 €
 *
 * Negatives are the negative sign followed by the positive pattern. .NET has a
 * separate `CurrencyNegativePattern` with sixteen variants; for both cultures
 * measured it agrees with this, and pretending to model the other fourteen
 * would be a claim nothing here checks.
 */
export function formatCurrency(value: number, digits: number, culture: CultureData): string {
  const special = nonFinite(value, culture);
  if (special !== null) return special;
  const magnitude = formatNumber(Math.abs(value), digits, culture);
  const symbol = culture.currencySymbol;
  const positioned =
    culture.currencyPositivePattern === 0
      ? `${symbol}${magnitude}`
      : culture.currencyPositivePattern === 1
        ? `${magnitude}${symbol}`
        : culture.currencyPositivePattern === 2
          ? `${symbol} ${magnitude}`
          : `${magnitude} ${symbol}`;
  const negative = value < 0 || Object.is(value, -0);
  return negative ? culture.negativeSign + positioned : positioned;
}

/**
 * `E` — scientific. Six fraction digits by default and a THREE-digit exponent
 * that always carries its sign:
 *
 *   '{0:E}'  -f 1234.5  ->  1.234500E+003
 *   '{0:E2}' -f 1234.5  ->  1.23E+003
 *   '{0:e2}' -f 1234.5  ->  1.23e+003
 *   '{0:E}'  -f 0.0     ->  0.000000E+000
 */
export function formatExponential(
  value: number,
  digits: number,
  culture: CultureData,
  upper: boolean,
): string {
  const special = nonFinite(value, culture);
  if (special !== null) return special;

  const marker = upper ? 'E' : 'e';
  if (value === 0) {
    const zeroFraction = digits === 0 ? '' : culture.numberDecimalSeparator + '0'.repeat(digits);
    const sign = Object.is(value, -0) ? culture.negativeSign : '';
    return `${sign}0${zeroFraction}${marker}+000`;
  }

  const magnitude = Math.abs(value);
  let exponent = Math.floor(Math.log10(magnitude));
  // log10 is not exact at the powers of ten, so the digit count decides.
  let scaled = roundScaled(magnitude, digits - exponent);
  if (scaled.toString().length > digits + 1) {
    exponent += 1;
    scaled = roundScaled(magnitude, digits - exponent);
  } else if (scaled.toString().length < digits + 1) {
    exponent -= 1;
    scaled = roundScaled(magnitude, digits - exponent);
  }

  const text = scaled.toString();
  const head = text.slice(0, 1);
  const tail = text.slice(1);
  const body = tail === '' ? head : `${head}${culture.numberDecimalSeparator}${tail}`;
  const expSign = exponent < 0 ? '-' : '+';
  const expDigits = String(Math.abs(exponent)).padStart(3, '0');
  const sign = value < 0 ? culture.negativeSign : '';
  return `${sign}${body}${marker}${expSign}${expDigits}`;
}

/**
 * `D` — decimal, integers only. `'{0:D}' -f 1.5` throws in pwsh with
 * "Format specifier was invalid.", so it throws here rather than silently
 * truncating. The precision pads the DIGITS, leaving the sign outside:
 * `'{0:D5}' -f -42` is `-00042`, measured.
 */
export function formatDecimalInteger(
  value: number | bigint,
  digits: number,
  culture: CultureData,
): string {
  if (typeof value === 'number' && !Number.isInteger(value)) {
    throw new NumericFormatError('Format specifier was invalid.');
  }
  const negative = value < 0;
  const magnitude = (negative ? -value : value).toString();
  return (negative ? culture.negativeSign : '') + magnitude.padStart(digits, '0');
}

/**
 * `X` — hexadecimal, integers only.
 *
 * A negative value is the two's complement of its .NET integer type, which
 * means the WIDTH is part of the answer:
 *
 *   '{0:X}' -f -1            ->  FFFFFFFF          (Int32)
 *   '{0:X}' -f ([int64]-1)   ->  FFFFFFFFFFFFFFFF  (Int64)
 *
 * The width follows the same Int32/Int64 rule psobject.ts uses for `typeNameOf`,
 * so the two cannot disagree about what type a literal has.
 */
export function formatHex(value: number | bigint, digits: number, upper: boolean): string {
  if (typeof value === 'number' && !Number.isInteger(value)) {
    throw new NumericFormatError('Format specifier was invalid.');
  }
  let magnitude = typeof value === 'bigint' ? value : BigInt(value);
  if (magnitude < 0n) {
    const width = typeof value === 'bigint' || magnitude < -2147483648n ? 64n : 32n;
    magnitude += 1n << width;
  }
  const text = magnitude.toString(16);
  const padded = text.padStart(digits, '0');
  return upper ? padded.toUpperCase() : padded;
}

/**
 * `G` / no specifier — the shortest round-trippable form, presented .NET's way.
 *
 * `precision` is the `G15` in `'{0:G15}'`; when absent the shortest round-trip
 * digits are used, which is what JavaScript's Number-to-string already gives.
 * Only the exponential thresholds are rebuilt (see the file header).
 */
export function formatGeneral(
  value: number | bigint,
  precision: number | null,
  culture: CultureData,
  upper: boolean,
): string {
  if (typeof value === 'bigint') return value.toString();
  const special = nonFinite(value, culture);
  if (special !== null) return special;
  if (value === 0) return Object.is(value, -0) ? `${culture.negativeSign}0` : '0';

  const marker = upper ? 'E' : 'e';
  const magnitude = Math.abs(value);
  const sign = value < 0 ? culture.negativeSign : '';

  // Significant digits, and the decimal exponent of the leading one.
  let digits: string;
  let exponent: number;
  if (precision === null) {
    const shortest = magnitude.toExponential();
    const [head, exp] = shortest.split('e') as [string, string];
    digits = head.replace('.', '').replace(/0+$/, '') || '0';
    exponent = Number(exp);
  } else {
    const raw = magnitude.toExponential(Math.max(0, precision - 1));
    const [head, exp] = raw.split('e') as [string, string];
    digits = head.replace('.', '').replace(/0+$/, '') || '0';
    exponent = Number(exp);
    // Rounding 9.99 to two significant digits gives 10, one digit too many.
    if (digits.length > precision) {
      digits = digits.slice(0, precision);
      exponent += 1;
    }
  }

  // Measured thresholds: exponential below 1e-4 (0.0001 stays fixed, 0.00001
  // does not), and at or above 1e17 when the precision is the round-trip
  // default. With an explicit precision .NET uses that precision instead.
  const upperThreshold = precision ?? 17;
  if (exponent < -4 || exponent >= upperThreshold) {
    const head = digits.slice(0, 1);
    const tail = digits.slice(1);
    const body = tail === '' ? head : `${head}${culture.numberDecimalSeparator}${tail}`;
    const expSign = exponent < 0 ? '-' : '+';
    return `${sign}${body}${marker}${expSign}${String(Math.abs(exponent)).padStart(2, '0')}`;
  }

  if (exponent >= 0) {
    const whole = digits.length > exponent + 1 ? digits.slice(0, exponent + 1) : digits.padEnd(exponent + 1, '0');
    const fraction = digits.length > exponent + 1 ? digits.slice(exponent + 1) : '';
    return sign + (fraction === '' ? whole : `${whole}${culture.numberDecimalSeparator}${fraction}`);
  }
  return `${sign}0${culture.numberDecimalSeparator}${'0'.repeat(-exponent - 1)}${digits}`;
}

// ---------------------------------------------------------------------------
// custom format strings
// ---------------------------------------------------------------------------

/**
 * A custom numeric format such as `#,##0.00`, `000.0`, `0.0%` or `0.0;(0.0)`.
 *
 * Measured, in order of how surprising they are:
 *
 *   '{0:#,##0.00}' -f 1234.5   ->  1,234.50
 *   '{0:0.0;(0.0)}' -f -1.5    ->  (1.5)      a second section is the NEGATIVE form
 *   '{0:0.0%}'  -f 0.5         ->  50.0%      `%` multiplies by a hundred
 *   '{0:0.0‰}'  -f 0.5         ->  500.0‰     and `‰` by a thousand
 *   '{0:0 units}' -f 3         ->  3 units    unrecognised characters are literal
 *   '{0:\#0}'   -f 3           ->  #3         backslash escapes
 *   '{0:ZZZ}'   -f 1234.5      ->  ZZZ        which is why a bad STANDARD
 *                                             specifier is not an error: it is
 *                                             read as a custom one, and every
 *                                             character of it is a literal
 *
 * Not implemented, and named rather than approximated: `E` inside a custom
 * string (scientific sections), the `,` scaling suffix (`0,,` meaning millions),
 * and a third section for zero.
 */
export function formatCustom(value: number | bigint, pattern: string, culture: CultureData): string {
  const sections = splitSections(pattern);
  const numeric = typeof value === 'bigint' ? Number(value) : value;
  const negative = numeric < 0;
  const chosen = negative && sections.length > 1 ? (sections[1] as string) : (sections[0] as string);
  // With an explicit negative section the sign is part of the pattern, so the
  // magnitude is what gets formatted: `0.0;(0.0)` on -1.5 is `(1.5)`, not `(-1.5)`.
  const useMagnitude = negative && sections.length > 1;

  const special = typeof numeric === 'number' ? nonFinite(numeric, culture) : null;
  if (special !== null) return special;

  let scale = 1;
  for (const char of chosen) {
    if (char === '%') scale *= 100;
    else if (char === '‰') scale *= 1000;
  }

  const target = (useMagnitude ? Math.abs(numeric) : numeric) * scale;

  // Digit places, so the value can be rounded before it is laid into the pattern.
  const dot = indexOfUnescaped(chosen, '.');
  const fractionPart = dot === -1 ? '' : chosen.slice(dot + 1);
  const fractionPlaces = countPlaces(fractionPart);
  const wholePart = dot === -1 ? chosen : chosen.slice(0, dot);
  const grouping = indexOfUnescaped(wholePart, ',') !== -1;

  const { negative: isNegative, whole, fraction } = fixedDigits(target, fractionPlaces);
  const trimmedWhole = whole.replace(/^0+(?=\d)/, '');

  let wholeDigits = layWhole(wholePart, trimmedWhole, grouping ? culture : null);
  if (isNegative && !useMagnitude) wholeDigits = culture.negativeSign + wholeDigits;
  return wholeDigits + (dot === -1 ? '' : layFraction(fractionPart, fraction, culture));
}

/** Split on unescaped `;`, which separates the positive/negative sections. */
function splitSections(pattern: string): string[] {
  const sections: string[] = [];
  let current = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string;
    if (char === '\\' && i + 1 < pattern.length) {
      current += char + (pattern[i + 1] as string);
      i += 1;
      continue;
    }
    if (char === ';') {
      sections.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  sections.push(current);
  return sections;
}

function indexOfUnescaped(pattern: string, target: string): number {
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string;
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (char === target) return i;
  }
  return -1;
}

const countPlaces = (part: string): number => {
  let count = 0;
  for (let i = 0; i < part.length; i++) {
    const char = part[i] as string;
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (char === '0' || char === '#') count += 1;
  }
  return count;
};

/** One character of a custom pattern: a digit place, or a literal to copy. */
interface PatternPart {
  readonly place: '0' | '#' | null;
  readonly literal: string;
}

/**
 * Split a section into digit places and literals. `\` escapes the next
 * character, and an unescaped `,` in the integer section is a grouping marker
 * rather than a literal comma.
 */
function tokenize(pattern: string, dropCommas: boolean): PatternPart[] {
  const parts: PatternPart[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string;
    if (char === '\\') {
      parts.push({ place: null, literal: pattern[i + 1] ?? '' });
      i += 1;
      continue;
    }
    if (char === '0' || char === '#') {
      parts.push({ place: char, literal: '' });
      continue;
    }
    if (char === ',' && dropCommas) continue;
    parts.push({ place: null, literal: char });
  }
  return parts;
}

/**
 * Lay the integer digits into the pattern's integer section.
 *
 * All the digits go at the LEFTMOST place, because .NET never drops significant
 * digits for want of places: `#` on 1234 is `1234`, not `4`. Remaining places
 * emit a zero only when they are `0`, which is what gives `000.0` on 1.5 the
 * answer `001.5`.
 */
function layWhole(pattern: string, digits: string, culture: CultureData | null): string {
  const parts = tokenize(pattern, true);
  const zeroPlaces = parts.filter((p) => p.place === '0').length;

  // With no `0` place at all, a value that rounds to zero has no integer digit:
  // `#.##` on 0.5 is `.5`.
  let body = digits === '0' && zeroPlaces === 0 ? '' : digits.padStart(zeroPlaces, '0');
  if (culture !== null && body !== '') body = group(body, culture);

  const out: string[] = [];
  let placesSeen = 0;
  for (const part of parts) {
    if (part.place === null) {
      out.push(part.literal);
      continue;
    }
    placesSeen += 1;
    // The first place carries the whole number; the rest are already spent.
    if (placesSeen === 1) out.push(body);
  }
  // With no digit place at all the pattern is pure literal text, which is how
  // `'{0:ZZZ}' -f 1234.5` produces `ZZZ` and not `ZZZ1234`.
  return out.join('');
}

/**
 * Lay the fraction digits into the pattern's fraction section.
 *
 * A `#` place emits its digit only when something significant follows, which is
 * why `#.###` on 1.5 is `1.5` and not `1.500`. A section that emits no digit at
 * all also loses its decimal separator: `#.###` on 1 is `1`.
 */
function layFraction(pattern: string, digits: string, culture: CultureData): string {
  const parts = tokenize(pattern, false);

  // How far to the right anything must be kept: the last `0` place, or the last
  // non-zero digit, whichever is further.
  let keep = 0;
  let index = 0;
  for (const part of parts) {
    if (part.place === null) continue;
    index += 1;
    if (part.place === '0') keep = index;
    else if ((digits[index - 1] ?? '0') !== '0') keep = index;
  }

  const out: string[] = [];
  let emitted = 0;
  let seen = 0;
  for (const part of parts) {
    if (part.place === null) {
      out.push(part.literal);
      continue;
    }
    seen += 1;
    if (seen > keep) continue;
    out.push(digits[seen - 1] ?? '0');
    emitted += 1;
  }
  const body = out.join('');
  return emitted === 0 ? body : culture.numberDecimalSeparator + body;
}
