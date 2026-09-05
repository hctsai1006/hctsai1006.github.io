# 15. MCP tool schema generation and the approval gate

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** AI  
**Status** [~] in progress  
**Tasks** 1/5 `####..............`

## Why

Command metadata already has to exist for help, completion and the binder. MCP tools and the AI planner should be consumers of it, not a parallel definition.

## Depends on

- [~] **8. Build one lexer, one AST and a version-aware parameter binder** — [detail](PR-08-version-aware-binder.md)
- [~] **14. Package identity, integrity, capabilities and trust promotion** — [detail](PR-14-package-trust.md)

## Tasks

- [ ] **15.1** Generate MCP tool schemas from command manifests
  - No upstream schema to conform to: the team-maintained PowerShell MCP server is a stated 2026 intention with no public code. Define ours from our metadata. Nothing is built; MCP appears only in two comments naming it as a future consumer.
  - *evidence:* nothing under `src/**/*.{ts,mts}` matches `/mcp/`
- [x] **15.2** Classify every command by risk: read / query-external / write / destructive / device / privileged-simulation
  - STALE todo, corrected 2026-09-06. Delivered as a by-product of the command-manifest work in item 4, not as MCP work: the Risk union is exactly the six the task names, the classification table requires one on every entry, the generator refuses to emit a manifest without it, and all 85 commands carry one. Two of the six categories have no members yet, which is a fact about the command set rather than a gap in the classification.
  - *evidence:* `src/commands/manifest.ts` exports `Risk`
  - *evidence:* `src/commands/classification.data.mts` exports `Classification`
  - *evidence:* `tests/unit/kernel-capabilities.test.mts` — test "classify every risk the contract declares"
  - *evidence:* `tests/unit/kernel-capabilities.test.mts` — test "audit every write, delete, network, device and privileged simulation"
- [ ] **15.3** Route AI plans through schema validation, AST validation, capability analysis and WhatIf preview before approval
  - Blocked twice over: there is no AST to validate against (8.3) and no -WhatIf to preview with (13.2).
  - *evidence:* nothing under `src/**/*.{ts,mts}` matches `/approval/`
- [ ] **15.4** Deny the AI direct handles: no OPFS, clipboard, device, package token or storage key
  - The broker is generic per-session infrastructure that could carry this, but nothing distinguishes an AI-issued command from a user one at the gate, and there is no AI execution path to deny. The only place the codebase knows about an AI origin is the history tag from 5.4, which is a display concern.
  - *evidence:* `src/ai/**/*` matches no file, though `src/**/*` does
- [ ] **15.5** Audit-log every AI-originated action with its plan and approval
  - The audit log is real and append-only, but its records carry no plan and no approval field, and nothing writes to it from an AI origin.
  - *evidence:* nothing under `src/**/*.{ts,mts}` matches `/approval/`

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- A destructive AI plan cannot execute without explicit approval
- Every AI action is reconstructable from the audit log

---

[Back to the roadmap](../../ROADMAP.md)
