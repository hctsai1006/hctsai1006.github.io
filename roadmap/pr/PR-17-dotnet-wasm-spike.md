# 17. Research spike: real PowerShell parser via .NET WASM

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** Future runtime  
**Status** [-] deferred  
**Tasks** 0/3 `..................`

## Why

The honest sequencing is to use real pwsh in CI to generate golden ASTs first, and only move the real parser into the browser when the runtime substrate is ready.

## Depends on

- [ ] **8. Build one lexer, one AST and a version-aware parameter binder** — [detail](PR-08-version-aware-binder.md)
- [~] **11. Differential conformance against real pwsh 7.6.5** — [detail](PR-11-differential-conformance.md)

## Tasks

- [ ] **17.1** Define RuntimeAdapter so UI, VFS, AI and terminal never depend on which engine runs
- [ ] **17.2** Generate golden ASTs from real pwsh in CI and validate our parser against them
  - This is the near-term win and needs no WASM at all.
- [!] **17.3** Spike loading a real PowerShell parser under .NET WASM
  - BLOCKED on substrate: Mono is still the Blazor WASM runtime through .NET 11; CoreCLR-on-WASM is opt-in early preview targeting .NET 12. PowerShell itself has ZERO WASM support in-tree (RIDs linux-x64;osx-x64). This is a spike, not a milestone.

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- RuntimeAdapter exists and the semantic engine implements it
- Golden AST tests run against real pwsh

## Risks

- Do not schedule the WASM branch as a deliverable. The substrate stabilises in .NET 12, and the PowerShell port does not exist — we would be writing it.

---

[Back to the roadmap](../../ROADMAP.md)
