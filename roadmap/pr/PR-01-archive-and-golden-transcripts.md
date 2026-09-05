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
  - The stated criterion was false as written, and was corrected rather than rounded to done. .gitattributes marks BOTH files `-text` on purpose, so git stores each verbatim and never normalises: index.html was committed with LF and the archive with CRLF, giving blobs 21794ce2 and 234cdfda. PROVENANCE.md used to print a `git hash-object` comparison asserting "both currently hash to 21794ce2"; running it failed. Two independent reviews found this separately. The document now states both blobs and names the identity that DOES hold — the same content once CRLF is folded, dc9570a7 — with a verification command that passes and a test asserting it. The archive itself was not touched: recommitting a frozen artifact to change its line endings is a change to the thing being preserved.
  - *evidence:* `legacy/PROVENANCE.md` matches `/dc9570a7/`
  - *evidence:* `tests/unit/v1-transcripts.test.mts` — test "is the same content as the index.html the site serves"
- [x] **1.2** Keep the live site serving the v1 file until the rewrite reaches parity
  - GitHub Pages serves / from index.html. The rewrite must not touch it until conformance passes.
  - *evidence:* nothing under `index.html` matches `/type="module"/`
  - *evidence:* `tests/unit/js-literal.test.mts` — test "extracts a script whose text really is inside the file"
- [x] **1.3** Script a headless capture of every command in CMDLETS + ALIAS + EGGS against v1
  - 67 cmdlets, 46 aliases and 11 easter eggs, deduplicated to 126 distinct invocations. tools/capture-v1.mts drives real headless Chromium. The command list is read from the RUNNING page and cross-checked against the archive literals and v1-inventory.json, because an enumeration that reads the same file the coverage check reads cannot detect a command that file is missing. All three readings agree exactly.
  - *evidence:* `tools/capture-v1.mts` exports `runCapture`
  - *evidence:* `tools/browser-harness.mts` matches `/chromium/`
  - *evidence:* `tests/unit/v1-transcripts.test.mts` — test "still defines the five literals the capture reads"
- [x] **1.4** Store transcripts as tests/conformance/fixtures/v1/*.txt keyed by command
  - 128 files, 1102 printed rows, one row per line and nothing else. Sealed by a manifest of per-file sha256 digests over newline-normalised content, so a hand-edited transcript fails the hermetic gate without needing a browser to notice.
  - *evidence:* `tests/unit/v1-transcripts.test.mts` — test "has a transcript on disk for every case, matching its recorded digest"
  - *evidence:* `tests/unit/v1-transcripts.test.mts` — test "has no transcript that no case claims"
- [x] **1.5** Record the 4 seeded history entries and the boot banner as fixtures too
  - __boot.txt and __history.txt. The seeded history prints nothing, so without a fixture of its own there would be no evidence of it anywhere.
  - *evidence:* `tests/unit/v1-transcripts.test.mts` — test "has a manifest digest that recomputes"
- [x] **1.6** Classify every source of nondeterminism by measurement, not by reading
  - Each case runs twice under one pinned environment and once under each of four single-axis variants. 3 commands read the clock, 3 the random source, 6 render a stored time in local time, and 2 change with the LOCALE — that last axis was expected to be inert and is not: nothing in v1 calls toLocale*, but V8 localises the zone name inside Date.prototype.toString(), so one frozen instant prints "(Coordinated Universal Time)" or "(Koordinierte Weltzeit)". Reduced motion is load-bearing too: ping is 11 rows with it and 2 without.
  - *evidence:* `tools/capture-v1.mts` matches `/prefers-reduced-motion/`
  - *evidence:* `tests/unit/v1-transcripts.test.mts` — test "is the archive the fixtures were captured from"

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- legacy/terminal-v1.html is the same document as index.html at the recorded sha — MEASURED as identical after newline normalisation, not byte for byte: .gitattributes declares both -text on purpose, so the archive keeps its original CRLF and the two git blobs differ permanently
- Every command name reachable from CORPUS has a captured transcript — CORPUS rebuilt from the archive literals, never read back from the fixtures
- A test can replay a transcript and diff it — npm run test:browser re-executes all 128 cases against real Chromium

## Risks

- Easter eggs and async commands (ping/traceroute) stream over time; capture must be deterministic or explicitly excluded — RESOLVED by taking the prefers-reduced-motion branch v1 already has, which prints the batch synchronously, and proving it with a settle check rather than assuming it

---

[Back to the roadmap](../../ROADMAP.md)
