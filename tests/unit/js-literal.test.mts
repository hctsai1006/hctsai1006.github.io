/**
 * Tests for locating a JavaScript literal in index.html.
 *
 * These started as a differential test against the TypeScript parser, written
 * because the riskiest file in the repository — a hand-written lexer — had no
 * test at all. That test did its job: it found two pieces of ordinary
 * JavaScript the matcher refused (`if (a) /}/.test(b)` and `throw /}/`), which
 * is what led to the matcher being replaced by the parser it was measured
 * against.
 *
 * So the differential half is gone, because comparing the parser to itself
 * proves nothing. What is left is the logic that is still ours:
 *
 *   - taking the script element out of an HTML file, and translating the
 *     parser's offsets back into whole-file coordinates;
 *   - finding the right declaration, and only that one;
 *   - refusing, loudly, everything it cannot answer for.
 *
 * The constructs that used to break the lexer are kept as regression cases.
 * They pass trivially now, and that is the point: if anyone ever reaches for a
 * hand-rolled scanner again, these are the inputs that will say no.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import { inlineScript, readNamedLiteral, readNamedLiteralFromHtml } from '../../tools/js-literal.mts';

const INDEX = join(import.meta.dirname, '..', '..', 'index.html');

/** Does this text parse and run as a standalone JavaScript expression? */
function evaluate(text: string): unknown {
  return runInContext(`(${text})`, createContext(Object.create(null) as Record<string, never>), {
    timeout: 1000,
  });
}

describe('index.html', () => {
  const html = readFileSync(INDEX, 'utf8');

  // The literals the extractors depend on. A wrong span here is wrong data on
  // the published page.
  const NAMES = ['D', 'CMDLETS', 'ALIAS', 'DISP', 'EGGS', 'APPS'] as const;

  for (const name of NAMES) {
    it(`${name}: the span indexes the whole file, not the script`, () => {
      const span = readNamedLiteralFromHtml(html, name);
      // The invariant that catches an offset-translation bug: what the span
      // claims to be must be what is actually at those coordinates in the file
      // the caller handed over.
      assert.equal(html.slice(span.start, span.end), span.text, `${name} offsets`);
    });

    it(`${name}: the span is a literal that evaluates`, () => {
      const value = evaluate(readNamedLiteralFromHtml(html, name).text);
      assert.equal(typeof value, 'object');
      assert.notEqual(value, null);
    });
  }

  it('does not match a longer name that starts with the one asked for', () => {
    // D and DISP both exist. A prefix match would return DISP's span for D, and
    // the shapes are similar enough that nothing downstream would notice.
    const d = readNamedLiteralFromHtml(html, 'D');
    const disp = readNamedLiteralFromHtml(html, 'DISP');
    assert.notEqual(d.start, disp.start);
    assert.ok(
      Object.hasOwn(evaluate(d.text) as object, 'stats'),
      'D is the portfolio object, so it has stats',
    );
  });

  it('extracts a script whose text really is inside the file', () => {
    const script = inlineScript(html);
    assert.equal(html.slice(script.offset, script.offset + script.text.length), script.text);
    assert.ok(script.text.includes('const D='), 'the script holds the declarations');
  });
});

describe('constructs that broke the hand-written lexer', () => {
  // Each of these is valid JavaScript. The first two were refused outright; the
  // rest are the cases the lexer had to special-case to get right.
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['regex after a closing paren', 'const X = { m(){ if (1) /}/.test("") ; return 1 } };'],
    ['regex after throw', 'const X = { m(){ throw /}/ } };'],
    ['regex after return', 'const X = { m(){ return /^-[a-z]*[rR]|^--recurse[{]?/ } };'],
    ['regex containing a brace', 'const X = { re: /[{]/, n: 1 };'],
    ['regex containing quotes', 'const X = { re: /[\'"]/, n: 1 };'],
    ['division that is not a regex', 'const X = { n: (4) / 2 / 1 };'],
    ['comment delimiters inside a string', 'const X = { a: "*/", b: \'/*\', n: 1 };'],
    ['quoted braces as keys', "const X = { '}': 1, '{': 2 };"],
    ['line comment holding a brace', 'const X = { // }\n n: 1 };'],
    ['nested template substitution', 'const X = { s: `a${ {b:1}.b }c`, n: 1 };'],
    ['template inside a template', 'const X = { s: `a${ `b${ 1 }` }c` };'],
    ['array literal', 'const X = [1, [2, 3], { a: 4 }];'],
    ['inline close, as ALIAS does', "const X = { a: 'b', c: 'd'};"],
    ['escaped quote in a string', "const X = { s: 'it\\'s', n: 1 };"],
    ['slash inside a character class', 'const X = { re: /[/]/, n: 1 };'],
    ['whitespace around the equals', 'const X   =   { n: 1 };'],
  ];

  for (const [label, source] of cases) {
    it(label, () => {
      const span = readNamedLiteral(source, 'X');
      assert.equal(source.slice(span.start, span.end), span.text);
      assert.doesNotThrow(() => evaluate(span.text), `${label}: the span must evaluate`);
    });
  }
});

describe('refusals', () => {
  it('rejects a source that does not parse, rather than using the recovered tree', () => {
    // TypeScript's parser recovers from errors and still returns a tree, so
    // without the diagnostics check this would hand back a confident, wrong span.
    assert.throws(
      () => readNamedLiteral('const X = { a: 1 ;', 'X'),
      /does not parse/,
    );
  });

  it('rejects an initialiser that is not a literal', () => {
    assert.throws(
      () => readNamedLiteral('const X = makeIt();', 'X'),
      /not an object or array literal/,
    );
  });

  it('names the declaration it could not find', () => {
    assert.throws(() => readNamedLiteral('const Y = {};', 'X'), /const X=/);
  });

  it('rejects HTML with no inline script', () => {
    assert.throws(() => readNamedLiteralFromHtml('<p>hi</p>', 'X'), /no inline <script>/);
  });

  it('ignores a script element that only has a src', () => {
    assert.throws(
      () => readNamedLiteralFromHtml('<script src="a.js"></script>', 'X'),
      /no inline <script>/,
    );
  });

  it('rejects an unclosed script element', () => {
    assert.throws(() => readNamedLiteralFromHtml('<script>const X = {};', 'X'), /never closed/);
  });
});
