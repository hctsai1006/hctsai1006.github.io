# 18. File manager, task manager, settings and window management

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** Desktop  
**Status** [~] in progress  
**Tasks** 1/4 `#####.............`

## Why

These are what turn a prompt into a workstation, and they are cheap once providers and the object pipeline exist.

## Depends on

- [~] **10. PowerShell provider model over the mount table** — [detail](PR-10-provider-model.md)
- [ ] **13. DSC-style declarative workstation state** — [detail](PR-13-workstation-state.md)

## Tasks

- [x] **18.1** Rebuild the nano/vim editor on the extracted core rather than on global ED state
  - STALE todo, corrected 2026-09-06. nano, vi and vim are one command factory going through a ui.dialog capability and a DialogPort, with no dependency on any global editor state — the only mention of v1's ED is a comment citing the behaviour being reproduced.
  - *evidence:* `src/commands/fs-manage/editors.ts` exports `nano`
  - *evidence:* `src/commands/fs-manage/editors.ts` exports `vim`
  - *evidence:* `tests/unit/fs-manage-editors.test.mts` — test "reads the file, hands it over, and writes the result"
  - *evidence:* `tests/unit/fs-manage-editors.test.mts` — test "reports a ui.dialog denial without opening anything"
  - *evidence:* nothing under `src/**/*.ts` matches `/wantCol/`
- [ ] **18.2** File manager over the provider model
  - Blocked on item 10: there is no provider model to build over.
  - *evidence:* `src/apps/**/*` matches no file, though `src/**/*` does
- [ ] **18.3** Task manager over the process/job model
  - The kernel process table and job model exist, but nothing consumes them: ps and Get-Process are simulated commands printing an invented list, disconnected from the real table by design until an app reads it.
  - *evidence:* `src/apps/**/*` matches no file, though `src/**/*` does
- [ ] **18.4** Settings backed by declarative workstation state
  - PreferencesPort and Set-Theme are real, but that is one flat key, not a settings surface, and the declarative state it is meant to sit on (item 13) does not exist.
  - *evidence:* `src/apps/**/*` matches no file, though `src/**/*` does

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- The editor no longer reaches back into console internals
- Apps use providers, not direct filesystem access

---

[Back to the roadmap](../../ROADMAP.md)
