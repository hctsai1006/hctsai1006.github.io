# 14. Package identity, integrity, capabilities and trust promotion

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** Supply chain  
**Status** [ ] todo  
**Tasks** 0/4 `..................`

## Why

A browser package manager that downloads and evaluates JavaScript is an XSS engine with a friendly prompt. Trust has to be in the design from the first line.

## Depends on

- [ ] **10. PowerShell provider model over the mount table** — [detail](PR-10-provider-model.md)

## Tasks

- [ ] **14.1** Define the package manifest with publisher, capabilities and integrity digest
- [ ] **14.2** Verify digests before execution; refuse on mismatch
- [ ] **14.3** Run third-party modules in a sandboxed worker behind a capability broker
- [ ] **14.4** Implement a lockfile and a discovery -> review -> promotion flow
  - Models the actually-shipped PSResourceGet idea: discovery separated from trusted production consumption. Do NOT claim ORAS support — it is explicitly future work upstream.

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- A tampered package fails to install
- A module cannot reach OPFS except through granted capabilities

---

[Back to the roadmap](../../ROADMAP.md)
