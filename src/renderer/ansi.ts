/**
 * ansi.ts — the only module in this repository that knows what ESC means.
 *
 * WHY IT IS SEPARATE FROM THE FORMATTER. `src/formatting/` turns objects into
 * PLAIN TEXT: `Out-String` produces characters, and every width decision it
 * makes — column sizing, wrapping, truncation — assumes those characters are
 * printable. An escape sequence breaks that assumption in the worst way,
 * because it is wide in the string and narrow on the screen. MEASURED, by
 * running this repository's own Format-Table over a two-row table whose first
 * cell is `\x1b[31mfoo\x1b[0m` and whose second is `foo`:
 *
 *     "V          W"          the column is sized 10
 *     "-          -"
 *     "\x1b[31mfoo\x1b[0m x"  drawn as `foo x` — the x lands at column 4
 *     "foo        y"          the y lands at column 11
 *
 * Ten, not twelve: `sizingWidth` already gives ESC itself zero, so the cost is
 * the seven printable characters of the two sequences, and the two rows come
 * out seven columns apart. Roadmap 16.2 asks for the separation for exactly
 * that reason, and the separation is a DIRECTION: text flows formatting ->
 * renderer, and nothing under `src/formatting/` imports this file.
 * `tests/unit/renderer-ansi.test.mts` reproduces both halves — the measurement
 * and the direction — rather than leaving either as an intention.
 *
 * WHAT IT IMPLEMENTS. The VT500 parser state machine (Paul Williams'), which is
 * the machine xterm.js's `EscapeSequenceParser` implements, reduced to the
 * states a shell transcript can reach. The states are named after the diagram:
 *
 *   GROUND  ESCAPE  ESCAPE_INTERMEDIATE
 *   CSI_ENTRY  CSI_PARAM  CSI_INTERMEDIATE  CSI_IGNORE
 *   OSC_STRING  DCS/SOS/PM/APC (one state here — nothing interprets their bodies)
 *
 * THREE DELIBERATE DEVIATIONS FROM THE 1980s DIAGRAM, all of them shared with
 * every terminal written since:
 *
 *   `:` opens a SUB-PARAMETER instead of sending the sequence to CSI_IGNORE.
 *   The diagram predates ITU-T T.416, and `38:2::r:g:b` is how a modern
 *   application asks for truecolour. Rejecting it would drop the colour.
 *
 *   BEL terminates OSC and the device-control strings, not only ST. xterm has
 *   accepted it since forever and shells emit it; ST-only would swallow every
 *   window title as data.
 *
 *   A C0 control inside a sequence is EXECUTED and the sequence continues,
 *   which the diagram does say and which is easy to get wrong: the first draft
 *   here sent them to CSI_IGNORE, so `\x1b[1\r;31m` lost its colour. Inside a
 *   string state a C0 is ignored instead, and only BEL ends it.
 *
 * WHY A RESUMABLE MACHINE AND NOT A REGEX. A regex over one chunk is correct
 * only if every sequence arrives whole. It does not: a host writes what it has,
 * and a colour sequence really can be split across two `write()` calls. A regex
 * would emit `\x1b[3` as visible garbage — which also throws the column count
 * off — and then swallow the `1m` on the next chunk. So the parser holds its
 * state between calls and a split sequence is still one sequence. The test
 * feeds a coloured string one character at a time and asserts the events match
 * the whole-string parse.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not interpret. `parse` reports
 * events; deciding what a CSI means is `grid.ts`'s job, and refusing one is the
 * semantic renderer's. That split is what lets the semantic renderer say "I
 * cannot honour cursor addressing" while the xterm adapter, which can, is
 * handed the identical bytes.
 */

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

/**
 * One CSI parameter, with its sub-parameters.
 *
 * `[38, 5, 214]` is the colon form `38:5:214`; the semicolon form `38;5;214`
 * arrives as three separate parameters. Both spellings are legal and both are
 * emitted in the wild, so the SGR folder below accepts either.
 */
export type AnsiParam = readonly number[];

/** An omitted parameter. ECMA-48 calls it "default"; what that means is per-command. */
export const OMITTED = -1;

export type AnsiEvent =
  /** Printable characters. Never contains a C0 control or an escape. */
  | { readonly kind: 'text'; readonly text: string }
  /** A C0 control the parser executes rather than collects: BS, HT, LF, VT, FF, CR. */
  | { readonly kind: 'execute'; readonly code: number }
  /** `ESC [ prefix params intermediates final`. */
  | {
      readonly kind: 'csi';
      readonly final: string;
      readonly params: readonly AnsiParam[];
      /** A private-parameter byte, one of `<=>?`, or ''. `\x1b[?25l` has prefix '?'. */
      readonly prefix: string;
      readonly intermediates: string;
    }
  /** `ESC intermediates final`, e.g. `ESC ( B` or `ESC c`. */
  | { readonly kind: 'esc'; readonly final: string; readonly intermediates: string }
  /** `ESC ] identifier ; data BEL|ST`. `identifier` is OMITTED when unparseable. */
  | { readonly kind: 'osc'; readonly identifier: number; readonly data: string }
  /** DCS, SOS, PM or APC. Collected whole and handed on; nothing here reads one. */
  | { readonly kind: 'string'; readonly opener: string; readonly data: string };

// ---------------------------------------------------------------------------
// style
// ---------------------------------------------------------------------------

export type AnsiColor =
  | { readonly kind: 'default' }
  | { readonly kind: 'palette'; readonly index: number }
  | { readonly kind: 'rgb'; readonly r: number; readonly g: number; readonly b: number };

export const DEFAULT_COLOR: AnsiColor = { kind: 'default' };

export interface TextStyle {
  readonly foreground: AnsiColor;
  readonly background: AnsiColor;
  readonly bold: boolean;
  readonly dim: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  /** SGR 7. Named for the SGR's own word, "inverse", rather than "reverse". */
  readonly inverse: boolean;
  readonly hidden: boolean;
  readonly strikethrough: boolean;
}

export const DEFAULT_STYLE: TextStyle = {
  foreground: DEFAULT_COLOR,
  background: DEFAULT_COLOR,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
  hidden: false,
  strikethrough: false,
};

function colorEquals(a: AnsiColor, b: AnsiColor): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'palette' && b.kind === 'palette') return a.index === b.index;
  if (a.kind === 'rgb' && b.kind === 'rgb') return a.r === b.r && a.g === b.g && a.b === b.b;
  return true;
}

/** Value equality, so adjacent cells that look the same merge into one run. */
export function styleEquals(a: TextStyle, b: TextStyle): boolean {
  return (
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.inverse === b.inverse &&
    a.hidden === b.hidden &&
    a.strikethrough === b.strikethrough &&
    colorEquals(a.foreground, b.foreground) &&
    colorEquals(a.background, b.background)
  );
}

/** SGR 30-37 / 40-47 map to palette 0-7; 90-97 / 100-107 to the bright half, 8-15. */
const basicColor = (index: number): AnsiColor => ({ kind: 'palette', index });

const inByte = (n: number): boolean => n >= 0 && n <= 255;

/**
 * Read an extended colour introduced by SGR 38 or 48.
 *
 * Two spellings, both legal, both seen:
 *
 *   38;5;214        semicolon form  — three parameters
 *   38:5:214        colon form      — one parameter with two sub-parameters
 *   38;2;r;g;b      semicolon truecolour
 *   38:2::r:g:b     colon truecolour, with an empty colour-space id in slot 2
 *
 * The colon form's empty slot is why the truecolour case reads its three
 * channels from the END of the parameter rather than from a fixed offset: an
 * ISO 8613-6 colour-space identifier sits between the `2` and the red channel
 * and is almost always empty, so `38:2::r:g:b` is six slots and `38:2:r:g:b` is
 * five. Taking the last three is right for both.
 *
 * Returns the colour and how many WHOLE PARAMETERS were consumed — always 1 for
 * the colon form, whatever it contained.
 */
function readExtendedColor(
  params: readonly AnsiParam[],
  at: number,
): { color: AnsiColor | null; consumed: number } {
  const head = params[at];
  if (head === undefined) return { color: null, consumed: 1 };

  if (head.length > 1) {
    const mode = head[1] ?? OMITTED;
    if (mode === 5) {
      const index = head[2] ?? OMITTED;
      return { color: inByte(index) ? basicColor(index) : null, consumed: 1 };
    }
    if (mode === 2) {
      const rgb = head.slice(-3);
      const r = rgb[0] ?? OMITTED;
      const g = rgb[1] ?? OMITTED;
      const b = rgb[2] ?? OMITTED;
      const ok = inByte(r) && inByte(g) && inByte(b);
      return { color: ok ? { kind: 'rgb', r, g, b } : null, consumed: 1 };
    }
    return { color: null, consumed: 1 };
  }

  const mode = params[at + 1]?.[0] ?? OMITTED;
  if (mode === 5) {
    const index = params[at + 2]?.[0] ?? OMITTED;
    return { color: inByte(index) ? basicColor(index) : null, consumed: 3 };
  }
  if (mode === 2) {
    const r = params[at + 2]?.[0] ?? OMITTED;
    const g = params[at + 3]?.[0] ?? OMITTED;
    const b = params[at + 4]?.[0] ?? OMITTED;
    const ok = inByte(r) && inByte(g) && inByte(b);
    return { color: ok ? { kind: 'rgb', r, g, b } : null, consumed: 5 };
  }
  return { color: null, consumed: 2 };
}

/**
 * Fold an SGR sequence into a style.
 *
 * `\x1b[m` carries no parameters; ECMA-48 says an omitted SGR parameter means
 * 0, so it is a full reset.
 *
 * Codes this does not implement are IGNORED rather than aborting the sequence.
 * `\x1b[1;53;31m` — bold, overlined, red — has to still come out red, and
 * stopping at the unknown 53 would lose it. That is a deliberate asymmetry with
 * the CSI handling in grid.ts, which records what it could not honour: an
 * unknown ATTRIBUTE changes nothing about where characters land, and an unknown
 * COMMAND can change everything.
 */
export function applySgr(style: TextStyle, params: readonly AnsiParam[]): TextStyle {
  let next: TextStyle = style;
  const list = params.length === 0 ? [[OMITTED]] : params;

  for (let i = 0; i < list.length; i += 1) {
    const raw = list[i]?.[0] ?? OMITTED;
    const code = raw === OMITTED ? 0 : raw;

    if (code === 0) next = DEFAULT_STYLE;
    else if (code === 1) next = { ...next, bold: true };
    else if (code === 2) next = { ...next, dim: true };
    else if (code === 3) next = { ...next, italic: true };
    else if (code === 4) next = { ...next, underline: true };
    else if (code === 7) next = { ...next, inverse: true };
    else if (code === 8) next = { ...next, hidden: true };
    else if (code === 9) next = { ...next, strikethrough: true };
    // 22 clears BOTH bold and dim. They are one attribute in ECMA-48's terms
    // ("normal intensity"), and clearing only bold leaves dim text that no
    // sequence can turn off again.
    else if (code === 22) next = { ...next, bold: false, dim: false };
    else if (code === 23) next = { ...next, italic: false };
    else if (code === 24) next = { ...next, underline: false };
    else if (code === 27) next = { ...next, inverse: false };
    else if (code === 28) next = { ...next, hidden: false };
    else if (code === 29) next = { ...next, strikethrough: false };
    else if (code >= 30 && code <= 37) next = { ...next, foreground: basicColor(code - 30) };
    else if (code === 39) next = { ...next, foreground: DEFAULT_COLOR };
    else if (code >= 40 && code <= 47) next = { ...next, background: basicColor(code - 40) };
    else if (code === 49) next = { ...next, background: DEFAULT_COLOR };
    else if (code >= 90 && code <= 97) next = { ...next, foreground: basicColor(code - 90 + 8) };
    else if (code >= 100 && code <= 107) next = { ...next, background: basicColor(code - 100 + 8) };
    else if (code === 38 || code === 48) {
      const { color, consumed } = readExtendedColor(list, i);
      i += consumed - 1;
      if (color !== null) {
        next = code === 38 ? { ...next, foreground: color } : { ...next, background: color };
      }
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// the parser
// ---------------------------------------------------------------------------

const ESC = 0x1b;
const BEL = 0x07;
const CAN = 0x18;
const SUB = 0x1a;
const DEL = 0x7f;

type State =
  | 'ground'
  | 'escape'
  | 'escape-intermediate'
  | 'csi-entry'
  | 'csi-param'
  | 'csi-intermediate'
  | 'csi-ignore'
  | 'osc'
  | 'string';

/** The C0 controls handed on rather than dropped: BS, HT, LF, VT, FF, CR. */
const EXECUTED: ReadonlySet<number> = new Set([0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d]);

/**
 * A resumable VT parser. One instance per stream.
 *
 * `parse` may be called with any split of the stream and produces the same
 * events as one call with the whole of it. That is the property the class
 * exists for, and the one a regex cannot have.
 */
export class AnsiParser {
  #state: State = 'ground';
  #text = '';
  #params: number[][] = [];
  #current: number[] = [];
  #hasCurrent = false;
  /**
   * Whether the sub-parameter slot being filled has seen a digit yet.
   *
   * Without it a colon-separated slot cannot be told apart from an omitted one,
   * and the first digit ACCUMULATES onto the OMITTED sentinel instead of
   * replacing it: `38:2` parsed as `[38, -8]`, because -1 * 10 + 2 is -8. The
   * colour then silently vanished, since -8 is not a mode this understands.
   */
  #slotHasDigits = false;
  #prefix = '';
  #intermediates = '';
  #collected = '';
  #opener = '';

  /** True when a sequence is still open: more input is needed to finish it. */
  get pending(): boolean {
    return this.#state !== 'ground';
  }

  reset(): void {
    this.#state = 'ground';
    this.#text = '';
    this.#clearParams();
    this.#collected = '';
    this.#opener = '';
  }

  #clearParams(): void {
    this.#params = [];
    this.#current = [];
    this.#hasCurrent = false;
    this.#slotHasDigits = false;
    this.#prefix = '';
    this.#intermediates = '';
  }

  #flushText(out: AnsiEvent[]): void {
    if (this.#text === '') return;
    out.push({ kind: 'text', text: this.#text });
    this.#text = '';
  }

  /** Close the parameter being accumulated. An empty one is OMITTED, not 0. */
  #closeParam(): void {
    this.#params.push(this.#hasCurrent ? this.#current : [OMITTED]);
    this.#current = [];
    this.#hasCurrent = false;
    this.#slotHasDigits = false;
  }

  /**
   * The parameter list a final byte closes.
   *
   * A CSI with NOTHING between `[` and the final byte has no parameters at all
   * — `\x1b[m` is `[]`, not `[[OMITTED]]` — which is xterm.js's own reading and
   * is why `applySgr` treats an empty list as a reset rather than relying on a
   * sentinel. One that has a separator does: `\x1b[;m` is two omitted
   * parameters, and losing that would make it indistinguishable from the bare
   * form for every command whose parameter count matters.
   */
  #finishParams(): readonly AnsiParam[] {
    if (this.#hasCurrent || this.#params.length > 0) this.#closeParam();
    return this.#params;
  }

  #osc(): AnsiEvent {
    const data = this.#collected;
    this.#collected = '';
    const semicolon = data.indexOf(';');
    if (semicolon === -1) return { kind: 'osc', identifier: OMITTED, data };
    const head = data.slice(0, semicolon);
    const identifier = /^[0-9]+$/.test(head) ? Number(head) : OMITTED;
    return { kind: 'osc', identifier, data: data.slice(semicolon + 1) };
  }

  parse(chunk: string): AnsiEvent[] {
    const out: AnsiEvent[] = [];

    for (const character of chunk) {
      const code = character.codePointAt(0) ?? 0;

      // CAN and SUB abort any sequence, from any state. Without this one
      // truncated sequence poisons every byte after it.
      if ((code === CAN || code === SUB) && this.#state !== 'ground') {
        this.#state = 'ground';
        this.#clearParams();
        this.#collected = '';
        continue;
      }

      // A C0 control INSIDE a sequence does not end it.
      //
      // This is the reference machine's rule and it is not the obvious one: in
      // CSI_ENTRY, CSI_PARAM, CSI_INTERMEDIATE, CSI_IGNORE, ESCAPE and
      // ESCAPE_INTERMEDIATE a C0 is `execute`d and the state is KEPT, so
      // `\x1b[1\r;31m` sets red and moves the carriage rather than losing the
      // colour. The first draft here sent those to csi-ignore, which discards
      // the sequence — the same class of defect the parser exists to prevent,
      // one layer down. Inside OSC and the device-control strings a C0 is
      // ignored instead, except BEL, which every implementation accepts as a
      // terminator and which therefore falls through to the state below.
      if (this.#state !== 'ground' && (code < 0x20 || code === DEL) && code !== ESC) {
        const inString = this.#state === 'osc' || this.#state === 'string';
        if (!inString) {
          if (EXECUTED.has(code)) out.push({ kind: 'execute', code });
          continue;
        }
        if (code !== BEL) continue;
      }

      // An ESC inside a sequence RESTARTS the sequence rather than ending it
      // badly. The string states handle their own ESC below, because they have
      // a body to emit first.
      if (
        code === ESC &&
        this.#state !== 'ground' &&
        this.#state !== 'osc' &&
        this.#state !== 'string'
      ) {
        this.#clearParams();
        this.#state = 'escape';
        continue;
      }

      switch (this.#state) {
        case 'ground': {
          if (code === ESC) {
            this.#flushText(out);
            this.#clearParams();
            this.#state = 'escape';
          } else if (code < 0x20 || code === DEL) {
            this.#flushText(out);
            if (EXECUTED.has(code)) out.push({ kind: 'execute', code });
            // Everything else in C0 — NUL, SO, SI, the rest — is dropped. A
            // terminal that printed them would put control characters into a
            // log region that a screen reader then reads out.
          } else if (code >= 0x80 && code <= 0x9f) {
            // C1. Dropped for the same reason, and because a UTF-8 stream that
            // produced one is nearly always a decoding accident rather than an
            // intended control.
            this.#flushText(out);
          } else {
            this.#text += character;
          }
          break;
        }

        case 'escape': {
          if (character === '[') {
            this.#state = 'csi-entry';
          } else if (character === ']') {
            this.#collected = '';
            this.#state = 'osc';
          } else if (character === 'P' || character === 'X' || character === '^' || character === '_') {
            this.#collected = '';
            this.#opener = character;
            this.#state = 'string';
          } else if (code >= 0x20 && code <= 0x2f) {
            this.#intermediates += character;
            this.#state = 'escape-intermediate';
          } else if (code >= 0x30 && code <= 0x7e) {
            out.push({ kind: 'esc', final: character, intermediates: '' });
            this.#state = 'ground';
          } else {
            this.#state = 'ground';
          }
          break;
        }

        case 'escape-intermediate': {
          if (code >= 0x20 && code <= 0x2f) {
            this.#intermediates += character;
          } else if (code >= 0x30 && code <= 0x7e) {
            out.push({ kind: 'esc', final: character, intermediates: this.#intermediates });
            this.#clearParams();
            this.#state = 'ground';
          } else {
            this.#clearParams();
            this.#state = 'ground';
          }
          break;
        }

        case 'csi-entry':
        case 'csi-param': {
          if (code >= 0x30 && code <= 0x39) {
            const digit = code - 0x30;
            if (!this.#hasCurrent) this.#current.push(digit);
            else if (!this.#slotHasDigits) this.#current[this.#current.length - 1] = digit;
            else {
              const last = this.#current.length - 1;
              this.#current[last] = (this.#current[last] ?? 0) * 10 + digit;
            }
            this.#hasCurrent = true;
            this.#slotHasDigits = true;
            this.#state = 'csi-param';
          } else if (character === ':') {
            // A sub-parameter. An empty slot stays OMITTED, which is what makes
            // `38:2::r:g:b` readable at all — the third slot is a colour-space
            // identifier that is nearly always absent.
            if (!this.#hasCurrent) this.#current.push(OMITTED);
            this.#current.push(OMITTED);
            this.#hasCurrent = true;
            this.#slotHasDigits = false;
            this.#state = 'csi-param';
          } else if (character === ';') {
            this.#closeParam();
            this.#state = 'csi-param';
          } else if (this.#state === 'csi-entry' && code >= 0x3c && code <= 0x3f) {
            this.#prefix += character;
          } else if (code >= 0x20 && code <= 0x2f) {
            this.#intermediates += character;
            this.#state = 'csi-intermediate';
          } else if (code >= 0x40 && code <= 0x7e) {
            out.push({
              kind: 'csi',
              final: character,
              params: this.#finishParams(),
              prefix: this.#prefix,
              intermediates: this.#intermediates,
            });
            this.#clearParams();
            this.#state = 'ground';
          } else {
            this.#state = 'csi-ignore';
          }
          break;
        }

        case 'csi-intermediate': {
          if (code >= 0x20 && code <= 0x2f) {
            this.#intermediates += character;
          } else if (code >= 0x40 && code <= 0x7e) {
            out.push({
              kind: 'csi',
              final: character,
              params: this.#finishParams(),
              prefix: this.#prefix,
              intermediates: this.#intermediates,
            });
            this.#clearParams();
            this.#state = 'ground';
          } else {
            this.#state = 'csi-ignore';
          }
          break;
        }

        case 'csi-ignore': {
          // Swallow to the final byte and emit nothing. A malformed CSI is
          // discarded whole; printing its tail is exactly how `1m` ends up
          // visible on screen.
          if (code >= 0x40 && code <= 0x7e) {
            this.#clearParams();
            this.#state = 'ground';
          }
          break;
        }

        case 'osc': {
          if (code === BEL) {
            out.push(this.#osc());
            this.#state = 'ground';
          } else if (code === ESC) {
            // Either ST (`ESC \`) or a new sequence starting inside an
            // unterminated OSC. Both end this one; which it was is decided by
            // the next character, in the escape state.
            out.push(this.#osc());
            this.#clearParams();
            this.#state = 'escape';
          } else {
            this.#collected += character;
          }
          break;
        }

        case 'string': {
          if (code === BEL) {
            out.push({ kind: 'string', opener: this.#opener, data: this.#collected });
            this.#collected = '';
            this.#state = 'ground';
          } else if (code === ESC) {
            out.push({ kind: 'string', opener: this.#opener, data: this.#collected });
            this.#collected = '';
            this.#clearParams();
            this.#state = 'escape';
          } else {
            this.#collected += character;
          }
          break;
        }
      }
    }

    // Printable text is emitted at the end of every chunk rather than held
    // until the next one. A partial ESCAPE is invisible garbage if it is wrong;
    // a withheld line is a terminal that looks hung. Only one of those is
    // recoverable, so text goes out and sequences wait.
    this.#flushText(out);
    return out;
  }
}

/** Parse a whole string in one go. For callers with no stream to hold. */
export function parseAnsi(text: string): AnsiEvent[] {
  return new AnsiParser().parse(text);
}

/**
 * True when `text` contains an ESC, i.e. when the ANSI path is needed at all.
 *
 * Not "contains a control character": a newline is content and every line of
 * every transcript in this repository has one. This is the cheap test a host
 * uses to decide whether a chunk can go straight to a text node.
 */
export function hasEscape(text: string): boolean {
  return text.includes('\u001b');
}

/**
 * The printable characters of `text`, with every escape sequence removed.
 *
 * This is what a screen reader must be given. An unstripped escape is read out
 * character by character — "escape bracket three one em" — which is why the
 * semantic renderer never puts raw input into the DOM.
 *
 * The executed controls survive as themselves, because a newline is content.
 * So this is not `hasEscape`'s inverse and does not claim to be.
 */
export function stripAnsi(text: string): string {
  let out = '';
  for (const event of parseAnsi(text)) {
    if (event.kind === 'text') out += event.text;
    else if (event.kind === 'execute') out += String.fromCharCode(event.code);
  }
  return out;
}
