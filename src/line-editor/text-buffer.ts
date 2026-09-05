/**
 * text-buffer.ts — the line being edited, as a value.
 *
 * In v1 the `<textarea>` WAS the buffer: `edit.value` and `edit.selectionStart`
 * were the model, and the browser silently supplied the hard part — it never let
 * the caret land inside a surrogate pair or between a base character and its
 * combining mark. Take the textarea away and that guarantee goes with it, so it
 * has to be re-stated here: every offset this class produces sits on a grapheme
 * boundary (see graphemes.ts).
 *
 * Offsets stay UTF-16 code units, matching what v1's arithmetic assumed, so a
 * render adapter can still `slice(0, caret)` and a textarea adapter can still
 * hand `selectionStart` straight in.
 *
 * The buffer is IMMUTABLE. That is not decoration: the completion menu has to
 * stash the pre-menu line and restore it on Escape, and history navigation has
 * to stash the in-progress draft. v1 did that by copying strings into ad-hoc
 * `orig`/`origCaret`/`draft` variables, one of which (`draft`) is never cleared
 * on the typing path and goes stale. A value type makes "remember this state"
 * the same operation as "hold a reference".
 *
 * Every mutator returns `this` unchanged when the operation is a no-op, so a
 * caller can tell "nothing happened" by identity and ring the bell.
 */

import {
  floorBoundaryIndex,
  graphemeBoundaries,
  graphemeLength,
  segmentGraphemes,
  snapWithin,
} from './graphemes.ts';

/**
 * PSReadLine's default `WordDelimiters`, verbatim, including the three dashes.
 *
 * Note that `-` is a delimiter, so word-left from the end of `Get-ChildItem`
 * stops at `ChildItem`. That is deliberate and matches PSReadLine; it is also
 * what makes word motion useful on `Verb-Noun` names, which is most of what gets
 * typed here. bash's `unix-word-rubout` (whitespace only) is available by
 * building a buffer with `withWordDelimiters('')`.
 */
export const DEFAULT_WORD_DELIMITERS = ";:,.[]{}()/\\|^&*-=+'\"–—―";

/** What a grapheme counts as when deciding where a word starts and ends. */
export type CharClass = 'whitespace' | 'delimiter' | 'word';

/** Classification is by the cluster's BASE character; marks never change it. */
function classify(grapheme: string, delimiters: string): CharClass {
  const first = String.fromCodePoint(grapheme.codePointAt(0) ?? 0);
  if (/\s/u.test(first)) return 'whitespace';
  if (first.length === 1 && delimiters.includes(first)) return 'delimiter';
  return 'word';
}

export class TextBuffer {
  readonly text: string;
  /** UTF-16 code-unit offset. Invariant: always a grapheme boundary. */
  readonly caret: number;
  readonly wordDelimiters: string;

  /** Boundary table, built once per buffer instead of once per motion. */
  #boundaries: readonly number[] | null = null;
  #graphemes: readonly string[] | null = null;

  private constructor(text: string, caret: number, wordDelimiters: string) {
    this.text = text;
    this.caret = caret;
    this.wordDelimiters = wordDelimiters;
  }

  static empty(wordDelimiters: string = DEFAULT_WORD_DELIMITERS): TextBuffer {
    return new TextBuffer('', 0, wordDelimiters);
  }

  /** `caret` defaults to the end of `text` and is snapped onto a boundary. */
  static of(
    text: string,
    caret?: number,
    wordDelimiters: string = DEFAULT_WORD_DELIMITERS,
  ): TextBuffer {
    const raw = caret ?? text.length;
    return new TextBuffer(
      text,
      snapWithin(graphemeBoundaries(text), raw, 'backward'),
      wordDelimiters,
    );
  }

  get boundaries(): readonly number[] {
    this.#boundaries ??= graphemeBoundaries(this.text);
    return this.#boundaries;
  }

  get graphemes(): readonly string[] {
    this.#graphemes ??= segmentGraphemes(this.text);
    return this.#graphemes;
  }

  get isEmpty(): boolean {
    return this.text.length === 0;
  }

  /** Visible character count — not `text.length`, which counts code units. */
  get graphemeCount(): number {
    return this.graphemes.length;
  }

  /** How many visible characters precede the caret. The caret's column. */
  get caretGraphemeIndex(): number {
    return this.boundaryIndexOf(this.caret);
  }

  get before(): string {
    return this.text.slice(0, this.caret);
  }

  get after(): string {
    return this.text.slice(this.caret);
  }

  get atStart(): boolean {
    return this.caret === 0;
  }

  get atEnd(): boolean {
    return this.caret === this.text.length;
  }

  slice(start: number, end: number): string {
    return this.text.slice(start, end);
  }

  // --------------------------------------------------------------- rebuilding

  withCaret(offset: number): TextBuffer {
    const snapped = snapWithin(this.boundaries, offset, 'backward');
    return snapped === this.caret ? this : new TextBuffer(this.text, snapped, this.wordDelimiters);
  }

  withWordDelimiters(delimiters: string): TextBuffer {
    return delimiters === this.wordDelimiters
      ? this
      : new TextBuffer(this.text, this.caret, delimiters);
  }

  /** Whole-line replacement, as history recall and prediction-accept do. */
  replace(text: string, caret?: number): TextBuffer {
    const target = caret ?? text.length;
    if (text === this.text) return this.withCaret(target);
    return TextBuffer.of(text, target, this.wordDelimiters);
  }

  // ----------------------------------------------------------------- mutation

  insert(insertion: string): TextBuffer {
    if (insertion === '') return this;
    const text = this.before + insertion + this.after;
    const at = this.caret + insertion.length;
    // Snap FORWARD here: if the inserted tail combines with the text that was
    // already to the right (a combining mark typed against a following base
    // character), the naive offset lands inside the cluster it just created.
    const boundaries = graphemeBoundaries(text);
    return new TextBuffer(text, snapWithin(boundaries, at, 'forward'), this.wordDelimiters);
  }

  /** Delete `[start, end)`, then park the caret at `start`. */
  deleteRange(start: number, end: number): TextBuffer {
    const lo = snapWithin(this.boundaries, Math.min(start, end), 'backward');
    const hi = snapWithin(this.boundaries, Math.max(start, end), 'forward');
    if (lo === hi) return this;
    return TextBuffer.of(this.text.slice(0, lo) + this.text.slice(hi), lo, this.wordDelimiters);
  }

  /** Backspace: removes one whole grapheme, family emoji included. */
  deleteBackward(): TextBuffer {
    return this.deleteRange(this.offsetLeft(), this.caret);
  }

  /** Delete key. */
  deleteForward(): TextBuffer {
    return this.deleteRange(this.caret, this.offsetRight());
  }

  deleteWordLeft(): TextBuffer {
    return this.deleteRange(this.offsetWordLeft(), this.caret);
  }

  deleteWordRight(): TextBuffer {
    return this.deleteRange(this.caret, this.offsetWordRight());
  }

  /** Ctrl+K. */
  deleteToLineEnd(): TextBuffer {
    return this.deleteRange(this.caret, this.offsetLineEnd());
  }

  /** Ctrl+U. */
  deleteToLineStart(): TextBuffer {
    return this.deleteRange(this.offsetLineStart(), this.caret);
  }

  // ------------------------------------------------------------------ motions

  moveLeft(): TextBuffer {
    return this.withCaret(this.offsetLeft());
  }

  moveRight(): TextBuffer {
    return this.withCaret(this.offsetRight());
  }

  moveWordLeft(): TextBuffer {
    return this.withCaret(this.offsetWordLeft());
  }

  moveWordRight(): TextBuffer {
    return this.withCaret(this.offsetWordRight());
  }

  moveToLineStart(): TextBuffer {
    return this.withCaret(this.offsetLineStart());
  }

  moveToLineEnd(): TextBuffer {
    return this.withCaret(this.offsetLineEnd());
  }

  // ------------------------------------------------------- offset computation
  // Public because the kill commands must know what they are about to remove
  // before removing it, so the caller can put it on the kill ring.

  offsetLeft(): number {
    const i = this.boundaryIndexOf(this.caret);
    return i === 0 ? 0 : (this.boundaries[i - 1] ?? 0);
  }

  offsetRight(): number {
    const i = this.boundaryIndexOf(this.caret);
    return this.boundaries[i + 1] ?? this.text.length;
  }

  /**
   * Emacs `backward-word`: skip anything non-word, then skip the word itself.
   * Pressed repeatedly it walks word starts instead of stalling on punctuation.
   */
  offsetWordLeft(): number {
    let i = this.boundaryIndexOf(this.caret);
    while (i > 0 && this.classAt(i - 1) !== 'word') i -= 1;
    while (i > 0 && this.classAt(i - 1) === 'word') i -= 1;
    return this.boundaries[i] ?? 0;
  }

  /** Emacs `forward-word`: lands AFTER the end of the next word, not on it. */
  offsetWordRight(): number {
    const last = this.graphemes.length;
    let i = this.boundaryIndexOf(this.caret);
    while (i < last && this.classAt(i) !== 'word') i += 1;
    while (i < last && this.classAt(i) === 'word') i += 1;
    return this.boundaries[i] ?? this.text.length;
  }

  /**
   * Start of the current LOGICAL line. PowerShell input goes multi-line whenever
   * a block opens, so a Home that jumped to offset 0 would be wrong there; v1
   * never had to decide because the browser owned Home.
   */
  offsetLineStart(): number {
    const nl = this.text.lastIndexOf('\n', this.caret - 1);
    return nl < 0 ? 0 : nl + 1;
  }

  offsetLineEnd(): number {
    const nl = this.text.indexOf('\n', this.caret);
    return nl < 0 ? this.text.length : nl;
  }

  /** Index into `boundaries` of the largest boundary that is <= `offset`. */
  boundaryIndexOf(offset: number): number {
    return floorBoundaryIndex(this.boundaries, offset);
  }

  private classAt(graphemeIndex: number): CharClass {
    return classify(this.graphemes[graphemeIndex] ?? '', this.wordDelimiters);
  }
}

/** Classify without a buffer to hand. */
export function charClassOf(
  grapheme: string,
  delimiters: string = DEFAULT_WORD_DELIMITERS,
): CharClass {
  return classify(grapheme, delimiters);
}

/** Visible length of a string, for callers that have no buffer to hand. */
export const visibleLength = graphemeLength;
