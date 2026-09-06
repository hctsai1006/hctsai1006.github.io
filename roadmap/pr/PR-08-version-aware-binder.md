# 8. Build one lexer, one AST and a version-aware parameter binder

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** Core  
**Status** [~] in progress  
**Tasks** 6/7 +1 partial `###############///`

## Why

There are currently FOUR independent tokenizers — splitPipe, the execOne regex, parseArgsOf, and the highlighter (which colours >, >> and < that nothing can execute) — plus ad-hoc flag re-parsing inside nine command bodies. Most 7.7 breaking changes are binder-level, so the binder must be a first-class component.

## Depends on

- [~] **3. Express 7.6.5 and 7.7.0-preview.4 as compatibility profiles** — [detail](PR-03-compatibility-profiles.md)
- [~] **7. Build the typed object pipeline and stream model** — [detail](PR-07-object-pipeline.md)

## Tasks

- [x] **8.1** Write one lexer with real quote and escape handling
  - One lexer, src/language/lexer.ts, and the last consumer wired to it was the one on the path that RUNS. Execution used to go through the kernel's splitTokens — a whitespace split with no quote handling — so `-Path "my file"` reached the binder as three arguments. It now goes through parseForExecution, and each CommandAst is bound from the AST rather than flattened back to strings, so a quoted `-Force` stays a value instead of binding the switch. tests/unit/lexer-single.test.mts gates this structurally AND behaviourally, and its survivor list is now empty.
  - *evidence:* `src/language/lexer.ts` exports `lex`
  - *evidence:* `src/line-editor/tokenize.ts` exports `tokenize`
  - *evidence:* `tests/unit/lexer-single.test.mts` — test "no module under src/ carries a second quote-state machine"
  - *evidence:* `tests/unit/kernel.test.mts` — test "keeps a quoted argument whole and strips its quotes"
  - *evidence:* nothing under `src/**/*.{ts,mts}` matches `/splitTokens/`
- [x] **8.2** Separate the editing parser (incremental, error-tolerant) from the execution parser (strict)
  - Two entry points over ONE grammar, which is the shape that matters: parseForEditing never throws and is what the highlighter and completion run on every keystroke, and parseForExecution is that same parse plus a gate. The separation is enforced by the type system rather than by convention — parseForExecution returns a branded ExecutableScript that nothing outside parse.ts can construct, so an evaluator typed against it cannot be handed the tolerant parser's output.
  - *evidence:* `src/language/parse.ts` exports `parseForEditing`
  - *evidence:* `src/language/parse.ts` exports `parseForExecution`
  - *evidence:* `tests/unit/language-parse.test.mts` — test "accepts a strict superset of what the execution parser accepts"
  - *evidence:* `tests/unit/language-parse.test.mts` — test "refuses an incomplete line rather than guessing at it"
- [x] **8.3** Refuse to execute recognised-but-unimplemented syntax with an explicit error naming the AST node
  - 37 node types are refused by name, and the names are real: PwshAstNode is the pwsh 7.6.5 hierarchy, so a typo is a compile error. The list is derived from the tables parseForExecution consults rather than declared beside them, and compat/profiles/*.json now publishes it (see 3.6) instead of declaring []. Two mappings were measured rather than guessed: `workflow W { }` is a FunctionDefinitionAst in pwsh, and ConfigurationDefinitionAst really does exist in PS 7 core.
  - *evidence:* `src/language/unimplemented.ts` exports `UNIMPLEMENTED_KEYWORDS`
  - *evidence:* `tests/unit/language-unimplemented.test.mts` — test "every keyword in the table is genuinely refused by the parser"
  - *evidence:* `tests/unit/kernel.test.mts` — test "refuses syntax the engine cannot run, naming the AST node"
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
- [x] **8.7** Make the highlighter share the real lexer so it cannot colour syntax the engine rejects
  - src/language/highlight.ts is computed FROM the parser: it lexes with the one lexer and paints every span parseForExecution refuses with a `refused` class, so it cannot colour something the engine will not run. Checked over a 20,000-input generated corpus rather than on examples.
  - *evidence:* `src/language/highlight.ts` exports `highlight`
  - *evidence:* `tests/unit/lexer-single.test.mts` — test "the highlighter is computed from the parser, not from its own regex"
  - *evidence:* `tests/unit/language-invariants.test.mts` — test "INVARIANT 2: the highlighter never colours a refused span as valid"

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- One tokenizer in the codebase — src/language/lexer.ts, with tests/unit/lexer-single.test.mts asserting that no module under src/ carries a second quote-state machine
- Where-Object -Not:$false behaves per the active profile
- Format-Table -Property "" errors on 7.7 and not on 7.6, from data alone

---

[Back to the roadmap](../../ROADMAP.md)
