# 16. Optional xterm.js ANSI renderer alongside the semantic DOM terminal

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** Rendering  
**Status** [~] in progress  
**Tasks** 0/4 +1 partial `/////.............`

## Why

The semantic DOM terminal is what makes this accessible to screen readers and is the better default. ANSI is for TUI fidelity, and must be a second adapter rather than a replacement.

## Depends on

- [~] **7. Build the typed object pipeline and stream model** — [detail](PR-07-object-pipeline.md)

## Tasks

- [ ] **16.1** Define TerminalPort with both a semantic DOM and an xterm adapter
  - *evidence:* nothing under `src/**/*.ts` matches `/TerminalPort/`
  - *evidence:* nothing under `src/**/*.ts` matches `/xterm/`
- [ ] **16.2** Separate the ANSI parser from plain-text formatting
  - 7.7 fixes VT Reset sequences appearing mid-string; that only makes sense with a real ANSI parser. No ANSI parser exists — the only occurrences of the word are the Windows-1252 charset name on -Encoding.
  - *evidence:* `src/renderer/**/*` matches no file, though `src/**/*` does
- [/] **16.3** Use cell width rather than string length everywhere
  - MISSING: "everywhere", and the port that would give this task its point. The width engine is done and rigorous — generated from the UCD, agreeing with it on all 1 114 112 code points, and used by the formatter, the wrapper and the line editor alike. Two things fall short of the wording: ls deliberately keeps its own byte-oriented padding to model raw POSIX ls rather than terminal width, which is a documented exception rather than a bug; and the task frames this as surviving a port to a second renderer that 16.1 has not started.
  - *evidence:* `src/line-editor/cells.ts` exports `displayWidth`
  - *evidence:* `src/formatting/width.ts` exports `truncateToWidth`
  - *evidence:* `tests/unit/cell-width.test.mts` — test "agrees with the UCD on all 1 114 112 code points, not just the corpus"
  - *evidence:* `tests/unit/cell-width.test.mts` — test "renderer and line editor answer identically, on every sample"
- [ ] **16.4** Keep the semantic renderer the default and keep aria-live output intact
  - There is no renderer in src/ at all yet, so there is nothing to keep as the default. aria-live exists only in the frozen v1 file.
  - *evidence:* nothing under `src/**/*.ts` matches `/aria-live/`

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- CJK and emoji align in both renderers
- Screen-reader output is unchanged in the default renderer

---

[Back to the roadmap](../../ROADMAP.md)
