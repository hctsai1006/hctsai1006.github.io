# 9. OPFS-backed filesystem with overlay, WAL, snapshots and migrations

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** State  
**Status** [ ] todo  
**Tasks** 0/7 `..................`

## Why

State currently lives in one localStorage key with no transactions, no snapshots and no migration path. It also cannot survive a schema change.

## Depends on

- [ ] **6. Move execution into a worker behind a typed kernel protocol** — [detail](PR-06-worker-kernel-protocol.md)

## Tasks

- [ ] **9.1** Implement OPFS backend with sync access handles inside a dedicated StorageWorker
  - HARD CONSTRAINT: the WHATWG spec marks createSyncAccessHandle [Exposed=DedicatedWorker], which excludes Window AND SharedWorker. The coordinator can never hold the handle.
- [ ] **9.2** Keep the seed/overlay split that already works: rebuild seed each boot, graft user changes
- [ ] **9.3** Add a write-ahead log and snapshot/restore
- [ ] **9.4** Add versioned migrations with rollback
- [ ] **9.5** Elect a storage leader with Web Locks; use SharedWorker for coordination where available
  - Web Locks is widely available since March 2022 and MDN documents leader election explicitly. SharedWorker is only Baseline "newly available" (May 2026) and absent on Samsung Internet and Opera Mobile, so the fallback stays.
- [ ] **9.6** Surface quota via navigator.storage.estimate() and warn before the ceiling
  - OPFS shares the origin quota and is deleted when the user clears site data. Export must exist before people can lose work.
- [ ] **9.7** Return Result<void, StorageError> instead of a rendered error row
  - fsSave currently returns a view object consumed by 13 command bodies.

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- A migration can be rolled back
- Two tabs cannot corrupt the tree
- Clearing site data is survivable via export

## Risks

- OPFS is deleted on site-data clear with no warning from the browser; export/import must land in the same PR

---

[Back to the roadmap](../../ROADMAP.md)
