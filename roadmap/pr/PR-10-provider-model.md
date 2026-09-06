# 10. PowerShell provider model over the mount table

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** State  
**Status** [~] in progress  
**Tasks** 3/4 `##############....`

## Why

Env, Variable, Function, Process and Package are not files. Forcing them into /proc and /dev is less faithful than modelling providers.

## Depends on

- [~] **9. OPFS-backed filesystem with overlay, WAL, snapshots and migrations** — [detail](PR-09-storage-layer.md)

## Tasks

- [x] **10.1** Define the provider interface (drive, item, child-item, content)
  - Capability-layered, as PowerShell itself is: DriveProvider, ItemProvider, ContainerProvider, NavigationProvider and ContentProvider, implemented as far as a provider can honestly answer. Deliberately NOT StorageBackend — Env: has no chmod, no quota and no bytes, and forcing it into a filesystem interface is the same mistake as forcing it into /proc. The container/navigation split is detected structurally rather than read off a flag, because Get-PSProvider does not report it: MEASURED, its Capabilities are ShouldProcess/Filter/Credentials only, and the behavioural proof is that Set-Location Env:\PATH reports a path that does not exist even though Test-Path says the item is there. The fifth PowerShell layer, IPropertyCmdletProvider, is deliberately not modelled: none of the five providers has anything to put in it, and registry.ts records what adding it later would take.
  - *evidence:* `src/providers/types.ts` exports `ItemProvider`
  - *evidence:* `src/providers/types.ts` exports `ContainerProvider`
  - *evidence:* `src/providers/types.ts` exports `NavigationProvider`
  - *evidence:* `src/providers/types.ts` exports `ContentProvider`
  - *evidence:* `src/storage/vfs.ts` exports `ForeignDrives`
  - *evidence:* `tests/unit/providers.test.mts` — test "makes the four session-state providers containers but NOT navigation providers"
  - *evidence:* `tests/unit/providers.test.mts` — test "can express a refusal for a provider that implements neither layer"
- [x] **10.2** Implement FileSystem, Env, Variable, Function, Alias providers
  - Env:, Variable:, Function: and Alias: are ONE implementation over four descriptors, as PowerShell derives all four from SessionStateProviderBase: the only things that differ are the item shape, the content, what an incoming value has to be, and what a null MEANS. That last one is measured and is not uniform — Clear-Item deletes an environment variable, a function and an alias, and leaves a variable holding $null, while Set-Item -Value '' keeps all four. FileSystem is an ADAPTER over the existing brokered FileSystemPort, so OPFS and the memory backend are untouched and every filesystem call still passes the capability broker. Variable: and Function: are backed by empty stores because this engine has neither variables nor user functions yet; the drives are real, the tables are honestly empty, and a session-state layer supplies a SessionStateStore later without touching a provider.
  - *evidence:* `src/providers/session-state.ts` exports `SessionStateProvider`
  - *evidence:* `src/providers/filesystem.ts` exports `FileSystemProvider`
  - *evidence:* `src/providers/registry.ts` exports `ProviderRegistry`
  - *evidence:* `npm run capture:providers`
  - *evidence:* `tests/unit/providers.test.mts` — test "lists Env:/ which is the acceptance criterion"
  - *evidence:* `tests/unit/providers.test.mts` — test "reproduces the measured table: clearing writes null, and null means different things"
  - *evidence:* `tests/unit/providers.test.mts` — test "reproduces the collated order pwsh returns, in every session-state drive"
  - *evidence:* `tests/unit/providers.test.mts` — test "teaches the SAME resolver about provider drives instead of adding a second"
- [ ] **10.3** Implement Portfolio, Process, Package and Browser providers
  - None of the four exists. The provider layer they would join does, so the claim is no longer "there is no src/providers" but "none of these four providers is in it" — a search over the directory rather than for the directory. Adding one is a pure addition: a descriptor and a store for a flat provider, a NavigationProvider class for a hierarchical one such as Portfolio:, plus a line in the registry constructor. Nothing in resolvePath, VirtualFileSystem, ForeignDrives or a rewired command changes. Set-Location Portfolio:/ — the second half of this PR's acceptance — needs only isContainer on that provider; canEnter already routes it.
  - *evidence:* nothing under `src/providers/**/*.ts` matches `/PortfolioProvider|ProcessProvider|PackageProvider|BrowserProvider/`
  - *evidence:* `src/providers/portfolio.ts` matches no file, though `src/providers/*.ts` does
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
