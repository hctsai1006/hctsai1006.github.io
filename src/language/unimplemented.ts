/**
 * unimplemented.ts — refusing recognised syntax BY NAME.
 *
 * The project's central rule, quoted from `compat/profiles/*.json`'s own
 * `engineLimits.notes`:
 *
 *   "BrowserShell emulates observable semantics; it does not execute
 *    PowerShell. Recognised-but-unimplemented syntax must fail with an explicit
 *    error naming the AST node rather than silently doing something
 *    approximate."
 *
 * That is the same argument `src/commands/manifest.ts` makes for commands: a
 * terminal that looks authoritative about everything is lying about most of it,
 * and being visibly honest about the simulated parts is what makes the real
 * parts credible. A parser that quietly treated `if ($x) { a } else { b }` as a
 * command called `if` with three arguments would be the parser-level version of
 * `ping` inventing round-trip times.
 *
 * ── THE NAMES ARE REAL ────────────────────────────────────────────────────
 *
 * Every `nodeType` below is a concrete type in pwsh 7.6.5's own AST hierarchy,
 * and `PwshAstNode` makes a typo a compile error. Two of the mappings are not
 * the obvious guess, and both were measured:
 *
 *   `workflow W { }`      -> FunctionDefinitionAst, not a workflow node. pwsh
 *                            parses it as a function and then raises
 *                            WorkflowNotSupportedInPowerShellCore separately.
 *   `configuration C { }` -> ConfigurationDefinitionAst, which DOES exist as
 *                            its own type even though DSC is not in PS 7 core.
 *
 * ── WHY A KEYWORD TABLE AND NOT A GRAMMAR ─────────────────────────────────
 *
 * Writing a real `if` parser in order to reject it would be the most expensive
 * possible way to say no, and every line of it would be a line that could
 * silently start working. Recognising the keyword is enough to name the node
 * honestly, which is all the rule asks for.
 */

import type { PwshAstNode } from './ast.ts';

/**
 * Statement keywords this engine recognises and does not implement, mapped to
 * the AST node the reference implementation would build.
 *
 * Lower-cased keys: PowerShell keywords are case-insensitive, and `IF` is the
 * same statement as `if`.
 */
export const UNIMPLEMENTED_KEYWORDS: ReadonlyMap<string, { node: PwshAstNode; describes: string }> =
  new Map([
    ['if', { node: 'IfStatementAst' as const, describes: 'a conditional statement' }],
    ['elseif', { node: 'IfStatementAst' as const, describes: 'a conditional statement' }],
    ['else', { node: 'IfStatementAst' as const, describes: 'a conditional statement' }],
    ['for', { node: 'ForStatementAst' as const, describes: 'a for loop' }],
    ['foreach', { node: 'ForEachStatementAst' as const, describes: 'a foreach loop' }],
    ['while', { node: 'WhileStatementAst' as const, describes: 'a while loop' }],
    ['do', { node: 'DoWhileStatementAst' as const, describes: 'a do loop' }],
    ['until', { node: 'DoUntilStatementAst' as const, describes: 'a do-until loop' }],
    ['switch', { node: 'SwitchStatementAst' as const, describes: 'a switch statement' }],
    ['function', { node: 'FunctionDefinitionAst' as const, describes: 'a function definition' }],
    ['filter', { node: 'FunctionDefinitionAst' as const, describes: 'a filter definition' }],
    // Measured: pwsh parses `workflow W { }` into a FunctionDefinitionAst and
    // reports WorkflowNotSupportedInPowerShellCore as a separate error.
    ['workflow', { node: 'FunctionDefinitionAst' as const, describes: 'a workflow definition' }],
    ['try', { node: 'TryStatementAst' as const, describes: 'a try statement' }],
    ['catch', { node: 'CatchClauseAst' as const, describes: 'a catch clause' }],
    ['finally', { node: 'TryStatementAst' as const, describes: 'a finally block' }],
    ['trap', { node: 'TrapStatementAst' as const, describes: 'a trap statement' }],
    ['class', { node: 'TypeDefinitionAst' as const, describes: 'a class definition' }],
    ['enum', { node: 'TypeDefinitionAst' as const, describes: 'an enum definition' }],
    ['data', { node: 'DataStatementAst' as const, describes: 'a data section' }],
    [
      'configuration',
      { node: 'ConfigurationDefinitionAst' as const, describes: 'a DSC configuration' },
    ],
    ['using', { node: 'UsingStatementAst' as const, describes: 'a using statement' }],
    ['param', { node: 'ParamBlockAst' as const, describes: 'a parameter block' }],
    ['begin', { node: 'NamedBlockAst' as const, describes: 'a begin block' }],
    ['process', { node: 'NamedBlockAst' as const, describes: 'a process block' }],
    ['end', { node: 'NamedBlockAst' as const, describes: 'an end block' }],
    ['clean', { node: 'NamedBlockAst' as const, describes: 'a clean block' }],
    ['return', { node: 'ReturnStatementAst' as const, describes: 'a return statement' }],
    ['throw', { node: 'ThrowStatementAst' as const, describes: 'a throw statement' }],
    ['exit', { node: 'ExitStatementAst' as const, describes: 'an exit statement' }],
    ['break', { node: 'BreakStatementAst' as const, describes: 'a break statement' }],
    ['continue', { node: 'ContinueStatementAst' as const, describes: 'a continue statement' }],
  ]);

/**
 * The complete list of AST nodes this engine refuses.
 *
 * THIS IS THE ENGINE'S OWN ANSWER, derived from the tables in this file rather
 * than declared beside them, so the list and the behaviour cannot disagree.
 *
 * It is also the SOURCE of `engineLimits.unimplementedAstNodes` in
 * `compat/profiles/*.json`: `tools/generate-compatibility-profile.mts` imports
 * this function and writes what it returns. The field used to be a literal `[]`
 * in the generator — an empty list beside `nativePowerShellEngine: false`,
 * which reads as "every AST node is implemented". Typing the names into the
 * generator instead would have reproduced the defect one step later, because a
 * second copy of a list drifts the first time a keyword is added below.
 *
 * Sorted, so the generated profiles do not churn on Map iteration order.
 *
 * WHAT IT DOES NOT COVER, stated so the field is not read as more than it is:
 * this is what the PARSER refuses. A HOST can refuse more. `Kernel.#exec`
 * declines `a && b` (PipelineChainAst) and a quoted command head
 * (CommandExpressionAst in pwsh) because one request is one process group and
 * nothing evaluates expressions — both using `unimplementedMessage` below, so
 * they read the same, but neither is in this list. They are deliberately not:
 * `parseForExecution`'s refusals are what `highlight.ts` paints, so adding
 * `PipelineChainAst` here would paint every token of `a && b` as refused while
 * the tree itself is built correctly and a host that ran chains would want it.
 * The consequence is that the profile field UNDERSTATES by those two, which is
 * the safe direction — `language-unimplemented.test.mts` pins that a profile
 * may never declare something the engine does run.
 */
export function unimplementedAstNodes(): readonly PwshAstNode[] {
  const nodes = new Set<PwshAstNode>(EXECUTION_REFUSED_NODES);
  for (const entry of UNIMPLEMENTED_KEYWORDS.values()) nodes.add(entry.node);
  for (const entry of UNIMPLEMENTED_SYNTAX.values()) nodes.add(entry.node);
  return [...nodes].sort();
}

/**
 * Nodes the parser BUILDS but the engine cannot run.
 *
 * The difference from the two tables around it matters. Those describe syntax
 * the parser declines to build a real node for. This describes a node that IS
 * in the tree, correctly, and that execution still refuses — so the editing
 * parser can hand the highlighter a proper `ScriptBlockExpressionAst`, and
 * completion can see inside `Where-Object { ... }`, while nothing pretends the
 * body can be evaluated.
 *
 * `ScriptBlockExpressionAst` is here because a script block is an OPAQUE HANDLE
 * in this engine (see `src/commands/powershell/support.ts`): the closure stays
 * in the realm that made it and there is no evaluator that could build one from
 * text. Refusing it is what keeps `Where-Object { $_.Length -gt 10 }` from
 * appearing to work; lifting it is one line the day an evaluator exists.
 */
export const EXECUTION_REFUSED_NODES: readonly PwshAstNode[] = [
  'ScriptBlockExpressionAst',
  'FileRedirectionAst',
  'MergingRedirectionAst',
];

/** Why each refused-but-built node is refused, for the error message. */
export const EXECUTION_REFUSAL_REASONS: ReadonlyMap<PwshAstNode, string> = new Map([
  [
    'ScriptBlockExpressionAst' as const,
    'a script block, which this engine can hold as an opaque handle but cannot evaluate from text',
  ],
  [
    // The roadmap's own indictment of the v1 highlighter was that it "colours
    // `>`, `>>` and `<` that nothing implements". Nothing implements them here
    // either — there is no stream-to-file plumbing — so they are refused rather
    // than accepted and dropped. Silently discarding a redirection is the worst
    // available answer: the command appears to succeed and the file never
    // appears.
    'FileRedirectionAst' as const,
    'output redirection to a file, which this engine does not implement',
  ],
  [
    'MergingRedirectionAst' as const,
    'stream merging redirection, which this engine does not implement',
  ],
]);

/**
 * Non-keyword syntax this engine recognises and refuses, keyed by the token kind
 * that introduces it.
 *
 * `RedirectInStd` is here for a different reason from the rest: pwsh 7.6.5
 * refuses `<` ITSELF with `RedirectionNotSupported`, so refusing it is fidelity
 * rather than a limitation. The v1 highlighter coloured `<` as an operator, and
 * the roadmap recorded that nothing implements it — the measurement says
 * nothing should.
 */
export const UNIMPLEMENTED_SYNTAX: ReadonlyMap<string, { node: PwshAstNode; describes: string }> =
  new Map([
    ['DollarParen', { node: 'SubExpressionAst' as const, describes: 'a subexpression $( )' }],
    ['AtParen', { node: 'ArrayExpressionAst' as const, describes: 'an array expression @( )' }],
    ['AtCurly', { node: 'HashtableAst' as const, describes: 'a hashtable @{ }' }],
    ['LBracket', { node: 'TypeExpressionAst' as const, describes: 'a type literal [ ]' }],
    ['Equals', { node: 'AssignmentStatementAst' as const, describes: 'an assignment' }],
    ['Dot', { node: 'MemberExpressionAst' as const, describes: 'a member access' }],
    ['ColonColon', { node: 'MemberExpressionAst' as const, describes: 'a static member access' }],
    ['DotDot', { node: 'BinaryExpressionAst' as const, describes: 'a range operator' }],
    ['QuestionMark', { node: 'TernaryExpressionAst' as const, describes: 'a ternary operator' }],
    [
      'QuestionQuestion',
      { node: 'BinaryExpressionAst' as const, describes: 'a null-coalescing operator' },
    ],
    ['Plus', { node: 'BinaryExpressionAst' as const, describes: 'an arithmetic operator' }],
    ['PlusPlus', { node: 'UnaryExpressionAst' as const, describes: 'an increment operator' }],
    ['Multiply', { node: 'BinaryExpressionAst' as const, describes: 'an arithmetic operator' }],
    ['Divide', { node: 'BinaryExpressionAst' as const, describes: 'an arithmetic operator' }],
    ['Rem', { node: 'BinaryExpressionAst' as const, describes: 'an arithmetic operator' }],
    ['Exclaim', { node: 'UnaryExpressionAst' as const, describes: 'a logical-not operator' }],
    ['Minus', { node: 'UnaryExpressionAst' as const, describes: 'a unary minus' }],
    ['MinusMinus', { node: 'UnaryExpressionAst' as const, describes: 'a decrement operator' }],
    ['LParen', { node: 'ParenExpressionAst' as const, describes: 'a parenthesised expression' }],
    ['Comma', { node: 'ArrayLiteralAst' as const, describes: 'an array literal' }],
    ['Ampersand', { node: 'CommandAst' as const, describes: 'the call operator &' }],
    [
      'RedirectInStd',
      { node: 'FileRedirectionAst' as const, describes: 'input redirection with <' },
    ],
  ]);

/**
 * The message a refusal prints.
 *
 * Shaped so the node name is unmissable and searchable, and so the sentence
 * says what is true — RECOGNISED, not implemented — rather than the misleading
 * "unknown" a parse failure would suggest.
 */
export function unimplementedMessage(nodeType: PwshAstNode, describes: string, text: string): string {
  const quoted = text.length > 40 ? `${text.slice(0, 37)}...` : text;
  return (
    `BrowserShell recognised ${describes} (${nodeType}) in "${quoted}", and does not implement it. ` +
    'This engine emulates observable PowerShell semantics; it does not execute PowerShell. ' +
    'Rather than run something approximate, it refuses.'
  );
}
