/**
 * docs-claim.mts — extracting what the documentation CLAIMS, kept separate from
 * what is true.
 *
 * The whole point of ranking prose last is being able to compare it against the
 * machine-readable sources. That comparison only works if the claim is parsed
 * into data first, so this is a pure function over markdown with no fetching in
 * it — which also means it can be tested against real doc text.
 *
 * Two properties matter and are easy to get wrong:
 *
 *   1. The docs hard-wrap. The version can be separated from the word
 *      "PowerShell" by a newline:
 *
 *          PowerShell 7.6.5 includes the following features... PowerShell
 *          7.6.5 is built on the .NET 10.0.11 runtime.
 *
 *      So the whitespace class must match newlines. Tightening it to a literal
 *      space silently stops matching.
 *
 *   2. `rc` must be accepted, not just `preview`. PowerShell ships an rc before
 *      every GA. A parser that only knows `-preview.N` returns null for the
 *      whole rc window, which the caller escalates to an error — turning the
 *      month before every release into a guaranteed false failure. A gate with a
 *      predictable false alarm gets disabled, which converts "never silently
 *      pass" into "never runs".
 */

export interface DocsClaim {
  /** The PowerShell version the doc says it describes, or null if unparseable. */
  psVersion: string | null;
  /** The .NET version the doc associates with it. */
  dotnetVersion: string | null;
  /** The noun the prose used — usually "runtime", even when naming an SDK. */
  dotnetNoun: string | null;
  /** How many "is built on" sentences the file contains. More than one is ambiguous. */
  builtOnSentences: number;
}

/** Matches both pre-release kinds. See property 2 above. */
const PRE = String.raw`(?:-(?:preview|rc)\.\d+)?`;

const BUILT_ON = new RegExp(
  String.raw`PowerShell\s+(\d+\.\d+\.\d+${PRE})\s+is built on the\s+\.NET\s+([\d][\w.-]*)\s+(runtime|SDK)`,
  'i',
);

const INCLUDES = new RegExp(
  String.raw`PowerShell\s+(\d+\.\d+\.\d+${PRE})\s+includes the following`,
  'i',
);

export function parseDocsClaim(markdown: string): DocsClaim {
  // Count matches, don't just take the first. A doc that grows a second
  // "is built on" sentence — a historical section, say — would otherwise have
  // its older sentence silently win, producing a false
  // "docs-version-behind-release" finding that looks like an upstream problem.
  const all = [...markdown.matchAll(new RegExp(BUILT_ON.source, 'gi'))];
  const built = all[0];
  const includes = INCLUDES.exec(markdown);
  return {
    psVersion: built?.[1] ?? includes?.[1] ?? null,
    dotnetVersion: built?.[2] ?? null,
    dotnetNoun: built?.[3]?.toLowerCase() ?? null,
    builtOnSentences: all.length,
  };
}

/**
 * A row of the support-lifecycle table:
 *
 *     | PowerShell 7.6 (LTS)     | 18-Mar-2026  |  14-Nov-2028   | [.NET 10.0][07] |
 *     | PowerShell 7.7 (preview) |              |                | [.NET 11.0][08] |
 *     | PowerShell 7.5           | 23-Jan-2025  |  10-Nov-2026   | [.NET 9.0][16]  |
 *
 * The qualifier is not always "(LTS)". Matching only that skipped the preview row
 * and produced a false "no row for 7.7" warning.
 */
export interface LifecycleRow {
  line: string;
  isLts: boolean;
  endOfSupport: string | null;
  /** The raw end-of-support cell, kept so an unparseable one can be reported. */
  rawEndOfSupport: string;
}

export interface LifecycleTable {
  rows: Map<string, LifecycleRow>;
  /**
   * Versions listed more than once. The doc carries a supported table AND an
   * end-of-life table under one heading, so a version appearing in both would
   * otherwise take its values from whichever came last.
   */
  duplicates: string[];
  /**
   * Rows whose end-of-support cell is non-empty but did not parse as a date.
   * Inserting a column shifts the cells: the row still matches, isLts is still
   * right, and only the date silently becomes null — so the independent EOL
   * cross-check goes blind with no signal at all. Reporting these is the signal.
   */
  unparseableDates: Array<{ line: string; raw: string }>;
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** "14-Nov-2028" -> "2028-11-14", so it can be compared with .NET's eol-date. */
export function toIsoDate(dmy: string): string | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(dmy.trim());
  if (m === null) return null;
  const [, d, mon, y] = m;
  const mm = MONTHS[(mon ?? '').toLowerCase()];
  if (d === undefined || y === undefined || mm === undefined) return null;
  return `${y}-${mm}-${d.padStart(2, '0')}`;
}

/** The version cell, e.g. "PowerShell 7.6 (LTS)" or "PowerShell 7.7 (preview)". */
const VERSION_CELL = /^PowerShell\s+(\d+\.\d+)\s*(?:\(([A-Za-z]+)\))?$/i;

const splitRow = (line: string): string[] =>
  line.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());

/**
 * Read the table by COLUMN NAME, not by column position.
 *
 * Positional groups look fine until the table gains a column. Then the row still
 * matches, the LTS qualifier is still right, and the "end-of-support" cell
 * silently becomes whatever now sits in that position — in the real doc, the
 * *Released* date, which parses cleanly and is simply wrong. A plausible wrong
 * date is far more dangerous than a missing one, and no amount of validating the
 * value would catch it, because the value is valid. So the header row decides
 * which column is which, and a table whose header we cannot read is reported
 * rather than guessed at.
 */
export function parseLifecycleTable(markdown: string): LifecycleTable {
  const rows = new Map<string, LifecycleRow>();
  const duplicates: string[] = [];
  const unparseableDates: Array<{ line: string; raw: string }> = [];

  let eolColumn: number | null = null;

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;

    const cells = splitRow(line);

    // A header row re-arms the column mapping, so several tables in one document
    // are each read against their own header.
    const headerIndex = cells.findIndex((c) => /end.of.support/i.test(c));
    if (headerIndex !== -1) {
      eolColumn = headerIndex;
      continue;
    }
    if (/^[-: ]+$/.test(cells.join(''))) continue; // separator row

    const version = VERSION_CELL.exec(cells[0] ?? '');
    if (version === null) continue;
    const key = version[1];
    if (key === undefined) continue;

    // First occurrence wins: the supported-versions table precedes the
    // end-of-life table, and the supported one is authoritative.
    if (rows.has(key)) {
      duplicates.push(key);
      continue;
    }

    const cell = eolColumn === null ? '' : (cells[eolColumn] ?? '');
    const endOfSupport = toIsoDate(cell);
    if (eolColumn === null) {
      unparseableDates.push({ line: key, raw: '<no end-of-support column in the header>' });
    } else if (cell !== '' && endOfSupport === null) {
      unparseableDates.push({ line: key, raw: cell });
    }

    rows.set(key, {
      line: key,
      isLts: (version[2] ?? '').toUpperCase() === 'LTS',
      endOfSupport,
      rawEndOfSupport: cell,
    });
  }

  return { rows, duplicates, unparseableDates };
}
