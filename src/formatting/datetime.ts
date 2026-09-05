/**
 * datetime.ts — the CULTURE layer over the one date/time engine.
 *
 * THERE USED TO BE TWO ENGINES AND THIS FILE HELD THE WORSE ONE.
 *
 * `formatDatePattern` here expanded custom patterns; `expandCustom` in
 * src/commands/native/datetime.ts expanded custom patterns. Measured against
 * .NET over a 47-pattern corpus, the native one was wrong on 0 and this one was
 * wrong on 20, in two classes:
 *
 *   - It had no standard-specifier table, so it read every ONE-CHARACTER
 *     pattern as a custom one. .NET never does: `'{0:d}' -f $date` is
 *     `3/4/2026`, the culture's short date, not the day number `4`.
 *   - It formatted from `Date.getMilliseconds()`, so it could not see the ticks
 *     below a millisecond and `FFF` fell through to the default branch and
 *     emitted the literal text `FFF`.
 *
 * A mutation test showed why nothing caught it: replacing this file's `y` arm
 * with `'MUTANT'` left conformance coverage unchanged, because all thirteen
 * date cases in the corpus route through the OTHER engine.
 *
 * So the expansion is no longer done here. This file resolves the CULTURE —
 * which pattern a standard specifier means, and what the names in it are — and
 * hands a fully culture-bound pattern to `formatDotNet`.
 *
 * WHY THE CULTURE LAYER IS OUTSIDE THE ENGINE RATHER THAN A PARAMETER OF IT
 *
 * The obvious shape is `expandCustom(value, pattern, culture)`. It is not what
 * is here because `src/commands/native/` belongs to another change in flight,
 * and forking the engine to add a parameter to it would recreate the exact
 * duplication this file is being repaired for. Binding the names into the
 * pattern first is equivalent — `MMMM` under de-DE becomes the literal `März`
 * before the engine ever sees it — and it keeps the count of date engines at
 * one. If native/ ever takes a culture parameter, this file collapses into a
 * call to it.
 *
 * WHAT THE CULTURE ACTUALLY DECIDES, all captured (see culture.ts):
 *
 *   the standard table   'd' is `M/d/yyyy` (en-US), `dd.MM.yyyy` (de-DE),
 *                        `yyyy/M/d` (zh-TW), `MM/dd/yyyy` (invariant)
 *   the names            MMM/MMMM/ddd/dddd, and the genitive forms
 *   the designators      tt is `PM` (en-US), `下午` (zh-TW)
 *   the era              gg is `AD`, `n. Chr.`, `西元`, `A.D.`
 *   the separators       an unescaped `/` is the DATE separator, not a slash:
 *                        `'{0:M/d/yyyy}' -f $d` is `3.4.2020` under de-DE
 *
 * Four specifiers are culture-INDEPENDENT by definition — `o`/`O`, `r`/`R`,
 * `s` and `u` — and go straight to the engine, which already implements them
 * against the Kind. `U` is culture-dependent AND defined in UTC, so it is the
 * culture's full pattern applied to the converted value.
 */

import { PSDateTime, formatDotNet, psDateTime } from '../commands/native/datetime.ts';
import type { CultureData, StandardDateSpecifier } from './culture.ts';

/** Raised for a format string .NET rejects. */
export class DatePatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatePatternError';
  }
}

/**
 * .NET's own wording, which pwsh surfaces verbatim. Measured on both hosts:
 *
 *   pwsh: '{0:h}' -f $date
 *     Error formatting a string: Input string was not in a correct format..
 *
 * A single letter that is not a standard specifier throws; a RUN of them does
 * not, because a multi-character format string is a custom one in which an
 * unrecognised letter is a literal (`'{0:ZZZ}' -f $date` is `ZZZ`).
 */
const NOT_A_FORMAT = 'Input string was not in a correct format.';

/** The nineteen .NET spells; the four the engine owns are handled before this. */
const STANDARD = new Set<string>([
  'd', 'D', 'f', 'F', 'g', 'G', 'm', 'M', 't', 'T', 'U', 'y', 'Y',
]);

/** Culture-independent by definition, and already implemented by the engine. */
const ENGINE_OWNED = new Set<string>(['o', 'O', 'r', 'R', 's', 'u']);

// ---------------------------------------------------------------------------
// binding a culture into a pattern
// ---------------------------------------------------------------------------

/**
 * Escape a run of text so the engine copies it verbatim.
 *
 * Per CHARACTER with a backslash rather than wrapped in quotes, because the
 * engine's quoted-run scanner has no escape inside a quoted run: a designator
 * that contained an apostrophe would end the run early and the rest would be
 * re-read as pattern letters. Backslash has no such hazard, and it is a real
 * .NET escape rather than an invented one.
 *
 * Split by UTF-16 code unit, not by code point: the engine's `\` arm consumes
 * exactly one code unit, so escaping a surrogate PAIR as a single unit would
 * lose its low half. Every name in the capture is BMP, which is precisely why
 * this is worth stating rather than discovering later.
 */
const literal = (text: string): string => text.split('').map((c) => `\\${c}`).join('');

/**
 * Does the pattern carry a `d` or `dd`? .NET asks this to decide between the
 * nominative and GENITIVE month names, and the answer is visible: de-DE's
 * abbreviated genitive for March is `März` where its nominative is `Mär`, so
 * `'{0:MMM d}' -f $d` is `März 4` and `'{0:MMM}' -f $d` is `Mär`. Both measured.
 *
 * .NET's own test looks at the NEAREST `d` run on each side of the month token
 * and scans the raw string, quoted sections included. This asks the simpler
 * question — is there ANY `d` run of one or two — which differs only for a
 * pattern holding both a short and a long day run whose nearest one is long.
 * Stated rather than hidden: no captured pattern is such a case.
 */
function usesGenitiveMonths(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== 'd') continue;
    let run = 1;
    while (pattern[i + run] === 'd') run += 1;
    if (run <= 2) return true;
    i += run - 1;
  }
  return false;
}

/**
 * Rewrite every culture-dependent token in a custom pattern into an escaped
 * literal, leaving the numeric fields (`y`, `M`, `d`, `H`, `h`, `m`, `s`, `f`,
 * `F`, `z`, `K`) for the engine.
 *
 * Quoting is honoured exactly as the engine honours it, so a name that happens
 * to contain a pattern letter — zh-TW's `星期三` does not, but nothing
 * guarantees that for a culture added later — cannot be re-read as a field.
 */
function bindCulture(pattern: string, value: PSDateTime, culture: CultureData): string {
  const genitive = usesGenitiveMonths(pattern);
  const monthNames = genitive ? culture.monthGenitiveNames : culture.monthNames;
  const abbreviatedMonths = genitive
    ? culture.abbreviatedMonthGenitiveNames
    : culture.abbreviatedMonthNames;
  const month = value.getUTCMonth();
  const weekday = value.getUTCDay();
  const designator = value.getUTCHours() < 12 ? culture.amDesignator : culture.pmDesignator;

  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i] as string;

    // `\x` and a quoted run are the engine's, and are forwarded untouched.
    if (char === '\\') {
      out += pattern.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (char === "'" || char === '"') {
      const close = pattern.indexOf(char, i + 1);
      if (close === -1) throw new DatePatternError(NOT_A_FORMAT);
      out += pattern.slice(i, close + 1);
      i = close + 1;
      continue;
    }

    let run = 1;
    while (pattern[i + run] === char) run += 1;

    switch (char) {
      // A run of 3 is the abbreviated name, 4 or more the full one. Measured:
      // `MMMMM` is `March` and `ddddd` is `Wednesday` — the run saturates
      // rather than erroring.
      case 'M':
        out += run <= 2 ? char.repeat(run)
          : run === 3 ? literal(abbreviatedMonths[month] ?? '')
          : literal(monthNames[month] ?? '');
        break;
      case 'd':
        out += run <= 2 ? char.repeat(run)
          : run === 3 ? literal(culture.abbreviatedDayNames[weekday] ?? '')
          : literal(culture.dayNames[weekday] ?? '');
        break;
      // `t` is the designator's first CHARACTER, `tt` (or more) the whole of it.
      // Measured under zh-TW, where `%t` is `下` — so it is a character of the
      // designator and not an `A`/`P` the engine could hard-code.
      case 't':
        out += literal(run === 1 ? designator.slice(0, 1) : designator);
        break;
      case 'g':
        out += literal(culture.eraName);
        break;
      // An unescaped `/` is the culture's DATE separator and `:` its TIME
      // separator — .NET substitutes them, it does not print them. `/` is
      // visible in the captured set (de-DE's is `.`); `:` is `:` for all four,
      // so it is implemented from the specification and cannot be shown here.
      case '/':
        out += literal(culture.dateSeparator).repeat(run);
        break;
      case ':':
        out += literal(culture.timeSeparator).repeat(run);
        break;
      default:
        out += char.repeat(run);
    }
    i += run;
  }
  return out;
}

// ---------------------------------------------------------------------------
// the value
// ---------------------------------------------------------------------------

/**
 * The engine formats a `PSDateTime`, whose civil fields are its UTC fields by
 * construction. A plain `Date` reaching this file — a test fixture, or a value
 * that never went through Get-Date — is rebuilt from its LOCAL fields, which is
 * what the old implementation read and therefore keeps every existing answer.
 *
 * A `PSDateTime` is passed through rather than rebuilt, because rebuilding
 * would drop the three things only it carries: its Kind, its UTC offset, and
 * its sub-millisecond ticks. Dropping the last of those is how `FFF` used to
 * print the letters `FFF`.
 */
function asPSDateTime(value: Date): PSDateTime {
  if (value instanceof PSDateTime) return value;
  return psDateTime({
    year: value.getFullYear(),
    month: value.getMonth() + 1,
    day: value.getDate(),
    hour: value.getHours(),
    minute: value.getMinutes(),
    second: value.getSeconds(),
    millisecond: value.getMilliseconds(),
  });
}

/** `U` is the full pattern applied to the UTC instant, so the value shifts. */
function toUtc(value: PSDateTime): PSDateTime {
  const offset = value.kind === 'Utc' ? 0 : value.offsetMinutes;
  return new PSDateTime(value.getTime() - offset * 60_000, {
    kind: 'Utc',
    offsetMinutes: value.offsetMinutes,
    subMillisecondTicks: value.subMillisecondTicks,
  });
}

// ---------------------------------------------------------------------------
// the entry point
// ---------------------------------------------------------------------------

/**
 * Format a DateTime against a .NET format string under one culture.
 *
 * An EMPTY format string is `G`, a ONE-CHARACTER one is a standard specifier
 * (never a custom one), and anything longer is a custom pattern. That three-way
 * split is .NET's, and getting it wrong is what cost the old implementation
 * twenty of forty-seven patterns.
 *
 *   formatDate(d, '',      EN_US)  3/4/2020 3:06:07 PM
 *   formatDate(d, 'd',     EN_US)  3/4/2020
 *   formatDate(d, 'd',     ZH_TW)  2020/3/4
 *   formatDate(d, 'dd',    EN_US)  04
 *   formatDate(d, '%d',    EN_US)  4
 *   formatDate(d, 'h',     EN_US)  throws — `h` is not a standard specifier
 */
export function formatDate(value: Date, format: string, culture: CultureData): string {
  const instant = asPSDateTime(value);

  if (format.length === 0) return formatDate(value, 'G', culture);

  if (format.length === 1) {
    if (ENGINE_OWNED.has(format)) return formatDotNet(instant, format);
    if (!STANDARD.has(format)) throw new DatePatternError(NOT_A_FORMAT);
    const specifier = format as StandardDateSpecifier;
    const subject = specifier === 'U' ? toUtc(instant) : instant;
    return expand(subject, culture.standardDatePatterns[specifier], culture);
  }

  // `%x` says "the single character x is a CUSTOM specifier", which is the only
  // way to ask for one — a bare `d` would have been read as the standard
  // specifier above. Measured: `'{0:%d}' -f $date` is `4`.
  if (format.length === 2 && format.startsWith('%')) {
    return expand(instant, format.slice(1), culture);
  }

  return expand(instant, format, culture);
}

/**
 * Bind the culture and hand the result to the engine.
 *
 * A pattern that collapses to a single character would be re-read by the engine
 * as a STANDARD specifier, which is the one thing this function must not let
 * happen — `%d` binds to `d`, and `formatDotNet(value, 'd')` is `3/4/2026`. An
 * empty quoted run in front costs nothing and settles it: the engine consumes
 * `''` as a zero-length literal and the rest is unambiguously custom.
 */
function expand(value: PSDateTime, pattern: string, culture: CultureData): string {
  const bound = bindCulture(pattern, value, culture);
  return formatDotNet(value, bound.length === 1 ? `''${bound}` : bound);
}

/**
 * The culture's general pattern — what a DateTime shows in a table cell and what
 * `'{0}' -f $date` produces.
 *
 * zh-TW's designator sits BEFORE the hour with no space (`2020/3/4 下午3:06:07`)
 * while en-US puts it last and separates it with U+202F. That is in the pattern,
 * not in the code, which is why the pattern is captured data.
 */
export const formatDateGeneral = (value: Date, culture: CultureData): string =>
  formatDate(value, 'G', culture);

/** The full pattern — what a BARE DateTime shows through the default view. */
export const formatDateFull = (value: Date, culture: CultureData): string =>
  formatDate(value, 'F', culture);
