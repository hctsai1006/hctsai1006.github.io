/**
 * textarea.ts — the real `<textarea>`, demoted from owner of the line to an
 * input surface for it.
 *
 * v1 kept its state IN the textarea: `val()` was `edit.value`, `caretPos()` was
 * `edit.selectionStart`, and every feature that wanted to know what the user had
 * typed asked the DOM. That is the coupling PR-05 exists to break. Here
 * `LineEditor` is the only authority; the textarea holds a copy, and every event
 * either reconciles the copy back into the core or is replayed from the core
 * onto the copy.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TEXTAREA STAYS AT ALL, AND WHY IT STILL HOLDS THE TEXT
 * ---------------------------------------------------------------------------
 *
 * The obvious simplification is a textarea that is always empty — a keystroke
 * funnel that is drained on every `input` event, so nothing can be out of step
 * because there is only ever one copy. That was the first design here and it was
 * rejected, because everything the textarea is being kept FOR needs the text to
 * be in it:
 *
 *   - An IME composes against surrounding context. 注音 and Japanese conversion
 *     read the text to the left of the caret; an empty box is a worse candidate
 *     list.
 *   - A soft keyboard's Backspace is `deleteContentBackward` against the field's
 *     own content. With nothing to delete there is nothing to report, and mobile
 *     Backspace stops working — silently, and only on a device.
 *   - Selection, which is the third thing the roadmap says the textarea earns
 *     its place for, is selection OF something.
 *
 * So: mirror, not drain. The cost is one invariant to hold — after any event,
 * `surface.value` equals `editor.view.text` — and `sync()` is the only thing
 * that writes the surface.
 *
 * ---------------------------------------------------------------------------
 * MEASURED, ON 2026-09-06
 * ---------------------------------------------------------------------------
 *
 * Playwright 1.60.0 on Windows NT 10.0 x64, against Chromium 148.0.7778.96 and
 * WebKit 26.4, both headless. Firefox's Playwright build is not installed here,
 * so none of this is a claim about Gecko. The full event traces are in the
 * measurement notes on `ime.ts`.
 *
 *   1. Assigning `textarea.value` fires NO event — not `input`, not
 *      `beforeinput`. Both engines. That is what makes `sync()` safe to call
 *      from inside a handler: writing the core's line back cannot re-enter.
 *   2. Assigning a DIFFERENT string moves the caret to the end of the field
 *      (selectionStart 3 -> 7 in both engines); assigning the IDENTICAL string
 *      leaves it where it was. So `setSelectionRange` after the write is what
 *      keeps the caret, not the equality guard.
 *   3. `preventDefault()` on keydown suppresses `beforeinput` and `input`
 *      entirely, in both engines — an un-prevented Enter logged keydown,
 *      beforeinput, input; a prevented one logged keydown alone. So a key the
 *      core handles produces no reconcile pass at all, and a key it declines is
 *      left to the browser, arriving here later as whatever the browser made of
 *      it (or as nothing, for a key that edits no text).
 *   4. During a composition, `input` fires BEFORE `compositionend`, carrying
 *      `isComposing: true` and `inputType: 'insertCompositionText'`, and the
 *      field already holds the committed text by the time `compositionend`
 *      arrives. `onInput` is written to be correct in either order — see there.
 *   5. `setSelectionRange` did NOT throw on a detached textarea or a
 *      `display: none` one in either engine; it threw `InvalidStateError` on an
 *      `<input type="email">`, which is a control with no selection. v1 wrapped
 *      this call in try/catch and so does this, for that case.
 *   6. A programmatic `setSelectionRange` fires `selectionchange` in Chromium,
 *      asynchronously, on the element and on the document; WebKit 26.4 fired
 *      none. That measurement is why `#reconcile` compares before it writes:
 *      `sync()` -> selectionchange -> reconcile -> `setBuffer` would otherwise
 *      close the completion menu one tick after Tab opened it, because
 *      `LineEditor.setBuffer` resets transient state by design.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 *   - It does not render. The ghost text, the mirror span, the completion
 *     listbox and the terminal transcript are all somebody else's; this reads
 *     `editor.view` only to write the input line back.
 *   - It does not model a selection inside the line. `TextBuffer` has a caret
 *     and no anchor, so an IME composing over a non-collapsed selection is not
 *     represented; the next `sync()` collapses it. v1 had the same hole — its
 *     `setVal` always collapsed — so this is a preserved limitation and not a
 *     new one.
 *   - It does not assume it is the only input source. Nothing is cached: the
 *     composing flag is read from the core on every keydown, and the surface is
 *     compared against the core rather than against a remembered value. A second
 *     adapter (a terminal emulator's own hidden input, say) driving the same
 *     `LineEditor` will be seen, not overwritten.
 *   - It does not make a soft keyboard's Enter submit. On Android the keydown
 *     path is unusable — Chromium issue 462227034 records `key: "Unidentified"`
 *     with `keyCode: 229` for virtual-keyboard input — so Enter arrives only as
 *     `beforeinput`/`input` with `inputType: "insertLineBreak"`, and the newline
 *     the browser already inserted reconciles into the line. v1 behaved the same
 *     way: its guard returned early on 229 and the newline went into the
 *     textarea it was reading as truth. The fix is to route that `inputType` to
 *     `accept-line`, and it is NOT done here on purpose: submitting a command
 *     from an `input` event means a mis-reported `inputType` EXECUTES something,
 *     and no Android device was available to verify it away. It belongs with the
 *     mobile work, next to whoever ends up owning the input element.
 */

import {
  type EditorEffect,
  type LineEditor,
} from '../line-editor/index.ts';
import { imeGuardLeg, toEditorKeyEvent, type ImeGuardLeg, type KeydownLike } from './ime.ts';

/**
 * What a host holds when it does not care which input source is live.
 *
 * Declared beside its only implementation because there is exactly one today.
 * The second — a terminal emulator that owns its own hidden input, which is the
 * shape the render seam may bring — implements these three and nothing else has
 * to change.
 */
export interface InputAdapter {
  /** True while this adapter is listening. */
  readonly attached: boolean;
  attach(): void;
  /** Idempotent, so a host can call it on teardown without tracking state. */
  detach(): void;
  /** Push the core's current line onto the surface. */
  sync(): void;
}

/**
 * The textarea as this adapter uses it.
 *
 * Structural rather than `HTMLTextAreaElement`, for the reason
 * `src/storage/opfs-platform.ts` gives at length: a fake that has to satisfy the
 * full DOM interface is a fake nobody writes, and the whole IME suite has to run
 * in `node --test`. A real textarea satisfies this — asserted at compile time in
 * tests/unit/line-editor-input.test.mts, so the port cannot drift from lib.dom
 * without the typecheck failing.
 *
 * The two listener methods are the exception: they take lib.dom's own
 * `EventListenerOrEventListenerObject` rather than a narrow signature of this
 * module's own. That was tried first and does not compile. `addEventListener` on
 * a DOM element is an overload set whose generic form takes `(ev: any) => any`,
 * and no parameter type but `any` is assignable to it in both directions — `tsc`
 * rejects `(event: never) => void` with "Type 'any' is not assignable to type
 * 'never'". Since `src/input/` is the layer that is ALLOWED to know about the
 * DOM, borrowing one type from it is better than an `any` this repository has
 * none of, and it puts the `as KeyboardEvent` narrowing in `attach()` where a
 * reader expects to find it.
 */
export interface TextareaLike {
  value: string;
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
  setSelectionRange(start: number, end: number): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
}

/** The one field this adapter reads off a `CompositionEvent`. */
export interface CompositionLike {
  /** At `compositionend`, the committed string — empty if it was cancelled. */
  readonly data: string;
}

/** The parts of an `InputEvent` that decide whether a reconcile is due. */
export interface TextInputLike {
  readonly isComposing?: boolean;
}

export interface TextareaInputOptions {
  /**
   * Called after every event that may have changed the core's state, with what
   * the core said about the last input. `{ kind: 'none' }` for the paths that
   * are not keystrokes at all — a composition commit, a reconcile — because the
   * host still has to redraw.
   */
  readonly onEffect?: (effect: EditorEffect) => void;
  /**
   * Whether the page currently holds a selection the user would expect Ctrl+C to
   * copy. v1 asked `window.getSelection()`, which in a textarea-focused page
   * answers about the TRANSCRIPT, not the input line — the gesture being
   * protected is "select some output, press Ctrl+C". That is a question about
   * the whole document, so it is the host's to answer; the default covers only
   * the input line's own selection.
   */
  readonly hasSelection?: () => boolean;
}

export type KeydownOutcome =
  /** An IME owns this keystroke. Nothing was preventDefault'd. */
  | { readonly kind: 'ime'; readonly leg: ImeGuardLeg }
  /** Left to the browser, which is v1's fall-through to the native textarea. */
  | { readonly kind: 'passed-through'; readonly reason: PassThroughReason }
  | { readonly kind: 'handled'; readonly effect: EditorEffect };

export type PassThroughReason =
  /** No binding and not text. */
  | 'unhandled'
  /** The core refused it as a composition key even though the guard let it by. */
  | 'composing'
  /** Ctrl+C with something selected: a copy, not a cancel. */
  | 'selection-copy';

export class TextareaInputAdapter implements InputAdapter {
  readonly #editor: LineEditor;
  readonly #surface: TextareaLike;
  readonly #onEffect: ((effect: EditorEffect) => void) | undefined;
  readonly #hasSelection: () => boolean;
  #bindings: readonly (readonly [string, EventListener])[] | null = null;

  constructor(editor: LineEditor, surface: TextareaLike, options: TextareaInputOptions = {}) {
    this.#editor = editor;
    this.#surface = surface;
    this.#onEffect = options.onEffect;
    this.#hasSelection =
      options.hasSelection ??
      ((): boolean => {
        const start = this.#surface.selectionStart;
        const end = this.#surface.selectionEnd;
        return start !== null && end !== null && start !== end;
      });
  }

  get attached(): boolean {
    return this.#bindings !== null;
  }

  attach(): void {
    if (this.#bindings !== null) return;
    // The narrowing casts are the ordinary DOM ones: a listener registered for
    // `keydown` receives a `KeyboardEvent`, and lib.dom's `KeyboardEvent`,
    // `CompositionEvent` and `InputEvent` each already satisfy the small
    // interface the matching handler asks for.
    const bindings: (readonly [string, EventListener])[] = [
      ['keydown', (event): void => void this.onKeyDown(event as KeyboardEvent)],
      ['compositionstart', (): void => this.onCompositionStart()],
      ['compositionupdate', (): void => this.onCompositionUpdate()],
      ['compositionend', (event): void => this.onCompositionEnd(event as CompositionEvent)],
      ['input', (event): void => this.onInput(event as InputEvent)],
      // v1 listened for click, for keyup on ArrowLeft/ArrowRight/Home/End, and
      // for the document's selectionchange. The keyup listener is not carried
      // over: those four are bound chords here, so the core moved the caret and
      // there is nothing for a keyup to correct. Click is the caret move that is
      // left, plus a drag on a touch screen. `document.selectionchange` is not
      // wired here because reaching for a global from inside an adapter is what
      // makes one untestable — `onSelectionChange` is public for a host to wire.
      ['click', (): void => this.onSelectionChange()],
    ];
    for (const [type, listener] of bindings) this.#surface.addEventListener(type, listener);
    this.#bindings = bindings;
  }

  detach(): void {
    const bindings = this.#bindings;
    if (bindings === null) return;
    for (const [type, listener] of bindings) this.#surface.removeEventListener(type, listener);
    this.#bindings = null;
  }

  // ------------------------------------------------------------------ events

  /**
   * The whole IME guard runs here, before anything else and before any decision
   * about `preventDefault`. `imeGuardLeg` carries v1's third leg; the core
   * carries the other two and would refuse the key as well, which is why a
   * `composing` effect coming back is treated as a pass-through rather than
   * asserted impossible. The cost of being wrong in that direction is a stolen
   * candidate keystroke and no way for the user to recover it.
   */
  onKeyDown(event: KeydownLike): KeydownOutcome {
    const leg = imeGuardLeg(event, this.#editor.composing);
    if (leg !== null) return { kind: 'ime', leg };

    const translated = toEditorKeyEvent(event);

    // v1: `if(String(getSelection())) return;` before Ctrl+C cancelled the line.
    // Asked of the resolved ACTION rather than of the letter C, so a rebound
    // cancel keeps the behaviour and a rebound Ctrl+C does not inherit it.
    if (this.#editor.keys.resolve(translated) === 'cancel-line' && this.#hasSelection()) {
      return { kind: 'passed-through', reason: 'selection-copy' };
    }

    const effect = this.#editor.handleKey(translated);
    if (effect.kind === 'unhandled' || effect.kind === 'composing') {
      return { kind: 'passed-through', reason: effect.kind };
    }

    // `bell` is preventDefault'd with the rest: the chord IS bound, the binding
    // just had nothing to do. Letting the browser act on a bound chord would
    // make ArrowLeft at column 0 behave differently from ArrowLeft anywhere else.
    event.preventDefault();
    this.sync();
    this.#emit(effect);
    return { kind: 'handled', effect };
  }

  onCompositionStart(): void {
    // The core closes the completion menu from here, as v1 did: the IME is about
    // to take ArrowUp/ArrowDown/Enter, which are also the menu's keys.
    this.#editor.setComposing(true);
    this.#emit({ kind: 'none' });
  }

  /**
   * v1 had NO `compositionupdate` listener; this one only re-asserts a flag that
   * every sequence measured here has already set. It exists so that an IME which
   * updates without a start still arms the sticky leg, which is the leg that
   * covers engines whose `isComposing` cannot be trusted. Nothing available on
   * this machine behaves that way, so this is defensive and unmeasured — but it
   * is idempotent, and the failure it guards against is the editor eating a
   * candidate keystroke.
   */
  onCompositionUpdate(): void {
    this.#editor.setComposing(true);
  }

  /**
   * Order: clear the flag, then commit. If `insertText` ever threw, an editor
   * stuck with `composing === true` is inert to every key, which is a worse
   * failure than a lost commit.
   *
   * `data` is empty when the user cancelled the composition (measured), and
   * `LineEditor.insertText('')` returns immediately, so there is no branch here.
   */
  onCompositionEnd(event: CompositionLike): void {
    this.#editor.setComposing(false);
    this.#editor.insertText(event.data);
    this.sync();
    this.#emit({ kind: 'none' });
  }

  /**
   * Both guards are load-bearing, and they cover opposite orderings — which are
   * not hypothetical, they are two engines disagreeing in public:
   *
   *   Chrome fires `input` (with `isComposing: true`) BEFORE `compositionend`.
   *   Measured here, and the subject of Chromium issue 40800432, open since 2021,
   *   which asks Chrome to adopt Gecko's order. So the first guard is the one
   *   that fires in practice.
   *
   *   Gecko fires `compositionend` first, and Firefox 136 added a TRAILING
   *   `input` afterwards — Bugzilla 1305387, still open, asks for it to be
   *   removed again. That one arrives with the core already holding the
   *   committed text, so `#reconcile` compares and finds nothing to do.
   *
   *   Safari sent `keydown` and `input` after `compositionend` for nine years
   *   (WebKit 165004). An `input` that arrives before `compositionend` with
   *   `isComposing: false` is stopped by the second guard, the sticky flag.
   */
  onInput(event: TextInputLike): void {
    if (event.isComposing === true || this.#editor.composing) return;
    this.#reconcile();
  }

  /**
   * A caret move the core did not make: a click, a touch drag, a native
   * Home/End on a platform that does not route through keydown.
   */
  onSelectionChange(): void {
    if (this.#editor.composing) return;
    this.#reconcile();
  }

  /**
   * Escape hatch for a `compositionend` that never arrives.
   *
   * v1 had this exposure and no way out of it: if the event is lost the editor
   * is inert to every key and only a reload recovers. No such loss was observed
   * here, and none could be — it is reported on Android IMEs this machine cannot
   * drive. The method costs two lines and turns an unrecoverable state into a
   * recoverable one, so it is here rather than argued about.
   */
  cancelComposition(): void {
    if (!this.#editor.composing) return;
    this.#editor.setComposing(false);
    this.#emit({ kind: 'none' });
  }

  // ------------------------------------------------------------ the two ways

  /**
   * Core -> surface. The only writer of `surface.value` in this file.
   *
   * Refuses while a composition is live. Every internal caller already checks —
   * the guard runs before `onKeyDown` reaches here, and both reconcile paths
   * return early — but this is on the `InputAdapter` port, so a host holding
   * several input sources can call it at any moment, and writing `value` during
   * a composition destroys the pre-edit string the IME is still editing. The
   * mirror invariant is suspended for the span of a composition by design: the
   * field holds the line PLUS the pre-edit, and `onCompositionEnd` restores it.
   */
  sync(): void {
    if (this.#editor.composing) return;
    const view = this.#editor.view;
    // Skipped when nothing changed so that a pure caret move does not touch the
    // field's value at all, leaving its native undo stack and any IME context
    // alone. It is not what protects the caret; `setSelectionRange` is.
    if (this.#surface.value !== view.text) this.#surface.value = view.text;
    try {
      this.#surface.setSelectionRange(view.caret, view.caret);
    } catch {
      // Measured not to throw for a textarea, attached or not, in either engine
      // tested. It is specified to throw `InvalidStateError` on a control with
      // no selection, and `TextareaLike` is an interface a host could satisfy
      // with one. v1 wrapped the same call for the same reason.
    }
  }

  /**
   * Surface -> core, wholesale.
   *
   * A diff would be smaller but would have to guess at intent; the surface has
   * already applied the edit, so handing the core the result is exact. It also
   * matches v1's `input` handler, which closed the menu and dropped history
   * navigation on any native edit — `setBuffer` does both.
   *
   * The equality check is not an optimisation. `sync()` fires `selectionchange`
   * asynchronously in Chromium (measured), so without it every completion would
   * be reconciled away a tick after it was applied.
   */
  #reconcile(): void {
    const text = this.#surface.value;
    const buffer = this.#editor.buffer;
    const caret = this.#surface.selectionStart ?? text.length;
    if (text === buffer.text && caret === buffer.caret) return;
    this.#editor.setBuffer(buffer.replace(text, caret));
    this.#emit({ kind: 'none' });
  }

  #emit(effect: EditorEffect): void {
    this.#onEffect?.(effect);
  }
}
