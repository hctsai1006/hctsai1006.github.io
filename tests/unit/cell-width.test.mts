/**
 * cell-width.test.mts — the gate on `src/line-editor/cells.ts`.
 *
 * WHAT THIS EXISTS TO CATCH. There were two width implementations, they
 * disagreed on 914 code points, and the worst of the disagreements had
 * ZERO test coverage in either direction: `src/formatting/width.ts` counted all
 * 448 code points of U+2600–U+27BF as double-width, and deleting that entire
 * range from its table killed no test at all. Only 60 of those 448 are Wide.
 * `✓ ✗ ★ ☐` — the entire vocabulary of a status column — are not among them,
 * so every table with a status column was over-padded by one cell per row.
 *
 * So the range is now pinned FROM BOTH SIDES. Deleting it fails
 * `the 60 wide code points of U+2600-U+27BF`; widening it to the whole block
 * fails `the 388 narrow ones`. Neither mistake can pass again.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE GROUND TRUTH, and how far it actually goes.
 *
 * `Intl.Segmenter` is not involved: cell width is a sum over code points, so
 * segmentation cannot influence the answer. The truth used here is the Unicode
 * Character Database itself, checked in under `fixtures/` as VERBATIM line
 * subsets of the official files — original header lines kept, so the version,
 * the date and the copyright travel with the data, and `grep` reproduces them
 * byte for byte from unicode.org. `\p{East_Asian_Width=Wide}` is not a
 * JavaScript property escape (it is a SyntaxError, not a silent mismatch),
 * which is why the property has to arrive as data at all.
 *
 * The fixtures are parsed HERE, by a parser written here, and compared against
 * the module across every one of the 1 114 112 code points. That proves the
 * generated table faithfully encodes East_Asian_Width and Hangul_Syllable_Type
 * and that nobody hand-edited an entry.
 *
 * WHAT IT DOES NOT PROVE, said plainly: this and `tools/generate-width-table.mts`
 * read the same fixtures, so a sweep alone cannot tell you the RULES are right —
 * only that the data survived the trip. The rules are pinned separately, by the
 * corpus below, whose expected values are written out by hand and are checkable
 * against any terminal you like.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cellWidthOfCodePoint, displayWidth } from '../../src/line-editor/cells.ts';
import { segmentGraphemes } from '../../src/line-editor/graphemes.ts';
import { cellWidthOf, displayWidth as metricsWidth } from '../../src/line-editor/metrics.ts';
import { displayWidth as formattingWidth, truncateToWidth } from '../../src/formatting/width.ts';
import { renderDocument } from '../../src/formatting/views.ts';
import { buildDefaultDocument } from '../../src/commands/format/build.ts';
import { DEFAULT_CULTURE } from '../../src/formatting/culture.ts';
import { psObject } from '../../src/pipeline/psobject.ts';
import type { PSValue } from '../../src/pipeline/psobject.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const MAX_CODE_POINT = 0x10ffff;

// ---------------------------------------------------------------------------
// ground truth, parsed here rather than imported
// ---------------------------------------------------------------------------

/** `RANGE ; VALUE # comment` — the shape every UCD data file shares. */
function ucdRanges(file: string, wanted: ReadonlySet<string>): [number, number][] {
  const out: [number, number][] = [];
  for (const raw of readFileSync(join(FIXTURES, file), 'utf8').split('\n')) {
    const line = (raw.split('#')[0] ?? '').trim();
    if (line === '') continue;
    const [cps = '', value = ''] = line.split(';').map((part) => part.trim());
    if (!wanted.has(value)) continue;
    const [lo = '', hi = lo] = cps.split('..');
    out.push([Number.parseInt(lo, 16), Number.parseInt(hi, 16)]);
  }
  assert.ok(out.length > 0, `${file} yielded no ${[...wanted].join('/')} ranges`);
  return out;
}

/** The version stamped in a fixture's retained UCD header. */
function ucdVersion(file: string): string {
  const first = readFileSync(join(FIXTURES, file), 'utf8').split('\n')[0] ?? '';
  const match = /-(\d+\.\d+\.\d+)\.txt/.exec(first);
  assert.ok(match, `${file} has no version in its first line: ${first}`);
  return match[1] ?? '';
}

const truth = new Uint8Array(MAX_CODE_POINT + 1).fill(1);
{
  truth.fill(0, 0x00, 0x20);
  truth.fill(0, 0x7f, 0xa0);
  for (const [lo, hi] of ucdRanges('EastAsianWidth-16.0.0.W-F.txt', new Set(['W', 'F']))) {
    truth.fill(2, lo, hi + 1);
  }
  // After the wide fill: a mark that is also Wide is still a mark.
  const zero = /^[\p{Mn}\p{Me}\p{Cf}]$/u;
  for (let cp = 0xa0; cp <= MAX_CODE_POINT; cp += 1) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    if (zero.test(String.fromCodePoint(cp))) truth[cp] = 0;
  }
  for (const [lo, hi] of ucdRanges('HangulSyllableType-16.0.0.V-T.txt', new Set(['V', 'T']))) {
    truth.fill(0, lo, hi + 1);
  }
  truth[0xad] = 1; // SOFT HYPHEN: Cf, but a terminal prints it
}

// ---------------------------------------------------------------------------
// the corpus
// ---------------------------------------------------------------------------

/**
 * Named spans covering every script and mechanism that has ever broken a
 * column. Ranges rather than single characters on purpose: a bug in a width
 * table is almost never one code point, it is a boundary off by a block.
 */
const CORPUS: ReadonlyArray<readonly [string, number, number]> = [
  ['ASCII printable', 0x0020, 0x007e],
  ['C0 controls', 0x0000, 0x001f],
  ['DEL and C1', 0x007f, 0x009f],
  ['Latin-1 supplement', 0x00a0, 0x00ff],
  ['Latin Extended-A', 0x0100, 0x017f],
  ['combining diacriticals', 0x0300, 0x036f],
  ['Greek', 0x0370, 0x03ff],
  ['Cyrillic', 0x0400, 0x045f],
  ['Hebrew incl. points', 0x0590, 0x05f4],
  ['Arabic incl. harakat', 0x0600, 0x06ff],
  ['Devanagari', 0x0900, 0x097f],
  ['Thai', 0x0e00, 0x0e5b],
  ['Hangul Jamo L, V, T', 0x1100, 0x11ff],
  ['general punctuation incl. ZWJ', 0x2000, 0x206f],
  ['combining marks for symbols', 0x20d0, 0x20f0],
  ['letterlike and arrows', 0x2100, 0x21ff],
  ['misc technical', 0x2300, 0x23ff],
  ['box drawing and blocks', 0x2500, 0x259f],
  ['misc symbols and dingbats', 0x2600, 0x27bf],
  ['braille', 0x2800, 0x28ff],
  ['CJK radicals', 0x2e80, 0x2eff],
  ['CJK symbols and kana', 0x3000, 0x30ff],
  ['CJK unified ideographs (head)', 0x4e00, 0x4eff],
  ['Yijing hexagrams', 0x4dc0, 0x4dff],
  ['Hangul Jamo Extended-A', 0xa960, 0xa97f],
  ['Hangul syllables (head)', 0xac00, 0xacff],
  ['Hangul Jamo Extended-B', 0xd7b0, 0xd7fb],
  ['CJK compatibility ideographs', 0xf900, 0xf9ff],
  ['variation selectors', 0xfe00, 0xfe0f],
  ['fullwidth forms', 0xff01, 0xff60],
  ['halfwidth forms', 0xff61, 0xffdc],
  ['fullwidth signs', 0xffe0, 0xffe6],
  ['Linear B (astral, narrow)', 0x10000, 0x1000f],
  ['musical symbols incl. combining', 0x1d165, 0x1d18b],
  ['Tangut (astral, wide)', 0x17000, 0x1701f],
  ['regional indicators', 0x1f1e6, 0x1f1ff],
  ['enclosed ideographic supplement', 0x1f200, 0x1f251],
  ['misc symbols and pictographs', 0x1f300, 0x1f3ff],
  ['emoticons', 0x1f600, 0x1f64f],
  ['transport and map', 0x1f680, 0x1f6ff],
  ['supplemental symbols', 0x1f900, 0x1f9ff],
  ['symbols extended-A', 0x1fa70, 0x1faff],
  ['CJK extension B (head)', 0x20000, 0x2000f],
  ['tag characters', 0xe0020, 0xe007f],
  ['variation selectors supplement', 0xe0100, 0xe01ef],
];

const corpusCodePoints = (): number[] => {
  const out: number[] = [];
  for (const [, lo, hi] of CORPUS) for (let cp = lo; cp <= hi; cp += 1) out.push(cp);
  return out;
};

// ---------------------------------------------------------------------------

describe('cell width: the corpus', () => {
  it('spans well over 500 code points across every script that breaks columns', () => {
    const points = corpusCodePoints();
    assert.ok(points.length >= 500, `corpus is ${points.length} code points`);
    assert.equal(new Set(points).size >= 500, true);
    // The categories the brief named, each actually present.
    for (const name of [
      'ASCII printable',
      'Latin-1 supplement',
      'combining diacriticals',
      'Hangul Jamo L, V, T',
      'Hangul syllables (head)',
      'CJK unified ideographs (head)',
      'fullwidth forms',
      'misc symbols and dingbats',
      'emoticons',
      'variation selectors',
      'regional indicators',
      'Thai',
      'Devanagari',
      'Arabic incl. harakat',
    ]) {
      assert.ok(
        CORPUS.some((entry) => entry[0] === name),
        `corpus is missing ${name}`,
      );
    }
  });

  it('agrees with the UCD on every code point in the corpus', () => {
    const wrong: string[] = [];
    for (const cp of corpusCodePoints()) {
      const got = cellWidthOfCodePoint(cp);
      const want = truth[cp];
      if (got !== want) wrong.push(`U+${cp.toString(16).toUpperCase()} got ${got} want ${want}`);
    }
    assert.deepEqual(wrong.slice(0, 20), [], `${wrong.length} corpus disagreements`);
  });

  it('agrees with the UCD on all 1 114 112 code points, not just the corpus', () => {
    let wrong = 0;
    let first = '';
    for (let cp = 0; cp <= MAX_CODE_POINT; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue; // surrogates are not characters
      if (cellWidthOfCodePoint(cp) !== truth[cp]) {
        wrong += 1;
        if (first === '') {
          first = `U+${cp.toString(16).toUpperCase()} got ${cellWidthOfCodePoint(cp)} want ${truth[cp]}`;
        }
      }
    }
    assert.equal(wrong, 0, `${wrong} code points disagree with the UCD, first: ${first}`);
  });

  /**
   * The table is Unicode 16.0.0 because `process.versions.unicode` is 16.0 and
   * the `\p{Mn}` / `\p{Me}` / `\p{Cf}` half of the model comes from the engine.
   * If the engine moves and the fixtures do not, characters assigned after
   * 16.0.0 measure 1 where a current terminal would say 2, silently. Loud is
   * better: refresh the fixtures and re-run the generator.
   */
  it('keeps the checked-in UCD version and the engine s Unicode version in step', () => {
    assert.equal(ucdVersion('EastAsianWidth-16.0.0.W-F.txt'), '16.0.0');
    assert.equal(ucdVersion('HangulSyllableType-16.0.0.V-T.txt'), '16.0.0');
    assert.equal(
      `${process.versions.unicode}.0`,
      '16.0.0',
      'the engine moved past the checked-in UCD extracts; refresh fixtures/ and run ' +
        'node tools/generate-width-table.mts --write',
    );
  });
});

// ---------------------------------------------------------------------------
// the range that had no coverage at all
// ---------------------------------------------------------------------------

describe('U+2600-U+27BF, where the two implementations disagreed on all 448', () => {
  /**
   * Transcribed by hand from EastAsianWidth-16.0.0.txt so that a reviewer can
   * check it against unicode.org without running anything, and so that a bad
   * regeneration cannot quietly agree with itself.
   */
  const WIDE: ReadonlyArray<readonly [number, number]> = [
    [0x2614, 0x2615], [0x2630, 0x2637], [0x2648, 0x2653], [0x267f, 0x267f],
    [0x268a, 0x268f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab],
    [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4],
    [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa],
    [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728],
    [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757],
    [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf],
  ];
  const isWide = (cp: number): boolean => WIDE.some(([lo, hi]) => cp >= lo && cp <= hi);
  const wideCount = WIDE.reduce((n, [lo, hi]) => n + hi - lo + 1, 0);

  it('has exactly 60 wide code points out of 448', () => {
    assert.equal(wideCount, 60);
    let counted = 0;
    for (let cp = 0x2600; cp <= 0x27bf; cp += 1) if (cellWidthOfCodePoint(cp) === 2) counted += 1;
    assert.equal(counted, 60, 'the module disagrees with the hand transcription');
  });

  /** Deleting the range from the table turns these into 1 and fails here. */
  it('the 60 wide code points of U+2600-U+27BF measure 2', () => {
    const wrong: string[] = [];
    for (const [lo, hi] of WIDE) {
      for (let cp = lo; cp <= hi; cp += 1) {
        if (cellWidthOfCodePoint(cp) !== 2) wrong.push(`U+${cp.toString(16).toUpperCase()}`);
      }
    }
    assert.deepEqual(wrong, [], 'wide symbols measuring narrow');
  });

  /** Widening it to the whole block turns these into 2 and fails here. */
  it('the 388 narrow ones measure 1, which is what a status column is made of', () => {
    const wrong: string[] = [];
    for (let cp = 0x2600; cp <= 0x27bf; cp += 1) {
      if (isWide(cp)) continue;
      if (cellWidthOfCodePoint(cp) !== 1) wrong.push(`U+${cp.toString(16).toUpperCase()}`);
    }
    assert.equal(448 - wideCount, 388);
    assert.deepEqual(wrong.slice(0, 20), [], `${wrong.length} narrow symbols measuring wide`);
  });

  it('names the four that broke real tables', () => {
    assert.equal(displayWidth('✓'), 1, 'U+2713 CHECK MARK');
    assert.equal(displayWidth('✗'), 1, 'U+2717 BALLOT X');
    assert.equal(displayWidth('★'), 1, 'U+2605 BLACK STAR');
    assert.equal(displayWidth('☐'), 1, 'U+2610 BALLOT BOX');
    // And the neighbours that really are wide, so the fix is not "all narrow".
    assert.equal(displayWidth('⛅'), 2, 'U+26C5 SUN BEHIND CLOUD');
    assert.equal(displayWidth('✅'), 2, 'U+2705 WHITE HEAVY CHECK MARK');
    assert.equal(displayWidth('❗'), 2, 'U+2757 HEAVY EXCLAMATION MARK');
  });
});

// ---------------------------------------------------------------------------
// the decisions, each one stated and each one pinned
// ---------------------------------------------------------------------------

describe('cell width: the decisions', () => {
  it('counts East Asian Wide and Fullwidth as two', () => {
    assert.equal(displayWidth('中'), 2);
    assert.equal(displayWidth('日本語'), 6);
    assert.equal(displayWidth('ハロー'), 6, 'the string PowerShell #6290 gets wrong');
    assert.equal(displayWidth('Ａ'), 2, 'U+FF21 FULLWIDTH LATIN A');
    assert.equal(displayWidth('A'), 1, 'the halfwidth one is still one');
    assert.equal(displayWidth('ｱ'), 1, 'U+FF71 HALFWIDTH KATAKANA A');
  });

  it('counts combining marks as zero and spacing marks as one', () => {
    assert.equal(displayWidth('́'), 0, 'U+0301 COMBINING ACUTE is Mn');
    assert.equal(displayWidth('é'), 1, 'e plus an accent is one cell');
    assert.equal(displayWidth('⃣'), 0, 'U+20E3 COMBINING KEYCAP is Me');
    // Mc is NOT zero. A Devanagari spacing vowel takes its own cell, and the
    // old implementations zeroed it by testing \p{M} or \p{Mc}.
    assert.equal(displayWidth('ा'), 1, 'U+093E DEVANAGARI SIGN AA is Mc');
    assert.equal(displayWidth('े'), 0, 'U+0947 DEVANAGARI SIGN E is Mn');
    assert.equal(displayWidth('ั'), 0, 'U+0E31 THAI MAI HAN AKAT is Mn');
    assert.equal(displayWidth('กั'), 1, 'a Thai syllable with a vowel above');
    assert.equal(displayWidth('وَ'), 1, 'Arabic waw with fatha');
  });

  it('counts control characters as zero', () => {
    for (const cp of [0x00, 0x07, 0x1b, 0x7f, 0x85, 0x9f]) {
      assert.equal(cellWidthOfCodePoint(cp), 0, `U+${cp.toString(16)}`);
    }
    assert.equal(displayWidth('[31m'), 4, 'ESC is free, the CSI body is not');
  });

  /**
   * DECISION: a variation selector is zero, not two.
   *
   * U+FE0F requests emoji presentation, so "VS16 means two cells" is a
   * defensible reading of UTS #51 — but it is not what a cell terminal does.
   * U+FE00–FE0F are `Mn`; xterm.js gives them width 0 and folds them into the
   * preceding cell, so `✓` + VS16 advances the cursor ONE column even where the
   * font paints a wide colour glyph. The measured behaviour wins over the
   * plausible reading, and it falls out of the `\p{Mn}` rule with no special
   * case, which is why there is nothing here to keep in sync.
   */
  it('gives both variation selectors zero, so VS16 does not widen its base', () => {
    assert.equal(displayWidth('️'), 0, 'VS16 alone');
    assert.equal(displayWidth('︎'), 0, 'VS15 alone');
    assert.equal(displayWidth('✓️'), 1, 'VS16 does not promote a narrow base');
    assert.equal(displayWidth('✓︎'), 1, 'VS15 leaves it narrow');
    assert.equal(displayWidth('❤️'), 1, 'U+2764 is Neutral even with VS16');
    assert.equal(displayWidth('☀︎'), 1, 'text presentation of the sun');
  });

  /**
   * DECISION: a ZWJ sequence is the sum of its parts.
   *
   * A terminal without grapheme shaping writes each emoji into its own pair of
   * cells and the joiners into none. Eight is what the grid spends on the
   * family; the old answer of 2 made the editor believe the line was six cells
   * shorter than it was drawn.
   */
  it('counts a ZWJ sequence as the sum of its parts', () => {
    assert.equal(displayWidth('‍'), 0, 'ZWJ is Cf');
    assert.equal(displayWidth('\u{1f468}‍\u{1f469}‍\u{1f467}‍\u{1f466}'), 8);
    assert.equal(displayWidth('\u{1f469}‍\u{1f4bb}'), 4, 'woman technologist');
    // Skin tone modifiers are Wide in their own right, so they DO cost cells.
    assert.equal(displayWidth('\u{1f44d}\u{1f3fd}'), 4, 'thumbs up plus modifier');
  });

  /**
   * DECISION: a flag is two cells, arrived at honestly.
   *
   * Not because a flag "looks like" two columns, but because U+1F1E6–1F1FF is
   * East_Asian_Width Neutral — regional indicators are not Wide — so each is
   * one cell and a pair is two. A four-indicator run is four cells, which is
   * also what a terminal draws when it cannot pair them.
   */
  it('counts a regional indicator pair as two, per indicator not per flag', () => {
    assert.equal(cellWidthOfCodePoint(0x1f1e6), 1, 'a lone regional indicator');
    assert.equal(displayWidth('\u{1f1f9}\u{1f1fc}'), 2, 'one flag');
    assert.equal(displayWidth('\u{1f1f9}\u{1f1fc}\u{1f1ef}\u{1f1f5}'), 4, 'two flags');
  });

  it('counts a keycap as one cell', () => {
    assert.equal(displayWidth('1️⃣'), 1, 'digit + VS16 + COMBINING KEYCAP');
    assert.equal(displayWidth('#️⃣'), 1);
  });

  /**
   * DECISION: conjoining jamo V and T are zero.
   *
   * The one case a property escape cannot reach — jamo are `Lo`, not marks — so
   * Hangul_Syllable_Type is generated alongside East_Asian_Width. Without it a
   * decomposed syllable measures 4 where the composed one measures 2 and every
   * Korean column drifts by the number of syllables in it.
   */
  it('measures a decomposed Hangul syllable the same as a composed one', () => {
    assert.equal(displayWidth('한'), 2, 'U+D55C, precomposed');
    assert.equal(displayWidth('한'), 2, 'the same syllable as L + V + T');
    assert.equal(displayWidth('ᄒ'), 2, 'the leading consonant carries the width');
    assert.equal(displayWidth('ᅡ'), 0, 'the vowel composes into it');
    assert.equal(displayWidth('ᆫ'), 0, 'so does the trailing consonant');
    // Jamo Extended-B, which xterm.js's own table misses because Kuhn's wcwidth
    // predates the block. Being consistent beats being bug-compatible.
    assert.equal(displayWidth('ힰ'), 0, 'U+D7B0, a Jamo Extended-B vowel');
    assert.equal(displayWidth('ퟋ'), 0, 'U+D7CB, a Jamo Extended-B trailing');
    assert.equal(displayWidth('ꥠ'), 2, 'U+A960 is a LEADING jamo, and Wide');
  });

  it('keeps SOFT HYPHEN at one, the documented exception to the Cf rule', () => {
    assert.equal(displayWidth('­'), 1);
    assert.equal(displayWidth('​'), 0, 'ZERO WIDTH SPACE is not an exception');
    assert.equal(displayWidth('﻿'), 0, 'nor is the BOM');
    assert.equal(displayWidth('‎'), 0, 'nor LEFT-TO-RIGHT MARK');
  });

  it('counts astral non-emoji correctly, which is where v1 s table started', () => {
    assert.equal(displayWidth('\u{10000}'), 1, 'Linear B is astral and narrow');
    assert.equal(displayWidth('\u{20000}'), 2, 'CJK extension B is astral and wide');
    assert.equal(displayWidth('\u{1f389}'), 2, 'U+1F389 PARTY POPPER, the v1 bug');
    assert.equal(displayWidth('\u{1d167}'), 0, 'a combining musical symbol');
    assert.equal(displayWidth('\u{e0041}'), 0, 'a tag character');
  });
});

// ---------------------------------------------------------------------------
// one implementation, provably
// ---------------------------------------------------------------------------

describe('one implementation', () => {
  const SAMPLES = [
    '',
    'plain ascii',
    '測試 mixed 中文',
    'ハロー',
    '한글 한',
    '✓ ok  ✗ fail  ★ star  ☐ todo',
    '⛅ ✅ ❗',
    'é café',
    'กัน स्त्री',
    'وَلَد',
    '\u{1f468}‍\u{1f469}‍\u{1f467}‍\u{1f466}',
    '\u{1f1f9}\u{1f1fc} flag',
    '1️⃣ 2️⃣',
    '✓️ vs ✓︎',
    '\u{1f44d}\u{1f3fd}',
    'ＡＢＣ ｱｲｳ',
    '\u{20000}\u{10000}',
  ];

  /**
   * The whole point of the change. `render.ts` and `editor.ts` used to reach
   * different numbers for the same string; now there is one function and three
   * names for it, and this asserts they cannot come apart again.
   */
  it('renderer and line editor answer identically, on every sample', () => {
    for (const text of SAMPLES) {
      const base = displayWidth(text);
      assert.equal(formattingWidth(text), base, `formatting/width.ts on ${JSON.stringify(text)}`);
      assert.equal(metricsWidth(text), base, `line-editor/metrics.ts on ${JSON.stringify(text)}`);
      assert.equal(
        segmentGraphemes(text).reduce((n, g) => n + cellWidthOf(g), 0),
        base,
        `per-cluster walk on ${JSON.stringify(text)}`,
      );
    }
  });

  /**
   * The invariant that lets the editor keep walking clusters while the model
   * counts code points: segmentation is a partition, so the two sums are the
   * same number. Asserted rather than argued.
   */
  it('summing per cluster equals summing per code point, over the whole corpus', () => {
    const text = corpusCodePoints()
      .filter((cp) => cp > 0x20 && !(cp >= 0x7f && cp <= 0x9f))
      .map((cp) => String.fromCodePoint(cp))
      .join('');
    const byCluster = segmentGraphemes(text).reduce((n, g) => n + displayWidth(g), 0);
    assert.equal(byCluster, displayWidth(text));
    assert.ok(byCluster > 500, `only ${byCluster} cells measured`);
  });

  it('truncates on a cluster boundary while budgeting per cell', () => {
    // A ZWJ family costs 8, so it does not fit in a 6-cell budget even though
    // it is a single cluster. The budget is left unspent rather than half-cut.
    const family = '\u{1f468}‍\u{1f469}‍\u{1f467}‍\u{1f466}';
    assert.equal(truncateToWidth(`ab${family}`, 6), 'ab…');
    assert.equal(truncateToWidth('一二三四五六七八九十', 12), '一二三四五…');
    assert.equal(displayWidth(truncateToWidth('一二三四五六七八九十', 12)), 11);
  });
});

// ---------------------------------------------------------------------------
// the thing a user actually sees
// ---------------------------------------------------------------------------

describe('a status column lines up', () => {
  const o = (bag: Record<string, PSValue>): PSValue => psObject(bag);
  const table = (values: readonly PSValue[], width: number): string =>
    renderDocument(buildDefaultDocument(values, DEFAULT_CULTURE), {
      width,
      culture: DEFAULT_CULTURE,
    }).join('\n');

  /**
   * The regression, rendered. Under the old model each of `✓ ✗ ★ ☐` was
   * budgeted two cells and drawn in one, so every row after the header lost a
   * column of alignment — the defect that had no test.
   */
  it('renders check, cross, star and box in a one-cell column', () => {
    assert.equal(
      table(
        [
          o({ Status: '✓', Name: 'build' }),
          o({ Status: '✗', Name: 'test' }),
          o({ Status: '★', Name: 'lint' }),
          o({ Status: '☐', Name: 'docs' }),
        ],
        40,
      ),
      `
Status Name
------ ----
✓      build
✗      test
★      lint
☐      docs
`,
    );
  });

  it('still lines up when a genuinely wide symbol shares the column', () => {
    assert.equal(
      table([o({ S: '✓', N: 'narrow' }), o({ S: '✅', N: 'wide' })], 40),
      `
S  N
-  -
✓  narrow
✅ wide
`,
    );
  });
});
