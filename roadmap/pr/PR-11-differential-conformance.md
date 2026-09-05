# 11. Differential conformance against real pwsh 7.6.5

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** Compatibility  
**Status** [~] in progress  
**Tasks** 4/5 +1 partial `##############////`

## Why

Fidelity claims need evidence. pwsh 7.6.5 on .NET 10.0.11 is installed on the dev machine, so the LTS track can be differential-tested today without CI or Docker.

## Depends on

- [~] **8. Build one lexer, one AST and a version-aware parameter binder** — [detail](PR-08-version-aware-binder.md)

## Tasks

- [x] **11.1** Write generate-conformance-fixtures.ps1 to capture real pwsh output for a command corpus
  - STALE todo, corrected 2026-09-06. It captures the 115-case corpus against real pwsh, runs each case twice to prove determinism, and seals every case and the document with a sha256 over a canonical projection so an edited recording is reported as tampering rather than as a defect in the project.
  - *evidence:* `tests/conformance/fixtures/pwsh-7.6.5.json` — `cases`
  - *evidence:* `tests/conformance/fixtures/pwsh-7.6.5.json` — `integrity`
  - *evidence:* `npm run capture:conformance`
  - *evidence:* `tests/conformance/conformance.test.mts` — test "actually compared something"
- [x] **11.2** Normalise machine-specific output (paths, times, pids, widths) before comparison
  - STALE todo, corrected 2026-09-06. Nine normalisation rules cover line endings, machine paths, username, hostname, pid, guid, ISO timestamp, clock time and trailing space, with residue detectors for what normalisation cannot fix.
  - *evidence:* `tests/conformance/fixtures/pwsh-7.6.5.json` — `normalisation`
  - *evidence:* `tools/generate-conformance-fixtures.ps1` matches `/NormalisationRules/`
- [x] **11.3** Capture Get-Command metadata from real pwsh to validate our manifests
  - Done for 7.6.5 via tools/capture-pwsh-metadata.ps1: 43 commands, 398 declared parameters, with types, parameter sets, positions, pipeline binding and validation attributes. It already proves four 7.7 deltas against the reference implementation — Format-Table -Property carries no attributes in 7.6.5, and -ExcludeProperty and Join-Path -Extension do not exist there.
  - *evidence:* `compat/upstream/v7.6.5/command-metadata.json` — `commands`
  - *evidence:* `compat/upstream/v7.6.5/command-metadata.json` — `requested`
  - *evidence:* `npm run capture:metadata`
  - *evidence:* `tests/unit/binder-manifests.test.mts` — test "the manifest file still has the shape the binder reads"
- [x] **11.4** Record known-differences.yml for deliberate divergences, with a reason for each
  - STALE todo, corrected 2026-09-06. The file is not merely present: a narrow YAML reader parses it, every entry needs a reason of at least twenty characters and a case id that exists in the corpus, and a test proves the file was really read rather than silently coming back empty.
  - *evidence:* `tools/conformance.mts` exports `runConformance`
  - *evidence:* `tests/conformance/conformance.test.mts` — test "does not count a known gap as evidence of fidelity"
  - *evidence:* `tests/conformance/known-differences.yml` matches `/reason/`
- [/] **11.5** Report per-profile conformance coverage as a number the site can display
  - MISSING: the per-profile part, and the display. The number itself is real and hard to forge — coverage is credited only where the connection between a case and a command can be established mechanically, after relabelling twenty-four cases was shown to move it from 38.7% to 100% with zero problems reported — and `npm run conformance -- --check` gates it. But there is exactly one fixture, for 7.6.5, so "per-profile" is aspirational; and nothing renders it: the explorer page never mentions coverage, and no other page in the repository does either.
  - *evidence:* `tests/conformance/report.json` — `coverage.behaviouralCoveragePercent`
  - *evidence:* `tests/conformance/conformance.test.mts` — test "counts coverage from established credits, never from the corpus label"
  - *evidence:* `tests/conformance/fixtures/pwsh-7.7*` matches no file, though `tests/conformance/**/*` does

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- A fixture mismatch fails CI
- Every divergence is either fixed or listed with a reason
- Coverage is a measured number, not a claim

## Risks

- 7.7-preview.4 needs a side-by-side install or CI container; the 7.6.5 track works locally today

---

[Back to the roadmap](../../ROADMAP.md)
