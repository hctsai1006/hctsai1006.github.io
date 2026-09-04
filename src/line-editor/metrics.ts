/**
 * metrics.ts — the geometry port.
 *
 * v1 measured the terminal by writing a 50-character probe span into `#out`,
 * calling `getBoundingClientRect()` on it, and deriving columns from
 * `con.clientWidth`. That is one function, and it made the entire editor
 * untestable outside a browser: nothing downstream of it could run without a
 * layout engine.
 *
 * So geometry becomes an injected value. The core asks how wide the terminal is
 * and how wide a grapheme renders; it never measures. A browser adapter can
 * implement this with the same probe span, a canvas adapter with `measureText`,
 * and a test with two numbers.
 *
 * `monospaceMetrics` is the table-driven default. It differs from v1's `dw()` in
 * two places that were bugs there: emoji are two cells wide, not one, and a
 * combining mark is zero cells, not one.
 */

import { segmentGraphemes } from './graphemes.ts';

export interface TerminalMetrics {
  /** Usable width in cells. Bounds wrapping and the completion menu. */
  readonly columns: number;
  /** Usable height in rows. Bounds how many candidates a menu page shows. */
  readonly rows: number;
  /** Cells one grapheme cluster occupies: 0 for a mark, 1 narrow, 2 wide. */
  cellWidth(grapheme: string): number;
}

/** East Asian Wide and Fullwidth ranges, plus the emoji blocks that render wide. */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f320],
  [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393],
  [0x1f3a0, 0x1f3ca],
  [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e],
  [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596],
  [0x1f5a4, 0x1f5a4],
  [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5],
  [0x1f6cc, 0x1f6cc],
  [0x1f6d0, 0x1f6d2],
  [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fc],
  [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

const MARK = /\p{M}/u;

function isWide(cp: number): boolean {
  for (const range of WIDE_RANGES) {
    if (cp >= range[0] && cp <= range[1]) return true;
  }
  return false;
}

/**
 * Cells one cluster occupies, decided by its BASE code point.
 *
 * A cluster's marks add nothing — that is what makes them marks — so `e` plus
 * U+0301 is one cell and 👨‍👩‍👧‍👦 is two, not eleven.
 */
export function cellWidthOf(grapheme: string): number {
  const cp = grapheme.codePointAt(0);
  if (cp === undefined) return 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (MARK.test(String.fromCodePoint(cp))) return 0;
  return isWide(cp) ? 2 : 1;
}

/** Cells a whole string occupies. The replacement for v1's `dw()`. */
export function displayWidth(text: string, cellWidth = cellWidthOf): number {
  let total = 0;
  for (const g of segmentGraphemes(text)) total += cellWidth(g);
  return total;
}

/** Metrics for a terminal of `columns` x `rows` cells. */
export function monospaceMetrics(columns: number, rows: number): TerminalMetrics {
  return { columns, rows, cellWidth: cellWidthOf };
}

/**
 * A stand-in for hosts that have not measured anything yet. 80x24 is the
 * conventional default and is honest about being a guess, which a zero would
 * not be — a zero-column terminal would silently disable wrapping decisions.
 */
export const DEFAULT_METRICS: TerminalMetrics = monospaceMetrics(80, 24);
