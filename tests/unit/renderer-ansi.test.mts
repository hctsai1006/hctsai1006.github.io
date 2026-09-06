/**
 * renderer-ansi.test.mts — the parser, and the separation it exists to make.
 *
 * Every escape in this file is written `\u001b` rather than as the byte. A raw
 * ESC in a source file is invisible in a diff, and this repository already has
 * a gate (`tools/check-source-bytes.mts`) that exists because three invisible
 * bytes shipped from one cause.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';

import {
  AnsiParser,
  applySgr,
  DEFAULT_STYLE,
  hasEscape,
  OMITTED,
  parseAnsi,
  stripAnsi,
  styleEquals,
  type AnsiEvent,
} from '../../src/renderer/ansi.ts';
import { DEFAULT_CULTURE } from '../../src/formatting/culture.ts';
import { renderDocument, type TableSection } from '../../src/formatting/views.ts';

const ESC = '\u001b';
const CSI = `${ESC}[`;

const texts = (events: readonly AnsiEvent[]): string =>
  events.map((e) => (e.kind === 'text' ? e.text : '')).join('');

describe('the ANSI parser', () => {
  it('passes plain text through untouched, sequence-free', () => {
    const events = parseAnsi('hello 中文 👋');
    assert.deepEqual(events, [{ kind: 'text', text: 'hello 中文 👋' }]);
  });

  it('reads an SGR sequence as a CSI with parameters', () => {
    assert.deepEqual(parseAnsi(`${CSI}1;31mred`), [
      { kind: 'csi', final: 'm', params: [[1], [31]], prefix: '', intermediates: '' },
      { kind: 'text', text: 'red' },
    ]);
  });

  it('tells no parameters apart from one omitted parameter', () => {
    // `\u001b[m` carries none; `\u001b[;m` carries two, both omitted.
    // Collapsing the two is harmless for SGR, whose default is 0 either way,
    // and wrong for any command that counts what it was given.
    assert.deepEqual(parseAnsi(`${CSI}m`), [
      { kind: 'csi', final: 'm', params: [], prefix: '', intermediates: '' },
    ]);
    assert.deepEqual(parseAnsi(`${CSI};m`), [
      { kind: 'csi', final: 'm', params: [[OMITTED], [OMITTED]], prefix: '', intermediates: '' },
    ]);
  });

  it('keeps a private-parameter prefix separate from the parameters', () => {
    assert.deepEqual(parseAnsi(`${CSI}?25l`), [
      { kind: 'csi', final: 'l', params: [[25]], prefix: '?', intermediates: '' },
    ]);
  });

  it('reads colon sub-parameters as one parameter, not several', () => {
    // The distinction is load-bearing: `38;5;214` and `38:5:214` mean the same
    // colour but arrive as three parameters and as one.
    assert.deepEqual(parseAnsi(`${CSI}38:2::12:34:56m`), [
      {
        kind: 'csi',
        final: 'm',
        params: [[38, 2, OMITTED, 12, 34, 56]],
        prefix: '',
        intermediates: '',
      },
    ]);
  });

  it('is resumable: a sequence split one character at a time parses identically', () => {
    // This is the property a regex cannot have, and the reason `AnsiParser` is a
    // class. A host writes what it has; a colour sequence really does arrive in
    // two pieces.
    const source = `plain${CSI}1;38;5;214mbright${CSI}0m tail`;
    const whole = parseAnsi(source);

    const parser = new AnsiParser();
    const piecemeal: AnsiEvent[] = [];
    for (const character of source) piecemeal.push(...parser.parse(character));

    // Character-at-a-time yields one text event per character, so the events
    // are compared after merging adjacent text runs — which is what a consumer
    // does anyway.
    const merge = (events: readonly AnsiEvent[]): AnsiEvent[] => {
      const out: AnsiEvent[] = [];
      for (const event of events) {
        const last = out[out.length - 1];
        if (event.kind === 'text' && last !== undefined && last.kind === 'text') {
          out[out.length - 1] = { kind: 'text', text: last.text + event.text };
          continue;
        }
        out.push(event);
      }
      return out;
    };

    assert.deepEqual(merge(piecemeal), merge(whole));
    assert.equal(texts(whole), 'plainbright tail');
  });

  it('reports a sequence as pending until it is finished', () => {
    const parser = new AnsiParser();
    assert.deepEqual(parser.parse(`ab${CSI}3`), [{ kind: 'text', text: 'ab' }]);
    assert.equal(parser.pending, true, 'a half-written CSI is still open');
    assert.deepEqual(parser.parse('1mc'), [
      { kind: 'csi', final: 'm', params: [[31]], prefix: '', intermediates: '' },
      { kind: 'text', text: 'c' },
    ]);
    assert.equal(parser.pending, false);
  });

  it('discards a malformed CSI whole rather than printing its tail', () => {
    // The defect roadmap 16.2 names — "VT Reset sequences appearing
    // mid-string" — is this one seen from the outside: a parser that gives up
    // in the middle of a sequence prints the rest of it. `<` is legal only
    // as the FIRST byte of a CSI, so meeting one among the parameters sends
    // the whole sequence to CSI_IGNORE, tail and all.
    assert.deepEqual(parseAnsi(`a${CSI}1;2<mb`), [
      { kind: 'text', text: 'a' },
      { kind: 'text', text: 'b' },
    ]);
  });

  it('lets CAN abort a sequence from inside it', () => {
    assert.equal(texts(parseAnsi(`a${CSI}31\u0018b`)), 'ab');
  });

  it('collects an OSC terminated by BEL and by ST alike', () => {
    assert.deepEqual(parseAnsi(`${ESC}]0;a title\u0007x`), [
      { kind: 'osc', identifier: 0, data: 'a title' },
      { kind: 'text', text: 'x' },
    ]);
    assert.deepEqual(parseAnsi(`${ESC}]0;a title${ESC}\\x`), [
      { kind: 'osc', identifier: 0, data: 'a title' },
      { kind: 'esc', final: '\\', intermediates: '' },
      { kind: 'text', text: 'x' },
    ]);
  });

  it('executes CR and LF, and drops the C0 controls a terminal does not act on', () => {
    const events = parseAnsi('a\u0000b\r\nc\u0007');
    assert.deepEqual(events, [
      { kind: 'text', text: 'a' },
      { kind: 'text', text: 'b' },
      { kind: 'execute', code: 0x0d },
      { kind: 'execute', code: 0x0a },
      { kind: 'text', text: 'c' },
    ]);
  });

  it('reads an ESC with intermediates as a designation, not as text', () => {
    assert.deepEqual(parseAnsi(`${ESC}(Bx`), [
      { kind: 'esc', final: 'B', intermediates: '(' },
      { kind: 'text', text: 'x' },
    ]);
  });
});

describe('SGR folding', () => {
  it('treats an omitted parameter as a full reset', () => {
    const coloured = applySgr(DEFAULT_STYLE, [[31], [1]]);
    assert.equal(coloured.bold, true);
    assert.ok(styleEquals(applySgr(coloured, [[OMITTED]]), DEFAULT_STYLE));
    assert.ok(styleEquals(applySgr(coloured, []), DEFAULT_STYLE));
  });

  it('clears dim as well as bold on 22, because they are one attribute', () => {
    // ECMA-48 has one intensity attribute with three values. Clearing only bold
    // would leave dim text with no sequence that can turn it off.
    const both = applySgr(DEFAULT_STYLE, [[1], [2]]);
    assert.deepEqual([both.bold, both.dim], [true, true]);
    const cleared = applySgr(both, [[22]]);
    assert.deepEqual([cleared.bold, cleared.dim], [false, false]);
  });

  it('reads indexed and truecolour in both the semicolon and the colon spelling', () => {
    const semi = applySgr(DEFAULT_STYLE, [[38], [5], [214]]);
    const colon = applySgr(DEFAULT_STYLE, [[38, 5, 214]]);
    assert.deepEqual(semi.foreground, { kind: 'palette', index: 214 });
    assert.ok(styleEquals(semi, colon), 'the two spellings must fold identically');

    const rgbSemi = applySgr(DEFAULT_STYLE, [[48], [2], [1], [2], [3]]);
    const rgbColon = applySgr(DEFAULT_STYLE, [[48, 2, OMITTED, 1, 2, 3]]);
    assert.deepEqual(rgbSemi.background, { kind: 'rgb', r: 1, g: 2, b: 3 });
    assert.ok(styleEquals(rgbSemi, rgbColon), 'the empty colour-space slot must not shift the channels');
  });

  it('consumes the whole extended colour, so what follows it is not misread', () => {
    // The bug this guards: reading `38;5;214` as three separate codes makes the
    // `5` a blink and the `214` an unknown, and the red that follows never
    // arrives because the loop is out of step.
    const style = applySgr(DEFAULT_STYLE, [[38], [5], [214], [1]]);
    assert.deepEqual(style.foreground, { kind: 'palette', index: 214 });
    assert.equal(style.bold, true);
  });

  it('ignores an unknown attribute without abandoning the rest of the sequence', () => {
    // 53 is overline, which this renderer does not model. The red after it must
    // still land.
    const style = applySgr(DEFAULT_STYLE, [[1], [53], [31]]);
    assert.equal(style.bold, true);
    assert.deepEqual(style.foreground, { kind: 'palette', index: 1 });
  });

  it('maps the bright ranges into the top half of the palette', () => {
    assert.deepEqual(applySgr(DEFAULT_STYLE, [[91]]).foreground, { kind: 'palette', index: 9 });
    assert.deepEqual(applySgr(DEFAULT_STYLE, [[107]]).background, { kind: 'palette', index: 15 });
  });
});

describe('stripping', () => {
  it('removes sequences and keeps the newlines, because a newline is content', () => {
    assert.equal(stripAnsi(`${CSI}31mred${CSI}0m\nplain`), 'red\nplain');
    assert.equal(stripAnsi(`${ESC}]8;;https://example.com\u0007link${ESC}]8;;\u0007`), 'link');
  });

  it('answers hasEscape on the escape, not on every control character', () => {
    assert.equal(hasEscape('plain text\n'), false);
    assert.equal(hasEscape(`${CSI}0m`), true);
  });
});

describe('why the parser is separate from the formatter', () => {
  /**
   * The measurement in ansi.ts's header, reproduced so it cannot rot.
   *
   * The formatter sizes a column by DISPLAY WIDTH, and an escape sequence has
   * display width: ESC itself is zero, but `[31m` is four printable columns
   * that are never drawn. So a coloured cell claims columns it does not use and
   * every other row in the table is pushed right by the difference.
   */
  const coloured = `${CSI}31mfoo${CSI}0m`;

  const table = (cell: string): string[] => {
    const section: TableSection = {
      kind: 'table',
      columns: [
        { header: 'V', alignment: 'left' },
        { header: 'W', alignment: 'left' },
      ],
      groups: [{ label: null, rows: [[cell, 'x'], ['foo', 'y']] }],
      hideHeaders: false,
      wrap: false,
    };
    return renderDocument({ sections: [section] }, { width: 120, culture: DEFAULT_CULTURE });
  };

  it('a coloured cell misaligns the table by the printable length of its sequences', () => {
    const lines = table(coloured);
    const withColour = lines.find((l) => l.endsWith('x'));
    const plain = lines.find((l) => l.endsWith('y'));
    assert.ok(withColour !== undefined && plain !== undefined);

    // The plain row's `y` sits at column 11; the coloured row's `x` is DRAWN at
    // column 4, because only `foo` is visible. Seven columns of drift.
    assert.equal(plain.indexOf('y'), 11);
    assert.equal(stripAnsi(withColour).indexOf('x'), 4);
    assert.equal(plain.indexOf('y') - stripAnsi(withColour).indexOf('x'), 7);
  });

  it('the same table is aligned once the sequences are stripped before formatting', () => {
    // Selected by the trailing marker rather than by `startsWith('foo')`: once
    // the colour is gone BOTH rows start with `foo`, and picking the first
    // match found the same line twice.
    const lines = table(stripAnsi(coloured));
    const first = lines.find((l) => l.endsWith('x'));
    const second = lines.find((l) => l.endsWith('y'));
    assert.ok(first !== undefined && second !== undefined);
    assert.notEqual(first, second, 'the two rows must be different lines');
    assert.equal(first.indexOf('x'), second.indexOf('y'));
    assert.equal(first.indexOf('x'), 4);
  });

  it('nothing under src/formatting imports the renderer', () => {
    // The direction is the design. Formatting produces plain text and knows
    // nothing about escapes; the renderer is downstream and knows about
    // nothing else. An import the other way would put a second width model
    // inside the formatter, which is how this repository got two of them last
    // time.
    const directory = join(import.meta.dirname, '..', '..', 'src', 'formatting');
    const files = readdirSync(directory).filter((f) => f.endsWith('.ts'));
    assert.ok(files.length >= 8, `expected the whole formatter, found ${String(files.length)} files`);

    for (const file of files) {
      const source = readFileSync(join(directory, file), 'utf8');
      const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const specifiers: string[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
          const spec = node.moduleSpecifier;
          if (spec !== undefined && ts.isStringLiteralLike(spec)) specifiers.push(spec.text);
        }
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const first = node.arguments[0];
          if (first !== undefined && ts.isStringLiteralLike(first)) specifiers.push(first.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(tree);

      const offending = specifiers.filter((s) => s.includes('renderer'));
      assert.deepEqual(offending, [], `${file} imports ${offending.join(', ')}`);
    }
  });
});
