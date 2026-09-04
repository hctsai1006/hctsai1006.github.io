/**
 * The `-f` operator, against pwsh 7.6.5.
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
 *   NumberDecimalDigits from ICU, and en-US's is 3 while zh-TW's is 2
 *   rounding is half-EVEN on the exact binary value: 2.5 -> 2 but 3.5 -> 4
 *   a string argument ignores the specifier: '{0:N2}' -f '1234.5' is 1234.5
 *   '{0:ZZZ}' is not an error, it is a custom format of three literals
 *   alignment pads by CHARACTER count, so '{0,4}' -f '中文' has two spaces
 *   '{0}' is NOT "$x": 0.1+0.2 formats as 0.30000000000000004
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CULTURE, DE_DE, ZH_TW, cultureByName, UnknownCultureError } from '../../src/formatting/culture.ts';
import { FormatOperatorError, formatOperator } from '../../src/formatting/format-operator.ts';
import type { PSValue } from '../../src/pipeline/psobject.ts';

const en = (format: string, ...args: PSValue[]): string =>
  formatOperator(format, args, DEFAULT_CULTURE);
const de = (format: string, ...args: PSValue[]): string => formatOperator(format, args, DE_DE);

describe('-f is culture-dependent, unlike "$x"', () => {
  it('swaps both separators between en-US and de-DE', () => {
    assert.equal(en('{0:N2}', 1234.5), '1,234.50');
    assert.equal(de('{0:N2}', 1234.5), '1.234,50');
  });

  it('takes the default fraction digits from the culture, and it is not two', () => {
    // pwsh: '{0:N}' -f 1234.5 is 1,234.500 under en-US and de-DE, and
    // 1,234.50 under zh-TW. .NET Core reads the digit count from ICU's
    // decimal pattern, where en-US says three.
    assert.equal(en('{0:N}', 1234.5), '1,234.500');
    assert.equal(de('{0:N}', 1234.5), '1.234,500');
    assert.equal(formatOperator('{0:N}', [1234.5], ZH_TW), '1,234.50');
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
    assert.equal(en('{0}', when), '3/4/2020 5:06:07 AM');
    assert.equal(de('{0}', when), '04.03.2020 05:06:07');
    assert.equal(en('{0:tt}', new Date(2020, 2, 4, 15, 6, 7)), 'PM');
    assert.equal(en('{0:s}', new Date(2020, 2, 4, 15, 6, 7)), '2020-03-04T15:06:07');
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
    assert.equal(cultureByName('en-US').numberDecimalDigits, 3);
    assert.equal(cultureByName('de-DE').numberGroupSeparator, '.');
    assert.equal(cultureByName('zh-TW').numberDecimalDigits, 2);
  });

  it('refuses a culture nobody measured rather than guessing en-US', () => {
    assert.throws(() => cultureByName('fr-FR'), UnknownCultureError);
  });
});
