# 1. Archive the single-file terminal and capture golden transcripts

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** Ground truth  
**Status** [~] in progress  
**Tasks** 1/5 +2 partial `####///////.......`

## Why

The current index.html is the only specification of how this site behaves. Before any refactor, its behaviour must be frozen as executable expectations, or the rewrite has nothing to be correct against.

## Depends on

Nothing. This can start immediately.

## Tasks

- [/] **1.1** Copy index.html to legacy/terminal-v1.html, unmodified, and pin the commit sha it came from
  - OVER-CLAIMED, corrected 2026-09-06. The copy is faithful in content — identical to index.html once CRLF is normalised — but NOT identical by the very measure this task and legacy/PROVENANCE.md nominate. .gitattributes marks both files `-text`, so git stores each verbatim; index.html was committed with LF and the archive with CRLF, giving blobs 21794ce2 and 234cdfda. PROVENANCE.md prints a `git hash-object` comparison and asserts "Both currently hash to 21794ce2…"; run it and it fails. The archive is usable and is replayed by the test suite, so this is a real half — but a provenance document whose own verification command does not pass is exactly the class of defect this repository exists to hunt, and rounding it to done would repeat it. Fixing it means recommitting the archive with LF endings, which is a change to a frozen artifact and belongs in its own review.
  - *evidence:* `legacy/PROVENANCE.md` matches `/21794ce2250e2ec525eb146fcd688e93407ea90d/`
  - *evidence:* `tests/unit/simulated.test.mts` — test "the simulated command set"
- [x] **1.2** Keep the live site serving the v1 file until the rewrite reaches parity
  - GitHub Pages serves / from index.html. The rewrite must not touch it until conformance passes.
  - *evidence:* `tests/unit/js-literal.test.mts` — test "extracts a script whose text really is inside the file"
  - *evidence:* nothing under `index.html` matches `/type="module"/`
- [/] **1.3** Script a headless capture of every command in CMDLETS + ALIAS + EGGS against v1
  - MISSING: the capture, and most of the corpus. No capture script exists. What exists instead is stronger for what it covers and narrower than the task: tests/unit/simulated-v1-archive.mts brace-slices CMDLETS and EGGS bodies straight out of legacy/terminal-v1.html and evaluates them live, diffing v1 against the rewrite on every run — no recorded output to go stale. It reaches the 26 simulated-fidelity commands and 3 of the 11 eggs. The other ~59 commands and the whole 46-entry ALIAS table have no v1 comparison of any kind.
  - *evidence:* `tests/unit/simulated-v1-archive.mts` exports `v1Cmdlet`
  - *evidence:* `tests/unit/simulated-v1-archive.mts` exports `v1Egg`
  - *evidence:* `tests/unit/simulated-determinism.test.mts` — test "every command is byte-identical across two runs of the same environment"
- [ ] **1.4** Store transcripts as tests/conformance/fixtures/v1/*.txt keyed by command
  - *evidence:* `tests/conformance/fixtures/v1/**/*` matches no file, though `tests/conformance/**/*` does
- [ ] **1.5** Record the 4 seeded history entries and the boot banner as fixtures too
  - *evidence:* `tests/conformance/fixtures/v1/**/*` matches no file, though `tests/conformance/**/*` does

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- legacy/terminal-v1.html has the same git blob hash as the index.html at the recorded sha — the comparison legacy/PROVENANCE.md prints, which does not currently pass
- Every command name reachable from CORPUS has a captured transcript
- A test can replay a transcript and diff it

## Risks

- Easter eggs and async commands (ping/traceroute) stream over time; capture must be deterministic or explicitly excluded

---

[Back to the roadmap](../../ROADMAP.md)
