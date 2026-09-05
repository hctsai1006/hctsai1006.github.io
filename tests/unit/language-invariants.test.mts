/**
 * The three invariants, checked by a deterministic fuzzer.
 *
 * The brief for this work named the three ways it fails:
 *
 *   1. a string is still tokenised by a second path
 *   2. the highlighter colours something the execution parser rejects
 *   3. an unimplemented node reaches execution
 *
 * The other test files check those against a 216-case corpus MEASURED from
 * pwsh, which is the right way to check correctness. It is the wrong way to
 * check an invariant: a corpus only contains what somebody thought of. This
 * generates 20,000 inputs from the characters that actually matter, in a fixed
 * order from a fixed seed, and asserts all three hold on every one.
 *
 * It earned its place immediately. The first run did not report a violation —
 * it HUNG, because a line beginning `|` made the editing parser loop forever
 * without consuming a token. That matters more than most bugs: the editing
 * parser runs on every keystroke, so typing a leading pipe froze the page. The
 * corpus did not contain a leading `|`, and no amount of reading the code had
 * found it.
 *
 * 20,000 inputs run in under a second, so the count is not tuned down for CI.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { lex } from '../../src/language/lexer.ts';
import { highlight } from '../../src/language/highlight.ts';
import { parseForEditing, parseForExecution } from '../../src/language/parse.ts';
import { unsupportedNodes, walk } from '../../src/language/ast.ts';
import { tokenize } from '../../src/line-editor/tokenize.ts';

/**
 * The fragments a PowerShell line is actually made of.
 *
 * Chosen so the generator produces the hard cases rather than random noise:
 * every quote style, every redirection form, every statement keyword, the
 * stop-parsing token, splatting, and several deliberately unterminated pieces.
 */
const ALPHABET: readonly string[] = [
  'Get-ChildItem', 'Sort-Object', 'a', 'b', 'x', '1', '10', '-5',
  '-Path', '-Force', '--Path', '-eq', '-gt', '-Name:v', '-Sw:$false',
  "'q'", '"q"', '$x', '$_', '$true', '@p', '@(', '@{', '$(',
  '{', '}', '(', ')', '[', ']', '|', '&&', '||', ';', '&', ',',
  '>', '>>', '2>', '2>&1', '1>&2', '<', '*>', '#c', '`t', '--%',
  '..', '::', '.', '=', '+', '!', '?', '??',
  'if', 'function', 'while', 'foreach', 'try', 'class', 'switch',
  'return', 'param', 'data', 'using',
  '"un', "'un", '@"', '"@', '1kb', '0x1F', 'a,b', 'a.b', 'a>b', '\n',
];

/** A linear congruential generator, so the corpus is identical on every run. */
function* generate(count: number): Generator<string> {
  let seed = 12345;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = (): string => ALPHABET[Math.floor(next() * ALPHABET.length)] ?? 'a';
  for (let i = 0; i < count; i += 1) {
    const parts: string[] = [];
    const length = 1 + Math.floor(next() * 7);
    for (let k = 0; k < length; k += 1) parts.push(pick());
    yield parts.join(next() < 0.85 ? ' ' : '');
  }
}

/** Diagnostics that mean "keep typing", which the highlighter must not paint. */
const INCOMPLETE = new Set([
  'TerminatorExpectedAtEndOfString',
  'MissingEndCurlyBrace',
  'MissingTerminatorMultiLineComment',
  'EmptyPipeElement',
  'MissingArgument',
  'MissingFileSpecification',
  'WhitespaceBeforeHereStringFooter',
  'UnexpectedToken',
]);

const INPUTS = [...generate(20000)];

describe('the language invariants hold on 20,000 generated inputs', () => {
  it('terminates on every input, and never throws', { timeout: 60_000 }, () => {
    // The regression test for the hang. Without the parser's no-progress guard
    // this does not fail — it never returns, and the runner kills it.
    for (const source of INPUTS) {
      parseForEditing(source);
      parseForExecution(source);
      highlight(source);
    }
  });

  it('terminates on a statement that begins with a separator', { timeout: 5000 }, () => {
    // The exact shapes that hung: nothing to parse, and nothing consumed.
    for (const source of ['|', '| a', '&&', '&& a', '||', '|| a', 'a | | b', ') x', '} x']) {
      const parsed = parseForEditing(source);
      assert.ok(parsed.ast.kind === 'ScriptBlockAst', source);
    }
  });

  it('INVARIANT 1: no string is tokenised by a second path', () => {
    const trivia = new Set(['Comment', 'LineContinuation']);
    for (const source of INPUTS) {
      const canonical = lex(source).tokens;
      assert.deepEqual(
        parseForEditing(source).tokens.map((t) => [t.kind, t.start, t.end]),
        canonical.map((t) => [t.kind, t.start, t.end]),
        `the parser lexed ${JSON.stringify(source)} differently`,
      );
      assert.deepEqual(
        tokenize(source).map((t) => [t.start, t.end, t.value]),
        canonical.filter((t) => !trivia.has(t.kind)).map((t) => [t.start, t.end, t.value]),
        `the line editor lexed ${JSON.stringify(source)} differently`,
      );
    }
  });

  it('INVARIANT 2: the highlighter never colours a refused span as valid', () => {
    let exercised = 0;
    for (const source of INPUTS) {
      const parsed = parseForExecution(source);
      if (parsed.ok) continue;
      const ranges = parsed.refusals.filter((r) => !INCOMPLETE.has(r.id));
      if (ranges.length === 0) continue;
      exercised += 1;
      for (const span of highlight(source)) {
        if (span.className === null || span.className === 'refused') continue;
        const covered = ranges.some(
          (r) =>
            (span.start >= r.start && span.end <= r.end) ||
            (r.start >= span.start && r.start < span.end),
        );
        assert.equal(
          covered,
          false,
          `${JSON.stringify(source)}: ${JSON.stringify(span.text)} coloured "${span.className}" ` +
            'inside a span the engine refuses',
        );
      }
    }
    assert.ok(exercised > 1000, `only ${exercised} refusing inputs were generated`);
  });

  it('INVARIANT 3: no unimplemented node reaches execution', () => {
    const unrunnable = new Set([
      'ScriptBlockExpressionAst',
      'FileRedirectionAst',
      'MergingRedirectionAst',
    ]);
    let accepted = 0;
    for (const source of INPUTS) {
      const parsed = parseForExecution(source);
      if (!parsed.ok) continue;
      accepted += 1;
      assert.deepEqual(
        unsupportedNodes(parsed.ast).map((n) => n.nodeType),
        [],
        `${JSON.stringify(source)} was accepted with unsupported nodes`,
      );
      for (const node of walk(parsed.ast)) {
        assert.equal(
          unrunnable.has(node.kind),
          false,
          `${JSON.stringify(source)} was accepted containing ${node.kind}`,
        );
        if (node.kind === 'VariableExpressionAst') {
          // There is no variable table; only the literals may survive.
          assert.ok(
            !node.splatted && ['true', 'false', 'null'].includes(node.variablePath.toLowerCase()),
            `${JSON.stringify(source)} was accepted with the variable $${node.variablePath}`,
          );
        }
      }
    }
    assert.ok(accepted > 100, `only ${accepted} inputs were accepted; coverage is too thin`);
  });

  it('the highlighter reproduces every input character for character', () => {
    for (const source of INPUTS) {
      assert.equal(highlight(source).map((s) => s.text).join(''), source);
    }
  });
});
