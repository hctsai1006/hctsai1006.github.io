# 5. Extract a headless LineEditorCore behind input and render adapters

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** Core  
**Status** [~] in progress  
**Tasks** 3/5 +1 partial `###########////...`

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
- [ ] **5.2** Keep the real textarea as an input adapter only
  - It earns its place for IME, soft keyboards and selection; it must stop owning state. The core defines the seam (EditorKeyEvent, insertText, setComposing) but no adapter has been written, and the live textarea is still the untouched v1 one in index.html.
  - *evidence:* nothing under `src/**/*.ts` matches `/InputAdapter/`
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
- [/] **5.5** Preserve the IME triple-guard (isComposing || composing || keyCode===229)
  - MISSING: the third leg. The sticky `composing` state and the per-event `isComposing` flag are both in the core and tested; `keyCode === 229` occurs nowhere in src/ because the core deliberately leaves it to an input adapter that task 5.2 has not built. Two of three legs is not the guard — v1 carries all three precisely because neither of the other two was reliable alone on old Safari and Android IMEs.
  - *evidence:* `tests/unit/line-editor-keys.test.mts` — test "hands every key back while a composition is in progress"
  - *evidence:* `tests/unit/line-editor-keys.test.mts` — test "honours a per-event isComposing flag as well as the sticky one"
  - *evidence:* nothing under `src/**/*.ts` matches `/keyCode/`

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- LineEditorCore has zero DOM imports
- Completion and prediction are unit-testable headlessly
- CJK/IME input still works on mobile

## Risks

- The IME and mobile-selection behaviour of the current textarea is subtle and hard-won; regressions here are user-visible

---

[Back to the roadmap](../../ROADMAP.md)
