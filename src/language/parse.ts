/**
 * parse.ts — two parsers over one lexer, and the difference between them is
 * TOLERANCE, not grammar.
 *
 * ── THE SHAPE, AND WHY IT IS THIS SHAPE ───────────────────────────────────
 *
 * The editing parser runs on every keystroke, for the highlighter and for
 * completion. A half-typed line is its NORMAL input: `Get-ChildItem -Path 'my fi`
 * is not an error, it is a person in the middle of typing. So it never throws,
 * always returns a tree, and reports what is incomplete alongside it.
 *
 * The execution parser runs once, on submit, and refuses anything it cannot
 * faithfully run.
 *
 * They are NOT two grammars. `parseScript` builds one tree and both use it —
 * because two grammars is how the highlighter ends up colouring syntax the
 * engine rejects, which is one of the three ways this roadmap item fails. The
 * strictness lives entirely in `parseForExecution`'s gate, so the set of things
 * the editing parser accepts is a strict superset by construction, and
 * `tests/unit/language-parse.test.mts` asserts that rather than assuming it.
 *
 * ── WHAT EXECUTION REFUSES ────────────────────────────────────────────────
 *
 *   1. Anything incomplete. An unterminated string is fine to type and not fine
 *      to run.
 *   2. Any `UnsupportedSyntaxAst` — recognised syntax with no implementation.
 *      The error NAMES the pwsh AST node, which is the project's central rule.
 *   3. Any node in `EXECUTION_REFUSED_NODES` — built correctly, not runnable.
 *   4. Anything pwsh 7.6.5 itself refuses, such as `<` and `1>&2`. Those come
 *      through as ordinary lexer diagnostics carrying pwsh's own error id.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────────
 *
 * Expression evaluation. `$x + 1` parses to an `UnsupportedSyntaxAst` naming
 * `BinaryExpressionAst` and stops there. Building half an evaluator in order to
 * reject it would be the most expensive possible way to say no, and every line
 * of it could silently start working.
 */

import {
  type CommandAst,
  type CommandElementAst,
  type CommandExpressionAst,
  type Extent,
  type ExpressionAst,
  type PipelineAst,
  type PipelineChainAst,
  type PipelineElementAst,
  type PwshAstNode,
  type RedirectionAst,
  type ScriptBlockAst,
  type StatementAst,
  type UnsupportedSyntaxAst,
  unsupportedNodes,
  walk,
} from './ast.ts';
import { lex } from './lexer.ts';
import type { Diagnostic, Token } from './tokens.ts';
import {
  EXECUTION_REFUSAL_REASONS,
  EXECUTION_REFUSED_NODES,
  UNIMPLEMENTED_KEYWORDS,
  UNIMPLEMENTED_SYNTAX,
  unimplementedMessage,
} from './unimplemented.ts';

export interface ParseResult {
  readonly ast: ScriptBlockAst;
  readonly tokens: readonly Token[];
  readonly diagnostics: readonly Diagnostic[];
}

/** Trivia the parser skips but the highlighter still wants. */
const TRIVIA = new Set(['Comment', 'LineContinuation']);

// ---------------------------------------------------------------------------
// the one parser
// ---------------------------------------------------------------------------

class Parser {
  readonly #source: string;
  readonly #all: readonly Token[];
  readonly #tokens: readonly Token[];
  readonly #diagnostics: Diagnostic[];
  #i = 0;

  constructor(source: string) {
    this.#source = source;
    const lexed = lex(source);
    this.#all = lexed.tokens;
    this.#tokens = lexed.tokens.filter((t) => !TRIVIA.has(t.kind));
    this.#diagnostics = [...lexed.diagnostics];
  }

  parse(): ParseResult {
    const statements: StatementAst[] = [];
    while (this.#i < this.#tokens.length) {
      this.#skip(['Semi', 'NewLine']);
      if (this.#i >= this.#tokens.length) break;
      const before = this.#i;
      const statement = this.#parseStatement();
      if (statement !== null) statements.push(statement);

      // A statement that consumed NOTHING would spin here forever. It happens:
      // a line beginning `|`, `&&` or `||` has no pipeline element to parse, so
      // `#parsePipeline` returns null having advanced past nothing.
      //
      // Found by fuzzing the finished parser, and it mattered more than most
      // bugs would: the editing parser runs on EVERY KEYSTROKE, so a user
      // typing a leading `|` hung the page rather than seeing a red squiggle.
      // The lexer has carried the same guard from the start; the parser needed
      // its own.
      if (this.#i === before) {
        const token = this.#peek();
        this.#i += 1;
        if (token !== undefined) {
          this.#diagnose(
            'UnexpectedToken',
            `Unexpected token "${token.text}" in expression or statement.`,
            token.start,
            token.end,
            // Incomplete: a leading `|` is usually a line still being typed, and
            // painting it red on the way past would make the prompt flash.
            true,
          );
        }
      }
    }
    return {
      ast: {
        kind: 'ScriptBlockAst',
        extent: this.#extent(0, this.#source.length),
        statements,
      },
      tokens: this.#all,
      diagnostics: this.#diagnostics,
    };
  }

  // -- plumbing -------------------------------------------------------------

  #peek(offset = 0): Token | undefined {
    return this.#tokens[this.#i + offset];
  }

  #skip(kinds: readonly string[]): void {
    while (this.#i < this.#tokens.length) {
      const token = this.#peek();
      if (token === undefined || !kinds.includes(token.kind)) return;
      this.#i += 1;
    }
  }

  #extent(start: number, end: number): Extent {
    return { start, end, text: this.#source.slice(start, end) };
  }

  #extentOf(token: Token): Extent {
    return this.#extent(token.start, token.end);
  }

  #unsupported(token: Token, nodeType: PwshAstNode, describes: string): UnsupportedSyntaxAst {
    return {
      kind: 'UnsupportedSyntaxAst',
      extent: this.#extentOf(token),
      nodeType,
      describes,
    };
  }

  #diagnose(id: string, message: string, start: number, end: number, incomplete: boolean): void {
    this.#diagnostics.push({ id, message, start, end, incomplete });
  }

  // -- statements -----------------------------------------------------------

  /** A pipeline, or a chain of pipelines joined by `&&` / `||`. */
  #parseStatement(): StatementAst | null {
    const head = this.#peek();
    if (head === undefined) return null;

    // A statement keyword is the honest refusal point: recognising the word is
    // enough to name the node, and parsing the construct in order to reject it
    // would be code that could silently start working.
    if (head.kind === 'Identifier' || head.kind === 'Generic') {
      const keyword = UNIMPLEMENTED_KEYWORDS.get(head.value.toLowerCase());
      if (keyword !== undefined) {
        // Consume the whole statement so one keyword does not produce a refusal
        // per token after it.
        const start = head.start;
        while (this.#i < this.#tokens.length && this.#peek()?.kind !== 'Semi') this.#i += 1;
        const end = this.#tokens[this.#i - 1]?.end ?? head.end;
        return {
          kind: 'UnsupportedSyntaxAst',
          extent: this.#extent(start, end),
          nodeType: keyword.node,
          describes: keyword.describes,
        };
      }
    }

    let left: PipelineAst | PipelineChainAst | null = this.#parsePipeline();
    if (left === null) return null;

    while (this.#i < this.#tokens.length) {
      const operator = this.#peek();
      if (operator?.kind !== 'AndAnd' && operator?.kind !== 'OrOr') break;
      this.#i += 1;
      const right = this.#parsePipeline();
      if (right === null) {
        this.#diagnose(
          'EmptyPipeElement',
          'An empty pipe element is not allowed.',
          operator.start,
          operator.end,
          true,
        );
        break;
      }
      const chain: PipelineChainAst = {
        kind: 'PipelineChainAst',
        extent: this.#extent(left.extent.start, right.extent.end),
        lhs: left,
        rhs: right,
        operator: operator.kind === 'AndAnd' ? 'AndAnd' : 'OrOr',
      };
      left = chain;
    }
    return left;
  }

  #parsePipeline(): PipelineAst | null {
    const elements: PipelineElementAst[] = [];
    const start = this.#peek()?.start ?? 0;
    let background = false;

    for (;;) {
      const element = this.#parsePipelineElement();
      if (element === null) {
        // `Get-ChildItem |` — measured, pwsh reports EmptyPipeElement and still
        // returns a tree. The editing parser needs exactly that.
        if (elements.length > 0) {
          const pipe = this.#tokens[this.#i - 1];
          if (pipe !== undefined) {
            this.#diagnose(
              'EmptyPipeElement',
              'An empty pipe element is not allowed.',
              pipe.start,
              pipe.end,
              true,
            );
          }
        }
        break;
      }
      elements.push(element);
      const next = this.#peek();
      if (next?.kind === 'Pipe') {
        this.#i += 1;
        continue;
      }
      if (next?.kind === 'Ampersand') {
        this.#i += 1;
        background = true;
      }
      break;
    }

    if (elements.length === 0) return null;
    const end = elements[elements.length - 1]?.extent.end ?? start;
    return {
      kind: 'PipelineAst',
      extent: this.#extent(start, end),
      elements: elements.map((element) =>
        element.kind === 'CommandAst' ? { ...element, background } : element,
      ),
      background,
    };
  }

  // -- commands -------------------------------------------------------------

  #parsePipelineElement(): PipelineElementAst | null {
    const head = this.#peek();
    if (head === undefined) return null;
    if (head.kind === 'Pipe' || head.kind === 'Semi' || head.kind === 'NewLine') return null;
    if (head.kind === 'AndAnd' || head.kind === 'OrOr') return null;

    // A command HEAD is a bare word or a string. Anything else starts an
    // expression statement, which this engine parses far enough to refuse.
    const isCommandHead =
      head.kind === 'Generic' ||
      head.kind === 'Identifier' ||
      head.kind === 'StringLiteral' ||
      head.kind === 'StringExpandable' ||
      head.kind === 'HereStringLiteral' ||
      head.kind === 'HereStringExpandable';

    if (!isCommandHead) return this.#parseExpressionStatement();
    return this.#parseCommand();
  }

  #parseCommand(): CommandAst {
    const head = this.#peek() as Token;
    this.#i += 1;
    const elements: CommandElementAst[] = [
      {
        kind: 'StringConstantExpressionAst',
        extent: this.#extentOf(head),
        value: head.value,
        stringConstantType: 'BareWord',
      },
    ];
    const redirections: RedirectionAst[] = [];
    let end = head.end;

    while (this.#i < this.#tokens.length) {
      const token = this.#peek();
      if (token === undefined) break;
      if (
        token.kind === 'Pipe' ||
        token.kind === 'Semi' ||
        token.kind === 'NewLine' ||
        token.kind === 'AndAnd' ||
        token.kind === 'OrOr' ||
        token.kind === 'Ampersand'
      ) {
        break;
      }

      if (token.kind === 'Redirection' || token.kind === 'RedirectInStd') {
        const redirection = this.#parseRedirection();
        if (redirection !== null) {
          redirections.push(redirection);
          end = redirection.extent.end;
        }
        continue;
      }

      if (token.kind === 'Parameter') {
        elements.push(this.#parseParameter());
        end = elements[elements.length - 1]?.extent.end ?? end;
        continue;
      }

      const argument = this.#parseArgument();
      if (argument === null) break;
      elements.push(argument);
      end = argument.extent.end;
    }

    return {
      kind: 'CommandAst',
      extent: this.#extent(head.start, end),
      commandName: head.value,
      elements,
      redirections,
      background: false,
    };
  }

  /**
   * `-Name` or `-Name:value`.
   *
   * The colon form keeps its argument INSIDE the parameter node, which is the
   * distinction `switchSemantics` rests on: `-Switch:$false` is one element and
   * `-Switch $false` is two, and a binder that cannot see the difference cannot
   * tell "explicitly false" from "false was the next positional argument".
   */
  #parseParameter(): CommandElementAst {
    const token = this.#peek() as Token;
    this.#i += 1;
    const written = token.text.replace(/^-+/u, '');
    const hasColon = written.endsWith(':');
    const name = hasColon ? written.slice(0, -1) : written;

    if (!hasColon) {
      return {
        kind: 'CommandParameterAst',
        extent: this.#extentOf(token),
        parameterName: name,
        argument: null,
      };
    }

    // Measured: `-Name:value` is `Parameter("-Name:")` then a separate token,
    // and `-Name:` with nothing after it is a parser error upstream.
    const next = this.#peek();
    if (next === undefined || next.start !== token.end) {
      this.#diagnose(
        'MissingArgument',
        `Parameter -${name}: requires an argument.`,
        token.start,
        token.end,
        true,
      );
      return {
        kind: 'CommandParameterAst',
        extent: this.#extentOf(token),
        parameterName: name,
        argument: null,
      };
    }
    const argument = this.#parseArgument();
    return {
      kind: 'CommandParameterAst',
      extent: this.#extent(token.start, argument?.extent.end ?? token.end),
      parameterName: name,
      argument,
    };
  }

  /** One command argument: a word, a string, a variable, a script block. */
  #parseArgument(): ExpressionAst | null {
    const token = this.#peek();
    if (token === undefined) return null;

    switch (token.kind) {
      case 'Generic':
      case 'Identifier':
        this.#i += 1;
        return {
          kind: 'StringConstantExpressionAst',
          extent: this.#extentOf(token),
          value: token.value,
          stringConstantType: 'BareWord',
        };
      case 'Number':
        this.#i += 1;
        return {
          kind: 'ConstantExpressionAst',
          extent: this.#extentOf(token),
          value: token.value,
        };
      case 'StringLiteral':
      case 'HereStringLiteral':
        this.#i += 1;
        return {
          kind: 'StringConstantExpressionAst',
          extent: this.#extentOf(token),
          value: token.value,
          stringConstantType:
            token.kind === 'StringLiteral' ? 'SingleQuoted' : 'SingleQuotedHereString',
        };
      case 'StringExpandable':
      case 'HereStringExpandable':
        this.#i += 1;
        return {
          kind: 'ExpandableStringExpressionAst',
          extent: this.#extentOf(token),
          value: token.value,
          stringConstantType:
            token.kind === 'StringExpandable' ? 'DoubleQuoted' : 'DoubleQuotedHereString',
        };
      case 'Variable':
      case 'SplattedVariable':
        this.#i += 1;
        return {
          kind: 'VariableExpressionAst',
          extent: this.#extentOf(token),
          variablePath: token.value,
          splatted: token.kind === 'SplattedVariable',
        };
      case 'LCurly':
        return this.#parseScriptBlock();
      default: {
        const syntax = UNIMPLEMENTED_SYNTAX.get(token.kind);
        if (syntax !== undefined) {
          this.#i += 1;
          return this.#unsupported(token, syntax.node, syntax.describes);
        }
        this.#i += 1;
        return this.#unsupported(token, 'ErrorExpressionAst', `the token "${token.text}"`);
      }
    }
  }

  /**
   * `{ ... }` — captured as TEXT, not parsed.
   *
   * A real node with a real body, so the highlighter and completion can work
   * inside it and a future evaluator has somewhere to start. Execution still
   * refuses it: see `EXECUTION_REFUSED_NODES`.
   */
  #parseScriptBlock(): ExpressionAst {
    const open = this.#peek() as Token;
    this.#i += 1;
    let depth = 1;
    let close: Token | undefined;
    const bodyStart = open.end;
    while (this.#i < this.#tokens.length) {
      const token = this.#peek() as Token;
      if (token.kind === 'LCurly') depth += 1;
      if (token.kind === 'RCurly') {
        depth -= 1;
        if (depth === 0) {
          close = token;
          this.#i += 1;
          break;
        }
      }
      this.#i += 1;
    }
    if (close === undefined) {
      this.#diagnose(
        'MissingEndCurlyBrace',
        "Missing closing '}' in statement block or type definition.",
        open.start,
        this.#source.length,
        true,
      );
      return {
        kind: 'ScriptBlockExpressionAst',
        extent: this.#extent(open.start, this.#source.length),
        body: this.#source.slice(bodyStart),
      };
    }
    return {
      kind: 'ScriptBlockExpressionAst',
      extent: this.#extent(open.start, close.end),
      body: this.#source.slice(bodyStart, close.start),
    };
  }

  #parseRedirection(): RedirectionAst | null {
    const token = this.#peek() as Token;
    this.#i += 1;

    if (token.kind === 'RedirectInStd') {
      // pwsh 7.6.5 refuses this itself; the lexer already recorded
      // RedirectionNotSupported. Modelled as a node so the tree still describes
      // what was typed.
      return {
        kind: 'FileRedirectionAst',
        extent: this.#extentOf(token),
        fromStream: '0',
        append: false,
        file: null,
      };
    }

    const merge = /^(\d|\*)?>&(\d)$/u.exec(token.text);
    if (merge !== null) {
      return {
        kind: 'MergingRedirectionAst',
        extent: this.#extentOf(token),
        fromStream: merge[1] ?? '1',
        toStream: merge[2] ?? '1',
      };
    }

    const file = /^(\d|\*)?(>>?)$/u.exec(token.text);
    const target = this.#parseArgument();
    if (target === null) {
      this.#diagnose(
        'MissingFileSpecification',
        'Missing file specification after redirection operator.',
        token.start,
        token.end,
        true,
      );
    }
    return {
      kind: 'FileRedirectionAst',
      extent: this.#extent(token.start, target?.extent.end ?? token.end),
      fromStream: file?.[1] ?? '1',
      append: file?.[2] === '>>',
      file: target,
    };
  }

  /**
   * A statement that is not a command: `$x = 1`, `1 + 1`, `[int]::MaxValue`.
   *
   * Parsed only as far as naming what it is. Everything here is refused at
   * execution, and the naming is the whole point.
   */
  #parseExpressionStatement(): CommandExpressionAst {
    const head = this.#peek() as Token;
    const start = head.start;
    let expression: ExpressionAst;

    if (head.kind === 'Variable' || head.kind === 'SplattedVariable') {
      this.#i += 1;
      expression = {
        kind: 'VariableExpressionAst',
        extent: this.#extentOf(head),
        variablePath: head.value,
        splatted: head.kind === 'SplattedVariable',
      };
    } else if (head.kind === 'Number') {
      this.#i += 1;
      expression = {
        kind: 'ConstantExpressionAst',
        extent: this.#extentOf(head),
        value: head.value,
      };
    } else {
      const syntax = UNIMPLEMENTED_SYNTAX.get(head.kind);
      this.#i += 1;
      expression =
        syntax === undefined
          ? this.#unsupported(head, 'ErrorExpressionAst', `the token "${head.text}"`)
          : this.#unsupported(head, syntax.node, syntax.describes);
    }

    // Whatever follows a bare expression makes it a bigger expression, and this
    // engine implements none of them. One refusal for the rest of the statement.
    let end = expression.extent.end;
    const trailing = this.#peek();
    if (
      trailing !== undefined &&
      trailing.kind !== 'Pipe' &&
      trailing.kind !== 'Semi' &&
      trailing.kind !== 'NewLine' &&
      trailing.kind !== 'AndAnd' &&
      trailing.kind !== 'OrOr'
    ) {
      // The HEAD names the construct when it already is a refusal:
      // `[int]::MaxValue` is a TypeExpressionAst that a member access follows,
      // not a BinaryExpressionAst. Letting the trailing token win would name the
      // wrong node, and a wrong name is worse than a vague one because it sends
      // the reader looking for the wrong thing.
      const head0 = expression.kind === 'UnsupportedSyntaxAst' ? expression : null;
      const syntax = UNIMPLEMENTED_SYNTAX.get(trailing.kind);
      const node: PwshAstNode = head0?.nodeType ?? syntax?.node ?? 'BinaryExpressionAst';
      const describes = head0?.describes ?? syntax?.describes ?? 'an expression operator';
      while (
        this.#i < this.#tokens.length &&
        !['Pipe', 'Semi', 'NewLine', 'AndAnd', 'OrOr'].includes(this.#peek()?.kind ?? '')
      ) {
        this.#i += 1;
      }
      end = this.#tokens[this.#i - 1]?.end ?? end;
      expression = {
        kind: 'UnsupportedSyntaxAst',
        extent: this.#extent(start, end),
        nodeType: node,
        describes,
      };
    }

    return {
      kind: 'CommandExpressionAst',
      extent: this.#extent(start, end),
      expression,
      redirections: [],
    };
  }
}

// ---------------------------------------------------------------------------
// the two entry points
// ---------------------------------------------------------------------------

/**
 * Parse for EDITING: never throws, always returns a tree.
 *
 * This is what the highlighter and completion run, on every keystroke. It is
 * `parseScript` with nothing added, which is the point — the editing parser is
 * the parser, and the execution parser is the parser plus a gate.
 */
export function parseForEditing(source: string): ParseResult {
  return new Parser(source).parse();
}

/** Kept as its own name so callers read as what they are doing. */
export const parseScript = parseForEditing;

export interface ExecutionRefusal {
  /** `BrowserShellUnimplementedSyntax`, or the pwsh error id when pwsh refuses too. */
  readonly id: string;
  readonly message: string;
  readonly start: number;
  readonly end: number;
  /** Set when the refusal names an AST node, which is the common case. */
  readonly nodeType: PwshAstNode | null;
  /**
   * "Keep typing" rather than "this cannot run".
   *
   * Carried here so the highlighter does not need its own list of which error
   * ids mean incomplete. It had one, and a list of ids maintained in two places
   * is the defect this whole item is about — it was already wrong, missing the
   * `UnexpectedToken` the parser's no-progress guard emits, so a leading `|`
   * was painted red while the comment beside the guard said it must not be.
   */
  readonly incomplete: boolean;
}

declare const executable: unique symbol;

/**
 * A tree the execution parser has cleared, and the ONLY thing an evaluator
 * should accept.
 *
 * The roadmap's note on this task is "error-tolerant parsing must never feed
 * the evaluator", and a comment is not a mechanism. `parseForEditing` returns a
 * plain `ScriptBlockAst`; this carries a private brand that nothing outside
 * this module can construct, so an evaluator typed against `ExecutableScript`
 * CANNOT be handed the editing parser's output. It is a compile error rather
 * than a code-review question.
 *
 * The brand is a phantom: it exists in the type and never at runtime, so the
 * value still passes through `structuredClone` to a Worker unchanged.
 */
export interface ExecutableScript {
  readonly [executable]: true;
  readonly ast: ScriptBlockAst;
  readonly tokens: readonly Token[];
}

export type ExecutionParse =
  | ({ readonly ok: true } & ExecutableScript)
  | { readonly ok: false; readonly refusals: readonly ExecutionRefusal[] };

/**
 * Parse for EXECUTION: strict, and explicit about what it will not run.
 *
 * Refuses in source order so the FIRST problem is the one reported, which is
 * what a person reading an error expects. Every refusal that has an AST node
 * names it — that is the rule this whole file exists to keep.
 */
export function parseForExecution(source: string): ExecutionParse {
  const parsed = parseForEditing(source);
  const refusals: ExecutionRefusal[] = [];

  // 1. Incomplete input. Fine to type, not fine to run.
  for (const diagnostic of parsed.diagnostics) {
    if (!diagnostic.incomplete) continue;
    refusals.push({
      id: diagnostic.id,
      message: diagnostic.message,
      start: diagnostic.start,
      end: diagnostic.end,
      nodeType: null,
      incomplete: true,
    });
  }

  // 2. Anything pwsh 7.6.5 refuses too, carrying pwsh's own error id.
  for (const diagnostic of parsed.diagnostics) {
    if (diagnostic.incomplete) continue;
    if (diagnostic.id === 'BrowserShellUnrecognizedCharacter' || !diagnostic.id.startsWith('BrowserShell')) {
      refusals.push({
        id: diagnostic.id,
        message: diagnostic.message,
        start: diagnostic.start,
        end: diagnostic.end,
        nodeType: null,
        incomplete: false,
      });
    }
  }

  // 3. Recognised-but-unimplemented syntax, named.
  for (const node of unsupportedNodes(parsed.ast)) {
    refusals.push({
      id: 'BrowserShellUnimplementedSyntax',
      message: unimplementedMessage(node.nodeType, node.describes, node.extent.text),
      start: node.extent.start,
      end: node.extent.end,
      nodeType: node.nodeType,
      incomplete: false,
    });
  }

  // 4. A variable reference this engine cannot resolve.
  //
  //    THERE IS NO VARIABLE TABLE. Nothing in `src/` stores one — assignment is
  //    refused as `AssignmentStatementAst`, and a grep for a variable store
  //    finds none. So `Get-Item $x` has no value to bind, and the alternative to
  //    refusing it is binding the literal four characters `$x` as a path, which
  //    is precisely the "something approximate" the engine limits forbid. It
  //    would also FAIL SILENTLY: `Remove-Item $target` with no `$target` would
  //    try to delete a file called `$target`.
  //
  //    `$true`, `$false` and `$null` are exempt because they are LITERALS, not
  //    lookups — `coercion.ts`'s `booleanLiteral` recognises them by spelling,
  //    which is how `-Switch:$false` works without a variable table at all.
  const LITERAL_VARIABLES = new Set(['true', 'false', 'null']);
  for (const node of walk(parsed.ast)) {
    if (node.kind !== 'VariableExpressionAst') continue;
    if (!node.splatted && LITERAL_VARIABLES.has(node.variablePath.toLowerCase())) continue;
    refusals.push({
      id: 'BrowserShellUnimplementedSyntax',
      message: unimplementedMessage(
        'VariableExpressionAst',
        node.splatted
          ? 'splatting, which needs a variable table this engine does not have'
          : 'a variable reference, which this engine cannot resolve because it has no variables',
        node.extent.text,
      ),
      start: node.extent.start,
      end: node.extent.end,
      nodeType: 'VariableExpressionAst',
      incomplete: false,
    });
  }

  // 5. Nodes the parser builds correctly and the engine cannot run.
  const refusedKinds = new Set<string>(EXECUTION_REFUSED_NODES);
  for (const node of walk(parsed.ast)) {
    if (!refusedKinds.has(node.kind)) continue;
    const nodeType = node.kind as PwshAstNode;
    refusals.push({
      id: 'BrowserShellUnimplementedSyntax',
      message: unimplementedMessage(
        nodeType,
        EXECUTION_REFUSAL_REASONS.get(nodeType) ?? 'this construct',
        node.extent.text,
      ),
      start: node.extent.start,
      end: node.extent.end,
      nodeType,
      incomplete: false,
    });
  }

  if (refusals.length > 0) {
    refusals.sort((a, b) => a.start - b.start);
    return { ok: false, refusals };
  }
  // The only construction of the brand in the codebase. It is a phantom type,
  // so nothing is added to the value at runtime.
  return { ok: true, ast: parsed.ast, tokens: parsed.tokens } as {
    ok: true;
  } & ExecutableScript;
}

/**
 * The command stages of a pipeline, for a caller that only needs the shape.
 *
 * This is what replaces `kernel.ts`'s `splitPipeline` + `splitTokens`, whose
 * own comment marks them for deletion. The difference is not cosmetic: those
 * split on whitespace, so `Write-Output 'a b'` reached the binder as two
 * arguments.
 */
export function pipelineStages(pipeline: PipelineAst | PipelineChainAst): readonly CommandAst[] {
  const stages: CommandAst[] = [];
  const visit = (node: PipelineAst | PipelineChainAst): void => {
    if (node.kind === 'PipelineChainAst') {
      visit(node.lhs);
      visit(node.rhs);
      return;
    }
    for (const element of node.elements) {
      if (element.kind === 'CommandAst') stages.push(element);
    }
  };
  visit(pipeline);
  return stages;
}

/**
 * The argument tokens of a command, as the binder wants them.
 *
 * One conversion, in one place. The binder's `parseParameterToken` re-derived
 * `-Name:value` from a raw string because nothing upstream had told it; now the
 * AST has already decided, and the strings handed over are DECODED — quotes
 * stripped, escapes resolved — which `splitTokens` never did.
 */
export function commandArguments(command: CommandAst): readonly string[] {
  const args: string[] = [];
  for (const element of command.elements.slice(1)) {
    if (element.kind === 'CommandParameterAst') {
      const argument = element.argument;
      if (argument === null) {
        args.push(`-${element.parameterName}`);
        continue;
      }
      args.push(`-${element.parameterName}:${expressionText(argument)}`);
      continue;
    }
    args.push(expressionText(element));
  }
  return args;
}

/** The decoded text of an argument expression. */
function expressionText(expression: ExpressionAst): string {
  switch (expression.kind) {
    case 'StringConstantExpressionAst':
    case 'ExpandableStringExpressionAst':
      return expression.value;
    case 'ConstantExpressionAst':
      return expression.value;
    case 'VariableExpressionAst':
      return `${expression.splatted ? '@' : '$'}${expression.variablePath}`;
    case 'ScriptBlockExpressionAst':
      return `{${expression.body}}`;
    default:
      return expression.extent.text;
  }
}
