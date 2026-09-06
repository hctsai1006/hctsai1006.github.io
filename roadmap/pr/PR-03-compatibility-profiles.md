# 3. Express 7.6.5 and 7.7.0-preview.4 as compatibility profiles

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** Ground truth  
**Status** [~] in progress  
**Tasks** 7/8 +1 partial `################//`

## Why

Adding a PowerShell version must never mean forking a command. Version differences belong in data that commands read, not in branches commands contain.

## Depends on

- [x] **2. Mechanise version truth across five axes** — [detail](PR-02-verify-release-truth.md)

## Tasks

- [x] **3.1** Author compat/profiles/powershell-7.6.5-linux.json from the lockfile
  - Generated from the release lockfile plus the metadata captured from real pwsh 7.6.5. No version string is typed by hand.
  - *evidence:* `compat/profiles/powershell-7.6.5-linux.json` — `displayVersion`
  - *evidence:* `npm run profiles`
- [x] **3.2** Author powershell-7.7.0-preview.4-linux.json inheriting from it
  - Baseline values are derived as the inverse of the 7.7 values rather than written separately, so the two profiles cannot silently agree and turn the compatibility layer into a no-op.
  - *evidence:* `compat/profiles/powershell-7.7.0-preview.4-linux.json` — `inherits`
  - *evidence:* `tools/compat-curation.mts` exports `buildBehaviorTables`
- [x] **3.3** Populate behaviors for every 7.7 breaking change, each with a behaviorDocs entry citing its upstream PR
  - CI rejects a behavior key with no doc entry: an undocumented flag is a guess.
  - *evidence:* `compat/profiles/powershell-7.7.0-preview.4-linux.json` — `behaviorDocs`
  - *evidence:* `tools/compat-curation.mts` exports `primaryPr`
  - *evidence:* `tools/generate-compatibility-profile.mts` matches `/assertBehaviorsDocumented/`
- [x] **3.4** Generate compat/deltas/7.6.5__7.7.0-preview.4.json
  - *evidence:* `compat/deltas/7.6.5__7.7.0-preview.4.json` — `changes.0.upstreamPr`
  - *evidence:* `npm run profiles`
- [/] **3.5** Mark each delta entry implemented:false until a conformance fixture proves it
  - The rule is now the rule the code applies, and the answer it gives is zero. `implemented` used to be a synonym for `emulated` — the boolean projection of the curated four-state `implementation` — so six entries read as implemented on the strength of unit tests written against this project's own behaviour view. The two fields are now separate: `emulated` is what a command can read, `implemented` is `emulated` AND naming a conformance case, and classifyDeltaProof in tools/conformance.mts fails the build if a named case is missing, did not agree, or belongs to a change nothing emulates. `verified` costs a fixture outright, so the two entries claiming it (New-Guid -Empty:$false, Get-Random -Shuffle:$false) were demoted to `implemented`. MISSING: any entry that can name one — 0 of 6 emulated changes are proven. No corpus case exercises any of the six emulated behaviour keys, and adding one means re-capturing the whole fixture: 7.7.0-preview.4 is installed nowhere, and the one host available for a 7.6.5 re-capture runs Windows with updatable help installed, which is recorded in tests/conformance/conformance.test.mts as turning three passing help.* cases into unexplained differences. So the honest move was to make the claim cheap to check and expensive to fake, and let it report 0.
  - *evidence:* `tools/conformance.mts` exports `classifyDeltaProof`
  - *evidence:* `tests/unit/conformance-coverage.test.mts` — test "fails the build when the named case is gone"
  - *evidence:* `tests/unit/conformance-coverage.test.mts` — test "fails the build when "verified" names nothing"
  - *evidence:* `compat/deltas/7.6.5__7.7.0-preview.4.json` — `changes.0.emulated`
  - *evidence:* `compat/deltas/7.6.5__7.7.0-preview.4.json` — `summary.emulated`
  - *evidence:* `tests/conformance/report.json` — `deltaProof.proven`
  - *evidence:* `tools/compat-curation.mts` matches `/is "verified" but names no conformance case/`
- [x] **3.6** Record engineLimits.nativePowerShellEngine=false and the unimplemented AST node list
  - `nativePowerShellEngine: false` was always recorded, and that is the half that protects a visitor from believing a real pwsh is running. `unimplementedAstNodes` was a literal [] in the generator with nothing populating it, and an empty list beside it reads as "every AST node is implemented" — the exact opposite of the truth. It is now IMPORTED: the generator calls unimplementedAstNodes(), which derives 40 node names from what parseForExecution consults, so the declaration cannot drift from the behaviour. Typing the names into the generator instead would have been the same defect one step later. Being derived is not the same as being right: the first derivation read three tables, missed two refusals the parser writes in code (VariableExpressionAst, ErrorExpressionAst) and inherited one name that was never a limit (CommandAst, which is what the & call operator is mapped to for the message). A test that walks every tree the execution parser ACCEPTS now says the list may never name something the engine runs.
  - *evidence:* `compat/profiles/powershell-7.6.5-linux.json` — `engineLimits.nativePowerShellEngine`
  - *evidence:* `compat/profiles/powershell-7.6.5-linux.json` — `engineLimits.notes`
  - *evidence:* `compat/profiles/powershell-7.6.5-linux.json` — `engineLimits.unimplementedAstNodes`
  - *evidence:* `src/language/unimplemented.ts` exports `unimplementedAstNodes`
  - *evidence:* `tests/unit/language-unimplemented.test.mts` — test "declares EXACTLY what the engine refuses, in both profiles"
  - *evidence:* `tools/generate-compatibility-profile.mts` matches `/unimplementedAstNodes()/`
- [x] **3.7** Record bundled module versions
  - All six modules verified from src/Modules/PSGalleryModules.csproj at each tag. PSResourceGet is the only one that differs (1.2.0 vs 1.3.0-preview1); the rest are pinned identically, so a behaviour difference cannot be blamed on a module version unless it is that one.
  - *evidence:* `compat/profiles/powershell-7.6.5-linux.json` — `bundledModules`
  - *evidence:* `compat/deltas/powershell-77-changes.source.mts` exports `BUNDLED_MODULES`
- [x] **3.8** Build the profile resolver with deep-merge inheritance and cycle detection
  - A stored profile is a delta, so nothing can read one directly. Resolution merges parent-first, detects inheritance cycles (undetected they hang the session at start with no message), and distinguishes an undeclared behaviour key from one declared null — strict mode throws on the former, because a mistyped key would otherwise make a command behave like an older version forever.
  - *evidence:* `src/compatibility/profile-resolver.ts` exports `resolveProfile`
  - *evidence:* `src/compatibility/profile-resolver.ts` exports `compatibilityView`
  - *evidence:* `src/compatibility/profile-resolver.ts` exports `ProfileResolutionError`
  - *evidence:* `tests/unit/profile-resolver.test.mts` — test "lets the child override the parameter it does mention"

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- Both profiles validate against compatibility-profile.schema.json
- Every behavior key has a behaviorDocs entry with an upstream PR number
- Profiles are generated from the lockfile, with no hand-typed version strings
- Every delta entry marked implemented names the fixture that proved it (3.5 — enforced by classifyDeltaProof, and vacuous today: 0 of 6 emulated changes can name one)
- engineLimits enumerates the AST nodes the engine will refuse (3.6 — not yet true)

---

[Back to the roadmap](../../ROADMAP.md)
