# 8. Build one lexer, one AST and a version-aware parameter binder

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** Core  
**Status** [~] in progress  
**Tasks** 2/7 +2 partial `#####/////........`

## Why

There are currently FOUR independent tokenizers — splitPipe, the execOne regex, parseArgsOf, and the highlighter (which colours >, >> and < that nothing can execute) — plus ad-hoc flag re-parsing inside nine command bodies. Most 7.7 breaking changes are binder-level, so the binder must be a first-class component.

## Depends on

- [~] **3. Express 7.6.5 and 7.7.0-preview.4 as compatibility profiles** — [detail](PR-03-compatibility-profiles.md)
- [~] **7. Build the typed object pipeline and stream model** — [detail](PR-07-object-pipeline.md)

## Tasks

- [/] **8.1** Write one lexer with real quote and escape handling
  - MISSING: the "one". A real lexer exists — tokenize() handles quoting, doubled-quote escaping and backticks — but it only serves line-editor completion. Execution still runs on the kernel's splitTokens, which splits on whitespace with no quote handling at all, and the binder carries a third parameter-token classifier of its own. Three token recognisers, which is the defect item 8 was opened about, one short of v1's four.
  - *evidence:* `src/line-editor/tokenize.ts` exports `tokenize`
  - *evidence:* `tests/unit/kernel.test.mts` — test "does not split inside quotes"
  - *evidence:* `src/kernel/kernel.ts` matches `/splitTokens/`
- [ ] **8.2** Separate the editing parser (incremental, error-tolerant) from the execution parser (strict)
  - Error-tolerant parsing must never feed the evaluator. Only the tolerant half exists; there is no strict execution parser to separate it from.
- [ ] **8.3** Refuse to execute recognised-but-unimplemented syntax with an explicit error naming the AST node
  - There is no AST, so there is no node to name. Both the kernel and the PowerShell command support module say so in as many words.
  - *evidence:* nothing under `src/**/*.{ts,mts}` matches `/AstNodeKind/`
- [x] **8.4** Implement ParameterBinder with validation, parameter sets and positional binding
  - STALE todo, corrected 2026-09-06. Named and positional binding, parameter-set narrowing, mandatory checks, coercion and validation attributes are all implemented and are among the most heavily tested code in the repository.
  - *evidence:* `src/binding/binder.ts` exports `bindParameters`
  - *evidence:* `src/binding/binder.ts` exports `tryBindParameters`
  - *evidence:* `src/binding/validation.ts` exports `validate`
  - *evidence:* `tests/unit/binder-manifests.test.mts` — test "binds positional Path then Filter"
  - *evidence:* `tests/unit/binder-manifests.test.mts` — test "rejects -Path together with -LiteralPath"
- [x] **8.5** Support switchSemantics so -Switch:$false differs from -Switch absent
  - STALE todo, corrected 2026-09-06. The mechanism is not named switchSemantics — it is honourExplicitFalse, a per-command, per-parameter behaviour key resolved from the active profile — but it is exactly this, and thirty-odd command/parameter pairs declare it.
  - *evidence:* `src/compatibility/behavior-keys.ts` exports `switchBehaviorKey`
  - *evidence:* `compat/profiles/powershell-7.7.0-preview.4-linux.json` — `behaviors`
  - *evidence:* `tests/unit/binder-switch-scope.test.mts` — test "binds New-Guid -Empty:$false as PRESENT under 7.6 and as FALSE under 7.7"
- [/] **8.6** Apply profile parameterPatches over base metadata rather than forking commands
  - MISSING: the applying. The merge machinery is real and tested — CommandPatch.parameterPatches deep-merges parent-first — but nothing uses it. No shipped profile declares a single parameterPatches entry, and CompatibilityView, the interface the binder and commands actually consume, exposes only behaviour lookups, so no code path reads a patch and overrides parameter metadata before binding.
  - *evidence:* `src/compatibility/profile-resolver.ts` exports `CommandPatch`
  - *evidence:* `tests/unit/profile-resolver.test.mts` — test "lets the child override the parameter it does mention"
  - *evidence:* nothing under `compat/profiles/*.json` matches `/parameterPatches/`
- [ ] **8.7** Make the highlighter share the real lexer so it cannot colour syntax the engine rejects
  - No highlighter has been ported yet, and it is moot until 8.1 leaves one tokenizer to share.

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- One tokenizer in the codebase — three exist today: tokenize, splitTokens and the binder's parameter-token classifier
- Where-Object -Not:$false behaves per the active profile
- Format-Table -Property "" errors on 7.7 and not on 7.6, from data alone

---

[Back to the roadmap](../../ROADMAP.md)
