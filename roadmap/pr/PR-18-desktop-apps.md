# 18. File manager, task manager, settings and window management

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** Desktop  
**Status** [ ] todo  
**Tasks** 0/4 `..................`

## Why

These are what turn a prompt into a workstation, and they are cheap once providers and the object pipeline exist.

## Depends on

- [ ] **10. PowerShell provider model over the mount table** — [detail](PR-10-provider-model.md)
- [ ] **13. DSC-style declarative workstation state** — [detail](PR-13-workstation-state.md)

## Tasks

- [ ] **18.1** Rebuild the nano/vim editor on the extracted core rather than on global ED state
- [ ] **18.2** File manager over the provider model
- [ ] **18.3** Task manager over the process/job model
- [ ] **18.4** Settings backed by declarative workstation state

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- The editor no longer reaches back into console internals
- Apps use providers, not direct filesystem access

---

[Back to the roadmap](../../ROADMAP.md)
