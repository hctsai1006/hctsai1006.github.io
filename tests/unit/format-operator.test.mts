/**
 * The `-f` operator, against pwsh 7.6.5 on LINUX
 * (docker pwsh-linux:7.6.5, .NET 10.0.11, Ubuntu 24.04) — the platform the
 * compatibility profiles this project publishes actually target. Where the
 * Windows host disagrees the disagreement is called out at the case.
 *
 * Every expectation was read off the reference implementation under a pinned
 * culture, most of them under two — the whole point of this operator is that it
 * is culture-DEPENDENT where PowerShell's own string conversion is not.
 *
 *   '{0:N2}' -f 1234.5     en-US 1,234.50    de-DE 1.234,50
 *   "$(1234.5)"            1234.5 under both        (see to-string.ts)
 *
 * The cases that caught the implementation, in the order they would be got
 * wrong:
 *
 *   'N' with no digits is THREE decimals, not two — .NET Core takes
 *   NumberDecimalDigits from ICU, and en-US, de-DE and zh-TW all say 3
 *   (only the INVARIANT culture says 2, and it is not a locale)
 *   rounding is half-EVEN for F/N/C/P/E and half-up on the G15 decimal for a
 *   CUSTOM format: '{0:F2}' -f 0.125 is 0.12 and '{0:0.00}' -f 0.125 is 0.13
 *   a one-character date format is a STANDARD specifier: '{0:d}' is 3/4/2020
 *   a string argument ignores the specifier: '{0:N2}' -f '1234.5' is 1234.5
 *   '{0:ZZZ}' is not an error, it is a custom format of three literals
 *   alignment pads by CHARACTER count, so '{0,4}' -f '中文' has two spaces
 *   '{0}' is NOT "$x": 0.1+0.2 formats as 0.30000000000000004
 *
 * ONE INVISIBLE CHARACTER RUNS THROUGH THE DATE CASES. Under en-US on Linux the
 * AM/PM designator is preceded by U+202F NARROW NO-BREAK SPACE, not U+0020 —
 * CLDR 42 made that change and a current Linux ICU has it. It is written as
 * ` ` everywhere below rather than pasted, because a pasted one is
 * indistinguishable from a space in a diff and in a review.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CULTURE, DE_DE, INVARIANT, ZH_TW, cultureByName, UnknownCultureError } from '../../src/formatting/culture.ts';
import { FormatOperatorError, formatOperator } from '../../src/formatting/format-operator.ts';
import { psDateTime } from '../../src/commands/native/datetime.ts';
import type { PSValue } from '../../src/pipeline/psobject.ts';

const en = (format: string, ...args: PSValue[]): string =>
  formatOperator(format, args, DEFAULT_CULTURE);
const de = (format: string, ...args: PSValue[]): string => formatOperator(format, args, DE_DE);

describe('-f is culture-dependent, unlike "$x"', () => {
  it('swaps both separators between en-US and de-DE', () => {
    assert.equal(en('{0:N2}', 1234.5), '1,234.50');
    assert.equal(de('{0:N2}', 1234.5), '1.234,50');
  });

  it('takes the default fraction digits from the culture, and it is three', () => {
    // pwsh 7.6.5, LINUX and Windows alike:
    //   (1234.5).ToString('N', <culture>)
    //     en-US      1,234.500
    //     de-DE      1.234,500
    //     zh-TW      1,234.500
    //     invariant  1,234.50     <- the only one that is two
    //
    // This file used to assert 1,234.50 for zh-TW, above a comment saying .NET
    // reads 2 from ICU for it. Both were wrong: zh-TW's NumberDecimalDigits is
    // 3, on both platforms, and the whole justification for hand-maintaining
    // culture.ts rested on the claim that it was 2 and `Intl` said 3.
    assert.equal(en('{0:N}', 1234.5), '1,234.500');
    assert.equal(de('{0:N}', 1234.5), '1.234,500');
    assert.equal(formatOperator('{0:N}', [1234.5], ZH_TW), '1,234.500');
    assert.equal(formatOperator('{0:N}', [1234.5], INVARIANT), '1,234.50');
  });

  it('places the currency symbol from the culture pattern', () => {
    assert.equal(en('{0:C}', 1234.5), '$1,234.50');
    assert.equal(de('{0:C}', 1234.5), '1.234,50 €');
    assert.equal(en('{0:C}', -1234.5), '-$1,234.50');
    assert.equal(de('{0:C}', -1234.5), '-1.234,50 €');
  });

  it('places the percent symbol from the culture pattern, with a plain space', () => {
    // pwsh de-DE: the space before % is U+0020, verified by code point rather
    // than by eye — a non-breaking space would look identical and fail.
    assert.equal(en('{0:P1}', 0.1234), '12.3%');
    assert.equal(de('{0:P1}', 0.1234), '12,3 %');
    assert.equal(de('{0:P1}', 0.1234).codePointAt(4), 0x20);
  });
});

describe('rounding is half-even, on the exact value', () => {
  it('rounds a tie to the even digit, where JavaScript rounds away from zero', () => {
    // pwsh: 2 and 4. JavaScript: (2.5).toFixed(0) is "3".
    assert.equal(en('{0:N0}', 2.5), '2');
    assert.equal(en('{0:N0}', 3.5), '4');
    assert.notEqual((2.5).toFixed(0), '2');
  });

  it('distinguishes an exact tie from one that only looks like one', () => {
    // 0.125 is exactly representable and ties down; 0.135 is really
    // 0.13500000000000000888… and rounds up. Any approximate implementation
    // gets one of these wrong.
    assert.equal(en('{0:F2}', 0.125), '0.12');
    assert.equal(en('{0:F2}', 0.135), '0.14');
  });

  it('follows the binary value for the classic near-ties', () => {
    assert.equal(en('{0:F2}', 1.005), '1.00');
    assert.equal(en('{0:F2}', 2.675), '2.67');
  });

  it('keeps the sign when the magnitude rounds to zero', () => {
    assert.equal(en('{0:N2}', -0.001), '-0.00');
    assert.equal(en('{0:N2}', 0), '0.00');
  });
});

describe('the standard specifiers', () => {
  it('N and F differ only in grouping', () => {
    assert.equal(en('{0:N2}', 1234.5), '1,234.50');
    assert.equal(en('{0:F2}', 1234.5), '1234.50');
    assert.equal(en('{0:F3}', 1234.5), '1234.500');
  });

  it('D pads the digits and leaves the sign outside', () => {
    assert.equal(en('{0:D5}', 42), '00042');
    assert.equal(en('{0:D5}', -42), '-00042');
  });

  it('D refuses a non-integer, as pwsh does', () => {
    assert.throws(
      () => en('{0:D}', 1.5),
      (error: unknown) =>
        error instanceof FormatOperatorError &&
        error.message === 'Error formatting a string: Format specifier was invalid..',
    );
  });

  it('X takes the two’s complement at the value’s integer width', () => {
    assert.equal(en('{0:X}', 255), 'FF');
    assert.equal(en('{0:X4}', 255), '00FF');
    assert.equal(en('{0:x4}', 255), '00ff');
    // pwsh: '{0:X}' -f -1 is FFFFFFFF (Int32); [int64]-1 is sixteen Fs.
    assert.equal(en('{0:X}', -1), 'FFFFFFFF');
    assert.equal(en('{0:X}', -1n), 'FFFFFFFFFFFFFFFF');
  });

  it('E uses six decimals and a THREE-digit signed exponent', () => {
    assert.equal(en('{0:E}', 1234.5), '1.234500E+003');
    assert.equal(en('{0:E2}', 1234.5), '1.23E+003');
    assert.equal(en('{0:e2}', 1234.5), '1.23e+003');
    assert.equal(en('{0:E}', 0), '0.000000E+000');
    assert.equal(en('{0:E3}', 0.000123), '1.230E-004');
    assert.equal(en('{0:E2}', -1234.5), '-1.23E+003');
  });

  it('P multiplies by a hundred first', () => {
    assert.equal(en('{0:P}', 0.1234), '12.340%');
    assert.equal(en('{0:P}', -0.5), '-50.000%');
    assert.equal(en('{0:P2}', 1234.5), '123,450.00%');
  });

  it('NaN and the infinities ignore every specifier, and use ICU symbols', () => {
    // pwsh: ∞, not the word "Infinity" the .NET Framework used.
    assert.equal(en('{0:N2}', NaN), 'NaN');
    assert.equal(en('{0:N2}', Infinity), '∞');
    assert.equal(en('{0:N2}', -Infinity), '-∞');
  });
});

describe('{0} with no specifier is not "$x"', () => {
  it('produces the SHORTEST round-trip digits, not G15', () => {
    // pwsh: '{0}' -f (0.1+0.2) is 0.30000000000000004, while "$(0.1+0.2)" is 0.3.
    assert.equal(en('{0}', 0.1 + 0.2), '0.30000000000000004');
    assert.equal(en('{0}', 1 / 3), '0.3333333333333333');
    // and G15 explicitly asks for the other one
    assert.equal(en('{0:G15}', 1 / 3), '0.333333333333333');
  });

  it('switches to exponential at .NET’s thresholds, not JavaScript’s', () => {
    // pwsh: 0.0001 stays fixed and 0.00001 does not; 1e16 stays fixed and 1e17
    // does not. JavaScript's String() would keep both of the second pair fixed.
    assert.equal(en('{0}', 0.0001), '0.0001');
    assert.equal(en('{0}', 0.00001), '1E-05');
    assert.equal(en('{0}', 1e16), '10000000000000000');
    assert.equal(en('{0}', 1e17), '1E+17');
    assert.equal(en('{0}', 1e21), '1E+21');
  });
});

describe('custom format strings', () => {
  it('handles the usual shapes', () => {
    assert.equal(en('{0:#,##0.00}', 1234.5), '1,234.50');
    assert.equal(en('{0:0.##}', 1234.5), '1234.5');
    assert.equal(en('{0:000.0}', 1.5), '001.5');
    assert.equal(en('{0:#,#}', 1234567), '1,234,567');
    assert.equal(en('{0:0000}', 42), '0042');
    assert.equal(en('{0:#.###}', 1.5), '1.5');
    assert.equal(en('{0:#.00}', -1.5), '-1.50');
  });

  it('reads a second section as the NEGATIVE form, sign and all', () => {
    // pwsh: '{0:0.0;(0.0)}' -f -1.5 is (1.5) — the minus is gone because the
    // pattern supplies its own notation.
    assert.equal(en('{0:0.0;(0.0)}', -1.5), '(1.5)');
    assert.equal(en('{0:0.0;(0.0)}', 1.5), '1.5');
  });

  it('multiplies for % and copies anything it does not recognise', () => {
    assert.equal(en('{0:0.0%}', 0.5), '50.0%');
    assert.equal(en('{0:#.##%}', 0.1234), '12.34%');
    assert.equal(en('{0:0 units}', 3), '3 units');
    assert.equal(en('{0:\\#0}', 3), '#3');
  });

  it('treats an unrecognised MULTI-letter specifier as literal text', () => {
    // pwsh: '{0:ZZZ}' -f 1234.5 is ZZZ. Not an error, and not the number.
    assert.equal(en('{0:ZZZ}', 1234.5), 'ZZZ');
  });

  it('rounds HALF-UP on the G15 decimal, where F and N round half-even', () => {
    // pwsh 7.6.5, LINUX. The pairs are the point: the same value, the same
    // number of decimals, two different answers.
    //   '{0:F2}'   -f 0.125   0.12      '{0:0.00}' -f 0.125   0.13
    //   '{0:F2}'   -f 2.675   2.67      '{0:0.00}' -f 2.675   2.68
    //   '{0:F2}'   -f 1.005   1.00      '{0:0.00}' -f 1.005   1.01
    //   '{0:N0}'   -f 2.5     2         '{0:0000}' -f 2.5     0003
    //
    // Line one alone would suggest half-up against half-even. Lines two and
    // three show it is more than that: 2.675 is really 2.674999…82, so an
    // away-from-zero rule on the exact binary value would agree with F2 and
    // answer 2.67. .NET generates fifteen significant DECIMAL digits first —
    // where 2.675 is an exact tie — and rounds those half-up.
    assert.equal(en('{0:F2}', 0.125), '0.12');
    assert.equal(en('{0:0.00}', 0.125), '0.13');
    assert.equal(en('{0:F2}', 2.675), '2.67');
    assert.equal(en('{0:0.00}', 2.675), '2.68');
    assert.equal(en('{0:F2}', 1.005), '1.00');
    assert.equal(en('{0:0.00}', 1.005), '1.01');
    assert.equal(en('{0:N0}', 2.5), '2');
    assert.equal(en('{0:0000}', 2.5), '0003');
  });

  it('emits nothing at all — sign included — when the pattern emits nothing', () => {
    // pwsh 7.6.5, LINUX:
    //   '{0:#,#}'   -f -0.001                    ''
    //   '{0:#.###}' -f [double]::NegativeZero    ''
    //   '{0:#.##%}' -f [double]::NegativeZero    '-%'    a literal survives
    //   '{0:ZZZ}'   -f -1234.5                   '-ZZZ'
    assert.equal(en('{0:#,#}', -0.001), '');
    assert.equal(en('{0:#.###}', -0), '');
    assert.equal(en('{0:#.##%}', -0), '-%');
    assert.equal(en('{0:ZZZ}', -1234.5), '-ZZZ');
  });

  it('shifts the decimal SCALE for %, rather than multiplying the double', () => {
    // pwsh: '{0:P}' -f 1e21 is 100,000,000,000,000,000,000,000.000% — but
    // 1e21 * 100 as a double is 99999999999999991611392, so an implementation
    // that multiplies first prints that instead. Measured on LINUX.
    assert.equal(en('{0:P}', 1e21), '100,000,000,000,000,000,000,000.000%');
    assert.equal(en('{0:0.0%}', 0.5), '50.0%');
  });
});

describe('the currency sign is a PATTERN, not a leading minus', () => {
  it('parenthesises a negative under the invariant culture', () => {
    // pwsh 7.6.5, LINUX:
    //   (-1234.5).ToString('C', <invariant>)  (¤1,234.50)
    //   (-1234.5).ToString('C', <en-US>)      -$1,234.50
    //   (-1234.5).ToString('C', <de-DE>)      -1.234,50 €
    // CurrencyNegativePattern is 0 for the invariant culture — `($n)`, with no
    // minus sign anywhere. numeric.ts used to say "negative sign, then the
    // positive pattern" and justify it with "for both cultures measured it
    // agrees"; it agreed with the two that had been looked at.
    assert.equal(formatOperator('{0:C}', [-1234.5], INVARIANT), '(¤1,234.50)');
    assert.equal(formatOperator('{0:C}', [1234.5], INVARIANT), '¤1,234.50');
    assert.equal(en('{0:C}', -1234.5), '-$1,234.50');
    assert.equal(de('{0:C}', -1234.5), '-1.234,50 €');
    assert.equal(formatOperator('{0:C}', [-1234.5], ZH_TW), '-$1,234.50');
  });
});

describe('alignment, indices and escapes', () => {
  it('pads by CHARACTER count, not display width', () => {
    // pwsh: '[{0,4}]' -f '中文' is [  中文] — two characters, two spaces, even
    // though the terminal draws four columns. The table formatter measures
    // columns instead; the two mechanisms are deliberately different.
    assert.equal(en('[{0,10}]', 'ab'), '[        ab]');
    assert.equal(en('[{0,-10}]', 'ab'), '[ab        ]');
    assert.equal(en('[{0,4}]', '中文'), '[  中文]');
  });

  it('combines alignment with a specifier', () => {
    assert.equal(en('[{0,10:N2}]', 1234.5), '[  1,234.50]');
  });

  it('never truncates to the alignment width', () => {
    assert.equal(en('[{0,3}]', 'abcdef'), '[abcdef]');
  });

  it('reuses and reorders indices, and ignores extra arguments', () => {
    assert.equal(en('{0} {0} {1}', 'a', 'b'), 'a a b');
    assert.equal(en('{1}{0}', 'a', 'b'), 'ba');
    assert.equal(en('{0}', 'a', 'b'), 'a');
  });

  it('unescapes doubled braces outside a format item', () => {
    assert.equal(en('{{0}} {0}', 'x'), '{0} x');
  });
});

describe('argument types', () => {
  it('hands back a string unchanged, specifier and all', () => {
    // pwsh: '{0:N2}' -f '1234.5' is 1234.5. String is not IFormattable.
    assert.equal(en('{0:N2}', '1234.5'), '1234.5');
  });

  it('prints a boolean as True, ignoring any specifier', () => {
    assert.equal(en('{0}', true), 'True');
    assert.equal(en('{0:N2}', true), 'True');
  });

  it('prints $null as the empty string', () => {
    assert.equal(en('{0}', null), '');
  });

  it('prints an ARRAY as its type name, because String.Format calls ToString()', () => {
    // pwsh: '{0}' -f (,@(1,2)) is System.Object[], while "$(@(1,2))" is "1 2".
    assert.equal(en('{0}', [1, 2]), 'System.Object[]');
  });

  it('prints a PSCustomObject the way "$x" does', () => {
    assert.equal(en('{0}', { typeNames: ['System.Management.Automation.PSCustomObject', 'System.Object'], properties: { A: 1 } }), '@{A=1}');
  });

  it('formats a date by pattern, and by the culture when no pattern is given', () => {
    const when = new Date(2020, 2, 4, 5, 6, 7);
    assert.equal(en('{0:yyyy-MM-dd}', when), '2020-03-04');
    assert.equal(en('{0:HH:mm:ss}', new Date(2020, 2, 4, 15, 6, 7)), '15:06:07');
    // pwsh 7.6.5, LINUX: '{0}' -f ([datetime]'2020-03-04T05:06:07') is
    // `3/4/2020 5:06:07<U+202F>AM`. On the Windows host the same expression
    // gives U+0020 — a real platform divergence, and the profile this project
    // publishes is the Linux one.
    assert.equal(en('{0}', when), '3/4/2020 5:06:07\u202fAM');
    assert.equal(de('{0}', when), '04.03.2020 05:06:07');
    assert.equal(en('{0:tt}', new Date(2020, 2, 4, 15, 6, 7)), 'PM');
    assert.equal(en('{0:s}', new Date(2020, 2, 4, 15, 6, 7)), '2020-03-04T15:06:07');
  });
});

/**
 * The date half of the engine, which used to be a second implementation living
 * in src/formatting/datetime.ts and was wrong on 20 of 47 patterns.
 *
 * Everything here was measured with
 * `([datetime]::new(2020,3,4,15,6,7,89)).ToString(<format>, <culture>)` on pwsh
 * 7.6.5, LINUX — the same call `'{0:<format>}' -f $d` resolves to.
 */
describe('a one-character date format is a STANDARD specifier', () => {
  const afternoon = new Date(2020, 2, 4, 15, 6, 7, 89);
  const zh = (format: string): string => formatOperator(format, [afternoon], ZH_TW);

  it('reads every one of the nineteen, and not as a custom pattern', () => {
    // The trap: `d` is the culture's SHORT DATE, not the day number 4. The old
    // implementation had no standard table at all, so it answered `4`.
    assert.equal(en('{0:d}', afternoon), '3/4/2020');
    assert.equal(en('{0:D}', afternoon), 'Wednesday, March 4, 2020');
    assert.equal(en('{0:f}', afternoon), 'Wednesday, March 4, 2020 3:06\u202fPM');
    assert.equal(en('{0:F}', afternoon), 'Wednesday, March 4, 2020 3:06:07\u202fPM');
    assert.equal(en('{0:g}', afternoon), '3/4/2020 3:06\u202fPM');
    assert.equal(en('{0:G}', afternoon), '3/4/2020 3:06:07\u202fPM');
    assert.equal(en('{0:m}', afternoon), 'March 4');
    assert.equal(en('{0:M}', afternoon), 'March 4');
    assert.equal(en('{0:o}', afternoon), '2020-03-04T15:06:07.0890000');
    assert.equal(en('{0:r}', afternoon), 'Wed, 04 Mar 2020 15:06:07 GMT');
    assert.equal(en('{0:s}', afternoon), '2020-03-04T15:06:07');
    assert.equal(en('{0:t}', afternoon), '3:06\u202fPM');
    assert.equal(en('{0:T}', afternoon), '3:06:07\u202fPM');
    assert.equal(en('{0:u}', afternoon), '2020-03-04 15:06:07Z');
    assert.equal(en('{0:y}', afternoon), 'March 2020');
    assert.equal(en('{0:Y}', afternoon), 'March 2020');
  });

  it('resolves each specifier through the CULTURE, not through en-US', () => {
    assert.equal(zh('{0:d}'), '2020/3/4');
    assert.equal(zh('{0:D}'), '2020年3月4日 星期三');
    assert.equal(zh('{0:G}'), '2020/3/4 下午3:06:07');
    assert.equal(zh('{0:T}'), '下午3:06:07');
    assert.equal(zh('{0:y}'), '2020年3月');
    assert.equal(de('{0:d}', afternoon), '04.03.2020');
    assert.equal(de('{0:D}', afternoon), 'Mittwoch, 4. März 2020');
  });

  it('keeps `r`, `s`, `o` and `u` culture-free, as .NET defines them', () => {
    // Measured under all four captured cultures; every one gives these.
    assert.equal(zh('{0:r}'), 'Wed, 04 Mar 2020 15:06:07 GMT');
    assert.equal(zh('{0:s}'), '2020-03-04T15:06:07');
    assert.equal(zh('{0:O}'), '2020-03-04T15:06:07.0890000');
    assert.equal(zh('{0:u}'), '2020-03-04 15:06:07Z');
  });

  it('throws for a letter that is not a specifier, with pwsh’s wording', () => {
    // pwsh: '{0:h}' -f $d
    //   Error formatting a string: Input string was not in a correct format..
    // Measured on LINUX and on Windows; identical.
    assert.throws(
      () => en('{0:h}', afternoon),
      (error: unknown) =>
        error instanceof FormatOperatorError &&
        error.message === 'Error formatting a string: Input string was not in a correct format..',
    );
  });

  it('asks for a single CUSTOM specifier with %', () => {
    // pwsh: '{0:%d}' -f $d is 4, where '{0:d}' is 3/4/2020.
    assert.equal(en('{0:%d}', afternoon), '4');
    assert.equal(en('{0:%H}', afternoon), '15');
    assert.equal(zh('{0:%t}'), '下');
  });
});

describe('custom date patterns bind the culture, not en-US', () => {
  // [datetime]::new(2026,3,4,5,6,7).AddTicks(89000) — 8.9 milliseconds, which is
  // 8 whole milliseconds plus 9000 ticks. Only a PSDateTime can carry the second
  // half; a JavaScript Date cannot, which is why the corpus has this value.
  const morning = psDateTime(
    { year: 2026, month: 3, day: 4, hour: 5, minute: 6, second: 7, millisecond: 8 },
    { subMillisecondTicks: 9000 },
  );
  const afternoon = new Date(2020, 2, 4, 15, 6, 7, 89);

  it('substitutes the names, the designator and the era', () => {
    assert.equal(en('{0:dddd}', afternoon), 'Wednesday');
    assert.equal(en('{0:ddd}', afternoon), 'Wed');
    assert.equal(en('{0:MMMM}', afternoon), 'March');
    assert.equal(en('{0:MMM}', afternoon), 'Mar');
    assert.equal(formatOperator('{0:dddd}', [afternoon], ZH_TW), '星期三');
    assert.equal(formatOperator('{0:MMMM}', [afternoon], ZH_TW), '3月');
    assert.equal(de('{0:dddd}', afternoon), 'Mittwoch');
    assert.equal(de('{0:MMM}', afternoon), 'Mär');
    // pwsh: ([datetime]...).ToString('gg', <culture>)
    //   en-US AD   de-DE `n. Chr.`   zh-TW 西元
    // The old implementation refused `g` outright rather than answer `AD` for
    // three cultures that do not say AD.
    assert.equal(en('{0:gg}', afternoon), 'AD');
    assert.equal(de('{0:gg}', afternoon), 'n. Chr.');
    assert.equal(formatOperator('{0:gg}', [afternoon], ZH_TW), '西元');
  });

  it('uses the GENITIVE month names when the pattern carries a day number', () => {
    // pwsh de-DE:  'MMM'        Mär
    //              'MMM d'      März 4      <- genitive, because of the `d`
    //              'd. MMM yyyy'  4. März 2020
    // The two arrays really differ for de-DE: Mär vs März, Jan vs Jan.
    assert.equal(de('{0:MMM}', afternoon), 'Mär');
    assert.equal(de('{0:MMM d}', afternoon), 'März 4');
    assert.equal(de('{0:d. MMM yyyy}', afternoon), '4. März 2020');
  });

  it('treats an unescaped / as the culture’s DATE separator', () => {
    // pwsh: ([datetime]...).ToString('yyyy/MM', de-DE) is 2020.03, and
    // 'yyyy//MM' is 2020..03 — each slash is substituted, not printed.
    assert.equal(en('{0:yyyy/MM}', afternoon), '2020/03');
    assert.equal(de('{0:yyyy/MM}', afternoon), '2020.03');
    assert.equal(de('{0:M/d/yyyy h:mm:ss tt}', afternoon), '3.4.2020 3:06:07 PM');
  });

  it('sees the ticks below a millisecond, so F and f mean something', () => {
    // pwsh: [datetime]::new(2026,3,4,5,6,7).AddTicks(89000).ToString(<f>)
    //   fff 008   ffff 0089   fffffff 0089000   FFF 0089 -> trimmed to 0089
    // The old implementation formatted from Date.getMilliseconds(), so it had
    // no ticks to show and `FFF` fell through to its literal branch and printed
    // the three letters `FFF`.
    assert.equal(en('{0:fff}', morning), '008');
    assert.equal(en('{0:fffffff}', morning), '0089000');
    assert.equal(en('{0:FFF}', morning), '008');
    assert.equal(en('{0:FFFFFFF}', morning), '0089');
    assert.notEqual(en('{0:FFF}', morning), 'FFF');
  });
});

describe('errors, with pwsh’s own wording', () => {
  it('refuses an index past the end of the arguments', () => {
    assert.throws(
      () => en('{0} {1}', 'a'),
      (error: unknown) =>
        error instanceof FormatOperatorError &&
        error.message ===
          'Error formatting a string: Index (zero based) must be greater than or equal to zero ' +
            'and less than the size of the argument list..',
    );
  });

  it('refuses a non-digit where the index should be, at the right offset', () => {
    assert.throws(
      () => en('{a}', 'x'),
      (error: unknown) =>
        error instanceof FormatOperatorError &&
        error.message ===
          'Error formatting a string: Input string was not in a correct format. ' +
            'Failure to parse near offset 1. Expected an ASCII digit..',
    );
  });

  it('refuses an unterminated format item', () => {
    assert.throws(
      () => en('{0', 'x'),
      (error: unknown) =>
        error instanceof FormatOperatorError &&
        error.message ===
          'Error formatting a string: Input string was not in a correct format. ' +
            'Failure to parse near offset 2. Format item ends prematurely..',
    );
  });

  it('refuses a lone closing brace', () => {
    assert.throws(
      () => en('{0:0}}0}', 5),
      (error: unknown) =>
        error instanceof FormatOperatorError &&
        /Unexpected closing brace without a corresponding opening brace/.test(
          (error as Error).message,
        ),
    );
  });
});

describe('culture lookup', () => {
  it('resolves the three cultures the capture uses', () => {
    // `NumberDecimalDigits`, read off CultureInfo on pwsh 7.6.5 LINUX and
    // confirmed on Windows: en-US 3, de-DE 3, zh-TW 3, invariant 2. This case
    // asserted 2 for zh-TW, which is the value culture.ts's header used to
    // build its whole argument on.
    assert.equal(cultureByName('en-US').numberDecimalDigits, 3);
    assert.equal(cultureByName('de-DE').numberGroupSeparator, '.');
    assert.equal(cultureByName('zh-TW').numberDecimalDigits, 3);
    assert.equal(cultureByName('invariant').numberDecimalDigits, 2);
  });

  it('carries the zh-TW values the hand table got wrong', () => {
    // Every one of these was transcribed and every one was wrong. Measured on
    // pwsh 7.6.5, LINUX; identical on Windows.
    const zh = cultureByName('zh-TW');
    assert.equal(zh.numberDecimalDigits, 3);        // table said 2
    assert.equal(zh.percentDecimalDigits, 3);       // table said 2
    assert.equal(zh.currencySymbol, '$');           // table said NT$
    assert.equal(zh.nan, '非數值');                  // table said NaN
    assert.equal(zh.dateTimePattern, 'yyyy/M/d tth:mm:ss');
    assert.equal(zh.fullDateTimePattern, 'yyyy年M月d日 dddd tth:mm:ss');
    // de-DE really has AM/PM designators; the table said both were empty.
    assert.equal(cultureByName('de-DE').amDesignator, 'AM');
    assert.equal(cultureByName('de-DE').pmDesignator, 'PM');
    // and the invariant culture's percent pattern is 0 (`n %`), not 1.
    assert.equal(cultureByName('invariant').percentPositivePattern, 0);
    assert.equal(formatOperator('{0:P0}', [0.5], INVARIANT), '50 %');
  });

  it('refuses a culture nobody measured rather than guessing en-US', () => {
    assert.throws(() => cultureByName('fr-FR'), UnknownCultureError);
  });
});
