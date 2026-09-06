/**
 * xterm.ts — the second adapter, and the reason it costs this project nothing.
 *
 * THE CONSTRAINT THIS FILE IS SHAPED BY. `legacy/PROVENANCE.md` says of the
 * original: "It has no build step and no dependencies, which is why it has
 * survived." That is not nostalgia, it is the reason a 2113-line page from
 * years ago still runs. So "add an xterm adapter" must not become "this project
 * now depends on xterm.js to run", and the whole file is arranged around that:
 *
 *   - Nothing here imports xterm. The module arrives through `load`, which
 *     defaults to a dynamic `import()` of a specifier that is a STRING, so
 *     neither the type checker nor a bundler resolves it and a checkout with no
 *     xterm installed type-checks and runs.
 *   - Every part that can be checked without xterm is separated out and
 *     checked: `unicodeProvider()` below is the entire alignment contract, and
 *     it is a plain object that `tests/unit/renderer-xterm.test.mts` exercises
 *     in full with nothing installed.
 *   - The adapter is never the default. `createTerminal` in index.ts returns
 *     the semantic renderer unless a host asks for this one by name.
 *
 * At the time of writing NOTHING in this repository installs xterm.js, and
 * `package.json` is unchanged. This adapter is code that becomes live the day
 * someone adds the dependency, and until then it is exercised through an
 * injected fake module.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY ALIGNMENT IS CONSTRUCTED HERE AND NOT ASSERTED.
 *
 * xterm.js ships two width models and its DEFAULT is the wrong one. Measured
 * DURING THIS WORK against the published packages `@xterm/headless@6.0.0` and
 * `@xterm/addon-unicode11@0.9.0` — not by this repository's tests, which never
 * load xterm and never could assert this:
 *
 *     codepoint                     v6 (default)   v11 (addon)
 *     U+4E00 一  CJK ideograph            2             2
 *     U+FF21 Ａ  fullwidth                2             2
 *     U+1F600 😀 emoji                    1             2
 *     U+231A  ⌚ watch                     1             2
 *     U+26A1  ⚡ high voltage              1             2
 *
 * So with a stock `new Terminal()`, every emoji is one cell wide in xterm and
 * two in this project's formatter, and a table containing one is misaligned by
 * exactly the count of them. Loading the unicode11 addon fixes the emoji and
 * still leaves the 1114 code points where xterm's frozen Unicode 12 snapshot
 * disagrees with the Unicode 16.0.0 tables in `src/line-editor/cells.ts` — 833
 * of them Wide characters assigned after Unicode 12.
 *
 * The fix is not to load the addon. It is to register a provider whose
 * `wcwidth` IS `cellWidthOfCodePoint`, so xterm measures with this project's
 * table rather than its own. Then "CJK and emoji align in both renderers" is
 * not a property to be tested afterwards; it is the same function answering
 * twice. That provider needs no dependency to build and none to test.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS ADAPTER DELIBERATELY DOES NOT DO: INPUT.
 *
 * `TerminalPort` has no input surface — no `onData`, no `onKey`, no `focus` —
 * and this adapter subscribes to none. Input in this project belongs to the
 * line editor and to a real `<textarea>`, which earns its place because of IME
 * composition, soft keyboards and selection; an xterm that also handled keys
 * would be a second input owner and the two would fight over composition.
 *
 * THE UNRESOLVED PART, recorded rather than decided: `Terminal.open(parent)`
 * builds xterm's own DOM, and that DOM includes its own helper textarea and its
 * own key listeners. Not subscribing to `onData` stops this adapter from acting
 * on them; it does not stop xterm from installing them. Whether the host
 * suppresses them (`attachCustomKeyEventHandler`), keeps xterm off the DOM
 * entirely (`@xterm/headless` has no `open` at all — confirmed absent from its
 * typings), or hands input over to xterm when this renderer is active is a
 * decision about the INPUT seam and is not made here.
 */

import { cellWidthOfCodePoint } from '../line-editor/cells.ts';
import { AnsiParser } from './ansi.ts';
import { MAX_ROWS, TerminalBuffer } from './grid.ts';
import type { TerminalCell, UnsupportedSequence } from './grid.ts';
import type { TerminalPort } from './port.ts';

// ---------------------------------------------------------------------------
// the Unicode provider
// ---------------------------------------------------------------------------

/**
 * xterm.js's `IUnicodeVersionProvider`, restated so nothing has to import it.
 *
 * Verbatim from `@xterm/xterm@6.0.0`'s `typings/xterm.d.ts`:
 *
 *     export interface IUnicodeVersionProvider {
 *       readonly version: string;
 *       wcwidth(codepoint: number): 0 | 1 | 2;
 *       charProperties(codepoint: number, preceding: number): number;
 *     }
 *
 * `charProperties` really is typed `number` on both sides in the PUBLIC
 * typings. Internally it is `UnicodeCharProperties`, but that is a bare
 * `export type UnicodeCharProperties = number` in `src/common/services/Services.ts`
 * and is not exported from the package, so an implementation compiled against
 * the published typings must say `number`.
 */
export interface XtermUnicodeVersionProvider {
  readonly version: string;
  wcwidth(codepoint: number): 0 | 1 | 2;
  charProperties(codepoint: number, preceding: number): number;
}

/**
 * The bit layout of a `UnicodeCharProperties`, reimplemented because xterm does
 * not export the helpers that build one.
 *
 * `UnicodeService`'s statics are internal — `require('@xterm/headless')` exports
 * exactly `['Terminal']` — so a provider written outside xterm has to do the
 * packing itself. From `src/common/services/UnicodeService.ts`:
 *
 *     public static createPropertyValue(state: number, width: number, shouldJoin: boolean = false)
 *       { return ((state & 0xffffff) << 3) | ((width & 3) << 1) | (shouldJoin?1:0); }
 *     public static extractWidth(value) { return ((value >> 1) & 0x3); }
 *     public static extractShouldJoin(value) { return (value & 1) !== 0; }
 *     public static extractCharKind(value) { return value >> 3; }
 *
 *     bit 0     shouldJoin — combine with the preceding character
 *     bit 1..2  width, 0/1/2
 *     bit 3..31 grapheme-break class
 *
 * The class field is 0 here, which is what BOTH of xterm's own providers pass:
 * neither `UnicodeV6` nor `UnicodeV11` does grapheme clustering, and only
 * `@xterm/addon-unicode-graphemes` reads those bits. Passing 0 puts this
 * provider in the same family as the two xterm ships rather than half-way to a
 * third behaviour.
 */
export const createPropertyValue = (state: number, width: number, shouldJoin: boolean): number =>
  ((state & 0xffffff) << 3) | ((width & 3) << 1) | (shouldJoin ? 1 : 0);

export const extractWidth = (value: number): number => (value >> 1) & 0x3;

export const extractShouldJoin = (value: number): boolean => (value & 1) !== 0;

/**
 * The Unicode version this provider registers under.
 *
 * '16' because `src/line-editor/cells.ts` is generated from Unicode 16.0.0 and
 * pinned to `process.versions.unicode`. Registering under a plain version
 * number is deliberate: xterm keys its providers by that string, so a future
 * xterm shipping its own '16' would be REPLACED by this one rather than sitting
 * beside it, and there would be exactly one answer either way.
 */
export const UNICODE_VERSION = '16';

/**
 * The provider xterm measures with.
 *
 * `charProperties` reproduces the algorithm both of xterm's providers use,
 * verbatim from `addons/addon-unicode11/src/UnicodeV11.ts` (`UnicodeV6.ts` is
 * byte-identical here bar one comment):
 *
 *     let width = this.wcwidth(codepoint);
 *     let shouldJoin = width === 0 && preceding !== 0;
 *     if (shouldJoin) {
 *       const oldWidth = UnicodeService.extractWidth(preceding);
 *       if (oldWidth === 0) shouldJoin = false;
 *       else if (oldWidth > width) width = oldWidth;
 *     }
 *     return UnicodeService.createPropertyValue(0, width, shouldJoin);
 *
 * It is reproduced rather than improved on purpose. The rule that a zero-width
 * code point folds into the cell before it is the same rule `grid.ts` follows,
 * and the two have to agree about ZWJ sequences and combining marks or the
 * renderers stop aligning on exactly the inputs this phase is about.
 */
export function unicodeProvider(): XtermUnicodeVersionProvider {
  return {
    version: UNICODE_VERSION,
    wcwidth(codepoint: number): 0 | 1 | 2 {
      // cellWidthOfCodePoint returns 0, 1 or 2 by construction; the cast states
      // that for xterm's narrower type rather than re-deriving it.
      return cellWidthOfCodePoint(codepoint) as 0 | 1 | 2;
    },
    charProperties(codepoint: number, preceding: number): number {
      let width: number = this.wcwidth(codepoint);
      let shouldJoin = width === 0 && preceding !== 0;
      if (shouldJoin) {
        const oldWidth = extractWidth(preceding);
        if (oldWidth === 0) shouldJoin = false;
        else if (oldWidth > width) width = oldWidth;
      }
      return createPropertyValue(0, width, shouldJoin);
    },
  };
}

// ---------------------------------------------------------------------------
// the slice of xterm this adapter uses
// ---------------------------------------------------------------------------

export interface XtermUnicodeHandling {
  register(provider: XtermUnicodeVersionProvider): void;
  activeVersion: string;
  readonly versions: readonly string[];
}

export interface XtermTerminalLike {
  readonly unicode: XtermUnicodeHandling;
  write(data: string, callback?: () => void): void;
  clear(): void;
  dispose(): void;
  open?(parent: unknown): void;
}

/** `new Terminal(options)` and nothing else. Everything else is unused here. */
export interface XtermModuleLike {
  Terminal: new (options?: Readonly<Record<string, unknown>>) => XtermTerminalLike;
}

/** The npm package. Scoped: unscoped `xterm` was deprecated at 5.3.0. */
export const XTERM_SPECIFIER = '@xterm/xterm';

export interface XtermTerminalOptions {
  /** Where xterm draws. Omit for a terminal that is fed but not shown. */
  readonly container?: unknown;
  /**
   * How the module is obtained. Defaults to `import(specifier)`.
   *
   * A parameter rather than a hard import so a test can supply a module without
   * installing one, and so a host can point at a bundle, a CDN URL or a
   * pre-imported object.
   */
  readonly load?: () => Promise<XtermModuleLike>;
  readonly specifier?: string;
  readonly columns?: number;
  readonly rows?: number;
  readonly maxRows?: number;
}

/**
 * Options handed to `new Terminal(...)`.
 *
 * `allowProposedApi` is not optional: `terminal.unicode` is a getter that calls
 * `_checkProposedApi()` and THROWS unless it is true, so merely reading the
 * property to register a provider fails without it. Read off
 * `src/browser/public/Terminal.ts`.
 *
 * `convertEol` stays false. Turning it on makes xterm translate LF to CRLF,
 * which would give it a different row structure from `grid.ts` for the same
 * bytes — the engine already emits LF and means it (`out-string.ts`'s NEWLINE).
 *
 * `screenReaderMode` stays false, and that is the whole architectural point:
 * xterm's screen-reader support builds a hidden mirror of the buffer for
 * assistive technology. The semantic renderer needs no mirror because its
 * output IS text, and it is the default for that reason. Turning the mirror on
 * here would put a second, differently-derived transcript into the
 * accessibility tree beside the one task 16.4 protects.
 *
 * `cols` and `rows` are init-only in xterm — they live on
 * `ITerminalInitOnlyOptions`, not `ITerminalOptions`, because they cannot be
 * changed after construction — but the constructor takes the intersection, so
 * they are passed here with everything else.
 */
export function terminalOptions(options: XtermTerminalOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {
    allowProposedApi: true,
    convertEol: false,
    screenReaderMode: false,
  };
  if (options.columns !== undefined) out['cols'] = options.columns;
  if (options.rows !== undefined) out['rows'] = options.rows;
  return out;
}

/**
 * Register the provider and make it the active one.
 *
 * The second half is not redundant. `unicode.register` only auto-activates when
 * nothing is active yet, and `CoreTerminal` registers `UnicodeV6` in its own
 * constructor — so after `register` the active version is still '6' and every
 * emoji is still one cell wide. Confirmed against the real packages: loading
 * the unicode11 addon leaves `versions = ['6','11']` and `activeVersion = '6'`.
 * Forgetting the assignment is a silent no-op, which is the worst shape a bug
 * can take here.
 */
export function activateUnicode(terminal: XtermTerminalLike): void {
  const provider = unicodeProvider();
  terminal.unicode.register(provider);
  terminal.unicode.activeVersion = provider.version;
}

// ---------------------------------------------------------------------------
// the adapter
// ---------------------------------------------------------------------------

class XtermTerminal implements TerminalPort {
  readonly kind = 'xterm' as const;

  readonly #terminal: XtermTerminalLike;
  readonly #buffer: TerminalBuffer;
  readonly #parser = new AnsiParser();
  #disposed = false;

  constructor(terminal: XtermTerminalLike, maxRows: number) {
    this.#terminal = terminal;
    this.#buffer = new TerminalBuffer(maxRows);
  }

  /**
   * What a log-shaped reading of this stream contains.
   *
   * Not a read of xterm's own screen. xterm implements the full VT stack, so
   * once a program addresses the cursor the two diverge — and `unsupported`
   * names every sequence where that happened, which is what makes the
   * divergence visible rather than silent. What the two never disagree about is
   * WIDTH, because `activateUnicode` gave xterm this project's own table.
   */
  snapshot(): readonly (readonly TerminalCell[])[] {
    return this.#buffer.rows;
  }

  get unsupported(): readonly UnsupportedSequence[] {
    return this.#buffer.unsupported;
  }

  write(chunk: string): void {
    if (this.#disposed) return;
    this.#terminal.write(chunk);
    this.#buffer.write(this.#parser.parse(chunk));
  }

  clear(): void {
    if (this.#disposed) return;
    this.#terminal.clear();
    this.#buffer.clear();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#parser.reset();
    this.#terminal.dispose();
  }
}

/**
 * Load xterm and wrap it.
 *
 * Asynchronous because the loading is, and the asynchrony is the feature: the
 * default renderer is constructed synchronously and needs nothing, so a page
 * that never asks for ANSI never pays for it.
 */
export async function createXtermTerminal(
  options: XtermTerminalOptions = {},
): Promise<TerminalPort> {
  const specifier = options.specifier ?? XTERM_SPECIFIER;
  // The specifier is a VARIABLE, so neither tsc nor a bundler tries to resolve
  // it. That is what lets this file compile in a checkout with no xterm.
  const load = options.load ?? (async (): Promise<XtermModuleLike> => import(specifier) as Promise<XtermModuleLike>);

  const module = await load();
  const terminal = new module.Terminal(terminalOptions(options));
  activateUnicode(terminal);
  if (options.container !== undefined && terminal.open !== undefined) {
    terminal.open(options.container);
  }
  return new XtermTerminal(terminal, options.maxRows ?? MAX_ROWS);
}
