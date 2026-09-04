/**
 * datetime.ts — .NET custom date/time patterns, shared by the `-f` operator and
 * the formatter.
 *
 * It is one implementation because pwsh uses one: `'{0:yyyy-MM-dd}' -f $d` and
 * the string a bare DateTime prints go through the same pattern engine, only
 * with different patterns. Which pattern is the interesting part, and it is
 * measured:
 *
 *   [datetime]'2020-03-04T15:06:07' | Out-String
 *     Wednesday, March 4, 2020 3:06:07 PM        FullDateTimePattern
 *   [pscustomobject]@{ D = $d } | Format-Table
 *     3/4/2020 3:06:07 PM                        the general pattern
 *   "$d"
 *     03/04/2020 15:06:07                        invariant — see to-string.ts
 *
 * Three different answers for one value, and only the third is culture-free.
 */

import type { CultureData } from './culture.ts';

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

/** Raised for a pattern letter this engine does not implement. */
export class DatePatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatePatternError';
  }
}

/**
 * Format a DateTime against a .NET custom pattern.
 *
 * `'` and `"` quote a literal run and `\` escapes one character, which zh-TW's
 * full pattern needs — it is literally `yyyy'年'M'月'd'日' tt hh:mm:ss`.
 *
 * Implemented: y, M, d, H, h, m, s, f, t in every run length that pwsh accepts,
 * including the name forms `MMM`/`MMMM` and `ddd`/`dddd`, whose names were read
 * off `DateTimeFormat.DayNames` and `.MonthNames` for each culture rather than
 * translated by hand.
 *
 * Not implemented, and raised rather than approximated: `z`, `zz`, `zzz` and `K`
 * need a UTC offset, and `g` needs an era name. The pipeline's Date carries
 * neither.
 */
export function formatDatePattern(value: Date, pattern: string, culture: CultureData): string {
  let out = '';
  let index = 0;
  const hour12 = value.getHours() % 12 === 0 ? 12 : value.getHours() % 12;

  while (index < pattern.length) {
    const char = pattern[index] as string;

    if (char === '\\') {
      out += pattern[index + 1] ?? '';
      index += 2;
      continue;
    }
    if (char === "'" || char === '"') {
      const close = pattern.indexOf(char, index + 1);
      if (close === -1) {
        out += pattern.slice(index + 1);
        index = pattern.length;
      } else {
        out += pattern.slice(index + 1, close);
        index = close + 1;
      }
      continue;
    }

    let run = 1;
    while (pattern[index + run] === char) run += 1;

    switch (char) {
      case 'y':
        out += run <= 2 ? pad(value.getFullYear() % 100, 2) : pad(value.getFullYear(), run);
        break;
      case 'M':
        if (run === 3) out += culture.abbreviatedMonthNames[value.getMonth()] ?? '';
        else if (run >= 4) out += culture.monthNames[value.getMonth()] ?? '';
        else out += pad(value.getMonth() + 1, run);
        break;
      case 'd':
        if (run === 3) out += culture.abbreviatedDayNames[value.getDay()] ?? '';
        else if (run >= 4) out += culture.dayNames[value.getDay()] ?? '';
        else out += pad(value.getDate(), run);
        break;
      case 'H':
        out += pad(value.getHours(), run);
        break;
      case 'h':
        out += pad(hour12, run);
        break;
      case 'm':
        out += pad(value.getMinutes(), run);
        break;
      case 's':
        out += pad(value.getSeconds(), run);
        break;
      case 'f':
        out += pad(value.getMilliseconds(), 3).slice(0, Math.min(run, 3)).padEnd(run, '0');
        break;
      case 't': {
        const designator = value.getHours() < 12 ? culture.amDesignator : culture.pmDesignator;
        out += run === 1 ? designator.slice(0, 1) : designator;
        break;
      }
      case 'z':
      case 'K':
      case 'g':
        throw new DatePatternError(
          `the date/time pattern letter '${char}' is recognised but not implemented: ` +
            'it needs a UTC offset or an era name the pipeline does not carry',
        );
      default:
        out += char.repeat(run);
    }
    index += run;
  }
  return out;
}

/**
 * The culture's general pattern — what a DateTime shows in a table cell and what
 * `'{0}' -f $date` produces.
 *
 * zh-TW's designator sits BETWEEN the date and the time (`2020/3/4 上午
 * 03:06:07`) while en-US puts it last. That is in the pattern, not in the code,
 * which is why the pattern is data.
 */
export const formatDateGeneral = (value: Date, culture: CultureData): string =>
  formatDatePattern(value, culture.dateTimePattern, culture);

/** The full pattern — what a BARE DateTime shows through the default view. */
export const formatDateFull = (value: Date, culture: CultureData): string =>
  formatDatePattern(value, culture.fullDateTimePattern, culture);
