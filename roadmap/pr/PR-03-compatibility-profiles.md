# 3. Express 7.6.5 and 7.7.0-preview.4 as compatibility profiles

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** Ground truth  
**Status** [~] in progress  
**Tasks** 8/8 `##################`

## Why

Adding a PowerShell version must never mean forking a command. Version differences belong in data that commands read, not in branches commands contain.

## Depends on

- [x] **2. Mechanise version truth across five axes** — [detail](PR-02-verify-release-truth.md)

## Tasks

- [x] **3.1** Author compat/profiles/powershell-7.6.5-linux.json from the lockfile
  - Generated from the release lockfile plus the metadata captured from real pwsh 7.6.5. No version string is typed by hand.
- [x] **3.2** Author powershell-7.7.0-preview.4-linux.json inheriting from it
  - Baseline values are derived as the inverse of the 7.7 values rather than written separately, so the two profiles cannot silently agree and turn the compatibility layer into a no-op.
- [x] **3.3** Populate behaviors for every 7.7 breaking change, each with a behaviorDocs entry citing its upstream PR
  - CI rejects a behavior key with no doc entry: an undocumented flag is a guess.
- [x] **3.4** Generate compat/deltas/7.6.5__7.7.0-preview.4.json
- [x] **3.5** Mark each delta entry implemented:false until a conformance fixture proves it
  - The UI must say "documented, not emulated" rather than imply fidelity.
- [x] **3.6** Record engineLimits.nativePowerShellEngine=false and the unimplemented AST node list
- [x] **3.7** Record bundled module versions
  - All six modules verified from src/Modules/PSGalleryModules.csproj at each tag. PSResourceGet is the only one that differs (1.2.0 vs 1.3.0-preview1); the rest are pinned identically, so a behaviour difference cannot be blamed on a module version unless it is that one.
- [x] **3.8** Build the profile resolver with deep-merge inheritance and cycle detection
  - A stored profile is a delta, so nothing can read one directly. Resolution merges parent-first, detects inheritance cycles (undetected they hang the session at start with no message), and distinguishes an undeclared behaviour key from one declared null — strict mode throws on the former, because a mistyped key would otherwise make a command behave like an older version forever.

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- Both profiles validate against compatibility-profile.schema.json
- Every behavior key has a behaviorDocs entry with an upstream PR number
- Profiles are generated from the lockfile, with no hand-typed version strings

---

[Back to the roadmap](../../ROADMAP.md)
