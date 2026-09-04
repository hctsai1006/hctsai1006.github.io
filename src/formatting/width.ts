/**
 * width.ts — how many terminal columns a string occupies.
 *
 * Column width is not string length, and getting it wrong misaligns every
 * table the shell prints. The v1 terminal already knew this and shipped a
 * double-width counter covering the main CJK ranges, which is why its tables
 * line up for Chinese. That implementation is preserved in spirit and corrected
 * in three places where it undercounts:
 *
 *   1. EMOJI. `dw()` tested `0x20000..0x3FFFD` for the astral planes, but emoji
 *      live at `U+1F300..U+1FAFF`, below that floor. So 🎉 (U+1F389) counted as
 *      one column while every terminal renders it as two. PowerShell 7.7 has an
 *      upstream fix for exactly this class of bug in its progress bar (#26185).
 *
 *   2. COMBINING MARKS. A combining accent occupies no column of its own —
 *      "é" written as e + U+0301 is one column, not two.
 *
 *   3. GRAPHEME CLUSTERS. A ZWJ sequence such as 👨‍👩‍👧 is several code points
 *      and one visible glyph. Counting per code point inflates it enormously.
 *
 * The measurement is per GRAPHEME, using Intl.Segmenter, which is available in
 * Node 20+ and every browser this project targets. Falling back to per-code-point
 * counting when it is missing would silently reintroduce the bug, so the absence
 * is reported instead.
 */

/**
 * East Asian Wide (W) and Fullwidth (F) ranges from UAX #11.
 *
 * Deliberately a table rather than a regex: `\p{East_Asian_Width=Wide}` is not
 * a supported Unicode property escape in JavaScript, so a regex here would
 * either not compile or would silently match something else.
 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo init. consonants
  [0x2e80, 0x303e], // CJK Radicals, Kangxi, CJK Symbols
  [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, Hangul Compat Jamo, CJK Compat
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi Syllables, Yi Radicals
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe10, 0xfe19], // Vertical forms
  [0xfe30, 0xfe6f], // CJK Compatibility Forms, Small Form Variants
  [0xff00, 0xff60], // Fullwidth Forms
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x1b000, 0x1b001], // Kana Supplement
  [0x1f200, 0x1f251], // Enclosed Ideographic Supplement
  [0x20000, 0x2fffd], // CJK Extension B..
  [0x30000, 0x3fffd], // CJK Extension G..
];

/**
 * Emoji that render double-width. `Extended_Pictographic` alone is too broad —
 * it includes characters like © and ™ that are narrow — so presentation is
 * decided by the emoji ranges plus an explicit variation selector.
 */
const EMOJI_WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x2600, 0x27bf], // Misc Symbols and Dingbats, when emoji-presented
];

const inRanges = (cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean =>
  ranges.some(([lo, hi]) => cp >= lo && cp <= hi);

/** U+FE0F requests emoji presentation, which is double-width. */
const VARIATION_SELECTOR_16 = 0xfe0f;
/** U+FE0E requests text presentation, which is single-width. */
const VARIATION_SELECTOR_15 = 0xfe0e;

const COMBINING = /^\p{Mn}|^\p{Me}|^\p{Mc}/u;

let segmenter: Intl.Segmenter | null = null;

function graphemes(text: string): string[] {
  if (typeof Intl.Segmenter !== 'function') {
    // Falling back to per-code-point counting would silently misalign every
    // table containing an emoji or a combining mark, which is the bug this
    // module exists to fix. Say so instead.
    throw new Error(
      'Intl.Segmenter is required to measure terminal column width correctly. ' +
        'Counting code points instead would misalign emoji and combining marks.',
    );
  }
  segmenter ??= new Intl.Segmenter('en', { granularity: 'grapheme' });
  return [...segmenter.segment(text)].map((s) => s.segment);
}

/**
 * Columns occupied by a single grapheme cluster: 0, 1 or 2.
 *
 * A cluster is measured by its FIRST meaningful code point plus any presentation
 * selector, because a cluster renders as one glyph in the width its base
 * character dictates. Summing the parts would count a ZWJ family as six.
 */
export function graphemeWidth(cluster: string): number {
  const points = [...cluster].map((c) => c.codePointAt(0) ?? 0);
  const first = points[0];
  if (first === undefined) return 0;

  // Control characters occupy nothing. A terminal that prints them moves the
  // cursor by its own rules, which is not something a width calculation can
  // model, so they contribute zero.
  if (first < 0x20 || (first >= 0x7f && first <= 0x9f)) return 0;

  // A lone combining mark has no width of its own.
  if (COMBINING.test(cluster)) return 0;

  if (points.includes(VARIATION_SELECTOR_16)) return 2;
  if (points.includes(VARIATION_SELECTOR_15)) return 1;

  if (inRanges(first, WIDE_RANGES)) return 2;
  if (inRanges(first, EMOJI_WIDE_RANGES)) return 2;

  // A ZWJ sequence renders as a single double-width glyph.
  if (points.includes(0x200d)) return 2;

  return 1;
}

/** Total columns a string occupies in a terminal. */
export function displayWidth(text: string): number {
  let total = 0;
  for (const cluster of graphemes(text)) total += graphemeWidth(cluster);
  return total;
}

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
 * Truncate to at most `columns`, never splitting a grapheme cluster.
 *
 * Cutting mid-cluster would emit half an emoji or an orphaned combining mark,
 * which renders as a replacement character and throws the column count off by
 * exactly the amount the truncation was trying to save.
 */
export function truncateToWidth(text: string, columns: number, ellipsis = '…'): string {
  if (displayWidth(text) <= columns) return text;
  const suffix = displayWidth(ellipsis);
  const budget = columns - suffix;
  if (budget <= 0) return '';

  let used = 0;
  let out = '';
  for (const cluster of graphemes(text)) {
    const w = graphemeWidth(cluster);
    if (used + w > budget) break;
    out += cluster;
    used += w;
  }
  return out + ellipsis;
}
