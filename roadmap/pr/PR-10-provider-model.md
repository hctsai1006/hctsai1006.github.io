# 10. PowerShell provider model over the mount table

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** State  
**Status** [ ] todo  
**Tasks** 0/4 `..................`

## Why

Env, Variable, Function, Process and Package are not files. Forcing them into /proc and /dev is less faithful than modelling providers.

## Depends on

- [ ] **9. OPFS-backed filesystem with overlay, WAL, snapshots and migrations** — [detail](PR-09-storage-layer.md)

## Tasks

- [ ] **10.1** Define the provider interface (drive, item, child-item, content)
- [ ] **10.2** Implement FileSystem, Env, Variable, Function, Alias providers
- [ ] **10.3** Implement Portfolio, Process, Package and Browser providers
- [ ] **10.4** Move quote-stripping out of resolvePath; paths should arrive already lexed

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- Get-ChildItem Env:/ works
- Set-Location Portfolio:/ works
- One path resolver, used by every provider

---

[Back to the roadmap](../../ROADMAP.md)
