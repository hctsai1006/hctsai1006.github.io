/**
 * renderer-semantic.test.mts — the default renderer, held to v1's output.
 *
 * WHAT COUNTS AS "SCREEN-READER OUTPUT" HERE IS NOT AN OPINION. v1's golden
 * transcripts are captured by `tools/capture-v1.mts` as the `textContent` of
 * every `.row` under `#out`, in a real Chromium — that is literally the line in
 * the file. So the 128 files under `tests/conformance/fixtures/v1/` ARE the
 * accessible text of v1's log region, and replaying them through this renderer
 * is a direct test of task 16.4's "screen-reader output is unchanged in the
 * default renderer".
 *
 * The live-region attributes are checked the same way: read out of
 * `legacy/terminal-v1.html` rather than restated, so a change on either side
 * fails rather than one of them quietly becoming the reference for the other.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { MAX_ROWS, runsOf } from '../../src/renderer/grid.ts';
import {
  createSemanticTerminal,
  DEFAULT_LOG_LABEL,
  LOG_REGION_ATOMIC,
  LOG_REGION_LIVE,
  LOG_REGION_ROLE,
  ROW_CLASS,
  styleAttribute,
  styleClasses,
  type TerminalDocument,
} from '../../src/renderer/semantic.ts';
import { applySgr, DEFAULT_STYLE } from '../../src/renderer/ansi.ts';
import { fakeHost, FakeElement } from './renderer-dom-fake.mts';

const ESC = '\u001b';
const CSI = `${ESC}[`;

const FIXTURES = join(import.meta.dirname, '..', 'conformance', 'fixtures', 'v1');
const ARCHIVE = join(import.meta.dirname, '..', '..', 'legacy', 'terminal-v1.html');

/** LF-normalised, the way `tools/v1-fixtures.mts` reads them. */
const lf = (text: string): string => text.replace(/\r\n/g, '\n');

/** One transcript's rows: the file is one printed row per line, trailing LF. */
function transcriptRows(file: string): string[] {
  const text = lf(readFileSync(join(FIXTURES, file), 'utf8'));
  if (text === '') return [];
  return text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
}

describe('the live region', () => {
  it('carries exactly the attributes v1 puts on #out', () => {
    // Read from the archive, not restated. The point of the assertion is that
    // the two agree; hard-coding both sides would make it agree with itself.
    const archive = readFileSync(ARCHIVE, 'utf8');
    const tag = /<div id="out"[^>]*>/.exec(archive);
    assert.ok(tag !== null, 'legacy/terminal-v1.html no longer has a #out div');

    const attribute = (name: string): string | null => {
      const found = new RegExp(`${name}="([^"]*)"`).exec(tag[0]);
      return found === null ? null : (found[1] ?? null);
    };

    assert.equal(attribute('role'), LOG_REGION_ROLE);
    assert.equal(attribute('aria-live'), LOG_REGION_LIVE);
    assert.equal(attribute('aria-atomic'), LOG_REGION_ATOMIC);
    assert.equal(attribute('aria-label'), DEFAULT_LOG_LABEL);
  });

  it('sets them on the container before anything is written', () => {
    const { document, container } = fakeHost();
    createSemanticTerminal({ document, container });
    assert.equal(container.attributes.get('role'), 'log');
    assert.equal(container.attributes.get('aria-live'), 'polite');
    assert.equal(container.attributes.get('aria-atomic'), 'false');
    assert.equal(container.attributes.get('aria-label'), DEFAULT_LOG_LABEL);
  });

  it('takes its row class and row cap from v1 rather than restating them', () => {
    // Two more constants whose justification is "because v1 says so". Checked
    // against the archive for the same reason the aria attributes are: a
    // comment that cites a file nobody reads is a comment that can go stale.
    const archive = readFileSync(ARCHIVE, 'utf8');
    assert.match(archive, /d\.className='row'/, 'v1 no longer classes its rows "row"');
    assert.equal(ROW_CLASS, 'row');
    const cap = /const MAXROWS=(\d+)/.exec(archive);
    assert.ok(cap !== null, 'v1 no longer declares MAXROWS');
    assert.equal(MAX_ROWS, Number(cap[1]));
  });

  it('lets a host in another language change the label and nothing else', () => {
    const { document, container } = fakeHost();
    createSemanticTerminal({ document, container, label: 'Console output' });
    assert.equal(container.attributes.get('aria-label'), 'Console output');
    assert.equal(container.attributes.get('aria-live'), 'polite');
  });
});

describe('the accessible text of v1, replayed', () => {
  /**
   * The four rows in the whole corpus that a terminal renders differently from
   * v1, and what it renders them as.
   *
   * v1 put a raw TAB into a text node and let `white-space: pre-wrap` draw it.
   * This renderer is a terminal emulator, so it advances to the next stop at a
   * multiple of eight and writes blanks — which is what xterm.js does with the
   * same bytes, and the reason the two renderers can be said to align at all.
   * Keeping the raw tab would make this renderer's columns disagree with the
   * ANSI one's on every line containing one.
   *
   * The expansions are written out rather than computed: `Distributor ID:` is
   * 15 columns, so the next stop is 16 and one blank is written; `Description:`
   * is 12, so four; `Release:` is 8, so eight; `Codename:` is 9, so seven.
   */
  const TAB_EXPANSIONS = new Map<string, string>([
    ['Distributor ID:\tUbuntu', 'Distributor ID: Ubuntu'],
    ['Description:\tUbuntu 24.04.4 LTS', 'Description:    Ubuntu 24.04.4 LTS'],
    ['Release:\t24.04', 'Release:        24.04'],
    ['Codename:\tnoble', 'Codename:       noble'],
  ]);

  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.txt')).sort();

  it('has a corpus to replay at all', () => {
    // The failure mode this repository is organised against: every assertion
    // below passes vacuously over an empty list.
    assert.equal(files.length, 128, 'the v1 fixture set changed size');
    const rows = files.reduce((n, f) => n + transcriptRows(f).length, 0);
    assert.equal(rows, 1102, 'the number of captured rows changed');
  });

  it('reproduces every captured row byte for byte, but for expanded tabs', () => {
    const problems: string[] = [];
    let compared = 0;
    let expanded = 0;

    for (const file of files) {
      const rows = transcriptRows(file);
      const { document, container, rows: rendered } = fakeHost();
      const terminal = createSemanticTerminal({ document, container });
      for (const row of rows) terminal.write(`${row}\n`);

      const produced = rendered();
      // One trailing element for the row the cursor is on after the last LF,
      // which is empty and is what a real terminal shows.
      assert.equal(
        produced.length,
        rows.length + 1,
        `${file}: ${String(produced.length)} elements for ${String(rows.length)} rows`,
      );

      rows.forEach((row, index) => {
        compared += 1;
        const expected = TAB_EXPANSIONS.get(row) ?? row;
        if (expected !== row) expanded += 1;
        const actual = produced[index]?.textContent ?? null;
        if (actual !== expected) {
          problems.push(
            `${file}:${String(index + 1)} expected ${JSON.stringify(expected)} ` +
              `but rendered ${JSON.stringify(actual)}`,
          );
        }
      });
      assert.equal(produced[rows.length]?.textContent, '');
    }

    assert.deepEqual(problems.slice(0, 10), [], `${String(problems.length)} rows differ`);
    assert.equal(compared, 1102);
    assert.equal(expanded, 4, 'exactly four rows in the corpus contain a tab');
  });

  it('gives every row v1\'s class, so the CSS and the capture still select it', () => {
    const { document, container, rows } = fakeHost();
    const terminal = createSemanticTerminal({ document, container });
    terminal.write('one\ntwo\n');
    assert.deepEqual(rows().map((r) => r.className), [ROW_CLASS, ROW_CLASS, ROW_CLASS]);
    assert.deepEqual(rows().map((r) => r.nodeName), ['div', 'div', 'div']);
  });
});

describe('the DOM it builds', () => {
  it('puts unstyled text in a text node, with no wrapper element', () => {
    // v1 writes `d.textContent = txt` and only creates a span when there is a
    // class for it. An extra wrapper changes how some screen readers chunk a
    // line, so "no span unless there is a reason" is kept rather than
    // rediscovered.
    const { document, container, rows } = fakeHost();
    const terminal = createSemanticTerminal({ document, container });
    terminal.write('plain text');
    const row = rows()[0];
    assert.ok(row !== undefined);
    assert.deepEqual(row.elements(), [], 'a plain row must contain no elements');
    assert.equal(row.textContent, 'plain text');
  });

  it('wraps a styled run in a span and names the attributes as classes', () => {
    const { document, container, rows } = fakeHost();
    const terminal = createSemanticTerminal({ document, container });
    terminal.write(`plain ${CSI}1;31mred${CSI}0m after`);
    const row = rows()[0];
    assert.ok(row !== undefined);

    const spans = row.elements();
    assert.equal(spans.length, 1, 'only the styled run gets an element');
    assert.equal(spans[0]?.nodeName, 'span');
    assert.equal(spans[0]?.className, 'ansi-bold ansi-fg-1');
    assert.equal(spans[0]?.textContent, 'red');
    // And the row's own text is still the whole line, sequences gone.
    assert.equal(row.textContent, 'plain red after');
  });

  it('keeps an escape sequence out of the accessible text entirely', () => {
    // An unstripped escape is announced character by character. This is the
    // reason the renderer parses rather than assigning the chunk to textContent.
    const { document, container, rows } = fakeHost();
    const terminal = createSemanticTerminal({ document, container });
    terminal.write(`${ESC}]0;a window title${CSI}?25l${CSI}38;5;214mtext${CSI}0m`);
    assert.equal(rows()[0]?.textContent, 'text');
  });

  it('names an indexed colour as a class and only inlines truecolour', () => {
    // The palette stays in CSS, where v1 keeps every colour, so a theme can
    // change it. Truecolour has no index to name, so it is the one case that
    // gets an inline style.
    assert.deepEqual(styleClasses(applySgr(DEFAULT_STYLE, [[38], [5], [214]])), ['ansi-fg-214']);
    assert.equal(styleAttribute(applySgr(DEFAULT_STYLE, [[38], [5], [214]])), '');
    assert.deepEqual(styleClasses(applySgr(DEFAULT_STYLE, [[38], [2], [1], [2], [3]])), []);
    assert.equal(styleAttribute(applySgr(DEFAULT_STYLE, [[38], [2], [1], [2], [3]])), 'color:rgb(1,2,3)');
  });

  it('rewrites the last row in place as it grows, rather than appending twice', () => {
    const { document, container, rows } = fakeHost();
    const terminal = createSemanticTerminal({ document, container });
    terminal.write('par');
    terminal.write('tial');
    assert.equal(rows().length, 1);
    assert.equal(rows()[0]?.textContent, 'partial');
    terminal.write('\ndone');
    assert.deepEqual(rows().map((r) => r.textContent), ['partial', 'done']);
  });

  it('drops the elements for rows the cap discarded', () => {
    const { document, container, rows } = fakeHost();
    const terminal = createSemanticTerminal({ document, container, maxRows: 3 });
    terminal.write('a\nb\nc\nd\n');
    assert.deepEqual(rows().map((r) => r.textContent), ['c', 'd', '']);
  });

  it('empties the container on clear and keeps rendering after it', () => {
    const { document, container, rows } = fakeHost();
    const terminal = createSemanticTerminal({ document, container });
    terminal.write('gone\n');
    terminal.clear();
    assert.deepEqual(rows().map((r) => r.textContent), ['']);
    terminal.write('after');
    assert.deepEqual(rows().map((r) => r.textContent), ['after']);
  });

  it('stops writing once disposed', () => {
    const { document, container, rows } = fakeHost();
    const terminal = createSemanticTerminal({ document, container });
    terminal.write('before\n');
    terminal.dispose();
    terminal.write('after');
    assert.deepEqual(rows(), []);
  });
});

describe('the port contract', () => {
  it('names itself the semantic renderer', () => {
    const { document, container } = fakeHost();
    assert.equal(createSemanticTerminal({ document, container }).kind, 'semantic');
  });

  it('reports the sequences it could not honour', () => {
    const { document, container } = fakeHost();
    const terminal = createSemanticTerminal({ document, container });
    terminal.write(`${CSI}2Atext`);
    assert.equal(terminal.unsupported.length, 1);
    assert.equal(terminal.unsupported[0]?.sequence, 'CSI 2A');
  });

  it('exposes the snapshot in cells, so CJK columns can be read off it', () => {
    const { document, container } = fakeHost();
    const terminal = createSemanticTerminal({ document, container });
    terminal.write('中文abc');
    const first = terminal.snapshot()[0] ?? [];
    assert.equal(first.length, 7);
    assert.deepEqual(
      runsOf(first).map((r) => [r.text, r.column, r.columns]),
      [['中文abc', 0, 7]],
    );
  });

  it('a real DOM Document satisfies the narrow port it declares', () => {
    // A compile-time claim with a runtime assertion behind it: if `Document`
    // ever stopped being assignable to `TerminalDocument`, this file would not
    // type-check, and `npm run typecheck` is a gate.
    const asPort = (real: Document): TerminalDocument => real;
    assert.equal(typeof asPort, 'function');
  });

  it('a fake element really is what the renderer writes into', () => {
    // Guards the fake itself: a `textContent` that only read direct children
    // would report the plain rows correctly and lose every styled one.
    const element = new FakeElement('div');
    const inner = new FakeElement('span');
    inner.append('deep');
    element.append('shallow ', inner);
    assert.equal(element.textContent, 'shallow deep');
  });
});
