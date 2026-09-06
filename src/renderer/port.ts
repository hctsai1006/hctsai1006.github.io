/**
 * port.ts — the seam this phase exists to create.
 *
 * v1 has no seam. `print(rows)` in `legacy/terminal-v1.html` builds DOM nodes
 * and appends them to `#out` in the same function that decides what a row
 * contains, so there is exactly one renderer and no way to have a second. PR-16
 * asks for a second — xterm.js, for TUI fidelity — without making it the first.
 *
 * THE SHAPE IS DELIBERATELY THE LINE EDITOR'S. `src/line-editor/` already
 * solved the same problem in the other direction: `LineEditorCore` decides and
 * an adapter renders, geometry arrives as an injected `TerminalMetrics` rather
 * than being measured. This is its sibling on the output side. A host holds a
 * `TerminalPort`; it never holds a `Terminal`, a `document` or an xterm.
 *
 * WHAT IS AND IS NOT ON THE PORT, and why the list is this short:
 *
 *   write      the only way anything arrives. Takes a chunk, not a line, and
 *              the chunk may end in the middle of an escape sequence — because
 *              a real host writes what it has.
 *   clear      Clear-Host, and `\x1b[2J`, and nothing else.
 *   snapshot   what is on screen, in CELLS. This is the measurement surface,
 *              and it is on the port rather than on one adapter because the
 *              acceptance condition — "CJK and emoji align in both renderers" —
 *              is a statement about two ports being comparable.
 *   unsupported  what the SHARED GRID could not honour. Empty is a claim, not
 *              a default, and it means two useful things depending on which
 *              adapter is behind the port: for the semantic renderer, the
 *              screen is not showing this and the xterm one would serve it
 *              better; for the xterm renderer, xterm honoured it and the
 *              snapshot above has stopped being an accurate reading of what
 *              is on screen.
 *
 * There is no `resize`, no `focus`, no `scrollToBottom` and no event surface.
 * Every one of those is a host concern that v1 already does in CSS or in three
 * lines of its own, and a port that carries them cannot be implemented by
 * anything except the thing it was extracted from.
 */

import type { TerminalCell, UnsupportedSequence } from './grid.ts';

/**
 * Which renderer is behind a port.
 *
 * 'semantic' is the default everywhere. The kind is exposed so a host can say
 * which one is running — not so callers can branch on it: a caller that
 * branches on the renderer has found a hole in this interface.
 */
export type TerminalRendererKind = 'semantic' | 'xterm';

export interface TerminalPort {
  readonly kind: TerminalRendererKind;

  /**
   * Write a chunk. May contain ANSI, and may end mid-sequence — the parser
   * behind every implementation is resumable, so a sequence split across two
   * calls is still one sequence.
   */
  write(chunk: string): void;

  /** Drop everything on screen. The current SGR state survives; see grid.ts. */
  clear(): void;

  /**
   * The rows currently held, in cells.
   *
   * Cells, not text, because the question this answers is "which column is this
   * character in" and text cannot answer it: `中文` is four columns and two
   * characters. `rowText` and `runsOf` in grid.ts turn a snapshot back into
   * something a reader or a DOM wants.
   *
   * THE LIVE ROWS, NOT A COPY, despite the name. `readonly` here is a
   * compile-time promise and nothing more: the arrays are the buffer's own and
   * they grow as more is written. Copying would be honest to the name and would
   * also be a lie of its own — the cells inside are shared either way — so the
   * behaviour is written down instead. Read it, do not keep it.
   */
  snapshot(): readonly (readonly TerminalCell[])[];

  /**
   * Sequences this renderer received and could not honour.
   *
   * A host shows this to decide whether to offer the ANSI renderer. It is the
   * only honest way to express "the semantic renderer is the better default AND
   * cannot run a TUI" — the alternative is a renderer that silently draws a
   * full-screen editor as a thousand rows of garbage.
   */
  readonly unsupported: readonly UnsupportedSequence[];

  /** Release whatever the adapter holds. Idempotent in every implementation. */
  dispose(): void;
}
