/**
 * Tests for locating a JavaScript literal in index.html.
 *
 * These started as a differential test against the TypeScript parser, written
 * because the riskiest file in the repository — a hand-written lexer — had no
 * test. It did its job: it found two pieces of ordinary JavaScript the matcher
 * refused, which led to the matcher being replaced by the parser it was
 * measured against.
 *
 * Removing the differential half was right for the literal reader and WRONG for
 * everything around it. An adversarial review pointed out that what remained
 * left `inlineScript` — by then the only hand-rolled structural code in the
 * file — with one happy path and three refusals, and then demonstrated that it
 * would return a commented-out `<script>` as truth. The lesson is not "keep the
 * old tests" but "test the part that is still ours", so most of this file is
 * now about the HTML scanner and about refusals.
 *
 * The constructs that used to break the lexer are kept as regression cases.
 * They pass trivially now, and that is the point: if anyone reaches for a
 * hand-rolled scanner again, these are the inputs that will say no.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import { inlineScript, readNamedLiteral, readNamedLiteralFromHtml } from '../../tools/js-literal.mts';

const INDEX = join(import.meta.dirname, '..', '..', 'index.html');

/**
 * Run the span as an expression.
 *
 * `vm` is not a security boundary and does not claim to be. The context is a
 * fresh realm from a null prototype, the input is a committed file in this
 * repository, and the point is to prove the span is syntactically whole.
 */
function evaluate(text: string): unknown {
  return runInContext(`(${text})`, createContext(Object.create(null) as Record<string, never>), {
    timeout: 1000,
  });
}

/**
 * `D.stats.merged` for a page, as a plain number.
 *
 * Scalar on purpose. A VM context is a separate realm, so an object it returns
 * carries that realm's Object.prototype and deepStrictEqual reports "same
 * structure but not reference-equal" — a test failure that says nothing about
 * the code under test.
 */
const mergedCount = (html: string): unknown =>
  (evaluate(readNamedLiteralFromHtml(html, 'D').text) as { stats: { merged: unknown } }).stats.merged;

describe('index.html', () => {
  const html = readFileSync(INDEX, 'utf8');
  const NAMES = ['D', 'CMDLETS', 'ALIAS', 'DISP', 'EGGS', 'APPS'] as const;

  for (const name of NAMES) {
    it(`${name}: the span indexes the whole file, not the script`, () => {
      const span = readNamedLiteralFromHtml(html, name);
      // Catches a missing `+ script.offset`: the text must really be at those
      // coordinates in the file the caller handed over.
      assert.equal(html.slice(span.start, span.end), span.text, `${name} offsets`);
    });

    it(`${name}: the span is a literal that evaluates`, () => {
      const value = evaluate(readNamedLiteralFromHtml(html, name).text);
      assert.equal(typeof value, 'object');
      assert.notEqual(value, null);
    });
  }

  it('returns the declaration asked for, not one whose name starts the same way', () => {
    // D and DISP both exist. A prefix match would hand back DISP for D, and the
    // shapes are close enough that nothing downstream would notice.
    const d = evaluate(readNamedLiteralFromHtml(html, 'D').text) as Record<string, unknown>;
    const disp = evaluate(readNamedLiteralFromHtml(html, 'DISP').text) as Record<string, unknown>;
    assert.ok(Object.hasOwn(d, 'stats'), 'D is the portfolio object');
    assert.ok(!Object.hasOwn(disp, 'stats'), 'DISP is the display-name map');
    assert.notEqual(readNamedLiteralFromHtml(html, 'D').start, readNamedLiteralFromHtml(html, 'DISP').start);
  });

  it('extracts a script whose text really is inside the file', () => {
    const script = inlineScript(html);
    assert.equal(html.slice(script.offset, script.offset + script.text.length), script.text);
    assert.ok(script.text.includes('const D='), 'the script holds the declarations');
  });
});

describe('the HTML scanner', () => {
  const REAL = '<script>const D={stats:{merged:276}};</script>';

  it('ignores a script inside an HTML comment', () => {
    // The finding that caused this rewrite. The old regex returned the
    // commented-out block, the extractor wrote 115 merged PRs into src/data,
    // --check then agreed the data was in sync, and nothing threw.
    const html = `<!-- old build\n<script>const D={stats:{merged:115}};</script>\n-->\n${REAL}`;
    assert.equal(mergedCount(html), 276);
  });

  it('ignores a script element written inside another tag attribute', () => {
    assert.equal(mergedCount(`<div title="<script>const D={stats:{merged:9}};</script>"></div>${REAL}`), 276);
  });

  it('accepts an attribute whose name merely ends in src', () => {
    // `\bsrc=` matches data-src, because "-" is a word boundary. The old
    // version refused this valid page outright.
    assert.equal(mergedCount('<script data-src="lazy.js">const D={stats:{merged:276}};</script>'), 276);
  });

  it('accepts src= appearing inside another attribute value', () => {
    assert.equal(mergedCount('<script data-note="use src=foo">const D={stats:{merged:276}};</script>'), 276);
  });

  it('accepts an attribute value containing >', () => {
    assert.equal(mergedCount('<script data-note="a>b">const D={stats:{merged:276}};</script>'), 276);
  });

  it('skips a real external script and reads the inline one', () => {
    assert.equal(mergedCount(`<script src="x.js"></script>${REAL}`), 276);
  });

  it('closes the element case-insensitively', () => {
    // The open tag was matched with /i while the close was found with a
    // case-sensitive indexOf, so </SCRIPT> ran the two elements together and
    // the first one's literal was returned as the whole page's.
    const html = '<script>const D={stats:{merged:1}};//</SCRIPT>';
    assert.equal(mergedCount(html), 1);
    assert.equal(inlineScript(html).text, 'const D={stats:{merged:1}};//');
  });

  it('closes the element with trailing whitespace in the end tag', () => {
    assert.equal(mergedCount('<script>const D={stats:{merged:276}};</script >'), 276);
  });

  it('refuses to choose between two inline scripts', () => {
    assert.throws(
      () => inlineScript(`${REAL}<script>const D={stats:{merged:1}};</script>`),
      /expected exactly one inline <script>, found 2/,
    );
  });

  it('refuses HTML with no inline script', () => {
    assert.throws(() => readNamedLiteralFromHtml('<p>hi</p>', 'D'), /no inline <script>/);
    assert.throws(() => readNamedLiteralFromHtml('<script src="a.js"></script>', 'D'), /no inline <script>/);
  });

  it('refuses an unclosed script element', () => {
    assert.throws(() => readNamedLiteralFromHtml('<script>const D = {};', 'D'), /never closed/);
  });

  it('refuses an unterminated HTML comment rather than scanning past it', () => {
    assert.throws(() => inlineScript(`<!-- oops ${REAL}`), /unterminated HTML comment/);
  });
});

describe('early errors, which a parse-only check misses', () => {
  // Each of these parses cleanly and would make a browser refuse to run the
  // entire script, so a literal lifted out of it describes code that never
  // executes. TypeScript reports them from the checker, not the parser.
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['a duplicate const declaration', 'const X = {a:1}; const X = {b:2};'],
    ['a const with no initializer', 'const X = {a:1}; const Y;'],
    ['return outside a function', 'const X = {a:1}; return 1;'],
    ['a repeated key in an object literal', 'const X = {__proto__:null, __proto__:null};'],
    ['break outside a loop', 'const X = {a:1}; break;'],
  ];

  for (const [label, source] of cases) {
    it(`refuses ${label}`, () => {
      assert.throws(() => readNamedLiteral(source, 'X'), /does not parse or would not run/);
    });
  }

  it('does not mistake an unresolved global for an error', () => {
    // Reported as 2584 with no lib loaded. index.html is full of these, so a
    // gate that required an empty diagnostic list would reject the one file it
    // exists to read.
    assert.doesNotThrow(() => readNamedLiteral('const X = {a: document.title};', 'X'));
  });
});

describe('constructs that broke the hand-written lexer', () => {
  // Each is valid JavaScript. The first two were refused outright; the rest are
  // cases the lexer had to special-case. The assertions check the VALUE, not
  // just that a span came back — an earlier version compared the span against a
  // slice taken with its own start and end, which cannot fail.
  const cases: ReadonlyArray<readonly [string, string, unknown]> = [
    ['regex after a closing paren', 'const X = { n: 1, m(){ if (1) /}/.test("") } };', 1],
    ['regex after throw', 'const X = { n: 1, m(){ throw /}/ } };', 1],
    ['regex after return', 'const X = { n: 1, m(){ return /^-[a-z]*|^--r[{]?/ } };', 1],
    ['regex containing a brace', 'const X = { re: /[{]/, n: 1 };', 1],
    ['regex containing quotes', 'const X = { re: /[\'"]/, n: 1 };', 1],
    ['division that is not a regex', 'const X = { n: (4) / 2 / 2 };', 1],
    ['comment delimiters inside strings', 'const X = { a: "*/", b: \'/*\', n: 1 };', 1],
    ['quoted braces as keys', "const X = { '}': 9, '{': 8, n: 1 };", 1],
    ['line comment holding a brace', 'const X = { // }\n n: 1 };', 1],
    ['nested template substitution', 'const X = { s: `a${ {b:1}.b }c`, n: 1 };', 1],
    ['template inside a template', 'const X = { s: `a${ `b${ 1 }` }c`, n: 1 };', 1],
    ['inline close, as ALIAS does', "const X = { a: 'b', n: 1};", 1],
    ['escaped quote in a string', "const X = { s: 'it\\'s', n: 1 };", 1],
    ['slash inside a character class', 'const X = { re: /[/]/, n: 1 };', 1],
    ['whitespace around the equals', 'const X   =   { n: 1 };', 1],
  ];

  for (const [label, source, expected] of cases) {
    it(label, () => {
      const span = readNamedLiteral(source, 'X');
      const value = evaluate(span.text) as { n: unknown };
      assert.equal(value.n, expected, `${label}: the span must be the whole literal`);
    });
  }

  it('an array literal comes back whole', () => {
    // Compared as JSON: the value comes from another realm, so a structural
    // compare would fail on the prototype rather than on the content.
    const value = evaluate(readNamedLiteral('const X = [1, [2, 3], { a: 4 }];', 'X').text);
    assert.equal(JSON.stringify(value), JSON.stringify([1, [2, 3], { a: 4 }]));
  });

  it('picks the declaration by name when several are present', () => {
    // A reader that ignored `name` passed every case above, because each source
    // had exactly one declaration. This is the case that fails it.
    const source = 'const A = { n: 1 }; const X = { n: 2 }; const Z = { n: 3 };';
    assert.equal((evaluate(readNamedLiteral(source, 'X').text) as { n: number }).n, 2);
    assert.equal((evaluate(readNamedLiteral(source, 'A').text) as { n: number }).n, 1);
    assert.equal((evaluate(readNamedLiteral(source, 'Z').text) as { n: number }).n, 3);
  });
});

describe('refusals', () => {
  it('rejects an initialiser that is not a literal', () => {
    assert.throws(() => readNamedLiteral('const X = makeIt();', 'X'), /not an object or array literal/);
  });

  it('names the declaration it could not find', () => {
    assert.throws(() => readNamedLiteral('const Y = {};', 'X'), /const X=/);
  });

  it('rejects a truncated source rather than returning a partial span', () => {
    assert.throws(() => readNamedLiteral('const X = { a: 1', 'X'), /does not parse/);
  });

  it('rejects an unterminated string', () => {
    assert.throws(() => readNamedLiteral("const X = { s: 'oops };", 'X'), /does not parse/);
  });
});
