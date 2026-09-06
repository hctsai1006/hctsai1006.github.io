/**
 * grid.ts — where characters land, in cells, for both renderers.
 *
 * WHY BOTH RENDERERS SHARE THIS. PR-16's acceptance condition is "CJK and emoji
 * align in both renderers". That can be asserted after the fact, or it can be
 * made true by construction; this file is the second. The semantic DOM renderer
 * builds its rows from this grid, and the xterm adapter hands xterm.js a Unicode
 * provider backed by the same `cellWidthOfCodePoint` this file uses. Neither
 * renderer owns a width answer, so neither can drift from the other.
 *
 * THE MODEL IS xterm.js's, DELIBERATELY. `src/line-editor/cells.ts` carries the
 * evidence: swept over all 1 114 112 code points, its table and xterm.js's
 * UnicodeV11 provider differ on 1114, every one of them Unicode version drift.
 * The two rules that matter here, and that a DOM renderer would not invent:
 *
 *   A zero-width code point joins the PRECEDING cell rather than taking one.
 *   That is xterm's `charProperties(codepoint, preceding)`, and it is why
 *   `e` + U+0301 is one cell and 👨‍👩‍👧‍👦 is eight — the ZWJs are free and the
 *   four people are two cells each.
 *
 *   A wide code point takes TWO cells, the second of which holds nothing. It is
 *   not a space: a space is a character somebody wrote, and the right half of 中
 *   is not. `runsOf` below relies on the difference to reconstruct the text.
 *
 * WHAT THIS IS NOT. It is not a screen. There is no cursor row, no scroll
 * region, no addressable grid — a log renderer appends rows and never goes back
 * up, which is what makes its output readable by a screen reader in the first
 * place. Sequences that need a screen are RECORDED as unsupported rather than
 * approximated, because an approximated cursor move puts text in the wrong
 * place silently, and the recorded list is how a host knows to offer the xterm
 * renderer instead. That list is the concrete form of "ANSI is for TUI
 * fidelity": it names what the semantic renderer cannot do.
 *
 * WHAT IT ALSO IS NOT: a wrapper. Nothing here breaks a long line. `Out-String`
 * already wrapped to its `-Width`, and v1's `.row` is `white-space:pre-wrap`,
 * so the browser soft-wraps whatever is left. Hard-wrapping here would split one
 * logical row into several `.row` elements and change how many separate
 * announcements a screen reader makes for one line of output — which is exactly
 * what task 16.4 forbids. So the grid is as wide as its content.
 */

import { cellWidthOfCodePoint } from '../line-editor/cells.ts';
import {
  applySgr,
  DEFAULT_STYLE,
  OMITTED,
  styleEquals,
  type AnsiEvent,
  type TextStyle,
} from './ansi.ts';

/**
 * One cell.
 *
 * `text` is a string, not a character: a base plus its combining marks share one
 * cell, which is what a terminal draws and what makes `runsOf` able to hand the
 * DOM a grapheme rather than a fragment.
 *
 * `text === ''` marks the right half of a wide cell. Nothing is drawn there and
 * nothing may be appended to it.
 */
export interface TerminalCell {
  readonly text: string;
  readonly style: TextStyle;
}

/** The right half of a double-width cell. Shared, because it is immutable. */
const CONTINUATION_TEXT = '';

const BLANK = ' ';

/** Tab stops, every 8 columns. The VT default, and what every shell assumes. */
export const TAB_WIDTH = 8;

/**
 * How many rows the buffer keeps.
 *
 * 1500 because that is v1's `MAXROWS`, and the number is load-bearing for more
 * than memory: v1 counts prompt rows towards it too, so an empty Enter cannot
 * be used to push output out of the log without limit.
 */
export const MAX_ROWS = 1500;

/** A sequence the semantic grid could not honour, kept so a host can react. */
export interface UnsupportedSequence {
  /** Printable spelling, e.g. `CSI 5 A`. Never the raw bytes: they are invisible. */
  readonly sequence: string;
  readonly reason: string;
}

/** How many unsupported sequences are remembered before the list stops growing. */
const MAX_UNSUPPORTED = 64;

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

/**
 * A stretch of cells that look the same, ready to become one DOM node.
 *
 * `column` is where it starts and `columns` is how wide it is — both in CELLS,
 * never in code units. They are the numbers the alignment test compares between
 * the two renderers.
 */
export interface StyledRun {
  readonly text: string;
  readonly style: TextStyle;
  readonly column: number;
  readonly columns: number;
}

/**
 * Identity first, then value.
 *
 * The buffer stores the SAME style object in every cell written under one SGR
 * state, so `a === b` answers for nearly every adjacent pair and the field-by-
 * field comparison only runs at a real style boundary.
 */
const sameStyle = (a: TextStyle, b: TextStyle): boolean => a === b || styleEquals(a, b);

/**
 * Collapse a row of cells into runs.
 *
 * The concatenated `text` of the runs is exactly the printable text that was
 * written into the row. That is not a convenience — it is the property task
 * 16.4 rests on, because the accessible text of the rendered row is that
 * concatenation, and it has to equal what v1 put in a text node.
 */
export function runsOf(cells: readonly TerminalCell[]): StyledRun[] {
  const runs: StyledRun[] = [];
  let text = '';
  let style: TextStyle | null = null;
  let column = 0;
  let width = 0;

  const flush = (): void => {
    if (style === null || width === 0) return;
    runs.push({ text, style, column, columns: width });
    text = '';
    width = 0;
  };

  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    if (cell === undefined) continue;
    // A continuation cell belongs to the run that owns its left half, whatever
    // its style says: splitting a wide character in two would produce a run
    // starting mid-glyph.
    if (cell.text === CONTINUATION_TEXT) {
      if (style !== null) width += 1;
      continue;
    }
    if (style === null || !sameStyle(style, cell.style)) {
      flush();
      style = cell.style;
      column = index;
    }
    text += cell.text;
    width += 1;
  }
  flush();
  return runs;
}

/** The printable text of a row: what a screen reader is given for it. */
export function rowText(cells: readonly TerminalCell[]): string {
  let out = '';
  for (const cell of cells) out += cell.text;
  return out;
}

// ---------------------------------------------------------------------------
// the buffer
// ---------------------------------------------------------------------------

const spell = (event: Extract<AnsiEvent, { kind: 'csi' }>): string =>
  `CSI ${event.prefix}${event.params.map((p) => p.join(':')).join(';')}${event.intermediates}${event.final}`;

const first = (event: Extract<AnsiEvent, { kind: 'csi' }>, fallback: number): number => {
  const value = event.params[0]?.[0] ?? OMITTED;
  return value === OMITTED ? fallback : value;
};

/**
 * Rows of cells, written by ANSI events.
 *
 * One instance per terminal. It holds no DOM and no xterm; both adapters own
 * one of these and read the same rows out of it, which is what makes the two
 * renderers comparable at all.
 */
export class TerminalBuffer {
  #rows: TerminalCell[][] = [[]];
  #column = 0;
  #style: TextStyle = DEFAULT_STYLE;
  #unsupported: UnsupportedSequence[] = [];
  #maxRows: number;
  /** Rows dropped by the cap, so a caller can tell "empty" from "trimmed". */
  #trimmed = 0;

  constructor(maxRows: number = MAX_ROWS) {
    this.#maxRows = Math.max(1, maxRows);
  }

  get rows(): readonly (readonly TerminalCell[])[] {
    return this.#rows;
  }

  /** Where the next character goes, in cells from the left of the current row. */
  get column(): number {
    return this.#column;
  }

  get style(): TextStyle {
    return this.#style;
  }

  get unsupported(): readonly UnsupportedSequence[] {
    return this.#unsupported;
  }

  get trimmedRows(): number {
    return this.#trimmed;
  }

  clear(): void {
    this.#rows = [[]];
    this.#column = 0;
    // Back to zero, not left alone: after a clear nothing HAS been trimmed. A
    // caller mirroring this count must re-read it here, or its own arithmetic
    // goes negative on the next write. `semantic.ts`'s `clear` does.
    this.#trimmed = 0;
    // The style deliberately survives a clear: `Clear-Host` inside a coloured
    // region does not end the colour, and resetting here would make the next
    // write come out in the wrong one.
  }

  #record(sequence: string, reason: string): void {
    if (this.#unsupported.length >= MAX_UNSUPPORTED) return;
    this.#unsupported.push({ sequence, reason });
  }

  #line(): TerminalCell[] {
    const row = this.#rows[this.#rows.length - 1];
    if (row !== undefined) return row;
    const fresh: TerminalCell[] = [];
    this.#rows.push(fresh);
    return fresh;
  }

  /** Grow the row to `upto` cells with blanks in the current style. */
  /**
   * Grow the row to `upto` cells with blanks in the current style.
   *
   * No repair needed and none done: this only ever appends PAST the end of the
   * row, so there is no existing cell to orphan. Overwriting is `#blank`'s job.
   */
  #pad(row: TerminalCell[], upto: number): void {
    while (row.length < upto) row.push({ text: BLANK, style: this.#style });
  }

  /**
   * Write one blank at `at`, repairing whatever it overlaps.
   *
   * The single place a blank is written over existing content, and it exists
   * because there were four of them — TAB, CUF, ECH and erase-in-line — and
   * three had the same bug. Blanking the left half of 中 without blanking its
   * right half leaves a continuation cell with nothing in front of it, and
   * `runsOf` then folds that orphan into whatever run precedes it, reporting a
   * width one column too wide for every line after the erase.
   */
  #blank(row: TerminalCell[], at: number): void {
    this.#repairOverlap(row, at);
    row[at] = { text: BLANK, style: this.#style };
  }

  #newline(): void {
    this.#rows.push([]);
    this.#column = 0;
    while (this.#rows.length > this.#maxRows) {
      this.#rows.shift();
      this.#trimmed += 1;
    }
  }

  /**
   * Blank the surviving half of a wide character a write is about to overlap.
   *
   * Overwriting is not hypothetical — `\rDone` over a progress bar is the whole
   * reason CR exists — and a half-overwritten 中 is where the cell model
   * produces something a naive implementation gets silently wrong. Left alone,
   * overwriting the left half of 中 with `a` leaves `[a][continuation]`, and
   * `runsOf` would then report `a` as two columns wide, which is exactly the
   * class of bug this phase is about. A real terminal blanks the orphan.
   *
   * CALLED BEFORE THE WRITE, on every cell the write will cover, and never
   * after it. The first version also called it on the last cell written, which
   * for a wide character is its own continuation half — so it read that half as
   * an orphan and blanked the character it had just placed. Every CJK and emoji
   * assertion in `renderer-grid.test.mts` failed on that, which is the reason
   * those expectations are written as literals rather than computed.
   */
  #repairOverlap(row: TerminalCell[], at: number): void {
    const cell = row[at];
    if (cell === undefined) return;
    if (cell.text === CONTINUATION_TEXT) {
      // A write landing on a right half orphans the left one.
      const left = row[at - 1];
      if (left !== undefined) row[at - 1] = { text: BLANK, style: left.style };
      return;
    }
    // A write landing on a left half orphans the right one.
    const right = row[at + 1];
    if (right !== undefined && right.text === CONTINUATION_TEXT) {
      row[at + 1] = { text: BLANK, style: right.style };
    }
  }

  /**
   * Put one code point on the screen.
   *
   * The zero-width case is the interesting one: the mark joins the last cell
   * that HOLDS something, skipping the empty right half of a wide character. A
   * mark appended to that half would be invisible — nothing is drawn there —
   * and the row's text would gain a character the screen reader announces in
   * the wrong place.
   */
  #put(character: string, width: number): void {
    const row = this.#line();

    if (width === 0) {
      for (let at = Math.min(this.#column, row.length) - 1; at >= 0; at -= 1) {
        const cell = row[at];
        if (cell === undefined || cell.text === CONTINUATION_TEXT) continue;
        row[at] = { text: cell.text + character, style: cell.style };
        return;
      }
      // Nothing to join. A leading combining mark gets its own cell rather than
      // being dropped: dropping it would silently change the text, and this is
      // the one place where a terminal's behaviour and a reader's expectation
      // both point at "show it".
      this.#pad(row, this.#column);
      this.#repairOverlap(row, this.#column);
      row[this.#column] = { text: character, style: this.#style };
      this.#column += 1;
      return;
    }

    this.#pad(row, this.#column);
    for (let i = 0; i < width; i += 1) this.#repairOverlap(row, this.#column + i);
    row[this.#column] = { text: character, style: this.#style };
    this.#column += 1;
    for (let i = 1; i < width; i += 1) {
      row[this.#column] = { text: CONTINUATION_TEXT, style: this.#style };
      this.#column += 1;
    }
  }

  #text(text: string): void {
    for (const character of text) {
      this.#put(character, cellWidthOfCodePoint(character.codePointAt(0) ?? 0));
    }
  }

  #execute(code: number): void {
    switch (code) {
      case 0x08: // BS — back one CELL, not one character.
        if (this.#column > 0) this.#column -= 1;
        break;
      case 0x09: {
        // HT. The blanks are written in the CURRENT style, so a tab inside a
        // coloured region carries that region's background, which is what a
        // terminal draws.
        const row = this.#line();
        const stop = (Math.floor(this.#column / TAB_WIDTH) + 1) * TAB_WIDTH;
        this.#pad(row, this.#column);
        while (this.#column < stop) {
          this.#blank(row, this.#column);
          this.#column += 1;
        }
        break;
      }
      case 0x0a:
      case 0x0b:
      case 0x0c:
        // LF, VT and FF all move to the next row. VT and FF are index
        // operations in the VT spec and every terminal treats them as a
        // linefeed; a shell that emits one means "new line".
        this.#newline();
        break;
      case 0x0d:
        this.#column = 0;
        break;
      default:
        break;
    }
  }

  #eraseInLine(event: Extract<AnsiEvent, { kind: 'csi' }>): void {
    const row = this.#line();
    const mode = first(event, 0);
    if (mode === 0) {
      // Cutting at the cursor can sever a wide character. Repairing FIRST means
      // a cut landing on a right half blanks the left one that is being kept,
      // and a cut landing on a left half drops the whole character.
      this.#repairOverlap(row, this.#column);
      row.length = Math.min(row.length, this.#column);
    } else if (mode === 1) {
      this.#pad(row, this.#column + 1);
      for (let at = 0; at <= this.#column && at < row.length; at += 1) this.#blank(row, at);
    } else if (mode === 2) {
      row.length = 0;
    } else {
      this.#record(spell(event), `EL mode ${String(mode)} is not defined`);
    }
  }

  #eraseInDisplay(event: Extract<AnsiEvent, { kind: 'csi' }>): void {
    const mode = first(event, 0);
    if (mode === 2 || mode === 3) {
      this.clear();
      return;
    }
    // ED 0 and ED 1 erase relative to a cursor on a SCREEN. This renderer has
    // rows and no screen, so honouring them would mean inventing a viewport and
    // deleting rows the reader has already been read.
    this.#record(spell(event), 'erase-in-display needs a screen; this renderer appends rows');
  }

  #csi(event: Extract<AnsiEvent, { kind: 'csi' }>): void {
    if (event.prefix !== '') {
      // `?` sequences are private modes: cursor visibility, bracketed paste,
      // the alternate screen. None of them change where a character lands, so
      // they are recorded rather than refused loudly.
      this.#record(spell(event), 'private mode; the semantic renderer has no modes');
      return;
    }
    switch (event.final) {
      case 'm':
        this.#style = applySgr(this.#style, event.params);
        return;
      case 'K':
        this.#eraseInLine(event);
        return;
      case 'J':
        this.#eraseInDisplay(event);
        return;
      case 'C': {
        // CUF. Moving right within a row is honourable: it is padding.
        const by = Math.max(1, first(event, 1));
        const row = this.#line();
        this.#pad(row, this.#column);
        for (let i = 0; i < by; i += 1) {
          this.#blank(row, this.#column);
          this.#column += 1;
        }
        return;
      }
      case 'D': {
        const by = Math.max(1, first(event, 1));
        this.#column = Math.max(0, this.#column - by);
        return;
      }
      case 'G': {
        // CHA is 1-based, and column 0 is what a 0 or an omitted parameter
        // means in every implementation.
        const to = Math.max(1, first(event, 1));
        this.#column = to - 1;
        return;
      }
      case 'X': {
        // ECH erases forward without moving. Honourable for the same reason CUF
        // is: it stays on this row.
        const by = Math.max(1, first(event, 1));
        const row = this.#line();
        this.#pad(row, this.#column);
        for (let at = this.#column; at < this.#column + by && at < row.length; at += 1) {
          this.#blank(row, at);
        }
        return;
      }
      default:
        this.#record(spell(event), 'needs an addressable screen or is not implemented');
    }
  }

  /** Apply parsed events. The only way anything gets into the buffer. */
  write(events: readonly AnsiEvent[]): void {
    for (const event of events) {
      switch (event.kind) {
        case 'text':
          this.#text(event.text);
          break;
        case 'execute':
          this.#execute(event.code);
          break;
        case 'csi':
          this.#csi(event);
          break;
        case 'esc':
          if (event.final === 'c' && event.intermediates === '') {
            // RIS, a full reset. The one ESC sequence worth honouring: it is
            // what a program emits when it has finished making a mess.
            this.clear();
            this.#style = DEFAULT_STYLE;
          } else if (event.intermediates !== '') {
            // Character-set designation, `ESC ( B` and friends. This renderer
            // is Unicode-only, so there is nothing to designate and nothing is
            // lost by ignoring it — recorded rather than listed as a failure.
            this.#record(`ESC ${event.intermediates}${event.final}`, 'character sets are not modelled; output is Unicode');
          } else {
            this.#record(`ESC ${event.final}`, 'not implemented');
          }
          break;
        case 'osc':
          // Window titles, hyperlinks, clipboard. None of them place a
          // character, and a host that wants them can read them off the parser.
          this.#record(
            `OSC ${event.identifier === OMITTED ? '?' : String(event.identifier)}`,
            'operating-system commands are the host\'s business, not the grid\'s',
          );
          break;
        case 'string':
          this.#record(`${event.opener} string`, 'device-control strings are not interpreted');
          break;
      }
    }
  }
}
