/**
 * width.ts — the formatter's view of terminal width: padding and truncation.
 *
 * The MEASUREMENT is not here. It is in `src/line-editor/cells.ts`, which both
 * this file and `src/line-editor/metrics.ts` import, and whose header carries
 * the model, the evidence for it and the decisions it makes. This file used to
 * carry a second, divergent copy: the two disagreed on 914 code points, and
 * this one counted all 448 code points of U+2600–U+27BF as double-width
 * when only 60 of them are, so `✓ ✗ ★ ☐` — the contents of a status column —
 * were each budgeted two cells and drawn in one. Every table containing one was
 * over-padded by exactly the count of them.
 *
 * WHY THE MEASUREMENT MOVED RATHER THAN THIS FILE BECOMING THE HOME. The
 * line-editor core is sealed by a test: every module under `src/line-editor/`
 * may import only `./…` and the generated manifests. `metrics.ts` therefore
 * cannot import from `src/formatting/`, so the shared answer had to live inside
 * the core. The dependency runs core → formatting, which is the direction the
 * rest of the repository already runs in.
 *
 * WHAT IS LEFT HERE is the part that is genuinely about formatting rather than
 * about Unicode: fitting a measured string into a column. That is where the two
 * questions meet — `displayWidth` says how many cells a run of text costs, and
 * `clusters` says where a cut may land — and keeping them in one file is what
 * stops a truncation from spending a budget it computed with a different ruler.
 */

export { cellWidthOfCodePoint, displayWidth } from '../line-editor/cells.ts';

import { displayWidth } from '../line-editor/cells.ts';
import { segmentGraphemes } from '../line-editor/graphemes.ts';

/** Pad on the right to `columns`, measuring by display width rather than length. */
export function padRight(text: string, columns: number): string {
  const pad = columns - displayWidth(text);
  return pad > 0 ? text + ' '.repeat(pad) : text;
}

/** Pad on the left to `columns`, for right-aligned numeric columns. */
export function padLeft(text: string, columns: number): string {
  const pad = columns - displayWidth(text);
  return pad > 0 ? ' '.repeat(pad) + text : text;
}

/**
 * Split into grapheme clusters — the positions a cut is allowed to land on.
 *
 * Shared with the line editor on purpose. "Where may the caret sit" and "where
 * may this string be cut" are the same question, and this repository has now
 * been bitten twice by answering one question in more than one place. The copy
 * that used to live in `render.ts` had no fallback for a missing
 * `Intl.Segmenter`, so a host without ECMA-402 threw while the editor, which
 * had a fallback, kept working.
 */
export function clusters(text: string): string[] {
  return segmentGraphemes(text);
}

/**
 * Truncate to at most `columns`, never splitting a grapheme cluster.
 *
 * Cutting mid-cluster would emit half an emoji or an orphaned combining mark,
 * which renders as a replacement character and throws the column count off by
 * exactly the amount the truncation was trying to save.
 *
 * Note that a cluster can be wider than two cells now: a ZWJ family is eight,
 * because a cell terminal draws its four people separately. So a budget may be
 * left partly unspent rather than filled to the last cell, which is correct —
 * the alternative is emitting a fragment of a sequence.
 */
export function truncateToWidth(text: string, columns: number, ellipsis = '…'): string {
  if (displayWidth(text) <= columns) return text;
  const suffix = displayWidth(ellipsis);
  const budget = columns - suffix;
  if (budget <= 0) return '';

  let used = 0;
  let out = '';
  for (const cluster of clusters(text)) {
    const w = displayWidth(cluster);
    if (used + w > budget) break;
    out += cluster;
    used += w;
  }
  return out + ellipsis;
}
