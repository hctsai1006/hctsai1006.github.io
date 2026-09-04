# 5. Extract a headless LineEditorCore behind input and render adapters

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** Core  
**Status** [ ] todo  
**Tasks** 0/5 `..................`

## Why

The editor currently owns shell state, history, completion AND rendering, and measures DOM geometry inline. None of it can be tested without a browser.

## Depends on

- [~] **4. Extract portfolio data and command manifests out of index.html** — [detail](PR-04-extract-data-and-manifests.md)

## Tasks

- [ ] **5.1** Lift TextBuffer, HistoryEngine, CompletionEngine, PredictionEngine, KeyBindingEngine into pure modules
- [ ] **5.2** Keep the real textarea as an input adapter only
  - It earns its place for IME, soft keyboards and selection; it must stop owning state.
- [ ] **5.3** Define a TerminalMetrics port so width is injected, not measured via a probe span in #out
- [ ] **5.4** Tag every history entry with origin (user | completion | ai | script), cwd and profile
  - So AI-issued commands cannot pollute the user's arrow-key history.
- [ ] **5.5** Preserve the IME triple-guard (isComposing || composing || keyCode===229)

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- LineEditorCore has zero DOM imports
- Completion and prediction are unit-testable headlessly
- CJK/IME input still works on mobile

## Risks

- The IME and mobile-selection behaviour of the current textarea is subtle and hard-won; regressions here are user-visible

---

[Back to the roadmap](../../ROADMAP.md)
