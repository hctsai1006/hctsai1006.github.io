# 2. Mechanise version truth across five axes

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** Ground truth  
**Status** [x] done  
**Tasks** 17/17 `##################`

## Why

A hardcoded banner string is a rumour. Version truth is five independently-drifting axes, and conflating any two of them produces confident wrong answers.

## Depends on

Nothing. This can start immediately.

## Tasks

- [x] **2.1** Resolve which releases exist from the GitHub Releases API
- [x] **2.2** Dereference annotated tags to real commit shas
  - PowerShell uses annotated tags; the naive ref sha points at a tag object, not a commit.
- [x] **2.3** Read the SDK pin from global.json at each tag
- [x] **2.4** Resolve SDK to the runtime it ships via .NET per-channel releases.json
  - TRAP A: SDK 10.0.303 ships runtime 10.0.11. The two are different version spaces and cannot be compared.
- [x] **2.5** Record SDK feature band without ordering it
  - TRAP B: .NET 10.0.11 ships SDKs 10.0.400, 10.0.303 and 10.0.111 simultaneously. Bands are parallel trains, not a sequence.
- [x] **2.6** Read LTS membership from PowerShell master:tools/metadata.json
  - Replaces a hardcode. Avoids the aka.ms/pwsh-buildinfo-lts trap, which returns the previous LTS.
- [x] **2.7** Cross-check the declared LTS against the .NET release-type rule
- [x] **2.8** Cross-check the docs prose and classify which axis it names
  - TRAP C: the 7.7 doc calls an SDK version a runtime.
- [x] **2.9** Fail loudly when the docs parser stops matching
  - A verifier that goes green because its own parser broke is worse than no verifier.
- [x] **2.10** Digest a canonical projection, not raw bytes
  - The Releases API body carries download_count and reactions, which tick constantly; digesting raw bytes made --check report drift on every run.
- [x] **2.11** Enforce the lockfile against its JSON schema with ajv
  - A schema nothing validates against is decoration. This caught the v1 schema encoding the wrong SDK/runtime model.
- [x] **2.12** Distinguish exit codes: 0 clean, 1 drift/error, 2 could-not-run
- [x] **2.13** Wire into CI on a daily schedule, opening a PR rather than auto-merging
  - The workflow never auto-merges and never switches the production profile. A tool that silently retargets the site when upstream ships is the hardcoded version string again, only faster.
- [x] **2.14** Rank rc above preview, and test it
  - PowerShell ships an rc before every GA. Folding rc into preview made 7.6.0-rc.1 compare as older than a preview, flipping an error/warning branch during the one window when the answer matters most.
- [x] **2.15** Validate every upstream payload shape at the trust boundary
  - JSON.parse(x) as T is an unchecked assertion about a third party. A renamed .NET field would have made parseVersion(undefined) return null and the lag check silently skip, leaving the run green.
- [x] **2.16** Fetch timeouts, retry with backoff, and distinct exit codes
  - 0 clean, 1 drift, 2 could-not-run, 3 internal bug. CI must not treat a rate limit as though upstream moved.
- [x] **2.17** Cross-check the support-lifecycle doc as an independent LTS assertion
  - Its table gives LTS status and end-of-support per line, derived independently of the .NET metadata. It also surfaced that v7.4.19 loses support in 66 days.

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- npm run truth:check passes twice in a row with no false drift
- npx tsc --noEmit is clean under strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes + erasableSyntaxOnly
- The lockfile records both SDK and runtime for every release
- No PowerShell version string is hardcoded anywhere in the tool

---

[Back to the roadmap](../../ROADMAP.md)
