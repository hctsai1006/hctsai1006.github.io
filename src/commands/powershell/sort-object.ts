/**
 * Sort-Object.
 *
 * THE HEADLINE CORRECTION: pwsh's Sort-Object is NOT stable by default.
 *
 * The brief for this command said it must be stable. It is — but "PowerShell's
 * sort is stable" is false, and the difference is worth stating precisely
 * because it looks true until you feed it enough data:
 *
 *   $in = 1..20 | ForEach-Object { [pscustomobject]@{ Key = $_ % 3; Idx = $_ } }
 *   $in | Sort-Object Key            ->  0:18 0:3 0:15 0:6 0:12 0:9 | 1:1 ...
 *   $in | Sort-Object Key -Stable    ->  0:3 0:6 0:9 0:12 0:15 0:18 | 1:1 ...
 *
 * The default scrambles ties. At eight elements it does not:
 *
 *   1..8 as above | Sort-Object Key  ->  0:2 0:4 0:6 0:8 1:1 1:3 1:5 1:7
 *
 * That is .NET's introsort falling back to insertion sort below its threshold —
 * stable by accident, for small inputs only. pwsh added an explicit `-Stable`
 * switch (PowerShell 6.2) precisely because the default is not.
 *
 * This implementation is ALWAYS stable, and that is a deliberate, recorded
 * divergence rather than an oversight. The alternative is to reproduce the tie
 * order of a specific introsort implementation — pivot choices and all — which
 * is not reproducible in a browser, would differ between engines, and would
 * make a differential test flap. Every order pwsh produces for ties is *an*
 * arbitrary order; ours is one of them, and it is the one `-Stable` gives.
 *
 * TWO MORE CORRECTIONS
 *
 *   Sort-Object DROPS `$null` input objects:
 *     @(3,$null,1,$null,2) | Sort-Object   ->  1,2,3   (three items, not five)
 *   Nulls do not sort first, and they do not sort last. They are gone. A
 *   *property* holding null is different: that object survives and sorts first
 *   ascending, matching compareValues.
 *
 *   An object MISSING the sort property sorts LAST in BOTH directions:
 *     asc   ->  has1, has3, none
 *     desc  ->  has3, has1, none
 *   So "missing" is not "null" here — null flips with -Descending, missing does
 *   not. Treating an absent property as null would put it first ascending,
 *   which is the wrong answer in the most common shape there is (a collection
 *   where some objects lack the property).
 */

import { compareForSorting } from '../../pipeline/psobject.ts';
import type { PSValue } from '../../pipeline/psobject.ts';
import { throwIfCancelled } from '../../pipeline/pipeline.ts';
import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import {
  OBJECT,
  STRING_ARRAY,
  SWITCH,
  emitAll,
  hasResolvableProperty,
  manifest,
  parameter,
  resolveProperty,
  stringArray,
  switchValue,
} from './support.ts';

interface Keyed {
  readonly value: PSValue;
  /** Input position. The tiebreaker that makes the sort stable. */
  readonly index: number;
}

function makeComparer(
  properties: readonly string[] | undefined,
  descending: boolean,
  caseSensitive: boolean,
): (a: Keyed, b: Keyed) => number {
  const compareOne = (a: PSValue, b: PSValue): number => {
    const result = compareForSorting(a, b, caseSensitive);
    return descending ? -result : result;
  };

  return (left: Keyed, right: Keyed): number => {
    if (properties === undefined || properties.length === 0) {
      const result = compareOne(left.value, right.value);
      return result !== 0 ? result : left.index - right.index;
    }
    for (const property of properties) {
      const leftHas = hasResolvableProperty(left.value, property);
      const rightHas = hasResolvableProperty(right.value, property);
      if (!leftHas && !rightHas) continue;
      // NOT passed through `compareOne`: -Descending must not flip this.
      // Verified above — an object without the property is last either way.
      if (!leftHas) return 1;
      if (!rightHas) return -1;
      const result = compareOne(
        resolveProperty(left.value, property) ?? null,
        resolveProperty(right.value, property) ?? null,
      );
      if (result !== 0) return result;
    }
    return left.index - right.index;
  };
}

const SORT_OBJECT_MANIFEST = manifest({
  display: 'Sort-Object',
  aliases: ['sort'],
  synopsis: 'Sorts objects by property values.',
  notes:
    'Always stable. pwsh 7.6.5 is stable only below .NET’s insertion-sort threshold and ' +
    'offers -Stable for the guarantee; this implementation gives the -Stable ordering ' +
    'unconditionally, because reproducing a specific introsort’s tie order is neither ' +
    'possible nor useful in a browser. -Top, -Bottom and -Culture are not implemented.',
  parameters: [
    parameter('Property', STRING_ARRAY, { position: 0 }),
    parameter('Descending', SWITCH),
    parameter('Unique', SWITCH),
    parameter('CaseSensitive', SWITCH),
    parameter('Stable', SWITCH),
    parameter('InputObject', OBJECT, { valueFromPipeline: true }),
  ],
  outputTypeNames: ['System.Object'],
});

export const sortObject: CommandModule = {
  manifest: SORT_OBJECT_MANIFEST,

  async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
    const parameters = bound.parameters;
    const properties = stringArray(parameters, 'Property');
    const descending = switchValue(parameters, 'Descending');
    const unique = switchValue(parameters, 'Unique');
    const caseSensitive = switchValue(parameters, 'CaseSensitive');

    // Sorting is a BLOCKING stage: nothing can be emitted before the last input
    // arrives, so `Sort-Object` genuinely has to hold the set. That is a real
    // memory cost and it is PowerShell's cost too, not an implementation choice.
    const buffered: Keyed[] = [];
    for await (const item of context.input) {
      throwIfCancelled(context.signal, 'Sort-Object');
      if (item === null) continue;
      buffered.push({ value: item, index: buffered.length });
    }

    const comparer = makeComparer(properties, descending, caseSensitive);
    // Array.prototype.sort is required to be stable since ES2019, and the
    // explicit index tiebreaker above makes the guarantee independent of that.
    buffered.sort(comparer);

    let ordered: readonly Keyed[] = buffered;
    if (unique) {
      // Deduplication is by the SORT comparison, not by string identity, which
      // is why `@('b','A','a','B','b') | Sort-Object -Unique` gives A,b rather
      // than four items: -eq is case-insensitive, so A and a are one value.
      // (Select-Object -Unique disagrees and is case-sensitive. They really do
      // differ; see the note there.)
      const kept: Keyed[] = [];
      for (const entry of buffered) {
        const previous = kept.at(-1);
        if (previous !== undefined && comparerTiesOn(comparer, previous, entry)) continue;
        kept.push(entry);
      }
      ordered = kept;
    }

    await emitAll(
      context.streams.success,
      ordered.map((entry) => entry.value),
      context.signal,
    );
    return 0;
  },
};

/**
 * Two entries are duplicates when they compare equal ignoring the stability
 * tiebreaker — the comparer never returns 0 (indexes differ), so the tiebreaker
 * has to be subtracted back out rather than tested for zero.
 */
function comparerTiesOn(
  comparer: (a: Keyed, b: Keyed) => number,
  left: Keyed,
  right: Keyed,
): boolean {
  const probe: Keyed = { value: right.value, index: left.index };
  return comparer(left, probe) === 0;
}
