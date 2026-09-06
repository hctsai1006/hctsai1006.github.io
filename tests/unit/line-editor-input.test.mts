/**
 * Tests for the input seam: the textarea adapter, and v1's IME guard whole.
 *
 * WHAT THE IME SUITE HAS TO PROVE, AND WHY IT IS WRITTEN THE WAY IT IS
 *
 * `isComposing || composing || keyCode === 229` is one line, and writing that
 * line is not the task. A guard is three legs only if each leg stops a keystroke
 * the other two let through, so each of the three cases below neutralises the
 * leg under test and asserts that the SAME event then gets past the guard. That
 * second assertion is the whole point: without it the test passes just as well
 * with two legs, or with one.
 *
 * The failure being prevented is not cosmetic. During 注音 composition Enter is
 * candidate confirmation and ArrowUp/ArrowDown page the candidate list, so a
 * keystroke the guard misses is a submitted command or a recalled history line,
 * and the half-composed word is gone. Two of the cases therefore assert the
 * damage as well as the guard: the line must not have been submitted.
 *
 * WHAT IS MEASURED AND WHAT IS NOT. The events replayed here are the traces
 * recorded from Chromium 148.0.7778.96 and WebKit 26.4 on 2026-09-06 — the
 * measurement notes on src/input/ime.ts say what was run. The two cases that
 * describe engines this machine could not drive (old Safari, Android) are marked
 * where they appear; they are v1's stated reasons for its middle leg, replayed
 * as v1 describes them, not as something observed here.
 *
 * There is no DOM in this file. `FakeTextarea` is fifteen lines and reproduces
 * the two measured behaviours the adapter depends on; the compile-time check in
 * `the surface port` is what ties it back to what lib.dom says a real textarea
 * is.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  IME_SENTINEL_KEYCODE,
  imeGuardLeg,
  toEditorKeyEvent,
  TextareaInputAdapter,
  type ImeGuardLeg,
  type InputAdapter,
  type KeydownLike,
  type TextareaLike,
} from '../../src/input/index.ts';
import { HistoryEngine, LineEditor, monospaceMetrics, type EditorEffect } from '../../src/line-editor/index.ts';

const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);

/**
 * Faithful in the two ways the adapter depends on, both measured:
 *
 *   - assigning a DIFFERENT string moves the caret to the end of the field
 *     (Chromium 148 and WebKit 26.4 both reported selectionStart 3 -> 7);
 *     assigning the identical string leaves it alone;
 *   - assigning `value` fires no event, so it cannot re-enter a handler.
 *
 * If it did not move the caret, every `sync()` here would pass whether or not
 * the adapter restored the selection, and the mirror tests would prove nothing.
 */
class FakeTextarea implements TextareaLike {
  #value = '';
  selectionStart: number | null = 0;
  selectionEnd: number | null = 0;
  readonly listeners = new Map<string, EventListener>();

  get value(): string {
    return this.#value;
  }

  set value(next: string) {
    if (next === this.#value) return;
    this.#value = next;
    this.selectionStart = next.length;
    this.selectionEnd = next.length;
  }

  /** The IME and the browser write here; only they move text without an event. */
  typeNatively(text: string, caret: number = text.length): void {
    this.#value = text;
    this.selectionStart = caret;
    this.selectionEnd = caret;
  }

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.set(type, listener as EventListener);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }

  /**
   * Deliver an event to whatever `attach()` registered, so the wiring is
   * exercised rather than assumed.
   *
   * The one cast in this file. The fakes here are the SHAPE the adapter reads,
   * not DOM `Event`s; the port takes lib.dom's listener type because that is the
   * only thing a real textarea's `addEventListener` accepts — see the note on
   * `TextareaLike`.
   */
  dispatch(type: string, event: unknown): void {
    const listener = this.listeners.get(type);
    assert.ok(listener, `nothing is listening for ${type}`);
    listener(event as Event);
  }
}

type KeydownInit = Omit<KeydownLike, 'preventDefault'>;
interface FakeKeydown extends KeydownLike {
  readonly prevented: number;
}

function keydown(init: KeydownInit): FakeKeydown {
  let prevented = 0;
  return {
    ...init,
    preventDefault: (): void => {
      prevented += 1;
    },
    get prevented(): number {
      return prevented;
    },
  };
}

interface Rig {
  readonly editor: LineEditor;
  readonly surface: FakeTextarea;
  readonly adapter: TextareaInputAdapter;
  readonly effects: EditorEffect[];
}

function rig(options: { hasSelection?: () => boolean } = {}): Rig {
  const editor = new LineEditor({
    history: new HistoryEngine(),
    clock: () => NOW,
    cwd: '/home/thc1006',
    compatibilityProfile: '7.6.5',
    metrics: monospaceMetrics(80, 24),
  });
  const surface = new FakeTextarea();
  const effects: EditorEffect[] = [];
  const adapter = new TextareaInputAdapter(editor, surface, {
    onEffect: (effect) => effects.push(effect),
    ...(options.hasSelection === undefined ? {} : { hasSelection: options.hasSelection }),
  });
  return { editor, surface, adapter, effects };
}

/** Type printable characters the way a physical keyboard delivers them. */
function type(adapter: TextareaInputAdapter, text: string): void {
  for (const ch of text) adapter.onKeyDown(keydown({ key: ch, keyCode: ch.toUpperCase().charCodeAt(0) }));
}

// ---------------------------------------------------------------------------

describe('the IME guard, one case per leg', () => {
  it('stops the keydown that starts a composition, which only the 229 sentinel sees', () => {
    // MEASURED, Chromium 148.0.7778.96: a keydown carrying windowsVirtualKeyCode
    // 229 arrives as `key="Process" keyCode=229 isComposing=false`, and the
    // `compositionstart` requested immediately afterwards fires AFTER it. So at
    // this instant the two legs the core owns are both false: the composition
    // has not started, and nothing has set the sticky flag.
    const first = keydown({ key: 'Process', keyCode: IME_SENTINEL_KEYCODE, isComposing: false });
    assert.equal(imeGuardLeg(first, false), 'sentinel-keycode');

    // Neutralise the leg and the identical keystroke walks straight through.
    // This is what makes it a leg rather than a line of code.
    const withoutSentinel = keydown({ key: 'Process', keyCode: 0, isComposing: false });
    assert.equal(imeGuardLeg(withoutSentinel, false), null);

    // And the damage, on the key that matters. A Windows IME confirming a
    // candidate reports the sentinel; without leg three this Enter submits the
    // line and the half-composed word is lost.
    const { editor, adapter } = rig();
    type(adapter, 'Get-Date');
    const enter = keydown({ key: 'Enter', keyCode: IME_SENTINEL_KEYCODE, isComposing: false });
    assert.deepEqual(adapter.onKeyDown(enter), { kind: 'ime', leg: 'sentinel-keycode' });
    assert.equal(enter.prevented, 0, 'an IME key is never preventDefault-ed');
    assert.equal(editor.view.text, 'Get-Date', 'still on the line');
    assert.equal(editor.history.entries.length, 0, 'nothing was submitted');
  });

  it('stops a mid-composition keydown that reports neither flag, which only the sticky leg sees', () => {
    // NOT MEASURED, AND THE WEAKEST OF THE THREE — said plainly rather than
    // dressed up. No engine available here, and no browser-tracker issue found
    // while researching this, produces a keydown that only the sticky leg
    // catches: every engine surveyed sends the sentinel, the flag, or both. The
    // event below is constructed to v1's description — its comment names 舊
    // Safari and 部分 Android IME — of an engine with no `isComposing` at all,
    // which is the state of the world before Gecko 31 / Chrome 56 / WebKit 2016.
    //
    // It stays because deleting a leg on the grounds that today's engines make
    // it look redundant is the exact reasoning that would have deleted it from
    // v1, and the cost of being wrong is a 注音 user losing a word.
    const { editor, adapter } = rig();
    type(adapter, 'Get-Date');

    adapter.onCompositionStart();
    const enter = keydown({ key: 'Enter', keyCode: 13 });
    assert.equal(imeGuardLeg(enter, editor.composing), 'sticky-composing');
    assert.deepEqual(adapter.onKeyDown(enter), { kind: 'ime', leg: 'sticky-composing' });

    // Neutralise the leg: the same event with no composition in progress is an
    // ordinary Enter, and it submits.
    assert.equal(imeGuardLeg(enter, false), null);
    assert.equal(editor.history.entries.length, 0);
    adapter.onCompositionEnd({ data: '' });
    assert.deepEqual(adapter.onKeyDown(keydown({ key: 'Enter', keyCode: 13 })).kind, 'handled');
    assert.equal(editor.history.entries.length, 1, 'the same keystroke, unguarded, submits');
  });

  it('stops a keydown inside a composition this adapter never saw start, which only isComposing sees', () => {
    // MEASURED, Chromium 148: a keydown delivered while a composition is live
    // reports `isComposing: true` and carries the REAL key code — 13 for Enter,
    // not 229. So if the sticky flag is not set, leg one is the only thing left.
    //
    // It is not set when the adapter was attached mid-composition, or when a
    // spurious `compositionend` cleared it early. Both are reachable here: an
    // adapter can be attached and detached while the user is typing, which is
    // exactly what swapping input surfaces does.
    const { editor, adapter, surface } = rig();
    type(adapter, 'Get-Date');
    adapter.attach();
    assert.equal(editor.composing, false, 'attached mid-composition, having missed the start');

    const enter = keydown({ key: 'Enter', keyCode: 13, isComposing: true });
    assert.equal(imeGuardLeg(enter, false), 'is-composing');
    assert.deepEqual(adapter.onKeyDown(enter), { kind: 'ime', leg: 'is-composing' });
    assert.equal(editor.history.entries.length, 0, 'nothing was submitted');

    // Neutralise the leg: the same key code, no flag, no sticky state.
    assert.equal(imeGuardLeg(keydown({ key: 'Enter', keyCode: 13 }), false), null);
    assert.equal(surface.value, 'Get-Date');
  });

  it('is not fooled by keyCode 0, which is what a synthesised event reports', () => {
    // MEASURED, both engines: a `KeyboardEvent` constructed in script with
    // `isComposing: true` reports `keyCode: 0`. `=== 229` is a test for a
    // sentinel, so an absent or zero key code has to fall through to the other
    // two legs rather than be treated as "probably an IME".
    assert.equal(imeGuardLeg(keydown({ key: 'Enter', keyCode: 0, isComposing: true }), false), 'is-composing');
    assert.equal(imeGuardLeg(keydown({ key: 'Enter', keyCode: 0 }), true), 'sticky-composing');
    assert.equal(imeGuardLeg(keydown({ key: 'Enter', keyCode: 0 }), false), null);
    assert.equal(imeGuardLeg(keydown({ key: 'Enter' }), false), null, 'an absent keyCode is not 229');
  });

  it('has a soft landing for Process and Unidentified, and none at all for the real key', () => {
    // There IS a fallback behind leg three on the platforms that name the key
    // `Process` (Chrome for Windows, Firefox) or `Unidentified` (Chrome for
    // Android): both are in the core's NAMED_KEYS with no binding, so the core
    // answers `unhandled` and the IME keeps the keystroke.
    const { adapter, editor } = rig();
    const process = keydown({ key: 'Process', keyCode: 0 });
    assert.deepEqual(adapter.onKeyDown(process), { kind: 'passed-through', reason: 'unhandled' });
    assert.equal(process.prevented, 0);
    assert.equal(editor.view.text, '');
    assert.deepEqual(adapter.onKeyDown(keydown({ key: 'Unidentified' })), {
      kind: 'passed-through',
      reason: 'unhandled',
    });

    // And there is NO fallback on Chrome for macOS or Safari, which per Chromium
    // issue 462227034 send the real key with keyCode 229 beside it. Escape is
    // bound to revert-line, so on those two the sentinel is the only thing
    // between a composing user and a cleared line. This asserts both halves: the
    // sentinel catches it, and without the sentinel it does not survive.
    type(adapter, 'Get-Date');
    const macOs = keydown({ key: 'Escape', keyCode: 229, isComposing: false });
    assert.deepEqual(adapter.onKeyDown(macOs), { kind: 'ime', leg: 'sentinel-keycode' });
    assert.equal(editor.view.text, 'Get-Date');

    assert.equal(adapter.onKeyDown(keydown({ key: 'Escape', keyCode: 27 })).kind, 'handled');
    assert.equal(editor.view.text, '', 'the same keystroke without the sentinel clears the line');
  });
});

/**
 * What a keydown looks like DURING a composition, per engine.
 *
 * Sourced from Chromium issue 462227034 and its Google triage comment, which
 * compares Chrome on Windows, macOS, Linux and Android against Firefox, and from
 * WebKit 165004 for the Safari row. Not measured here; a tracker with a
 * maintainer's repro is the evidence.
 */
interface EngineProfile {
  readonly name: string;
  readonly keydown: KeydownInit;
  /** Which leg is expected to fire, written down rather than derived. */
  readonly withStart: ImeGuardLeg | null;
  readonly withoutStart: ImeGuardLeg | null;
}

const ENGINE_PROFILES: readonly EngineProfile[] = [
  { name: 'Chrome for Windows', keydown: { key: 'Process', keyCode: 229, isComposing: true }, withStart: 'is-composing', withoutStart: 'is-composing' },
  { name: 'Chrome for macOS', keydown: { key: 'Enter', keyCode: 229, isComposing: true }, withStart: 'is-composing', withoutStart: 'is-composing' },
  { name: 'Chrome for Android', keydown: { key: 'Unidentified', keyCode: 229, isComposing: true }, withStart: 'is-composing', withoutStart: 'is-composing' },
  { name: 'Firefox, any platform', keydown: { key: 'Process', keyCode: 229, isComposing: true }, withStart: 'is-composing', withoutStart: 'is-composing' },
  // WebKit 165004: keydown arrives AFTER compositionend with isComposing false.
  { name: 'Safari before the 165004 fix', keydown: { key: 'Enter', keyCode: 229, isComposing: false }, withStart: 'sticky-composing', withoutStart: 'sentinel-keycode' },
  // Before Gecko 31 / Chrome 56 / WebKit 2016 the attribute did not exist.
  { name: 'anything predating isComposing', keydown: { key: 'Enter', keyCode: 229 }, withStart: 'sticky-composing', withoutStart: 'sentinel-keycode' },
  // The adversary, not an engine: reports neither field while composing.
  { name: 'an engine reporting nothing useful', keydown: { key: 'Enter', keyCode: 13, isComposing: false }, withStart: 'sticky-composing', withoutStart: null },
];

describe('the guard as a matrix, which is the only way to see what each leg buys', () => {
  /**
   * Read down the two columns and each leg's job becomes visible:
   *
   *   `is-composing` wins every row where the flag is set, so on today's engines
   *       it is the leg that actually fires. On its own it would still be enough
   *       for the top four — but `keyCode` is DEPRECATED, and an engine that
   *       drops it leaves this as the only leg. It is the forward-compatible one.
   *   `sentinel-keycode` is the only leg left on the two historical rows once the
   *       compositionstart is gone. Safari sat in that state for nine years.
   *   `sticky-composing` is the only leg that is not a per-event field, so it is
   *       the only one that survives an engine reporting neither — the last row,
   *       left column. No such engine is documented; that row is the adversary,
   *       and the leg is what makes it survivable.
   *
   * The last row, right column, is the honest hole: no compositionstart and no
   * usable field is no information, and the keystroke is taken. It is in the
   * table rather than left out, because a matrix that only shows the wins is the
   * same mistake as a guard that only has one leg.
   */
  /**
   * One test rather than one per row, and the reason is mechanical: tools/
   * roadmap-evidence.mts reads cited test names off the TypeScript AST, so a
   * name built from a template literal in a loop does not exist as far as the
   * roadmap gate is concerned. A row that fails names itself in the message.
   */
  it('guards a composition keystroke on every engine profile, with and without the compositionstart', () => {
    for (const profile of ENGINE_PROFILES) {
      for (const startDelivered of [true, false]) {
        const expected = startDelivered ? profile.withStart : profile.withoutStart;
        const where = `${profile.name}, compositionstart ${startDelivered ? 'delivered' : 'lost'}`;

        // The leg, from the table rather than re-derived here. Deriving the
        // expectation from the same three conditions the guard uses would make
        // this pass for a one-legged guard as happily as for a three-legged one.
        assert.equal(imeGuardLeg(keydown({ ...profile.keydown }), startDelivered), expected, where);

        // And the consequence, which is what the leg is actually for.
        const { editor, adapter } = rig();
        type(adapter, 'Get-Date');
        if (startDelivered) adapter.onCompositionStart();
        const event = keydown({ ...profile.keydown });
        const outcome = adapter.onKeyDown(event);

        if (expected !== null) {
          assert.deepEqual(outcome, { kind: 'ime', leg: expected }, where);
          assert.equal(event.prevented, 0, where);
          assert.equal(editor.history.entries.length, 0, where);
          assert.equal(editor.view.text, 'Get-Date', where);
        } else {
          // No flag, no sentinel, no compositionstart: no information, and the
          // composing user's Enter runs the command. In the table on purpose.
          assert.equal(outcome.kind, 'handled', where);
          assert.equal(editor.history.entries.length, 1, where);
          assert.equal(editor.view.text, '', where);
        }
      }
    }
  });

  it('reads the sentinel as the exact legacy virtual-key code and nothing near it', () => {
    assert.equal(IME_SENTINEL_KEYCODE, 229);
    for (const keyCode of [0, 13, 228, 230, 27]) {
      assert.equal(imeGuardLeg(keydown({ key: 'Enter', keyCode }), false), null, `keyCode ${keyCode}`);
    }
  });
});

describe('the composition sequence the sticky flag was added for', () => {
  it('hands back every key between compositionstart and compositionend', () => {
    // v1: compositionstart sets `composing`, compositionend clears it, and the
    // key handler returns early for the whole span. These keydowns carry NO
    // flags at all, which is the case the span exists to cover.
    const history = new HistoryEngine();
    history.append({
      source: 'Get-ChildItem',
      cwd: '/home/thc1006',
      compatibilityProfile: '7.6.5',
      origin: 'user',
      exitCode: 0,
      durationMs: 1,
      createdAt: NOW - 1000,
    });
    const editor = new LineEditor({ history, clock: () => NOW, metrics: monospaceMetrics(80, 24) });
    const surface = new FakeTextarea();
    const adapter = new TextareaInputAdapter(editor, surface);
    type(adapter, 'Get-');

    adapter.onCompositionStart();
    for (const key of ['Enter', 'ArrowUp', 'ArrowDown', 'Tab', 'Escape', '1', '2', '3']) {
      const event = keydown({ key });
      assert.equal(adapter.onKeyDown(event).kind, 'ime', key);
      assert.equal(event.prevented, 0, key);
    }
    assert.equal(editor.view.text, 'Get-', 'no key reached the buffer');
    assert.equal(editor.history.entries.length, 1, 'Enter did not submit');
    assert.equal(editor.view.menu, null, 'Tab did not open the menu');

    adapter.onCompositionEnd({ data: '測試' });
    assert.equal(editor.view.text, 'Get-測試');
    assert.equal(editor.composing, false);
    // Immediately usable again: the same Enter that was handed back now submits.
    assert.equal(adapter.onKeyDown(keydown({ key: 'Enter' })).kind, 'handled');
    assert.equal(editor.history.entries[1]?.source, 'Get-測試');
  });

  it('closes the completion menu when a composition starts', () => {
    // v1's compositionstart handler called closeMenu() because the IME is about
    // to take ArrowUp/ArrowDown/Enter, which are the menu's keys too. The core
    // does it inside setComposing; this asserts the adapter actually gets there.
    const { editor, adapter } = rig();
    type(adapter, 'Get-C');
    adapter.onKeyDown(keydown({ key: 'Tab' }));
    assert.notEqual(editor.view.menu, null, 'there is a menu to close');
    adapter.onCompositionStart();
    assert.equal(editor.view.menu, null);
  });

  it('re-arms the sticky leg from compositionupdate, which v1 had no listener for', () => {
    // Defensive and unmeasured: nothing available here fires update without a
    // start. It is idempotent, and the failure it covers is the editor eating a
    // candidate keystroke.
    const { editor, adapter } = rig();
    adapter.onCompositionUpdate();
    assert.equal(editor.composing, true);
    assert.equal(adapter.onKeyDown(keydown({ key: 'Enter' })).kind, 'ime');
  });

  it('recovers from a compositionend that never arrives', () => {
    // v1 had no way out of this: a lost compositionend left the editor inert to
    // every key until the page was reloaded. Reported on Android IMEs; not
    // reproduced here, because no such device was available.
    const { editor, adapter } = rig();
    adapter.onCompositionStart();
    assert.equal(adapter.onKeyDown(keydown({ key: 'a' })).kind, 'ime');
    adapter.cancelComposition();
    assert.equal(editor.composing, false);
    assert.equal(adapter.onKeyDown(keydown({ key: 'a' })).kind, 'handled');
    assert.equal(editor.view.text, 'a');
  });
});

describe('a composition replayed from the measured event order', () => {
  it('commits through insertText and ignores every input event the IME caused', () => {
    // The trace recorded from Chromium 148 on 2026-09-06, driving a real
    // composition through CDP Input.imeSetComposition: input fires DURING the
    // composition, carrying isComposing: true, and compositionend arrives last
    // with the field already holding the committed text.
    const { editor, adapter, surface } = rig();
    type(adapter, 'Get-');
    assert.equal(surface.value, 'Get-');

    adapter.onCompositionStart();
    for (const preEdit of ['ㄘ', 'ㄘㄜ', '測']) {
      surface.typeNatively('Get-' + preEdit);
      adapter.onInput({ isComposing: true });
      assert.equal(editor.view.text, 'Get-', `pre-edit ${preEdit} must not reach the core`);
    }
    adapter.onCompositionEnd({ data: '測' });

    assert.equal(editor.view.text, 'Get-測');
    assert.equal(surface.value, 'Get-測', 'the surface was not double-written');
    assert.equal(editor.view.caret, 5);
    assert.equal(surface.selectionStart, 5);
  });

  it('survives the other ordering, where the commit input arrives after compositionend', () => {
    // Not the order measured here, but the one the spec's event-order section
    // reads as, and engines have differed. Both guards in onInput exist for this:
    // the sticky flag covers an input delivered before compositionend with
    // isComposing false, and the equality check covers one delivered after.
    const { editor, adapter, surface } = rig();
    adapter.onCompositionStart();
    surface.typeNatively('測');
    adapter.onInput({ isComposing: false });
    assert.equal(editor.view.text, '', 'the sticky flag stopped it');

    adapter.onCompositionEnd({ data: '測' });
    assert.equal(editor.view.text, '測');

    surface.typeNatively('測');
    adapter.onInput({ isComposing: false });
    assert.equal(editor.view.text, '測', 'no double insert');
  });

  it('survives Safari sending the confirming keydown after compositionend', () => {
    // WebKit 165004, open from 2016-11-21 to 2026-04-16. Comment #4: "The Enter
    // key that accepts the IME input will be sent with isComposing === false,
    // because Safari is sending events out of order, and keydown/input are being
    // sent after compositionend. This makes comparing keyCode === 229 the only
    // reliable way to detect whether IME is being used or not."
    //
    // Both of the core's legs are false by then — the flag says so and the sticky
    // state was cleared by the compositionend that just fired — so this is leg
    // three earning its place on a shipping browser rather than on a first
    // keystroke. Nine and a half years of Safari; the fix is newer than this
    // repository.
    const { editor, adapter, surface } = rig();
    type(adapter, 'Get-');
    adapter.onCompositionStart();
    surface.typeNatively('Get-測');
    adapter.onCompositionEnd({ data: '測' });
    assert.equal(editor.composing, false, 'the sticky leg is already down');

    const confirming = keydown({ key: 'Enter', keyCode: 229, isComposing: false });
    assert.deepEqual(adapter.onKeyDown(confirming), { kind: 'ime', leg: 'sentinel-keycode' });
    assert.equal(confirming.prevented, 0);
    assert.equal(editor.history.entries.length, 0, 'the candidate confirmation did not run a command');
    assert.equal(editor.view.text, 'Get-測');
  });

  it('treats a cancelled composition as a commit of nothing', () => {
    // MEASURED: cancelling with an empty string ends with `compositionend
    // data: ""`. insertText('') is a no-op in the core, so nothing branches.
    const { editor, adapter, surface } = rig();
    type(adapter, 'Get-');
    adapter.onCompositionStart();
    surface.typeNatively('Get-ㄘ');
    adapter.onInput({ isComposing: true });
    surface.typeNatively('Get-');
    adapter.onCompositionEnd({ data: '' });
    assert.equal(editor.view.text, 'Get-');
    assert.equal(surface.value, 'Get-');
  });
});

describe('the textarea as a mirror rather than an owner', () => {
  it('writes the core onto the surface after every handled key', () => {
    const { editor, adapter, surface } = rig();
    type(adapter, 'Get-Date');
    assert.equal(surface.value, 'Get-Date');
    assert.equal(editor.view.text, 'Get-Date');

    adapter.onKeyDown(keydown({ key: 'ArrowLeft' }));
    assert.equal(surface.selectionStart, 7, 'the caret came from the core, not from the field');
    assert.equal(surface.value, 'Get-Date');

    adapter.onKeyDown(keydown({ key: 'a', ctrlKey: true }));
    assert.equal(surface.selectionStart, 0, 'Ctrl+A is move-line-start here, not select-all');

    adapter.onKeyDown(keydown({ key: 'Enter' }));
    assert.equal(surface.value, '', 'submitting cleared both');
    assert.equal(editor.view.text, '');
  });

  it('takes a native edit back into the core wholesale', () => {
    // Paste, autocorrect, and every soft-keyboard insertion arrive this way: the
    // field has already applied the edit, so the core is handed the result.
    const { editor, adapter, surface } = rig();
    type(adapter, 'Get-');
    surface.typeNatively('Get-Content ./notes.md', 10);
    adapter.onInput({});
    assert.equal(editor.view.text, 'Get-Content ./notes.md');
    assert.equal(editor.view.caret, 10);
  });

  it('lets a soft keyboard Enter reach the line as a newline, which is v1 unfixed', () => {
    // PINNING A KNOWN LIMITATION so it is visible rather than accidental.
    //
    // On Android the keydown path is unusable — Chromium issue 462227034 records
    // `key: "Unidentified"` with `keyCode: 229` for virtual-keyboard input, so
    // leg three guards every key including Enter, and Enter arrives only as an
    // input event with `inputType: "insertLineBreak"`. The browser has already
    // put the newline in the field, so the reconcile carries it into the line.
    //
    // v1 did the same thing for the same reason: its guard returned early on 229
    // and the newline landed in the textarea it read as truth. Routing that
    // inputType to accept-line is the fix; it is deliberately not done here,
    // because submitting from an input event means a mis-reported inputType
    // EXECUTES a command and no device was available to rule that out.
    const { editor, adapter, surface } = rig();
    type(adapter, 'Get-Date');
    const guarded = keydown({ key: 'Unidentified', keyCode: 229 });
    assert.deepEqual(adapter.onKeyDown(guarded), { kind: 'ime', leg: 'sentinel-keycode' });

    surface.typeNatively('Get-Date\n');
    adapter.onInput({ isComposing: false });
    assert.equal(editor.view.text, 'Get-Date\n');
    assert.equal(editor.history.entries.length, 0, 'nothing ran — this is the limitation');
  });

  it('does not reconcile when the surface already agrees, so a completion survives', () => {
    // MEASURED: sync()'s setSelectionRange fires selectionchange in Chromium 148,
    // asynchronously, on the element and the document. Without the equality check
    // in the reconcile that would call setBuffer a tick after Tab applied a
    // candidate, and setBuffer resets transient state by design — the menu would
    // close on its own. This is that regression, made deterministic.
    const { editor, adapter } = rig();
    type(adapter, 'Get-C');
    adapter.onKeyDown(keydown({ key: 'Tab' }));
    const menu = editor.view.menu;
    assert.notEqual(menu, null);

    adapter.onSelectionChange();
    adapter.onInput({});
    assert.notEqual(editor.view.menu, null, 'the menu outlived its own sync');
    assert.deepEqual(editor.view.menu, menu);
  });

  it('leaves the surface alone while a composition is in progress', () => {
    // Including through the public sync(), which is on the InputAdapter port and
    // can therefore be called by a host at any moment. Writing `value` during a
    // composition destroys the pre-edit string the IME is still editing, so the
    // mirror invariant is deliberately suspended for the span of a composition.
    const { adapter, surface, editor } = rig();
    type(adapter, 'Get-');
    adapter.onCompositionStart();
    surface.typeNatively('Get-ㄘㄜ');
    adapter.onSelectionChange();
    adapter.onInput({ isComposing: false });
    adapter.sync();
    assert.equal(surface.value, 'Get-ㄘㄜ', 'nothing trampled the pre-edit string');
    assert.equal(editor.view.text, 'Get-', 'and nothing leaked into the core');

    adapter.onCompositionEnd({ data: '測' });
    assert.equal(surface.value, 'Get-測', 'the mirror is restored on commit');
  });

  it('reports every state change through onEffect, including the ones that are not keys', () => {
    const { adapter, effects } = rig();
    type(adapter, 'ab');
    adapter.onCompositionStart();
    adapter.onCompositionEnd({ data: '測' });
    adapter.onKeyDown(keydown({ key: 'Enter' }));
    assert.deepEqual(
      effects.map((e) => e.kind),
      ['none', 'none', 'none', 'none', 'submit'],
    );
  });
});

describe('preventDefault, which decides who owns the keystroke', () => {
  it('claims a key the core handled and releases one it did not', () => {
    // MEASURED, both engines: preventDefault on keydown suppresses beforeinput
    // and input entirely. So this is exactly the switch between "the core edited
    // the line" and "the browser will, and onInput reconciles the result".
    const { adapter } = rig();

    const handled = keydown({ key: 'a', keyCode: 65 });
    assert.equal(adapter.onKeyDown(handled).kind, 'handled');
    assert.equal(handled.prevented, 1);

    // Ctrl+V has no binding, so the browser pastes and onInput picks it up —
    // which is how v1's paste worked, through the native textarea.
    const paste = keydown({ key: 'v', ctrlKey: true, keyCode: 86 });
    assert.deepEqual(adapter.onKeyDown(paste), { kind: 'passed-through', reason: 'unhandled' });
    assert.equal(paste.prevented, 0);

    const composing = keydown({ key: 'Enter', isComposing: true });
    assert.equal(adapter.onKeyDown(composing).kind, 'ime');
    assert.equal(composing.prevented, 0);
  });

  it('claims a bound chord even when the binding had nothing to do', () => {
    // ArrowLeft at column 0 rings the bell. It is still preventDefault-ed,
    // because a bound chord whose effect depends on the caret would otherwise
    // fall through to the browser at one position and not at the others.
    const { adapter } = rig();
    const event = keydown({ key: 'ArrowLeft' });
    assert.deepEqual(adapter.onKeyDown(event), { kind: 'handled', effect: { kind: 'bell', action: 'move-left' } });
    assert.equal(event.prevented, 1);
  });

  it('lets Ctrl+C copy when there is a selection, and cancel when there is not', () => {
    // v1: `if(String(getSelection())) return;` before Ctrl+C cancelled the line.
    // The gesture is "select some transcript, press Ctrl+C", which is a question
    // about the document, so the host answers it.
    let selected = true;
    const { editor, adapter } = rig({ hasSelection: () => selected });
    type(adapter, 'Get-Date');

    const copy = keydown({ key: 'c', ctrlKey: true, keyCode: 67 });
    assert.deepEqual(adapter.onKeyDown(copy), { kind: 'passed-through', reason: 'selection-copy' });
    assert.equal(copy.prevented, 0);
    assert.equal(editor.view.text, 'Get-Date', 'the line survived the copy');

    selected = false;
    const cancel = keydown({ key: 'c', ctrlKey: true, keyCode: 67 });
    assert.deepEqual(adapter.onKeyDown(cancel), {
      kind: 'handled',
      effect: { kind: 'cancel', line: 'Get-Date' },
    });
    assert.equal(cancel.prevented, 1);
    assert.equal(editor.view.text, '');
  });

  it('defaults the selection question to the field itself', () => {
    const { editor, adapter, surface } = rig();
    type(adapter, 'Get-Date');
    surface.selectionStart = 0;
    surface.selectionEnd = 8;
    assert.equal(adapter.onKeyDown(keydown({ key: 'c', ctrlKey: true })).kind, 'passed-through');
    assert.equal(editor.view.text, 'Get-Date');
  });
});

describe('the surface port', () => {
  it('is satisfied by a real HTMLTextAreaElement, as lib.dom declares one', () => {
    // Compile-time only — there is no textarea in this process. `npm run
    // typecheck` fails here if `TextareaLike` drifts from what the DOM actually
    // offers, which is the risk of declaring a structural port instead of using
    // the DOM type. It is why the port can be faked in fifteen lines above.
    const accept = (surface: TextareaLike): TextareaLike => surface;
    const fromDom: (element: HTMLTextAreaElement) => TextareaLike = accept;
    assert.equal(typeof fromDom, 'function');
  });

  it('renames a DOM keydown into the core vocabulary without inventing anything', () => {
    assert.deepEqual(toEditorKeyEvent(keydown({ key: 'a' })), {
      key: 'a',
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
      isComposing: false,
    });
    assert.deepEqual(toEditorKeyEvent(keydown({ key: 'W', ctrlKey: true, shiftKey: true, isComposing: true })), {
      key: 'W',
      ctrl: true,
      alt: false,
      shift: true,
      meta: false,
      isComposing: true,
    });
    // `key` is copied verbatim; the core's normalizeKey owns the aliases, and
    // folding them twice would mean two tables to keep in step.
    assert.equal(toEditorKeyEvent(keydown({ key: 'Esc' })).key, 'Esc');
  });

  it('attaches and detaches idempotently', () => {
    const { adapter, surface } = rig();
    const port: InputAdapter = adapter;
    assert.equal(port.attached, false);
    port.attach();
    port.attach();
    assert.equal(port.attached, true);
    assert.deepEqual(
      [...surface.listeners.keys()].sort(),
      ['click', 'compositionend', 'compositionstart', 'compositionupdate', 'input', 'keydown'],
    );
    port.detach();
    port.detach();
    assert.equal(port.attached, false);
    assert.equal(surface.listeners.size, 0);
  });

  it('routes a real event through the listeners it registered', () => {
    // The handlers are public so the suite can drive them directly; this is the
    // one test that proves attach() wired them to the right names.
    const { editor, adapter, surface } = rig();
    adapter.attach();

    surface.dispatch('keydown', keydown({ key: 'x', keyCode: 88 }));
    assert.equal(editor.view.text, 'x');
    assert.equal(surface.value, 'x');

    surface.dispatch('compositionstart', {});
    assert.equal(editor.composing, true);
    surface.dispatch('keydown', keydown({ key: 'Enter' }));
    assert.equal(editor.history.entries.length, 0, 'the guard is on the wired path too');

    surface.dispatch('compositionend', { data: '測' });
    assert.equal(editor.view.text, 'x測');
    assert.equal(surface.value, 'x測');
  });
});
