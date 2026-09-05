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

## Why there is no upper bound

The obvious one is `<25`, and it would be a guess. The one engine coupling this
repository actually has is Unicode: `src/line-editor/cells.ts` carries
East_Asian_Width and Hangul_Syllable_Type tables for Unicode 16.0.0, chosen to
match `process.versions.unicode`, because a character that a 17.0 table calls
Wide while the engine's own property escapes call it unassigned is a
disagreement with no correct answer.

That coupling is already **enforced by a test**: `tests/unit/cell-width.test.mts`
asserts the table's version equals `process.versions.unicode`, so an engine that
moves Unicode fails loudly and by name. A version range would be a weaker
statement of the same fact, and it would also block a future Node that is fine.
The check that exists is better than the guess that would replace it.
