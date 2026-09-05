/**
 * tokenize.ts — enough PowerShell lexing to know WHERE the caret is.
 *
 * v1 had four independent tokenizers (completion, argv split, pipe split, head
 * extraction) and none of them agreed. The one that drove completion was a
 * single call to `lastIndexOf(' ')`, so `Get-Content 'my file|` believed the
 * word under the caret was `file` and quoting did not exist. The result was that
 * completion could only ever tell "start of line or after a pipe" from
 * "everything else" — two states, where the interesting question has four.
 *
 * This is not a parser and does not try to be. It answers exactly one question:
 * given a caret offset, which token is under it, what came before it in the same
 * command, and is the caret inside a quoted string. Anything a parser would need
 * beyond that (expressions, script blocks, expandable-string interiors) is
 * deliberately absent.
 */

export type TokenKind =
  /** A bare or quoted word: a command name, a value, a path. */
  | 'word'
  /** `-Name` or `--Name`. Not `-1`, which is a negative number. */
  | 'parameter'
  /** A PowerShell operator spelled like a parameter: `-eq`, `-match`. */
  | 'operator'
  /** `|`, `;`, `&&`, `||`, `(`, `)`, `{`, `}`, newline — a new command starts. */
  | 'separator'
  /** `>`, `>>`, `2>`, `<` — whatever follows is a path, not an argument. */
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
 * Operators that look like parameters. Without this list `$_.Length -gt 10`
 * would put the caret in "parameter position" of `Where-Object` and offer
 * `-Property`, which is worse than offering nothing.
 */
const OPERATORS: ReadonlySet<string> = new Set(
  [
    'eq', 'ne', 'gt', 'ge', 'lt', 'le',
    'ceq', 'cne', 'cgt', 'cge', 'clt', 'cle',
    'ieq', 'ine', 'igt', 'ige', 'ilt', 'ile',
    'like', 'notlike', 'match', 'notmatch',
    'clike', 'cnotlike', 'cmatch', 'cnotmatch',
    'ilike', 'inotlike', 'imatch', 'inotmatch',
    'contains', 'notcontains', 'in', 'notin',
    'ccontains', 'cnotcontains', 'cin', 'cnotin',
    'replace', 'creplace', 'ireplace', 'split', 'csplit', 'isplit', 'join',
    'and', 'or', 'xor', 'not', 'is', 'isnot', 'as',
    'band', 'bor', 'bxor', 'bnot', 'shl', 'shr', 'f',
  ].map((o) => o.toLowerCase()),
);

/**
 * v1's `FLAGRE`, kept verbatim in spirit: one or two dashes then an ASCII
 * letter. The comment there was `只有 -Name 這種才算參數;-1 是負數值,不是參數`
 * — only `-Name` is a parameter, `-1` is a negative number — and that is still
 * the rule.
 */
const PARAMETER_RE = /^-{1,2}[A-Za-z_]/;

/**
 * Characters that end a bare word.
 *
 * `,` is absent on purpose: it is PowerShell's array operator, so `-Path a,b` is
 * one argument to one parameter. Breaking on it would put the caret in "command
 * position" after every comma.
 */
const BREAKS = new Set([' ', '\t', '\n', '\r', '|', ';', '&', '(', ')', '{', '}', '<', '>']);

/** Longest match wins, so `&&` is tried before `&` and `||` before `|`. */
const SEPARATORS: readonly string[] = ['&&', '||', '|', ';', '&', '(', ')', '{', '}', '\n'];

function isRedirectionAt(text: string, i: number): number {
  // `2>&1`, `2>>`, `>>`, `>`, `<`. Returns the length matched, or 0.
  const m = /^(?:\d?>>?(?:&\d)?|<)/.exec(text.slice(i, i + 4));
  return m === null ? 0 : m[0].length;
}

function classifyWord(raw: string, quote: '"' | "'" | null): TokenKind {
  if (quote !== null) return 'word';
  if (!PARAMETER_RE.test(raw)) return 'word';
  const bare = raw.replace(/^-+/, '').toLowerCase();
  return OPERATORS.has(bare) ? 'operator' : 'parameter';
}

/** Lex a command line. Never throws; unterminated quotes produce a token. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const len = text.length;
  let i = 0;

  while (i < len) {
    const ch = text[i] ?? '';

    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i += 1;
      continue;
    }

    const redirection = isRedirectionAt(text, i);
    if (redirection > 0) {
      const raw = text.slice(i, i + redirection);
      tokens.push({
        kind: 'redirection',
        text: raw,
        value: raw,
        start: i,
        end: i + redirection,
        quote: null,
        unterminated: false,
      });
      i += redirection;
      continue;
    }

    const separator = SEPARATORS.find((s) => text.startsWith(s, i));
    if (separator !== undefined) {
      tokens.push({
        kind: 'separator',
        text: separator,
        value: separator,
        start: i,
        end: i + separator.length,
        quote: null,
        unterminated: false,
      });
      i += separator.length;
      continue;
    }

    tokens.push(readWord(text, i));
    const last = tokens[tokens.length - 1];
    i = last === undefined ? len : Math.max(last.end, i + 1);
  }

  return tokens;
}

function readWord(text: string, start: number): Token {
  const len = text.length;
  const opener = text[start];
  if (opener === '"' || opener === "'") {
    const closed = readQuoted(text, start, opener);
    return {
      kind: 'word',
      text: text.slice(start, closed.end),
      value: closed.value,
      start,
      end: closed.end,
      quote: opener,
      unterminated: closed.unterminated,
    };
  }

  let i = start;
  let value = '';
  while (i < len) {
    const ch = text[i] ?? '';
    if (BREAKS.has(ch)) break;
    if (isRedirectionAt(text, i) > 0) break;
    if (ch === '`' && i + 1 < len) {
      // Backtick is PowerShell's escape character outside single quotes.
      value += text[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      // An embedded quote, as in `--path="a b"`. Absorb it into this token.
      const inner = readQuoted(text, i, ch);
      value += inner.value;
      i = inner.end;
      continue;
    }
    value += ch;
    i += 1;
  }

  const raw = text.slice(start, i);
  return {
    kind: classifyWord(raw, null),
    text: raw,
    value,
    start,
    end: i,
    quote: null,
    unterminated: false,
  };
}

function readQuoted(
  text: string,
  start: number,
  quote: '"' | "'",
): { value: string; end: number; unterminated: boolean } {
  const len = text.length;
  let i = start + 1;
  let value = '';
  while (i < len) {
    const ch = text[i] ?? '';
    if (ch === quote) {
      // Doubling escapes the quote in both PowerShell string forms.
      if (text[i + 1] === quote) {
        value += quote;
        i += 2;
        continue;
      }
      return { value, end: i + 1, unterminated: false };
    }
    if (quote === '"' && ch === '`' && i + 1 < len) {
      value += text[i + 1] ?? '';
      i += 2;
      continue;
    }
    value += ch;
    i += 1;
  }
  return { value, end: len, unterminated: true };
}

/** Quote `value` for insertion, the way PowerShell would need it quoted. */
export function quoteIfNeeded(value: string, preferred: '"' | "'" | null = null): string {
  const needsQuote = preferred !== null || /[\s'"`$;,|&(){}<>]/.test(value) || value === '';
  if (!needsQuote) return value;
  if (preferred === '"') return `"${value.replace(/(["`$])/g, '`$1')}"`;
  // Single quotes are the safer default: nothing inside them expands.
  return `'${value.replace(/'/g, "''")}'`;
}
