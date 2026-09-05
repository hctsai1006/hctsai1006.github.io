# 10. PowerShell provider model over the mount table

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** State  
**Status** [~] in progress  
**Tasks** 1/4 +1 partial `#####/////........`

## Why

Env, Variable, Function, Process and Package are not files. Forcing them into /proc and /dev is less faithful than modelling providers.

## Depends on

- [~] **9. OPFS-backed filesystem with overlay, WAL, snapshots and migrations** — [detail](PR-09-storage-layer.md)

## Tasks

- [/] **10.1** Define the provider interface (drive, item, child-item, content)
  - MISSING: the interface. The seam a provider model would sit on is built and tested — a mount table that routes drive-qualified paths, and one path resolver already proven generic by mounting a second backend at a made-up drive. But every mount is typed as the same POSIX-shaped StorageBackend, and there is no item/child-item/content abstraction. vfs.ts says so itself: the seam exists so PR-10 can add Env:, Variable: and Function:, and none of them is implemented there.
  - *evidence:* `src/storage/vfs.ts` exports `MountTable`
  - *evidence:* `src/storage/vfs.ts` exports `VirtualFileSystem`
  - *evidence:* `tests/unit/storage-path.test.mts` — test "routes a drive-qualified path to the second mount, not the first"
  - *evidence:* `tests/unit/storage-path.test.mts` — test "unmounts a provider drive and forgets its alias"
- [ ] **10.2** Implement FileSystem, Env, Variable, Function, Alias providers
  - Environment variables are ordinary simulated commands with invented output, never a mounted Env: drive.
  - *evidence:* `src/providers/**/*` matches no file, though `src/**/*` does
- [ ] **10.3** Implement Portfolio, Process, Package and Browser providers
  - *evidence:* `src/providers/**/*` matches no file, though `src/**/*` does
- [x] **10.4** Move quote-stripping out of resolvePath; paths should arrive already lexed
  - STALE todo, corrected 2026-09-06. resolvePath touches no quotes at all: a file whose name literally contains quote characters is addressable, and a test pins it.
  - *evidence:* `src/storage/vfs.ts` exports `resolvePath`
  - *evidence:* `tests/unit/storage-path.test.mts` — test "does not strip quotes; a quoted name is a name"

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- Get-ChildItem Env:/ works
- Set-Location Portfolio:/ works
- One path resolver, used by every provider

---

[Back to the roadmap](../../ROADMAP.md)
