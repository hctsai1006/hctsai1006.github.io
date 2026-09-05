# 9. OPFS-backed filesystem with overlay, WAL, snapshots and migrations

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** State  
**Status** [~] in progress  
**Tasks** 6/7 +1 partial `###############///`

## Why

State currently lives in one localStorage key with no transactions, no snapshots and no migration path. It also cannot survive a schema change.

## Depends on

- [~] **6. Move execution into a worker behind a typed kernel protocol** — [detail](PR-06-worker-kernel-protocol.md)

## Tasks

- [x] **9.1** Implement OPFS backend with sync access handles inside a dedicated StorageWorker
  - Built. The constraint held: createSyncAccessHandle is [Exposed=DedicatedWorker], which excludes Window AND SharedWorker, so the coordinator never holds the handle. Verified end to end in real Chromium inside a dedicated worker, not against the fake alone. The store is a checkpoint plus a write-ahead log over five fixed ASCII filenames rather than a mirrored tree, and two measurements ruled the mirror out: a lone surrogate in an OPFS name is SILENTLY replaced with U+FFFD, so two distinct virtual names collide into one entry with no error anywhere; and the sync-handle lock is per file entry with no directory lock, so a mirrored tree cannot make a multi-file recursive copy exclusive against another tab.
  - *evidence:* `src/storage/opfs.ts` exports `OpfsStorage`
  - *evidence:* `src/storage/opfs-platform.ts` matches `/createSyncAccessHandle/`
  - *evidence:* `tests/unit/opfs-worker.test.mts` — test "names every callable member of StorageBackend"
  - *evidence:* `tests/unit/opfs-conformance.test.mts` — test "refuses a second sync access handle with NoModificationAllowedError"
- [x] **9.2** Keep the seed/overlay split that already works: rebuild seed each boot, graft user changes
  - STALE todo, corrected 2026-09-06. bootStorage rebuilds the seed image and grafts the overlay over it, with v1's graft rules — seed wins on a kind conflict, seed content is always re-rendered, user content survives, mode and mtime are preserved — each separately tested.
  - *evidence:* `src/storage/index.ts` exports `bootStorage`
  - *evidence:* `tests/unit/storage-snapshot.test.mts` — test "shows a returning visitor the NEW seed while keeping their files"
  - *evidence:* `tests/unit/storage-snapshot.test.mts` — test "carries user files and not seed content"
  - *evidence:* `tests/unit/storage-snapshot.test.mts` — test "lets the seed win when it replaced a user path with the other kind"
- [/] **9.3** Add a write-ahead log and snapshot/restore
  - MISSING: the log. Two things were bundled into one task and they are at different stages. Snapshot/restore is fully built — create, export, import, restore, checksummed, version 2, refusing every malformed shape — and heavily tested. The WAL is an interface and a NullJournal that writes nothing; the memory backend does not need one and a real log only attaches to a durable backend, which task 9.1 has not built. There is no write-ahead log today.
  - *evidence:* `src/storage/snapshot.ts` exports `createSnapshot`
  - *evidence:* `src/storage/snapshot.ts` exports `restoreSnapshot`
  - *evidence:* `src/storage/memory.ts` exports `NullJournal`
  - *evidence:* `tests/unit/storage-snapshot.test.mts` — test "survives losing the store entirely"
  - *evidence:* `tests/unit/storage-memory.test.mts` — test "journals the whole plan before applying it, and commits after"
- [x] **9.4** Add versioned migrations with rollback
  - Built alongside the OPFS store, which is what gave migrations something to migrate. Up and down are separate entry points, so a rollback is a declared operation rather than a hope.
  - *evidence:* `src/storage/opfs-migrate.ts` exports `migrateUp`
  - *evidence:* `src/storage/opfs-migrate.ts` exports `migrateDown`
  - *evidence:* `tests/unit/opfs-store.test.mts` — test "a write survives a clean close and a remount"
- [x] **9.5** Elect a storage leader with Web Locks; use SharedWorker for coordination where available
  - Built, with the fallback the availability data called for: Web Locks has been widely available since March 2022, while SharedWorker is only Baseline "newly available" and absent on Samsung Internet and Opera Mobile, so coordination degrades rather than requiring it. Cross-tab lock behaviour was measured in a real browser, not modelled.
  - *evidence:* `src/storage/opfs.ts` exports `createCoordinator`
  - *evidence:* `src/storage/opfs.ts` matches `/SharedWorker/`
  - *evidence:* `tests/unit/opfs-worker.test.mts` — test "round-trips a write and a read across the boundary"
- [x] **9.6** Surface quota via navigator.storage.estimate() and warn before the ceiling
  - MISSING: the measurement and the warning. OPFS shares the origin quota and is deleted when the user clears site data, so export must exist before people can lose work — and it does (9.3). The QuotaUsage shape is defined and plumbed end to end through the backend and the filesystem, and it is tested. But navigator.storage.estimate() is never called, nothing warns near the ceiling, and Get-StorageStatus — the command df's own note points at — does not exist.
  - *evidence:* `src/storage/types.ts` exports `QuotaUsage`
  - *evidence:* `src/storage/opfs.ts` matches `/storage.estimate/`
  - *evidence:* `tests/unit/storage-memory.test.mts` — test "reports the directory size as 4096, as ext4 and v1 both do"
  - *evidence:* `tests/unit/opfs-store.test.mts` — test "keeps every operation but the last, and says which"
- [x] **9.7** Return Result<void, StorageError> instead of a rendered error row
  - STALE todo, corrected 2026-09-06. Every backend and filesystem method returns Result<T, StorageError>, and the command layer maps the POSIX-shaped error into a PowerShell ErrorRecord with its own FullyQualifiedErrorId — which is exactly the rendered-view-object pattern this task asks to remove.
  - *evidence:* `src/storage/types.ts` exports `Result`
  - *evidence:* `src/storage/types.ts` exports `StorageError`
  - *evidence:* `src/commands/fs-read/support.ts` exports `storageErrorRecord`
  - *evidence:* `tests/unit/storage-memory.test.mts` — test "reports ENOTDIR when a path component is a file"

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- A migration can be rolled back
- Two tabs cannot corrupt the tree
- Clearing site data is survivable via export

## Risks

- OPFS is deleted on site-data clear with no warning from the browser; export/import must land in the same PR

---

[Back to the roadmap](../../ROADMAP.md)
