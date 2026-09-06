/**
 * ime.ts — the DOM half of v1's IME guard, and the rename from a DOM key event
 * to the core's own `EditorKeyEvent`.
 *
 * v1's command-line key handler opened with one line:
 *
 *     if(e.isComposing || composing || e.keyCode===229) return;
 *
 * `src/line-editor/` owns two of those three legs and deliberately owns no more:
 * `keyCode` is a DOM fact and naming it there would fail the headlessness gate
 * in tests/unit/line-editor.test.mts. This file is where the third leg lives, so
 * the guard is whole again across the seam rather than two-thirds of a guard on
 * each side of it.
 *
 * ---------------------------------------------------------------------------
 * WHY THREE LEGS, WHEN ONE WOULD LOOK LIKE ENOUGH
 * ---------------------------------------------------------------------------
 *
 * Each leg answers a question the other two cannot, and the interesting one is
 * the first keystroke of a composition:
 *
 *   sentinel-keycode   Two cases, and the second is not hypothetical.
 *                      (a) The keydown that STARTS a composition. Measured
 *                          below: `isComposing` is false on it (the composition
 *                          has not started yet) and `compositionstart` has not
 *                          fired, so the sticky flag is false too.
 *                      (b) Safari, for nine and a half years. WebKit bug 165004
 *                          (filed 2016-11-21, fixed 2026-04-16) is the
 *                          out-of-order composition events, and comment #4 on it
 *                          is the clearest statement of why this leg exists:
 *                          "The Enter key that accepts the IME input will be
 *                          sent with isComposing === false, because Safari is
 *                          sending events out of order, and keydown/input are
 *                          being sent after compositionend. This makes comparing
 *                          keyCode === 229 the only reliable way to detect
 *                          whether IME is being used or not, even though modern
 *                          APIs are available, because they are giving the wrong
 *                          results." After `compositionend` the sticky flag is
 *                          false as well, so on that Safari both other legs miss
 *                          and the confirming Enter submits the command.
 *   is-composing       The leg that fires on every current engine, and the one
 *                      that has to outlive the others. Every engine surveyed
 *                      sends the sentinel BESIDE the flag, so today this leg is
 *                      rarely the only thing stopping a key — but `keyCode` is
 *                      deprecated, `isComposing` is its specified replacement,
 *                      and an engine that finally drops the legacy key model
 *                      leaves this as the only leg with anything to say. It is
 *                      also what covers a composition whose `compositionstart`
 *                      this adapter never saw: attached mid-composition, or a
 *                      spurious `compositionend` cleared the sticky flag early.
 *   sticky-composing   The only leg that is not a per-event field. It is scoped
 *                      to the composition, so it is the one that survives an
 *                      engine reporting nothing usable on the keystroke itself —
 *                      and it is the ONLY leg that does. No such engine is
 *                      documented in anything found while researching this, and
 *                      saying so is better than implying otherwise; v1's comment
 *                      names 舊 Safari and 部分 Android IME, and the tracker
 *                      record shows those actually send the sentinel. It stays
 *                      anyway, for the reason it was written: deleting a leg
 *                      because today's engines make it look redundant is a
 *                      live-fire experiment on 注音 users, and that same argument
 *                      would have deleted it from v1.
 *
 * The whole matrix — seven engine profiles crossed with whether the
 * `compositionstart` arrived — is in tests/unit/line-editor-input.test.mts,
 * including the one square nothing can save.
 *
 * The failure this prevents is total, not cosmetic: during 注音 composition
 * Enter is candidate confirmation, ArrowUp/ArrowDown page the candidate list and
 * Tab belongs to the IME. A guard that misses one keystroke eats the user's
 * candidate selection and there is no way to get it back.
 *
 * ---------------------------------------------------------------------------
 * MEASURED, ON 2026-09-06
 * ---------------------------------------------------------------------------
 *
 * Playwright 1.60.0, Windows NT 10.0 x64:
 *
 *     Chromium 148.0.7778.96 (headless), driven through CDP `Input.*`
 *     WebKit 26.4 (headless) — no CDP, so the keyboard probes only
 *
 * Firefox's Playwright build is not installed on this machine, so nothing here
 * is a claim about Gecko.
 *
 *   1. `Input.dispatchKeyEvent { windowsVirtualKeyCode: 229 }` arrives as
 *      `keydown key="Process" keyCode=229 isComposing=false`, and a
 *      `compositionstart` requested immediately afterwards fires AFTER it. That
 *      is the whole case for this file: at that keydown the two legs the core
 *      owns are both false.
 *   2. A keydown dispatched while a composition is live reports
 *      `isComposing=true keyCode=13` for Enter. Chromium sets `isComposing` from
 *      the composition state, and does NOT rewrite the key code to 229.
 *   3. A `KeyboardEvent` constructed in script with `isComposing: true` reports
 *      `keyCode: 0` in both engines. `keyCode` is not derived from anything; it
 *      is whatever the engine put there, which is why `=== 229` is a test for a
 *      sentinel and not a range check.
 *   4. A composition driven through `Input.imeSetComposition` emits
 *      compositionstart, then (compositionupdate, beforeinput, input)* with
 *      `isComposing: true` on the input events, then compositionend — so `input`
 *      precedes `compositionend`, and the textarea already holds the committed
 *      text when `compositionend` arrives. `textarea.ts` is written to survive
 *      either order.
 *   5. Cancelling a composition (`imeSetComposition` with an empty string) ends
 *      it with `compositionend data=""`. `LineEditor.insertText('')` is a no-op,
 *      so that path needs no special case.
 *
 * NOT MEASURED HERE, and therefore not claimed as a measurement. Where a browser
 * tracker answers the question, it is cited instead — a bug report with a
 * maintainer's repro is evidence; this file's author reasoning about it is not:
 *
 *   - Whether a real OS IME emits the 229 keydown. CDP's `Input.imeSetComposition`
 *     enters below the keyboard layer and produced NO keydown at all, so the 229
 *     event above had to be synthesised. What was measured is what the ENGINE
 *     does with such an event (`isComposing` stays false), not that Windows 注音
 *     or GBoard sends one.
 *   - Android/GBoard. Chromium issue 462227034 records that Chrome for Android
 *     reports `key: "Unidentified"` with `keyCode: 229` for virtual-keyboard
 *     input, and Chromium issue 41365420 (open since 2018) records `isComposing`
 *     being computed wrongly on `deleteSurroundingText` and
 *     `extendSelectionAndDelete` — the `InputConnection` paths Android IMEs
 *     actually use. So on Android the flag is known-unreliable exactly where the
 *     sentinel appears. No device was available to confirm it here.
 *   - Old Safari. WebKit 165004, quoted above, and WebKit 162921 shows Safari
 *     shipped the `isComposing` ATTRIBUTE in 2016 while returning the wrong value
 *     on the commit keystroke until the 165004 fix — ten years of an API that
 *     existed and could not be trusted. Nothing about WebKit's composition
 *     ordering was measured here either way: Playwright exposes no IME entry
 *     point for WebKit, so the build available (26.4) could only be driven with
 *     ordinary keys. The tracker is the evidence, not this file.
 *   - Gecko. Firefox's Playwright build is not installed here. Per Chromium
 *     462227034's own comparison, Firefox reports `key: "Process"` with
 *     `keyCode: 229` on every platform.
 *
 * ONE SURPRISE WORTH RECORDING, from the same Chromium issue: on Linux, Chrome
 * fires NO keydown at all during a composition. There is nothing there for any
 * leg to catch, and nothing here depends on there being.
 */

import type { EditorKeyEvent } from '../line-editor/index.ts';

/**
 * The sentinel a browser puts in the deprecated `keyCode` while an IME is
 * processing the keystroke. It is not a key: 229 is `VK_PROCESSKEY` from the
 * Windows virtual-key table, surfaced unchanged by the legacy key model.
 */
export const IME_SENTINEL_KEYCODE = 229;

/**
 * The parts of a DOM `KeyboardEvent` this seam reads.
 *
 * Structural and mostly optional, for the same reason `src/storage/` declares
 * its own four-method view of OPFS instead of using `lib.dom`: a real
 * `KeyboardEvent` satisfies it, and so does an object literal in a test, which
 * is what lets the IME cases run in the hermetic suite.
 *
 * `isComposing` and `keyCode` are optional because an engine that predates them
 * has neither, and an absent flag must read as "no information", never as
 * "not composing" — that is what leaves the other two legs to answer.
 */
export interface KeydownLike {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly metaKey?: boolean;
  readonly isComposing?: boolean;
  /**
   * Deprecated in UI Events and load-bearing anyway. Reading it is the point of
   * this module; nothing else in the codebase may.
   */
  readonly keyCode?: number;
  preventDefault(): void;
}

/** Which leg fired, so a test can prove each one carries its own case. */
export type ImeGuardLeg = 'is-composing' | 'sticky-composing' | 'sentinel-keycode';

/**
 * v1's guard, whole, with the leg that fired named instead of collapsed to a
 * boolean. `composing` is the caller's sticky state — read from
 * `LineEditor.composing`, never from a second copy kept here, because two
 * booleans meaning the same thing is the class of bug PR-05 exists to remove.
 *
 * The leg order is v1's. It decides only which name comes back; any leg alone
 * stops the key.
 */
export function imeGuardLeg(event: KeydownLike, composing: boolean): ImeGuardLeg | null {
  if (event.isComposing === true) return 'is-composing';
  if (composing) return 'sticky-composing';
  if (event.keyCode === IME_SENTINEL_KEYCODE) return 'sentinel-keycode';
  return null;
}

/**
 * Rename a DOM keydown into the core's vocabulary.
 *
 * `=== true` rather than a pass-through because `exactOptionalPropertyTypes`
 * distinguishes an absent optional property from one holding `undefined`, and
 * because the core reads these as plain booleans.
 *
 * `key` is copied verbatim. The core's `normalizeKey` already folds `Esc`,
 * `Left` and the rest, and folding twice would mean two tables to keep in step.
 *
 * `Process` and `Unidentified` are passed through unchanged. They are in the
 * core's `NAMED_KEYS` with no binding, so a composition keydown that reached the
 * core would be answered `unhandled` and left to the browser.
 *
 * THAT SOFT LANDING IS PLATFORM-SPECIFIC, AND THE FIRST DRAFT OF THIS COMMENT
 * CLAIMED IT IN GENERAL, WHICH WAS WRONG. Per Chromium issue 462227034 and the
 * triage on it, `key` during a composition is `"Process"` only on Chrome for
 * Windows and on Firefox; Chrome for Android sends `"Unidentified"`; Chrome for
 * macOS and Safari send the REAL key — `"Escape"`, `"な"` — with `keyCode: 229`
 * beside it. On those two, a keystroke that got past the sentinel would be
 * Escape, and Escape is bound. So there is no fallback to rely on and the
 * sentinel is not belt-and-braces; it is the belt. This function special-cases
 * nothing, and `imeGuardLeg` is what has to be right.
 */
export function toEditorKeyEvent(event: KeydownLike): EditorKeyEvent {
  return {
    key: event.key,
    ctrl: event.ctrlKey === true,
    alt: event.altKey === true,
    shift: event.shiftKey === true,
    meta: event.metaKey === true,
    isComposing: event.isComposing === true,
  };
}
