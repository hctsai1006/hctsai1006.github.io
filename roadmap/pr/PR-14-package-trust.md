# 14. Package identity, integrity, capabilities and trust promotion

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** Supply chain  
**Status** [~] in progress  
**Tasks** 0/4 +1 partial `/////.............`

## Why

A browser package manager that downloads and evaluates JavaScript is an XSS engine with a friendly prompt. Trust has to be in the design from the first line.

## Depends on

- [~] **10. PowerShell provider model over the mount table** — [detail](PR-10-provider-model.md)

## Tasks

- [ ] **14.1** Define the package manifest with publisher, capabilities and integrity digest
  - The only digest verification in the repository guards conformance fixtures against tampering, which is a different trust boundary.
  - *evidence:* nothing under `src/**/*.ts` matches `/PackageManifest/`
- [ ] **14.2** Verify digests before execution; refuse on mismatch
  - *evidence:* `src/packages/**/*` matches no file, though `src/**/*` does
- [/] **14.3** Run third-party modules in a sandboxed worker behind a capability broker
  - MISSING: the sandbox. The capability broker is real, enforced on every command today and thoroughly tested — two gates, declared and granted, with an append-only audit log that records denials and elevations. The isolation half does not exist, and src/kernel/inspect.ts says so itself: the real boundary is a separate Worker or a sandboxed iframe with a message-only API and no shared global, and that is future work. Without it the broker guards a boundary that a module could simply step around.
  - *evidence:* `src/kernel/capabilities.ts` exports `CapabilityBroker`
  - *evidence:* `src/kernel/capabilities.ts` exports `AuditLog`
  - *evidence:* `tests/unit/kernel-capabilities.test.mts` — test "denies a capability that is declared but not granted"
  - *evidence:* `tests/unit/kernel-capabilities.test.mts` — test "records a denial, which is the line a reviewer actually looks for"
  - *evidence:* nothing under `src/**/*.ts` matches `/new Worker/`
- [ ] **14.4** Implement a lockfile and a discovery -> review -> promotion flow
  - Models the actually-shipped PSResourceGet idea: discovery separated from trusted production consumption. Do NOT claim ORAS support — it is explicitly future work upstream. The only lockfile here is the upstream release lockfile from item 2, which is unrelated.
  - *evidence:* `src/packages/**/*` matches no file, though `src/**/*` does

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- A tampered package fails to install
- A module cannot reach OPFS except through granted capabilities

---

[Back to the roadmap](../../ROADMAP.md)
