# 6. Move execution into a worker behind a typed kernel protocol

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** Core  
**Status** [~] in progress  
**Tasks** 2/4 +2 partial `#########/////////`

## Why

run() is a god function: parse, history, prompt echo, pipeline policy, execution, DOM print and scroll, all inline.

## Depends on

- [~] **5. Extract a headless LineEditorCore behind input and render adapters** — [detail](PR-05-headless-line-editor.md)

## Tasks

- [x] **6.1** Define the kernel protocol: submit, cancel, signal, event stream
  - *evidence:* `src/kernel/protocol.ts` exports `KERNEL_REQUEST_KINDS`
  - *evidence:* `src/kernel/protocol.ts` exports `KERNEL_EVENT_KINDS`
  - *evidence:* `src/kernel/protocol.ts` exports `KernelRequest`
  - *evidence:* `tests/unit/kernel.test.mts` — test "lists exactly the request kinds the protocol defines"
  - *evidence:* `tests/unit/kernel.test.mts` — test "covers every event kind and every stream"
- [/] **6.2** Split run() into parse -> execute -> render with no DOM access in the middle
  - MISSING: two of the three stages. Execute is real, DOM-free and heavily tested. Parse is a placeholder — splitPipeline plus a whitespace split that the kernel itself labels DELIBERATELY NOT A PARSER and marks for deletion, pending item 8. Render is not a kernel stage at all: the kernel stops at emitting events, and formatting happens inside Out-String and the Format-* commands rather than at the pipeline tail. The "no DOM in the middle" half holds, but trivially, because nothing in src/ touches the DOM yet.
  - *evidence:* `src/kernel/kernel.ts` exports `Kernel`
  - *evidence:* `src/kernel/kernel.ts` exports `splitPipeline`
  - *evidence:* `tests/unit/kernel.test.mts` — test "creates a process, emits its objects, and exits 0"
  - *evidence:* nothing under `src/**/*.ts` matches `/document.querySelector/`
- [x] **6.3** Model async commands as event streams instead of the asyncOut/busy globals
  - ping/traceroute returned null and printed themselves in v1, forcing a pipeline pre-flight hack. They are ordinary commands now, writing values that the kernel turns into events and that honour cancellation between writes.
  - *evidence:* nothing under `src/**/*.ts` matches `/asyncOut/`
  - *evidence:* `src/commands/simulated/network.ts` exports `networkCommands`
  - *evidence:* `tests/unit/simulated.test.mts` — test "draws exactly four values, as v1 does"
  - *evidence:* `tests/unit/kernel.test.mts` — test "Ctrl+C stops the foreground pipeline and leaves the background job alone"
- [/] **6.4** Stop commands mutating prompt chrome; return a CWD change instead
  - MISSING: the return channel. No command touches prompt chrome or the DOM any more — that half is real. But nothing carries a location change back either: Set-Location mutates the filesystem object's own location while the kernel's per-terminal cwd is set once at startup and never refreshed, and the protocol has no event for it. Get-Location and $env:PWD therefore read a value that a cd does not update.
  - *evidence:* `src/commands/ports.ts` exports `FileSystemPort`
  - *evidence:* `src/commands/fs-read/set-location.ts` exports `setLocation`
  - *evidence:* nothing under `src/kernel/**/*.ts` matches `/location-changed/`

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- No command implementation touches document
- Cancellation works mid-pipeline
- asyncOut special-casing is gone

---

[Back to the roadmap](../../ROADMAP.md)
