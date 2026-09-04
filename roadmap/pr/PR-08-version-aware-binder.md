# 8. Build one lexer, one AST and a version-aware parameter binder

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** Core  
**Status** [ ] todo  
**Tasks** 0/7 `..................`

## Why

There are currently FOUR independent tokenizers — splitPipe, the execOne regex, parseArgsOf, and the highlighter (which colours >, >> and < that nothing can execute) — plus ad-hoc flag re-parsing inside nine command bodies. Most 7.7 breaking changes are binder-level, so the binder must be a first-class component.

## Depends on

- [~] **3. Express 7.6.5 and 7.7.0-preview.4 as compatibility profiles** — [detail](PR-03-compatibility-profiles.md)
- [~] **7. Build the typed object pipeline and stream model** — [detail](PR-07-object-pipeline.md)

## Tasks

- [ ] **8.1** Write one lexer with real quote and escape handling
- [ ] **8.2** Separate the editing parser (incremental, error-tolerant) from the execution parser (strict)
  - Error-tolerant parsing must never feed the evaluator.
- [ ] **8.3** Refuse to execute recognised-but-unimplemented syntax with an explicit error naming the AST node
- [ ] **8.4** Implement ParameterBinder with validation, parameter sets and positional binding
- [ ] **8.5** Support switchSemantics so -Switch:$false differs from -Switch absent
  - A whole class of 7.7 fixes is exactly this.
- [ ] **8.6** Apply profile parameterPatches over base metadata rather than forking commands
- [ ] **8.7** Make the highlighter share the real lexer so it cannot colour syntax the engine rejects

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- One tokenizer in the codebase
- Where-Object -Not:$false behaves per the active profile
- Format-Table -Property "" errors on 7.7 and not on 7.6, from data alone

---

[Back to the roadmap](../../ROADMAP.md)
