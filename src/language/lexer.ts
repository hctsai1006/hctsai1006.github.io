/**
 * lexer.ts — THE lexer. There is exactly one, and this is it.
 *
 * ── WHY ONE ───────────────────────────────────────────────────────────────
 *
 * There were nine. Five in the v1 terminal (`splitPipe`, the `execOne` regex,
 * `parseArgsOf`, `highlightInto`'s regex and the `currentToken` completion
 * splitter, each duplicated into `legacy/terminal-v1.html`) and four in the
 * rewrite (`src/line-editor/tokenize.ts`, `kernel.ts`'s `splitPipeline` +
 * `splitTokens`, and `binder.ts`'s `parseParameterToken`). They disagreed:
 *
 *   - `--Path` is a PARAMETER to `tokenize.ts` and to v1's `FLAGRE`, and an
 *     ARGUMENT to `binder.ts`. pwsh says argument. Two of the three were wrong,
 *     and the highlighter coloured it as the wrong one of them.
 *   - `-Path a,b` is ONE argument to `tokenize.ts`, whose comment says so
 *     explicitly. pwsh lexes THREE tokens: `a`, `,`, `b`.
 *   - `2>&1` is a token to `tokenize.ts` alone. `highlightInto` splits it into
 *     `2` (number), `>` (operator) and `&1` (uncoloured).
 *   - `splitTokens` was `stage.split(/\s+/u)`, so every quoted argument
 *     containing a space became two arguments by the time it reached the
 *     binder. That pair was the last to go: the kernel parses now.
 *
 * ── WHY IT IS MEASURED, NOT REASONED ──────────────────────────────────────
 *
 * PowerShell's lexing is genuinely strange, and every rule below was read out
 * of pwsh 7.6.5 rather than remembered. `tools/capture-lexer-fixtures.ps1` runs
 * `[System.Management.Automation.Language.Parser]::ParseInput` — the very lexer
 * pwsh runs — over `tests/unit/fixtures/lexer-corpus.json` and records its
 * tokens. `tests/unit/lexer-differential.test.mts` replays that fixture against
 * this file. The surprises that survived contact with the measurement:
 *
 *  1. MODE CHANGES THE MEANING OF THE SAME CHARACTERS. `1+1` at the start of a
 *     statement is three tokens; `Get-Item 1+1` is two, because `1+1` is one
 *     ARGUMENT. `--Path` alone is `MinusMinus Identifier` with two errors;
 *     `Get-Item --Path` is one Generic. None of the nine tokenizers had modes.
 *
 *  2. ONLY EIGHT CHARACTERS BREAK A BARE ARGUMENT: `& ( ) , ; { | }`. Probed
 *     across every ASCII punctuation character. `>` and `<` do NOT break one —
 *     `f a>b` is a single Generic token — they are redirections only at the
 *     START of a token. `tokenize.ts` breaks on `<` and `>` anywhere.
 *
 *  3. BACKTICK ESCAPES APPLY IN BARE WORDS TOO, with the same table as a
 *     double-quoted string: `` a`tb `` has the value `a<TAB>b`. And an
 *     UNRECOGNISED escape drops the backtick and keeps the character —
 *     `` `q `` is `q`, not `` `q ``. Guessing either way looks plausible.
 *
 *  4. `-5` IS MODE-DEPENDENT. At a statement start it is `Number(-5)`. As an
 *     argument — `Get-Random -Minimum -5` — it is `Generic("-5")`. Meanwhile a
 *     bare `10` in argument position IS a Number. So argument-mode words become
 *     numbers only when they do not start with a dash.
 *
 *  5. `--%` STOPS PARSING AT `|`, `&&`, `||` AND NEWLINE — BUT NOT AT `;` OR
 *     `>`. `cmd --% a ; b` puts `a ; b` in ONE verbatim token. This is the sort
 *     of rule nobody recalls correctly.
 *
 *  6. `<` IS NOT SUPPORTED BY PWSH ITSELF. `Get-Content < in.txt` lexes as
 *     `RedirectInStd` and raises `RedirectionNotSupported` in real 7.6.5. The
 *     v1 highlighter coloured `<` as an operator, and the roadmap noted nothing
 *     implements it — the measurement says nothing SHOULD, because the
 *     reference implementation does not either. Likewise `1>&2` and `1>&1`:
 *     lexed, then refused. Merging is into stream 1 only.
 *
 *  7. `7>` IS NOT A REDIRECTION. Streams are 1-6 and `*`. `x 7> f` lexes `7>`
 *     as an ordinary Generic word.
 *
 *  8. A QUOTE OPENS A STRING ONLY AT THE START OF A TOKEN. `f "a"b` is
 *     `StringExpandable("a")` then `Identifier("b")` — two tokens. But
 *     `f a"b"c` is ONE Generic whose value is `abc`. Absorbing mid-word and
 *     splitting at the start is not symmetric, and no hand-written tokenizer
 *     here had it right.
 *
 * ── ERROR TOLERANCE IS NOT OPTIONAL ───────────────────────────────────────
 *
 * This lexer NEVER throws and always returns tokens. A half-typed line is the
 * normal state of the editing parser's input — it runs on every keystroke — so
 * an unterminated string is a `Diagnostic` with `incomplete: true` beside a
 * complete token list, exactly as pwsh's own parser does it. The execution
 * parser is what refuses; see `parse.ts`. Diagnostics carry pwsh's own
 * `ErrorId` wherever one was measured for the same input.
 */

import {
  DASH_OPERATORS,
  type Diagnostic,
  type LexerMode,
  type LexResult,
  type QuoteStyle,
  type Token,
  type TokenKind,
} from './tokens.ts';

// ---------------------------------------------------------------------------
// character classes, all measured
// ---------------------------------------------------------------------------

/**
 * The ONLY characters that end a bare argument from inside it.
 *
 * Probed over every ASCII punctuation character with `f aXb`: exactly these
 * eight split the word. Everything else — `! " # $ % ' * + - . / : < = > ? @
 * [ \ ] ^ _ backtick ~` — is absorbed.
 */
const ARGUMENT_BREAKS: ReadonlySet<string> = new Set(['&', '(', ')', ',', ';', '{', '|', '}']);

/** Whitespace that separates tokens without producing one. Newline is a token. */
const SPACE: ReadonlySet<string> = new Set([' ', '\t', '\r', '\f', '\v', ' ']);

/**
 * Backtick escapes, as pwsh decodes them.
 *
 * Read out of the reference implementation one escape at a time, in both quote
 * styles, comparing code points rather than characters so console encoding
 * could not corrupt the answer. Anything ABSENT from this table drops the
 * backtick and keeps the character verbatim — that is a measured rule, not a
 * fallback: `` "pre`qpost" `` has the value `preqpost`.
 *
 * `\u0000` is spelled as an escape rather than written literally because a raw
 * NUL in a source file is a repository-wide error (`npm run check:bytes`), and
 * three have slipped in already.
 */
const ESCAPES: ReadonlyMap<string, string> = new Map([
  ['0', '\u0000'],
  ['a', '\u0007'],
  ['b', '\b'],
  ['e', '\u001B'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
  ['v', '\u000B'],
  ['`', '`'],
]);

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';

const isIdentifierStart = (c: string | undefined): boolean =>
  c !== undefined && ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_');

const isIdentifierPart = (c: string | undefined): boolean => isIdentifierStart(c) || isDigit(c);

/** `^[A-Za-z_][A-Za-z0-9_]*$` — what makes a bare word `Identifier` not `Generic`. */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * A bare word that is entirely a number.
 *
 * Covers decimal, hex, binary, exponent, the `kb`/`mb`/`gb`/`tb`/`pb`
 * multipliers and the `l`/`d`/`u`/`n`/`s`/`ms` type suffixes pwsh accepts. Used
 * only to decide Number-vs-Generic; the numeric VALUE is not computed here,
 * because nothing downstream in this engine consumes it yet and a half-built
 * numeric tower is exactly the kind of second implementation this file exists
 * to prevent.
 */
const NUMBER_RE =
  /^[+-]?(?:0[xX][0-9a-fA-F]+|0[bB][01]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(?:[kKmMgGtTpP][bB])?(?:[lLdDuUnN]|[uU][lL]|[sS]|[mM][sS])?$/u;

// ---------------------------------------------------------------------------
// the lexer
// ---------------------------------------------------------------------------

export interface LexOptions {
  /**
   * Where to begin. `command` is right for a submitted line and for the line
   * editor; `expression` is for lexing a fragment already known to be one.
   */
  readonly mode?: LexerMode;
}

class Lexer {
  readonly #text: string;
  readonly #tokens: Token[] = [];
  readonly #diagnostics: Diagnostic[] = [];
  #i = 0;
  #mode: LexerMode;

  constructor(text: string, mode: LexerMode) {
    this.#text = text;
    this.#mode = mode;
  }

  run(): LexResult {
    while (this.#i < this.#text.length) {
      const before = this.#i;
      this.#step();
      // A step that consumed nothing would spin forever on an input this lexer
      // does not understand. Emitting Unknown and advancing keeps the promise
      // that lexing always terminates and always returns tokens.
      if (this.#i === before) {
        this.#emit('Unknown', before, before + 1, this.#text.slice(before, before + 1), null, false);
        this.#diagnose(
          'BrowserShellUnrecognizedCharacter',
          `The character ${JSON.stringify(this.#text[before] ?? '')} is not recognised here.`,
          before,
          before + 1,
          false,
        );
        this.#i = before + 1;
      }
    }
    return { tokens: this.#tokens, diagnostics: this.#diagnostics };
  }

  // -- plumbing -------------------------------------------------------------

  #at(offset = 0): string | undefined {
    return this.#text[this.#i + offset];
  }

  #emit(
    kind: TokenKind,
    start: number,
    end: number,
    value: string,
    quote: QuoteStyle,
    unterminated: boolean,
  ): void {
    this.#tokens.push({
      kind,
      text: this.#text.slice(start, end),
      value,
      start,
      end,
      quote,
      unterminated,
    });
  }

  #diagnose(id: string, message: string, start: number, end: number, incomplete: boolean): void {
    this.#diagnostics.push({ id, message, start, end, incomplete });
  }

  /** The token that ends a statement, so the next word is a command head again. */
  #startStatement(): void {
    this.#mode = 'command';
  }

  /** True when the lexer is looking at the head of a command, not an argument. */
  get #inCommand(): boolean {
    return this.#mode === 'command';
  }

  /**
   * A statement whose first character cannot begin a command name is an
   * EXPRESSION, and lexes by different rules from there on.
   *
   * Measured pairs that force this: `1+1` is `Number Plus Number` while
   * `Get-Item 1+1` is one Generic argument; `$x -eq 1` gives the operator token
   * `Ieq` while `Get-Item -eq` would give the parameter `-eq`. A lexer with one
   * mode is wrong about one of each pair, and all nine of the tokenizers this
   * replaces had one mode.
   *
   * `-` is deliberately NOT a trigger: `-Path` at a statement start is measured
   * as `Parameter`, not as an operator or a minus. `@` is not one either,
   * because `@x`, `@(` and `@{` each have their own path.
   */
  #maybeEnterExpression(c: string): void {
    if (isDigit(c) || c === '$' || c === '[' || c === '"' || c === "'") {
      this.#mode = 'expression';
    }
  }

  /**
   * `.Name` and `::Name` immediately after something a member can hang off.
   *
   * Measured: `Write-Output $_.Name` lexes as `Generic Variable Dot Identifier`
   * — the member access happens even in ARGUMENT position, where a bare word
   * would otherwise swallow `.Name` whole. That is what `tokenize.ts` did, and
   * it is why `$_.Length -gt 10` could not be told from a filename.
   *
   * Adjacency is required: `$x .Name` is a variable and a separate argument.
   */
  /**
   * Could the token just emitted be the end of a value?
   *
   * Decides whether a following `-` or `+` is a sign or a binary operator, which
   * is the difference between `1+1` being three tokens and being two.
   */
  #previousEndsValue(): boolean {
    const previous = this.#tokens[this.#tokens.length - 1];
    if (previous === undefined) return false;
    switch (previous.kind) {
      case 'Number':
      case 'Variable':
      case 'RParen':
      case 'RBracket':
      case 'RCurly':
      case 'Identifier':
      case 'Generic':
      case 'StringLiteral':
      case 'StringExpandable':
      case 'HereStringLiteral':
      case 'HereStringExpandable':
        return true;
      default:
        return false;
    }
  }

  #lexMemberAccess(): boolean {
    if (this.#mode === 'expression') return false;
    const previous = this.#tokens[this.#tokens.length - 1];
    if (previous === undefined || previous.end !== this.#i) return false;
    if (previous.kind !== 'Variable' && previous.kind !== 'RParen') return false;
    const c = this.#at();
    if (c === '.' && isIdentifierStart(this.#at(1))) {
      this.#mode = 'expression';
      return false;
    }
    if (c === ':' && this.#at(1) === ':') {
      this.#mode = 'expression';
      return false;
    }
    return false;
  }

  // -- dispatch -------------------------------------------------------------

  #step(): void {
    const c = this.#at();
    if (c === undefined) return;

    if (SPACE.has(c)) {
      this.#i += 1;
      return;
    }

    if (this.#mode === 'command') this.#maybeEnterExpression(c);
    if (this.#lexMemberAccess()) return;

    if (c === '\n') {
      this.#emit('NewLine', this.#i, this.#i + 1, '\n', null, false);
      this.#i += 1;
      this.#startStatement();
      return;
    }

    // A backtick immediately before a newline continues the line; anywhere else
    // it is an escape and belongs to the word that contains it.
    if (c === '`' && (this.#at(1) === '\n' || (this.#at(1) === '\r' && this.#at(2) === '\n'))) {
      const end = this.#at(1) === '\r' ? this.#i + 3 : this.#i + 2;
      this.#emit('LineContinuation', this.#i, end, '', null, false);
      this.#i = end;
      return;
    }

    if (c === '#') return this.#lexLineComment();
    if (c === '<' && this.#at(1) === '#') return this.#lexBlockComment();

    if (this.#lexSeparator()) return;
    if (this.#lexRedirection()) return;
    if (this.#lexAtSign()) return;

    if (c === '"' || c === "'") return this.#lexQuoted(c);
    if (c === '$') return this.#lexDollar();
    if (c === '-') return this.#lexDash();

    if (this.#mode === 'expression') return this.#lexExpressionAtom();
    return this.#lexBareWord();
  }

  // -- trivia ---------------------------------------------------------------

  #lexLineComment(): void {
    const start = this.#i;
    while (this.#i < this.#text.length && this.#at() !== '\n') this.#i += 1;
    this.#emit('Comment', start, this.#i, this.#text.slice(start, this.#i), null, false);
  }

  #lexBlockComment(): void {
    const start = this.#i;
    this.#i += 2;
    while (this.#i < this.#text.length) {
      if (this.#at() === '#' && this.#at(1) === '>') {
        this.#i += 2;
        this.#emit('Comment', start, this.#i, this.#text.slice(start, this.#i), null, false);
        return;
      }
      this.#i += 1;
    }
    this.#emit('Comment', start, this.#i, this.#text.slice(start, this.#i), null, true);
    this.#diagnose(
      'MissingTerminatorMultiLineComment',
      'Missing closing "#>" in block comment.',
      start,
      this.#i,
      true,
    );
  }

  // -- separators -----------------------------------------------------------

  /** `| && || ; & , ( ) { } [ ]`, and the statement-start bookkeeping they drive. */
  #lexSeparator(): boolean {
    const c = this.#at();
    if (c === undefined) return false;
    const two = c + (this.#at(1) ?? '');

    if (two === '&&' || two === '||') {
      this.#emit(two === '&&' ? 'AndAnd' : 'OrOr', this.#i, this.#i + 2, two, null, false);
      this.#i += 2;
      this.#startStatement();
      return true;
    }

    const simple: Partial<Record<string, TokenKind>> = {
      '|': 'Pipe',
      ';': 'Semi',
      '&': 'Ampersand',
      '(': 'LParen',
      ')': 'RParen',
      '{': 'LCurly',
      '}': 'RCurly',
    };
    const kind = simple[c];
    if (kind !== undefined) {
      this.#emit(kind, this.#i, this.#i + 1, c, null, false);
      this.#i += 1;
      // `)` and `}` CLOSE a statement, so what follows them is not a command
      // head; everything else here opens one.
      if (c === ')' || c === '}') this.#mode = 'expression';
      else this.#startStatement();
      return true;
    }

    // `,` `[` `]` do not open a statement. In argument mode `[` and `]` are
    // ordinary word characters — measured, `f a]b` is one Generic — so only a
    // LEADING `]` becomes its own token there, matching `f ]ab`.
    if (c === ',') {
      this.#emit('Comma', this.#i, this.#i + 1, c, null, false);
      this.#i += 1;
      return true;
    }
    if (this.#mode === 'expression' && (c === '[' || c === ']')) {
      this.#emit(c === '[' ? 'LBracket' : 'RBracket', this.#i, this.#i + 1, c, null, false);
      this.#i += 1;
      return true;
    }
    if (this.#mode !== 'expression' && c === ']') {
      this.#emit('Generic', this.#i, this.#i + 1, c, null, false);
      this.#i += 1;
      return true;
    }
    return false;
  }

  // -- redirection ----------------------------------------------------------

  /**
   * `>` `>>` `N>` `N>>` `*>` `*>>` `N>&1` `*>&1`, and `<`.
   *
   * Only at the START of a token: `f a>b` is one Generic word, measured. Only
   * streams 1-6 and `*` count, so `7>` falls through to the word scanner.
   */
  #lexRedirection(): boolean {
    const c = this.#at();
    if (c === undefined) return false;

    if (c === '<') {
      this.#emit('RedirectInStd', this.#i, this.#i + 1, '<', null, false);
      this.#diagnose(
        'RedirectionNotSupported',
        'The "<" redirection operator is not supported in PowerShell.',
        this.#i,
        this.#i + 1,
        false,
      );
      this.#i += 1;
      return true;
    }

    const start = this.#i;
    let cursor = this.#i;
    let stream = '';
    const first = this.#text[cursor];
    if (first !== undefined && ((first >= '1' && first <= '6') || first === '*')) {
      stream = first;
      cursor += 1;
    }
    if (this.#text[cursor] !== '>') return false;
    cursor += 1;
    if (this.#text[cursor] === '>') {
      cursor += 1;
    } else if (this.#text[cursor] === '&') {
      // The merge form. pwsh's grammar accepts `&1` and `&2`; only a target of
      // 1 is then supported, and `1>&1` is refused as well. `2>&3` is not even
      // lexed as a merge, which is why the target set is exactly {1, 2}.
      const target = this.#text[cursor + 1];
      if (target === '1' || target === '2') {
        cursor += 2;
        const text = this.#text.slice(start, cursor);
        this.#emit('Redirection', start, cursor, text, null, false);
        if (target !== '1' || stream === '1') {
          this.#diagnose(
            'RedirectionNotSupported',
            `The "${text}" redirection operator is not supported in PowerShell. ` +
              'Streams can only be merged into the success stream.',
            start,
            cursor,
            false,
          );
        }
        this.#i = cursor;
        return true;
      }
    }
    const text = this.#text.slice(start, cursor);
    this.#emit('Redirection', start, cursor, text, null, false);
    this.#i = cursor;
    return true;
  }

  // -- `@` ------------------------------------------------------------------

  /** `@(` `@{` `@"` `@'` and splatting. */
  #lexAtSign(): boolean {
    if (this.#at() !== '@') return false;
    const next = this.#at(1);

    if (next === '(') {
      this.#emit('AtParen', this.#i, this.#i + 2, '@(', null, false);
      this.#i += 2;
      this.#startStatement();
      return true;
    }
    if (next === '{') {
      this.#emit('AtCurly', this.#i, this.#i + 2, '@{', null, false);
      this.#i += 2;
      this.#mode = 'expression';
      return true;
    }
    if (next === '"' || next === "'") {
      this.#lexHereString(next);
      return true;
    }
    if (isIdentifierStart(next) || next === '$') {
      const start = this.#i;
      this.#i += 1;
      if (this.#at() === '$') this.#i += 1;
      while (isIdentifierPart(this.#at()) || this.#at() === ':') this.#i += 1;
      const text = this.#text.slice(start, this.#i);
      this.#emit('SplattedVariable', start, this.#i, text.slice(1), null, false);
      if (this.#mode === 'expression') {
        this.#diagnose(
          'SplattingNotPermitted',
          'Splatting is only permitted for a command argument, not in an expression. ' +
            `Use "$${text.slice(1)}" instead.`,
          start,
          this.#i,
          false,
        );
      }
      this.#mode = 'argument';
      return true;
    }
    return false;
  }

  /**
   * `@"` NEWLINE ... NEWLINE `"@`.
   *
   * Measured: the opening newline and the newline before the terminator are BOTH
   * dropped from the value; the terminator must sit at column zero; a bare quote
   * inside needs no escaping; and `@""@` — no newline after the header — is an
   * error in its own right.
   */
  #lexHereString(quote: '"' | "'"): void {
    const start = this.#i;
    this.#i += 2;
    const expandable = quote === '"';

    let headerBad = false;
    if (this.#at() === '\r') this.#i += 1;
    if (this.#at() === '\n') this.#i += 1;
    else headerBad = true;

    const bodyStart = this.#i;
    let bodyEnd = -1;
    let terminatorEnd = -1;
    let whitespaceBefore = false;

    while (this.#i < this.#text.length) {
      if (this.#at() === quote && this.#at(1) === '@') {
        // Column zero, i.e. immediately after a newline. Whitespace before the
        // footer is a distinct measured error, and pwsh does NOT close there.
        let lineStart = this.#i;
        while (lineStart > bodyStart && this.#text[lineStart - 1] !== '\n') lineStart -= 1;
        const indent = this.#text.slice(lineStart, this.#i);
        if (indent.length === 0) {
          bodyEnd = lineStart;
          terminatorEnd = this.#i + 2;
          break;
        }
        if (indent.trim().length === 0) whitespaceBefore = true;
      }
      this.#i += 1;
    }

    const kind: TokenKind = expandable ? 'HereStringExpandable' : 'HereStringLiteral';
    const style: QuoteStyle = expandable ? '@"' : "@'";

    if (terminatorEnd === -1) {
      const raw = this.#text.slice(bodyStart);
      const body = raw.replace(/\r?\n$/u, '');
      this.#i = this.#text.length;
      this.#emit(kind, start, this.#i, expandable ? decodeEscapes(body) : body, style, true);
      this.#diagnose(
        whitespaceBefore ? 'WhitespaceBeforeHereStringFooter' : 'TerminatorExpectedAtEndOfString',
        whitespaceBefore
          ? `No whitespace is allowed before the string terminator "${quote}@".`
          : `The string is missing the terminator: ${quote}@.`,
        start,
        this.#i,
        true,
      );
      return;
    }

    const body = this.#text.slice(bodyStart, bodyEnd).replace(/\r?\n$/u, '');
    this.#i = terminatorEnd;
    this.#emit(kind, start, this.#i, expandable ? decodeEscapes(body) : body, style, false);
    if (headerBad) {
      this.#diagnose(
        'UnexpectedCharactersAfterHereStringHeader',
        `No characters are allowed after the here-string header "@${quote}"; ` +
          'the string must start on the next line.',
        start,
        start + 2,
        false,
      );
    }
  }

  // -- strings --------------------------------------------------------------

  /**
   * A quote at the START of a token opens a string; a quote inside a word is
   * absorbed by `#lexBareWord`. Measured: `f "a"b` is two tokens, `f a"b"c` is
   * one.
   */
  #lexQuoted(quote: '"' | "'"): void {
    const start = this.#i;
    const scan = readQuoted(this.#text, start, quote);
    this.#i = scan.end;
    this.#emit(
      quote === '"' ? 'StringExpandable' : 'StringLiteral',
      start,
      scan.end,
      scan.value,
      quote,
      scan.unterminated,
    );
    if (scan.unterminated) {
      this.#diagnose(
        'TerminatorExpectedAtEndOfString',
        `The string is missing the terminator: ${quote}.`,
        start,
        scan.end,
        true,
      );
    }
    if (this.#inCommand) this.#mode = 'argument';
  }

  // -- `$` ------------------------------------------------------------------

  #lexDollar(): void {
    const start = this.#i;
    if (this.#at(1) === '(') {
      this.#emit('DollarParen', start, start + 2, '$(', null, false);
      this.#i += 2;
      this.#startStatement();
      return;
    }
    this.#i += 1;
    if (this.#at() === '{') {
      // `${weird name}` — everything up to the closing brace is the name.
      this.#i += 1;
      while (this.#i < this.#text.length && this.#at() !== '}') this.#i += 1;
      if (this.#at() === '}') this.#i += 1;
      const text = this.#text.slice(start, this.#i);
      this.#emit('Variable', start, this.#i, text.slice(2, -1), null, false);
      if (this.#inCommand) this.#mode = 'argument';
      return;
    }
    if (this.#at() === '_' || this.#at() === '$' || this.#at() === '^' || this.#at() === '?') {
      this.#i += 1;
    }
    while (isIdentifierPart(this.#at()) || this.#at() === ':') this.#i += 1;
    // A trailing `?` is part of the name: measured, `$x?` is Variable("$x?").
    if (this.#at() === '?' && this.#text[this.#i - 1] !== '?') this.#i += 1;
    const text = this.#text.slice(start, this.#i);
    this.#emit('Variable', start, this.#i, text.slice(1), null, false);
    if (this.#inCommand) this.#mode = 'argument';
  }

  // -- `-` ------------------------------------------------------------------

  /**
   * `-Name`, `-Name:`, `-eq`, `-5`, `--`, `--%`, and a lone `-`.
   *
   * Mode-dependent in two places, both measured:
   *
   *   `-5`      statement start -> Number(-5);  argument -> Generic("-5")
   *   `--Path`  statement start -> MinusMinus Identifier;  argument -> Generic
   */
  #lexDash(): void {
    const start = this.#i;
    const next = this.#at(1);

    // `--%` — everything after it is verbatim until `|`, `&&`, `||` or newline.
    // NOT `;` and NOT `>`, which is the part nobody remembers.
    if (next === '-' && this.#at(2) === '%') {
      this.#emit('Generic', start, start + 3, '--%', null, false);
      this.#i = start + 3;
      this.#lexVerbatimRemainder();
      return;
    }

    if (next === '-') {
      if (this.#mode === 'argument') {
        this.#lexBareWord();
        return;
      }
      this.#emit('MinusMinus', start, start + 2, '--', null, false);
      this.#i += 2;
      this.#diagnose(
        'MissingExpressionAfterOperator',
        'You must provide a value expression following the "--" operator.',
        start,
        start + 2,
        false,
      );
      this.#mode = 'expression';
      return;
    }

    if (isIdentifierStart(next)) {
      let cursor = this.#i + 1;
      while (isIdentifierPart(this.#text[cursor])) cursor += 1;
      const word = this.#text.slice(this.#i + 1, cursor);

      // An operator only where an operator can stand. `Get-Item -eq` binds a
      // parameter named `eq`, which is why `tokenize.ts` keeping one flat
      // operator list made `$_.Length -gt 10` and `Sort-Object -Descending`
      // classify by the same rule.
      const operator = DASH_OPERATORS.get(word.toLowerCase());
      if (operator !== undefined && this.#mode === 'expression') {
        this.#emit(operator, start, cursor, this.#text.slice(start, cursor), null, false);
        this.#i = cursor;
        return;
      }

      // The colon belongs to the Parameter token: measured, `-Name:value` is
      // `Parameter("-Name:")` then `Identifier("value")`.
      if (this.#text[cursor] === ':') cursor += 1;
      this.#emit('Parameter', start, cursor, this.#text.slice(start, cursor), null, false);
      this.#i = cursor;
      if (this.#inCommand) this.#mode = 'argument';
      return;
    }

    if (this.#mode === 'argument') {
      // `-5` as an argument is a bare word, not a number. Measured on
      // `Get-Random -Minimum -5 -Maximum 10`.
      this.#lexBareWord();
      return;
    }

    if (isDigit(next) || (next === '.' && isDigit(this.#at(2)))) {
      this.#lexExpressionAtom();
      return;
    }

    this.#emit('Minus', start, start + 1, '-', null, false);
    this.#i += 1;
    this.#diagnose(
      'MissingExpressionAfterOperator',
      'You must provide a value expression following the "-" operator.',
      start,
      start + 1,
      false,
    );
  }

  /**
   * Everything after `--%`, verbatim.
   *
   * Measured stops: `|`, `&&`, `||`, newline. NOT `;`, NOT `>`, NOT a quote.
   * Emits a zero-length Generic when nothing follows, which is what pwsh does
   * for `Write-Output --%`.
   */
  #lexVerbatimRemainder(): void {
    while (SPACE.has(this.#at() ?? '')) this.#i += 1;
    const start = this.#i;
    while (this.#i < this.#text.length) {
      const c = this.#at();
      if (c === '\n' || c === '|') break;
      if ((c === '&' && this.#at(1) === '&') || (c === '|' && this.#at(1) === '|')) break;
      this.#i += 1;
    }
    const text = this.#text.slice(start, this.#i);
    this.#emit('Generic', start, this.#i, text, null, false);
  }

  // -- words ----------------------------------------------------------------

  /**
   * A bare word in command or argument position.
   *
   * Breaks only on whitespace, a newline, and the eight measured break
   * characters. Absorbs quotes, backtick escapes, `>` `<` `=` `.` `+` `*` and
   * everything else. `#` starts a comment only at the start of a word — `f a#b`
   * is one word, `f a #b` is a word and a comment.
   */
  #lexBareWord(): void {
    const start = this.#i;
    let value = '';
    let unterminated = false;

    while (this.#i < this.#text.length) {
      const c = this.#at();
      if (c === undefined) break;
      if (SPACE.has(c) || c === '\n') break;
      if (ARGUMENT_BREAKS.has(c)) break;

      if (c === '`') {
        const escaped = this.#at(1);
        if (escaped === undefined) {
          // A trailing backtick is kept literally: `f a\`` has the value "a`".
          value += '`';
          this.#i += 1;
          continue;
        }
        value += ESCAPES.get(escaped) ?? escaped;
        this.#i += 2;
        continue;
      }

      if (c === '"' || c === "'") {
        const inner = readQuoted(this.#text, this.#i, c);
        value += inner.value;
        this.#i = inner.end;
        if (inner.unterminated) {
          unterminated = true;
          this.#diagnose(
            'TerminatorExpectedAtEndOfString',
            `The string is missing the terminator: ${c}.`,
            start,
            this.#i,
            true,
          );
        }
        continue;
      }

      value += c;
      this.#i += 1;
    }

    const text = this.#text.slice(start, this.#i);
    this.#emit(this.#classifyWord(text), start, this.#i, value, null, unterminated);
    if (this.#inCommand) this.#mode = 'argument';
  }

  /**
   * `Identifier`, `Number` or `Generic`.
   *
   * Measured: a word that is a plain identifier is `Identifier`; a word that is
   * wholly a number is `Number` — but only when it does not start with a dash,
   * because `-5` in argument position is `Generic`; everything else is
   * `Generic`. Classification is on the raw TEXT, not the decoded value, so
   * `` a`tb `` is Generic even though its value has no odd characters.
   */
  #classifyWord(text: string): TokenKind {
    if (IDENTIFIER_RE.test(text)) return 'Identifier';
    if (!text.startsWith('-') && !text.startsWith('+') && NUMBER_RE.test(text)) return 'Number';
    return 'Generic';
  }

  /**
   * Expression mode: numbers, identifiers and the punctuation operators.
   *
   * Deliberately narrower than command mode. An expression this engine cannot
   * evaluate must reach `parse.ts` as something it can REFUSE BY NAME, and
   * lexing it into a bare word would hide it instead.
   */
  #lexExpressionAtom(): void {
    const start = this.#i;
    const c = this.#at();
    if (c === undefined) return;

    // Numbers, including a leading sign — but a sign is only part of the number
    // where a value cannot already have ended. Measured: `1+1` is
    // `Number Plus Number`, not `Number Number(+1)`, while a bare `-5` at the
    // start of a statement IS the number minus five.
    const signed = (c === '-' || c === '+') && (isDigit(this.#at(1)) || this.#at(1) === '.');
    if (isDigit(c) || (signed && !this.#previousEndsValue())) {
      let cursor = this.#i + 1;
      while (cursor < this.#text.length) {
        const d = this.#text[cursor];
        if (d === undefined) break;
        // `1..10` is a range, not `1.` then `.10`: stop before a second dot.
        if (d === '.' && this.#text[cursor + 1] === '.') break;
        if (isIdentifierPart(d) || d === '.') {
          cursor += 1;
          continue;
        }
        break;
      }
      const text = this.#text.slice(start, cursor);
      this.#i = cursor;
      this.#emit(NUMBER_RE.test(text) ? 'Number' : 'Generic', start, cursor, text, null, false);
      return;
    }

    if (isIdentifierStart(c)) {
      let cursor = this.#i;
      while (isIdentifierPart(this.#text[cursor])) cursor += 1;
      const text = this.#text.slice(start, cursor);
      this.#i = cursor;
      this.#emit('Identifier', start, cursor, text, null, false);
      return;
    }

    const two = c + (this.#at(1) ?? '');
    const pairs: Partial<Record<string, TokenKind>> = {
      '..': 'DotDot',
      '::': 'ColonColon',
      '++': 'PlusPlus',
      '??': 'QuestionQuestion',
    };
    const pair = pairs[two];
    if (pair !== undefined) {
      this.#emit(pair, start, start + 2, two, null, false);
      this.#i += 2;
      return;
    }

    const singles: Partial<Record<string, TokenKind>> = {
      '.': 'Dot',
      ':': 'Colon',
      '=': 'Equals',
      '+': 'Plus',
      '*': 'Multiply',
      '/': 'Divide',
      '%': 'Rem',
      '!': 'Exclaim',
      '?': 'QuestionMark',
    };
    const single = singles[c];
    if (single !== undefined) {
      this.#emit(single, start, start + 1, c, null, false);
      this.#i += 1;
      return;
    }

    // Unrecognised in expression mode: fall back to the word scanner so the
    // lexer still terminates and still returns a token for every character.
    this.#lexBareWord();
  }
}

// ---------------------------------------------------------------------------
// shared string reading
// ---------------------------------------------------------------------------

/**
 * Read a quoted run starting at `start`, whose first character is `quote`.
 *
 * Shared by the string path and the bare-word path precisely because those two
 * used to be separate implementations with different answers — `readWord` and
 * `readQuoted` in `tokenize.ts` handled the doubling rule twice.
 *
 * Measured rules: `''` and `""` are a literal quote in their own style; the
 * backtick escapes ONLY inside `"..."`, where it can also escape the closing
 * quote (so `"abc\`"` is unterminated); inside `'...'` the backtick is an
 * ordinary character, so `'pre\`'post'` ends at the quote after the backtick.
 */
function readQuoted(
  text: string,
  start: number,
  quote: '"' | "'",
): { value: string; end: number; unterminated: boolean } {
  const expandable = quote === '"';
  let i = start + 1;
  let value = '';

  while (i < text.length) {
    const c = text[i];
    if (c === quote) {
      if (text[i + 1] === quote) {
        value += quote;
        i += 2;
        continue;
      }
      return { value, end: i + 1, unterminated: false };
    }
    if (expandable && c === '`' && i + 1 < text.length) {
      const escaped = text[i + 1] ?? '';
      if (escaped === 'u' && text[i + 2] === '{') {
        const close = text.indexOf('}', i + 3);
        if (close !== -1) {
          const hex = text.slice(i + 3, close);
          const code = Number.parseInt(hex, 16);
          if (/^[0-9a-fA-F]{1,6}$/u.test(hex) && Number.isFinite(code) && code <= 0x10ffff) {
            value += String.fromCodePoint(code);
            i = close + 1;
            continue;
          }
        }
      }
      value += ESCAPES.get(escaped) ?? escaped;
      i += 2;
      continue;
    }
    value += c ?? '';
    i += 1;
  }
  return { value, end: text.length, unterminated: true };
}

/** The escape table applied to a here-string body, which has no quote to close. */
function decodeEscapes(body: string): string {
  let value = '';
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === '`' && i + 1 < body.length) {
      const escaped = body[i + 1] ?? '';
      value += ESCAPES.get(escaped) ?? escaped;
      i += 1;
      continue;
    }
    value += c ?? '';
  }
  return value;
}

// ---------------------------------------------------------------------------
// public entry point
// ---------------------------------------------------------------------------

/**
 * Lex a command line. Never throws; always returns a token for every character.
 *
 * This is the ONLY tokenizer in the engine. `src/line-editor/tokenize.ts`,
 * the highlighter and both parsers are views over this function, so a string
 * cannot be tokenised by a second path — `tests/unit/lexer-single.test.mts`
 * asserts exactly that, the way `to-string.test.mts` asserts there is one
 * value-to-string implementation.
 */
export function lex(text: string, options: LexOptions = {}): LexResult {
  return new Lexer(text, options.mode ?? 'command').run();
}
