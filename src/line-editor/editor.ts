/**
 * editor.ts — the state machine the adapters drive.
 *
 * This is the object v1's `onKey` + `sync` + `openOrCycle` + `histNav` +
 * `predict` collectively were, with the DOM taken out. It owns the composition
 * of the five engines and the transient modes they imply (a completion menu is
 * open, a reverse search is running, history navigation is in progress) —
 * exactly the state v1 kept in loose module-level variables that could and did
 * fall out of step with each other.
 *
 * Every method is synchronous and every input is explicit. The clock is
 * injected, geometry is injected, and nothing here has heard of a `document`.
 *
 * IME: `setComposing(true)` makes the editor inert. That is v1's behaviour and
 * it is not a detail — during 注音 composition, Enter is candidate confirmation,
 * ArrowUp/ArrowDown page the candidate list and Tab is the IME's, so intercepting
 * any of them breaks the input method. The adapter owns the DOM half of the
 * triple guard (`e.keyCode === 229`); this owns the other two, honouring both a
 * per-event `isComposing` flag and the sticky `setComposing` state, because v1
 * proved that on old Safari and some Android IMEs neither is reliable alone.
 */

import { CompletionEngine, type CompletionCandidate, type CompletionContext } from './completion.ts';
import {
  DEFAULT_NAVIGATION_ORIGINS,
  HistoryEngine,
  type HistoryEntry,
  type HistoryOrigin,
} from './history.ts';
import { KeyBindingEngine, isPrintableKey, normalizeKey, type EditorAction, type EditorKeyEvent } from './keys.ts';
import { DEFAULT_METRICS, type TerminalMetrics } from './metrics.ts';
import { PredictionEngine, type Prediction } from './prediction.ts';
import { TextBuffer } from './text-buffer.ts';

export interface CompletionMenuView {
  readonly candidates: readonly CompletionCandidate[];
  readonly index: number;
  /** How many rows the injected metrics allow, so the host need not decide. */
  readonly pageSize: number;
}

export interface ReverseSearchView {
  readonly needle: string;
  readonly index: number;
  readonly count: number;
  /** True when the needle matches nothing — render the prompt as failing. */
  readonly failed: boolean;
}

/** Everything a renderer needs, and nothing it can use to reach back in. */
export interface LineEditorView {
  readonly text: string;
  /** UTF-16 code-unit offset, always on a grapheme boundary. */
  readonly caret: number;
  /** Display cells before the caret, via the injected metrics. */
  readonly caretColumn: number;
  /** Ghost text to draw after the caret. Empty when suppressed. */
  readonly prediction: string;
  readonly menu: CompletionMenuView | null;
  readonly search: ReverseSearchView | null;
  readonly composing: boolean;
}

export type EditorEffect =
  | { readonly kind: 'none' }
  /** The IME owns this key. The host must not preventDefault. */
  | { readonly kind: 'composing' }
  /** No binding and not text. The host may do as it likes. */
  | { readonly kind: 'unhandled'; readonly event: EditorKeyEvent }
  /** The action was understood but could not do anything. */
  | { readonly kind: 'bell'; readonly action: EditorAction }
  | { readonly kind: 'submit'; readonly line: string; readonly entry: HistoryEntry | null }
  | { readonly kind: 'cancel'; readonly line: string }
  | { readonly kind: 'clear-screen' };

export interface LineEditorOptions {
  readonly history?: HistoryEngine;
  readonly completion?: CompletionEngine;
  readonly keys?: KeyBindingEngine;
  readonly prediction?: PredictionEngine;
  readonly metrics?: TerminalMetrics;
  /** Injected so ranking and history timestamps are reproducible in tests. */
  readonly clock?: () => number;
  readonly cwd?: string;
  readonly compatibilityProfile?: string;
  /**
   * Which origins Up/Down arrow will walk. Defaults to everything except `ai`,
   * so an agent's commands stay out of the user's muscle memory.
   */
  readonly navigationOrigins?: readonly HistoryOrigin[];
  /** Make Up/Down filter by the text already typed, like PSReadLine's F8. */
  readonly historyPrefixSearch?: boolean;
  readonly wordDelimiters?: string;
}

interface MenuState {
  readonly candidates: readonly CompletionCandidate[];
  readonly context: CompletionContext;
  /** The buffer as it was before the menu opened, for Escape. */
  readonly saved: TextBuffer;
  index: number;
}

interface SearchState {
  needle: string;
  matches: readonly HistoryEntry[];
  index: number;
  readonly saved: TextBuffer;
}

export class LineEditor {
  readonly history: HistoryEngine;
  readonly completion: CompletionEngine;
  readonly keys: KeyBindingEngine;
  readonly predictions: PredictionEngine;
  readonly metrics: TerminalMetrics;

  #buffer: TextBuffer;
  #composing = false;
  #menu: MenuState | null = null;
  #search: SearchState | null = null;
  /** Index into `history.entries`, or null when not navigating. */
  #historyIndex: number | null = null;
  /** The in-progress line, parked while history navigation borrows the buffer. */
  #draft: TextBuffer | null = null;
  #historyPrefix = '';
  #kill = '';
  /** Whether the line about to be submitted came out of the completion menu. */
  #usedCompletion = false;

  readonly #clock: () => number;
  readonly #navigationOrigins: readonly HistoryOrigin[];
  readonly #historyPrefixSearch: boolean;
  #cwd: string;
  #profile: string;

  constructor(options: LineEditorOptions = {}) {
    this.history = options.history ?? new HistoryEngine();
    this.completion = options.completion ?? new CompletionEngine();
    this.keys = options.keys ?? KeyBindingEngine.emacs();
    this.predictions =
      options.prediction ??
      new PredictionEngine(this.history, {
        corpus: this.completion.inventory.commands.map((c) => c.name),
      });
    this.metrics = options.metrics ?? DEFAULT_METRICS;
    this.#clock = options.clock ?? Date.now;
    this.#cwd = options.cwd ?? '/';
    this.#profile = options.compatibilityProfile ?? '';
    this.#navigationOrigins = options.navigationOrigins ?? DEFAULT_NAVIGATION_ORIGINS;
    this.#historyPrefixSearch = options.historyPrefixSearch ?? false;
    this.#buffer =
      options.wordDelimiters === undefined
        ? TextBuffer.empty()
        : TextBuffer.empty(options.wordDelimiters);
  }

  // -------------------------------------------------------------------- state

  get buffer(): TextBuffer {
    return this.#buffer;
  }

  get composing(): boolean {
    return this.#composing;
  }

  get cwd(): string {
    return this.#cwd;
  }

  setCwd(cwd: string): void {
    this.#cwd = cwd;
  }

  setCompatibilityProfile(profile: string): void {
    this.#profile = profile;
  }

  /** Replace the whole line, e.g. when the host restores a session. */
  setBuffer(buffer: TextBuffer): void {
    this.#buffer = buffer;
    this.#resetTransientState();
  }

  /**
   * Tell the core an IME composition started or ended.
   *
   * While it is true, prediction and completion are suppressed and every key is
   * handed back — the grey suggestion must not shadow the pre-edit string, and
   * the completion menu must not eat the candidate-selection keys.
   */
  setComposing(active: boolean): void {
    this.#composing = active;
    // v1 closed the menu on compositionstart for the same reason: the IME is
    // about to take ArrowUp/ArrowDown/Enter, which are the menu's keys too.
    if (active) this.#menu = null;
  }

  get view(): LineEditorView {
    const prediction = this.#currentPrediction();
    return {
      text: this.#buffer.text,
      caret: this.#buffer.caret,
      caretColumn: this.#caretColumn(),
      prediction: prediction?.completion ?? '',
      menu:
        this.#menu === null
          ? null
          : {
              candidates: this.#menu.candidates,
              index: this.#menu.index,
              pageSize: Math.max(1, this.metrics.rows - 2),
            },
      search:
        this.#search === null
          ? null
          : {
              needle: this.#search.needle,
              index: this.#search.index,
              count: this.#search.matches.length,
              failed: this.#search.matches.length === 0 && this.#search.needle !== '',
            },
      composing: this.#composing,
    };
  }

  // ------------------------------------------------------------------- input

  /** The IME commit path, and the paste path. Never a key. */
  insertText(text: string): void {
    if (text === '') return;
    this.#buffer = this.#buffer.insert(text);
    this.#afterEdit();
  }

  handleKey(event: EditorKeyEvent): EditorEffect {
    // Both legs of the guard the core owns. The adapter owns `keyCode === 229`.
    if (this.#composing || event.isComposing === true) return { kind: 'composing' };

    const action = this.keys.resolve(event);
    if (action === null) return { kind: 'unhandled', event };
    return this.perform(action, event);
  }

  /** Run an action directly. Exposed so a host can bind gestures of its own. */
  perform(action: EditorAction, event?: EditorKeyEvent): EditorEffect {
    if (this.#search !== null) {
      const handled = this.#searchAction(action, event);
      if (handled !== null) return handled;
    }
    if (this.#menu !== null) {
      const handled = this.#menuAction(action);
      if (handled !== null) return handled;
      // v1's rule: any other key closes the menu, keeping what it applied, and
      // then behaves normally.
      this.#menu = null;
    }
    return this.#editAction(action, event);
  }

  // ------------------------------------------------------------ edit actions

  #editAction(action: EditorAction, event?: EditorKeyEvent): EditorEffect {
    const before = this.#buffer;

    switch (action) {
      case 'self-insert': {
        const key = event === undefined ? '' : normalizeKey(event.key);
        if (key === '' || !isPrintableKey(key)) return { kind: 'unhandled', event: event ?? { key } };
        this.#buffer = this.#buffer.insert(key);
        this.#afterEdit();
        return { kind: 'none' };
      }

      case 'accept-line':
        return this.submit();

      case 'cancel-line': {
        const line = this.#buffer.text;
        this.#buffer = this.#buffer.replace('');
        this.#resetTransientState();
        return { kind: 'cancel', line };
      }

      case 'revert-line':
        if (this.#buffer.isEmpty) return { kind: 'unhandled', event: event ?? { key: 'Escape' } };
        this.#buffer = this.#buffer.replace('');
        this.#usedCompletion = false;
        this.#afterEdit();
        return { kind: 'none' };

      case 'clear-screen':
        return { kind: 'clear-screen' };

      case 'move-left':
        this.#buffer = this.#buffer.moveLeft();
        break;

      case 'move-right':
      case 'accept-prediction': {
        const taken = this.#acceptPrediction('all');
        if (taken) return { kind: 'none' };
        if (action === 'accept-prediction') return { kind: 'bell', action };
        this.#buffer = this.#buffer.moveRight();
        break;
      }

      case 'move-line-end': {
        // v1 accepted the suggestion from End as well as ArrowRight, but only
        // when the caret was already at the end — so mid-line End just moves.
        if (this.#buffer.atEnd && this.#acceptPrediction('all')) return { kind: 'none' };
        this.#buffer = this.#buffer.moveToLineEnd();
        break;
      }

      case 'move-word-right':
      case 'accept-prediction-word': {
        const taken = this.#acceptPrediction('word');
        if (taken) return { kind: 'none' };
        if (action === 'accept-prediction-word') return { kind: 'bell', action };
        this.#buffer = this.#buffer.moveWordRight();
        break;
      }

      case 'move-word-left':
        this.#buffer = this.#buffer.moveWordLeft();
        break;

      case 'move-line-start':
        this.#buffer = this.#buffer.moveToLineStart();
        break;

      case 'delete-backward':
        this.#buffer = this.#buffer.deleteBackward();
        this.#afterEdit();
        break;

      case 'delete-forward':
        this.#buffer = this.#buffer.deleteForward();
        this.#afterEdit();
        break;

      case 'kill-to-line-end':
        this.#kill = this.#buffer.slice(this.#buffer.caret, this.#buffer.offsetLineEnd());
        this.#buffer = this.#buffer.deleteToLineEnd();
        this.#afterEdit();
        break;

      case 'kill-to-line-start':
        this.#kill = this.#buffer.slice(this.#buffer.offsetLineStart(), this.#buffer.caret);
        this.#buffer = this.#buffer.deleteToLineStart();
        this.#afterEdit();
        break;

      case 'kill-word-left':
        this.#kill = this.#buffer.slice(this.#buffer.offsetWordLeft(), this.#buffer.caret);
        this.#buffer = this.#buffer.deleteWordLeft();
        this.#afterEdit();
        break;

      case 'kill-word-right':
        this.#kill = this.#buffer.slice(this.#buffer.caret, this.#buffer.offsetWordRight());
        this.#buffer = this.#buffer.deleteWordRight();
        this.#afterEdit();
        break;

      case 'yank':
        if (this.#kill === '') return { kind: 'bell', action };
        this.#buffer = this.#buffer.insert(this.#kill);
        this.#afterEdit();
        break;

      case 'history-previous':
        return this.#historyBack();

      case 'history-next':
        return this.#historyForward();

      case 'history-search-backward':
        return this.#beginSearch();

      case 'complete':
      case 'complete-previous':
        return this.#openOrCycle(action === 'complete' ? 1 : -1);

      case 'complete-accept':
      case 'complete-cancel':
        // Only meaningful while a menu is open; `perform` already handled that.
        return { kind: 'bell', action };
    }

    return before === this.#buffer && action.startsWith('move-')
      ? { kind: 'bell', action }
      : { kind: 'none' };
  }

  // ---------------------------------------------------------------- submitting

  /** Accept the line: append it to history with full provenance, then clear. */
  submit(origin?: HistoryOrigin): EditorEffect {
    const line = this.#buffer.text;
    const entry = this.history.append({
      source: line,
      cwd: this.#cwd,
      compatibilityProfile: this.#profile,
      origin: origin ?? (this.#usedCompletion ? 'completion' : 'user'),
      exitCode: null,
      durationMs: null,
      createdAt: this.#clock(),
    });
    this.#buffer = this.#buffer.replace('');
    this.#resetTransientState();
    return { kind: 'submit', line, entry };
  }

  // ------------------------------------------------------------------ history

  #historyBack(): EditorEffect {
    if (this.#historyIndex === null) {
      this.#draft = this.#buffer;
      this.#historyPrefix = this.#historyPrefixSearch ? this.#buffer.before : '';
      this.#historyIndex = this.history.entries.length;
    }
    const found = this.history.previousIndex(
      this.#historyIndex,
      this.#historyPrefix,
      this.#navigationOrigins,
    );
    if (found < 0) return { kind: 'bell', action: 'history-previous' };
    this.#historyIndex = found;
    const entry = this.history.entries[found];
    this.#buffer = this.#buffer.replace(entry?.source ?? '');
    this.#usedCompletion = false;
    return { kind: 'none' };
  }

  #historyForward(): EditorEffect {
    if (this.#historyIndex === null) return { kind: 'bell', action: 'history-next' };
    const found = this.history.nextIndex(
      this.#historyIndex,
      this.#historyPrefix,
      this.#navigationOrigins,
    );
    if (found < 0) {
      // Past the newest entry: give back the line that was being typed. v1 kept
      // a `draft` string for this but never cleared it on the typing path, so a
      // stale draft could reappear a command later.
      this.#buffer = this.#draft ?? this.#buffer.replace('');
      this.#historyIndex = null;
      this.#draft = null;
      return { kind: 'none' };
    }
    this.#historyIndex = found;
    const entry = this.history.entries[found];
    this.#buffer = this.#buffer.replace(entry?.source ?? '');
    this.#usedCompletion = false;
    return { kind: 'none' };
  }

  // ----------------------------------------------------------- reverse search

  #beginSearch(): EditorEffect {
    this.#search = { needle: '', matches: [], index: 0, saved: this.#buffer };
    return { kind: 'none' };
  }

  /**
   * Returns null when the action is not the search's business, so `perform`
   * falls through to the normal handler.
   *
   * The match list is RANKED, not chronological. bash steps backwards through
   * time; here the first hit is the best-ranked one, which is the whole reason
   * the ranking exists. The order is still stable for a given needle, so
   * pressing Ctrl+R repeatedly walks a fixed list.
   */
  #searchAction(action: EditorAction, event?: EditorKeyEvent): EditorEffect | null {
    const search = this.#search;
    if (search === null) return null;

    switch (action) {
      case 'history-search-backward':
        if (search.matches.length === 0) return { kind: 'bell', action };
        search.index = (search.index + 1) % search.matches.length;
        this.#applySearchMatch();
        return { kind: 'none' };

      case 'self-insert': {
        const key = event === undefined ? '' : normalizeKey(event.key);
        if (key === '' || !isPrintableKey(key)) return { kind: 'unhandled', event: event ?? { key } };
        search.needle += key;
        this.#refreshSearch();
        return { kind: 'none' };
      }

      case 'delete-backward':
        if (search.needle === '') return { kind: 'bell', action };
        search.needle = search.needle.slice(0, -1);
        this.#refreshSearch();
        return { kind: 'none' };

      case 'revert-line':
      case 'complete-cancel':
      case 'cancel-line':
        this.#buffer = search.saved;
        this.#search = null;
        return { kind: 'none' };

      case 'accept-line':
        // Accept the found line into the buffer; a second Enter runs it. Making
        // one Enter do both would execute a command the user only glimpsed.
        this.#search = null;
        return { kind: 'none' };

      default:
        // Any other editing action leaves search mode with the match kept.
        this.#search = null;
        return null;
    }
  }

  #refreshSearch(): void {
    const search = this.#search;
    if (search === null) return;
    search.matches =
      search.needle === ''
        ? []
        : this.history
            .recall({ now: this.#clock(), contains: search.needle, cwd: this.#cwd, limit: 50 })
            .map((m) => m.entry);
    search.index = 0;
    this.#applySearchMatch();
  }

  #applySearchMatch(): void {
    const search = this.#search;
    if (search === null) return;
    const match = search.matches[search.index];
    this.#buffer = match === undefined ? search.saved : search.saved.replace(match.source);
  }

  // --------------------------------------------------------------- completion

  #openOrCycle(direction: 1 | -1): EditorEffect {
    const result = this.completion.complete(this.#buffer);
    if (result.candidates.length === 0) return { kind: 'bell', action: 'complete' };

    const first = result.candidates[0];
    if (result.candidates.length === 1 && first !== undefined) {
      this.#buffer = this.completion.applyTo(this.#buffer, result.context, first);
      this.#usedCompletion = true;
      this.#historyIndex = null;
      this.#draft = null;
      return { kind: 'none' };
    }

    const index = direction === 1 ? 0 : result.candidates.length - 1;
    this.#menu = {
      candidates: result.candidates,
      context: result.context,
      saved: this.#buffer,
      index,
    };
    this.#applyMenuSelection();
    return { kind: 'none' };
  }

  #menuAction(action: EditorAction): EditorEffect | null {
    const menu = this.#menu;
    if (menu === null) return null;

    switch (action) {
      case 'complete':
      case 'history-next':
        menu.index = (menu.index + 1) % menu.candidates.length;
        this.#applyMenuSelection();
        return { kind: 'none' };

      case 'complete-previous':
      case 'history-previous':
        menu.index = (menu.index - 1 + menu.candidates.length) % menu.candidates.length;
        this.#applyMenuSelection();
        return { kind: 'none' };

      case 'complete-accept':
      case 'accept-line':
        // v1 and PSReadLine agree: Enter takes the highlighted candidate and
        // closes the menu WITHOUT running the line. Two Enters to execute.
        this.#menu = null;
        return { kind: 'none' };

      case 'complete-cancel':
      case 'revert-line':
        this.#buffer = menu.saved;
        this.#menu = null;
        // A rejected completion did not contribute to the line, so it must not
        // colour the provenance of whatever is submitted next.
        this.#usedCompletion = false;
        return { kind: 'none' };

      default:
        return null;
    }
  }

  /**
   * Always rebuilds from the pre-menu buffer.
   *
   * v1 re-derived the caret from the already-mutated buffer on every cycle and
   * only worked because `setVal` happened to park the caret at
   * `start + pick.length`. Replaying from the saved state cannot drift.
   */
  #applyMenuSelection(): void {
    const menu = this.#menu;
    if (menu === null) return;
    const candidate = menu.candidates[menu.index];
    if (candidate === undefined) return;
    this.#buffer = this.completion.applyTo(menu.saved, menu.context, candidate);
    this.#usedCompletion = true;
    this.#historyIndex = null;
    this.#draft = null;
  }

  // --------------------------------------------------------------- prediction

  /**
   * v1's gate, preserved exactly: `!composing && atEnd() && !menu.open`.
   * Reverse search is added because its buffer is on loan from history.
   */
  #currentPrediction(): Prediction | null {
    if (this.#composing || this.#menu !== null || this.#search !== null) return null;
    if (!this.#buffer.atEnd) return null;
    return this.predictions.predict(this.#buffer.text, { now: this.#clock(), cwd: this.#cwd });
  }

  #acceptPrediction(amount: 'all' | 'word'): boolean {
    if (!this.#buffer.atEnd) return false;
    const prediction = this.#currentPrediction();
    if (prediction === null || prediction.completion === '') return false;
    const take =
      amount === 'all' ? prediction.completion : PredictionEngine.firstWordOf(prediction.completion);
    this.#buffer = this.#buffer.insert(take);
    this.#afterEdit();
    return true;
  }

  // ------------------------------------------------------------------ private

  #caretColumn(): number {
    let column = 0;
    const graphemes = this.#buffer.graphemes;
    const upto = this.#buffer.caretGraphemeIndex;
    for (let i = 0; i < upto; i += 1) column += this.metrics.cellWidth(graphemes[i] ?? '');
    return column;
  }

  /** Every edit detaches from history navigation and closes the menu. */
  #afterEdit(): void {
    this.#menu = null;
    this.#historyIndex = null;
    this.#draft = null;
  }

  #resetTransientState(): void {
    this.#menu = null;
    this.#search = null;
    this.#historyIndex = null;
    this.#draft = null;
    this.#historyPrefix = '';
    this.#usedCompletion = false;
  }
}
