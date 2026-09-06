# 11. Differential conformance against real pwsh 7.6.5

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** Compatibility  
**Status** [~] in progress  
**Tasks** 5/5 `##################`

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
  - *evidence:* `tests/unit/binder-differential.test.mts` — test "reproduces the reference exactly under the 7.6 profile too, with no exceptions"
- [x] **11.4** Record known-differences.yml for deliberate divergences, with a reason for each
  - STALE todo, corrected 2026-09-06. The file is not merely present: a narrow YAML reader parses it, every entry needs a reason of at least twenty characters and a case id that exists in the corpus, and a test proves the file was really read rather than silently coming back empty.
  - *evidence:* `tools/conformance.mts` exports `runConformance`
  - *evidence:* `tests/conformance/conformance.test.mts` — test "does not count a known gap as evidence of fidelity"
  - *evidence:* `tests/conformance/known-differences.yml` matches `/reason/`
- [x] **11.5** Report per-profile conformance coverage as a number the site can display
  - Both halves landed. Every published profile gets its own row from classifyProfileCoverage, expressed in the ladder src/commands/manifest.ts already defines — declared / partial / implemented / verified — where `verified` is awarded only by a case that agreed with a capture of THAT profile's own version. 7.6.5 reads 10 / 31 commands verified and 0 / 6 behaviour flags proven; 7.7.0-preview.4 reads 0 and 0, because no 7.7 exists to capture from, and showing the two separately is the point: one global percentage would have carried the 7.6.5 measurement across to a version nothing has ever been asked. Neither denominator reads the evidence, so no fraction can be improved by deleting a fixture — the property is a unit test, not a comment. compat/explorer.html renders both rows.
  - *evidence:* `tools/conformance.mts` exports `classifyProfileCoverage`
  - *evidence:* `tests/conformance/report.json` — `profileCoverage.1.commands.verifiedPercent`
  - *evidence:* `tests/unit/conformance-coverage.test.mts` — test "never lets the evidence touch the denominator"
  - *evidence:* `tests/unit/conformance-coverage.test.mts` — test "awards nothing from a capture of a different version, however much evidence there is"
  - *evidence:* `tests/conformance/conformance.test.mts` — test "reports a coverage number for every published profile, not just the one with a fixture"
  - *evidence:* `compat/explorer.html` matches `/How much of this has been checked against a real PowerShell/`
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
