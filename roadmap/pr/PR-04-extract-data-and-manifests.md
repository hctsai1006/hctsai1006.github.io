# 4. Extract portfolio data and command manifests out of index.html

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** Core  
**Status** [~] in progress  
**Tasks** 4/9 `########..........`

## Why

D (portfolio data) and CMDLETS (67 command entries) are trapped in a 2113-line script. Nothing can be tested or reused while they are.

## Depends on

- [x] **1. Archive the single-file terminal and capture golden transcripts** — [detail](PR-01-archive-and-golden-transcripts.md)

## Tasks

- [x] **4.1** Extract D into typed JSON under src/data
  - Evaluated out of index.html in an isolated VM rather than regex-scraped, because regex-scraping structure is how the 115-to-148 count drift went unnoticed. check-numbers.js now reads src/data/profile.json instead of matching D.stats, and the extractor asserts pubTotal equals pubsFull.length so two counts of one thing can never disagree silently.
- [x] **4.7** Extract the authoritative v1 command inventory
  - Brace-matched out of index.html: 67 commands, 46 aliases, 11 easter eggs, independently reproducing the architecture survey figures. This is the coverage target the rewrite has to clear.
- [x] **4.8** Declare a fidelity level for every command
  - native-semantic / browser-backed / simulated / external-runtime, with capabilities and a risk class. The generator refuses to emit a manifest for an unclassified command, and refuses any simulated entry with no note saying what it does NOT do. Result: 23 native-semantic, 29 browser-backed, 26 simulated.
- [x] **4.9** Derive parameter metadata from the reference implementation
  - v1 declares 36 parameters across 67 commands; real pwsh reports 398 across 43. Manifests take types, positions, switch semantics and validation attributes from the capture where one exists, and mark everything else unverified rather than inventing it.
- [ ] **4.2** Remove the load-time mutation of D.profile (the __STATS__ sentinel patch)
- [ ] **4.3** Convert each CMDLETS entry into a declarative manifest + separate implementation
- [ ] **4.4** Break the command-table/filesystem cycle
  - buildSeed enumerates CMDLETS to populate /usr/bin, and which queries both. Pass an explicit binNames list instead.
- [ ] **4.5** Unify command resolution so aliases and easter eggs share one lookup order
  - set-location currently reaches into EGGS because sl is both an alias and an egg.
- [ ] **4.6** Delete the dead `hidden` flag that no entry ever sets, and the unused GROUPNAME/ED.path/ED.wantCol

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- check-numbers.js still passes
- No module-level mutation of portfolio data
- Command manifests are serialisable

---

[Back to the roadmap](../../ROADMAP.md)
