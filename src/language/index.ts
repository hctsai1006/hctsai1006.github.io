/**
 * The language surface: one lexer, one AST, two parsers, one highlighter.
 *
 * Everything that needs to know what a command line MEANS goes through here.
 * The point of the barrel is not convenience — it is that there is a single
 * door, so a second tokenizer would have to be a visible, deliberate act rather
 * than a quiet convenience in some other module. Nine of them arrived quietly.
 */

export { lex, type LexOptions } from './lexer.ts';

export {
  DASH_OPERATORS,
  STRING_KINDS,
  type Diagnostic,
  type LexerMode,
  type LexResult,
  type QuoteStyle,
  type Token,
  type TokenKind,
} from './tokens.ts';

export {
  PWSH_AST_NODES,
  expressionText,
  unsupportedNodes,
  walk,
  type Ast,
  type CommandAst,
  type CommandElementAst,
  type CommandExpressionAst,
  type CommandParameterAst,
  type ConstantExpressionAst,
  type ExpandableStringExpressionAst,
  type ExpressionAst,
  type Extent,
  type FileRedirectionAst,
  type MergingRedirectionAst,
  type PipelineAst,
  type PipelineChainAst,
  type PipelineElementAst,
  type PwshAstNode,
  type RedirectionAst,
  type ScriptBlockAst,
  type ScriptBlockExpressionAst,
  type StatementAst,
  type StatementBlockAst,
  type StringConstantExpressionAst,
  type UnsupportedSyntaxAst,
  type VariableExpressionAst,
} from './ast.ts';

export {
  commandArguments,
  parseForEditing,
  parseForExecution,
  parseScript,
  pipelineStages,
  type ExecutableScript,
  type ExecutionParse,
  type ExecutionRefusal,
  type ParseResult,
} from './parse.ts';

export {
  EXECUTION_REFUSAL_REASONS,
  EXECUTION_REFUSED_NODES,
  MESSAGE_ONLY_NODES,
  REFUSED_WITHOUT_A_TABLE,
  UNIMPLEMENTED_KEYWORDS,
  UNIMPLEMENTED_SYNTAX,
  unimplementedAstNodes,
  unimplementedMessage,
} from './unimplemented.ts';

export { highlight, type HighlightClass, type HighlightSpan } from './highlight.ts';
