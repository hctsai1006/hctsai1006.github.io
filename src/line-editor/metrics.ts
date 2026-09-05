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
 * WHAT THIS FILE NO LONGER DOES. It used to carry its own copy of the width
 * table, and the copy had drifted from `src/formatting/width.ts` — the two
 * disagreed on 914 code points, and on every one of U+2600–U+27BF. Two
 * implementations of one measurement is one implementation and a bug, so the
 * table is gone and the answer comes from
 * `./cells.ts`, which the formatter imports too. What stays here is the PORT:
 * the shape a host implements, and the default that assumes a monospace grid.
 *
 * THE TWO QUESTIONS, ONCE MORE. "How many cells does this occupy" is answered
 * per code point by `./cells.ts`. "Where may the caret sit" is answered per
 * grapheme cluster by `./graphemes.ts`. The editor needs both and they are not
 * the same question; conflating them is what produced the second width table.
 * `cellWidthOf` below bridges them: hand it one cluster and it returns the cells
 * that cluster's code points add up to, which is what a cell terminal advances.
 */

import { displayWidth as cellsOf } from './cells.ts';
import { segmentGraphemes } from './graphemes.ts';

export interface TerminalMetrics {
  /** Usable width in cells. Bounds wrapping and the completion menu. */
  readonly columns: number;
  /** Usable height in rows. Bounds how many candidates a menu page shows. */
  readonly rows: number;
  /** Cells one grapheme cluster occupies: the sum over its code points. */
  cellWidth(grapheme: string): number;
}

/**
 * Cells one grapheme cluster occupies.
 *
 * The same function as `displayWidth`, named for the port. It is NOT capped at
 * two: a cluster is as wide as its parts, so `é` is 1, `中` is 2 and the ZWJ
 * family 👨‍👩‍👧‍👦 is 8 — four emoji that a cell terminal has no way to fuse.
 * The previous version returned 2 for all of them, which is why a line
 * containing one wrapped in the wrong place.
 */
export const cellWidthOf: (grapheme: string) => number = cellsOf;

/**
 * Cells a whole string occupies. The replacement for v1's `dw()`.
 *
 * With the default measurement this is exactly `./cells.ts`'s `displayWidth`:
 * segmentation partitions the string, so summing per cluster and summing per
 * code point cannot differ. The `cellWidth` parameter exists for hosts that
 * genuinely measure — a proportional font, a canvas — and only then does the
 * per-cluster walk do any work the default would not.
 */
export function displayWidth(text: string, cellWidth?: (grapheme: string) => number): number {
  if (cellWidth === undefined) return cellsOf(text);
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
