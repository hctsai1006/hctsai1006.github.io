/**
 * completion.ts — ranked candidates that know where the caret is standing.
 *
 * v1 had two completion contexts: "start of line or right after a pipe" and
 * "everything else". Everything else got the head command's parameter list, so
 * `Get-ChildItem -Path <TAB>` offered `-Recurse` — a parameter where a value
 * belongs — and `Get-Help Get-Ch<TAB>` fell back to the whole command corpus by
 * accident rather than by decision.
 *
 * There are four positions that behave differently, and the caret is always in
 * exactly one of them:
 *
 *   command          the first word of a pipeline segment
 *   parameter        a word starting `-`, which is not `-1`
 *   parameter-value  the word after a NON-SWITCH parameter
 *   argument         anything else — positional
 *
 * Telling `parameter-value` from `argument` needs one bit of metadata per
 * parameter (switch or not), which is exactly why the inventory exists and why
 * the manifests record `isSwitch` separately from a boolean type.
 *
 * Matching is prefix-first with a subsequence fallback, in that order and never
 * blended: a fuzzy hit must never displace something the user literally typed
 * the start of.
 */

import { manifestInventory, type CommandInventory } from './inventory.ts';
import type { TextBuffer } from './text-buffer.ts';
import { quoteIfNeeded, tokenize, type Token } from './tokenize.ts';

export type CompletionContextKind = 'command' | 'parameter' | 'parameter-value' | 'argument';

export interface CompletionContext {
  readonly kind: CompletionContextKind;
  /** The text being completed, unquoted. Empty when starting a fresh word. */
  readonly word: string;
  /** Code-unit offsets of the span a candidate replaces. */
  readonly replaceStart: number;
  readonly replaceEnd: number;
  /** Set when the caret is inside a quoted string, so candidates re-quote. */
  readonly quote: '"' | "'" | null;
  /** The command this pipeline segment invokes, as typed. Empty at command position. */
  readonly commandName: string;
  /** For `parameter-value`, the parameter awaiting a value, without dashes. */
  readonly parameterName: string | null;
  /** Zero-based index among positional arguments of this command. */
  readonly argumentIndex: number;
}

export type MatchKind = 'exact' | 'prefix' | 'prefix-ci' | 'fuzzy';

export interface CompletionCandidate {
  /** Exactly what to write over `[replaceStart, replaceEnd)`. Already quoted. */
  readonly text: string;
  /** What to show in the menu. */
  readonly display: string;
  readonly kind: 'command' | 'alias' | 'parameter' | 'argument';
  /** Synopsis, parameter type, or whatever the argument source supplied. */
  readonly detail: string;
  readonly matchKind: MatchKind;
  /** 0..1. Only comparable within a `matchKind`. */
  readonly score: number;
}

export interface CompletionResult {
  readonly context: CompletionContext;
  readonly candidates: readonly CompletionCandidate[];
}

/** One suggestion from the host, e.g. a filename from the virtual filesystem. */
export interface ArgumentSuggestion {
  readonly value: string;
  readonly detail?: string;
}

/**
 * How the host supplies arguments and parameter values.
 *
 * Injected rather than imported because the core must not know that a
 * filesystem, a theme list or a process table exists. This is v1's
 * `pathCandidates()` with the DOM and the global VFS taken out of it.
 */
export type ArgumentSource = (context: CompletionContext) => readonly ArgumentSuggestion[];

export interface CompletionEngineOptions {
  readonly inventory?: CommandInventory;
  readonly argumentSource?: ArgumentSource;
  /** Cap on returned candidates. The menu never shows more than a page anyway. */
  readonly limit?: number;
  /**
   * When an argument position produces nothing, offer command names.
   *
   * v1 did this by accident and it turned out to be right: the most common
   * argument in this shell is another command name (`Get-Help`, `Which`,
   * `Get-Command`). Kept, but as a decision rather than a fallthrough.
   */
  readonly commandFallback?: boolean;
}

const DEFAULT_LIMIT = 200;

/** Word-boundary characters, for scoring a fuzzy match's quality. */
const BOUNDARY = new Set(['-', '_', '.', ' ', '\\', '/', ':']);

/**
 * Greedy left-to-right subsequence match, scored on where the matches landed.
 *
 * Deliberately not optimal-alignment: "a simple fuzzy fallback" that a reader
 * can predict beats a scoring function nobody can reason about, and the tier
 * system means fuzzy only ever orders candidates that already failed prefix.
 */
export function fuzzyScore(candidate: string, query: string): number | null {
  if (query === '') return 0;
  const hay = candidate.toLowerCase();
  const needle = query.toLowerCase();
  let raw = 0;
  let at = 0;
  let previousMatch = -2;

  for (const ch of needle) {
    const found = hay.indexOf(ch, at);
    if (found < 0) return null;
    raw += 1;
    if (found === 0) raw += 3;
    else {
      const before = candidate[found - 1] ?? '';
      const here = candidate[found] ?? '';
      // A hit at a word start (`Get-|ChildItem`, `Child|Item`) is worth far more
      // than one in the middle of a word.
      if (BOUNDARY.has(before) || (before === before.toLowerCase() && here !== here.toLowerCase())) {
        raw += 2;
      }
    }
    if (found === previousMatch + 1) raw += 2;
    previousMatch = found;
    at = found + 1;
  }

  // Six is the per-character maximum (1 + 3 boundary-or-start + 2 contiguous).
  return raw / (needle.length * 6);
}

interface Match {
  readonly kind: MatchKind;
  readonly score: number;
}

const MATCH_RANK: Readonly<Record<MatchKind, number>> = {
  exact: 0,
  prefix: 1,
  'prefix-ci': 2,
  fuzzy: 3,
};

/** Prefix first, always; fuzzy only once prefix has failed. */
export function matchCandidate(candidate: string, query: string): Match | null {
  if (query === '') return { kind: 'prefix', score: 0 };
  if (candidate === query) return { kind: 'exact', score: 1 };
  if (candidate.startsWith(query)) return { kind: 'prefix', score: query.length / candidate.length };
  const lowerCandidate = candidate.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (lowerCandidate === lowerQuery) return { kind: 'exact', score: 1 };
  if (lowerCandidate.startsWith(lowerQuery)) {
    return { kind: 'prefix-ci', score: query.length / candidate.length };
  }
  const fuzzy = fuzzyScore(candidate, query);
  return fuzzy === null ? null : { kind: 'fuzzy', score: fuzzy };
}

/**
 * Which token the caret is completing, and what came before it.
 *
 * Follows v1's convention that a candidate replaces `[tokenStart, caret)` and
 * leaves the text right of the caret alone, because that is what makes editing
 * mid-line survive a completion.
 */
export function resolveCompletionContext(
  text: string,
  caret: number,
  inventory: CommandInventory,
): CompletionContext {
  const tokens = tokenize(text);

  let targetIndex = -1;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === undefined) continue;
    if (t.kind === 'separator' || t.kind === 'redirection') continue;
    // `caret > start` and not `>=`: a caret sitting at the very start of a token
    // is starting a new word, not editing that one.
    if (caret > t.start && caret <= t.end) {
      targetIndex = i;
      break;
    }
  }

  const target = targetIndex < 0 ? null : (tokens[targetIndex] ?? null);
  const replaceStart = target === null ? caret : target.start;
  const partial = text.slice(replaceStart, caret);
  const head = tokenize(partial)[0];
  const word = target === null ? '' : (head?.value ?? partial);
  const quote = target === null ? null : (head?.quote ?? null);

  // Everything in this pipeline segment that precedes the caret.
  const boundary = targetIndex < 0 ? tokens.length : targetIndex;
  let segmentStart = 0;
  for (let i = 0; i < boundary; i += 1) {
    if (tokens[i]?.kind === 'separator') segmentStart = i + 1;
  }
  const preceding: Token[] = [];
  for (let i = segmentStart; i < boundary; i += 1) {
    const t = tokens[i];
    if (t !== undefined && t.kind !== 'separator') preceding.push(t);
  }

  const commandToken = preceding.find((t) => t.kind === 'word');
  const commandName = commandToken?.value ?? '';

  const base = { word, replaceStart, replaceEnd: caret, quote, commandName };

  if (commandToken === undefined) {
    return { ...base, kind: 'command', commandName: '', parameterName: null, argumentIndex: 0 };
  }

  // `-`, `--` and `-Name` are parameters being typed; `-1` is a negative number.
  if (/^--?(?:[A-Za-z_].*)?$/.test(word)) {
    return { ...base, kind: 'parameter', parameterName: null, argumentIndex: 0 };
  }

  // Walk the segment deciding whether each word was consumed as a parameter
  // value or counted as a positional argument.
  let pending: string | null = null;
  let argumentIndex = 0;
  for (const t of preceding) {
    if (t === commandToken) continue;
    if (t.kind === 'parameter') {
      const name = t.value.replace(/^-+/, '');
      pending = inventory.isSwitch(commandName, name) ? null : name;
      continue;
    }
    if (t.kind === 'operator' || t.kind === 'redirection') {
      pending = null;
      continue;
    }
    if (pending !== null) pending = null;
    else argumentIndex += 1;
  }

  if (pending !== null) {
    return { ...base, kind: 'parameter-value', parameterName: pending, argumentIndex };
  }
  return { ...base, kind: 'argument', parameterName: null, argumentIndex };
}

export class CompletionEngine {
  readonly inventory: CommandInventory;
  readonly limit: number;
  readonly commandFallback: boolean;
  readonly #argumentSource: ArgumentSource | null;

  constructor(options: CompletionEngineOptions = {}) {
    this.inventory = options.inventory ?? manifestInventory();
    this.limit = options.limit ?? DEFAULT_LIMIT;
    this.commandFallback = options.commandFallback ?? true;
    this.#argumentSource = options.argumentSource ?? null;
  }

  complete(buffer: TextBuffer): CompletionResult {
    const context = resolveCompletionContext(buffer.text, buffer.caret, this.inventory);
    return { context, candidates: this.candidatesFor(context) };
  }

  /** Overwrite `[replaceStart, replaceEnd)` and park the caret after the insert. */
  applyTo(
    buffer: TextBuffer,
    context: CompletionContext,
    candidate: CompletionCandidate,
  ): TextBuffer {
    const text =
      buffer.text.slice(0, context.replaceStart) +
      candidate.text +
      buffer.text.slice(context.replaceEnd);
    return buffer.replace(text, context.replaceStart + candidate.text.length);
  }

  candidatesFor(context: CompletionContext): readonly CompletionCandidate[] {
    const collected =
      context.kind === 'command'
        ? this.#commandCandidates(context)
        : context.kind === 'parameter'
          ? this.#parameterCandidates(context)
          : this.#argumentCandidates(context);

    const hasQuery = context.word !== '';
    const sorted = [...collected].sort((a, b) => {
      const rank = MATCH_RANK[a.matchKind] - MATCH_RANK[b.matchKind];
      if (rank !== 0) return rank;
      if (b.score !== a.score) return b.score - a.score;
      // Shortest-first, then canonical-before-alias, only help when the user
      // typed something. On an empty query the only readable order is the
      // alphabetical one v1's CORPUS used.
      if (hasQuery) {
        if (a.display.length !== b.display.length) return a.display.length - b.display.length;
        if (a.kind !== b.kind) return a.kind === 'command' ? -1 : b.kind === 'command' ? 1 : 0;
      }
      const left = a.display.toLowerCase();
      const right = b.display.toLowerCase();
      return left < right ? -1 : left > right ? 1 : 0;
    });

    return sorted.slice(0, this.limit);
  }

  #commandCandidates(context: CompletionContext): CompletionCandidate[] {
    const out: CompletionCandidate[] = [];
    for (const entry of this.inventory.commands) {
      const m = matchCandidate(entry.name, context.word);
      if (m === null) continue;
      out.push({
        text: quoteIfNeeded(entry.name, context.quote),
        display: entry.name,
        kind: entry.kind,
        detail: entry.kind === 'alias' ? `-> ${entry.canonical}` : entry.synopsis,
        matchKind: m.kind,
        score: m.score,
      });
    }
    return out;
  }

  #parameterCandidates(context: CompletionContext): CompletionCandidate[] {
    const dashes = /^--/.test(context.word) ? '--' : '-';
    const typed = context.word.replace(/^-+/, '');
    const out: CompletionCandidate[] = [];
    // No fallback to command names here. v1 did that when a cmdlet was unknown,
    // which offered `Get-Date` as an answer to `-`; an empty menu is honest.
    for (const p of this.inventory.parametersOf(context.commandName)) {
      const m = matchCandidate(p.name, typed);
      if (m === null) continue;
      out.push({
        text: `${dashes}${p.name}`,
        display: `${dashes}${p.name}`,
        kind: 'parameter',
        detail: p.common ? 'common parameter' : p.type,
        matchKind: m.kind,
        score: m.score,
      });
    }
    return out;
  }

  #argumentCandidates(context: CompletionContext): CompletionCandidate[] {
    const supplied = this.#argumentSource === null ? [] : this.#argumentSource(context);
    const out: CompletionCandidate[] = [];
    for (const suggestion of supplied) {
      const m = matchCandidate(suggestion.value, context.word);
      if (m === null) continue;
      out.push({
        text: quoteIfNeeded(suggestion.value, context.quote),
        display: suggestion.value,
        kind: 'argument',
        detail: suggestion.detail ?? '',
        matchKind: m.kind,
        score: m.score,
      });
    }
    if (out.length === 0 && this.commandFallback && context.word !== '') {
      return this.#commandCandidates(context);
    }
    return out;
  }
}
