/**
 * The highlighter cannot colour syntax the engine rejects.
 *
 * That is one of the three ways this roadmap item fails, and it is the one the
 * roadmap named directly: v1's highlighter "colours `>`, `>>` and `<` that
 * nothing implements". The guarantee here is structural — `highlight.ts` calls
 * `parseForExecution` and paints refused spans with the `refused` class — so
 * these tests check the guarantee HOLDS rather than checking a list of colours.
 *
 * The v1 defects, each pinned as a case:
 *
 *   `>` `>>` `<`   coloured as operators; nothing implements redirection, and
 *                  pwsh 7.6.5 refuses `<` itself.
 *   `2>&1`         split into `2` (num), `>` (op) and `&1` (uncoloured).
 *   `-eq` `-match` coloured as parameters, because `/^-/` was tested first.
 *   `&&` `||` `;`  no class at all.
 *   second stage   never coloured as a command, because `first` was a
 *                  whole-line boolean.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { highlight } from '../../src/language/highlight.ts';
import { parseForExecution } from '../../src/language/parse.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  readFileSync(resolve(HERE, 'fixtures/lexer-corpus.json'), 'utf8'),
) as readonly string[];

/** The class covering the first occurrence of `needle` in `line`. */
function classAt(line: string, needle: string): string | null | undefined {
  const at = line.indexOf(needle);
  assert.notEqual(at, -1, `${JSON.stringify(needle)} is not in ${JSON.stringify(line)}`);
  return highlight(line).find((s) => s.start === at)?.className;
}

describe('the highlighter shares the real lexer', () => {
  it('colours a redirection as refused, because nothing implements it', () => {
    // The roadmap's own example. v1 gave these the `op` class.
    assert.equal(classAt('Get-ChildItem > out.txt', '>'), 'refused');
    assert.equal(classAt('Get-ChildItem >> out.txt', '>>'), 'refused');
    assert.equal(classAt('Get-Content < in.txt', '<'), 'refused');
  });

  it('treats 2>&1 as ONE span, not three', () => {
    // v1's alternation produced `2` -> num, `>` -> op, `&1` -> nothing.
    const spans = highlight('Get-ChildItem 2>&1');
    const redirection = spans.find((s) => s.text === '2>&1');
    assert.ok(redirection !== undefined, 'the redirection was split up');
    assert.equal(redirection.className, 'refused');
  });

  it('never colours -eq as a parameter, and -Path always as one', () => {
    // v1 tested `/^-/` before its operator list, so `-eq`, `-match` and `-like`
    // all came out `param` — the same colour as `-Path`, which is a different
    // thing entirely.
    //
    // Here `-eq` comes out `refused`, and that is not a weaker answer than
    // `op`: `$x -eq 1` is a comparison EXPRESSION, and this engine has no
    // expression evaluator, so the whole statement is refused as
    // BinaryExpressionAst. Colouring it `op` would be v1's mistake in a
    // different costume — telling the reader the line is fine when it will not
    // run. What matters is that it is never `param`.
    assert.notEqual(classAt('$x -eq 1', '-eq'), 'param');
    assert.equal(classAt('$x -eq 1', '-eq'), 'refused');
    assert.notEqual(classAt('$x -match "a"', '-match'), 'param');

    // A real parameter, on a line the engine really runs.
    assert.equal(classAt('Get-ChildItem -Path /home', '-Path'), 'param');
    assert.equal(classAt('Get-ChildItem -Path /home -Recurse', '-Recurse'), 'param');
    assert.equal(parseForExecution('Get-ChildItem -Path /home -Recurse').ok, true);
  });

  it('colours --Path as an argument, because pwsh says it is one', () => {
    // Measured: `Get-Item --Path` lexes as two Generic tokens. The old
    // `tokenize.ts` and v1's FLAGRE both called it a parameter; `binder.ts`
    // called it an argument. The highlighter now agrees with the binder,
    // because they read the same lexer.
    assert.notEqual(classAt('Get-Item --Path', '--Path'), 'param');
  });

  it('gives the separators a class, and it is not the same class for all four', () => {
    // v1 gave `&&`, `||` and `;` NO class at all, which is the defect this
    // pins. What class each one gets is decided by whether the engine can run
    // the line, exactly as for `-eq` above.
    //
    // `;` and `|` are `op`: `a | b` really runs, and `a ; b` is two statements
    // the parser builds correctly — the kernel declines to run two per exec,
    // but that is a property of exec, not of the syntax.
    //
    // `&&` and `||` are `refused`, and this asserted `op` for one commit. The
    // roadmap's complaint about v1 was that it "colours `>`, `>>` and `<` that
    // nothing implements"; nothing implements a pipeline chain either —
    // measured, pwsh runs `b` in `a && b` only when `a` succeeded, and this
    // engine has one process group per exec — so `op` was that same defect in a
    // different costume. `EXECUTION_REFUSED_NODES` names PipelineChainAst now,
    // and `compat/profiles/*.json` declares it.
    assert.equal(classAt('a ; b', ';'), 'op');
    assert.equal(classAt('a | b', '|'), 'op');
    assert.equal(classAt('a && b', '&&'), 'refused');
    assert.equal(classAt('a || b', '||'), 'refused');

    // The colour comes WITH the reason, so a host can say why rather than only
    // paint it red.
    const chain = highlight('a && b').find((s) => s.text === '&&');
    assert.match(chain?.refusal ?? '', /PipelineChainAst/u);
  });

  it('colours the head of every pipeline stage as a command', () => {
    // v1's `first` was a whole-line boolean, so `Sort-Object` here was never
    // `cmd`.
    const line = 'Get-ChildItem | Sort-Object Name';
    assert.equal(classAt(line, 'Get-ChildItem'), 'cmd');
    assert.equal(classAt(line, 'Sort-Object'), 'cmd');
    assert.equal(classAt(line, 'Name'), null);
  });

  it('colours a comment, which v1 had no class for', () => {
    assert.equal(classAt('Get-Date # note', '# note'), 'comment');
  });

  it('does not paint a half-typed line red', () => {
    // Incomplete is not refused: the prompt would flash on every keystroke.
    const spans = highlight("Get-ChildItem -Path 'my fi");
    assert.deepEqual(
      spans.filter((s) => s.className === 'refused').map((s) => s.text),
      [],
    );
    assert.equal(classAt("Get-ChildItem -Path 'my fi", "'my fi"), 'str');
  });
});

describe('the highlighter cannot colour what the engine rejects', () => {
  it('paints every refused span as refused, across the measured corpus', () => {
    // THE GUARANTEE. For every line in the corpus, any span the execution
    // parser refuses must carry the `refused` class — never `cmd`, `param`,
    // `str`, `num`, `op` or `var`.
    const incomplete = new Set([
      'TerminatorExpectedAtEndOfString',
      'MissingEndCurlyBrace',
      'MissingTerminatorMultiLineComment',
      'EmptyPipeElement',
      'MissingArgument',
      'MissingFileSpecification',
      'WhitespaceBeforeHereStringFooter',
    ]);

    let checked = 0;
    for (const source of corpus) {
      const parsed = parseForExecution(source);
      if (parsed.ok) continue;
      const ranges = parsed.refusals.filter((r) => !incomplete.has(r.id));
      if (ranges.length === 0) continue;

      for (const span of highlight(source)) {
        if (span.className === null || span.className === 'refused') continue;
        const covered = ranges.some(
          (r) => (span.start >= r.start && span.end <= r.end) ||
            (r.start >= span.start && r.start < span.end),
        );
        assert.equal(
          covered,
          false,
          `${JSON.stringify(source)}: ${JSON.stringify(span.text)} was coloured ` +
            `"${span.className}" inside a span the engine refuses`,
        );
        checked += 1;
      }
    }
    assert.ok(checked > 0, 'no refused lines were exercised; the corpus lost its coverage');
  });

  it('every refused span explains itself', () => {
    for (const span of highlight('Get-ChildItem > out.txt')) {
      if (span.className !== 'refused') continue;
      assert.ok(
        (span.refusal ?? '').includes('FileRedirectionAst'),
        'a refused span must carry the reason, naming the node',
      );
    }
  });

  it('reproduces the input character for character', () => {
    // v1's highlighter preserved the input, and that matters: the echoed
    // transcript is built from these spans.
    for (const source of corpus) {
      assert.equal(
        highlight(source).map((s) => s.text).join(''),
        source,
      );
    }
  });
});
