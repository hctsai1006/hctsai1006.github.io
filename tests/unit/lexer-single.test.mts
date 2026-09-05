/**
 * There is exactly ONE lexer.
 *
 * Modelled on `psobject.test.mts`'s "there is exactly one value-to-string
 * implementation", which exists because three renderings once disagreed. This
 * is the same gate for the same defect shape, at six times the size: there were
 * NINE tokenizers.
 *
 *   v1 (index.html, duplicated verbatim into legacy/terminal-v1.html):
 *     splitPipe                index.html:1625   quote-aware pipe splitter
 *     the execOne regex        index.html:1647   /"[^"]*"|'[^']*'|\S+/g
 *     parseArgsOf              index.html:1633   FLAGRE + next-token values
 *     highlightInto            index.html:1453   a different regex again
 *     currentToken             index.html:1562   lastIndexOf(' ')
 *
 *   the rewrite:
 *     line-editor/tokenize.ts                    its own quote and escape rules
 *     kernel.ts splitPipeline + splitTokens      split(/\s+/u)
 *     binder.ts parseParameterToken              a third parameter classifier
 *
 * They disagreed about `--Path`, about `-Path a,b`, about `2>&1`, and about
 * whether a quoted argument survives to the binder at all.
 *
 * Two kinds of check here, because either alone is escapable:
 *
 *   STRUCTURAL — every consumer imports the one lexer and none defines its own.
 *   BEHAVIOURAL — the three views produce the same spans over the measured
 *                 corpus. A second implementation that happened to be imported
 *                 correctly would still fail this.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { lex } from '../../src/language/lexer.ts';
import { highlight } from '../../src/language/highlight.ts';
import { commandArguments, parseForEditing, pipelineStages } from '../../src/language/parse.ts';
import { tokenize } from '../../src/line-editor/tokenize.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../../src');

const corpus = JSON.parse(
  readFileSync(resolve(HERE, 'fixtures/lexer-corpus.json'), 'utf8'),
) as readonly string[];

/** Every `.ts` under `src/`, recursively. */
function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) found.push(full);
  }
  return found;
}

describe('there is exactly one lexer', () => {
  it('every view of the token stream is the same span list', () => {
    // The strongest form of the claim: if `tokenize`, `highlight` and
    // `parseForEditing` were reading different lexers, this diverges.
    for (const source of corpus) {
      const canonical = lex(source).tokens;

      // The parser reports the token stream it parsed, trivia included.
      assert.deepEqual(
        parseForEditing(source).tokens.map((t) => [t.kind, t.start, t.end]),
        canonical.map((t) => [t.kind, t.start, t.end]),
        `the parser lexed ${JSON.stringify(source)} differently`,
      );

      // The line editor's projection drops trivia and re-labels, but the SPANS
      // must be the canonical ones.
      const trivia = new Set(['Comment', 'LineContinuation']);
      assert.deepEqual(
        tokenize(source).map((t) => [t.start, t.end, t.text, t.value]),
        canonical
          .filter((t) => !trivia.has(t.kind))
          .map((t) => [t.start, t.end, t.text, t.value]),
        `the line editor lexed ${JSON.stringify(source)} differently`,
      );

      // The highlighter emits a span per token plus whitespace fillers, so the
      // token spans are recovered by dropping the unclassified fillers that do
      // not correspond to a token.
      const tokenStarts = new Set(canonical.map((t) => t.start));
      assert.deepEqual(
        highlight(source)
          .filter((s) => tokenStarts.has(s.start) && s.end > s.start)
          .map((s) => [s.start, s.end]),
        canonical.filter((t) => t.end > t.start).map((t) => [t.start, t.end]),
        `the highlighter lexed ${JSON.stringify(source)} differently`,
      );
    }
  });

  it('reconstructs the input exactly, in every view', () => {
    // A tokenizer that loses a character corrupts the echoed transcript, and
    // v1's highlighter was the one thing that had to preserve the input.
    for (const source of corpus) {
      assert.equal(
        highlight(source)
          .map((s) => s.text)
          .join(''),
        source,
        `the highlighter did not reproduce ${JSON.stringify(source)}`,
      );
    }
  });

  it('no module under src/ carries a second quote-state machine', () => {
    // WHAT IS BEING LOOKED FOR, precisely. Every one of the nine tokenizers had
    // the same core: a loop with a variable holding "which quote am I inside",
    // compared against `'` and `"`. That shape is unmistakable and it is what
    // makes something a command-line lexer rather than a string utility.
    //
    // The first draft of this gate matched raw file text for regex shapes and
    // produced five false positives — three of them regexes quoted INSIDE
    // COMMENTS that exist to explain the difference between v1's `/^-/` and the
    // binder's `/^-{1,2}[A-Za-z]/`, and two of them `split(/\s+/)` on a string
    // VALUE (`-split` in operators/strings.ts, word counting in
    // measure-object.ts). Neither is a command-line tokenizer, and a gate that
    // cries wolf about them is a gate somebody widens until it says nothing.
    //
    // So this parses the file and looks only at CODE, and only for the one
    // shape that matters.
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const relative = file.replace(/\\/gu, '/').split('/src/')[1] ?? file;
      // The one lexer is allowed to lex.
      if (relative === 'language/lexer.ts') continue;

      const tree = ts.createSourceFile(
        relative,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );

      const compared = new Set<string>();
      const visit = (node: ts.Node): void => {
        // `x === '"'`, `x === "'"`, `x === '|'`, `` x === '`' ``.
        if (ts.isBinaryExpression(node) && ts.isStringLiteral(node.right)) {
          compared.add(node.right.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(tree);

      // BOTH quote styles, AND a shell metacharacter. The quote pair alone is
      // not enough: .NET custom format strings use `'` and `"` as literal
      // delimiters, so `formatting/datetime.ts`, `commands/native/datetime.ts`
      // and `binding/validation.ts` all compare against both and none of them
      // is a command-line lexer. Requiring `|` or a backtick alongside is what
      // separates "handles quotes" from "lexes a command line" — kernel.ts's
      // splitPipeline compares against `'`, `"` and `|` in the same loop.
      const bothQuotes = compared.has('"') && compared.has("'");
      const shellMetacharacter = compared.has('|') || compared.has('`');
      if (bothQuotes && shellMetacharacter) offenders.push(relative);
    }

    // `src/kernel/kernel.ts` is expected here until integration deletes
    // `splitPipeline` and `splitTokens` — its own comment already says "NOT THE
    // PARSER. Delete this when the binder lands; PR-08 owns lexing". This gate
    // names the survivors so the count can only go down, rather than being
    // silent about them.
    const KNOWN_SURVIVORS = ['kernel/kernel.ts'];
    const unexpected = offenders.filter((o) => !KNOWN_SURVIVORS.includes(o));
    assert.deepEqual(unexpected, [], `a second tokenizer appeared in:\n${unexpected.join('\n')}`);

    // And the survivors really are still there, so this list cannot rot into a
    // permanent exemption for something already deleted.
    for (const survivor of KNOWN_SURVIVORS) {
      assert.ok(
        offenders.includes(survivor),
        `${survivor} no longer tokenizes; drop it from KNOWN_SURVIVORS`,
      );
    }
  });

  it('the line editor imports the shared lexer rather than defining one', () => {
    const text = readFileSync(join(SRC, 'line-editor/tokenize.ts'), 'utf8');
    assert.match(text, /from '\.\.\/language\/lexer\.ts'/u);
    // The rules it used to own, gone: no quote scanning, no escape table.
    assert.doesNotMatch(text, /readQuoted|BREAKS|SEPARATORS|isRedirectionAt/u);
  });

  it('the highlighter is computed from the parser, not from its own regex', () => {
    const text = readFileSync(join(SRC, 'language/highlight.ts'), 'utf8');
    assert.match(text, /parseForExecution/u);
    assert.match(text, /from '\.\/lexer\.ts'/u);
  });

  it('handles the cases kernel.ts splitTokens gets wrong, so it can be deleted', () => {
    // Forward-looking rather than an assertion about the defect: these are the
    // inputs `stage.split(/\s+/u)` mangles, and they are what integration needs
    // to be sure of before removing it.

    const quoted = stagesOf("Write-Output 'a b c'");
    assert.equal(quoted.length, 1);
    assert.deepEqual(commandArguments(quoted[0]!), ['a b c']);

    const piped = stagesOf("Write-Output 'a|b' | Sort-Object Name");
    assert.deepEqual(
      piped.map((s) => s.commandName),
      ['Write-Output', 'Sort-Object'],
    );
    assert.deepEqual(commandArguments(piped[0]!), ['a|b']);

    // splitTokens would produce ['-Path', '"my', 'file"'] — three arguments for
    // one value, which is how a quoted path reached the binder in pieces.
    const spaced = stagesOf('Get-ChildItem -Path "my file"');
    assert.deepEqual(commandArguments(spaced[0]!), ['-Path', 'my file']);

    function stagesOf(line: string) {
      const statements = parseForEditing(line).ast.statements;
      return statements.flatMap((s) =>
        s.kind === 'PipelineAst' || s.kind === 'PipelineChainAst' ? [...pipelineStages(s)] : [],
      );
    }
  });
});

