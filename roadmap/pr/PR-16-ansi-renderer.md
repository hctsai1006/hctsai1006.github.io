# 16. Optional xterm.js ANSI renderer alongside the semantic DOM terminal

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** Rendering  
**Status** [ ] todo  
**Tasks** 0/4 `..................`

## Why

The semantic DOM terminal is what makes this accessible to screen readers and is the better default. ANSI is for TUI fidelity, and must be a second adapter rather than a replacement.

## Depends on

- [~] **7. Build the typed object pipeline and stream model** — [detail](PR-07-object-pipeline.md)

## Tasks

- [ ] **16.1** Define TerminalPort with both a semantic DOM and an xterm adapter
- [ ] **16.2** Separate the ANSI parser from plain-text formatting
  - 7.7 fixes VT Reset sequences appearing mid-string; that only makes sense with a real ANSI parser.
- [ ] **16.3** Use cell width rather than string length everywhere
  - The existing dw() double-width counter is correct and must survive the port; 7.7 also fixes double-width progress rendering.
- [ ] **16.4** Keep the semantic renderer the default and keep aria-live output intact

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- CJK and emoji align in both renderers
- Screen-reader output is unchanged in the default renderer

---

[Back to the roadmap](../../ROADMAP.md)
