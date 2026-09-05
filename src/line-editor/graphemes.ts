/**
 * graphemes.ts — caret arithmetic in units the user can see.
 *
 * The v1 terminal moved its caret by UTF-16 code unit. That is invisible for
 * ASCII and wrong for everything this page actually receives: an emoji is two
 * code units, a family emoji is eleven, and `e` + U+0301 is two code units that
 * render as one mark on screen. Pressing Left once and landing between a
 * surrogate pair produces a caret that cannot be rendered and a Backspace that
 * mints a lone surrogate.
 *
 * So the whole editor treats a GRAPHEME CLUSTER as the atom. Offsets stay as
 * UTF-16 code-unit indices — a renderer needs `slice(0, caret)` and JS strings
 * are UTF-16, so converting at the boundary would just move the bug — but every
 * offset the editor produces is guaranteed to sit on a cluster boundary.
 *
 * `Intl.Segmenter` is the correct implementation and is present in Node 18+ and
 * every browser this project targets. The fallback exists because the caret
 * must never split a surrogate pair, and a silent absence of Intl would do
 * exactly that; it is deliberately smaller than UAX #29 and only covers the
 * clusters a command line realistically contains.
 */

/** Locale is irrelevant for grapheme granularity; UAX #29 rules are not tailored. */
const SEGMENTER_LOCALE = 'en';

let cached: Intl.Segmenter | null | undefined;

function grapheneSegmenter(): Intl.Segmenter | null {
  if (cached === undefined) {
    cached =
      typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter(SEGMENTER_LOCALE, { granularity: 'grapheme' })
        : null;
  }
  return cached;
}

/** True when this environment has ECMA-402 segmentation, i.e. the accurate path. */
export function hasIntlSegmenter(): boolean {
  return grapheneSegmenter() !== null;
}

const ZWJ = 0x200d;
const CR = 0x000d;
const LF = 0x000a;
const COMBINING_ENCLOSING_KEYCAP = 0x20e3;
const VARIATION_SELECTOR_15 = 0xfe0e;
const VARIATION_SELECTOR_16 = 0xfe0f;

const MARK = /\p{M}/u;

const isRegionalIndicator = (cp: number): boolean => cp >= 0x1f1e6 && cp <= 0x1f1ff;
const isSkinToneModifier = (cp: number): boolean => cp >= 0x1f3fb && cp <= 0x1f3ff;
/** Used by subdivision flags such as the England flag. */
const isTagCharacter = (cp: number): boolean => cp >= 0xe0020 && cp <= 0xe007f;

function isExtending(cp: number): boolean {
  if (
    cp === COMBINING_ENCLOSING_KEYCAP ||
    cp === VARIATION_SELECTOR_15 ||
    cp === VARIATION_SELECTOR_16
  ) {
    return true;
  }
  if (isSkinToneModifier(cp) || isTagCharacter(cp)) return true;
  return MARK.test(String.fromCodePoint(cp));
}

/**
 * A reduced UAX #29 for environments without `Intl.Segmenter`.
 *
 * Exported so the tests can exercise it directly: on a machine that has
 * `Intl.Segmenter` this branch would otherwise be dead code that only runs on
 * the machines nobody tests on.
 */
export function segmentGraphemesFallback(text: string): string[] {
  const out: string[] = [];
  const len = text.length;
  let i = 0;

  while (i < len) {
    const start = i;
    const first = text.codePointAt(i);
    if (first === undefined) break;
    i += first > 0xffff ? 2 : 1;

    // CRLF is one cluster; splitting it would let Backspace strip the LF alone.
    if (first === CR && text.codePointAt(i) === LF) {
      out.push(text.slice(start, i + 1));
      i += 1;
      continue;
    }

    if (isRegionalIndicator(first)) {
      const second = text.codePointAt(i);
      if (second !== undefined && isRegionalIndicator(second)) i += 2;
    }

    for (;;) {
      const next = text.codePointAt(i);
      if (next === undefined) break;
      if (isExtending(next)) {
        i += next > 0xffff ? 2 : 1;
        continue;
      }
      if (next === ZWJ) {
        i += 1;
        const joined = text.codePointAt(i);
        // A trailing ZWJ joins nothing, but it still belongs to this cluster.
        if (joined !== undefined) i += joined > 0xffff ? 2 : 1;
        continue;
      }
      break;
    }

    out.push(text.slice(start, i));
  }

  return out;
}

/** The visible characters of `text`, in order. */
export function segmentGraphemes(text: string): string[] {
  if (text === '') return [];
  const seg = grapheneSegmenter();
  if (seg === null) return segmentGraphemesFallback(text);
  const out: string[] = [];
  for (const part of seg.segment(text)) out.push(part.segment);
  return out;
}

/**
 * Every legal caret position, as code-unit offsets, ascending.
 * Always starts with 0 and ends with `text.length`, so it is never empty.
 */
export function graphemeBoundaries(text: string): number[] {
  const out: number[] = [0];
  let at = 0;
  for (const g of segmentGraphemes(text)) {
    at += g.length;
    out.push(at);
  }
  return out;
}

/** How many visible characters `text` contains. */
export function graphemeLength(text: string): number {
  return segmentGraphemes(text).length;
}

/** Index into `boundaries` of the largest boundary that is <= `offset`. */
export function floorBoundaryIndex(boundaries: readonly number[], offset: number): number {
  let lo = 0;
  let hi = boundaries.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const at = boundaries[mid];
    if (at !== undefined && at <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Move `offset` onto the nearest legal caret position.
 *
 * `direction` decides which way a caret that landed mid-cluster is nudged.
 * Clamping outward ('forward') is right for an insertion point that arrived
 * from a text replacement; 'backward' is right for a caret restored from a
 * saved position, which should never appear to have advanced.
 */
export function snapToBoundary(
  text: string,
  offset: number,
  direction: 'forward' | 'backward' = 'backward',
): number {
  if (offset <= 0) return 0;
  if (offset >= text.length) return text.length;
  const boundaries = graphemeBoundaries(text);
  return snapWithin(boundaries, offset, direction);
}

/** `snapToBoundary` against an already-computed boundary table. */
export function snapWithin(
  boundaries: readonly number[],
  offset: number,
  direction: 'forward' | 'backward' = 'backward',
): number {
  const last = boundaries[boundaries.length - 1] ?? 0;
  if (offset <= 0) return 0;
  if (offset >= last) return last;
  const i = floorBoundaryIndex(boundaries, offset);
  const at = boundaries[i] ?? 0;
  if (at === offset) return offset;
  return direction === 'backward' ? at : (boundaries[i + 1] ?? last);
}

/** The next caret position after `offset`, or `offset` if already at the end. */
export function nextBoundary(text: string, offset: number): number {
  const boundaries = graphemeBoundaries(text);
  const snapped = snapWithin(boundaries, offset, 'backward');
  const i = floorBoundaryIndex(boundaries, snapped);
  return boundaries[i + 1] ?? snapped;
}

/** The previous caret position before `offset`, or `offset` if already at 0. */
export function prevBoundary(text: string, offset: number): number {
  const boundaries = graphemeBoundaries(text);
  const snapped = snapWithin(boundaries, offset, 'forward');
  const i = floorBoundaryIndex(boundaries, snapped);
  return i === 0 ? 0 : (boundaries[i - 1] ?? 0);
}

/** How many visible characters precede `offset`. This is the caret's column. */
export function graphemeIndexAt(text: string, offset: number): number {
  const boundaries = graphemeBoundaries(text);
  return floorBoundaryIndex(boundaries, snapWithin(boundaries, offset, 'backward'));
}
