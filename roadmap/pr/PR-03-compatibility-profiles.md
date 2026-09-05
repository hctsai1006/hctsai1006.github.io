# 3. Express 7.6.5 and 7.7.0-preview.4 as compatibility profiles

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** Ground truth  
**Status** [~] in progress  
**Tasks** 6/8 +2 partial `##############////`

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
  - MISSING: the fixture link, which is the whole mechanism. `implemented` is derived from a hand-curated four-state `implementation` field (isEmulated in tools/compat-curation.mts), and `conformanceFixture` is hardcoded null on all 22 entries. Five are implemented:true with no fixture behind any of them — proven instead by unit tests against a synthetic behaviour view, which is a different and weaker claim than agreement with a real pwsh. The reason is real (7.7.0-preview.4 is installed nowhere to capture from) and the honest half is delivered: unemulated changes are labelled "documented, not emulated" in the explorer and cannot reach execution. But the rule this task states is not the rule the code applies.
  - *evidence:* `tools/compat-curation.mts` exports `isEmulated`
  - *evidence:* `compat/deltas/7.6.5__7.7.0-preview.4.json` — `changes.0.implementation`
  - *evidence:* `tests/unit/native-commands.test.mts` — test "follows the newGuid.defaultVersion behaviour flag, never a version check"
- [/] **3.6** Record engineLimits.nativePowerShellEngine=false and the unimplemented AST node list
  - MISSING: the list. `nativePowerShellEngine: false` is genuinely recorded in both profiles, and that is the half that protects a visitor from believing a real pwsh is running. `unimplementedAstNodes` is a literal [] in the generator with nothing populating it, and an empty list reads as "every AST node is implemented" — the exact opposite of the truth, since item 8 has not written a parser at all. It cannot be filled honestly until there is an AST to enumerate.
  - *evidence:* `compat/profiles/powershell-7.6.5-linux.json` — `engineLimits.nativePowerShellEngine`
  - *evidence:* `compat/profiles/powershell-7.6.5-linux.json` — `engineLimits.notes`
  - *evidence:* nothing under `src/**/*.ts` matches `/AstNodeKind/`
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
- Every delta entry marked implemented names the fixture that proved it (3.5 — not yet true)
- engineLimits enumerates the AST nodes the engine will refuse (3.6 — not yet true)

---

[Back to the roadmap](../../ROADMAP.md)
