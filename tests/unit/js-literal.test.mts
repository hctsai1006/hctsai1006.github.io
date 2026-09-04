/**
 * Differential tests for the literal brace matcher.
 *
 * This is the riskiest file in the repository: hand-written lexing, in a project
 * whose whole argument is that you should not parse structure by hand. It had no
 * tests at all until an adversarial review pointed that out.
 *
 * The oracle is the REAL TypeScript parser, which is already a devDependency.
 * Asserting against hand-written expected spans would only test that the matcher
 * agrees with whatever the author believed; asserting against `ts.createSourceFile`
 * tests it against an actual JavaScript grammar.
 *
 * Two classes of assertion, and the difference matters:
 *
 *   1. On real input and on the adversarial cases below, the span must be
 *      EXACTLY the parser's span.
 *   2. On input where the heuristic is known to be incomplete, the requirement
 *      is weaker but still meaningful: it must FAIL CLOSED. Either it throws, or
 *      the span it returns is not valid JavaScript, so the evaluator downstream
 *      rejects it. What must never happen is a wrong span that still parses,
 *      because that is silent data corruption.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import ts from 'typescript';

import { readLiteral, readNamedLiteral } from '../../tools/js-literal.mts';

const INDEX = join(import.meta.dirname, '..', '..', 'index.html');

/**
 * Ground truth: the span the TypeScript parser assigns to the initialiser of
 * `const NAME = ...`.
 */
function oracleSpan(source: string, name: string): { start: number; end: number } {
  const file = ts.createSourceFile('probe.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let found: { start: number; end: number } | null = null;

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      const init = node.initializer;
      if (init !== undefined) found = { start: init.getStart(file), end: init.getEnd() };
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  if (found === null) throw new Error(`the oracle could not find const ${name}`);
  return found;
}

/**
 * index.html is HTML, and `ts.createSourceFile` on the whole file finds no
 * declarations at all — the first version of this test "failed" on every real
 * literal for that reason, which says more about the oracle than the matcher.
 * Hand the parser the script element's text, and translate its offsets back
 * into whole-file coordinates so both sides are measuring the same thing.
 */
function inlineScript(html: string): { text: string; offset: number } {
  const open = /<script(?![^>]*\bsrc=)[^>]*>/i.exec(html);
  if (open === null) throw new Error('index.html has no inline <script>');
  const start = open.index + open[0].length;
  const end = html.indexOf('</script>', start);
  if (end === -1) throw new Error('index.html has an unterminated <script>');
  return { text: html.slice(start, end), offset: start };
}

/** Does this text parse as a standalone JavaScript expression? */
function isEvaluable(text: string): boolean {
  try {
    runInContext(`(${text})`, createContext(Object.create(null) as Record<string, never>), {
      timeout: 500,
    });
    return true;
  } catch {
    return false;
  }
}

describe('against the real index.html', () => {
  const html = readFileSync(INDEX, 'utf8');
  const script = inlineScript(html);

  // The literals the extractors actually depend on. If any of these drifts from
  // the parser's view, the extracted data is wrong.
  for (const name of ['D', 'CMDLETS', 'ALIAS', 'DISP', 'EGGS', 'APPS']) {
    it(`matches the TypeScript parser for ${name}`, () => {
      const span = readNamedLiteral(html, name);
      const truth = oracleSpan(script.text, name);
      assert.equal(span.start, truth.start + script.offset, `${name} start`);
      assert.equal(span.end, truth.end + script.offset, `${name} end`);
    });
  }

  it('handles the return-regex at index.html:1149', () => {
    // `return /^-[a-zA-Z]*[rR]/.test(...)` inside CMDLETS. Without `return` in
    // the keyword set this lexes as division; it survived only because that
    // pattern contains no braces. Adding one used to break extraction.
    const patched = inlineScript(
      html.replace('/^-[a-zA-Z]*[rR]/', '/^-[a-zA-Z]*[rR]|^--recurse[{]?/'),
    );
    const span = readNamedLiteral(patched.text, 'CMDLETS');
    const truth = oracleSpan(patched.text, 'CMDLETS');
    assert.equal(span.start, truth.start, 'CMDLETS start with a brace in the regex');
    assert.equal(span.end, truth.end, 'CMDLETS end with a brace in the regex');
  });
});

describe('adversarial inputs that must be exactly right', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['regex containing a brace', `const X = { re: /[{]/, n: 1 };`],
    ['regex containing quotes', `const X = { re: /['"]/, n: 1 };`],
    ['regex containing a closing brace', `const X = { re: /}/, n: 1 };`],
    ['division that is not a regex', `const X = { n: (4) / 2 / 1 };`],
    ['string containing a block-comment close', `const X = { s: '*/', n: 1 };`],
    ['string containing a block-comment open', `const X = { s: '/*', n: 1 };`],
    ['quoted brace as a key', `const X = { '}': 1, '{': 2 };`],
    ['comment with an unbalanced apostrophe', `const X = { /* it's fine */ n: 1 };`],
    ['line comment with a brace', `const X = { // }\n n: 1 };`],
    ['nested template with braces', 'const X = { s: `a${ {b:1}.b }c`, n: 1 };'],
    ['template inside a template', 'const X = { s: `a${ `b${ 1 }` }c` };'],
    ['array literal', `const X = [1, [2, 3], { a: 4 }];`],
    ['inline close, as ALIAS does', `const X = { a: 'b', c: 'd'};`],
    ['escaped quote in a string', `const X = { s: 'it\\'s', n: 1 };`],
    ['regex with escaped slash', `const X = { re: /a\\/b/, n: 1 };`],
    ['character class containing a slash', `const X = { re: /[/]/, n: 1 };`],
  ];

  for (const [label, source] of cases) {
    it(label, () => {
      const span = readNamedLiteral(source, 'X');
      const truth = oracleSpan(source, 'X');
      assert.equal(span.start, truth.start, `${label}: start`);
      assert.equal(span.end, truth.end, `${label}: end`);
      assert.ok(isEvaluable(span.text), `${label}: the span must be evaluable`);
    });
  }
});

describe('known incompleteness must fail closed', () => {
  // The heuristic cannot always tell a regex from a division. What it must never
  // do is return a WRONG span that still parses, because that is corrupted data
  // presented as correct.
  const hard: ReadonlyArray<readonly [string, string]> = [
    ['regex with an unbalanced brace after a value', `const X = {f(){return /}/.test(s)} /* } */ };`],
    ['keyword-shaped identifier before a slash', `const X = { n: myreturn / 2 / 1 };`],
  ];

  for (const [label, source] of hard) {
    it(label, () => {
      let span: ReturnType<typeof readNamedLiteral> | null = null;
      try {
        span = readNamedLiteral(source, 'X');
      } catch {
        return; // threw: fails closed, which is acceptable
      }

      const truth = oracleSpan(source, 'X');
      if (span.start === truth.start && span.end === truth.end) return; // correct

      // Wrong span. It is only acceptable if the evaluator will reject it.
      assert.equal(
        isEvaluable(span.text),
        false,
        `${label}: returned a WRONG span that still evaluates — this is silent corruption, not a fail-closed limit`,
      );
    });
  }
});

describe('error behaviour', () => {
  it('refuses to start anywhere but an opening delimiter', () => {
    assert.throws(() => readLiteral('const X = 1;', 10), /expected an object or array literal/);
  });

  it('names the declaration it could not find', () => {
    assert.throws(() => readNamedLiteral('const Y = {};', 'X'), /const X=/);
  });

  it('throws rather than returning a truncated span when the source ends early', () => {
    assert.throws(() => readNamedLiteral('const X = { a: 1', 'X'), /unbalanced|unterminated/);
  });

  it('throws on an unterminated string', () => {
    assert.throws(() => readNamedLiteral("const X = { s: 'oops };", 'X'), /unterminated/);
  });
});
