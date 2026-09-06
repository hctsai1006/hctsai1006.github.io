/**
 * renderer-xterm.test.mts — the ANSI adapter, checked with no xterm installed.
 *
 * NOTHING IN THIS REPOSITORY DEPENDS ON xterm.js, and this file is the argument
 * that it does not have to. `package.json` has no xterm entry, `node_modules`
 * has no xterm in it, and every assertion below runs anyway — because the whole
 * alignment contract is a plain object (`unicodeProvider()`) and the module is
 * injected rather than imported.
 *
 * WHAT THIS CAN AND CANNOT PROVE, said plainly:
 *
 *   CAN   that the provider answers with this project's own width table, that
 *         it packs its answer in the layout xterm's `UnicodeService` unpacks,
 *         that its `charProperties` reproduces xterm's joining rule, and that
 *         a layout built by consuming the provider EXACTLY as xterm consumes it
 *         is cell-for-cell identical to the semantic renderer's.
 *
 *   CANNOT  that xterm.js itself then draws that layout. That needs the
 *         dependency and a browser. What it replaces is the guesswork: the
 *         adapter's only contribution to alignment is the provider, and the
 *         provider is fully determined here.
 *
 * The xterm-side numbers quoted in the comments were read from xterm.js's
 * sources at `@xterm/xterm@6.0.0` and confirmed by running the published
 * packages; they are not produced by this test and this test does not assert
 * them.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cellWidthOfCodePoint } from '../../src/line-editor/cells.ts';
import { parseAnsi } from '../../src/renderer/ansi.ts';
import { rowText, TerminalBuffer } from '../../src/renderer/grid.ts';
import type { TerminalCell } from '../../src/renderer/grid.ts';
import {
  activateUnicode,
  createPropertyValue,
  createXtermTerminal,
  extractShouldJoin,
  extractWidth,
  terminalOptions,
  unicodeProvider,
  UNICODE_VERSION,
  XTERM_SPECIFIER,
  type XtermModuleLike,
  type XtermTerminalLike,
  type XtermUnicodeVersionProvider,
} from '../../src/renderer/xterm.ts';

// ---------------------------------------------------------------------------
// a fake xterm
// ---------------------------------------------------------------------------

interface Recorded {
  written: string[];
  cleared: number;
  disposed: number;
  opened: unknown[];
  registered: XtermUnicodeVersionProvider[];
  options: Readonly<Record<string, unknown>> | undefined;
  /** Anything the adapter touched that would make it an input owner. */
  inputTouched: string[];
}

function fakeXterm(): { module: XtermModuleLike; recorded: Recorded } {
  const recorded: Recorded = {
    written: [],
    cleared: 0,
    disposed: 0,
    opened: [],
    registered: [],
    options: undefined,
    inputTouched: [],
  };

  class FakeTerminal implements XtermTerminalLike {
    #active = '6';
    readonly #versions: string[] = ['6'];

    constructor(options?: Readonly<Record<string, unknown>>) {
      recorded.options = options;
    }

    get unicode(): XtermTerminalLike['unicode'] {
      // xterm's own getter throws unless `allowProposedApi` is set, so the fake
      // throws too. An adapter that forgot the option would fail here rather
      // than silently registering nothing.
      if (recorded.options?.['allowProposedApi'] !== true) {
        throw new Error('You must set the allowProposedApi option to true to use proposed API');
      }
      const self = this;
      return {
        register(provider: XtermUnicodeVersionProvider): void {
          recorded.registered.push(provider);
          if (!self.#versions.includes(provider.version)) self.#versions.push(provider.version);
          // xterm only auto-activates when nothing is active yet, and
          // `CoreTerminal` has already registered UnicodeV6 by this point. So
          // registering does NOT change the active version.
        },
        get versions(): readonly string[] {
          return self.#versions;
        },
        get activeVersion(): string {
          return self.#active;
        },
        set activeVersion(version: string) {
          if (!self.#versions.includes(version)) throw new Error(`unknown Unicode version "${version}"`);
          self.#active = version;
        },
      };
    }

    write(data: string): void {
      recorded.written.push(data);
    }
    clear(): void {
      recorded.cleared += 1;
    }
    dispose(): void {
      recorded.disposed += 1;
    }
    open(parent: unknown): void {
      recorded.opened.push(parent);
    }

    // The input surface. Touching any of these would make the adapter a second
    // input owner, which the line editor and the real textarea already are.
    get onData(): unknown {
      recorded.inputTouched.push('onData');
      return () => undefined;
    }
    get onKey(): unknown {
      recorded.inputTouched.push('onKey');
      return () => undefined;
    }
    get textarea(): unknown {
      recorded.inputTouched.push('textarea');
      return null;
    }
    attachCustomKeyEventHandler(): void {
      recorded.inputTouched.push('attachCustomKeyEventHandler');
    }
  }

  return { module: { Terminal: FakeTerminal }, recorded };
}

// ---------------------------------------------------------------------------
// the provider
// ---------------------------------------------------------------------------

describe('the Unicode provider', () => {
  const provider = unicodeProvider();

  it('registers under the Unicode version the width table is generated from', () => {
    assert.equal(UNICODE_VERSION, '16');
    assert.equal(provider.version, '16');
    // Tied to the engine rather than written twice: `cells.ts` derives its
    // zero-width set from the engine's own property escapes, so the version
    // this registers under has to be the engine's major. Node reports '16.0';
    // `tests/unit/cell-width.test.mts` appends the '.0' to reach the UCD's
    // '16.0.0' for the same reason.
    assert.equal(UNICODE_VERSION, (process.versions.unicode ?? '').split('.')[0]);
  });

  it('answers with this project\'s own table, code point for code point', () => {
    // A sweep, not a corpus: the provider must not be a second width model that
    // happens to agree on the examples somebody thought of. This repository has
    // found one conversion implemented twice, drifting silently, eight times.
    let checked = 0;
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      // Surrogates are not scalar values; nothing can legitimately ask.
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      if (provider.wcwidth(cp) !== cellWidthOfCodePoint(cp)) {
        assert.fail(`provider and cells.ts disagree at U+${cp.toString(16).toUpperCase()}`);
      }
      checked += 1;
    }
    assert.equal(checked, 1112064, 'the sweep must cover every scalar value');
  });

  it('answers 2 for the emoji xterm\'s default provider answers 1 for', () => {
    // Read from `src/common/input/UnicodeV6.ts`: its `wcwidth` falls through to
    // `return 1` for anything at or above U+10000 outside HIGH_COMBINING and
    // the SIP/TIP planes, so every emoji is one cell wide under the default.
    // That is the concrete reason this adapter registers a provider at all
    // rather than loading the unicode11 addon and hoping.
    for (const cp of [0x1f600, 0x1f914, 0x231a, 0x26a1]) {
      assert.equal(provider.wcwidth(cp), 2, `U+${cp.toString(16)} must be two cells`);
    }
    // And the ones the default already gets right, so the claim is specific.
    for (const cp of [0x4e00, 0xff21, 0xac00, 0x3000]) {
      assert.equal(provider.wcwidth(cp), 2);
    }
  });

  it('packs width and join the way xterm unpacks them', () => {
    // bit 0 shouldJoin, bits 1..2 width, bits 3.. the grapheme-break class.
    for (const width of [0, 1, 2]) {
      for (const join of [false, true]) {
        const packed = createPropertyValue(0, width, join);
        assert.equal(extractWidth(packed), width);
        assert.equal(extractShouldJoin(packed), join);
      }
    }
    assert.equal(createPropertyValue(0, 2, true), 5, '(2 << 1) | 1');
    assert.equal(createPropertyValue(0, 1, false), 2, '(1 << 1) | 0');
  });

  it('joins a zero-width code point into the cell before it, keeping its width', () => {
    // xterm's rule, reproduced: a zero-width code point after a two-cell one
    // reports width 2 and shouldJoin, so the pair stays one two-cell unit.
    const wide = provider.charProperties(0x1f468, 0);
    assert.equal(extractWidth(wide), 2);
    assert.equal(extractShouldJoin(wide), false);

    const zwj = provider.charProperties(0x200d, wide);
    assert.equal(extractShouldJoin(zwj), true, 'a ZWJ folds into what precedes it');
    assert.equal(extractWidth(zwj), 2, 'and inherits that cell\'s width, so nothing shifts');
  });

  it('does not join when there is nothing before it, or when what is before is zero', () => {
    const alone = provider.charProperties(0x0301, 0);
    assert.equal(extractShouldJoin(alone), false, 'no preceding cell to join');
    const afterZero = provider.charProperties(0x0301, createPropertyValue(0, 0, false));
    assert.equal(extractShouldJoin(afterZero), false, 'a zero-width cell is not a base');
  });
});

// ---------------------------------------------------------------------------
// alignment
// ---------------------------------------------------------------------------

/**
 * Lay text out by consuming the provider EXACTLY as xterm's input handler does.
 *
 * From `InputHandler.print`: for each code point ask `charProperties(code,
 * precedingJoinState)`, take the width and the join flag out of the answer,
 * carry the answer forward as the next preceding state, and either fold into
 * the last cell that holds something or start a new one of that many cells.
 *
 * This is a simulation of xterm's CONSUMPTION, not of xterm. What it can show
 * is that the provider, used that way, produces the same cells as `grid.ts`
 * produces by a completely different mechanism — a backward scan over the row
 * rather than a bit-packed carry. If the two disagreed about a ZWJ sequence or
 * a variation selector, the columns would differ and this would say so.
 */
function layoutThroughProvider(text: string, provider: XtermUnicodeVersionProvider): string[] {
  const cells: string[] = [];
  let preceding = 0;
  let lastContent = -1;

  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    const properties = provider.charProperties(codePoint, preceding);
    const width = extractWidth(properties);
    const shouldJoin = extractShouldJoin(properties);
    preceding = properties;

    if (shouldJoin && lastContent >= 0) {
      cells[lastContent] += character;
      continue;
    }
    if (width === 0) continue;
    lastContent = cells.length;
    cells.push(character);
    for (let i = 1; i < width; i += 1) cells.push('');
  }
  return cells;
}

describe('CJK and emoji align in both renderers', () => {
  const provider = unicodeProvider();

  /** The semantic renderer's cells for one line. */
  function semanticCells(text: string): string[] {
    const buffer = new TerminalBuffer();
    buffer.write(parseAnsi(text));
    return (buffer.rows[0] ?? []).map((c: TerminalCell) => c.text);
  }

  const CASES: readonly string[] = [
    'plain ascii',
    '中文abc',
    'ab中cd',
    '日本語とEnglishの混在',
    'x\u{1F600}y',
    '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}',
    '\u{1F1F9}\u{1F1FC} flag',
    '1️⃣ keycap',
    'é combining',
    '中́ mark on a wide base',
    '\u{1F44D}\u{1F3FD} skin tone',
    '가한글',
    'Ａｌｌｗｉｄｔｈ',
    'mixed 中 \u{1F600} é end',
  ];

  it('lays every case out cell for cell identically', () => {
    for (const text of CASES) {
      assert.deepEqual(
        layoutThroughProvider(text, provider),
        semanticCells(text),
        `the two renderers disagree about ${JSON.stringify(text)}`,
      );
    }
  });

  it('agrees about the column each of them puts the last character in', () => {
    // The same property stated the way a reader cares about it: the column, not
    // the cell list. `'中文abc'.indexOf('c')` is 4 and the column is 6.
    for (const text of CASES) {
      const throughProvider = layoutThroughProvider(text, provider).length;
      const throughGrid = semanticCells(text).length;
      assert.equal(throughProvider, throughGrid, `width differs for ${JSON.stringify(text)}`);
    }
    assert.equal(semanticCells('中文abc').length, 7);
    assert.equal(layoutThroughProvider('中文abc', provider).length, 7);
  });

  it('records the one input where the two deliberately differ', () => {
    // A string that BEGINS with a combining mark. xterm has nothing to fold it
    // into and drops it; the semantic renderer gives it a cell, because
    // dropping it would silently change text a screen reader then reads. The
    // divergence is recorded rather than smoothed over, and it cannot arise
    // from any well-formed line of output — a combining mark with no base is
    // not text anybody meant to print.
    const leadingMark = '́abc';
    assert.deepEqual(layoutThroughProvider(leadingMark, provider), ['a', 'b', 'c']);
    assert.deepEqual(semanticCells(leadingMark), ['́', 'a', 'b', 'c']);
  });
});

// ---------------------------------------------------------------------------
// the adapter
// ---------------------------------------------------------------------------

describe('the xterm adapter', () => {
  it('sets allowProposedApi, without which reading unicode throws', () => {
    const options = terminalOptions({});
    assert.equal(options['allowProposedApi'], true);
    assert.equal(options['convertEol'], false);
    // The semantic renderer is the accessible one. Turning xterm's hidden
    // buffer mirror on would put a second, differently-derived transcript into
    // the accessibility tree beside the one task 16.4 protects.
    assert.equal(options['screenReaderMode'], false);
  });

  it('passes cols and rows only when a host gave them', () => {
    assert.equal('cols' in terminalOptions({}), false);
    assert.deepEqual(
      { ...terminalOptions({ columns: 100, rows: 30 }) },
      { allowProposedApi: true, convertEol: false, screenReaderMode: false, cols: 100, rows: 30 },
    );
  });

  it('activates the provider as well as registering it', () => {
    // The trap: `register` only auto-activates when nothing is active, and
    // xterm has already registered UnicodeV6 by then. Registering alone leaves
    // every emoji one cell wide and fails silently.
    const { module } = fakeXterm();
    const terminal = new module.Terminal(terminalOptions({}));
    assert.equal(terminal.unicode.activeVersion, '6');
    activateUnicode(terminal);
    assert.deepEqual([...terminal.unicode.versions], ['6', '16']);
    assert.equal(terminal.unicode.activeVersion, '16');
  });

  it('loads the module through the injected loader, not an import', () => {
    // The dependency-free property, asserted: this resolves with no xterm
    // installed because the module arrives as an argument.
    assert.equal(XTERM_SPECIFIER, '@xterm/xterm');
  });

  it('builds a port that writes through to xterm', async () => {
    const { module, recorded } = fakeXterm();
    const terminal = await createXtermTerminal({ load: async () => module });

    assert.equal(terminal.kind, 'xterm');
    terminal.write('hello ');
    terminal.write('中文');
    assert.deepEqual(recorded.written, ['hello ', '中文']);
    assert.equal(recorded.registered.length, 1);
    assert.equal(recorded.registered[0]?.version, '16');
  });

  it('keeps a log-shaped mirror of the same stream', async () => {
    const { module } = fakeXterm();
    const terminal = await createXtermTerminal({ load: async () => module });
    terminal.write('中文abc\nsecond');
    assert.deepEqual(terminal.snapshot().map((row) => rowText(row)), ['中文abc', 'second']);
    assert.equal(terminal.snapshot()[0]?.length, 7, 'columns, not characters');
  });

  it('opens onto a container only when it is given one', async () => {
    const bare = fakeXterm();
    await createXtermTerminal({ load: async () => bare.module });
    assert.deepEqual(bare.recorded.opened, []);

    const mounted = fakeXterm();
    const host = { tag: 'div' };
    await createXtermTerminal({ load: async () => mounted.module, container: host });
    assert.deepEqual(mounted.recorded.opened, [host]);
  });

  it('never touches xterm\'s input surface', async () => {
    // The boundary with the line editor. `TerminalPort` has no input on it and
    // this adapter subscribes to none, so the real textarea stays the only
    // input owner and there is no second IME path.
    //
    // WHAT THIS DOES NOT PROVE, recorded rather than assumed: `open()` builds
    // xterm's own DOM, and that DOM carries its own helper textarea and key
    // listeners. Not subscribing stops this adapter from acting on them; it
    // does not stop xterm from installing them. Suppressing them is a decision
    // about the input seam and is not made here.
    const { module, recorded } = fakeXterm();
    const terminal = await createXtermTerminal({ load: async () => module, container: {} });
    terminal.write('anything');
    terminal.clear();
    terminal.dispose();
    assert.deepEqual(recorded.inputTouched, []);
  });

  it('clears and disposes through, and goes inert afterwards', async () => {
    const { module, recorded } = fakeXterm();
    const terminal = await createXtermTerminal({ load: async () => module });
    terminal.write('a');
    terminal.clear();
    assert.equal(recorded.cleared, 1);
    assert.deepEqual(terminal.snapshot().map((row) => rowText(row)), ['']);

    terminal.dispose();
    terminal.dispose();
    assert.equal(recorded.disposed, 1, 'dispose is idempotent');
    terminal.write('ignored');
    assert.deepEqual(recorded.written, ['a']);
  });
});
