/**
 * tokens.ts — the token vocabulary, named the way the reference implementation
 * names it.
 *
 * WHY THE NAMES ARE NOT OURS. This repository has now found the same defect six
 * times: one conversion implemented more than once, drifting silently. The
 * previous five were value-to-string (three copies), cell width (two models
 * disagreeing on 914 code points), three date engines (one wrong on 20 of 47
 * patterns), and two command-resolution orders that disagreed about `sl`. The
 * sixth is lexing, and it was the largest: five tokenizers in the v1 terminal
 * (`splitPipe`, the `execOne` regex, `parseArgsOf`, `highlightInto`'s regex and
 * the completion splitter), four more in the rewrite.
 *
 * A private vocabulary is how such copies drift without anyone noticing, because
 * there is nothing to compare them against. So the kinds below are the names
 * `[System.Management.Automation.Language.TokenKind]` uses, spelled identically,
 * and `tools/probe-lexer.ps1` dumps the reference implementation's own tokens in
 * those names. A disagreement is then a failing diff rather than a judgement
 * call, which is the only property that keeps a second implementation honest.
 *
 * Measured on pwsh 7.6.5 (Microsoft Windows 10.0.26340): the real enum has 157
 * members. This declares the subset BrowserShell lexes. That is a deliberate
 * subset, not an approximation — `unimplemented.ts` refuses what is missing by
 * name rather than letting it through as something else.
 */

/**
 * A token kind, spelled as `TokenKind` spells it.
 *
 * Grouped by what the lexer does to produce one, not by what a parser later
 * does with it.
 */
export type TokenKind =
  // -- words -----------------------------------------------------------------
  /**
   * A bare argument. `Get-Item a.b`, `Get-Item 1+1` and `Get-Item --Path` are
   * each ONE Generic token, because the argument lexing mode does not break on
   * `.`, `+` or `-`. Measured; see `LexerMode`.
   */
  | 'Generic'
  /** A bare word in expression mode: `a` in `a ; b`. */
  | 'Identifier'
  /**
   * `-Name`, or `-Name:` INCLUDING the colon. Measured: `-Name:value` lexes as
   * `Parameter("-Name:")` then `Identifier("value")` — two tokens, not one.
   */
  | 'Parameter'
  | 'Variable'
  /** `@name` in argument position. `@name` elsewhere is a SplattingNotPermitted error. */
  | 'SplattedVariable'
  | 'Number'
  // -- strings ---------------------------------------------------------------
  /** `'...'`. Nothing expands; `''` is a literal quote; backtick is literal. */
  | 'StringLiteral'
  /** `"..."`. `""` is a literal quote; backtick escapes; `$` would expand. */
  | 'StringExpandable'
  | 'HereStringLiteral'
  | 'HereStringExpandable'
  // -- separators and grouping ----------------------------------------------
  | 'Pipe'
  | 'AndAnd'
  | 'OrOr'
  | 'Semi'
  | 'Ampersand'
  | 'Comma'
  | 'NewLine'
  | 'LParen'
  | 'RParen'
  | 'LCurly'
  | 'RCurly'
  | 'LBracket'
  | 'RBracket'
  | 'DollarParen'
  | 'AtParen'
  | 'AtCurly'
  // -- redirection -----------------------------------------------------------
  /** `>`, `>>`, `N>`, `N>>`, `*>`, `*>>`, `N>&1`, `*>&1`. */
  | 'Redirection'
  /** `<`. Recognised, and NOT supported — by pwsh itself. See `lexer.ts`. */
  | 'RedirectInStd'
  // -- trivia ----------------------------------------------------------------
  | 'Comment'
  /** A backtick immediately before a newline. */
  | 'LineContinuation'
  // -- operators -------------------------------------------------------------
  | 'Dot'
  | 'DotDot'
  | 'ColonColon'
  | 'Colon'
  | 'Equals'
  | 'Minus'
  | 'MinusMinus'
  | 'Plus'
  | 'PlusPlus'
  | 'Multiply'
  | 'Divide'
  | 'Rem'
  | 'Exclaim'
  | 'QuestionMark'
  | 'QuestionQuestion'
  | ComparisonOperatorKind
  | LogicalOperatorKind
  // -- ends ------------------------------------------------------------------
  | 'EndOfInput'
  /** Recognised as nothing. Always accompanied by a diagnostic. */
  | 'Unknown';

/**
 * The `-eq` family, in the reference implementation's spelling.
 *
 * Measured, and the spelling is not the obvious guess: `-eq` is `Ieq`, not
 * `Eq` — the case-INSENSITIVE form is the unprefixed one, and `-ieq` produces
 * the same kind. `-join` is `Join` with no case prefix at all because it has no
 * case-sensitive form, and `-f` is `Format`.
 */
export type ComparisonOperatorKind =
  | 'Ieq' | 'Ine' | 'Igt' | 'Ige' | 'Ilt' | 'Ile'
  | 'Ceq' | 'Cne' | 'Cgt' | 'Cge' | 'Clt' | 'Cle'
  | 'Ilike' | 'Inotlike' | 'Imatch' | 'Inotmatch'
  | 'Clike' | 'Cnotlike' | 'Cmatch' | 'Cnotmatch'
  | 'Icontains' | 'Inotcontains' | 'Iin' | 'Inotin'
  | 'Ccontains' | 'Cnotcontains' | 'Cin' | 'Cnotin'
  | 'Ireplace' | 'Creplace' | 'Isplit' | 'Csplit' | 'Join'
  | 'Is' | 'IsNot' | 'As' | 'Shl' | 'Shr' | 'Format';

export type LogicalOperatorKind = 'And' | 'Or' | 'Xor' | 'Not' | 'Band' | 'Bor' | 'Bxor' | 'Bnot';

/**
 * `-eq` and friends, written form to `TokenKind`.
 *
 * Every entry was read out of pwsh 7.6.5 by parsing `1 <op> 2` and reporting
 * the operator token's `Kind` (tools/probe-lexer.ps1's sibling measurement).
 * Notably `-shl`/`-shr` carry `BinaryPrecedenceComparison`, not a bitwise
 * precedence, which is a fact about pwsh rather than about this table.
 */
export const DASH_OPERATORS: ReadonlyMap<string, TokenKind> = new Map<string, TokenKind>([
  ['eq', 'Ieq'], ['ne', 'Ine'], ['gt', 'Igt'], ['ge', 'Ige'], ['lt', 'Ilt'], ['le', 'Ile'],
  ['ieq', 'Ieq'], ['ine', 'Ine'], ['igt', 'Igt'], ['ige', 'Ige'], ['ilt', 'Ilt'], ['ile', 'Ile'],
  ['ceq', 'Ceq'], ['cne', 'Cne'], ['cgt', 'Cgt'], ['cge', 'Cge'], ['clt', 'Clt'], ['cle', 'Cle'],
  ['like', 'Ilike'], ['notlike', 'Inotlike'], ['match', 'Imatch'], ['notmatch', 'Inotmatch'],
  ['ilike', 'Ilike'], ['inotlike', 'Inotlike'], ['imatch', 'Imatch'], ['inotmatch', 'Inotmatch'],
  ['clike', 'Clike'], ['cnotlike', 'Cnotlike'], ['cmatch', 'Cmatch'], ['cnotmatch', 'Cnotmatch'],
  ['contains', 'Icontains'], ['notcontains', 'Inotcontains'], ['in', 'Iin'], ['notin', 'Inotin'],
  ['icontains', 'Icontains'], ['inotcontains', 'Inotcontains'], ['iin', 'Iin'], ['inotin', 'Inotin'],
  ['ccontains', 'Ccontains'], ['cnotcontains', 'Cnotcontains'], ['cin', 'Cin'], ['cnotin', 'Cnotin'],
  ['replace', 'Ireplace'], ['ireplace', 'Ireplace'], ['creplace', 'Creplace'],
  ['split', 'Isplit'], ['isplit', 'Isplit'], ['csplit', 'Csplit'], ['join', 'Join'],
  ['and', 'And'], ['or', 'Or'], ['xor', 'Xor'], ['not', 'Not'],
  ['band', 'Band'], ['bor', 'Bor'], ['bxor', 'Bxor'], ['bnot', 'Bnot'],
  ['is', 'Is'], ['isnot', 'IsNot'], ['as', 'As'],
  ['shl', 'Shl'], ['shr', 'Shr'], ['f', 'Format'],
]);

/** The string-carrying kinds, whose `value` is decoded rather than raw. */
export const STRING_KINDS: ReadonlySet<TokenKind> = new Set<TokenKind>([
  'StringLiteral',
  'StringExpandable',
  'HereStringLiteral',
  'HereStringExpandable',
]);

/**
 * Which quote character opened this token, when one did.
 *
 * Kept as its own field rather than derived from `kind`, because completion
 * needs it to re-quote a candidate and a here-string's opener is two characters.
 */
export type QuoteStyle = '"' | "'" | '@"' | "@'" | null;

export interface Token {
  readonly kind: TokenKind;
  /** Exactly the source text this token spans, quotes and escapes included. */
  readonly text: string;
  /**
   * What the token MEANS: quotes stripped, escapes resolved, `''` collapsed.
   *
   * For a Generic token this is not the same as `text` — measured,
   * `` a`tb `` has the value `a<TAB>b` and `a"b"c` has the value `abc`. Four
   * tokenizers disagreed about precisely this field.
   */
  readonly value: string;
  readonly start: number;
  /** Exclusive. */
  readonly end: number;
  readonly quote: QuoteStyle;
  /** The closing quote or here-string footer is missing. */
  readonly unterminated: boolean;
}

/**
 * A lexing or parsing complaint.
 *
 * `id` is the reference implementation's own `ParseError.ErrorId` wherever one
 * was measured for the same input, so an error here can be looked up against
 * pwsh's behaviour instead of only against ours. Ids this project invents are
 * prefixed `BrowserShell` so the two can never be confused.
 */
export interface Diagnostic {
  readonly id: string;
  readonly message: string;
  readonly start: number;
  readonly end: number;
  /**
   * `incomplete` means "keep typing" — an unterminated string, an unclosed
   * brace, a trailing pipe. The editing parser tolerates these; the execution
   * parser refuses them. Nothing else distinguishes the two parsers' handling
   * of a diagnostic, which is why this bit exists rather than a severity scale.
   */
  readonly incomplete: boolean;
}

/**
 * Where the lexer is, which changes what the SAME characters mean.
 *
 * This is the fact that made four hand-written tokenizers wrong, and none of
 * them modelled it. Measured on pwsh 7.6.5:
 *
 *   `1+1`              -> Number Plus Number      (three tokens)
 *   `Get-Item 1+1`     -> Generic Generic         (two — `1+1` is ONE argument)
 *   `--Path`           -> MinusMinus Identifier   (plus two errors)
 *   `Get-Item --Path`  -> Generic Generic         (`--Path` is an argument)
 *   `@x`               -> SplattedVariable        (plus SplattingNotPermitted)
 *   `Get-Item @x`      -> SplattedVariable        (legal splat)
 *
 * A single-mode lexer must choose one of each pair and is wrong about the other.
 */
export type LexerMode =
  /** Operators, numbers and variables have their meanings. */
  | 'expression'
  /** The head of a command. Almost everything is a bare word. */
  | 'command'
  /** After a command head. Bare words swallow `+`, `.`, `-`, `*`, `=`, `/`. */
  | 'argument';

export interface LexResult {
  readonly tokens: readonly Token[];
  readonly diagnostics: readonly Diagnostic[];
}
