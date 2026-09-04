/**
 * format-operator.ts — the `-f` operator.
 *
 * `'{0:N2}' -f 1234.5` is .NET composite formatting, and unlike everything in
 * to-string.ts it is CULTURE-DEPENDENT. Measured in pwsh 7.6.5:
 *
 *   en-US  1,234.50
 *   de-DE  1.234,50
 *
 * Three things here are not what a reader of the PowerShell docs would guess,
 * and each is measured:
 *
 * 1. ALIGNMENT PADS BY CHARACTER COUNT, NOT DISPLAY WIDTH.
 *      '[{0,4}]' -f '中文'   ->  [  中文]
 *    Two characters, so two spaces — even though the terminal draws four
 *    columns. The table formatter deliberately does the opposite (see
 *    render.ts); they are different mechanisms and must not share one.
 *
 * 2. A STRING ARGUMENT IGNORES THE SPECIFIER ENTIRELY.
 *      '{0:N2}' -f '1234.5'  ->  1234.5
 *    Not 1,234.50. String is not IFormattable, so String.Format hands back the
 *    string. An implementation that helpfully parsed it would disagree with the
 *    reference implementation on every numeric string.
 *
 * 3. AN UNRECOGNISED SPECIFIER IS NOT AN ERROR.
 *      '{0:ZZZ}' -f 1234.5   ->  ZZZ
 *    It is read as a CUSTOM format string in which every character is a
 *    literal. A single unknown letter DOES throw, because .NET reads a one
 *    character format string as a standard specifier.
 *
 * What is deliberately NOT implemented is listed at `formatValue`.
 */

import { DEFAULT_CULTURE, type CultureData } from './culture.ts';
import {
  NumericFormatError,
  formatCurrency,
  formatCustom,
  formatDecimalInteger,
  formatExponential,
  formatFixed,
  formatGeneral,
  formatHex,
  formatNumber,
  formatPercent,
} from './numeric.ts';
import { DatePatternError, formatDateFull, formatDateGeneral, formatDatePattern } from './datetime.ts';
import { toPSString } from './to-string.ts';
import { isPSObject, typeNameOf, type PSValue } from '../pipeline/psobject.ts';

/**
 * Raised for a format string the operator cannot apply.
 *
 * The message reproduces PowerShell's wording, including its doubled full stop
 * — pwsh appends its own period to the .NET exception message, which already
 * ends in one. That is what a script's `catch` block sees, so it is part of the
 * observable contract rather than a typo.
 */
export class FormatOperatorError extends Error {
  constructor(inner: string) {
    super(`Error formatting a string: ${inner}.`);
    this.name = 'FormatOperatorError';
  }
}

const parseFailure = (offset: number, why: string): never => {
  throw new FormatOperatorError(
    `Input string was not in a correct format. Failure to parse near offset ${offset}. ${why}.`,
  );
};

// ---------------------------------------------------------------------------
// composite format parsing
// ---------------------------------------------------------------------------

interface FormatItem {
  readonly index: number;
  readonly alignment: number;
  readonly spec: string;
}

/**
 * `{{` and `}}` are the escapes, and they are escapes only OUTSIDE a format
 * item. Inside one a `}` closes the item, which is why `'{0:0}}0}'` is a parse
 * error rather than a literal brace:
 *
 *   pwsh: '{{0}} {0}' -f 'x'   ->  {0} x
 *   pwsh: '{0:0}}0}'  -f 5     ->  Failure to parse near offset 6.
 *                                  Unexpected closing brace without a
 *                                  corresponding opening brace.
 */
function parse(format: string): (string | FormatItem)[] {
  const parts: (string | FormatItem)[] = [];
  let literal = '';
  let i = 0;

  const flush = (): void => {
    if (literal !== '') {
      parts.push(literal);
      literal = '';
    }
  };

  while (i < format.length) {
    const char = format[i] as string;

    if (char === '}') {
      if (format[i + 1] === '}') {
        literal += '}';
        i += 2;
        continue;
      }
      // .NET reports the position AFTER the offending brace here, and the
      // position OF the offending character for a bad index. Both offsets were
      // read off the reference implementation rather than reasoned about.
      parseFailure(i + 1, 'Unexpected closing brace without a corresponding opening brace');
    }

    if (char !== '{') {
      literal += char;
      i += 1;
      continue;
    }

    if (format[i + 1] === '{') {
      literal += '{';
      i += 2;
      continue;
    }

    i += 1;
    const digitsStart = i;
    while (i < format.length && (format[i] as string) >= '0' && (format[i] as string) <= '9') i += 1;
    if (i === digitsStart) {
      if (i >= format.length) parseFailure(i, 'Format item ends prematurely');
      parseFailure(digitsStart, 'Expected an ASCII digit');
    }
    const index = Number(format.slice(digitsStart, i));

    let alignment = 0;
    if (format[i] === ',') {
      i += 1;
      const signed = format[i] === '-';
      if (signed) i += 1;
      const alignStart = i;
      while (i < format.length && (format[i] as string) >= '0' && (format[i] as string) <= '9') i += 1;
      if (i === alignStart) {
        if (i >= format.length) parseFailure(i, 'Format item ends prematurely');
        parseFailure(alignStart, 'Expected an ASCII digit');
      }
      alignment = Number(format.slice(alignStart, i)) * (signed ? -1 : 1);
    }

    let spec = '';
    if (format[i] === ':') {
      i += 1;
      const specStart = i;
      while (i < format.length && format[i] !== '}') i += 1;
      spec = format.slice(specStart, i);
    }

    if (format[i] !== '}') parseFailure(format.length, 'Format item ends prematurely');
    i += 1;
    flush();
    parts.push({ index, alignment, spec });
  }

  flush();
  return parts;
}

// ---------------------------------------------------------------------------
// dates
// ---------------------------------------------------------------------------

/**
 * The standard date/time specifiers, restricted to those measured.
 *
 *   G  3/4/2020 3:06:07 PM         the culture's general pattern; also what
 *                                  `'{0}' -f $date` produces
 *   D  Wednesday, March 4, 2020    the date half of the full pattern
 *   s  2020-03-04T15:06:07         sortable, culture-independent
 *   O  2020-03-04T15:06:07.0890000
 *   u  2020-03-04 15:06:07Z
 *
 * `d`, `t`, `T`, `f`, `F`, `g`, `M`, `R`, `U` and `Y` are NOT implemented: each
 * needs a culture pattern that was not captured, and inventing one would make
 * this file's other claims worth less. A single letter that is not a specifier
 * at all is an error in pwsh too — `'{0:h}' -f $date` throws, because .NET reads
 * a one-character format string as a standard specifier rather than a custom one.
 */
function formatDateStandard(value: Date, letter: string, culture: CultureData): string {
  const pad3 = (n: number): string => String(n).padStart(3, '0');
  if (letter === 'G') return formatDateGeneral(value, culture);
  if (letter === 'D') return formatDateFull(value, culture).replace(/ \d?\d:\d\d:\d\d.*$/, '');
  if (letter === 's') return formatDatePattern(value, "yyyy-MM-dd'T'HH:mm:ss", culture);
  if (letter === 'O' || letter === 'o') {
    return `${formatDatePattern(value, "yyyy-MM-dd'T'HH:mm:ss", culture)}.${pad3(value.getMilliseconds())}0000`;
  }
  if (letter === 'u') return `${formatDatePattern(value, 'yyyy-MM-dd HH:mm:ss', culture)}Z`;
  throw new FormatOperatorError(
    `the standard date/time format specifier '${letter}' is recognised but not implemented`,
  );
}

// ---------------------------------------------------------------------------
// one argument
// ---------------------------------------------------------------------------

const STANDARD_NUMERIC = /^([A-Za-z])(\d*)$/;

function formatNumericSpec(
  value: number | bigint,
  spec: string,
  culture: CultureData,
): string {
  if (spec === '') return formatGeneral(value, null, culture, true);

  const match = STANDARD_NUMERIC.exec(spec);
  if (match === null) return formatCustom(value, spec, culture);

  const letter = match[1] as string;
  const precision = match[2] === '' ? null : Number(match[2]);
  const numeric = typeof value === 'bigint' ? Number(value) : value;

  switch (letter) {
    case 'N':
    case 'n':
      return formatNumber(numeric, precision ?? culture.numberDecimalDigits, culture);
    case 'F':
    case 'f':
      return formatFixed(numeric, precision ?? culture.numberDecimalDigits, culture);
    case 'D':
    case 'd':
      return formatDecimalInteger(value, precision ?? 0, culture);
    case 'P':
    case 'p':
      return formatPercent(numeric, precision ?? culture.percentDecimalDigits, culture);
    case 'X':
      return formatHex(value, precision ?? 0, true);
    case 'x':
      return formatHex(value, precision ?? 0, false);
    case 'C':
    case 'c':
      return formatCurrency(numeric, precision ?? culture.currencyDecimalDigits, culture);
    case 'E':
      return formatExponential(numeric, precision ?? 6, culture, true);
    case 'e':
      return formatExponential(numeric, precision ?? 6, culture, false);
    case 'G':
    case 'R':
      return formatGeneral(value, precision, culture, true);
    case 'g':
    case 'r':
      return formatGeneral(value, precision, culture, false);
    default:
      // A single unknown letter is an invalid standard specifier; a longer run
      // of them is a custom format string of literals. Measured: '{0:ZZZ}'
      // yields ZZZ, while '{0:Z}' throws.
      if (spec.length === 1) throw new NumericFormatError('Format specifier was invalid.');
      return formatCustom(value, spec, culture);
  }
}

/**
 * One `{n}` substitution.
 *
 * Deliberately NOT implemented, and each would be a lie rather than a gap:
 *   - TimeSpan and enum specifiers, which need types the pipeline does not model
 *   - the `,` scaling suffix in a custom numeric format (`0,,` for millions)
 *   - scientific sections inside a custom numeric format
 *   - a third custom section for zero (`+;-;zero`)
 */
export function formatValue(value: PSValue, spec: string, culture: CultureData): string {
  if (value === null || value === undefined) return '';
  // A string is not IFormattable: the specifier is discarded, not applied.
  if (typeof value === 'string') return value;
  // Boolean is not IFormattable either, so `'{0:N2}' -f $true` is `True`.
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number' || typeof value === 'bigint') {
    return formatNumericSpec(value, spec, culture);
  }
  if (value instanceof Date) {
    if (spec === '') return formatDateGeneral(value, culture);
    if (spec.length === 1) return formatDateStandard(value, spec, culture);
    return formatDatePattern(value, spec, culture);
  }
  // String.Format falls back to ToString(), which for an array is its TYPE
  // name. `"$(@(1,2))"` is `1 2`; `'{0}' -f (,@(1,2))` is `System.Object[]`.
  if (Array.isArray(value) || value instanceof Uint8Array) return typeNameOf(value);
  if (isPSObject(value)) return toPSString(value);
  return toPSString(value);
}

/**
 * `$x.ToString()` — the CULTURE-DEPENDENT conversion, which to-string.ts
 * deliberately refuses to provide.
 *
 * That refusal is about not reusing `toPSString`, and this does not: it is the
 * no-specifier arm of `String.Format`, which is exactly what `.ToString()` is.
 * The two really do disagree, which is the whole reason both exist:
 *
 *   culture   "$(1234.5)"   (1234.5).ToString()
 *   en-US     1234.5        1234.5
 *   de-DE     1234.5        1234,5          <-- differ
 *
 * And they disagree in PRECISION as well as separators: `"$(1/3)"` is
 * `0.333333333333333` (PowerShell's G15) while `(1/3).ToString()` is
 * `0.3333333333333333` (.NET Core's shortest round trip). Both measured.
 *
 * `$null.ToString()` THROWS in pwsh where `"$null"` is empty; that belongs to
 * the method-call evaluator, which knows it is dispatching on a null reference,
 * so the empty string is returned here rather than faking an exception this
 * function has no standing to raise.
 */
export function toCultureString(value: PSValue, culture: CultureData = DEFAULT_CULTURE): string {
  return formatValue(value, '', culture);
}

// ---------------------------------------------------------------------------
// the operator
// ---------------------------------------------------------------------------

/**
 * `format -f args`.
 *
 * The right operand is already unrolled by the caller, because PowerShell's
 * array-unrolling is the pipeline's job rather than this operator's:
 * `'{0}-{1}' -f @('a','b')` supplies two arguments.
 *
 * Extra arguments are ignored and a missing one throws, both measured:
 *   '{0}'      -f 'a','b'  ->  a
 *   '{0} {1}'  -f 'a'      ->  Index (zero based) must be greater than or
 *                              equal to zero and less than the size of the
 *                              argument list.
 */
export function formatOperator(
  format: string,
  args: readonly PSValue[],
  culture: CultureData = DEFAULT_CULTURE,
): string {
  let out = '';
  for (const part of parse(format)) {
    if (typeof part === 'string') {
      out += part;
      continue;
    }
    if (part.index >= args.length) {
      throw new FormatOperatorError(
        'Index (zero based) must be greater than or equal to zero and less than the size of the argument list.',
      );
    }
    let text: string;
    try {
      text = formatValue(args[part.index] as PSValue, part.spec, culture);
    } catch (error) {
      if (error instanceof NumericFormatError) throw new FormatOperatorError(error.message);
      if (error instanceof DatePatternError) throw new FormatOperatorError(error.message);
      throw error;
    }
    // Padded by character count, not display width. See the file header.
    if (part.alignment > 0) text = text.padStart(part.alignment, ' ');
    else if (part.alignment < 0) text = text.padEnd(-part.alignment, ' ');
    out += text;
  }
  return out;
}
