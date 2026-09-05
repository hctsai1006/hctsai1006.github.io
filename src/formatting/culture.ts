/**
 * culture.ts — the number and date data the CULTURE-DEPENDENT conversions need.
 *
 * to-string.ts covers `"$x"`, which is culture-INVARIANT and therefore needs
 * none of this. Two other conversions are not invariant, and this file exists
 * for them:
 *
 *   'N2' -f 1234.5     1,234.50 (en-US)   1.234,50 (de-DE)
 *   Format-Table cell  1.500    (en-US)   1.500    (zh-TW)
 *
 * WHY THE DATA IS CAPTURED AND NOT TRANSCRIBED
 *
 * This file used to be four hand-written tables, and its header used to justify
 * them with a measurement:
 *
 *     culture   .NET NumberDecimalDigits   Intl maximumFractionDigits
 *     zh-TW     2                          3     <-- disagree
 *
 * There is no such disagreement. Both say 3, on both hosts this project is
 * measured on. The justification was false, and the tables it justified had at
 * least nine wrong values in them — zh-TW's decimal digits, its percent digits,
 * its currency symbol, its NaN symbol, both of its date patterns, de-DE's two
 * designators and the invariant culture's percent pattern. Every zh-TW date in
 * a three-hundred case corpus came out wrong; en-US and de-DE came out right,
 * which is exactly what transcription failure looks like — it tracks how
 * familiar the transcriber was with the culture, not how the runtime behaves.
 *
 * So the tables are gone and the data below is READ from a capture:
 *
 *     tools/capture-pwsh-culture.ps1
 *       -> compat/upstream/v7.6.5/culture-metadata-linux.json
 *
 * The reason is not that a capture is more accurate on the day it is taken. It
 * is that a capture can be RE-RUN and diffed, and a transcription can only be
 * re-read by the person who already believed it. `Intl` is still not used, and
 * now for a reason that survives checking: `Intl` reports what a BROWSER's ICU
 * thinks, which is neither pinned nor the thing this project claims to
 * reproduce. The claim is "PowerShell 7.6.5 on Linux", and that is what the
 * capture asks.
 *
 * WHERE THE TWO PLATFORMS DISAGREE, LINUX WINS
 *
 * The same capture was taken under pwsh 7.6.5 on Windows
 * (`culture-metadata-windows.json`, committed beside it). Two real divergences
 * came out, and the compatibility profiles this project publishes target
 * `powershell-7.6.5-linux`, so the Linux answer is the one loaded here:
 *
 *   1. en-US's time patterns separate the AM/PM designator with U+202F NARROW
 *      NO-BREAK SPACE on Linux and with U+0020 on Windows. CLDR 42 made that
 *      change; a current Linux ICU has it and this Windows host's ICU does not.
 *      It reaches every en-US `G`, `F`, `f`, `g`, `t`, `T` and `U` — so
 *      `'{0}' -f $date` really is `3/4/2020 5:06:07 AM` under the profile
 *      this project publishes, and the tests say so with an explicit escape
 *      rather than a space nobody can see in a diff.
 *
 *   2. `ShortestDayNames` are CLDR's narrow forms on Linux (`Su`, `Mo`, …;
 *      `So.`, `Mo.`, …) and single letters on Windows (`S`, `M`, …). Captured,
 *      not used: no .NET format specifier reads them.
 *
 * The `U` specifier's SAMPLES differ too, by exactly the two hosts' UTC offsets.
 * That is a timezone difference and not a culture one — `engine.timeZoneId` in
 * the capture says which zone produced it.
 *
 * WHICH CULTURES, AND WHY AN UNKNOWN ONE THROWS
 *
 * Only the cultures the conformance capture uses are here — en-US is the pinned
 * culture, de-DE the stress culture, zh-TW the host culture — plus the invariant
 * culture, which is not a locale. A name that is not in the capture is a hard
 * error rather than a silent fallback to en-US, because printing US separators
 * while claiming to be a French host is exactly the kind of quiet wrongness the
 * rest of this project refuses. Adding fr-FR is a capture run, not an edit here.
 */

import captured from '../../compat/upstream/v7.6.5/culture-metadata-linux.json' with { type: 'json' };

/**
 * Where the currency symbol goes for a POSITIVE value. .NET numbers these
 * patterns; the numbers are the ones `CurrencyPositivePattern` reports, so they
 * are reproduced rather than renamed.
 *
 *   0 = $n    1 = n$    2 = $ n    3 = n $
 */
export type CurrencyPositivePattern = 0 | 1 | 2 | 3;

/**
 *   0 = n %   1 = n%    2 = %n     3 = % n
 */
export type PercentPositivePattern = 0 | 1 | 2 | 3;

/**
 * `CurrencyNegativePattern`, 0..16. Sixteen of the seventeen are unused by the
 * four cultures captured, and the seventeenth is why the table exists at all:
 * the invariant culture is pattern 0, `($n)`, so `'{0:C}' -f -1` is `(¤1.00)`
 * and not `-¤1.00`. An implementation that assumed "negative sign, then the
 * positive pattern" — which is what this file's numeric side used to assume —
 * gets en-US, de-DE and zh-TW right and the invariant culture wrong.
 */
export type CurrencyNegativePattern =
  | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16;

/** `PercentNegativePattern`, 0..11. */
export type PercentNegativePattern =
  | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;

/** `NumberNegativePattern`, 0..4. Every culture captured reports 1, `-n`. */
export type NumberNegativePattern = 0 | 1 | 2 | 3 | 4;

/**
 * The nineteen standard date/time format specifiers, as .NET spells them. They
 * are case-SENSITIVE: `d` is the short date and `D` the long one, which is the
 * single most consequential fact in this file — a one-character format string is
 * read as a standard specifier, never as a custom one, so `'{0:d}' -f $date` is
 * `3/4/2026` and not the day number.
 */
export type StandardDateSpecifier =
  | 'd' | 'D' | 'f' | 'F' | 'g' | 'G' | 'm' | 'M' | 'o' | 'O'
  | 'r' | 'R' | 's' | 't' | 'T' | 'u' | 'U' | 'y' | 'Y';

const STANDARD_DATE_SPECIFIERS: readonly StandardDateSpecifier[] = [
  'd', 'D', 'f', 'F', 'g', 'G', 'm', 'M', 'o', 'O',
  'r', 'R', 's', 't', 'T', 'u', 'U', 'y', 'Y',
];

export interface CultureData {
  readonly name: string;

  // -- numbers -------------------------------------------------------------

  readonly numberDecimalSeparator: string;
  readonly numberGroupSeparator: string;
  /** Digits per group, least significant first. Every culture captured says [3]. */
  readonly numberGroupSizes: readonly number[];
  /**
   * How many fraction digits the `N` and `F` specifiers produce when the format
   * string does not say. This is also what Format-Table uses for a
   * floating-point cell, which is the least guessable thing in this file.
   *
   * Captured: en-US 3, de-DE 3, zh-TW 3, invariant 2. The old table said zh-TW
   * was 2 and built a whole argument on it.
   */
  readonly numberDecimalDigits: number;
  readonly numberNegativePattern: NumberNegativePattern;
  readonly percentDecimalDigits: number;
  readonly percentSymbol: string;
  readonly percentPositivePattern: PercentPositivePattern;
  readonly percentNegativePattern: PercentNegativePattern;
  readonly currencyDecimalDigits: number;
  readonly currencySymbol: string;
  readonly currencyPositivePattern: CurrencyPositivePattern;
  readonly currencyNegativePattern: CurrencyNegativePattern;
  readonly negativeSign: string;
  /**
   * .NET Core on ICU reports the SYMBOL, not the word: `[double]::PositiveInfinity`
   * in a table cell renders as `∞`. The invariant culture keeps `Infinity`,
   * which is why both forms appear in the capture.
   */
  readonly positiveInfinity: string;
  readonly negativeInfinity: string;
  /** zh-TW's is `非數值`, not `NaN`. Captured; the old table guessed `NaN`. */
  readonly nan: string;

  // -- dates ---------------------------------------------------------------

  /**
   * The culture's pattern for each standard specifier, as
   * `DateTimeFormatInfo.GetAllDateTimePatterns(letter)[0]` reports it.
   */
  readonly standardDatePatterns: Readonly<Record<StandardDateSpecifier, string>>;
  /**
   * The `G` (general) pattern, which is what `'{0}' -f $date` and a DateTime
   * table cell produce. An alias for `standardDatePatterns.G`, kept because it
   * is what the two call sites actually mean.
   */
  readonly dateTimePattern: string;
  /**
   * The `F`/`FullDateTimePattern`, which is what a BARE DateTime prints through
   * the default view — a different pattern from the one a table CELL uses:
   *
   *   [datetime]'2020-03-04T15:06:07' | Out-String
   *     Wednesday, March 4, 2020 3:06:07 PM      <- full
   *   [pscustomobject]@{ D = $d } | Format-Table
   *     3/4/2020 3:06:07 PM                      <- general
   */
  readonly fullDateTimePattern: string;
  /**
   * An unescaped `/` in a custom date pattern is not a slash: it is replaced by
   * the culture's date separator, and `:` by its time separator. So
   * `'{0:M/d/yyyy}' -f $d` is `3.4.2020` under de-DE. Measured.
   */
  readonly dateSeparator: string;
  readonly timeSeparator: string;
  readonly dayNames: readonly string[];
  readonly abbreviatedDayNames: readonly string[];
  /**
   * Thirteen entries, as .NET reports them: the thirteenth is a lunisolar leap
   * month and is empty for every Gregorian culture. Kept as captured so nothing
   * downstream has to guess whether an index was shifted.
   */
  readonly monthNames: readonly string[];
  readonly abbreviatedMonthNames: readonly string[];
  /**
   * .NET uses the genitive names for a pattern where the month FOLLOWS a day
   * number (`d. MMMM`). For all four cultures captured the full genitive names
   * equal the nominative ones, so the engine can use one array — but de-DE's
   * ABBREVIATED genitive names differ (`Jan.` vs `Jan`), and no captured
   * pattern uses `d MMM`, so that difference is recorded rather than modelled.
   */
  readonly monthGenitiveNames: readonly string[];
  readonly abbreviatedMonthGenitiveNames: readonly string[];
  readonly amDesignator: string;
  readonly pmDesignator: string;
  /**
   * What `g`/`gg`/`ggg` produce. en-US `AD`, de-DE `n. Chr.`, zh-TW `西元`,
   * invariant `A.D.` — which is why the old engine, which had `AD` hard-coded,
   * refused the specifier outright rather than answer for three cultures.
   */
  readonly eraName: string;
}

// ---------------------------------------------------------------------------
// reading the capture
// ---------------------------------------------------------------------------

/**
 * Raised when the captured JSON does not have the shape this file needs.
 *
 * A capture is regenerated by running a script against a different PowerShell,
 * so its shape CAN change under this file. Failing loudly at module load beats
 * `undefined` reaching a format string and printing as the text "undefined".
 */
export class CultureCaptureError extends Error {
  constructor(message: string) {
    super(`${message} (compat/upstream/v7.6.5/culture-metadata-linux.json)`);
    this.name = 'CultureCaptureError';
  }
}

const enumerated = <T extends number>(value: number, max: number, field: string): T => {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new CultureCaptureError(`${field} is ${String(value)}, outside .NET's 0..${String(max)}`);
  }
  return value as T;
};

/** The shape `Get-DateTimeFormatDetail` writes, narrowed to what is read here. */
interface CapturedDateTimeFormat {
  readonly amDesignator: string;
  readonly pmDesignator: string;
  readonly dateSeparator: string;
  readonly timeSeparator: string;
  readonly standardPatterns: Readonly<Record<string, string>>;
  readonly dayNames: readonly string[];
  readonly abbreviatedDayNames: readonly string[];
  readonly monthNames: readonly string[];
  readonly abbreviatedMonthNames: readonly string[];
  readonly monthGenitiveNames: readonly string[];
  readonly abbreviatedMonthGenitiveNames: readonly string[];
  readonly eras: readonly { readonly era: number; readonly name: string }[];
}

interface CapturedNumberFormat {
  readonly numberDecimalDigits: number;
  readonly numberDecimalSeparator: string;
  readonly numberGroupSeparator: string;
  readonly numberGroupSizes: readonly number[];
  readonly numberNegativePattern: number;
  readonly percentDecimalDigits: number;
  readonly percentSymbol: string;
  readonly percentPositivePattern: number;
  readonly percentNegativePattern: number;
  readonly currencyDecimalDigits: number;
  readonly currencySymbol: string;
  readonly currencyPositivePattern: number;
  readonly currencyNegativePattern: number;
  readonly negativeSign: string;
  readonly positiveInfinitySymbol: string;
  readonly negativeInfinitySymbol: string;
  readonly nanSymbol: string;
}

interface CapturedCulture {
  readonly name: string;
  readonly numberFormat: CapturedNumberFormat;
  readonly dateTimeFormat: CapturedDateTimeFormat;
}

function readStandardPatterns(
  key: string,
  patterns: Readonly<Record<string, string>>,
): Record<StandardDateSpecifier, string> {
  const out = {} as Record<StandardDateSpecifier, string>;
  for (const specifier of STANDARD_DATE_SPECIFIERS) {
    const pattern = patterns[specifier];
    if (typeof pattern !== 'string' || pattern === '') {
      throw new CultureCaptureError(`${key} has no pattern for the standard specifier '${specifier}'`);
    }
    out[specifier] = pattern;
  }
  return out;
}

function toCultureData(key: string, source: CapturedCulture): CultureData {
  const n = source.numberFormat;
  const d = source.dateTimeFormat;
  const standardDatePatterns = readStandardPatterns(key, d.standardPatterns);
  const era = d.eras[d.eras.length - 1];
  if (era === undefined) throw new CultureCaptureError(`${key} has no calendar era`);

  return {
    // The invariant culture's `Name` is the empty string, which is useless in an
    // error message, so the capture's key stands in for it.
    name: source.name === '' ? key : source.name,
    numberDecimalSeparator: n.numberDecimalSeparator,
    numberGroupSeparator: n.numberGroupSeparator,
    numberGroupSizes: Object.freeze([...n.numberGroupSizes]),
    numberDecimalDigits: n.numberDecimalDigits,
    numberNegativePattern: enumerated<NumberNegativePattern>(n.numberNegativePattern, 4, `${key} numberNegativePattern`),
    percentDecimalDigits: n.percentDecimalDigits,
    percentSymbol: n.percentSymbol,
    percentPositivePattern: enumerated<PercentPositivePattern>(n.percentPositivePattern, 3, `${key} percentPositivePattern`),
    percentNegativePattern: enumerated<PercentNegativePattern>(n.percentNegativePattern, 11, `${key} percentNegativePattern`),
    currencyDecimalDigits: n.currencyDecimalDigits,
    currencySymbol: n.currencySymbol,
    currencyPositivePattern: enumerated<CurrencyPositivePattern>(n.currencyPositivePattern, 3, `${key} currencyPositivePattern`),
    currencyNegativePattern: enumerated<CurrencyNegativePattern>(n.currencyNegativePattern, 16, `${key} currencyNegativePattern`),
    negativeSign: n.negativeSign,
    positiveInfinity: n.positiveInfinitySymbol,
    negativeInfinity: n.negativeInfinitySymbol,
    nan: n.nanSymbol,
    standardDatePatterns: Object.freeze(standardDatePatterns),
    dateTimePattern: standardDatePatterns.G,
    fullDateTimePattern: standardDatePatterns.F,
    dateSeparator: d.dateSeparator,
    timeSeparator: d.timeSeparator,
    dayNames: Object.freeze([...d.dayNames]),
    abbreviatedDayNames: Object.freeze([...d.abbreviatedDayNames]),
    monthNames: Object.freeze([...d.monthNames]),
    abbreviatedMonthNames: Object.freeze([...d.abbreviatedMonthNames]),
    monthGenitiveNames: Object.freeze([...d.monthGenitiveNames]),
    abbreviatedMonthGenitiveNames: Object.freeze([...d.abbreviatedMonthGenitiveNames]),
    amDesignator: d.amDesignator,
    pmDesignator: d.pmDesignator,
    eraName: era.name,
  };
}

const byKey = new Map<string, CultureData>();
for (const [key, source] of Object.entries(captured.cultures)) {
  byKey.set(key, toCultureData(key, source as CapturedCulture));
}

const require_ = (key: string): CultureData => {
  const found = byKey.get(key);
  if (found === undefined) throw new CultureCaptureError(`the capture has no culture '${key}'`);
  return found;
};

/**
 * en-US — the culture the conformance fixtures were captured under
 * (`capture.pinnedCulture`), and therefore the default everywhere below.
 *
 *   '{0:N2}' -f 1234.5   1,234.50
 *   '{0:N}'  -f 1234.5   1,234.500      <-- three digits, not two
 *   '{0:C}'  -f 1234.5   $1,234.50
 *   '{0:P1}' -f 0.1234   12.3%
 *   '{0}'    -f $date    3/4/2020 5:06:07 AM
 */
export const EN_US: CultureData = require_('en-US');

/**
 * de-DE — the capture's stress culture, chosen because it swaps BOTH separators.
 *
 *   '{0:N2}' -f 1234.5   1.234,50
 *   '{0:C}'  -f 1234.5   1.234,50 €     <-- symbol last, separated by U+0020
 *   '{0:P1}' -f 0.1234   12,3 %         <-- a plain space, verified by code point
 *   '{0}'    -f $date    04.03.2020 05:06:07
 *
 * Its AM/PM designators are `AM` and `PM`, not empty. The old table said empty,
 * which is what a reader who has only ever seen de-DE's 24-hour patterns would
 * assume — and it is wrong the moment anyone writes `'{0:tt}' -f $date`.
 */
export const DE_DE: CultureData = require_('de-DE');

/**
 * zh-TW — the host culture of the capture machine, and the culture the old hand
 * table got wrong in six places:
 *
 *   field                  old table            captured
 *   numberDecimalDigits    2                    3
 *   percentDecimalDigits   2                    3
 *   currencySymbol         NT$                  $
 *   nan                    NaN                  非數值
 *   G pattern              yyyy/M/d tt hh:mm:ss yyyy/M/d tth:mm:ss
 *   F pattern              no dddd              yyyy年M月d日 dddd tth:mm:ss
 *
 * Note the designator: it sits BEFORE the hour with NO space, and the hour is
 * `h` rather than `hh`. `2020/3/4 下午3:06:07`, not `2020/3/4 下午 03:06:07`.
 */
export const ZH_TW: CultureData = require_('zh-TW');

/**
 * The invariant culture. Not the same thing as en-US: its `NumberDecimalDigits`
 * is 2 because it is fixed by the .NET specification rather than taken from
 * ICU's en-US pattern, its currency symbol is `¤`, its infinities are words
 * rather than `∞`, and its percent pattern is 0 (`n %`) where en-US is 1 (`n%`).
 * The old table said 1, so `'{0:P}' -f 0.5` lost its space.
 */
export const INVARIANT: CultureData = require_('Invariant');

const CULTURES: ReadonlyMap<string, CultureData> = new Map([
  ['en-us', EN_US],
  ['de-de', DE_DE],
  ['zh-tw', ZH_TW],
  ['invariant', INVARIANT],
  ['', INVARIANT],
]);

/**
 * The default. en-US rather than Invariant, because that is the culture the
 * conformance fixtures were captured under and every expected string in the
 * tests is therefore an en-US one.
 */
export const DEFAULT_CULTURE = EN_US;

/**
 * The five pattern enumerations, as RENDERED TEMPLATES rather than as numbers.
 *
 * `CurrencyNegativePattern = 0` is `($n)`: parentheses, and no minus sign at
 * all. That table is documented as prose a reader has to copy, and copying is
 * what this file exists to stop — so the capture asks .NET for the shape of
 * each index instead, by formatting `1` through a NumberFormatInfo whose symbol
 * is the literal `SYM` and whose negative sign is `NEG`. The result describes
 * the enumeration, not a locale, so it is one table for every culture.
 *
 *   currencyNegative[0]  (SYM1)      currencyNegative[8]  NEG1 SYM
 *   currencyNegative[1]  NEGSYM1     percentPositive[0]   1 SYM
 *
 * Substitute with `layPattern` below rather than by hand: a currency symbol of
 * `$` is a replacement-pattern metacharacter for `String.replace`.
 */
export type PatternKind =
  | 'currencyPositive'
  | 'currencyNegative'
  | 'percentPositive'
  | 'percentNegative'
  | 'numberNegative';

export function patternForm(kind: PatternKind, index: number): string {
  const table = captured.patternForms[kind] as Readonly<Record<string, string>>;
  const form = table[String(index)];
  if (form === undefined) {
    throw new CultureCaptureError(`no captured form for ${kind} pattern ${String(index)}`);
  }
  return form;
}

/**
 * Fill one of those templates.
 *
 * A replacer FUNCTION, not a replacement string: `'SYM1'.replace('SYM', '$')`
 * with a plain string would let `$'` and friends fire on a currency symbol that
 * is itself a dollar sign — which is the most common symbol there is.
 */
export function layPattern(form: string, symbol: string, negativeSign: string, magnitude: string): string {
  return form
    .replace('SYM', () => symbol)
    .replace('NEG', () => negativeSign)
    .replace('1', () => magnitude);
}

/** What produced the data, so a caller can say which engine it is claiming. */
export const CULTURE_CAPTURE = Object.freeze({
  psVersion: captured.engine.psVersion,
  platform: captured.engine.osPlatform,
  framework: captured.engine.framework,
  capturedAt: captured.capturedAt,
});

/** Raised for a culture nobody captured. See the file header for why. */
export class UnknownCultureError extends Error {
  constructor(name: string) {
    super(
      `no measured culture data for '${name}'. ` +
        `Known: ${[...CULTURES.keys()].filter((k) => k !== '').join(', ')}. ` +
        'Formatting with another culture\'s separators would be a silent fabrication; ' +
        'add it by re-running tools/capture-pwsh-culture.ps1 with -CultureName.',
    );
    this.name = 'UnknownCultureError';
  }
}

export function cultureByName(name: string): CultureData {
  const found = CULTURES.get(name.toLowerCase());
  if (found === undefined) throw new UnknownCultureError(name);
  return found;
}
