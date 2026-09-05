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
  - *evidence:* `compat/upstream/releases.lock.json` — `releases.0.tag`
  - *evidence:* `tools/verify-release-truth.mts` matches `/canonicaliseReleases/`
- [x] **2.2** Dereference annotated tags to real commit shas
  - PowerShell uses annotated tags; the naive ref sha points at a tag object, not a commit.
  - *evidence:* `compat/upstream/releases.lock.json` — `releases.0.tagObjectSha`
  - *evidence:* `compat/upstream/releases.lock.json` — `releases.0.commitSha`
  - *evidence:* `tools/verify-release-truth.mts` matches `/resolveTagToCommit/`
- [x] **2.3** Read the SDK pin from global.json at each tag
  - *evidence:* `compat/upstream/releases.lock.json` — `releases.0.dotnet.sdk`
  - *evidence:* `tools/verify-release-truth.mts` matches `/global.json/`
- [x] **2.4** Resolve SDK to the runtime it ships via .NET per-channel releases.json
  - TRAP A: SDK 10.0.303 ships runtime 10.0.11. The two are different version spaces and cannot be compared.
  - *evidence:* `compat/upstream/releases.lock.json` — `releases.0.dotnet.runtime`
  - *evidence:* `tools/verify-release-truth.mts` matches `/runtimeForSdk/`
- [x] **2.5** Record SDK feature band without ordering it
  - TRAP B: .NET 10.0.11 ships SDKs 10.0.400, 10.0.303 and 10.0.111 simultaneously. Bands are parallel trains, not a sequence.
  - *evidence:* `tools/version.mts` exports `featureBand`
  - *evidence:* `compat/upstream/releases.lock.json` — `releases.0.dotnet.featureBand`
  - *evidence:* `tests/unit/version.test.mts` — test "extracts the band from real SDK versions"
- [x] **2.6** Read LTS membership from PowerShell master:tools/metadata.json
  - Replaces a hardcode. Avoids the aka.ms/pwsh-buildinfo-lts trap, which returns the previous LTS.
  - *evidence:* `compat/upstream/releases.lock.json` — `channels.lts`
  - *evidence:* `compat/upstream/releases.lock.json` — `channels.ltsPrevious.0`
  - *evidence:* `tools/verify-release-truth.mts` matches `/LTSReleaseTag/`
- [x] **2.7** Cross-check the declared LTS against the .NET release-type rule
  - *evidence:* `compat/upstream/releases.lock.json` — `releases.0.dotnet.releaseType`
  - *evidence:* `tools/verify-release-truth.mts` matches `/lts-derivation-disagrees/`
- [x] **2.8** Cross-check the docs prose and classify which axis it names
  - TRAP C: the 7.7 doc calls an SDK version a runtime.
  - *evidence:* `tools/docs-claim.mts` exports `parseDocsClaim`
  - *evidence:* `tests/unit/docs-claim.test.mts` — test "reads the 7.7 claim, which names an SDK while calling it a runtime"
  - *evidence:* `compat/upstream/releases.lock.json` — `discrepancies.0.code`
- [x] **2.9** Fail loudly when the docs parser stops matching
  - A verifier that goes green because its own parser broke is worse than no verifier.
  - *evidence:* `tests/unit/docs-claim.test.mts` — test "reports null rather than a wrong answer when the shape changes"
  - *evidence:* `tools/verify-release-truth.mts` matches `/docs-parse-failed/`
- [x] **2.10** Digest a canonical projection, not raw bytes
  - The Releases API body carries download_count and reactions, which tick constantly; digesting raw bytes made --check report drift on every run.
  - *evidence:* `compat/upstream/releases.lock.json` — `releases.0.snapshotDigest`
  - *evidence:* `tools/verify-release-truth.mts` matches `/canonicaliseDotnetChannel/`
- [x] **2.11** Enforce the lockfile against its JSON schema with ajv
  - A schema nothing validates against is decoration. This caught the v1 schema encoding the wrong SDK/runtime model.
  - *evidence:* `compat/schemas/release-truth.schema.json` — `properties.releases`
  - *evidence:* `tools/verify-release-truth.mts` matches `/validateAgainstSchema/`
  - *evidence:* `npm run truth:verify`
- [x] **2.12** Distinguish exit codes: 0 clean, 1 drift/error, 2 could-not-run
  - *evidence:* `tools/upstream-sync.mts` exports `classifyExit`
  - *evidence:* `tests/unit/upstream-sync.test.mts` — test "maps the four documented codes to their documented meanings"
  - *evidence:* `tests/unit/upstream-sync.test.mts` — test "fails closed on the codes that used to go green"
- [x] **2.13** Wire into CI on a daily schedule, opening a PR rather than auto-merging
  - The workflow never auto-merges and never switches the production profile. A tool that silently retargets the site when upstream ships is the hardcoded version string again, only faster.
  - *evidence:* `tests/unit/workflows.test.mts` — test "upstream-sync.yml grants write to one job, not to the whole workflow"
  - *evidence:* `tests/unit/workflows.test.mts` — test "the sync branch is a constant, not a date"
  - *evidence:* `.github/workflows/upstream-sync.yml` matches `/cron/`
- [x] **2.14** Rank rc above preview, and test it
  - PowerShell ships an rc before every GA. Folding rc into preview made 7.6.0-rc.1 compare as older than a preview, flipping an error/warning branch during the one window when the answer matters most.
  - *evidence:* `tools/version.mts` exports `compareVersions`
  - *evidence:* `tools/version.mts` exports `rankOf`
  - *evidence:* `tests/unit/version.test.mts` — test "TRAP D: rc outranks preview"
- [x] **2.15** Validate every upstream payload shape at the trust boundary
  - JSON.parse(x) as T is an unchecked assertion about a third party. A renamed .NET field would have made parseVersion(undefined) return null and the lag check silently skip, leaving the run green.
  - *evidence:* `tools/upstream-schemas.mts` exports `VALIDATORS`
  - *evidence:* `tools/upstream-schemas.mts` exports `narrow`
  - *evidence:* `tools/verify-release-truth.mts` matches `/getShape/`
- [x] **2.16** Fetch timeouts, retry with backoff, and distinct exit codes
  - 0 clean, 1 drift, 2 could-not-run, 3 internal bug. CI must not treat a rate limit as though upstream moved.
  - *evidence:* `tests/unit/upstream-sync.test.mts` — test "never describes a tool error as upstream drift"
  - *evidence:* `tools/verify-release-truth.mts` matches `/AbortSignal.timeout/`
- [x] **2.17** Cross-check the support-lifecycle doc as an independent LTS assertion
  - Its table gives LTS status and end-of-support per line, derived independently of the .NET metadata. It also surfaced that v7.4.19 loses support in 66 days.
  - *evidence:* `tools/docs-claim.mts` exports `parseLifecycleTable`
  - *evidence:* `tests/unit/docs-claim.test.mts` — test "recognises LTS rows and reads their end-of-support date"
  - *evidence:* `compat/upstream/releases.lock.json` — `discrepancies.1.code`

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- npm run truth:check passes twice in a row with no false drift
- npx tsc --noEmit is clean under strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes + erasableSyntaxOnly
- The lockfile records both SDK and runtime for every release
- No PowerShell version string is hardcoded anywhere in the tool

---

[Back to the roadmap](../../ROADMAP.md)
