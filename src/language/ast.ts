/**
 * ast.ts — one AST, named the way the reference implementation names its own.
 *
 * The node names here are members of pwsh's `System.Management.Automation.
 * Language.Ast` hierarchy, read out of the assembly rather than invented:
 *
 *     [Ast].Assembly.GetTypes() | ? { $_.IsSubclassOf([Ast]) -and !$_.IsAbstract }
 *
 * gives 63 concrete types in pwsh 7.6.5, listed in `PWSH_AST_NODES` below.
 *
 * ── WHY THE NAMES MATTER MORE THAN USUAL ──────────────────────────────────
 *
 * The project's central rule is that recognised-but-unimplemented syntax must
 * fail with an explicit error NAMING the node, never approximate it silently —
 * `compat/profiles/*.json` says so in `engineLimits.notes`, and
 * `src/commands/manifest.ts`'s fidelity taxonomy is the same argument applied
 * to commands. An error naming a node this project made up would be
 * unlookupable: a user cannot search for it, and it cannot be compared against
 * what pwsh calls the same thing. So `UnsupportedSyntaxAst.nodeType` is
 * constrained to the real list, and a typo is a type error.
 *
 * ── WHAT IS MODELLED ──────────────────────────────────────────────────────
 *
 * The nodes this engine can EXECUTE, and one node — `UnsupportedSyntaxAst` —
 * standing for everything it recognises and cannot. That is deliberately not
 * the same as "the nodes pwsh has": a half-built `IfStatementAst` that runs the
 * wrong branch is worse than an honest refusal, and this repository has the
 * scars to prove it.
 */

/**
 * Every concrete AST node type in pwsh 7.6.5, as reported by its own assembly.
 *
 * Used to constrain the name in a refusal so it is always a name that exists.
 */
export const PWSH_AST_NODES = [
  'ArrayExpressionAst', 'ArrayLiteralAst', 'AssignmentStatementAst', 'AttributeAst',
  'AttributedExpressionAst', 'BaseCtorInvokeMemberExpressionAst', 'BinaryExpressionAst',
  'BlockStatementAst', 'BreakStatementAst', 'CatchClauseAst', 'CommandAst',
  'CommandExpressionAst', 'CommandParameterAst', 'ConfigurationDefinitionAst',
  'ConstantExpressionAst', 'ContinueStatementAst', 'ConvertExpressionAst',
  'DataStatementAst', 'DoUntilStatementAst', 'DoWhileStatementAst',
  'DynamicKeywordStatementAst', 'ErrorExpressionAst', 'ErrorStatementAst',
  'ExitStatementAst', 'ExpandableStringExpressionAst', 'FileRedirectionAst',
  'ForEachStatementAst', 'ForStatementAst', 'FunctionDefinitionAst', 'FunctionMemberAst',
  'HashtableAst', 'IfStatementAst', 'IndexExpressionAst', 'InvokeMemberExpressionAst',
  'MemberExpressionAst', 'MergingRedirectionAst', 'NamedAttributeArgumentAst',
  'NamedBlockAst', 'ParamBlockAst', 'ParameterAst', 'ParenExpressionAst', 'PipelineAst',
  'PipelineChainAst', 'PropertyMemberAst', 'ReturnStatementAst', 'ScriptBlockAst',
  'ScriptBlockExpressionAst', 'StatementBlockAst', 'StringConstantExpressionAst',
  'SubExpressionAst', 'SwitchStatementAst', 'TernaryExpressionAst', 'ThrowStatementAst',
  'TrapStatementAst', 'TryStatementAst', 'TypeConstraintAst', 'TypeDefinitionAst',
  'TypeExpressionAst', 'UnaryExpressionAst', 'UsingExpressionAst', 'UsingStatementAst',
  'VariableExpressionAst', 'WhileStatementAst',
] as const;

export type PwshAstNode = (typeof PWSH_AST_NODES)[number];

/** Source span, in code units, matching the token offsets the lexer reports. */
export interface Extent {
  readonly start: number;
  /** Exclusive. */
  readonly end: number;
  readonly text: string;
}

interface NodeBase {
  readonly extent: Extent;
}

// ---------------------------------------------------------------------------
// expressions this engine can evaluate
// ---------------------------------------------------------------------------

/**
 * A bare word or single-quoted string — a value with nothing to expand.
 *
 * `value` is the DECODED text, which is the field nine tokenizers disagreed
 * about. `Get-Item a"b"c` carries `abc` here, not `a"b"c`.
 */
export interface StringConstantExpressionAst extends NodeBase {
  readonly kind: 'StringConstantExpressionAst';
  readonly value: string;
  /** How it was written, so the highlighter and completion can re-quote it. */
  readonly stringConstantType: 'BareWord' | 'SingleQuoted' | 'SingleQuotedHereString';
}

/**
 * A double-quoted or expandable here-string.
 *
 * Kept DISTINCT from the constant form even though this engine has no variable
 * expansion yet, because collapsing them would make `"$x"` and `'$x'` the same
 * value — and the day expansion arrives, every call site would have to be
 * revisited to find which of the two it meant.
 */
export interface ExpandableStringExpressionAst extends NodeBase {
  readonly kind: 'ExpandableStringExpressionAst';
  /** The text between the quotes, escapes resolved, `$` sequences NOT expanded. */
  readonly value: string;
  readonly stringConstantType: 'DoubleQuoted' | 'DoubleQuotedHereString';
}

export interface VariableExpressionAst extends NodeBase {
  readonly kind: 'VariableExpressionAst';
  /** Without the `$`. `$env:PATH` keeps the `env:` scope in the name. */
  readonly variablePath: string;
  /** `@x` rather than `$x`. */
  readonly splatted: boolean;
}

export interface ConstantExpressionAst extends NodeBase {
  readonly kind: 'ConstantExpressionAst';
  /** The literal source text. Numeric conversion belongs to the binder. */
  readonly value: string;
}

/** `{ ... }` — its contents are lexed but not parsed until something runs them. */
export interface ScriptBlockExpressionAst extends NodeBase {
  readonly kind: 'ScriptBlockExpressionAst';
  /** The text between the braces, so `Where-Object { ... }` can be handed it. */
  readonly body: string;
}

export type ExpressionAst =
  | StringConstantExpressionAst
  | ExpandableStringExpressionAst
  | VariableExpressionAst
  | ConstantExpressionAst
  | ScriptBlockExpressionAst
  | UnsupportedSyntaxAst;

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

/**
 * `-Name`, or `-Name:value` with the value attached.
 *
 * The colon form is one AST node and TWO tokens, which is how pwsh models it
 * too. Keeping `argument` here rather than as a following element is what lets
 * the binder tell `-Switch:$false` from `-Switch $false` — the distinction
 * `switchSemantics` exists for.
 */
export interface CommandParameterAst extends NodeBase {
  readonly kind: 'CommandParameterAst';
  /** Without the dash and without the colon. */
  readonly parameterName: string;
  /** Present only for the `-Name:value` form. */
  readonly argument: ExpressionAst | null;
}

export type CommandElementAst = ExpressionAst | CommandParameterAst;

/** `command > file`, `2>> file`. */
export interface FileRedirectionAst extends NodeBase {
  readonly kind: 'FileRedirectionAst';
  /** `1`-`6`, or `*` for all streams. */
  readonly fromStream: string;
  readonly append: boolean;
  readonly file: ExpressionAst | null;
}

/** `2>&1`. pwsh only supports merging INTO stream 1; see `lexer.ts`. */
export interface MergingRedirectionAst extends NodeBase {
  readonly kind: 'MergingRedirectionAst';
  readonly fromStream: string;
  readonly toStream: string;
}

export type RedirectionAst = FileRedirectionAst | MergingRedirectionAst;

export interface CommandAst extends NodeBase {
  readonly kind: 'CommandAst';
  /** The head, as written. Resolution to a module is the registry's job. */
  readonly commandName: string;
  /** The head plus every argument, in source order. */
  readonly elements: readonly CommandElementAst[];
  readonly redirections: readonly RedirectionAst[];
  /** `&` — the whole pipeline runs in the background, recorded on each stage. */
  readonly background: boolean;
}

/** `$x`, `"literal"` or any expression used as a statement rather than a command. */
export interface CommandExpressionAst extends NodeBase {
  readonly kind: 'CommandExpressionAst';
  readonly expression: ExpressionAst;
  readonly redirections: readonly RedirectionAst[];
}

export type PipelineElementAst = CommandAst | CommandExpressionAst;

export interface PipelineAst extends NodeBase {
  readonly kind: 'PipelineAst';
  readonly elements: readonly PipelineElementAst[];
  readonly background: boolean;
}

/** `a && b`, `a || b`. Left-associative, as pwsh builds it. */
export interface PipelineChainAst extends NodeBase {
  readonly kind: 'PipelineChainAst';
  readonly lhs: PipelineAst | PipelineChainAst;
  readonly rhs: PipelineAst;
  readonly operator: 'AndAnd' | 'OrOr';
}

// ---------------------------------------------------------------------------
// the refusal node
// ---------------------------------------------------------------------------

/**
 * Syntax this engine RECOGNISED and does not implement.
 *
 * This node is the whole of task 3. It exists so that "we cannot run this" is a
 * value in the tree with a source span and a real pwsh node name attached,
 * rather than a silent reinterpretation as something else. The editing parser
 * produces it happily — the highlighter still colours `if` as a keyword — and
 * the execution parser turns every one it finds into an error that names the
 * node.
 *
 * `nodeType` is a `PwshAstNode`, so it can only ever be a name that really
 * exists in the reference implementation.
 */
export interface UnsupportedSyntaxAst extends NodeBase {
  readonly kind: 'UnsupportedSyntaxAst';
  readonly nodeType: PwshAstNode;
  /** What pwsh would do with it, in one clause, for the error message. */
  readonly describes: string;
}

// ---------------------------------------------------------------------------
// statements and the root
// ---------------------------------------------------------------------------

export type StatementAst = PipelineAst | PipelineChainAst | UnsupportedSyntaxAst;

export interface StatementBlockAst extends NodeBase {
  readonly kind: 'StatementBlockAst';
  readonly statements: readonly StatementAst[];
}

/**
 * The root. One submitted line is one of these.
 *
 * pwsh wraps statements in a `NamedBlockAst` (the implicit end block) inside a
 * `ScriptBlockAst`; that indirection carries nothing this engine reads, so the
 * statements hang directly off the root and `NamedBlockAst` is simply not
 * modelled. Named rather than silently flattened, because the difference is
 * visible to anyone comparing this tree with pwsh's.
 */
export interface ScriptBlockAst extends NodeBase {
  readonly kind: 'ScriptBlockAst';
  readonly statements: readonly StatementAst[];
}

export type Ast =
  | ScriptBlockAst
  | StatementBlockAst
  | StatementAst
  | PipelineElementAst
  | CommandElementAst
  | RedirectionAst;

/** Walk every node in the tree, parents before children. */
export function* walk(node: Ast): Generator<Ast> {
  yield node;
  switch (node.kind) {
    case 'ScriptBlockAst':
    case 'StatementBlockAst':
      for (const statement of node.statements) yield* walk(statement);
      return;
    case 'PipelineAst':
      for (const element of node.elements) yield* walk(element);
      return;
    case 'PipelineChainAst':
      yield* walk(node.lhs);
      yield* walk(node.rhs);
      return;
    case 'CommandAst':
      for (const element of node.elements) yield* walk(element);
      for (const redirection of node.redirections) yield* walk(redirection);
      return;
    case 'CommandExpressionAst':
      yield* walk(node.expression);
      for (const redirection of node.redirections) yield* walk(redirection);
      return;
    case 'CommandParameterAst':
      if (node.argument !== null) yield* walk(node.argument);
      return;
    case 'FileRedirectionAst':
      if (node.file !== null) yield* walk(node.file);
      return;
    default:
      return;
  }
}

/** Every `UnsupportedSyntaxAst` in the tree, in source order. */
export function unsupportedNodes(root: Ast): readonly UnsupportedSyntaxAst[] {
  const found: UnsupportedSyntaxAst[] = [];
  for (const node of walk(root)) {
    if (node.kind === 'UnsupportedSyntaxAst') found.push(node);
  }
  return found.sort((a, b) => a.extent.start - b.extent.start);
}
