/**
 * cells.ts — how many terminal CELLS a string occupies.
 *
 * This is the only implementation. It used to be two: `src/formatting/width.ts`,
 * used by `render.ts` for Format-Table column layout, and
 * `src/line-editor/metrics.ts`, used by `editor.ts` for wrapping and the caret.
 * They disagreed on 914 of the 1 112 064 code points, and on ALL 448 of
 * U+2600–U+27BF, where the formatting copy answered 2 for every one and the
 * editor copy answered 1 for every one. Measured against the model below, the
 * formatting copy was wrong on 388 of those 448 and the editor copy on the
 * other 60 — the review that found this said "wrong on all 448", which
 * overstates one side: the blanket rule was right by accident 60 times. The
 * ones it was wrong about include `✓ ✗ ★ ☐`, which is precisely what a status
 * column is made of. Both callers now import from here.
 *
 * WHY IT LIVES IN THE LINE EDITOR, which is not where you would look for a
 * table formatter's width function. Not taste — a test. The line-editor core is
 * sealed: `tests/unit/line-editor.test.mts` asserts that every module under
 * `src/line-editor/` imports only `./…` and the generated manifests, so
 * `metrics.ts` CANNOT reach into `src/formatting/`. The shared answer therefore
 * has to sit inside the core — and that is its right home anyway: like
 * `./graphemes.ts` next door, this is a dependency-free Unicode primitive that
 * everything above the core is free to depend on. `src/formatting/width.ts`
 * re-exports it and adds the padding and truncation helpers that only a
 * formatter needs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO QUESTIONS, NOT ONE. This is what produced two modules.
 *
 *   "How many cells does this occupy?"  — answered HERE, per CODE POINT.
 *   "Where may the caret sit?"          — answered by `line-editor/graphemes.ts`,
 *                                         per GRAPHEME CLUSTER.
 *
 * They are different questions with different answers and they must not be
 * merged. A terminal advances its cursor per code point; it has no idea that
 * 👨‍👩‍👧‍👦 is one family. A caret must never land between two halves of that
 * family, because there is no such position to render. Answering the first
 * question with the second is why the old code counted a ZWJ sequence as two
 * cells while every cell-based terminal draws it as eight.
 *
 * This file imports NOTHING — counting cells needs no segmentation, so the two
 * questions do not even share a dependency. They meet one layer up, in
 * `../formatting/width.ts`, which asks this file how wide a cluster is and asks
 * `./graphemes.ts` where a truncation is allowed to cut.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY NOT COPY POWERSHELL. The obvious authority is wrong here. PowerShell
 * measures with `ConsoleControl.LengthInBufferCells()`, and PowerShell/PowerShell
 * issue #6290 ("Table format has been broken when output column contains east
 * asian fullwidth characters") reports that it "returns invalid value when `str`
 * parameter contains east asian fullwidth characters":
 *
 *     // length expected 6(3 fullwidth characters), but actual returns 3.
 *     ConsoleControl.LengthInBufferCells("ハロー", 0, false);
 *
 * The issue is closed as Resolution-No Activity, i.e. still true. It is also a
 * HOST method, so with output redirected — which is how this repository's
 * conformance corpus was captured — there is no console and it degrades to
 * plain `.Length`. That is why two honest measurements of "what does pwsh do"
 * came back with CJK as 1 and CJK as 2. Copying pwsh here would be copying a
 * known bug, so the target is the renderer instead.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MODEL: wcwidth over code points, the way xterm.js does it.
 *
 * `roadmap/pr/PR-16-ansi-renderer.md` names xterm.js as the ANSI adapter, and
 * its acceptance condition is "CJK and emoji align in both renderers". Only a
 * cell model can satisfy that: a DOM renderer can be laid out per cell, but a
 * cell-based terminal cannot be made to do font shaping. So the cell model wins
 * and the DOM renderer follows it.
 *
 * xterm.js's `UnicodeV11` provider (`addons/addon-unicode11`) is `wcwidth(num)`
 * over single code points plus a `charProperties(codepoint, preceding)` that
 * folds a zero-width code point into the cell before it. Reading its tables:
 *
 *     C0, DEL, C1                    0
 *     combining / format             0   (its BMP_COMBINING, incl. U+200B–200F)
 *     East Asian Wide + Fullwidth    2   (its BMP_WIDE / HIGH_WIDE)
 *     everything else                1
 *
 * The rules below reproduce that, with the tables taken from Unicode 16.0.0
 * instead of xterm.js's frozen Unicode 12 snapshot. Swept over all 1 114 112
 * code points, this file and xterm.js UnicodeV11 differ on 1114, and every one
 * is version drift in the direction of being more current:
 *
 *     277 cps  here 0, xterm 1   marks assigned after Unicode 12
 *     833 cps  here 2, xterm 1   Wide assigned after Unicode 12 (U+4DC0–4DFF …)
 *       2 cps  here 1, xterm 0   U+1734, U+1171E — reclassified Mn → Mc in 14
 *       2 cps  here 1, xterm 2   U+1F93B, U+1F946 — de-Wided by the UTC
 *
 * Nothing else differs, which is the evidence that this IS xterm.js's model.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DECISIONS THAT ARE NOT FORCED, and what a terminal actually does.
 *
 * VARIATION SELECTORS. U+FE0F requests emoji presentation and U+FE0E requests
 * text presentation, and it is tempting to make VS16 mean "two cells". A cell
 * terminal does not do that. U+FE00–FE0F are `Mn`, so xterm.js gives them width
 * 0 and joins them into the preceding cell: `✓` + U+FE0F advances ONE cell even
 * though the font may well paint a wide colour glyph there. Both selectors are
 * therefore 0 here, and they fall out of the `\p{Mn}` rule rather than being
 * special-cased. This is a deliberate departure from "VS16 forces 2": it is
 * measured behaviour beating a plausible reading of UTS #51, and it keeps the
 * model at one rule instead of two.
 *
 * ZWJ SEQUENCES. 👨‍👩‍👧‍👦 is 2+0+2+0+2+0+2 = 8 cells, not 2. U+200D is `Cf`,
 * so it contributes nothing and the four people contribute two each. A terminal
 * that cannot shape the sequence draws four emoji, and that is what the column
 * arithmetic has to budget for. This is the single biggest behaviour change in
 * this file and it is the honest answer, not the pretty one.
 *
 * FLAGS. 🇹🇼 is two regional indicators. U+1F1E6–1F1FF is East_Asian_Width
 * Neutral — not Wide — so each is one cell and the pair is 2. That happens to
 * agree with how a shaping renderer draws it, for entirely unrelated reasons.
 *
 * KEYCAPS. `1️⃣` is U+0031 U+FE0F U+20E3 = 1 + 0 + 0 = 1 cell. U+20E3 is `Me`.
 *
 * HANGUL. Conjoining jamo are the one case that property escapes miss. `한`
 * is L + V + T and renders as the single syllable 한, two cells. The vowel and
 * the trailing consonant are `Lo`, not marks, so nothing zeroes them; but
 * Hangul_Syllable_Type does, and that table is generated below. Without it a
 * decomposed syllable measures 4 and every Korean table drifts.
 *
 * SOFT HYPHEN. U+00AD is `Cf`, which would make it 0, and it is the one
 * documented exception: Markus Kuhn's wcwidth excludes it and xterm.js follows,
 * because a terminal prints it rather than folding it into the previous cell.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THE DATA COMES FROM. Everything derivable from a Unicode property
 * escape is derived at run time from the engine's own tables — `\p{Mn}`,
 * `\p{Me}`, `\p{Cf}` — so the zero-width set can never be a stale transcription.
 * East_Asian_Width and Hangul_Syllable_Type are not exposed as escapes
 * (`/\p{East_Asian_Width=Wide}/u` is a SyntaxError), so those two are generated
 * from checked-in verbatim UCD extracts by `tools/generate-width-table.mts` and
 * re-derived independently by `tests/unit/cell-width.test.mts`. Unicode 16.0.0 is
 * pinned to match `process.versions.unicode` on the required Node, so the
 * generated half and the engine half describe the same Unicode.
 *
 * A NOTE ON Intl. The old implementation threw when `Intl.Segmenter` was
 * missing, because its width answer depended on segmentation. This one does
 * not: a width is a sum over code points, so `displayWidth` is exact with no
 * Intl at all — column alignment no longer depends on ECMA-402 being present.
 * Only truncation consults grapheme boundaries, and `segmentGraphemes` already
 * carries its own fallback for that.
 */

// --- BEGIN GENERATED: tools/generate-width-table.mts ---

/**
 * East_Asian_Width = Wide or Fullwidth, Unicode 16.0.0, as flat `lo, hi` pairs.
 *
 * Split at the BMP boundary because the two halves are searched differently:
 * the BMP half seeds a direct lookup table, the astral half is bisected.
 */
const WIDE_BMP: readonly number[] = [ // 59 ranges
  0x1100, 0x115f, 0x231a, 0x231b, 0x2329, 0x232a, 0x23e9, 0x23ec, 0x23f0, 0x23f0, 0x23f3, 0x23f3,
  0x25fd, 0x25fe, 0x2614, 0x2615, 0x2630, 0x2637, 0x2648, 0x2653, 0x267f, 0x267f, 0x268a, 0x268f,
  0x2693, 0x2693, 0x26a1, 0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26ce, 0x26ce,
  0x26d4, 0x26d4, 0x26ea, 0x26ea, 0x26f2, 0x26f3, 0x26f5, 0x26f5, 0x26fa, 0x26fa, 0x26fd, 0x26fd,
  0x2705, 0x2705, 0x270a, 0x270b, 0x2728, 0x2728, 0x274c, 0x274c, 0x274e, 0x274e, 0x2753, 0x2755,
  0x2757, 0x2757, 0x2795, 0x2797, 0x27b0, 0x27b0, 0x27bf, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b50,
  0x2b55, 0x2b55, 0x2e80, 0x2e99, 0x2e9b, 0x2ef3, 0x2f00, 0x2fd5, 0x2ff0, 0x303e, 0x3041, 0x3096,
  0x3099, 0x30ff, 0x3105, 0x312f, 0x3131, 0x318e, 0x3190, 0x31e5, 0x31ef, 0x321e, 0x3220, 0x3247,
  0x3250, 0xa48c, 0xa490, 0xa4c6, 0xa960, 0xa97c, 0xac00, 0xd7a3, 0xf900, 0xfaff, 0xfe10, 0xfe19,
  0xfe30, 0xfe52, 0xfe54, 0xfe66, 0xfe68, 0xfe6b, 0xff01, 0xff60, 0xffe0, 0xffe6,
];

const WIDE_ASTRAL: readonly number[] = [ // 63 ranges
  0x16fe0, 0x16fe4, 0x16ff0, 0x16ff1, 0x17000, 0x187f7, 0x18800, 0x18cd5, 0x18cff, 0x18d08, 0x1aff0, 0x1aff3,
  0x1aff5, 0x1affb, 0x1affd, 0x1affe, 0x1b000, 0x1b122, 0x1b132, 0x1b132, 0x1b150, 0x1b152, 0x1b155, 0x1b155,
  0x1b164, 0x1b167, 0x1b170, 0x1b2fb, 0x1d300, 0x1d356, 0x1d360, 0x1d376, 0x1f004, 0x1f004, 0x1f0cf, 0x1f0cf,
  0x1f18e, 0x1f18e, 0x1f191, 0x1f19a, 0x1f200, 0x1f202, 0x1f210, 0x1f23b, 0x1f240, 0x1f248, 0x1f250, 0x1f251,
  0x1f260, 0x1f265, 0x1f300, 0x1f320, 0x1f32d, 0x1f335, 0x1f337, 0x1f37c, 0x1f37e, 0x1f393, 0x1f3a0, 0x1f3ca,
  0x1f3cf, 0x1f3d3, 0x1f3e0, 0x1f3f0, 0x1f3f4, 0x1f3f4, 0x1f3f8, 0x1f43e, 0x1f440, 0x1f440, 0x1f442, 0x1f4fc,
  0x1f4ff, 0x1f53d, 0x1f54b, 0x1f54e, 0x1f550, 0x1f567, 0x1f57a, 0x1f57a, 0x1f595, 0x1f596, 0x1f5a4, 0x1f5a4,
  0x1f5fb, 0x1f64f, 0x1f680, 0x1f6c5, 0x1f6cc, 0x1f6cc, 0x1f6d0, 0x1f6d2, 0x1f6d5, 0x1f6d7, 0x1f6dc, 0x1f6df,
  0x1f6eb, 0x1f6ec, 0x1f6f4, 0x1f6fc, 0x1f7e0, 0x1f7eb, 0x1f7f0, 0x1f7f0, 0x1f90c, 0x1f93a, 0x1f93c, 0x1f945,
  0x1f947, 0x1f9ff, 0x1fa70, 0x1fa7c, 0x1fa80, 0x1fa89, 0x1fa8f, 0x1fac6, 0x1face, 0x1fadc, 0x1fadf, 0x1fae9,
  0x1faf0, 0x1faf8, 0x20000, 0x2fffd, 0x30000, 0x3fffd,
];

/**
 * Hangul_Syllable_Type = V or T, Unicode 16.0.0: the conjoining jamo that
 * compose into a preceding syllable block instead of opening one.
 */
const JAMO_VT: readonly number[] = [ // 3 ranges
  0x1160, 0x11ff, 0xd7b0, 0xd7c6, 0xd7cb, 0xd7fb,
];

// --- END GENERATED ---

/**
 * Zero-width by general category, read from the engine rather than a table.
 *
 * `Mn` nonspacing marks and `Me` enclosing marks add nothing to their base.
 * `Cf` format characters — ZWJ, ZWNJ, the bidi controls, the tag characters,
 * BOM — are not drawn at all. U+00AD is carved out below.
 */
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]$/u;

/** `Cf`, but a terminal prints it. See SOFT HYPHEN in the header. */
const SOFT_HYPHEN = 0x00ad;

/**
 * Filled on first use: 64 KiB, built by two regex scans, measured at ~8 ms.
 *
 * `cellWidthOfCodePoint` answers ASCII before consulting it, so a session that
 * never prints a non-ASCII BMP character never pays for it at all, and one that
 * does pays once. After that a measurement is an array index: 200 000 calls on a
 * mixed CJK/symbol/ASCII string run in 34 ms, about 0.17 µs each.
 */
let bmp: Uint8Array | null = null;

const fillRanges = (table: Uint8Array, pairs: readonly number[], value: number): void => {
  for (let i = 0; i < pairs.length; i += 2) {
    const lo = pairs[i];
    const hi = pairs[i + 1];
    if (lo === undefined || hi === undefined) continue;
    table.fill(value, lo, hi + 1);
  }
};

/**
 * Mark every `Mn`/`Me`/`Cf` in the BMP zero, in one regex pass per segment.
 *
 * The surrogate block is skipped rather than classified. Including it would put
 * lone surrogates into the scanned string, where an adjacent high and low pair
 * would combine into an astral code point and be classified as something the
 * caller never asked about. Surrogates keep the default 1, which is what
 * xterm.js answers for them too.
 */
function markZeroWidth(table: Uint8Array): void {
  for (const [from, to] of [
    [0x00a0, 0xd7ff],
    [0xe000, 0xffff],
  ] as const) {
    const chars: string[] = [];
    for (let cp = from; cp <= to; cp += 1) chars.push(String.fromCharCode(cp));
    const text = chars.join('');
    for (const match of text.matchAll(/[\p{Mn}\p{Me}\p{Cf}]+/gu)) {
      const at = from + match.index;
      table.fill(0, at, at + match[0].length);
    }
  }
}

function bmpTable(): Uint8Array {
  if (bmp !== null) return bmp;
  const table = new Uint8Array(0x10000).fill(1);

  // C0, DEL and C1. A terminal moves its cursor for these by its own rules,
  // which a width function cannot model, so they contribute nothing.
  table.fill(0, 0x00, 0x20);
  table.fill(0, 0x7f, 0xa0);

  fillRanges(table, WIDE_BMP, 2);

  // After the wide fill, deliberately: a handful of code points are both Wide
  // and a combining mark (U+302A–302D, U+3099–309A) and the mark wins.
  markZeroWidth(table);
  fillRanges(table, JAMO_VT, 0);
  table[SOFT_HYPHEN] = 1;

  bmp = table;
  return table;
}

/** Is `codePoint` inside one of the flat `lo, hi` pairs? Ranges are sorted. */
function inRanges(codePoint: number, pairs: readonly number[]): boolean {
  let lo = 0;
  let hi = pairs.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = pairs[mid * 2];
    const end = pairs[mid * 2 + 1];
    if (start === undefined || end === undefined) return false;
    if (codePoint < start) hi = mid - 1;
    else if (codePoint > end) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Cells one CODE POINT occupies: 0, 1 or 2.
 *
 * This is the whole model. Everything else in this file is summation, padding
 * or cutting. Exported so a test can sweep it over the entire code space
 * without going through a string.
 */
export function cellWidthOfCodePoint(codePoint: number): number {
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) return 0;
  if (codePoint < 0x7f) return 1;
  if (codePoint < 0x10000) return bmpTable()[codePoint] ?? 1;
  if (ZERO_WIDTH.test(String.fromCodePoint(codePoint))) return 0;
  return inRanges(codePoint, WIDE_ASTRAL) ? 2 : 1;
}

/**
 * Total cells `text` occupies in a terminal.
 *
 * Works on a whole string or on a single grapheme cluster, because a cluster's
 * width IS the sum of its code points — there is no separate "grapheme width"
 * rule, and the function that used to claim otherwise is gone. Segmentation is
 * a partition of the string, so summing per cluster and summing per code point
 * are the same number; `tests/unit/cell-width.test.mts` asserts that over the
 * corpus rather than leaving it as an argument.
 */
export function displayWidth(text: string): number {
  let total = 0;
  for (const character of text) total += cellWidthOfCodePoint(character.codePointAt(0) ?? 0);
  return total;
}
