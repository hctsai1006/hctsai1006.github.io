# 7. Build the typed object pipeline and stream model

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** Core  
**Status** [~] in progress  
**Tasks** 2/6 `######............`

## Why

Today every command returns pre-formatted rows, so `gci | Sort-Object` sorts rendered text including the UnixMode prefix. Without objects, Get-Member, Select-Object, ConvertTo-Json, property completion and structured AI results are all impossible.

## Depends on

- [ ] **6. Move execution into a worker behind a typed kernel protocol** — [detail](PR-06-worker-kernel-protocol.md)

## Tasks

- [x] **7.1** Define PSObject with typed properties and a type name
  - Case-insensitive property access, a type-name hierarchy for -is and formatting, PowerShell truthiness, and one-level pipeline unrolling. Every semantic was read off pwsh 7.6.5 rather than assumed, which corrected three of them: enumeration is one level not recursive, string ordering is culture-aware not codepoint, and it is Measure-Object that skips nulls rather than the pipeline dropping them.
- [x] **7.2** Implement the six PowerShell streams plus a separate native byte pipeline
  - Numbered 1-6 as users type them, with Progress deliberately unnumbered because there is no 7> in PowerShell. ErrorRecord carries the fields scripts actually branch on (FullyQualifiedErrorId, CategoryInfo). Sinks are async so a slow terminal can push back on a fast producer.
- [ ] **7.3** Move formatting to the end of the pipeline as Format-* directives
- [ ] **7.4** Reimplement Get-ChildItem to emit objects, with formatting applied last
- [ ] **7.5** Make Sort/Select/Where/Measure/Group operate on properties, not on rendered text
- [ ] **7.6** Keep an EncodingBroker so native byte streams are not corrupted by UTF-16 round-trips

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- gci | Sort-Object Length sorts numerically
- Get-Member reports real properties
- ConvertTo-Json emits structure, not text

---

[Back to the roadmap](../../ROADMAP.md)
