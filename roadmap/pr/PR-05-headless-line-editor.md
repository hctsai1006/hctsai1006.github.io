# 5. Extract a headless LineEditorCore behind input and render adapters

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** Core  
**Status** [~] in progress  
**Tasks** 5/5 `##################`

## Why

The editor currently owns shell state, history, completion AND rendering, and measures DOM geometry inline. None of it can be tested without a browser.

## Depends on

- [~] **4. Extract portfolio data and command manifests out of index.html** — [detail](PR-04-extract-data-and-manifests.md)

## Tasks

- [x] **5.1** Lift TextBuffer, HistoryEngine, CompletionEngine, PredictionEngine, KeyBindingEngine into pure modules
  - *evidence:* `src/line-editor/text-buffer.ts` exports `TextBuffer`
  - *evidence:* `src/line-editor/history.ts` exports `HistoryEngine`
  - *evidence:* `src/line-editor/completion.ts` exports `CompletionEngine`
  - *evidence:* `src/line-editor/prediction.ts` exports `PredictionEngine`
  - *evidence:* `src/line-editor/keys.ts` exports `KeyBindingEngine`
  - *evidence:* `tests/unit/line-editor.test.mts` — test "names no browser global in any module"
- [x] **5.2** Keep the real textarea as an input adapter only
  - src/input/ holds TextareaInputAdapter behind an InputAdapter port. The textarea still holds the text — a drain-on-every-input design was tried and rejected, because an empty field is what breaks IME context, soft-keyboard Backspace and selection, which are the three things it is being kept for — but LineEditor is now the only authority: every event either reconciles the field into the core or replays the core onto it. STILL OPEN: index.html remains the untouched v1 page, so nothing ships until the conformance suite reaches parity and a later phase wires it.
  - *evidence:* `src/input/textarea.ts` exports `TextareaInputAdapter`
  - *evidence:* `src/input/textarea.ts` exports `InputAdapter`
  - *evidence:* `src/input/textarea.ts` exports `TextareaLike`
  - *evidence:* `tests/unit/line-editor-input.test.mts` — test "writes the core onto the surface after every handled key"
  - *evidence:* `tests/unit/line-editor-input.test.mts` — test "takes a native edit back into the core wholesale"
  - *evidence:* `tests/unit/line-editor-input.test.mts` — test "is satisfied by a real HTMLTextAreaElement, as lib.dom declares one"
- [x] **5.3** Define a TerminalMetrics port so width is injected, not measured via a probe span in #out
  - *evidence:* `src/line-editor/metrics.ts` exports `TerminalMetrics`
  - *evidence:* `src/line-editor/metrics.ts` exports `monospaceMetrics`
  - *evidence:* `src/line-editor/metrics.ts` exports `DEFAULT_METRICS`
  - *evidence:* `tests/unit/line-editor.test.mts` — test "is a port, so a host can inject any measurement it likes"
  - *evidence:* `tests/unit/line-editor-keys.test.mts` — test "takes its page size from the injected metrics, never from a measurement"
- [x] **5.4** Tag every history entry with origin (user | completion | ai | script), cwd and profile
  - So AI-issued commands cannot pollute the user's arrow-key history.
  - *evidence:* `src/line-editor/history.ts` exports `HistoryOrigin`
  - *evidence:* `src/line-editor/history.ts` exports `DEFAULT_NAVIGATION_ORIGINS`
  - *evidence:* `tests/unit/line-editor-history.test.mts` — test "carries provenance on every entry"
  - *evidence:* `tests/unit/line-editor-history.test.mts` — test "leaves agent commands out by default"
- [x] **5.5** Preserve the IME triple-guard (isComposing || composing || keyCode===229)
  - All three legs, split across the seam: the core owns the two it can (per-event isComposing, sticky composing) and src/input/ime.ts owns keyCode === 229, which is named nowhere else in src/ and cannot be, because the headlessness gate forbids the core a DOM identifier. Each leg has a test that neutralises it and asserts the SAME keystroke then gets through, so two legs cannot pass as three. MEASURED 2026-09-06 on Chromium 148.0.7778.96 and WebKit 26.4: a keydown carrying keyCode 229 reports isComposing false and precedes compositionstart, which is the case only the sentinel catches. NOT MEASURED, and marked as such in the source: whether a real OS IME emits that keydown (CDP enters below the keyboard layer), Android/GBoard, old Safari, and Gecko.
  - *evidence:* `tests/unit/line-editor-keys.test.mts` — test "hands every key back while a composition is in progress"
  - *evidence:* `tests/unit/line-editor-keys.test.mts` — test "honours a per-event isComposing flag as well as the sticky one"
  - *evidence:* `src/input/ime.ts` exports `imeGuardLeg`
  - *evidence:* `src/input/ime.ts` exports `IME_SENTINEL_KEYCODE`
  - *evidence:* `tests/unit/line-editor-input.test.mts` — test "stops the keydown that starts a composition, which only the 229 sentinel sees"
  - *evidence:* `tests/unit/line-editor-input.test.mts` — test "stops a mid-composition keydown that reports neither flag, which only the sticky leg sees"
  - *evidence:* `tests/unit/line-editor-input.test.mts` — test "stops a keydown inside a composition this adapter never saw start, which only isComposing sees"
  - *evidence:* `tests/unit/line-editor-input.test.mts` — test "guards a composition keystroke on every engine profile, with and without the compositionstart"
  - *evidence:* `tests/unit/line-editor-input.test.mts` — test "survives Safari sending the confirming keydown after compositionend"
  - *evidence:* `tests/unit/line-editor-input.test.mts` — test "hands back every key between compositionstart and compositionend"
  - *evidence:* nothing under `src/line-editor/**/*.ts` matches `/keyCode/`

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- LineEditorCore has zero DOM imports
- Completion and prediction are unit-testable headlessly
- CJK/IME input still works on mobile

## Risks

- The IME and mobile-selection behaviour of the current textarea is subtle and hard-won; regressions here are user-visible

---

[Back to the roadmap](../../ROADMAP.md)
