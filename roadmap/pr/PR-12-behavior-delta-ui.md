# 12. Ship the version-difference explorer

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** Compatibility  
**Status** [ ] todo  
**Tasks** 0/3 `..................`

## Why

The whole point of profiles is being able to answer "what would this script do differently on 7.7?" without reading a changelog.

## Depends on

- [~] **11. Differential conformance against real pwsh 7.6.5** — [detail](PR-11-differential-conformance.md)

## Tasks

- [ ] **12.1** Add a command that diffs a script across two profiles
- [ ] **12.2** Show, per difference, whether BrowserShell actually emulates it or merely documents it
- [ ] **12.3** Let the session switch profiles without losing the filesystem

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- New-Guid shows v4 vs v7 across profiles
- Unemulated differences are labelled as such

---

[Back to the roadmap](../../ROADMAP.md)
