/**
 * The editing parser, the execution parser, and the rule that separates them.
 *
 * Three claims are pinned here, and they are the three ways this roadmap item
 * fails if it fails:
 *
 *   1. The editing parser accepts everything the execution parser accepts, and
 *      more. Not by inspection — asserted over the whole measured corpus.
 *   2. An unimplemented node can never reach execution, and the refusal NAMES
 *      the pwsh AST node.
 *   3. A command's arguments arrive DECODED, so `-Path "my file"` is one
 *      argument. `kernel.ts`'s `splitTokens` made it two, which is the defect
 *      the AST exists to remove.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  commandArguments,
  parseForEditing,
  parseForExecution,
  pipelineStages,
} from '../../src/language/parse.ts';
import { PWSH_AST_NODES, unsupportedNodes, walk } from '../../src/language/ast.ts';
import type { CommandAst, PipelineAst, PipelineChainAst } from '../../src/language/ast.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  readFileSync(resolve(HERE, 'fixtures/lexer-corpus.json'), 'utf8'),
) as readonly string[];

/** The command stages of a line, whatever statement shape it has. */
function stagesOf(line: string): readonly CommandAst[] {
  return parseForEditing(line).ast.statements.flatMap((statement) =>
    statement.kind === 'PipelineAst' || statement.kind === 'PipelineChainAst'
      ? [...pipelineStages(statement as PipelineAst | PipelineChainAst)]
      : [],
  );
}

describe('the editing parser', () => {
  it('never throws, on anything in the measured corpus', () => {
    for (const source of corpus) {
      const parsed = parseForEditing(source);
      assert.ok(parsed.ast.kind === 'ScriptBlockAst');
    }
  });

  it('returns a usable tree for a half-typed line', () => {
    // Every one of these is a person mid-keystroke, not an error.
    const partial = [
      "Get-ChildItem -Path 'my fi",
      'Get-ChildItem |',
      'Where-Object { $_.Length',
      'Get-ChildItem -Path',
      'Get-Ch',
    ];
    for (const line of partial) {
      const parsed = parseForEditing(line);
      assert.ok(
        parsed.ast.statements.length > 0,
        `${JSON.stringify(line)} produced no statement to work with`,
      );
    }
    // And the useful part survives: the command is still identifiable.
    assert.equal(stagesOf("Get-ChildItem -Path 'my fi")[0]?.commandName, 'Get-ChildItem');
    assert.deepEqual(commandArguments(stagesOf("Get-ChildItem -Path 'my fi")[0]!), [
      '-Path',
      'my fi',
    ]);
  });

  it('accepts a strict superset of what the execution parser accepts', () => {
    // The two-parsers-one-lexer shape, asserted rather than assumed. If this
    // ever fails, the highlighter can be shown something the engine would run —
    // or, worse, the engine can run something the highlighter never saw.
    for (const source of corpus) {
      const execution = parseForExecution(source);
      if (!execution.ok) continue;
      const editing = parseForEditing(source);
      assert.deepEqual(
        editing.tokens.map((t) => [t.kind, t.start]),
        execution.tokens.map((t) => [t.kind, t.start]),
        `the two parsers saw ${JSON.stringify(source)} differently`,
      );
    }
  });
});

describe('the execution parser refuses, by name', () => {
  const refusals: readonly [string, string][] = [
    ['if ($x) { 1 } else { 2 }', 'IfStatementAst'],
    ['foreach ($i in 1..3) { $i }', 'ForEachStatementAst'],
    ['while ($true) { break }', 'WhileStatementAst'],
    ['function f { 1 }', 'FunctionDefinitionAst'],
    ['try { 1 } catch { 2 }', 'TryStatementAst'],
    ['switch ($x) { 1 { "one" } }', 'SwitchStatementAst'],
    ['class C { }', 'TypeDefinitionAst'],
    ['trap { 1 }', 'TrapStatementAst'],
    ['data d { 1 }', 'DataStatementAst'],
    ['configuration C { }', 'ConfigurationDefinitionAst'],
    ['using namespace System', 'UsingStatementAst'],
    ['return 1', 'ReturnStatementAst'],
    ['$x = 1', 'AssignmentStatementAst'],
    ['[int]::MaxValue', 'TypeExpressionAst'],
    ['Where-Object { $_.Length -gt 10 }', 'ScriptBlockExpressionAst'],
    ['Get-ChildItem > out.txt', 'FileRedirectionAst'],
    ['Get-ChildItem 2>&1', 'MergingRedirectionAst'],
  ];

  for (const [source, nodeType] of refusals) {
    it(`refuses ${JSON.stringify(source)} as ${nodeType}`, () => {
      const parsed = parseForExecution(source);
      assert.equal(parsed.ok, false, `${JSON.stringify(source)} was accepted`);
      if (parsed.ok) return;
      const named = parsed.refusals.filter((r) => r.nodeType === nodeType);
      assert.ok(
        named.length > 0,
        `expected a refusal naming ${nodeType}, got ` +
          JSON.stringify(parsed.refusals.map((r) => r.nodeType ?? r.id)),
      );
      // The message must SAY the node name, because a caller that only prints
      // the message would otherwise lose the one fact that makes it lookupable.
      assert.ok(named[0]!.message.includes(nodeType));
      // And it must say it does not implement it, rather than "unknown".
      assert.match(named[0]!.message, /does not implement it/u);
    });
  }

  it('names only AST nodes the reference implementation actually has', () => {
    // A refusal naming a node pwsh does not have is unlookupable, which defeats
    // the point of naming it.
    const real = new Set<string>(PWSH_AST_NODES);
    for (const source of [...corpus, ...refusals.map(([s]) => s)]) {
      const parsed = parseForExecution(source);
      if (parsed.ok) continue;
      for (const refusal of parsed.refusals) {
        if (refusal.nodeType === null) continue;
        assert.ok(
          real.has(refusal.nodeType),
          `${refusal.nodeType} is not a pwsh AST node (from ${JSON.stringify(source)})`,
        );
      }
    }
  });

  it('lets no UnsupportedSyntaxAst through to a successful parse', () => {
    // The load-bearing invariant: if execution said yes, the tree it handed back
    // contains nothing the engine cannot run.
    for (const source of corpus) {
      const parsed = parseForExecution(source);
      if (!parsed.ok) continue;
      assert.deepEqual(
        unsupportedNodes(parsed.ast).map((n) => n.nodeType),
        [],
        `${JSON.stringify(source)} was accepted with unsupported nodes in the tree`,
      );
      for (const node of walk(parsed.ast)) {
        assert.notEqual(
          node.kind,
          'ScriptBlockExpressionAst',
          `${JSON.stringify(source)} was accepted with a script block in it`,
        );
      }
    }
  });

  it('refuses an incomplete line rather than guessing at it', () => {
    for (const source of ["Write-Output 'unterminated", 'Get-ChildItem |', 'Where-Object { $_']) {
      assert.equal(parseForExecution(source).ok, false, JSON.stringify(source));
    }
  });

  it('refuses what pwsh 7.6.5 refuses, carrying pwsh’s own error id', () => {
    // `<` and `1>&2` are not merely unimplemented here: real pwsh rejects them.
    for (const source of ['Get-Content < in.txt', 'Get-ChildItem 1>&2']) {
      const parsed = parseForExecution(source);
      assert.equal(parsed.ok, false);
      if (parsed.ok) return;
      assert.ok(
        parsed.refusals.some((r) => r.id === 'RedirectionNotSupported'),
        `expected pwsh’s RedirectionNotSupported for ${JSON.stringify(source)}`,
      );
    }
  });

  it('reports the first problem first', () => {
    const parsed = parseForExecution('Get-ChildItem > a.txt | if ($x) { 1 }');
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    const starts = parsed.refusals.map((r) => r.start);
    assert.deepEqual([...starts].sort((a, b) => a - b), starts);
  });
});

describe('the AST carries decoded arguments', () => {
  it('keeps a quoted argument whole', () => {
    // `splitTokens` produced ['-Path', '"my', 'file"'].
    assert.deepEqual(commandArguments(stagesOf('Get-ChildItem -Path "my file"')[0]!), [
      '-Path',
      'my file',
    ]);
  });

  it('does not split a pipeline inside a string', () => {
    const stages = stagesOf("Write-Output 'a|b' | Sort-Object Name");
    assert.deepEqual(stages.map((s) => s.commandName), ['Write-Output', 'Sort-Object']);
    assert.deepEqual(commandArguments(stages[0]!), ['a|b']);
  });

  it('keeps -Name:value as one element, which switch semantics depend on', () => {
    // `-Switch:$false` must be distinguishable from `-Switch $false`: the first
    // is an explicit false, the second is a switch followed by a positional
    // argument. The binder cannot tell them apart from a flat token list.
    const withColon = stagesOf('Get-Random -Shuffle:$false')[0]!;
    assert.deepEqual(commandArguments(withColon), ['-Shuffle:$false']);
    const element = withColon.elements[1];
    assert.equal(element?.kind, 'CommandParameterAst');
    if (element?.kind !== 'CommandParameterAst') return;
    assert.equal(element.parameterName, 'Shuffle');
    assert.notEqual(element.argument, null);

    const separate = stagesOf('Get-Random -Shuffle $false')[0]!;
    assert.deepEqual(commandArguments(separate), ['-Shuffle', '$false']);
    const first = separate.elements[1];
    assert.equal(first?.kind, 'CommandParameterAst');
    if (first?.kind !== 'CommandParameterAst') return;
    assert.equal(first.argument, null);
  });

  it('resolves escapes in a bare argument, as pwsh does', () => {
    // pwsh 7.6.5: `f a\`tb` -> Generic("a`tb") with value "a<TAB>b".
    assert.deepEqual(commandArguments(stagesOf('Write-Output a`tb')[0]!), ['a\tb']);
    assert.deepEqual(commandArguments(stagesOf('Write-Output a"b"c')[0]!), ['abc']);
  });

  it('builds a pipeline chain for && and ||', () => {
    const statement = parseForEditing('a && b || c').ast.statements[0];
    assert.equal(statement?.kind, 'PipelineChainAst');
    assert.deepEqual(stagesOf('a && b || c').map((s) => s.commandName), ['a', 'b', 'c']);
  });

  it('marks a background pipeline', () => {
    const statement = parseForEditing('Start-Sleep 1 &').ast.statements[0];
    assert.equal(statement?.kind, 'PipelineAst');
    if (statement?.kind !== 'PipelineAst') return;
    assert.equal(statement.background, true);
  });

  it('treats --% as verbatim, stopping where pwsh stops', () => {
    // Measured: `--%` runs to `|`, `&&`, `||` or a newline, but NOT to `;`.
    assert.deepEqual(commandArguments(stagesOf('cmd --% a ; b')[0]!), ['--%', 'a ; b']);
    const piped = stagesOf('cmd --% a | b');
    // `'a '`, with the trailing space. Verbatim means verbatim, and the pwsh
    // fixture records exactly this: Generic("a ") before the Pipe. The first
    // draft of this assertion said `'a'` and the lexer was right.
    assert.deepEqual(commandArguments(piped[0]!), ['--%', 'a ']);
    assert.equal(piped[1]?.commandName, 'b');
  });
});
