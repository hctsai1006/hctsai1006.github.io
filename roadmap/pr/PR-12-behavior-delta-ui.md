# 12. Ship the version-difference explorer

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** Compatibility  
**Status** [~] in progress  
**Tasks** 1/3 `######............`

## Why

The whole point of profiles is being able to answer "what would this script do differently on 7.7?" without reading a changelog.

## Depends on

- [~] **11. Differential conformance against real pwsh 7.6.5** — [detail](PR-11-differential-conformance.md)

## Tasks

- [ ] **12.1** Add a command that diffs a script across two profiles
  - Nothing runs a script under two profiles. The profile resolver is not even reachable from the command layer yet.
  - *evidence:* nothing under `src/**/*.{ts,mts}` matches `/compareProfiles/`
- [x] **12.2** Show, per difference, whether BrowserShell actually emulates it or merely documents it
  - STALE todo, corrected 2026-09-06. The generated explorer page labels every documented difference either emulated or "documented, not emulated", sorts the emulated ones first, and prints the ratio. Delivered as a generated static page rather than as in-session UI, which is what 12.1 and 12.3 would add.
  - *evidence:* `compat/deltas/7.6.5__7.7.0-preview.4.json` — `summary`
  - *evidence:* `tools/generate-compat-explorer.mts` matches `/documented, not emulated/`
  - *evidence:* `npm run explorer`
- [ ] **12.3** Let the session switch profiles without losing the filesystem
  - There is no concept of an active profile in a session at all, so there is nothing to switch.
  - *evidence:* nothing under `src/**/*.{ts,mts}` matches `/activeProfile/`

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- New-Guid shows v4 vs v7 across profiles
- Unemulated differences are labelled as such

---

[Back to the roadmap](../../ROADMAP.md)
