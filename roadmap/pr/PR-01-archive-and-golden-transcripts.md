# 1. Archive the single-file terminal and capture golden transcripts

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** Ground truth  
**Status** [~] in progress  
**Tasks** 2/5 `#######...........`

## Why

The current index.html is the only specification of how this site behaves. Before any refactor, its behaviour must be frozen as executable expectations, or the rewrite has nothing to be correct against.

## Depends on

Nothing. This can start immediately.

## Tasks

- [x] **1.1** Copy index.html to legacy/terminal-v1.html, unmodified, and pin the commit sha it came from
  - Identity is the git blob hash, not raw bytes: core.autocrlf=true means the working tree is CRLF while git stores LF, so a byte comparison against git show fails on an unchanged file.
- [x] **1.2** Keep the live site serving the v1 file until the rewrite reaches parity
  - GitHub Pages serves / from index.html. The rewrite must not touch it until conformance passes.
- [ ] **1.3** Script a headless capture of every command in CMDLETS + ALIAS + EGGS against v1
  - 67 cmdlets, 46 aliases, 11 easter eggs — enumerated in the architecture survey.
- [ ] **1.4** Store transcripts as tests/conformance/fixtures/v1/*.txt keyed by command
- [ ] **1.5** Record the 4 seeded history entries and the boot banner as fixtures too

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- legacy/terminal-v1.html is byte-identical to the index.html at the recorded sha
- Every command name reachable from CORPUS has a captured transcript
- A test can replay a transcript and diff it

## Risks

- Easter eggs and async commands (ping/traceroute) stream over time; capture must be deterministic or explicitly excluded

---

[Back to the roadmap](../../ROADMAP.md)
