/**
 * culture.ts — the number and date data the CULTURE-DEPENDENT conversions need.
 *
 * to-string.ts covers `"$x"`, which is culture-INVARIANT and therefore needs
 * none of this. Two other conversions are not invariant, and this file exists
 * for them:
 *
 *   'N2' -f 1234.5     1,234.50 (en-US)   1.234,50 (de-DE)
 *   Format-Table cell  1.500    (en-US)   1,50     (zh-TW)
 *
 * The second one is the surprise, and it is measured rather than assumed. See
 * the note on `numberDecimalDigits` below.
 *
 * WHY THE DATA IS A TABLE AND NOT `Intl`
 *
 * `Intl.NumberFormat` is available and does resolve the separators correctly,
 * so the obvious move is to delegate. It was tried and it is wrong on the field
 * that matters most here. Measured on this machine:
 *
 *   culture   .NET NumberFormatInfo.NumberDecimalDigits   Intl maximumFractionDigits
 *   en-US     3                                           3
 *   de-DE     3                                           3
 *   zh-TW     2                                           3     <-- disagree
 *
 * .NET derives the value from ICU's *decimal pattern*, `Intl` reports its own
 * default, and for zh-TW they differ. An implementation built on `Intl` would
 * print `1.500` where pwsh prints `1.50` under the host culture this project
 * was captured on. Everything below was read off
 * `[CultureInfo]::new(name).NumberFormat` in pwsh 7.6.5 / .NET 10.0.11.
 *
 * Only the cultures the conformance capture actually uses are here — en-US is
 * the pinned culture, de-DE the stress culture, zh-TW the host culture. A name
 * that is not in the table is a hard error rather than a silent fallback to
 * en-US, because printing US separators while claiming to be a French host is
 * exactly the kind of quiet wrongness the rest of this project refuses.
 */

/**
 * Where the currency symbol goes. .NET numbers these patterns; the numbers are
 * the ones `CurrencyPositivePattern` reports, so they are reproduced rather
 * than renamed.
 *
 *   0 = $n    1 = n$    2 = $ n    3 = n $
 */
export type CurrencyPositivePattern = 0 | 1 | 2 | 3;

/**
 *   0 = n %   1 = n%    2 = %n     3 = % n
 */
export type PercentPositivePattern = 0 | 1 | 2 | 3;

export interface CultureData {
  readonly name: string;
  readonly numberDecimalSeparator: string;
  readonly numberGroupSeparator: string;
  /** Digits per group, least significant first. Every culture measured says [3]. */
  readonly numberGroupSizes: readonly number[];
  /**
   * How many fraction digits the `N` and `F` specifiers produce when the format
   * string does not say. This is also what Format-Table uses for a
   * floating-point cell, which is the least guessable thing in this file.
   */
  readonly numberDecimalDigits: number;
  readonly percentDecimalDigits: number;
  readonly percentSymbol: string;
  readonly percentPositivePattern: PercentPositivePattern;
  readonly currencyDecimalDigits: number;
  readonly currencySymbol: string;
  readonly currencyPositivePattern: CurrencyPositivePattern;
  readonly negativeSign: string;
  /**
   * .NET Core on ICU reports the SYMBOL, not the word: `[double]::PositiveInfinity`
   * in a table cell renders as `∞`. Measured; the .NET Framework answer
   * ("Infinity") would be wrong here.
   */
  readonly positiveInfinity: string;
  readonly negativeInfinity: string;
  readonly nan: string;
  /**
   * The `G` (general) date/time pattern, which is what `'{0}' -f $date` and a
   * DateTime table cell produce. Expressed in .NET custom-format letters so one
   * formatter can serve both this and an explicit `{0:yyyy-MM-dd}`.
   */
  readonly dateTimePattern: string;
  /**
   * The `FullDateTimePattern`, which is what a BARE DateTime prints through the
   * default view — a different pattern from the one a table CELL uses:
   *
   *   [datetime]'2020-03-04T15:06:07' | Out-String
   *     Wednesday, March 4, 2020 3:06:07 PM      <- full
   *   [pscustomobject]@{ D = $d } | Format-Table
   *     3/4/2020 3:06:07 PM                      <- general
   *
   * Measured under all three cultures, which is also why the day and month
   * names below are here: `dddd` and `MMMM` are unavoidable once this pattern is.
   */
  readonly fullDateTimePattern: string;
  readonly dayNames: readonly string[];
  readonly abbreviatedDayNames: readonly string[];
  readonly monthNames: readonly string[];
  readonly abbreviatedMonthNames: readonly string[];
  readonly amDesignator: string;
  readonly pmDesignator: string;
}

/**
 * en-US — the culture the conformance fixtures were captured under
 * (`capture.pinnedCulture`), and therefore the default everywhere below.
 *
 *   '{0:N2}' -f 1234.5   1,234.50
 *   '{0:N}'  -f 1234.5   1,234.500      <-- three digits, not two
 *   '{0:C}'  -f 1234.5   $1,234.50
 *   '{0:P1}' -f 0.1234   12.3%
 *   '{0}'    -f $date    3/4/2020 5:06:07 AM
 */
const EN_US: CultureData = {
  name: 'en-US',
  numberDecimalSeparator: '.',
  numberGroupSeparator: ',',
  numberGroupSizes: [3],
  numberDecimalDigits: 3,
  percentDecimalDigits: 3,
  percentSymbol: '%',
  percentPositivePattern: 1,
  currencyDecimalDigits: 2,
  currencySymbol: '$',
  currencyPositivePattern: 0,
  negativeSign: '-',
  positiveInfinity: '∞',
  negativeInfinity: '-∞',
  nan: 'NaN',
  dateTimePattern: 'M/d/yyyy h:mm:ss tt',
  fullDateTimePattern: 'dddd, MMMM d, yyyy h:mm:ss tt',
  dayNames: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  abbreviatedDayNames: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  monthNames: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  abbreviatedMonthNames: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  amDesignator: 'AM',
  pmDesignator: 'PM',
};

/**
 * de-DE — the capture's stress culture, chosen because it swaps BOTH separators.
 *
 *   '{0:N2}' -f 1234.5   1.234,50
 *   '{0:C}'  -f 1234.5   1.234,50 €     <-- symbol last, separated by U+0020
 *   '{0:P1}' -f 0.1234   12,3 %         <-- a plain space, measured by code point
 *   '{0}'    -f $date    04.03.2020 05:06:07
 *
 * The two spaces above were read as code points (32, not 160) rather than
 * eyeballed, because a non-breaking space would be invisible in a diff and
 * would fail a byte-for-byte comparison.
 */
const DE_DE: CultureData = {
  name: 'de-DE',
  numberDecimalSeparator: ',',
  numberGroupSeparator: '.',
  numberGroupSizes: [3],
  numberDecimalDigits: 3,
  percentDecimalDigits: 3,
  percentSymbol: '%',
  percentPositivePattern: 0,
  currencyDecimalDigits: 2,
  currencySymbol: '€',
  currencyPositivePattern: 3,
  negativeSign: '-',
  positiveInfinity: '∞',
  negativeInfinity: '-∞',
  nan: 'NaN',
  dateTimePattern: 'dd.MM.yyyy HH:mm:ss',
  fullDateTimePattern: 'dddd, d. MMMM yyyy HH:mm:ss',
  dayNames: ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'],
  abbreviatedDayNames: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'],
  monthNames: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
  abbreviatedMonthNames: ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'],
  amDesignator: '',
  pmDesignator: '',
};

/**
 * zh-TW — the host culture of the capture machine, and the reason this file
 * cannot delegate to `Intl`: it is the culture whose `NumberDecimalDigits` is 2
 * where `Intl` says 3.
 *
 *   Format-Table cell for 1.5   1.50    (en-US gives 1.500)
 *   '{0}' -f $date              2020/3/4 上午 05:06:07
 */
const ZH_TW: CultureData = {
  name: 'zh-TW',
  numberDecimalSeparator: '.',
  numberGroupSeparator: ',',
  numberGroupSizes: [3],
  numberDecimalDigits: 2,
  percentDecimalDigits: 2,
  percentSymbol: '%',
  percentPositivePattern: 1,
  currencyDecimalDigits: 2,
  currencySymbol: 'NT$',
  currencyPositivePattern: 0,
  negativeSign: '-',
  positiveInfinity: '∞',
  negativeInfinity: '-∞',
  nan: 'NaN',
  dateTimePattern: 'yyyy/M/d tt hh:mm:ss',
  fullDateTimePattern: "yyyy'年'M'月'd'日' tt hh:mm:ss",
  dayNames: ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'],
  abbreviatedDayNames: ['週日', '週一', '週二', '週三', '週四', '週五', '週六'],
  monthNames: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
  abbreviatedMonthNames: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
  amDesignator: '上午',
  pmDesignator: '下午',
};

/**
 * The invariant culture. Not the same thing as en-US: its `NumberDecimalDigits`
 * is 2, because it is fixed by the .NET specification rather than taken from
 * ICU's en-US pattern.
 */
const INVARIANT: CultureData = {
  name: 'Invariant',
  numberDecimalSeparator: '.',
  numberGroupSeparator: ',',
  numberGroupSizes: [3],
  numberDecimalDigits: 2,
  percentDecimalDigits: 2,
  percentSymbol: '%',
  percentPositivePattern: 1,
  currencyDecimalDigits: 2,
  currencySymbol: '¤',
  currencyPositivePattern: 0,
  negativeSign: '-',
  positiveInfinity: 'Infinity',
  negativeInfinity: '-Infinity',
  nan: 'NaN',
  dateTimePattern: 'MM/dd/yyyy HH:mm:ss',
  fullDateTimePattern: 'dddd, dd MMMM yyyy HH:mm:ss',
  dayNames: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  abbreviatedDayNames: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  monthNames: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  abbreviatedMonthNames: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  amDesignator: 'AM',
  pmDesignator: 'PM',
};

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
export { EN_US, DE_DE, ZH_TW, INVARIANT };

/** Raised for a culture nobody measured. See the file header for why. */
export class UnknownCultureError extends Error {
  constructor(name: string) {
    super(
      `no measured culture data for '${name}'. ` +
        `Known: ${[...CULTURES.keys()].filter((k) => k !== '').join(', ')}. ` +
        'Formatting with another culture\'s separators would be a silent fabrication.',
    );
    this.name = 'UnknownCultureError';
  }
}

export function cultureByName(name: string): CultureData {
  const found = CULTURES.get(name.toLowerCase());
  if (found === undefined) throw new UnknownCultureError(name);
  return found;
}
