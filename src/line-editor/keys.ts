/**
 * keys.ts — key events in, editor verbs out. No DOM anywhere.
 *
 * `EditorKeyEvent` is this project's own shape, not `KeyboardEvent`. That is the
 * whole point: the core must be runnable in `node --test`, and a `KeyboardEvent`
 * reference — even a type-only one — drags in `lib.dom` and quietly permits
 * someone to reach for `event.target` later.
 *
 * The field names are chosen to be a rename away from the DOM adapter's
 * (`ctrlKey` -> `ctrl`) so the mapping is obviously total, and `isComposing` is
 * carried through because v1's IME guard was a THREE-way test
 * (`e.isComposing || composing || e.keyCode === 229`) and losing any leg of it
 * breaks 注音 input. The adapter owns the `keyCode === 229` leg, which is a DOM
 * fact; the core honours the other two.
 *
 * Bindings are a plain `Record<chord, action>`. Swapping in a Vi set is
 * therefore a data change, and `KeyBindingEngine` has no idea which set it is
 * holding.
 */

import { graphemeLength } from './graphemes.ts';

export interface EditorKeyEvent {
  /**
   * A DOM `KeyboardEvent.key` VALUE (`'a'`, `'Enter'`, `'ArrowLeft'`) — the
   * vocabulary, not the type. Adapters for other input sources synthesise it.
   */
  readonly key: string;
  readonly ctrl?: boolean;
  readonly alt?: boolean;
  readonly shift?: boolean;
  readonly meta?: boolean;
  /** True while an IME is composing. Every binding is suppressed if so. */
  readonly isComposing?: boolean;
}

/**
 * The editor's verb vocabulary.
 *
 * A string union rather than an enum: `erasableSyntaxOnly` forbids enums, and
 * strings mean a binding table can be written as JSON and shipped as config.
 */
export type EditorAction =
  | 'self-insert'
  | 'accept-line'
  /** Ctrl+C: abandon the line, echoing it, as v1 did. */
  | 'cancel-line'
  /** Escape: clear the line but stay on it. */
  | 'revert-line'
  | 'clear-screen'
  | 'move-left'
  | 'move-right'
  | 'move-word-left'
  | 'move-word-right'
  | 'move-line-start'
  | 'move-line-end'
  | 'delete-backward'
  | 'delete-forward'
  | 'kill-to-line-end'
  | 'kill-to-line-start'
  | 'kill-word-left'
  | 'kill-word-right'
  | 'yank'
  | 'history-previous'
  | 'history-next'
  | 'history-search-backward'
  | 'complete'
  | 'complete-previous'
  | 'complete-accept'
  | 'complete-cancel'
  /** Take the whole ghost-text suggestion. */
  | 'accept-prediction'
  /** Take one word of it, the way PSReadLine's ForwardWord does in a suggestion. */
  | 'accept-prediction-word';

export type KeyBindingMap = Readonly<Record<string, EditorAction>>;

/** Keys whose name is a word rather than the character they produce. */
const NAMED_KEYS: ReadonlySet<string> = new Set([
  'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Insert',
  'Home', 'End', 'PageUp', 'PageDown',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'Unidentified', 'Process', 'Dead',
]);

/** Legacy and non-browser spellings, normalised so a binding table needs one entry. */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  Esc: 'Escape',
  Del: 'Delete',
  Ins: 'Insert',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Spacebar: ' ',
  Space: ' ',
  Return: 'Enter',
  Add: '+',
  Subtract: '-',
};

export function normalizeKey(key: string): string {
  return KEY_ALIASES[key] ?? key;
}

/** A key that produces text: exactly one visible character, and not a control code. */
export function isPrintableKey(key: string): boolean {
  const k = normalizeKey(key);
  if (NAMED_KEYS.has(k)) return false;
  if (k.length === 0) return false;
  // Control codes: Ctrl+letter arrives as key 'a' with ctrl set, never raw.
  if (/^[\u0000-\u001F\u007F]$/.test(k)) return false;
  return graphemeLength(k) === 1;
}

/**
 * The lookup key for a binding table.
 *
 * Shift is part of the chord only for NAMED keys. For a printable key the case
 * of `key` already encodes it, so folding Shift in as well would make `Shift+A`
 * and `A` different chords for the same physical result.
 *
 * A printable key carrying Ctrl/Alt/Meta is upper-cased, so `Ctrl+a` and
 * `Ctrl+A` are one chord — which is what every terminal means by Ctrl+A.
 */
export function chordOf(event: EditorKeyEvent): string {
  const key = normalizeKey(event.key);
  const named = NAMED_KEYS.has(key) || key.length > 1;
  const modified = event.ctrl === true || event.alt === true || event.meta === true;
  const parts: string[] = [];
  if (event.ctrl === true) parts.push('Ctrl');
  if (event.alt === true) parts.push('Alt');
  if (event.shift === true && named) parts.push('Shift');
  if (event.meta === true) parts.push('Meta');
  parts.push(named || modified ? (named ? key : key.toUpperCase()) : key);
  return parts.join('+');
}

/**
 * The Emacs set, which is PSReadLine's default on non-Windows and the one this
 * terminal's users are most likely to have in their fingers.
 *
 * v1 shipped exactly two of these (Ctrl+L, Ctrl+C) and no Alt bindings at all —
 * `altKey` was never read anywhere in its key handler — so everything below is
 * new capability rather than a port.
 */
export const EMACS_BINDINGS: KeyBindingMap = {
  Enter: 'accept-line',
  Tab: 'complete',
  'Shift+Tab': 'complete-previous',
  Escape: 'revert-line',
  Backspace: 'delete-backward',
  Delete: 'delete-forward',

  ArrowLeft: 'move-left',
  ArrowRight: 'move-right',
  ArrowUp: 'history-previous',
  ArrowDown: 'history-next',
  Home: 'move-line-start',
  End: 'move-line-end',
  'Ctrl+ArrowLeft': 'move-word-left',
  'Ctrl+ArrowRight': 'move-word-right',

  'Ctrl+A': 'move-line-start',
  'Ctrl+E': 'move-line-end',
  'Ctrl+B': 'move-left',
  'Ctrl+F': 'move-right',
  'Ctrl+H': 'delete-backward',
  'Ctrl+D': 'delete-forward',
  'Ctrl+K': 'kill-to-line-end',
  'Ctrl+U': 'kill-to-line-start',
  // PSReadLine's Emacs mode binds Ctrl+W to BackwardKillWord, which stops at any
  // word delimiter. bash binds it to unix-word-rubout, which stops only at
  // whitespace. PSReadLine wins here because the delimiter set makes it useful
  // on `Verb-Noun` names and on paths.
  'Ctrl+W': 'kill-word-left',
  'Ctrl+Y': 'yank',
  'Ctrl+P': 'history-previous',
  'Ctrl+N': 'history-next',
  'Ctrl+R': 'history-search-backward',
  'Ctrl+L': 'clear-screen',
  'Ctrl+C': 'cancel-line',
  'Ctrl+G': 'complete-cancel',

  'Alt+B': 'move-word-left',
  'Alt+F': 'move-word-right',
  'Alt+D': 'kill-word-right',
  'Alt+Backspace': 'kill-word-left',
};

export class KeyBindingEngine {
  readonly bindings: KeyBindingMap;

  constructor(bindings: KeyBindingMap = EMACS_BINDINGS) {
    this.bindings = bindings;
  }

  static emacs(): KeyBindingEngine {
    return new KeyBindingEngine(EMACS_BINDINGS);
  }

  /**
   * `null` means "no binding and not text" — the host may do what it likes with
   * the key, which is how v1's fall-through to the native textarea behaved.
   */
  resolve(event: EditorKeyEvent): EditorAction | null {
    const bound = this.bindings[chordOf(event)];
    if (bound !== undefined) return bound;
    // A modifier other than Shift means the user asked for a command, not text.
    if (event.ctrl === true || event.alt === true || event.meta === true) return null;
    return isPrintableKey(event.key) ? 'self-insert' : null;
  }

  /** A new engine with `overrides` layered on top. Bindings stay data. */
  with(overrides: KeyBindingMap): KeyBindingEngine {
    return new KeyBindingEngine({ ...this.bindings, ...overrides });
  }

  /** Every chord bound to `action`. Drives a `Get-PSReadLineKeyHandler`-style list. */
  chordsFor(action: EditorAction): string[] {
    return Object.keys(this.bindings).filter((chord) => this.bindings[chord] === action);
  }
}
