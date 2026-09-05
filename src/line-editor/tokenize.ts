/**
 * tokenize.ts — the line editor's VIEW of the one lexer. Not a second lexer.
 *
 * ── WHAT THIS FILE USED TO BE ─────────────────────────────────────────────
 *
 * It used to be an independent tokenizer, and it was one of nine. Its own
 * header said it was "enough PowerShell lexing to know WHERE the caret is" and
 * "not a parser and does not try to be" — a reasonable position, except that
 * knowing where the caret is requires the same quoting rules as running the
 * line, so the two implementations had to agree and nothing made them. They did
 * not agree, and `src/language/lexer.ts` measured which one was right:
 *
 *   `--Path`         this file said PARAMETER; pwsh says it is an ARGUMENT.
 *                    `binder.ts` already said argument, so the highlighter and
 *                    the binder disagreed about the same characters.
 *   `-Path a,b`      this file said ONE token, in a comment that explained why.
 *                    pwsh lexes THREE: `a`, `,`, `b`.
 *   `$_.Length`      this file said one word. pwsh says `Variable Dot Identifier`
 *                    — which is the difference between knowing that `.Length` is
 *                    a member access and thinking it is a filename.
 *   `f a>b`          this file broke on `>`. pwsh does not: `>` redirects only
 *                    at the START of a token.
 *
 * So the lexing is gone and what remains is a PROJECTION: the real token stream,
 * mapped onto the four-way classification the completion engine consumes. The
 * mapping is total and mechanical, which is the point — there is no rule here
 * that could drift, because there is no rule here at all.
 *
 * ── WHY THE PROJECTION STILL EXISTS ───────────────────────────────────────
 *
 * Completion asks a narrower question than execution: "is this token something
 * that starts a new command, something that takes a value, or a value". Four
 * categories answer it, and 46 token kinds would make every consumer re-derive
 * the same four. Keeping the projection here means `completion.ts` is unchanged
 * and there is exactly one place that knows the correspondence.
 */

import { lex } from '../language/lexer.ts';
import type { Token as LanguageToken, TokenKind as LanguageTokenKind } from '../language/tokens.ts';

export type TokenKind =
  /** A bare or quoted word: a command name, a value, a path. */
  | 'word'
  /** `-Name`. Not `-1`, which is a value, and not `--Path`, which is too. */
  | 'parameter'
  /** An operator: `-eq`, `-match`, `.`, `,`, `=`. Never a new command. */
  | 'operator'
  /** `|`, `;`, `&&`, `||`, `(`, `)`, `{`, `}`, newline — a new command starts. */
  | 'separator'
  /** `>`, `>>`, `2>&1`, `<` — whatever follows is a path, not an argument. */
  | 'redirection';

export interface Token {
  readonly kind: TokenKind;
  /** Raw text, quotes included. */
  readonly text: string;
  /** Quotes stripped and escapes resolved — what the value actually is. */
  readonly value: string;
  readonly start: number;
  /** Exclusive. */
  readonly end: number;
  readonly quote: '"' | "'" | null;
  /** The closing quote is missing, i.e. the user is still typing inside it. */
  readonly unterminated: boolean;
}

/**
 * The projection, as data.
 *
 * Anything absent is a `word`, which is the right default: the four categories
 * exist to spot the tokens that CHANGE completion's state, and everything else
 * is a value.
 *
 * `Comma` is an `operator` and deliberately not a `separator`. The old file
 * refused to break on it at all, with the comment "breaking on it would put the
 * caret in command position after every comma" — the concern was right and the
 * remedy was wrong. Lexing it correctly and classifying it as an operator keeps
 * the caret out of command position, because only `separator` resets the
 * segment.
 */
const PROJECTION: Partial<Record<LanguageTokenKind, TokenKind>> = {
  Parameter: 'parameter',

  Pipe: 'separator',
  AndAnd: 'separator',
  OrOr: 'separator',
  Semi: 'separator',
  Ampersand: 'separator',
  NewLine: 'separator',
  LParen: 'separator',
  RParen: 'separator',
  LCurly: 'separator',
  RCurly: 'separator',
  DollarParen: 'separator',
  AtParen: 'separator',
  AtCurly: 'separator',
  LBracket: 'separator',
  RBracket: 'separator',

  Redirection: 'redirection',
  RedirectInStd: 'redirection',

  Comma: 'operator',
  Dot: 'operator',
  DotDot: 'operator',
  ColonColon: 'operator',
  Colon: 'operator',
  Equals: 'operator',
  Minus: 'operator',
  MinusMinus: 'operator',
  Plus: 'operator',
  PlusPlus: 'operator',
  Multiply: 'operator',
  Divide: 'operator',
  Rem: 'operator',
  Exclaim: 'operator',
  QuestionMark: 'operator',
  QuestionQuestion: 'operator',

  Ieq: 'operator', Ine: 'operator', Igt: 'operator', Ige: 'operator',
  Ilt: 'operator', Ile: 'operator', Ceq: 'operator', Cne: 'operator',
  Cgt: 'operator', Cge: 'operator', Clt: 'operator', Cle: 'operator',
  Ilike: 'operator', Inotlike: 'operator', Imatch: 'operator', Inotmatch: 'operator',
  Clike: 'operator', Cnotlike: 'operator', Cmatch: 'operator', Cnotmatch: 'operator',
  Icontains: 'operator', Inotcontains: 'operator', Iin: 'operator', Inotin: 'operator',
  Ccontains: 'operator', Cnotcontains: 'operator', Cin: 'operator', Cnotin: 'operator',
  Ireplace: 'operator', Creplace: 'operator', Isplit: 'operator', Csplit: 'operator',
  Join: 'operator', Is: 'operator', IsNot: 'operator', As: 'operator',
  Shl: 'operator', Shr: 'operator', Format: 'operator',
  And: 'operator', Or: 'operator', Xor: 'operator', Not: 'operator',
  Band: 'operator', Bor: 'operator', Bxor: 'operator', Bnot: 'operator',
};

/**
 * Trivia the caret can sit in but completion has nothing to say about.
 *
 * Dropped rather than projected, because every one of the four categories would
 * be a lie: a comment is not a word, and calling it a separator would put the
 * caret in command position after `#`.
 */
const TRIVIA: ReadonlySet<LanguageTokenKind> = new Set<LanguageTokenKind>([
  'Comment',
  'LineContinuation',
]);

/** A here-string's opener projects to the quote character it is built from. */
function legacyQuote(token: LanguageToken): '"' | "'" | null {
  switch (token.quote) {
    case '"':
    case '@"':
      return '"';
    case "'":
    case "@'":
      return "'";
    default:
      return null;
  }
}

/**
 * Lex a command line for the line editor. Never throws.
 *
 * A projection of `lex`, so a string cannot be tokenised by a second path.
 * `tests/unit/lexer-single.test.mts` asserts that this function and the
 * highlighter agree with the execution parser token for token.
 */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const token of lex(text).tokens) {
    if (TRIVIA.has(token.kind)) continue;
    tokens.push({
      kind: PROJECTION[token.kind] ?? 'word',
      text: token.text,
      value: token.value,
      start: token.start,
      end: token.end,
      quote: legacyQuote(token),
      unterminated: token.unterminated,
    });
  }
  return tokens;
}

/** Quote `value` for insertion, the way PowerShell would need it quoted. */
export function quoteIfNeeded(value: string, preferred: '"' | "'" | null = null): string {
  const needsQuote = preferred !== null || /[\s'"`$;,|&(){}<>]/.test(value) || value === '';
  if (!needsQuote) return value;
  if (preferred === '"') return `"${value.replace(/(["`$])/g, '`$1')}"`;
  // Single quotes are the safer default: nothing inside them expands.
  return `'${value.replace(/'/g, "''")}'`;
}
