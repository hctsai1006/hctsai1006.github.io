/**
 * renderer-grid.test.mts — which column each character lands in.
 *
 * The expectations here are HAND-DERIVED from Unicode properties and written
 * out as literals, not computed from the function under test. That is the only
 * way this file says anything: a test that asks `displayWidth` where a
 * character goes and then checks the answer against `displayWidth` passes
 * whatever either of them does. So every column below is written down, with the
 * reasoning that produced it beside it.
 *
 * PR-16's acceptance condition is "CJK and emoji align in both renderers". This
 * is the first half — that the shared grid puts them where a cell terminal
 * would. The second half, that the xterm adapter measures with the same table,
 * is in `renderer-xterm.test.mts`.
 *
 * Escapes are written `\u001b`, never as the byte. See the note at the top of
 * `renderer-ansi.test.mts`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseAnsi } from '../../src/renderer/ansi.ts';
import { MAX_ROWS, rowText, runsOf, TerminalBuffer } from '../../src/renderer/grid.ts';
import type { TerminalCell } from '../../src/renderer/grid.ts';

const ESC = '\u001b';
const CSI = `${ESC}[`;

const ZWJ = '‍';
const FAMILY = `\u{1F468}${ZWJ}\u{1F469}${ZWJ}\u{1F467}${ZWJ}\u{1F466}`;
const FLAG_TW = '\u{1F1F9}\u{1F1FC}';
const KEYCAP_ONE = '1️⃣';
const E_ACUTE = 'é';

/** Feed strings through the parser into a fresh buffer. */
function draw(...chunks: readonly string[]): TerminalBuffer {
  const buffer = new TerminalBuffer();
  for (const chunk of chunks) buffer.write(parseAnsi(chunk));
  return buffer;
}

const line = (buffer: TerminalBuffer, index = 0): readonly TerminalCell[] =>
  buffer.rows[index] ?? [];

/** The text of each cell. The right half of a wide cell shows as ''. */
const cellTexts = (cells: readonly TerminalCell[]): string[] => cells.map((c) => c.text);

describe('where a character lands', () => {
  it('gives ASCII one cell each', () => {
    assert.deepEqual(cellTexts(line(draw('abc'))), ['a', 'b', 'c']);
  });

  it('gives a CJK ideograph two cells, the second of which holds nothing', () => {
    // U+4E2D is East_Asian_Width=Wide. The right half is not a space: a space
    // is something somebody wrote, and reconstructing the row's text depends on
    // being able to tell the two apart.
    const cells = line(draw('中文abc'));
    assert.deepEqual(cellTexts(cells), ['中', '', '文', '', 'a', 'b', 'c']);
    assert.equal(cells.length, 7, 'two ideographs and three letters occupy seven columns');
  });

  it('puts the letter after two ideographs in column 4, not column 2', () => {
    // The whole phase in one assertion. `'中文abc'.indexOf('a')` is 2; the
    // column is 4. A renderer measuring by string length draws `a` two columns
    // left of where a cell terminal puts it.
    const cells = line(draw('中文abc'));
    assert.equal(cells.findIndex((c) => c.text === 'a'), 4);
    assert.equal('中文abc'.indexOf('a'), 2, 'the string index really does disagree');
  });

  it('gives an emoji two cells', () => {
    // U+1F600 is East_Asian_Width=Wide from Unicode 9 onwards. xterm.js's
    // DEFAULT provider still answers 1 for it, which is the measured reason the
    // adapter registers ours instead.
    const cells = line(draw('x\u{1F600}y'));
    assert.deepEqual(cellTexts(cells), ['x', '\u{1F600}', '', 'y']);
    assert.equal(cells.findIndex((c) => c.text === 'y'), 3);
  });

  it('folds a combining mark into the cell before it', () => {
    // `e` + U+0301 is one cell holding two code points, which is what a
    // terminal draws and what a reader should be handed as one unit.
    assert.deepEqual(cellTexts(line(draw(`${E_ACUTE}x`))), [E_ACUTE, 'x']);
  });

  it('folds a mark past the empty half of a wide cell, not into it', () => {
    // The mark belongs to 中, and 中 lives in the LEFT cell. Appending it to
    // the right half would put a character where nothing is drawn, and the
    // row's text would then read it out in the wrong place.
    const cells = line(draw('中́'));
    assert.deepEqual(cellTexts(cells), ['中́', '']);
    assert.equal(cells.length, 2);
  });

  it('spends eight cells on a ZWJ family, which is what a cell grid draws', () => {
    // Four people at two cells each; the three ZWJs are Cf and cost nothing.
    // `src/line-editor/cells.ts` calls this "the honest answer, not the pretty
    // one" — a terminal that cannot shape the sequence draws four emoji.
    const cells = line(draw(FAMILY));
    assert.equal(cells.length, 8);
    assert.equal(rowText(cells), FAMILY, 'the text must survive the round trip');
  });

  it('spends two cells on a flag and one on a keycap', () => {
    // Regional indicators are East_Asian_Width=Neutral, so 🇹🇼 is 1 + 1.
    // A keycap is a digit plus VS16 plus U+20E3, and both of those are zero.
    assert.equal(line(draw(FLAG_TW)).length, 2);
    assert.equal(line(draw(KEYCAP_ONE)).length, 1);
  });

  it('reconstructs the written text exactly, for every shape above', () => {
    // The property task 16.4 rests on: the accessible text of a rendered row is
    // the concatenation of its runs, so it has to equal what was written.
    for (const source of ['abc', '中文abc', `${E_ACUTE}x`, 'x\u{1F600}y', FAMILY, FLAG_TW, KEYCAP_ONE, '中́']) {
      const cells = line(draw(source));
      assert.equal(rowText(cells), source, `round trip failed for ${JSON.stringify(source)}`);
      assert.equal(
        runsOf(cells).map((r) => r.text).join(''),
        source,
        `runs lost text for ${JSON.stringify(source)}`,
      );
    }
  });
});

describe('runs', () => {
  it('reports a column and a width in cells, not in characters', () => {
    const runs = runsOf(line(draw(`${CSI}31m中文${CSI}0mab`)));
    assert.deepEqual(
      runs.map((r) => [r.text, r.column, r.columns]),
      [
        ['中文', 0, 4],
        ['ab', 4, 2],
      ],
    );
  });

  it('does not split a wide character across two runs when the style changes', () => {
    // A style change lands between cells; a wide character occupies two. If the
    // continuation half started its own run, the DOM would get a node with no
    // text but a width, and every column after it would shift.
    const runs = runsOf(line(draw(`${CSI}31m中${CSI}0m`)));
    assert.equal(runs.length, 1);
    assert.deepEqual([runs[0]?.text, runs[0]?.columns], ['中', 2]);
  });

  it('merges adjacent cells that look the same into one run', () => {
    const runs = runsOf(line(draw(`${CSI}1mbold ${CSI}1mstill bold`)));
    assert.equal(runs.length, 1, 'setting the same attribute twice is not a boundary');
    assert.equal(runs[0]?.text, 'bold still bold');
  });
});

describe('the controls a terminal acts on', () => {
  it('moves to column 0 on CR and overwrites from there', () => {
    assert.equal(rowText(line(draw('abcdef\rXY'))), 'XYcdef');
  });

  it('blanks the orphaned half when a write splits a wide character', () => {
    // Overwriting 中 with `x` leaves the cell that used to be its right half.
    // Left as a continuation it would make `x` two columns wide — a real
    // terminal blanks it, and so does this.
    const cells = line(draw('中文\rx'));
    assert.deepEqual(cellTexts(cells), ['x', ' ', '文', '']);
    assert.equal(rowText(cells), 'x 文');
  });

  it('blanks the left half when a write lands on the right half', () => {
    // CHA is 1-based, so column 4 is index 3 — the continuation cell of 中.
    assert.deepEqual(cellTexts(line(draw(`ab中\r${CSI}4Gy`))), ['a', 'b', ' ', 'y']);
  });

  it('lands on the right half after backspacing off a wide character', () => {
    assert.deepEqual(cellTexts(line(draw('中\bx'))), [' ', 'x']);
  });

  it('advances to the next multiple of eight on TAB, counting cells', () => {
    assert.equal(rowText(line(draw('ab\tc'))), 'ab      c');
    // 中 has already spent two columns, so the stop is still 8 and only six
    // blanks are written — not seven, which is what counting characters gives.
    assert.equal(rowText(line(draw('中\tx'))), '中      x');
    assert.equal(line(draw('中\tx')).length, 9);
  });

  it('moves back one cell on BS', () => {
    assert.equal(rowText(line(draw('abc\b\bX'))), 'aXc');
  });

  it('starts a new row on LF, VT and FF alike', () => {
    // VT and FF are index operations in the VT spec and every terminal treats
    // them as a linefeed.
    assert.equal(draw('a\nb\u000bc\u000cd').rows.length, 4);
  });

  it('does not leave half a wide character behind when erasing to the end', () => {
    // The cut lands on the RIGHT half of the ideograph, so the left half it
    // keeps has lost its partner. Before `#blank`/`#repairOverlap` covered the
    // erase paths this produced a row whose cells said four columns and whose
    // drawing took five, and nothing noticed.
    const cells = line(draw(`abc\u4e2d\r${CSI}5G${CSI}K`));
    assert.deepEqual(cellTexts(cells), ['a', 'b', 'c', ' ']);
    assert.equal(rowText(cells), 'abc ');
  });

  it('drops a wide character whole when the cut lands on its left half', () => {
    const cells = line(draw(`abc\u4e2d\r${CSI}4G${CSI}K`));
    assert.deepEqual(cellTexts(cells), ['a', 'b', 'c']);
  });

  it('repairs the same way when erasing back to the start of the line', () => {
    // EL 1 blanks through the cursor, which here is the left half of the
    // ideograph; its right half must go too.
    const cells = line(draw(`\u4e2dxy\r${CSI}1G${CSI}1K`));
    assert.deepEqual(cellTexts(cells), [' ', ' ', 'x', 'y']);
  });

  it('erases to the end of the line on CSI K', () => {
    assert.equal(rowText(line(draw(`abcdef\r${CSI}3G${CSI}K`))), 'ab');
  });

  it('clears everything on CSI 2J and keeps the colour', () => {
    const buffer = draw(`${CSI}31mred\nlines${CSI}2J`);
    assert.equal(buffer.rows.length, 1);
    // Clear-Host inside a coloured region does not end the colour; resetting it
    // here would make the next write come out in the wrong one.
    assert.deepEqual(buffer.style.foreground, { kind: 'palette', index: 1 });
  });

  it('resets style and screen alike on ESC c', () => {
    const buffer = draw(`${CSI}31mred${ESC}c`);
    assert.equal(buffer.rows.length, 1);
    assert.deepEqual(buffer.style.foreground, { kind: 'default' });
  });
});

describe('what the semantic grid refuses', () => {
  it('records a cursor move it cannot honour instead of guessing', () => {
    // A log renderer appends rows and never goes back up. Approximating CUU
    // would put text in the wrong row silently; recording it is how a host
    // learns to offer the ANSI renderer instead.
    const buffer = draw(`${CSI}5A`);
    assert.equal(buffer.unsupported.length, 1);
    assert.equal(buffer.unsupported[0]?.sequence, 'CSI 5A');
  });

  it('records a private mode and an OSC without drawing either', () => {
    const buffer = draw(`${CSI}?25l${ESC}]0;title\u0007text`);
    assert.equal(rowText(line(buffer)), 'text');
    assert.equal(buffer.unsupported.length, 2);
  });

  it('honours the moves that stay on the row, so they are not refused', () => {
    // CUF, CUB, CHA and ECH all stay on the current row, so they are real
    // operations here rather than approximations of one.
    const buffer = draw(`ab${CSI}3Cc${CSI}2Dx`);
    assert.deepEqual(buffer.unsupported, []);
    assert.equal(rowText(line(buffer)), 'ab  xc');
  });

  it('says nothing was refused for ordinary coloured output', () => {
    const buffer = draw(`${CSI}1;32mok${CSI}0m\nplain\n`);
    assert.deepEqual(buffer.unsupported, []);
  });
});

describe('the row cap', () => {
  it('drops the oldest rows and counts what it dropped', () => {
    const buffer = new TerminalBuffer(3);
    buffer.write(parseAnsi('a\nb\nc\nd\n'));
    assert.equal(buffer.rows.length, 3);
    assert.equal(buffer.trimmedRows, 2);
    assert.deepEqual(buffer.rows.map((r) => rowText(r)), ['c', 'd', '']);
  });

  it("defaults to v1's cap", () => {
    assert.equal(MAX_ROWS, 1500);
  });
});
