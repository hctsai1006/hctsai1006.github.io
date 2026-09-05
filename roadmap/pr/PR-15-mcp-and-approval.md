# 15. MCP tool schema generation and the approval gate

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** AI  
**Status** [ ] todo  
**Tasks** 0/5 `..................`

## Why

Command metadata already has to exist for help, completion and the binder. MCP tools and the AI planner should be consumers of it, not a parallel definition.

## Depends on

- [ ] **8. Build one lexer, one AST and a version-aware parameter binder** — [detail](PR-08-version-aware-binder.md)
- [ ] **14. Package identity, integrity, capabilities and trust promotion** — [detail](PR-14-package-trust.md)

## Tasks

- [ ] **15.1** Generate MCP tool schemas from command manifests
  - No upstream schema to conform to: the team-maintained PowerShell MCP server is a stated 2026 intention with no public code. Define ours from our metadata.
- [ ] **15.2** Classify every command by risk: read / query-external / write / destructive / device / privileged-simulation
- [ ] **15.3** Route AI plans through schema validation, AST validation, capability analysis and WhatIf preview before approval
- [ ] **15.4** Deny the AI direct handles: no OPFS, clipboard, device, package token or storage key
- [ ] **15.5** Audit-log every AI-originated action with its plan and approval

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- A destructive AI plan cannot execute without explicit approval
- Every AI action is reconstructable from the audit log

---

[Back to the roadmap](../../ROADMAP.md)
