/**
 * highlight.ts — colouring, computed from the SAME lexer and the SAME parser
 * that decide whether a line runs.
 *
 * ── THE DEFECT THIS REPLACES ──────────────────────────────────────────────
 *
 * v1's highlighter is `highlightInto` at `index.html:1453`, and it is a regex:
 *
 *     s.match(/(\s+|"[^"]*"?|'[^']*'?|--?[A-Za-z]\w*|\||>>|>|<|=|\$[\w:]+|[^\s|><=]+)/g)
 *
 * with a five-line `tokClass` deciding colours. Measured against pwsh, it is
 * wrong in ways a reader can see on screen:
 *
 *   - `>`, `>>` and `<` are coloured as operators, and NOTHING implements
 *     redirection. That is the roadmap's own example. Worse, `<` is refused by
 *     pwsh 7.6.5 ITSELF — so the highlighter was presenting as valid a
 *     construct the reference implementation rejects.
 *   - `2>&1` is not a token to it at all: the alternation splits it into `2`
 *     (number), `>` (operator) and `&1` (uncoloured).
 *   - `if (/^-/.test(t)) return 'param'` runs BEFORE the operator test, so
 *     `-eq`, `-match` and `-like` colour as parameters.
 *   - `&&`, `||`, `;`, `(`, `)`, `{`, `}` get no class at all.
 *
 * ── THE GUARANTEE ─────────────────────────────────────────────────────────
 *
 * "The highlighter cannot colour syntax the engine rejects" is not a promise
 * kept by care here; it is kept by CONSTRUCTION. This module calls
 * `parseForExecution` and paints every refused span with the `refused` class,
 * whatever the token underneath it was. So a construct can only appear in a
 * syntax colour if the execution parser accepted it, and the two cannot drift
 * because there is nothing to keep in step — one of them computes the other.
 *
 * `tests/unit/highlight.test.mts` asserts it over the whole measured corpus.
 *
 * ── WHY IT RETURNS DATA ───────────────────────────────────────────────────
 *
 * Spans, not DOM. `src/` is headless — `tests/unit/line-editor.test.mts`
 * refuses browser globals in the core and now in this directory too — and v1's
 * highlighter built `span` elements inline, which is why nothing could test it.
 * The host turns these into elements.
 */

import { parseForExecution } from './parse.ts';
import { lex } from './lexer.ts';
import type { Token, TokenKind } from './tokens.ts';

/**
 * The colour classes.
 *
 * The first six are v1's, kept by name so the existing palette keeps working:
 * `index.html` defines `--cmd --param --str --num --op --var` and themes them
 * three ways. The last three are new because v1 had no way to say them.
 */
export type HighlightClass =
  | 'cmd'
  | 'param'
  | 'str'
  | 'num'
  | 'op'
  | 'var'
  | 'comment'
  /** A redirection operator. Distinct from `op` because it is not arithmetic. */
  | 'redirection'
  /**
   * Syntax the execution parser refuses.
   *
   * Overrides every other class, and that override is the whole guarantee.
   * A host should render it as an error — underlined, struck through, red —
   * never as valid syntax.
   */
  | 'refused';

export interface HighlightSpan {
  readonly start: number;
  /** Exclusive. */
  readonly end: number;
  readonly text: string;
  /** `null` for whitespace and anything with no opinion attached. */
  readonly className: HighlightClass | null;
  /** Set on a `refused` span: why the engine will not run it. */
  readonly refusal?: string;
}

/** Token kind to colour, before the refusal override. */
const CLASSES: Partial<Record<TokenKind, HighlightClass>> = {
  Parameter: 'param',
  Variable: 'var',
  SplattedVariable: 'var',
  Number: 'num',
  StringLiteral: 'str',
  StringExpandable: 'str',
  HereStringLiteral: 'str',
  HereStringExpandable: 'str',
  Comment: 'comment',
  Redirection: 'redirection',
  RedirectInStd: 'redirection',

  Pipe: 'op',
  AndAnd: 'op',
  OrOr: 'op',
  Semi: 'op',
  Ampersand: 'op',
  Comma: 'op',
  LParen: 'op',
  RParen: 'op',
  LCurly: 'op',
  RCurly: 'op',
  LBracket: 'op',
  RBracket: 'op',
  DollarParen: 'op',
  AtParen: 'op',
  AtCurly: 'op',
  Dot: 'op',
  DotDot: 'op',
  ColonColon: 'op',
  Colon: 'op',
  Equals: 'op',
  Minus: 'op',
  MinusMinus: 'op',
  Plus: 'op',
  PlusPlus: 'op',
  Multiply: 'op',
  Divide: 'op',
  Rem: 'op',
  Exclaim: 'op',
  QuestionMark: 'op',
  QuestionQuestion: 'op',

  Ieq: 'op', Ine: 'op', Igt: 'op', Ige: 'op', Ilt: 'op', Ile: 'op',
  Ceq: 'op', Cne: 'op', Cgt: 'op', Cge: 'op', Clt: 'op', Cle: 'op',
  Ilike: 'op', Inotlike: 'op', Imatch: 'op', Inotmatch: 'op',
  Clike: 'op', Cnotlike: 'op', Cmatch: 'op', Cnotmatch: 'op',
  Icontains: 'op', Inotcontains: 'op', Iin: 'op', Inotin: 'op',
  Ccontains: 'op', Cnotcontains: 'op', Cin: 'op', Cnotin: 'op',
  Ireplace: 'op', Creplace: 'op', Isplit: 'op', Csplit: 'op',
  Join: 'op', Is: 'op', IsNot: 'op', As: 'op', Shl: 'op', Shr: 'op', Format: 'op',
  And: 'op', Or: 'op', Xor: 'op', Not: 'op',
  Band: 'op', Bor: 'op', Bxor: 'op', Bnot: 'op',

  Unknown: 'refused',
};

/**
 * The token kinds that can be a command NAME.
 *
 * v1 decided this with a `first` boolean that flipped on the first non-space
 * token of the whole line, so the second stage of a pipeline was never coloured
 * as a command. Here it is a real question about position: the head of each
 * pipeline element.
 */
const RESETS_COMMAND_POSITION: ReadonlySet<TokenKind> = new Set<TokenKind>([
  'Pipe',
  'AndAnd',
  'OrOr',
  'Semi',
  'NewLine',
  'LCurly',
  'LParen',
  'DollarParen',
]);

const NAMEABLE: ReadonlySet<TokenKind> = new Set<TokenKind>([
  'Generic',
  'Identifier',
  'StringLiteral',
  'StringExpandable',
]);

/**
 * Colour a command line.
 *
 * Returns a span for EVERY character, whitespace included, in source order and
 * without gaps, so a host can concatenate `text` and get the input back. v1's
 * version dropped nothing either, and that property is worth keeping: a
 * highlighter that loses a character silently corrupts the echoed transcript.
 */
export function highlight(text: string): readonly HighlightSpan[] {
  const { tokens } = lex(text);
  const refusals = refusalRanges(text);

  const spans: HighlightSpan[] = [];
  let cursor = 0;
  let commandPosition = true;

  for (const token of tokens) {
    if (token.start > cursor) {
      spans.push({
        start: cursor,
        end: token.start,
        text: text.slice(cursor, token.start),
        className: null,
      });
    }

    const className = classify(token, commandPosition);
    const refusal = refusalCovering(refusals, token);
    spans.push(
      refusal === null
        ? { start: token.start, end: token.end, text: token.text, className }
        : {
            start: token.start,
            end: token.end,
            text: token.text,
            className: 'refused',
            refusal,
          },
    );

    cursor = token.end;
    if (RESETS_COMMAND_POSITION.has(token.kind)) commandPosition = true;
    else if (token.kind !== 'Comment' && token.kind !== 'LineContinuation') commandPosition = false;
  }

  if (cursor < text.length) {
    spans.push({
      start: cursor,
      end: text.length,
      text: text.slice(cursor),
      className: null,
    });
  }
  return spans;
}

function classify(token: Token, commandPosition: boolean): HighlightClass | null {
  if (commandPosition && NAMEABLE.has(token.kind)) return 'cmd';
  return CLASSES[token.kind] ?? null;
}

interface Range {
  readonly start: number;
  readonly end: number;
  readonly message: string;
}

/**
 * Where the execution parser refuses, as ranges.
 *
 * An INCOMPLETE input is deliberately not a refusal for colouring purposes: a
 * half-typed string is the normal state of the line editor and painting it red
 * on every keystroke would make the prompt flash constantly. Everything else
 * the execution parser refuses is painted, which is the guarantee.
 *
 * "Incomplete" is read off the refusal rather than decided here. This function
 * used to carry its OWN list of the error ids that mean "keep typing", and a
 * list maintained in two places is the defect this whole item exists to remove
 * — that copy was already wrong, missing the `UnexpectedToken` the parser's
 * no-progress guard emits, so a leading `|` was painted red while the comment
 * beside the guard said it must not be.
 */
function refusalRanges(text: string): readonly Range[] {
  const parsed = parseForExecution(text);
  if (parsed.ok) return [];
  return parsed.refusals
    .filter((refusal) => !refusal.incomplete)
    .map((refusal) => ({ start: refusal.start, end: refusal.end, message: refusal.message }));
}

function refusalCovering(ranges: readonly Range[], token: Token): string | null {
  for (const range of ranges) {
    if (token.start >= range.start && token.end <= range.end) return range.message;
    // A zero-width or single-token refusal that starts inside the token.
    if (range.start >= token.start && range.start < token.end) return range.message;
  }
  return null;
}
