/**
 * to-string.ts — re-exports the value-to-string conversion.
 *
 * The implementation lives in `../pipeline/psobject.ts`, with the object model,
 * because "how does a PSValue become text" is part of what a PSValue IS, and
 * because the comparison, sorting, grouping and joining paths all need it.
 *
 * It briefly lived here instead, and an adversarial review caught the
 * consequence: there were then THREE renderings — this one, `renderValue` in the
 * cmdlets' support module, and bare `String()` inside the comparison fallbacks —
 * and they disagreed. `String(0.1 + 0.2)` is `0.30000000000000004` where pwsh
 * says `0.3`; `String([1,2])` is `"1,2"` where PowerShell joins with a space, so
 * `'1 2' -eq @(1,2)` answered false; and `String(date)` is a JavaScript date
 * string, which sorted `@('a', $date)` the wrong way round — the exact example
 * the sort comment cites as proof it was right.
 *
 * The same review found `src/formatting/width.ts` had drifted the same way
 * against `src/line-editor/metrics.ts`. One implementation, or they diverge.
 *
 * `formatDouble` used to be re-exported from here, and it was a FOURTH
 * rendering — a private G15 that switched to exponential at `exponent < -5`
 * where .NET switches at `< -4`, so `"$(0.00001)"` came out as `0.00001` where
 * pwsh says `1E-05`, and negative zero came out as `0` where pwsh says `-0`.
 * It is gone: `toPSString` now calls `formatGeneral(value, 15, INVARIANT, true)`
 * from `./numeric.ts`, which is the same function the `-f` operator's `G15`
 * goes through. Anything that wanted `formatDouble` wants that call.
 *
 * ONE MORE PROPERTY WORTH KNOWING AT THIS RE-EXPORT: the conversion unravels a
 * single level and then stops. That is what pwsh does — a nested PSCustomObject
 * renders as the empty string, a nested collection as its .NET type name — and
 * it is why a cyclic value renders here instead of exhausting the stack.
 * Callers that want the deep form want the FORMATTER (`render.ts`), which is a
 * different question with a different answer.
 */

export { toPSString, DEFAULT_OFS } from '../pipeline/psobject.ts';
