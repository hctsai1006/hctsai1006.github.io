# 7. Build the typed object pipeline and stream model

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** Core  
**Status** [~] in progress  
**Tasks** 5/6 `###############...`

## Why

Today every command returns pre-formatted rows, so `gci | Sort-Object` sorts rendered text including the UnixMode prefix. Without objects, Get-Member, Select-Object, ConvertTo-Json, property completion and structured AI results are all impossible.

## Depends on

- [~] **6. Move execution into a worker behind a typed kernel protocol** — [detail](PR-06-worker-kernel-protocol.md)

## Tasks

- [x] **7.1** Define PSObject with typed properties and a type name
  - Case-insensitive property access, a type-name hierarchy for -is and formatting, PowerShell truthiness, and one-level pipeline unrolling. Every semantic was read off pwsh 7.6.5 rather than assumed, which corrected three of them: enumeration is one level not recursive, string ordering is culture-aware not codepoint, and it is Measure-Object that skips nulls rather than the pipeline dropping them.
  - *evidence:* `src/pipeline/psobject.ts` exports `PSObject`
  - *evidence:* `src/pipeline/psobject.ts` exports `psObject`
  - *evidence:* `src/pipeline/psobject.ts` exports `typeNameOf`
  - *evidence:* `tests/unit/psobject.test.mts` — test "is case-insensitive, as PowerShell is"
  - *evidence:* `tests/unit/psobject.test.mts` — test "unrolls exactly one level"
  - *evidence:* `tests/unit/psobject.test.mts` — test "orders strings by culture, not by code point"
- [x] **7.2** Implement the six PowerShell streams plus a separate native byte pipeline
  - Numbered 1-6 as users type them, with Progress deliberately unnumbered because there is no 7> in PowerShell. ErrorRecord carries the fields scripts actually branch on (FullyQualifiedErrorId, CategoryInfo). Sinks are async so a slow terminal can push back on a fast producer.
  - *evidence:* `src/pipeline/streams.ts` exports `STREAM_NUMBER`
  - *evidence:* `src/pipeline/streams.ts` exports `PowerShellStreams`
  - *evidence:* `src/pipeline/streams.ts` exports `NativeStreams`
  - *evidence:* `src/pipeline/streams.ts` exports `ErrorRecord`
  - *evidence:* `tests/unit/kernel.test.mts` — test "preserves the true interleaving of four independent channels"
- [x] **7.3** Move formatting to the end of the pipeline as Format-* directives
  - STALE todo, corrected 2026-09-06. Format-Table/-List/-Wide emit one opaque record carrying a FormatDocument in baseObject and no public properties, so a later stage can learn nothing from it; only Out-String and the default renderer turn one into text.
  - *evidence:* `src/formatting/records.ts` exports `formatRecord`
  - *evidence:* `src/formatting/records.ts` exports `isFormatRecord`
  - *evidence:* `src/formatting/records.ts` exports `FORMAT_ENTRY_TYPE`
  - *evidence:* `tests/unit/format-cmdlets.test.mts` — test "emits ONE opaque directive, not objects"
  - *evidence:* `tests/unit/format-cmdlets.test.mts` — test "exposes NO properties, so a later stage learns nothing from it"
- [x] **7.4** Reimplement Get-ChildItem to emit objects, with formatting applied last
  - STALE todo, corrected 2026-09-06. Get-ChildItem emits FileInfo and DirectoryInfo PSObjects with a numeric Length and Date timestamps, and renders nothing itself.
  - *evidence:* `src/commands/fs-read/get-childitem.ts` exports `getChildItem`
  - *evidence:* `src/commands/fs-read/support.ts` exports `fileSystemInfo`
  - *evidence:* `tests/unit/fs-read.test.mts` — test "emits FileInfo and DirectoryInfo with the measured type chains"
  - *evidence:* `tests/unit/fs-read.test.mts` — test "gives a directory no Length property at all"
- [x] **7.5** Make Sort/Select/Where/Measure/Group operate on properties, not on rendered text
  - STALE todo, corrected 2026-09-06. All five resolve properties off PSValues and compare with compareValues, never on rendered rows. Where-Object is still held back from the default session, but for an unrelated reason: -match uses JavaScript RegExp rather than .NET, and its -is type table is narrow.
  - *evidence:* `src/commands/powershell/sort-object.ts` exports `sortObject`
  - *evidence:* `src/commands/powershell/group-object.ts` exports `groupObject`
  - *evidence:* `src/pipeline/psobject.ts` exports `compareValues`
  - *evidence:* `tests/unit/psobject.test.mts` — test "reproduces the reference implementation Sort-Object result"
- [ ] **7.6** Keep an EncodingBroker so native byte streams are not corrupted by UTF-16 round-trips
  - The byte channel type exists (NativeStreams, and the kernel forwards raw chunks as bytes events), but no command reads or writes it and there is no broker guarding the boundary.
  - *evidence:* nothing under `src/**/*.{ts,mts}` matches `/EncodingBroker/`

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- gci | Sort-Object Length sorts numerically
- Get-Member reports real properties
- ConvertTo-Json emits structure, not text — no ConvertTo-Json exists yet, so this one is still open

---

[Back to the roadmap](../../ROADMAP.md)
