# 11. Differential conformance against real pwsh 7.6.5

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** Compatibility  
**Status** [~] in progress  
**Tasks** 1/5 `####..............`

## Why

Fidelity claims need evidence. pwsh 7.6.5 on .NET 10.0.11 is installed on the dev machine, so the LTS track can be differential-tested today without CI or Docker.

## Depends on

- [ ] **8. Build one lexer, one AST and a version-aware parameter binder** — [detail](PR-08-version-aware-binder.md)

## Tasks

- [ ] **11.1** Write generate-conformance-fixtures.ps1 to capture real pwsh output for a command corpus
- [ ] **11.2** Normalise machine-specific output (paths, times, pids, widths) before comparison
- [x] **11.3** Capture Get-Command metadata from real pwsh to validate our manifests
  - Done for 7.6.5 via tools/capture-pwsh-metadata.ps1: 43 commands, 398 declared parameters, with types, parameter sets, positions, pipeline binding and validation attributes. It already proves four 7.7 deltas against the reference implementation — Format-Table -Property carries no attributes in 7.6.5, and -ExcludeProperty and Join-Path -Extension do not exist there.
- [ ] **11.4** Record known-differences.yml for deliberate divergences, with a reason for each
- [ ] **11.5** Report per-profile conformance coverage as a number the site can display

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- A fixture mismatch fails CI
- Every divergence is either fixed or listed with a reason
- Coverage is a measured number, not a claim

## Risks

- 7.7-preview.4 needs a side-by-side install or CI container; the 7.6.5 track works locally today

---

[Back to the roadmap](../../ROADMAP.md)
