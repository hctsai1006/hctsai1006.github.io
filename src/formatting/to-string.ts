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
 */

export { toPSString, formatDouble, DEFAULT_OFS } from '../pipeline/psobject.ts';
