# 16. Optional xterm.js ANSI renderer alongside the semantic DOM terminal

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** Rendering  
**Status** [~] in progress  
**Tasks** 3/4 +1 partial `##############////`

## Why

The semantic DOM terminal is what makes this accessible to screen readers and is the better default. ANSI is for TUI fidelity, and must be a second adapter rather than a replacement.

## Depends on

- [~] **7. Build the typed object pipeline and stream model** — [detail](PR-07-object-pipeline.md)

## Tasks

- [x] **16.1** Define TerminalPort with both a semantic DOM and an xterm adapter
  - The port carries write/clear/snapshot/unsupported and no input surface at all, so the xterm adapter cannot become a second input owner beside the line editor and the real textarea. LEFT OPEN on purpose, because it is not this task's to settle: xterm's own `open()` installs its helper textarea and key listeners, and whether the host suppresses them belongs to the input seam. No dependency was added — the module is injected, so every adapter test runs with no xterm installed.
  - *evidence:* `src/renderer/port.ts` exports `TerminalPort`
  - *evidence:* `src/renderer/semantic.ts` exports `createSemanticTerminal`
  - *evidence:* `src/renderer/xterm.ts` exports `createXtermTerminal`
  - *evidence:* `tests/unit/renderer-semantic.test.mts` — test "names itself the semantic renderer"
  - *evidence:* `tests/unit/renderer-xterm.test.mts` — test "builds a port that writes through to xterm"
  - *evidence:* `tests/unit/renderer-xterm.test.mts` — test "never touches xterm's input surface"
- [x] **16.2** Separate the ANSI parser from plain-text formatting
  - A resumable VT500 state machine in src/renderer/ansi.ts, and the separation is a direction that is now checked: nothing under src/formatting/ imports the renderer. The reason, measured with this repository's own Format-Table: a cell holding an SGR-wrapped `foo` sizes its column to 10 and draws 3, so the plain row beside it lands seven columns further right. The parser is resumable because a regex over one chunk emits a half-written sequence as visible text — which is what "VT Reset sequences appearing mid-string" looks like from the outside.
  - *evidence:* `src/renderer/ansi.ts` exports `AnsiParser`
  - *evidence:* `src/renderer/ansi.ts` exports `stripAnsi`
  - *evidence:* `tests/unit/renderer-ansi.test.mts` — test "is resumable: a sequence split one character at a time parses identically"
  - *evidence:* `tests/unit/renderer-ansi.test.mts` — test "discards a malformed CSI whole rather than printing its tail"
  - *evidence:* `tests/unit/renderer-ansi.test.mts` — test "a coloured cell misaligns the table by the printable length of its sequences"
  - *evidence:* `tests/unit/renderer-ansi.test.mts` — test "nothing under src/formatting imports the renderer"
- [/] **16.3** Use cell width rather than string length everywhere
  - MISSING: "everywhere", which is now down to two DELIBERATE exceptions and nothing else. The port that gave this task its point exists: the renderer places characters with the same cellWidthOfCodePoint the formatter and the line editor use, and the xterm adapter hands xterm a Unicode provider backed by it rather than letting xterm measure — a sweep of all 1 112 064 scalar values asserts the provider and the table never disagree. What still pads by character count: ls, which models raw POSIX ls piped to a file, and the -f operator, whose alignment is .NET String.Format's and really does pad "中文" to four columns with two spaces. Both are measured divergences documented at their call sites, so the honest status is partial rather than done.
  - *evidence:* `src/line-editor/cells.ts` exports `displayWidth`
  - *evidence:* `src/formatting/width.ts` exports `truncateToWidth`
  - *evidence:* `src/renderer/grid.ts` exports `runsOf`
  - *evidence:* `tests/unit/cell-width.test.mts` — test "agrees with the UCD on all 1 114 112 code points, not just the corpus"
  - *evidence:* `tests/unit/cell-width.test.mts` — test "renderer and line editor answer identically, on every sample"
  - *evidence:* `tests/unit/renderer-grid.test.mts` — test "puts the letter after two ideographs in column 4, not column 2"
  - *evidence:* `tests/unit/renderer-xterm.test.mts` — test "answers with this project's own table, code point for code point"
- [x] **16.4** Keep the semantic renderer the default and keep aria-live output intact
  - createTerminal returns the semantic renderer synchronously and the xterm one only when asked for by name, so the accessible renderer is the one you get by saying nothing. role/aria-live/aria-atomic/aria-label are asserted against the values read out of legacy/terminal-v1.html rather than restated. All 1102 captured v1 rows are replayed and compared as accessible text; 1098 are byte-identical. THE FOUR THAT ARE NOT are the tab-bearing rows of lsb_release: v1 put a raw TAB in a text node, and a terminal advances to the next stop at a multiple of eight, which is also what xterm does with the same bytes. Keeping the raw tab would make the two renderers disagree about every line containing one.
  - *evidence:* `src/renderer/index.ts` exports `createTerminal`
  - *evidence:* `src/renderer/semantic.ts` exports `LOG_REGION_LIVE`
  - *evidence:* `tests/unit/renderer-semantic.test.mts` — test "carries exactly the attributes v1 puts on #out"
  - *evidence:* `tests/unit/renderer-semantic.test.mts` — test "reproduces every captured row byte for byte, but for expanded tabs"
  - *evidence:* `tests/unit/renderer-semantic.test.mts` — test "puts unstyled text in a text node, with no wrapper element"
  - *evidence:* `tests/unit/renderer-semantic.test.mts` — test "keeps an escape sequence out of the accessible text entirely"

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- CJK and emoji align in both renderers
- Screen-reader output is unchanged in the default renderer

---

[Back to the roadmap](../../ROADMAP.md)
