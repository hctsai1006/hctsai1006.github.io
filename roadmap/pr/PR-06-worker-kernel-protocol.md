# 6. Move execution into a worker behind a typed kernel protocol

> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.

**Phase** Core  
**Status** [ ] todo  
**Tasks** 0/4 `..................`

## Why

run() is a god function: parse, history, prompt echo, pipeline policy, execution, DOM print and scroll, all inline.

## Depends on

- [ ] **5. Extract a headless LineEditorCore behind input and render adapters** — [detail](PR-05-headless-line-editor.md)

## Tasks

- [ ] **6.1** Define the kernel protocol: submit, cancel, signal, event stream
- [ ] **6.2** Split run() into parse -> execute -> render with no DOM access in the middle
- [ ] **6.3** Model async commands as event streams instead of the asyncOut/busy globals
  - ping/traceroute currently return null and print themselves, forcing a pipeline pre-flight hack.
- [ ] **6.4** Stop commands mutating prompt chrome; return a CWD change instead

## Acceptance

Observable conditions. Not opinions — each of these can be checked.

- No command implementation touches document
- Cancellation works mid-pipeline
- asyncOut special-casing is gone

---

[Back to the roadmap](../../ROADMAP.md)
