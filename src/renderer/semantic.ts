/**
 * semantic.ts — the default renderer: real elements, real text, a live region.
 *
 * WHY THIS IS THE DEFAULT AND NOT THE FALLBACK. A screen reader can read this
 * page because the output IS text in the accessibility tree — the same nodes
 * that are drawn are the ones that are read. xterm.js reaches accessibility the
 * other way round: its `screenReaderMode` option is documented as "whether
 * screen reader support is enabled. When on this will expose supporting
 * elements in the DOM to support NVDA on Windows and VoiceOver on macOS", i.e.
 * additional elements derived from the buffer rather than the drawing itself.
 * That is a second surface, and a second surface is a second source of truth.
 * So the semantic renderer stays the default and the ANSI one is opt-in, which
 * is what task 16.4 asks for. (The quotation is from `@xterm/xterm@6.0.0`'s
 * `typings/xterm.d.ts`; how those elements are built was not read, and nothing
 * here depends on how.)
 *
 * WHAT MUST NOT CHANGE, and how this file is held to it. v1's output is
 * `textContent` of every `.row` under `#out` — that is not an interpretation,
 * it is literally how `tools/capture-v1.mts` records the golden transcripts, so
 * the 128 committed files under `tests/conformance/fixtures/v1/` ARE the
 * screen-reader output. `tests/unit/renderer-semantic.test.mts` replays all
 * 1102 of those rows through this renderer and compares the accessible text.
 * 1098 are byte-identical. THE OTHER FOUR are the tab-bearing rows of
 * `lsb_release`, and the difference is deliberate: v1 put a raw TAB into a text
 * node, and this is a terminal emulator, so it advances to the next stop at a
 * multiple of eight and writes blanks — which is what xterm does with the same
 * bytes, and the only way the two renderers can agree about a line containing
 * one. The test asserts that number is exactly four, so a fifth divergence of
 * any kind fails. The live-region attributes are held the same way: read out of
 * `legacy/terminal-v1.html` by the test rather than restated here, so changing
 * either side fails.
 *
 * THE DOM SHAPE FOLLOWS v1's, INCLUDING WHERE IT IS PLAIN. v1 writes
 * `d.textContent = txt` for an unstyled row and only creates a `<span>` when
 * there is a class to put on it. This does the same: a run in the default style
 * becomes a text node. That is not cosmetic — an extra wrapper element changes
 * how some screen readers chunk a line, and "no spans unless there is a reason"
 * is a property worth keeping rather than rediscovering.
 *
 * WHY IT TAKES A DOCUMENT RATHER THAN USING THE GLOBAL. Because that is what
 * makes the transcript replay above possible at all: a renderer that reaches
 * for `globalThis.document` can only be tested in a browser, and the ground
 * truth it has to be tested against is 128 text files.
 *
 * It does NOT make this module headless in the sense `src/line-editor/` is.
 * That directory is sealed by a test which forbids even NAMING a browser
 * global, and `document` is named here — as a parameter and a field. This file
 * could not move into the core, and does not need to: the core is sealed so the
 * editor can run without a DOM, and a DOM renderer has no such ambition.
 */

import { AnsiParser } from './ansi.ts';
import type { AnsiColor, TextStyle } from './ansi.ts';
import { MAX_ROWS, runsOf, TerminalBuffer } from './grid.ts';
import type { StyledRun, TerminalCell, UnsupportedSequence } from './grid.ts';
import type { TerminalPort } from './port.ts';

// ---------------------------------------------------------------------------
// the slice of the DOM this needs
// ---------------------------------------------------------------------------

/**
 * A node, as far as this renderer is concerned.
 *
 * `textContent` is on the interface because it is the thing under test, not
 * because this file reads it: nothing here does. A fake that omitted it would
 * satisfy the renderer and prove nothing about accessibility.
 */
export interface TerminalNode {
  readonly textContent: string | null;
}

export interface TerminalElement extends TerminalNode {
  className: string;
  setAttribute(name: string, value: string): void;
  append(...nodes: (TerminalNode | string)[]): void;
  removeChild(child: TerminalNode): unknown;
  readonly firstChild: TerminalNode | null;
}

/** `Document` satisfies this structurally; nothing has to adapt a real one. */
export interface TerminalDocument {
  createElement(tag: string): TerminalElement;
  createTextNode(data: string): TerminalNode;
}

// ---------------------------------------------------------------------------
// the accessibility contract
// ---------------------------------------------------------------------------

/**
 * The live-region attributes, exactly as `legacy/terminal-v1.html` sets them on
 * `#out`:
 *
 *     <div id="out" role="log" aria-live="polite" aria-atomic="false"
 *          aria-label="主控台輸出"></div>
 *
 * Each one is load-bearing and none is the default for its element:
 *
 *   role="log"          a running record, so new content is announced and old
 *                       content is not re-read
 *   aria-live="polite"  queued behind whatever the user is doing. `assertive`
 *                       would interrupt them mid-word on every printed row
 *   aria-atomic="false" announce the ADDITION, not the whole region. `true`
 *                       re-reads the entire transcript on every line, which is
 *                       the failure mode this attribute exists to prevent
 *
 * `role="log"` implies a polite live region in the ARIA specification, so
 * `aria-live` here is redundant on paper. It is kept because v1 has it, because
 * implementations have historically disagreed about the implicit value, and
 * because task 16.4 says "keep aria-live output intact" — silently deleting the
 * attribute that task names would be a strange way to satisfy it.
 */
export const LOG_REGION_ROLE = 'log';
export const LOG_REGION_LIVE = 'polite';
export const LOG_REGION_ATOMIC = 'false';

/** v1's own label for `#out`. Traditional Chinese, because the page is. */
export const DEFAULT_LOG_LABEL = '主控台輸出';

/** v1's class on every output row. The CSS and the capture both select it. */
export const ROW_CLASS = 'row';

// ---------------------------------------------------------------------------
// style -> attributes
// ---------------------------------------------------------------------------

/**
 * How a style becomes classes and, only when it must, an inline colour.
 *
 * THE PALETTE IS NOT RESOLVED HERE, on purpose. An indexed colour becomes
 * `ansi-fg-214`, not `#d7af00`: v1 keeps every colour in CSS custom properties
 * so a theme can change them, and a renderer that baked RGB values in would
 * take that away and would also have to carry a 256-entry table that nothing
 * checks. Truecolour is the one case with no index to name, so it is the one
 * case that gets an inline `color:`.
 */
export function styleClasses(style: TextStyle): string[] {
  const classes: string[] = [];
  if (style.bold) classes.push('ansi-bold');
  if (style.dim) classes.push('ansi-dim');
  if (style.italic) classes.push('ansi-italic');
  if (style.underline) classes.push('ansi-underline');
  if (style.inverse) classes.push('ansi-inverse');
  if (style.hidden) classes.push('ansi-hidden');
  if (style.strikethrough) classes.push('ansi-strike');
  if (style.foreground.kind === 'palette') classes.push(`ansi-fg-${String(style.foreground.index)}`);
  if (style.background.kind === 'palette') classes.push(`ansi-bg-${String(style.background.index)}`);
  return classes;
}

const rgbCss = (color: AnsiColor): string | null =>
  color.kind === 'rgb' ? `rgb(${String(color.r)},${String(color.g)},${String(color.b)})` : null;

/** The inline `style` attribute, or '' when there is nothing that needs one. */
export function styleAttribute(style: TextStyle): string {
  const parts: string[] = [];
  const fg = rgbCss(style.foreground);
  const bg = rgbCss(style.background);
  if (fg !== null) parts.push(`color:${fg}`);
  if (bg !== null) parts.push(`background-color:${bg}`);
  return parts.join(';');
}

const isPlain = (run: StyledRun): boolean =>
  styleClasses(run.style).length === 0 && styleAttribute(run.style) === '';

// ---------------------------------------------------------------------------
// the adapter
// ---------------------------------------------------------------------------

export interface SemanticTerminalOptions {
  readonly document: TerminalDocument;
  /** The element the rows go into. It becomes the live region. */
  readonly container: TerminalElement;
  /** Overrides v1's `aria-label`. Hosts in other languages need this. */
  readonly label?: string;
  /** Rows kept before the oldest are dropped. v1's cap is the default. */
  readonly maxRows?: number;
}

/**
 * The default renderer.
 *
 * One `TerminalBuffer`, one `AnsiParser`, and a reconcile that touches only the
 * rows that can have changed. Rows never change once a newline has passed them
 * — this renderer has no cursor addressing, which is the same fact that makes
 * `unsupported` non-empty for a TUI — so the work per write is one element.
 */
class SemanticTerminal implements TerminalPort {
  readonly kind = 'semantic' as const;

  readonly #document: TerminalDocument;
  readonly #container: TerminalElement;
  readonly #buffer: TerminalBuffer;
  readonly #parser = new AnsiParser();
  /** One element per buffer row, in the same order. */
  #elements: TerminalElement[] = [];
  #trimmed = 0;
  #disposed = false;

  constructor(options: SemanticTerminalOptions) {
    this.#document = options.document;
    this.#container = options.container;
    this.#buffer = new TerminalBuffer(options.maxRows ?? MAX_ROWS);

    this.#container.setAttribute('role', LOG_REGION_ROLE);
    this.#container.setAttribute('aria-live', LOG_REGION_LIVE);
    this.#container.setAttribute('aria-atomic', LOG_REGION_ATOMIC);
    this.#container.setAttribute('aria-label', options.label ?? DEFAULT_LOG_LABEL);
    this.#reconcile(0);
  }

  get unsupported(): readonly UnsupportedSequence[] {
    return this.#buffer.unsupported;
  }

  snapshot(): readonly (readonly TerminalCell[])[] {
    return this.#buffer.rows;
  }

  write(chunk: string): void {
    if (this.#disposed) return;
    // The row that is about to be written into is the earliest one whose
    // content can change. Held as an ABSOLUTE row number because the trim below
    // shifts every relative index.
    const dirty = this.#buffer.trimmedRows + this.#buffer.rows.length - 1;
    this.#buffer.write(this.#parser.parse(chunk));
    this.#reconcile(dirty);
  }

  clear(): void {
    if (this.#disposed) return;
    this.#buffer.clear();
    for (const element of this.#elements) this.#container.removeChild(element);
    this.#elements = [];
    // Re-read rather than left alone: `TerminalBuffer.clear` sets its trimmed
    // count back to zero, so this mirror has to follow or `#trim` computes a
    // NEGATIVE number of rows to drop on the next write and silently stops
    // trimming for the rest of the session.
    this.#trimmed = this.#buffer.trimmedRows;
    this.#reconcile(0);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const element of this.#elements) this.#container.removeChild(element);
    this.#elements = [];
    this.#parser.reset();
  }

  /** Drop the elements for rows the buffer's cap has already discarded. */
  #trim(): void {
    let drop = this.#buffer.trimmedRows - this.#trimmed;
    this.#trimmed = this.#buffer.trimmedRows;
    while (drop > 0) {
      const first = this.#elements.shift();
      if (first === undefined) break;
      this.#container.removeChild(first);
      drop -= 1;
    }
  }

  /** Rebuild every row element from `dirtyAbsolute` onwards. */
  #reconcile(dirtyAbsolute: number): void {
    this.#trim();
    const rows = this.#buffer.rows;

    while (this.#elements.length < rows.length) {
      const element = this.#document.createElement('div');
      element.className = ROW_CLASS;
      this.#elements.push(element);
      this.#container.append(element);
    }

    const from = Math.max(0, dirtyAbsolute - this.#buffer.trimmedRows);
    for (let index = from; index < rows.length; index += 1) {
      const element = this.#elements[index];
      const cells = rows[index];
      if (element === undefined || cells === undefined) continue;
      this.#fill(element, cells);
    }
  }

  /**
   * Put one row's content into its element.
   *
   * `replaceChildren` is deliberately absent from `TerminalElement`. v1 uses
   * both idioms — `removeChild(out.firstChild)` to trim (`trimOutput`) and
   * `replaceChildren` with a `removeChild` fallback to clear (`clearOut`) — so
   * either would be faithful. One removal primitive is chosen because the
   * port's whole value is being small enough that a fake implementing it is
   * obviously correct, and every member added is a member the fake can get
   * subtly wrong.
   */
  #fill(element: TerminalElement, cells: readonly TerminalCell[]): void {
    for (;;) {
      const first = element.firstChild;
      if (first === null) break;
      element.removeChild(first);
    }

    for (const run of runsOf(cells)) {
      if (isPlain(run)) {
        element.append(this.#document.createTextNode(run.text));
        continue;
      }
      const span = this.#document.createElement('span');
      span.className = styleClasses(run.style).join(' ');
      const inline = styleAttribute(run.style);
      if (inline !== '') span.setAttribute('style', inline);
      span.append(this.#document.createTextNode(run.text));
      element.append(span);
    }
  }
}

/** Build the default renderer. Nothing is loaded, fetched or awaited. */
export function createSemanticTerminal(options: SemanticTerminalOptions): TerminalPort {
  return new SemanticTerminal(options);
}
