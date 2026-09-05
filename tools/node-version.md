# Why the Node floor is 24.12.0

`package.json` requires `node >=24.12.0`, `.node-version` pins the tested
`24.13.0`, and `.npmrc` sets `engine-strict=true`. All three numbers are
measured, not chosen for tidiness.

## The floor: type stripping became stable at 24.12.0

Every tool and every test here is a `.mts` file executed directly — `node
tools/generate-width-table.mts`, `node --test tests/**/*.test.mts`. There is no
build step and no loader. That rests entirely on Node's native type stripping,
whose history is:

| Node    | change                                              |
|---------|-----------------------------------------------------|
| 23.6.0  | type stripping enabled by default                   |
| 24.3.0  | stops emitting an experimental warning              |
| 24.12.0 | **type stripping is stable** (`Stability: 2 - Stable`) |

Read from <https://nodejs.org/docs/latest-v24.x/api/typescript.html>. The floor
was `>=24.0.0`, which admitted 24.0–24.11 — versions where the mechanism the
entire toolchain rests on was still experimental.

`engine-strict=true` makes the range a hard error at INSTALL time — npm only
*warns* about `engines` by default. MEASURED, with the floor temporarily set to
`>=99.0.0`:

    $ npm install --dry-run
    npm error engine Unsupported engine
    npm error notsup Required: {"node":">=99.0.0"}
    npm error notsup Actual:   {"npm":"11.6.2","node":"v24.13.0"}

It does **not** gate `npm run`: the same wrong floor let `npm run typecheck`
finish normally. An earlier draft of this file claimed otherwise, and the
measurement refuted it. `tools/check-engine.mts` is what closes that path, and
it runs first in `npm run verify` — because after the first day everyone
already has `node_modules`, and the failure would otherwise arrive as a
confusing syntax error from type stripping rather than a version message.

## What type stripping does NOT do

Node **ignores `tsconfig.json`**, quoting the same page:

> Node.js ignores `tsconfig.json` files and therefore features that depend on
> settings within `tsconfig.json`, such as paths or converting newer JavaScript
> syntax to older standards, are intentionally unsupported.

So none of this project's strict settings — `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `erasableSyntaxOnly`, `verbatimModuleSyntax` — are
enforced by RUNNING the code. They are enforced by `tsc --noEmit`, which is why
`npm run verify` runs the typecheck first, and why a green test run alone is not
evidence that the types hold.

## The Unicode coupling, and why CI reads `.node-version`

`src/line-editor/cells.ts` derives what it can from the engine's own property
escapes — `\p{Mn}`, `\p{Me}`, `\p{Cf}` — and carries East_Asian_Width and
Hangul_Syllable_Type as generated tables, because those are not property
escapes. Both halves have to come from the SAME Unicode release. A character
the table calls Wide while the engine's escapes call it unassigned is a
disagreement with no correct answer.

**A patch release moves Unicode, and that is not hypothetical.** CI floated on
`node-version: '24'` and resolved **24.20.0, which carries Unicode 17.0**,
against extracts at 16.0.0. This is what happened:

    node v24.20.0 satisfies >=24.12.0 (unicode 17.0)
    ✖ keeps the checked-in UCD version and the engine s Unicode version in step

An earlier draft of this file argued that no upper bound was needed because
"the check that exists is better than the guess that would replace it", and
that a range "would also block a future Node that is fine". The first half held
— the check caught it, loudly and by name, which is exactly what it is for. The
second half was wrong: 24.20.0 is inside `>=24.12.0` and is **not** fine for
this repository as it stands.

The fix is not an upper bound, which would still be a guess about where the
next Unicode bump lands. It is that CI reads `.node-version` instead of
floating, so the engine under test is the engine this repository says it is
tested on. Upgrading past a Unicode bump is a deliberate change that moves
three things together: `.node-version`, the UCD extracts under
`tests/unit/fixtures/`, and the regenerated table.

`tools/check-engine.mts` checks this too, and runs first in `npm run verify`.
The test already covered it; the point of repeating it is that a named failure
in the first second tells the next person it is their Node, where a red test
twenty seconds in reads like their change.

## Why there is still no upper bound

`<25` would not have helped: the version that broke it, 24.20.0, is inside any
range that admits 24.13.0. An upper bound is a guess about where the next
Unicode bump lands, and the bump that actually happened was a patch release.

What closes it is the pin plus the two checks — CI runs the named version, and
both `check-engine` and the cell-width suite refuse an engine whose Unicode
does not match the extracts. That is a statement about the thing that actually
couples, rather than about a version number that only correlates with it.
