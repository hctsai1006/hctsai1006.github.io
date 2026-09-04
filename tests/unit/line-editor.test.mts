/**
 * Tests for the text buffer, grapheme arithmetic and the geometry port.
 *
 * The emoji and CJK cases are not decoration. v1 delegated caret motion to a
 * `<textarea>`, which silently guaranteed that Left never landed inside a
 * surrogate pair and Backspace never split a ZWJ sequence. Taking the textarea
 * away takes that guarantee away, so every one of these assertions is a
 * regression that WOULD have happened and would have shipped looking like a
 * rendering glitch rather than a caret bug.
 *
 * The literals are written as escapes rather than pasted characters so that a
 * mangled file encoding fails the test instead of quietly changing what is
 * being asserted.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  graphemeBoundaries,
  graphemeIndexAt,
  graphemeLength,
  hasIntlSegmenter,
  nextBoundary,
  prevBoundary,
  segmentGraphemes,
  segmentGraphemesFallback,
  snapToBoundary,
} from '../../src/line-editor/graphemes.ts';
import {
  charClassOf,
  DEFAULT_WORD_DELIMITERS,
  TextBuffer,
} from '../../src/line-editor/text-buffer.ts';
import { cellWidthOf, displayWidth, monospaceMetrics } from '../../src/line-editor/metrics.ts';

/** U+1F468 ZWJ U+1F469 ZWJ U+1F467 ZWJ U+1F466 — 11 code units, one cluster. */
const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}';
/** U+1F44D — two code units. */
const THUMBS = '\u{1F44D}';
/** U+1F1F9 U+1F1FC — a regional-indicator pair, four code units. */
const FLAG_TW = '\u{1F1F9}\u{1F1FC}';
/** U+1F44B U+1F3FD — base plus skin-tone modifier. */
const WAVE_TONE = '\u{1F44B}\u{1F3FD}';
/** e + U+0301 COMBINING ACUTE — two code units, one cluster. */
const E_ACUTE = 'é';
/** 測試 — CJK, one code unit each, two cells each. */
const CJK = '測試';

describe('grapheme segmentation', () => {
  it('counts what the user sees, not what UTF-16 stores', () => {
    assert.equal(FAMILY.length, 11);
    assert.equal(graphemeLength(FAMILY), 1);

    assert.equal(THUMBS.length, 2);
    assert.equal(graphemeLength(THUMBS), 1);

    assert.equal(FLAG_TW.length, 4);
    assert.equal(graphemeLength(FLAG_TW), 1);

    assert.equal(WAVE_TONE.length, 4);
    assert.equal(graphemeLength(WAVE_TONE), 1);

    assert.equal(E_ACUTE.length, 2);
    assert.equal(graphemeLength(E_ACUTE), 1);

    // CJK is the easy case: one code unit each. It is here because the terminal
    // supports it and because it is the width, not the count, that differs.
    assert.equal(CJK.length, 2);
    assert.equal(graphemeLength(CJK), 2);
  });

  it('agrees with the no-Intl fallback on every cluster shape', () => {
    // The fallback only runs where `Intl.Segmenter` is missing, which is nowhere
    // anybody tests. Pinning it against the real implementation is the only way
    // it stays correct.
    assert.equal(hasIntlSegmenter(), true);
    for (const sample of [
      FAMILY,
      THUMBS,
      FLAG_TW,
      WAVE_TONE,
      E_ACUTE,
      CJK,
      `a${FAMILY}b`,
      `${FLAG_TW}${FLAG_TW}`,
      'á̂',
      'x\r\ny',
      '',
    ]) {
      assert.deepEqual(
        segmentGraphemesFallback(sample),
        segmentGraphemes(sample),
        `fallback disagreed on ${JSON.stringify(sample)}`,
      );
    }
  });

  it('always yields boundaries spanning the whole string', () => {
    const b = graphemeBoundaries(`a${FAMILY}b`);
    assert.deepEqual(b, [0, 1, 12, 13]);
    assert.deepEqual(graphemeBoundaries(''), [0]);
  });

  it('snaps an illegal offset onto a boundary, in the requested direction', () => {
    assert.equal(snapToBoundary(THUMBS, 1, 'backward'), 0);
    assert.equal(snapToBoundary(THUMBS, 1, 'forward'), 2);
    assert.equal(snapToBoundary(FAMILY, 5, 'backward'), 0);
    assert.equal(snapToBoundary(FAMILY, 5, 'forward'), 11);
  });

  it('steps whole clusters', () => {
    assert.equal(nextBoundary(`a${FAMILY}`, 1), 12);
    assert.equal(prevBoundary(`a${FAMILY}`, 12), 1);
    assert.equal(nextBoundary('abc', 3), 3, 'no movement past the end');
    assert.equal(prevBoundary('abc', 0), 0, 'no movement before the start');
    assert.equal(graphemeIndexAt(`a${FAMILY}b`, 12), 2);
  });
});

describe('TextBuffer caret motion', () => {
  it('moves by cluster, so Left never lands inside an emoji', () => {
    const b = TextBuffer.of(`a${FAMILY}b`);
    assert.equal(b.caret, 13);
    assert.equal(b.graphemeCount, 3);
    assert.equal(b.moveLeft().caret, 12);
    assert.equal(b.moveLeft().moveLeft().caret, 1, 'one press crosses all 11 code units');
    assert.equal(b.moveLeft().moveLeft().moveLeft().caret, 0);
    assert.equal(b.withCaret(0).moveRight().caret, 1);
    assert.equal(b.withCaret(1).moveRight().caret, 12);
  });

  it('backspaces a whole cluster instead of minting a lone surrogate', () => {
    const b = TextBuffer.of(`a${FAMILY}b`);
    assert.equal(b.deleteBackward().text, `a${FAMILY}`);
    assert.equal(b.deleteBackward().deleteBackward().text, 'a');
    // The classic bug: a naive `slice(0, caret - 1)` leaves half a surrogate
    // pair, which renders as U+FFFD and can never be deleted.
    assert.equal(TextBuffer.of(THUMBS).deleteBackward().text, '');
    assert.equal(TextBuffer.of(E_ACUTE).deleteBackward().text, '');
    assert.equal(TextBuffer.of(FLAG_TW).deleteBackward().text, '');
    assert.equal(TextBuffer.of(WAVE_TONE).deleteBackward().text, '');
  });

  it('deletes forward by cluster too', () => {
    assert.equal(TextBuffer.of(`${FAMILY}z`, 0).deleteForward().text, 'z');
    assert.equal(TextBuffer.of(CJK, 0).deleteForward().text, '試');
  });

  it('refuses to hold a caret that is not on a boundary', () => {
    assert.equal(TextBuffer.of(THUMBS, 1).caret, 0);
    assert.equal(TextBuffer.of(FAMILY, 7).caret, 0);
    assert.equal(TextBuffer.of(`a${FAMILY}b`, 6).caret, 1);
  });

  it('lands after a cluster the insertion just created', () => {
    // Typing a base character in front of a lone combining mark fuses them. The
    // naive offset (caret + inserted.length) would sit between them.
    const fused = TextBuffer.of('́', 0).insert('e');
    assert.equal(fused.text, E_ACUTE);
    assert.equal(fused.caret, 2);
    assert.equal(fused.graphemeCount, 1);
  });

  it('reports the caret column in visible characters', () => {
    assert.equal(TextBuffer.of(`a${FAMILY}b`, 12).caretGraphemeIndex, 2);
    assert.equal(TextBuffer.of(CJK).caretGraphemeIndex, 2);
  });

  it('returns itself when nothing changed, so callers can ring the bell', () => {
    const b = TextBuffer.of('abc', 0);
    assert.equal(b.moveLeft(), b);
    assert.equal(b.deleteBackward(), b);
    assert.equal(b.insert(''), b);
    assert.equal(b.deleteRange(2, 2), b);
    assert.notEqual(b.moveRight(), b, 'but a real change is a new value');
  });
});

describe('word motion', () => {
  it("treats `-` as a delimiter, as PSReadLine's default WordDelimiters does", () => {
    const b = TextBuffer.of('Get-ChildItem');
    assert.equal(b.offsetWordLeft(), 4, 'stops at ChildItem, not at the start');
    assert.equal(b.withCaret(4).offsetWordLeft(), 0);
    assert.equal(b.withCaret(0).offsetWordRight(), 3, 'forward-word lands after Get');
  });

  it('can be reconfigured to bash unix-word-rubout, because it is data', () => {
    const b = TextBuffer.of('Get-ChildItem -Recurse', undefined, '');
    assert.equal(b.offsetWordLeft(), 14, 'whitespace only: the whole -Recurse goes');
    assert.equal(TextBuffer.of('Get-ChildItem -Recurse').offsetWordLeft(), 15);
  });

  it('treats CJK and emoji as word characters', () => {
    const b = TextBuffer.of(`Get-ChildItem ${CJK} ${THUMBS}`);
    assert.equal(b.text.length, 19);
    assert.equal(b.offsetWordLeft(), 17, 'the emoji is one word');
    assert.equal(b.withCaret(17).offsetWordLeft(), 14, 'and so is the CJK run');
    assert.equal(charClassOf(CJK[0] ?? ''), 'word');
    assert.equal(charClassOf(FAMILY), 'word');
    assert.equal(charClassOf(' '), 'whitespace');
    assert.equal(charClassOf('-'), 'delimiter');
    assert.ok(DEFAULT_WORD_DELIMITERS.includes('-'));
  });

  it('skips delimiters before the word, so repeated presses make progress', () => {
    const b = TextBuffer.of('a.b/c');
    assert.equal(b.offsetWordLeft(), 4);
    assert.equal(b.withCaret(4).offsetWordLeft(), 2);
    assert.equal(b.withCaret(2).offsetWordLeft(), 0);
    assert.equal(b.withCaret(0).offsetWordRight(), 1);
    assert.equal(b.withCaret(1).offsetWordRight(), 3);
  });
});

describe('kill and line motions', () => {
  it('kills to the end and start of the CURRENT line', () => {
    const b = TextBuffer.of('one\ntwo three', 8);
    assert.equal(b.offsetLineStart(), 4);
    assert.equal(b.offsetLineEnd(), 13);
    assert.equal(b.deleteToLineEnd().text, 'one\ntwo ');
    assert.equal(b.deleteToLineStart().text, 'one\nthree');
    // A multi-line buffer is real: PowerShell input continues while a block is
    // open, so Ctrl+A that jumped to offset 0 would be wrong there.
    assert.equal(TextBuffer.of('one\ntwo', 2).offsetLineEnd(), 3);
  });

  it('kills words in both directions', () => {
    assert.equal(TextBuffer.of('Get-ChildItem -Recurse').deleteWordLeft().text, 'Get-ChildItem -');
    assert.equal(TextBuffer.of('Get-ChildItem -Recurse', 0).deleteWordRight().text, '-ChildItem -Recurse');
    assert.equal(TextBuffer.of(`${CJK} abc`, 0).deleteWordRight().text, ' abc');
  });

  it('expands a range outward rather than splitting the clusters it half-covers', () => {
    const b = TextBuffer.of(`${THUMBS}${FAMILY}${THUMBS}`);
    assert.deepEqual(b.boundaries, [0, 2, 13, 15]);
    // 1..12 starts inside the first emoji and ends inside the family. Half a
    // cluster cannot be deleted, so both ends grow to the enclosing boundary.
    assert.equal(b.deleteRange(1, 12).text, THUMBS);
    assert.equal(b.deleteRange(1, 12).caret, 0);
    // A range already on boundaries is taken as given.
    assert.equal(b.deleteRange(2, 13).text, `${THUMBS}${THUMBS}`);
  });
});

describe('terminal metrics', () => {
  it('measures cells, fixing the two width bugs v1 shipped', () => {
    assert.equal(cellWidthOf('a'), 1);
    assert.equal(cellWidthOf(CJK[0] ?? ''), 2);
    // v1's `dw()` returned 1 for emoji and 1 for a combining mark. Both wrong.
    assert.equal(cellWidthOf(THUMBS), 2);
    assert.equal(cellWidthOf(FAMILY), 2, 'a cluster is as wide as its base, not its parts');
    assert.equal(cellWidthOf('́'), 0);
    assert.equal(cellWidthOf(E_ACUTE), 1);
  });

  it('sums a whole string', () => {
    assert.equal(displayWidth(`${CJK}abc`), 7);
    assert.equal(displayWidth(`x${FAMILY}`), 3);
  });

  it('is a port, so a host can inject any measurement it likes', () => {
    const everythingIsThree = { columns: 10, rows: 3, cellWidth: () => 3 };
    assert.equal(displayWidth('ab', everythingIsThree.cellWidth), 6);
    assert.equal(monospaceMetrics(120, 40).columns, 120);
    assert.equal(monospaceMetrics(120, 40).rows, 40);
  });
});

describe('the core is headless', () => {
  /**
   * Roadmap PR-05's acceptance condition is "LineEditorCore has zero DOM
   * imports". A condition nobody checks is a wish, so this checks it: comments
   * are stripped (they discuss `KeyboardEvent` on purpose) and the remaining
   * code is searched for browser globals.
   */
  const DIRECTORY = join(import.meta.dirname, '..', '..', 'src', 'line-editor');

  const FORBIDDEN = [
    'document',
    'window',
    'navigator',
    'HTMLElement',
    'KeyboardEvent',
    'CompositionEvent',
    'getBoundingClientRect',
    'requestAnimationFrame',
    'localStorage',
    'addEventListener',
  ];

  /**
   * Walk the file with TypeScript's parser, not a regex.
   *
   * The first version stripped comments by hand and then searched the text. An
   * adversarial review defeated it with ORDINARY code — no concatenation, no
   * base64, no computed keys:
   *
   *     return 1
   *       * host.document.body.clientWidth
   *       / cellWidth;
   *
   * because `.filter(line => !/^\s*(\/\/|\*)/.test(line))` deletes any line
   * whose first non-space character is `*`, and a `*` continuation line is
   * legal. It also went wrong in the other direction: a trailing
   * `// mentions document` comment FAILED the test, since only lines that
   * *start* with `//` were dropped. And a pair of string constants holding the
   * block-comment delimiters deleted every line between them, because the
   * regex is string-blind. (Writing that second delimiter literally here ends
   * this comment early — which is the same bug, one layer up, and is why the
   * example is described rather than quoted.)
   *
   * This repository already made this decision once, in
   * `refactor(js-literal): parse with TypeScript instead of a hand-written
   * lexer`. The same argument applies to a test that guards a claim.
   *
   * What this still cannot decide, stated rather than papered over: a key built
   * at runtime — `globalThis['docu' + 'ment']`, `atob(...)`, `String.fromCharCode`
   * — is not statically visible to any checker. The claim this test supports is
   * "no module NAMES a browser global", which is what a reader of the source can
   * verify, not "no module can ever reach one".
   */
  function browserGlobalsNamedIn(source: string, file: string): string[] {
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const found: string[] = [];
    const forbidden = new Set<string>(FORBIDDEN);

    const visit = (node: ts.Node): void => {
      // An identifier anywhere: a bare reference, a property name in
      // `globalThis.document`, a destructured binding, a shorthand.
      if (ts.isIdentifier(node) && forbidden.has(node.text)) found.push(node.text);
      // A string used as a computed key: `globalThis['document']`.
      if (ts.isStringLiteralLike(node) && forbidden.has(node.text)) found.push(node.text);
      ts.forEachChild(node, visit);
    };
    visit(tree);
    return found;
  }

  /** Every module specifier, whatever the quote style and whatever the form. */
  function importsIn(source: string, file: string): string[] {
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const specifiers: string[] = [];

    const visit = (node: ts.Node): void => {
      // `import x from '…'`, and the side-effect form `import '…'` which has no
      // `from` at all — the regex looked for `from '…'` and saw neither that nor
      // any double-quoted specifier. A `createRequire` slipped through both.
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const spec = node.moduleSpecifier;
        if (spec !== undefined && ts.isStringLiteralLike(spec)) specifiers.push(spec.text);
      }
      // `import('…')`
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const first = node.arguments[0];
        if (first !== undefined && ts.isStringLiteralLike(first)) specifiers.push(first.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    return specifiers;
  }

  it('names no browser global in any module', () => {
    const files = readdirSync(DIRECTORY).filter((f) => f.endsWith('.ts'));
    assert.ok(files.length >= 9, `expected the whole core, found ${files.length} files`);
    for (const file of files) {
      const named = browserGlobalsNamedIn(readFileSync(join(DIRECTORY, file), 'utf8'), file);
      assert.deepEqual(named, [], `${file} references browser identifiers: ${named.join(', ')}`);
    }
  });

  it('imports nothing outside the core but the generated manifests', () => {
    const files = readdirSync(DIRECTORY).filter((f) => f.endsWith('.ts'));
    for (const file of files) {
      for (const specifier of importsIn(readFileSync(join(DIRECTORY, file), 'utf8'), file)) {
        assert.ok(
          specifier.startsWith('./') || specifier === '../commands/manifests.json',
          `${file} imports ${specifier}, which is outside the core`,
        );
      }
    }
  });

});
