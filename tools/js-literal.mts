/**
 * js-literal.mts — find the exact span of a JavaScript object or array literal.
 *
 * Extracting `const NAME={...}` by searching for a closing delimiter does not
 * work on real code. index.html closes some literals on their own line and
 * others inline (`'src':'get-source'};`), so a search for "\n};" silently
 * overshoots into a later declaration and yields a malformed slice. That is the
 * same class of failure as parsing structure with regexes, which this repo has
 * been burned by before.
 *
 * So: an actual brace matcher. It tracks the states that can contain an
 * unbalanced brace — string literals of all three kinds, template
 * substitutions, both comment forms, and regex literals — and returns the span
 * only when depth reaches zero outside all of them.
 *
 * Regex-versus-division is the one genuinely ambiguous case in JavaScript
 * lexing, and this is a heuristic, not a parser. A `/` begins a regex when it
 * follows an operator, an opening delimiter, or a keyword that can precede an
 * expression.
 *
 * Honest about the limit: a fuzz run against the TypeScript parser found inputs
 * where this returns a WRONG span rather than throwing — a regex containing an
 * unbalanced brace can end the scan early. What makes that survivable is that
 * every wrong span measured was syntactically broken, so the evaluator
 * downstream throws instead of accepting corrupted data. The pipeline fails
 * closed. Callers must treat a span as a candidate, never as proof.
 */

/** Characters after which a `/` starts a regex literal rather than a division. */
const REGEX_PRECEDERS = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%',
  '<', '>', '~', '^', '\n',
]);

/**
 * Keywords after which a `/` also begins a regex.
 *
 * Not decoration: index.html:1149 contains
 * `return /^-[a-zA-Z]*[rR]/.test(String(x))`. Without `return` in this set the
 * regex lexes as division, and it survives today only because that particular
 * pattern happens to contain no braces or quotes. A routine edit to it would
 * break extraction — verified by making one.
 */
const REGEX_PRECEDING_KEYWORDS = [
  'return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void',
  'instanceof', 'do', 'else', 'yield', 'await',
];

/**
 * Does the source immediately before `at` end with one of those keywords?
 * Checked on a word boundary, so `myreturn/2` stays division.
 */
function endsWithKeyword(source: string, at: number): boolean {
  const before = source.slice(Math.max(0, at - 24), at).trimEnd();
  return REGEX_PRECEDING_KEYWORDS.some((kw) => {
    if (!before.endsWith(kw)) return false;
    const preceding = before[before.length - kw.length - 1] ?? ' ';
    return !/[\w$]/.test(preceding);
  });
}

type Delimiter = '{' | '[';

const CLOSING: Record<Delimiter, string> = { '{': '}', '[': ']' };

export interface LiteralSpan {
  /** The literal text, including its outer delimiters. */
  text: string;
  start: number;
  end: number;
}

/**
 * Return the literal that begins at `open`, which must index the opening
 * delimiter.
 *
 * Throws on input it cannot lex, but does NOT guarantee a correct span on every
 * input — see the note on the regex heuristic above. Let the evaluator reject a
 * bad span; that is what keeps the failure mode loud.
 */
export function readLiteral(source: string, open: number): LiteralSpan {
  const first = source[open];
  if (first !== '{' && first !== '[') {
    throw new Error(`expected an object or array literal at ${open}, found ${JSON.stringify(first)}`);
  }
  const closing = CLOSING[first];

  let depth = 0;
  let i = open;
  /** Last non-whitespace character outside a comment, for the regex heuristic. */
  let previous = '\n';

  while (i < source.length) {
    const ch = source[i] ?? '';
    const next = source[i + 1] ?? '';

    // --- comments ---------------------------------------------------------
    if (ch === '/' && next === '/') {
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? source.length : nl;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      if (close === -1) throw new Error('unterminated block comment');
      i = close + 2;
      continue;
    }

    // --- strings ----------------------------------------------------------
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(source, i, ch);
      previous = ch;
      continue;
    }

    // --- regex literals ---------------------------------------------------
    if (ch === '/' && (REGEX_PRECEDERS.has(previous) || endsWithKeyword(source, i))) {
      i = skipRegex(source, i);
      previous = '/';
      continue;
    }

    // --- structure --------------------------------------------------------
    if (ch === first) depth++;
    else if (ch === closing) {
      depth--;
      if (depth === 0) {
        return { text: source.slice(open, i + 1), start: open, end: i + 1 };
      }
    }

    if (!/\s/.test(ch)) previous = ch;
    else if (ch === '\n') previous = '\n';
    i++;
  }

  throw new Error('unbalanced literal: reached end of source');
}

/** Skip a quoted string, honouring escapes and template substitutions. */
function skipString(source: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (quote === '`' && ch === '$' && source[i + 1] === '{') {
      // A template substitution can contain anything, including more strings
      // and braces, so recurse through it as a literal.
      const inner = readLiteral(source, i + 1);
      i = inner.end;
      continue;
    }
    if (ch === quote) return i + 1;
    i++;
  }
  throw new Error(`unterminated ${quote} string starting at ${start}`);
}

/** Skip a regex literal, honouring escapes and character classes. */
function skipRegex(source: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      // Skip trailing flags.
      let j = i + 1;
      while (j < source.length && /[dgimsuvy]/.test(source[j] ?? '')) j++;
      return j;
    } else if (ch === '\n') {
      throw new Error(`unterminated regex starting at ${start}`);
    }
    i++;
  }
  throw new Error(`unterminated regex starting at ${start}`);
}

/**
 * Find the declaration of `name` and return the literal that follows it.
 *
 * Whitespace-tolerant, unlike the first version, which matched the exact string
 * `const NAME=`. That worked only because index.html is written without a space
 * around the `=`; running a formatter over it would have turned every extractor
 * into "could not find". Fails closed rather than wrong, but there is no reason
 * to be that brittle about whitespace.
 *
 * The name is escaped and bounded on both sides, so looking for `D` does not
 * match `DISP` — the `\s*=` after the name is what supplies the right boundary.
 */
export function readNamedLiteral(source: string, name: string): LiteralSpan {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declaration = new RegExp(String.raw`\bconst\s+${escaped}\s*=\s*`);
  const match = declaration.exec(source);
  if (match === null) throw new Error(`could not find \`const ${name}=\` in the source`);
  return readLiteral(source, match.index + match[0].length);
}
