/**
 * Tests for key binding resolution and the editor state machine.
 *
 * The IME suite is the one that matters most. v1's key handler opened with
 * `if (e.isComposing || composing || e.keyCode === 229) return;` and a comment
 * explaining that during 注音 composition Enter is candidate confirmation and
 * ArrowUp/ArrowDown page the candidate list, so intercepting any key breaks the
 * input method. The roadmap names this the highest-regression area of the whole
 * extraction. Two of the three legs of that guard live in the core, and these
 * tests hold them.
 *
 * No `KeyboardEvent` appears anywhere: the events are plain objects, which is
 * the point of owning the interface.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CompletionEngine } from '../../src/line-editor/completion.ts';
import { LineEditor, type EditorEffect } from '../../src/line-editor/editor.ts';
import { HistoryEngine, type HistoryOrigin } from '../../src/line-editor/history.ts';
import {
  chordOf,
  EMACS_BINDINGS,
  isPrintableKey,
  KeyBindingEngine,
  normalizeKey,
  type EditorKeyEvent,
  type KeyBindingMap,
} from '../../src/line-editor/keys.ts';
import { monospaceMetrics } from '../../src/line-editor/metrics.ts';

const NOW = Date.UTC(2026, 8, 5, 12, 0, 0);

function makeEditor(options: { history?: HistoryEngine } = {}): LineEditor {
  const history = options.history ?? new HistoryEngine();
  return new LineEditor({
    history,
    clock: () => NOW,
    cwd: '/home/thc1006',
    compatibilityProfile: '7.6.5',
    metrics: monospaceMetrics(80, 24),
  });
}

/** Type a run of characters as individual key events, the way a user does. */
function type(editor: LineEditor, text: string): void {
  for (const ch of text) editor.handleKey({ key: ch });
}

function seed(history: HistoryEngine, source: string, origin: HistoryOrigin = 'user'): void {
  history.append({
    source,
    cwd: '/home/thc1006',
    compatibilityProfile: '7.6.5',
    origin,
    exitCode: 0,
    durationMs: 5,
    createdAt: NOW - 60_000,
  });
}

describe('chords', () => {
  it('folds the case of a printable key that carries a modifier', () => {
    // Ctrl+a and Ctrl+A are the same gesture; a binding table must not need both.
    assert.equal(chordOf({ key: 'a', ctrl: true }), 'Ctrl+A');
    assert.equal(chordOf({ key: 'A', ctrl: true }), 'Ctrl+A');
    assert.equal(chordOf({ key: 'b', alt: true }), 'Alt+B');
  });

  it('folds Shift into the chord only for named keys', () => {
    // For a printable key the case already encodes Shift, so including it would
    // make `Shift+A` and `A` different chords for the same character.
    assert.equal(chordOf({ key: 'A', shift: true }), 'A');
    assert.equal(chordOf({ key: 'a' }), 'a');
    assert.equal(chordOf({ key: 'Tab', shift: true }), 'Shift+Tab');
    assert.equal(chordOf({ key: 'ArrowLeft', ctrl: true }), 'Ctrl+ArrowLeft');
    assert.equal(chordOf({ key: 'Backspace', alt: true }), 'Alt+Backspace');
  });

  it('normalises legacy key spellings', () => {
    assert.equal(normalizeKey('Esc'), 'Escape');
    assert.equal(normalizeKey('Left'), 'ArrowLeft');
    assert.equal(normalizeKey('Spacebar'), ' ');
    assert.equal(chordOf({ key: 'Del', ctrl: true }), 'Ctrl+Delete');
  });

  it('knows which keys produce text', () => {
    assert.equal(isPrintableKey('a'), true);
    assert.equal(isPrintableKey(' '), true);
    assert.equal(isPrintableKey('測'), true);
    assert.equal(isPrintableKey('\u{1F44D}'), true, 'one emoji is one printable key');
    assert.equal(isPrintableKey('Enter'), false);
    assert.equal(isPrintableKey('ArrowLeft'), false);
    assert.equal(isPrintableKey('ab'), false);
    assert.equal(isPrintableKey(''), false);
  });
});

describe('key bindings', () => {
  const keys = KeyBindingEngine.emacs();

  it('binds the Emacs set the task asked for', () => {
    assert.equal(keys.resolve({ key: 'a', ctrl: true }), 'move-line-start');
    assert.equal(keys.resolve({ key: 'e', ctrl: true }), 'move-line-end');
    assert.equal(keys.resolve({ key: 'k', ctrl: true }), 'kill-to-line-end');
    assert.equal(keys.resolve({ key: 'u', ctrl: true }), 'kill-to-line-start');
    assert.equal(keys.resolve({ key: 'w', ctrl: true }), 'kill-word-left');
    assert.equal(keys.resolve({ key: 'b', alt: true }), 'move-word-left');
    assert.equal(keys.resolve({ key: 'f', alt: true }), 'move-word-right');
    assert.equal(keys.resolve({ key: 'r', ctrl: true }), 'history-search-backward');
  });

  it('treats an unbound printable key as text, and an unbound chord as nobody business', () => {
    assert.equal(keys.resolve({ key: 'x' }), 'self-insert');
    assert.equal(keys.resolve({ key: '測' }), 'self-insert');
    assert.equal(keys.resolve({ key: 'X', shift: true }), 'self-insert');
    assert.equal(keys.resolve({ key: 'q', alt: true }), null, 'a modified key is a command or nothing');
    assert.equal(keys.resolve({ key: 'F5' }), null);
  });

  it('is data: a Vi-style set is a different object, not a different class', () => {
    const viCommandMode: KeyBindingMap = {
      h: 'move-left',
      l: 'move-right',
      w: 'move-word-right',
      b: 'move-word-left',
      x: 'delete-forward',
      D: 'kill-to-line-end',
      Escape: 'complete-cancel',
    };
    const vi = new KeyBindingEngine(viCommandMode);
    assert.equal(vi.resolve({ key: 'h' }), 'move-left');
    assert.equal(vi.resolve({ key: 'w' }), 'move-word-right');
    assert.equal(vi.resolve({ key: 'a', ctrl: true }), null, 'the Emacs set is gone');
    assert.equal(keys.resolve({ key: 'h' }), 'self-insert', 'and the original is untouched');
  });

  it('layers overrides without mutating the base table', () => {
    const custom = keys.with({ 'Ctrl+W': 'kill-word-right' });
    assert.equal(custom.resolve({ key: 'w', ctrl: true }), 'kill-word-right');
    assert.equal(keys.resolve({ key: 'w', ctrl: true }), 'kill-word-left');
    assert.equal(EMACS_BINDINGS['Ctrl+W'], 'kill-word-left');
    assert.deepEqual(keys.chordsFor('move-word-left').sort(), ['Alt+B', 'Ctrl+ArrowLeft']);
  });
});

describe('IME composition', () => {
  it('hands every key back while a composition is in progress', () => {
    // 注音 uses Enter to commit, ArrowUp/ArrowDown to page candidates and the
    // number row to pick one. Intercepting any of them breaks the IME.
    const editor = makeEditor();
    editor.setComposing(true);
    const keys: EditorKeyEvent[] = [
      { key: 'Enter' },
      { key: 'ArrowUp' },
      { key: 'ArrowDown' },
      { key: 'Tab' },
      { key: 'Escape' },
      { key: '1' },
      { key: 'l', ctrl: true },
      { key: 'c', ctrl: true },
    ];
    for (const event of keys) {
      assert.deepEqual(editor.handleKey(event), { kind: 'composing' }, JSON.stringify(event));
    }
    assert.equal(editor.view.text, '', 'nothing reached the buffer');
  });

  it('honours a per-event isComposing flag as well as the sticky one', () => {
    // v1 kept both because neither is reliable alone: `isComposing` misbehaves on
    // old Safari and some Android IMEs, and the event flag can arrive without a
    // compositionstart. The third leg (keyCode === 229) belongs to the adapter.
    const editor = makeEditor();
    assert.deepEqual(editor.handleKey({ key: 'a', isComposing: true }), { kind: 'composing' });
    assert.equal(editor.view.text, '');
    editor.handleKey({ key: 'a' });
    assert.equal(editor.view.text, 'a');
  });

  it('suppresses the ghost suggestion so it cannot shadow the pre-edit string', () => {
    const history = new HistoryEngine();
    seed(history, 'Get-ChildItem -Recurse');
    const editor = makeEditor({ history });
    type(editor, 'Get-');
    assert.notEqual(editor.view.prediction, '', 'there is something to suppress');

    editor.setComposing(true);
    assert.equal(editor.view.prediction, '');
    assert.equal(editor.view.composing, true);

    editor.setComposing(false);
    assert.notEqual(editor.view.prediction, '');
  });

  it('closes the completion menu when composition starts', () => {
    // The IME is about to take ArrowUp/ArrowDown/Enter, which are also the
    // menu's keys. v1 did this in its compositionstart handler.
    const editor = makeEditor();
    type(editor, 'Get-C');
    editor.handleKey({ key: 'Tab' });
    assert.notEqual(editor.view.menu, null);
    editor.setComposing(true);
    assert.equal(editor.view.menu, null);
  });

  it('accepts the committed string through insertText', () => {
    const editor = makeEditor();
    editor.setComposing(true);
    editor.setComposing(false);
    editor.insertText('測試');
    assert.equal(editor.view.text, '測試');
    assert.equal(editor.view.caret, 2);
    assert.equal(editor.view.caretColumn, 4, 'two cells each, via the injected metrics');
  });
});

describe('editing', () => {
  it('inserts, deletes and moves by the Emacs chords', () => {
    const editor = makeEditor();
    type(editor, 'Get-ChildItem');
    assert.equal(editor.view.text, 'Get-ChildItem');

    editor.handleKey({ key: 'a', ctrl: true });
    assert.equal(editor.view.caret, 0);
    editor.handleKey({ key: 'e', ctrl: true });
    assert.equal(editor.view.caret, 13);

    editor.handleKey({ key: 'b', alt: true });
    assert.equal(editor.view.caret, 4, 'Alt+B stops at ChildItem');
    editor.handleKey({ key: 'b', alt: true });
    assert.equal(editor.view.caret, 0);
    editor.handleKey({ key: 'f', alt: true });
    assert.equal(editor.view.caret, 3);
  });

  it('kills into a slot that Ctrl+Y gives back', () => {
    const editor = makeEditor();
    type(editor, 'Get-ChildItem -Recurse');
    editor.handleKey({ key: 'w', ctrl: true });
    assert.equal(editor.view.text, 'Get-ChildItem -');
    editor.handleKey({ key: 'y', ctrl: true });
    assert.equal(editor.view.text, 'Get-ChildItem -Recurse');

    editor.handleKey({ key: 'a', ctrl: true });
    editor.handleKey({ key: 'k', ctrl: true });
    assert.equal(editor.view.text, '');
    editor.handleKey({ key: 'y', ctrl: true });
    assert.equal(editor.view.text, 'Get-ChildItem -Recurse');

    editor.handleKey({ key: 'u', ctrl: true });
    assert.equal(editor.view.text, '', 'Ctrl+U kills back to the line start');
  });

  it('types emoji and CJK without splitting them', () => {
    const editor = makeEditor();
    editor.handleKey({ key: '\u{1F44D}' });
    editor.handleKey({ key: '測' });
    assert.equal(editor.view.text, '\u{1F44D}測');
    editor.handleKey({ key: 'Backspace' });
    editor.handleKey({ key: 'Backspace' });
    assert.equal(editor.view.text, '', 'two presses, two visible characters');
  });

  it('rings the bell when a motion cannot move', () => {
    const editor = makeEditor();
    const effect: EditorEffect = editor.handleKey({ key: 'ArrowLeft' });
    assert.deepEqual(effect, { kind: 'bell', action: 'move-left' });
    assert.deepEqual(editor.handleKey({ key: 'y', ctrl: true }), { kind: 'bell', action: 'yank' });
  });

  it('reports an unbound key rather than swallowing it', () => {
    const editor = makeEditor();
    const effect = editor.handleKey({ key: 'F5' });
    assert.equal(effect.kind, 'unhandled');
    // v1 let Escape on an empty line fall through so the host could blur.
    assert.equal(editor.handleKey({ key: 'Escape' }).kind, 'unhandled');
  });

  it('clears the screen without touching the line', () => {
    const editor = makeEditor();
    type(editor, 'half a command');
    assert.deepEqual(editor.handleKey({ key: 'l', ctrl: true }), { kind: 'clear-screen' });
    assert.equal(editor.view.text, 'half a command');
  });
});

describe('submitting', () => {
  it('records the line with full provenance', () => {
    const history = new HistoryEngine();
    const editor = makeEditor({ history });
    type(editor, 'Get-Date');
    const effect = editor.handleKey({ key: 'Enter' });
    assert.equal(effect.kind, 'submit');
    assert.equal(editor.view.text, '', 'the line is cleared');
    assert.deepEqual(
      history.entries.map((e) => ({ source: e.source, origin: e.origin, cwd: e.cwd, profile: e.compatibilityProfile })),
      [{ source: 'Get-Date', origin: 'user', cwd: '/home/thc1006', profile: '7.6.5' }],
    );
  });

  it('marks a line that came out of the completion menu', () => {
    // The `completion` origin is not decoration: menu-accepted lines are
    // systematically longer than typed ones and would skew prediction if they
    // were indistinguishable from what the user actually typed.
    const history = new HistoryEngine();
    const editor = makeEditor({ history });
    type(editor, 'Get-Ch');
    editor.handleKey({ key: 'Tab' });
    editor.handleKey({ key: 'Enter' });
    assert.equal(history.entries[0]?.origin, 'completion');
  });

  it('does not mark a line whose completion was rejected', () => {
    const history = new HistoryEngine();
    const editor = makeEditor({ history });
    type(editor, 'Get-C');
    editor.handleKey({ key: 'Tab' });
    editor.handleKey({ key: 'Escape' });
    type(editor, 'ommand');
    editor.handleKey({ key: 'Enter' });
    assert.deepEqual(
      history.entries.map((e) => [e.source, e.origin]),
      [['Get-Command', 'user']],
    );
  });

  it('does not mark a line recalled from history either', () => {
    const history = new HistoryEngine();
    seed(history, 'Get-Date');
    const editor = makeEditor({ history });
    type(editor, 'Get-C');
    editor.handleKey({ key: 'Tab' });
    const size = editor.view.menu?.candidates.length ?? 0;
    editor.handleKey({ key: 'ArrowUp' });
    assert.equal(editor.view.menu?.index, size - 1, 'ArrowUp cycles the menu, not history');
    editor.handleKey({ key: 'Escape' });
    editor.handleKey({ key: 'ArrowUp' });
    assert.equal(editor.view.text, 'Get-Date');
    editor.handleKey({ key: 'Enter' });
    assert.equal(history.entries[1]?.origin, 'user');
  });

  it('abandons the line on Ctrl+C without recording it', () => {
    const history = new HistoryEngine();
    const editor = makeEditor({ history });
    type(editor, 'oops');
    assert.deepEqual(editor.handleKey({ key: 'c', ctrl: true }), { kind: 'cancel', line: 'oops' });
    assert.equal(editor.view.text, '');
    assert.equal(history.size, 0);
  });

  it('lets a host submit on behalf of an agent', () => {
    const history = new HistoryEngine();
    const editor = makeEditor({ history });
    type(editor, 'kubectl get pods');
    editor.submit('ai');
    assert.equal(history.entries[0]?.origin, 'ai');
  });
});

describe('history navigation', () => {
  it('walks back and gives the draft line back on the way forward', () => {
    const history = new HistoryEngine();
    seed(history, 'first');
    seed(history, 'second');
    const editor = makeEditor({ history });
    type(editor, 'in progress');

    editor.handleKey({ key: 'ArrowUp' });
    assert.equal(editor.view.text, 'second');
    editor.handleKey({ key: 'ArrowUp' });
    assert.equal(editor.view.text, 'first');
    assert.deepEqual(editor.handleKey({ key: 'ArrowUp' }), { kind: 'bell', action: 'history-previous' });

    editor.handleKey({ key: 'ArrowDown' });
    assert.equal(editor.view.text, 'second');
    editor.handleKey({ key: 'ArrowDown' });
    assert.equal(editor.view.text, 'in progress', 'the draft is restored, not lost');
  });

  it('forgets the draft once the user edits, so it cannot reappear later', () => {
    // v1 cleared `hIdx` on the typing path but not `draft`, so a stale draft
    // could resurface a command later.
    const history = new HistoryEngine();
    seed(history, 'first');
    const editor = makeEditor({ history });
    type(editor, 'abc');
    editor.handleKey({ key: 'ArrowUp' });
    assert.equal(editor.view.text, 'first');
    type(editor, 'X');
    assert.equal(editor.view.text, 'firstX');
    assert.deepEqual(editor.handleKey({ key: 'ArrowDown' }), { kind: 'bell', action: 'history-next' });
    assert.equal(editor.view.text, 'firstX');
  });

  it('does not hand the user commands an agent ran', () => {
    const history = new HistoryEngine();
    seed(history, 'I typed this');
    seed(history, 'the agent ran this', 'ai');
    const editor = makeEditor({ history });
    editor.handleKey({ key: 'ArrowUp' });
    assert.equal(editor.view.text, 'I typed this');
  });

  it('is also reachable through Ctrl+P and Ctrl+N', () => {
    const history = new HistoryEngine();
    seed(history, 'only');
    const editor = makeEditor({ history });
    editor.handleKey({ key: 'p', ctrl: true });
    assert.equal(editor.view.text, 'only');
    editor.handleKey({ key: 'n', ctrl: true });
    assert.equal(editor.view.text, '');
  });
});

describe('reverse search', () => {
  it('finds by substring as the needle grows, and Enter keeps the line', () => {
    const history = new HistoryEngine();
    seed(history, 'Get-Process -Name pwsh');
    seed(history, 'Set-Location /tmp');
    const editor = makeEditor({ history });

    editor.handleKey({ key: 'r', ctrl: true });
    assert.deepEqual(editor.view.search, { needle: '', index: 0, count: 0, failed: false });

    type(editor, 'proc');
    assert.equal(editor.view.text, 'Get-Process -Name pwsh');
    assert.equal(editor.view.search?.count, 1);

    // Enter accepts the found line into the buffer; a second Enter runs it.
    // Making one Enter do both would execute a command the user only glimpsed.
    const effect = editor.handleKey({ key: 'Enter' });
    assert.deepEqual(effect, { kind: 'none' });
    assert.equal(editor.view.search, null);
    assert.equal(editor.view.text, 'Get-Process -Name pwsh');
  });

  it('restores the line on Escape', () => {
    const history = new HistoryEngine();
    seed(history, 'Get-Process');
    const editor = makeEditor({ history });
    type(editor, 'draft');
    editor.handleKey({ key: 'r', ctrl: true });
    type(editor, 'proc');
    assert.equal(editor.view.text, 'Get-Process');
    editor.handleKey({ key: 'Escape' });
    assert.equal(editor.view.text, 'draft');
    assert.equal(editor.view.search, null);
  });

  it('says so when the needle matches nothing', () => {
    const history = new HistoryEngine();
    seed(history, 'Get-Process');
    const editor = makeEditor({ history });
    editor.handleKey({ key: 'r', ctrl: true });
    type(editor, 'zzz');
    assert.equal(editor.view.search?.failed, true);
    editor.handleKey({ key: 'Backspace' });
    editor.handleKey({ key: 'Backspace' });
    editor.handleKey({ key: 'Backspace' });
    assert.equal(editor.view.search?.needle, '');
  });

  it('suppresses the ghost suggestion, whose buffer is on loan', () => {
    const history = new HistoryEngine();
    seed(history, 'Get-Process');
    const editor = makeEditor({ history });
    editor.handleKey({ key: 'r', ctrl: true });
    type(editor, 'get');
    assert.equal(editor.view.prediction, '');
  });
});

describe('the completion menu', () => {
  it('applies a lone candidate without opening a menu, as v1 did', () => {
    const editor = makeEditor();
    type(editor, 'Get-Ch');
    editor.handleKey({ key: 'Tab' });
    assert.equal(editor.view.text, 'Get-ChildItem');
    assert.equal(editor.view.menu, null);
  });

  it('opens on two or more, shows the first, and cycles both ways', () => {
    const editor = makeEditor();
    type(editor, 'Get-C');
    editor.handleKey({ key: 'Tab' });
    const menu = editor.view.menu;
    assert.ok(menu !== null);
    assert.equal(menu.index, 0);
    assert.ok(menu.candidates.length > 2);
    assert.equal(editor.view.text, menu.candidates[0]?.display);

    editor.handleKey({ key: 'Tab' });
    assert.equal(editor.view.menu?.index, 1);
    assert.equal(editor.view.text, menu.candidates[1]?.display);

    editor.handleKey({ key: 'Tab', shift: true });
    assert.equal(editor.view.menu?.index, 0);
    // Cycling replays from the pre-menu buffer, so it cannot accumulate drift.
    assert.equal(editor.view.text, menu.candidates[0]?.display);

    editor.handleKey({ key: 'ArrowUp' });
    assert.equal(editor.view.menu?.index, menu.candidates.length - 1);
  });

  it('takes its page size from the injected metrics, never from a measurement', () => {
    const editor = new LineEditor({ clock: () => NOW, metrics: monospaceMetrics(40, 10) });
    type(editor, 'Get-C');
    editor.handleKey({ key: 'Tab' });
    assert.equal(editor.view.menu?.pageSize, 8);
  });

  it('restores the original line on Escape', () => {
    const editor = makeEditor();
    type(editor, 'Get-C');
    editor.handleKey({ key: 'Tab' });
    assert.notEqual(editor.view.text, 'Get-C');
    editor.handleKey({ key: 'Escape' });
    assert.equal(editor.view.text, 'Get-C');
    assert.equal(editor.view.menu, null);
  });

  it('closes on Enter without running the line', () => {
    const editor = makeEditor();
    type(editor, 'Get-C');
    editor.handleKey({ key: 'Tab' });
    const chosen = editor.view.text;
    assert.deepEqual(editor.handleKey({ key: 'Enter' }), { kind: 'none' });
    assert.equal(editor.view.menu, null);
    assert.equal(editor.view.text, chosen, 'a second Enter is what runs it');
    assert.equal(editor.handleKey({ key: 'Enter' }).kind, 'submit');
  });

  it('closes on any other key and lets that key through, as v1 did', () => {
    const editor = makeEditor();
    type(editor, 'Get-C');
    editor.handleKey({ key: 'Tab' });
    const chosen = editor.view.text;
    editor.handleKey({ key: 'x' });
    assert.equal(editor.view.menu, null);
    assert.equal(editor.view.text, `${chosen}x`);
  });

  it('rings the bell when there is nothing to complete', () => {
    const editor = makeEditor();
    type(editor, 'zzzzzz');
    assert.deepEqual(editor.handleKey({ key: 'Tab' }), { kind: 'bell', action: 'complete' });
  });

  it('suppresses the ghost suggestion while it is open', () => {
    const history = new HistoryEngine();
    seed(history, 'Get-Command -Name x');
    const editor = makeEditor({ history });
    type(editor, 'Get-C');
    assert.notEqual(editor.view.prediction, '');
    editor.handleKey({ key: 'Tab' });
    assert.equal(editor.view.prediction, '');
  });

  it('completes into an injected argument source', () => {
    const completion = new CompletionEngine({
      argumentSource: (ctx) => (ctx.kind === 'parameter-value' ? [{ value: 'notes.md' }] : []),
    });
    const editor = new LineEditor({ completion, clock: () => NOW });
    type(editor, 'Get-Content -Path ');
    editor.handleKey({ key: 'Tab' });
    assert.equal(editor.view.text, 'Get-Content -Path notes.md');
  });
});

describe('inline prediction in the editor', () => {
  it('shows the tail and takes it on ArrowRight at the end of the line', () => {
    const history = new HistoryEngine();
    seed(history, 'Get-ChildItem -Recurse');
    const editor = makeEditor({ history });
    type(editor, 'Get-Child');
    assert.equal(editor.view.prediction, 'Item -Recurse');

    editor.handleKey({ key: 'ArrowRight' });
    assert.equal(editor.view.text, 'Get-ChildItem -Recurse');
    assert.equal(editor.view.prediction, '', 'nothing left to suggest');
  });

  it('takes one word at a time on Ctrl+ArrowRight', () => {
    const history = new HistoryEngine();
    seed(history, 'Get-ChildItem -Recurse -Force');
    const editor = makeEditor({ history });
    type(editor, 'Get-ChildItem');
    editor.handleKey({ key: 'ArrowRight', ctrl: true });
    assert.equal(editor.view.text, 'Get-ChildItem -Recurse');
    editor.handleKey({ key: 'ArrowRight', ctrl: true });
    assert.equal(editor.view.text, 'Get-ChildItem -Recurse -Force');
  });

  it('shows nothing when the caret is not at the end', () => {
    // v1's gate was `!composing && atEnd() && !menu.open`; ghost text drawn
    // mid-line would sit on top of the text after the caret.
    const history = new HistoryEngine();
    seed(history, 'Get-ChildItem -Recurse');
    const editor = makeEditor({ history });
    type(editor, 'Get-Child');
    editor.handleKey({ key: 'ArrowLeft' });
    assert.equal(editor.view.prediction, '');
    // ...and ArrowRight then just moves the caret.
    editor.handleKey({ key: 'ArrowRight' });
    assert.equal(editor.view.text, 'Get-Child');
  });

  it('keeps the capitalisation the user typed', () => {
    const history = new HistoryEngine();
    seed(history, 'whoami');
    const editor = makeEditor({ history });
    type(editor, 'WHO');
    assert.equal(editor.view.prediction, 'ami');
    editor.handleKey({ key: 'End' });
    assert.equal(editor.view.text, 'WHOami', 'not silently rewritten to whoami');
  });
});
