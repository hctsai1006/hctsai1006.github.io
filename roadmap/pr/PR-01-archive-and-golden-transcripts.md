# 1. Archive the single-file terminal and capture golden transcripts

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** Ground truth  
**Status** [x] done  
**Tasks** 6/6 `##################`

## Why

The current index.html is the only specification of how this site behaves. Before any refactor, its behaviour must be frozen as executable expectations, or the rewrite has nothing to be correct against.

## Depends on

Nothing. This can start immediately.

## Tasks

- [x] **1.1** Copy index.html to legacy/terminal-v1.html, unmodified, and pin the commit sha it came from
  - Identity is the git blob hash, not raw bytes: core.autocrlf=true means the working tree is CRLF while git stores LF, so a byte comparison against git show fails on an unchanged file.
- [x] **1.2** Keep the live site serving the v1 file until the rewrite reaches parity
  - GitHub Pages serves / from index.html. The rewrite must not touch it until conformance passes.
- [x] **1.3** Script a headless capture of every command in CMDLETS + ALIAS + EGGS against v1
  - 67 cmdlets, 46 aliases, 11 easter eggs, deduplicated to 126 distinct invocations. tools/capture-v1.mts drives real headless Chromium; the command list is read from the RUNNING page and cross-checked against the archive literals and v1-inventory.json, because an enumeration that reads the file the coverage check reads cannot detect a command that file is missing.
- [x] **1.4** Store transcripts as tests/conformance/fixtures/v1/*.txt keyed by command
  - 128 files, 1102 rows, one printed row per line. Sealed by a manifest of per-file sha256 digests over newline-normalised content, so a hand-edited transcript fails the hermetic gate without needing a browser.
- [x] **1.5** Record the 4 seeded history entries and the boot banner as fixtures too
  - __boot.txt and __history.txt. The seeded history prints nothing, so without a fixture of its own there is no evidence of it anywhere.
- [x] **1.6** Classify every source of nondeterminism by measurement, not by reading
  - Each case runs twice under one pinned environment and once under each of four single-axis variants. 3 commands read the clock, 3 the random source, 6 render a stored time in local time, and 2 change with the LOCALE — that last one was expected to be empty and was not: V8 localises the zone name inside Date.prototype.toString().

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- legacy/terminal-v1.html is the same document as index.html at the recorded sha — MEASURED as identical after newline normalisation, not byte for byte: .gitattributes declares both -text on purpose, so the archive keeps its original CRLF and the two git blobs differ permanently
- Every command name reachable from CORPUS has a captured transcript — CORPUS rebuilt from the archive literals, never read back from the fixtures
- A test can replay a transcript and diff it — npm run test:browser re-executes all 128 cases against real Chromium

## Risks

- Easter eggs and async commands (ping/traceroute) stream over time; capture must be deterministic or explicitly excluded — RESOLVED by taking the prefers-reduced-motion branch v1 already has, which prints the batch synchronously, and proving it with a settle check rather than assuming it

---

[Back to the roadmap](../../ROADMAP.md)
