# 4. Extract portfolio data and command manifests out of index.html

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** Core  
**Status** [~] in progress  
**Tasks** 8/9 `################..`

## Why

D (portfolio data) and CMDLETS (67 command entries) are trapped in a 2113-line script. Nothing can be tested or reused while they are.

## Depends on

- [~] **1. Archive the single-file terminal and capture golden transcripts** — [detail](PR-01-archive-and-golden-transcripts.md)

## Tasks

- [x] **4.1** Extract D into typed JSON under src/data
  - Evaluated out of index.html in an isolated VM rather than regex-scraped, because regex-scraping structure is how the 115-to-148 count drift went unnoticed. check-numbers.js now reads src/data/profile.json instead of matching D.stats, and the extractor asserts pubTotal equals pubsFull.length so two counts of one thing can never disagree silently.
  - *evidence:* `src/data/profile.json` — `stats`
  - *evidence:* `tests/unit/check-numbers.test.mts` — test "fails when the snapshot disagrees with src/data instead of trusting the snapshot"
- [x] **4.7** Extract the authoritative v1 command inventory
  - Brace-matched out of index.html: 67 commands, 46 aliases, 11 easter eggs, independently reproducing the architecture survey figures. This is the coverage target the rewrite has to clear.
  - *evidence:* `src/commands/v1-inventory.json` — `counts.commands`
  - *evidence:* `src/commands/v1-inventory.json` — `counts.aliases`
  - *evidence:* `npm run inventory`
- [x] **4.8** Declare a fidelity level for every command
  - native-semantic / browser-backed / simulated / external-runtime, with capabilities and a risk class. The generator refuses to emit a manifest for an unclassified command, and refuses any simulated entry with no note saying what it does NOT do. The split was 23/29/26 when this was written and is 31 native-semantic, 28 browser-backed, 26 simulated across 85 commands today — the number is read from src/commands/manifests.json, not from this sentence.
  - *evidence:* `src/commands/manifest.ts` exports `Fidelity`
  - *evidence:* `src/commands/classification.data.mts` exports `CLASSIFICATION`
  - *evidence:* `npm run manifests`
- [x] **4.9** Derive parameter metadata from the reference implementation
  - v1 declares 36 parameters across 67 commands; real pwsh reports 398 across 43. Manifests take types, positions, switch semantics and validation attributes from the capture where one exists, and mark everything else unverified rather than inventing it.
  - *evidence:* `compat/upstream/v7.6.5/command-metadata.json` — `commands`
  - *evidence:* `src/commands/manifest.ts` exports `ParameterMetadata`
  - *evidence:* `tests/unit/binder-manifests.test.mts` — test "validation attributes recovered from the capture"
- [x] **4.2** Remove the load-time mutation of D.profile (the __STATS__ sentinel patch)
  - STALE todo, corrected 2026-09-06. The rewrite substitutes the sentinel per call instead of patching the array at load, and a test asserts the placeholder never reaches output. index.html still does it the old way, but item 1.2 freezes that file until parity, so the task can only mean "do not reproduce it in the rewrite".
  - *evidence:* `src/commands/portfolio/data.ts` exports `STATS_SENTINEL`
  - *evidence:* `src/commands/portfolio/data.ts` exports `statsLine`
  - *evidence:* `tests/unit/native-portfolio.test.mts` — test "composes the stats line rather than storing it"
- [x] **4.3** Convert each CMDLETS entry into a declarative manifest + separate implementation
  - STALE todo, corrected 2026-09-06. 85 declarative manifests in src/commands/manifests.json, each resolved to a separate implementation module through the registry; nothing is declared without an implementation behind it.
  - *evidence:* `src/commands/manifest.ts` exports `CommandManifest`
  - *evidence:* `src/commands/registry.ts` exports `ALL_COMMANDS`
  - *evidence:* `tests/unit/registry.test.mts` — test "names the manifest gap rather than silently allowing it"
- [x] **4.4** Break the command-table/filesystem cycle
  - STALE todo, corrected 2026-09-06. src/storage/seed.ts takes an explicit `binaries` list and imports nothing from the command layer it exists to unblock, which is exactly the binNames list this task asks for.
  - *evidence:* `src/storage/seed.ts` exports `SeedOptions`
  - *evidence:* nothing under `src/storage/**/*.ts` matches `/commands/registry/`
  - *evidence:* `src/storage/seed.ts` exports `buildSeed`
- [x] **4.5** Unify command resolution so aliases and easter eggs share one lookup order
  - STALE todo, corrected 2026-09-06. One index covers every command name and alias; the former easter eggs are ordinary simulated-fidelity entries in it, and v1's sl collision is an explicit documented shadow rather than a second lookup path.
  - *evidence:* `src/commands/registry.ts` exports `resolveCommand`
  - *evidence:* `src/commands/rewrite-inventory.data.mts` exports `SHADOWED_V1_TOKENS`
  - *evidence:* `tests/unit/registry.test.mts` — test "is case-insensitive and includes aliases"
- [ ] **4.6** Delete the dead `hidden` flag that no entry ever sets, and the unused GROUPNAME/ED.path/ED.wantCol
  - Two of the four are gone from the rewrite (ED.path, ED.wantCol have no occurrence in src/). GROUPNAME was not deleted but repurposed as a live exported constant in src/storage/seed.ts, and `hidden` is still declared in tools/extract-command-inventory.mts because the v1 extractor models v1 faithfully.
  - *evidence:* nothing under `src/**/*.ts` matches `/wantCol/`
  - *evidence:* `tools/extract-command-inventory.mts` matches `/hidden/`

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- check-numbers.js still passes
- No module-level mutation of portfolio data
- Command manifests are serialisable

---

[Back to the roadmap](../../ROADMAP.md)
