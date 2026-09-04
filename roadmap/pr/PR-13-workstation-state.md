# 13. DSC-style declarative workstation state

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** Declarative  
**Status** [ ] todo  
**Tasks** 0/4 `..................`

## Why

A machine you cannot export, diff and restore is a pile of implicit localStorage, not a machine.

## Depends on

- [ ] **10. PowerShell provider model over the mount table** — [detail](PR-10-provider-model.md)

## Tasks

- [ ] **13.1** Define the resource schema and registry
- [ ] **13.2** Implement Get/Test/Set with WhatIf planning
  - Model the DSC 3.2 feature set — version pinning, --what-if, map/filter expressions, adapters — and pin the exact DSC version modelled (3.2.3 stable; 3.3.0-rc.2 exists).
- [ ] **13.3** Implement Export/Import of the whole workstation
- [ ] **13.4** Report configuration drift

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- Set-WorkstationState -WhatIf previews without mutating
- An exported config rebuilds an equivalent machine

---

[Back to the roadmap](../../ROADMAP.md)
