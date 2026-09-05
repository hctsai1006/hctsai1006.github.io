/**
 * Select-Object — projection and windowing.
 *
 * This is the command that proves the pipeline is real. `-First 3` must stop
 * the upstream, and the proof is a side effect:
 *
 *   1..10 | ForEach-Object { $seen += $_; $_ } | Select-Object -First 3
 *   $seen  ->  1,2,3                                        (pwsh 7.6.5)
 *
 * FOUR THINGS THE PROBE CORRECTED
 *
 * 1. Select-Object DROPS `$null` input objects, and they do not count toward
 *    the window:
 *      @($null,$null,1,2) | Select-Object -First 2   ->  1,2
 *      @($null,1,2)       | Select-Object -Skip 1    ->  2
 *    The obvious model — nulls flow like any other value — gives 1 and then
 *    `$null,1,2 | Skip 1` -> 1,2. Both wrong. The pipeline itself does pass
 *    nulls (Where-Object emits them); this is Select-Object's own behaviour.
 *
 * 2. `-First 0` emits nothing but does NOT stop the upstream:
 *      1..10 | ForEach-Object { $seen += $_; $_ } | Select-Object -First 0
 *      $seen  ->  1..10
 *    The stop is signalled when an object is passed through, and with zero
 *    there is never an object to pass.
 *
 * 3. A missing property is still SELECTED, holding `$null`:
 *      [pscustomobject]@{A=1} | Select-Object A,Nope   ->  A=1, Nope=$null
 *    It is not skipped, and the resulting object's shape does not depend on
 *    the input's.
 *
 * 4. `-ExpandProperty` on a missing property is an ERROR, not silence:
 *      ExpandPropertyNotFound,Microsoft.PowerShell.Commands.SelectObjectCommand
 *      InvalidArgument / PSArgumentException / 'Property "V" cannot be found.'
 *    and processing CONTINUES with the remaining objects.
 *
 * 5. A COLLISION BETWEEN -Property AND -ExpandProperty KEEPS THE EXPANDED
 *    OBJECT'S OWN VALUE, and raises a DIFFERENT error id from the duplicate
 *    -Property case:
 *      $src = @([pscustomobject]@{K=1; V=[pscustomobject]@{K=9; Z=8}})
 *      $src | Select-Object -Property K -ExpandProperty V
 *        ->  one object, K=9 and Z=8            the expanded K WINS
 *        ->  AlreadyExistingUserSpecifiedPropertyExpand,...SelectObjectCommand
 *      @([pscustomobject]@{A=1}) | Select-Object -Property A,A
 *        ->  AlreadyExistingUserSpecifiedPropertyNoExpand,...
 *    Two ids for the same sentence. This used to spread the selected
 *    properties over the expanded object, so K became 1 -- the source's value
 *    silently overwrote the expanded one, with no error and a successful exit.
 *    Where there is no collision the added property goes AFTER the expanded
 *    object's own: `-Property K -ExpandProperty V` over `V=@{Z=8}` gives Z
 *    then K.
 *
 * 6. THE PARAMETER SETS ARE REAL, and -SkipLast is what splits them. Measured
 *    on `(Get-Command Select-Object).ParameterSets`, DefaultParameter is the
 *    default and holds First/Last/Skip; SkipLastParameter holds Skip/SkipLast
 *    and NOT First or Last. So:
 *      1..5 | Select-Object -First 2 -Last 2   ->  1,2,4,5   LEGAL
 *      1..3 | Select-Object -First 2 -Last 2   ->  1,2,3     overlap dedupes
 *      1..5 | Select-Object -Skip 1 -SkipLast 1 ->  2,3,4    LEGAL
 *      1..5 | Select-Object -Last 2 -SkipLast 1 ->  AmbiguousParameterSet
 *    All four were accepted here; the last one is the one that was wrong.
 */

import { enumerate, isPSObject, psObject, psWrap, typeNameOf } from '../../pipeline/psobject.ts';
import type { PSValue } from '../../pipeline/psobject.ts';
import { throwIfCancelled } from '../../pipeline/pipeline.ts';
import { errorRecord } from '../../pipeline/streams.ts';
import type { ErrorRecord } from '../../pipeline/streams.ts';
import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import {
  INT,
  OBJECT,
  STRING,
  STRING_ARRAY,
  SWITCH,
  commandInput,
  hasResolvableProperty,
  manifest,
  matchPropertyNames,
  numberValue,
  parameter,
  renderValue,
  resolveProperty,
  selectedTypeNames,
  stringArray,
  stringValue,
  switchValue,
} from './support.ts';

/** The .NET command class name pwsh puts in the FullyQualifiedErrorId. */
const COMMAND = 'Microsoft.PowerShell.Commands.SelectObjectCommand';

function expandNotFound(property: string): ErrorRecord {
  return errorRecord(
    `Property "${property}" cannot be found.`,
    'ExpandPropertyNotFound',
    COMMAND,
    'InvalidArgument',
    { exceptionType: 'System.Management.Automation.PSArgumentException' },
  );
}

/**
 * The same sentence under two error ids, which is what pwsh does. `NoExpand` is
 * `-Property A,A`; `Expand` is `-Property K` colliding with what
 * `-ExpandProperty` produced. Both measured.
 */
function duplicateProperty(
  property: string,
  target: PSValue,
  duringExpand = false,
): ErrorRecord {
  return errorRecord(
    `The property cannot be processed because the property "${property}" already exists.`,
    duringExpand
      ? 'AlreadyExistingUserSpecifiedPropertyExpand'
      : 'AlreadyExistingUserSpecifiedPropertyNoExpand',
    COMMAND,
    'InvalidOperation',
    { exceptionType: 'System.Management.Automation.PSArgumentException', targetObject: target },
  );
}

function ambiguousParameterSet(): ErrorRecord {
  return errorRecord(
    'Parameter set cannot be resolved using the specified named parameters. One or more ' +
      'parameters issued cannot be used together or an insufficient number of parameters ' +
      'were provided.',
    'AmbiguousParameterSet',
    COMMAND,
    'InvalidArgument',
    { exceptionType: 'System.Management.Automation.ParameterBindingException' },
  );
}

interface Projection {
  readonly values: readonly PSValue[];
  readonly errors: readonly ErrorRecord[];
  /** True when `-Property` built the objects, which changes the -Unique key. */
  readonly projected: boolean;
}

function selectProperties(
  source: PSValue,
  requested: readonly string[],
): { object: PSValue; errors: readonly ErrorRecord[] } {
  // Object.create(null), not {}. With a prototype, `-Property __proto__` writes
  // through the setter and RE-PARENTS this object: Object.keys said it was empty
  // while getProperty returned the grafted values, so Format-Table and
  // Where-Object disagreed about the same object.
  const properties: Record<string, PSValue> = Object.create(null) as Record<string, PSValue>;
  const errors: ErrorRecord[] = [];
  for (const request of requested) {
    for (const name of matchPropertyNames(source, request)) {
      if (Object.hasOwn(properties, name)) {
        errors.push(duplicateProperty(name, source));
        continue;
      }
      // A property the source does not have is still added, holding null —
      // selection defines the output shape, the input does not.
      properties[name] = resolveProperty(source, name) ?? null;
    }
  }
  return { object: psObject(properties, selectedTypeNames(source)), errors };
}

/**
 * Add the selected properties to an expanded object, WITHOUT overwriting.
 *
 * The spread used to run the other way, so a `-Property K` collided with the
 * expanded object's own `K` and replaced it. Measured, pwsh keeps the expanded
 * object's value and raises AlreadyExistingUserSpecifiedPropertyExpand; the
 * collisions are returned so the caller can do that.
 */
function attach(
  value: PSValue,
  extra: Readonly<Record<string, PSValue>>,
): { value: PSValue; collisions: readonly string[] } {
  if (Object.keys(extra).length === 0) return { value, collisions: [] };
  if (isPSObject(value)) {
    const collisions = Object.keys(extra).filter((name) => Object.hasOwn(value.properties, name));
    const merged: Record<string, PSValue> = { ...value.properties };
    for (const [name, item] of Object.entries(extra)) {
      if (!Object.hasOwn(merged, name)) merged[name] = item;
    }
    return { value: psObject(merged, value.typeNames), collisions };
  }
  return { value: attachToPrimitive(value, extra), collisions: [] };
}

function attachToPrimitive(
  value: PSValue,
  extra: Readonly<Record<string, PSValue>>,
): PSValue {
  // pwsh keeps the expanded value's own type — `$r[0].GetType().FullName` is
  // System.Int32 — while still answering `$r[0].Tag`. That is a PSObject
  // wrapping the primitive, which is exactly what baseObject is for.
  return psWrap(extra, [typeNameOf(value), 'System.Object'], value);
}

function project(
  source: PSValue,
  requested: readonly string[] | undefined,
  expand: string | undefined,
): Projection {
  if (expand !== undefined) {
    if (!hasResolvableProperty(source, expand)) {
      return { values: [], errors: [expandNotFound(expand)], projected: false };
    }
    const value = resolveProperty(source, expand) ?? null;

    // Verified: `@([pscustomobject]@{V=@(1,2)}) | Select-Object -ExpandProperty V`
    // sends TWO objects. Expansion unrolls one level, which is why `enumerate`
    // is called here and not at every stage boundary.
    const expanded = [...enumerate(value)];

    if (requested === undefined) return { values: expanded, errors: [], projected: false };
    const selected = selectProperties(source, requested);
    const extra = isPSObject(selected.object) ? selected.object.properties : {};
    const errors = [...selected.errors];
    const values = expanded.map((item) => {
      const merged = attach(item, extra);
      for (const name of merged.collisions) errors.push(duplicateProperty(name, item, true));
      return merged.value;
    });
    return { values, errors, projected: false };
  }

  if (requested !== undefined) {
    const selected = selectProperties(source, requested);
    return { values: [selected.object], errors: selected.errors, projected: true };
  }
  return { values: [source], errors: [], projected: false };
}

/**
 * The key `-Unique` compares on, which is NOT what you would guess, and is not
 * even the same rule in both cases.
 *
 * Verified against pwsh 7.6.5:
 *
 *   @('a','A')     | Select-Object -Unique                  ->  a, A   (2)
 *   @(1,'1')       | Select-Object -Unique                  ->  1      (1)
 *   @('c','a','c','b') | Select-Object -Unique              ->  c,a,b  (input order, not sorted)
 *   @(o{K=1},o{K=1},o{K=2}) | Select-Object -Unique         ->  1 object
 *   @(o{K=1},o{K=1},o{K=2}) | Select-Object -Property K -Unique  ->  2 objects
 *
 * So the comparison is CASE-SENSITIVE (unlike `Sort-Object -Unique`, which is
 * case-insensitive — the two commands genuinely disagree), and `1` and `'1'`
 * collide because it compares string forms.
 *
 * The fourth line is the ugly one. `([pscustomobject]@{K=1}).ToString()` returns
 * the EMPTY STRING in pwsh, so every PSCustomObject hashes the same and
 * `-Unique` collapses them all to one — three distinct objects in, one out.
 * That is reproduced here rather than quietly improved: a user who learns this
 * command in the emulator and then runs the same line against real PowerShell
 * must not be surprised, and silently returning a better answer would hide a
 * data-destroying behaviour instead of exposing it.
 *
 * The fifth line is why `projected` exists: with `-Property`, pwsh compares the
 * CONSTRUCTED objects property by property instead, and does distinguish them.
 */
function uniqueKey(value: PSValue, projected: boolean): string {
  if (projected && isPSObject(value)) {
    return Object.entries(value.properties)
      .map(([name, item]) => `${name}=${renderValue(item)}`)
      .join('\u0000');
  }
  if (isPSObject(value)) return '';
  return renderValue(value);
}

const SELECT_OBJECT_MANIFEST = manifest({
  display: 'Select-Object',
  aliases: ['select'],
  synopsis: 'Selects objects or object properties.',
  notes:
    'Windowing (-First/-Last/-Skip/-SkipLast), projection (-Property/-ExpandProperty) and ' +
    '-Unique are implemented, and -First really does stop the upstream. -Unique reproduces ' +
    "pwsh's case-sensitive ToString comparison, including its collapse of distinct " +
    'PSCustomObjects onto one another. The parameter sets are enforced: -SkipLast belongs ' +
    'to a different set from -First and -Last, so combining them is refused the way pwsh ' +
    'refuses it, while -First with -Last is legal and windows both ends. A -Property that ' +
    'collides with what -ExpandProperty produced keeps the expanded value and reports ' +
    'AlreadyExistingUserSpecifiedPropertyExpand, verified against pwsh 7.6.5. -Wait, ' +
    '-Index, -SkipIndex, -ExcludeProperty and -CaseInsensitive are upstream-only and are ' +
    'not accepted.',
  parameters: [
    parameter('Property', STRING_ARRAY, { position: 0 }),
    parameter('ExpandProperty', STRING),
    parameter('First', INT, { validation: ['ValidateRangeAttribute'] }),
    parameter('Last', INT, { validation: ['ValidateRangeAttribute'] }),
    parameter('Skip', INT, { validation: ['ValidateRangeAttribute'] }),
    parameter('SkipLast', INT, { validation: ['ValidateRangeAttribute'] }),
    parameter('Unique', SWITCH),
    parameter('InputObject', OBJECT, { valueFromPipeline: true }),
  ],
  outputTypeNames: ['System.Management.Automation.PSObject'],
});

export const selectObject: CommandModule = {
  manifest: SELECT_OBJECT_MANIFEST,

  async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
    const parameters = bound.parameters;
    const requested = stringArray(parameters, 'Property');
    const expand = stringValue(parameters, 'ExpandProperty');
    const first = numberValue(parameters, 'First');
    const last = numberValue(parameters, 'Last');
    const skip = numberValue(parameters, 'Skip') ?? 0;
    const skipLast = numberValue(parameters, 'SkipLast');
    const unique = switchValue(parameters, 'Unique');

    // Rule 6. Measured: -SkipLast lives in SkipLastParameter, which declares
    // neither -First nor -Last, so pwsh cannot resolve the combination. All
    // three were accepted here and silently produced some window or other.
    if (skipLast !== undefined && (first !== undefined || last !== undefined)) {
      await context.streams.error.write(ambiguousParameterSet());
      return 1;
    }

    const sink = context.streams.success;
    const seenKeys = new Set<string>();

    // -Last and -SkipLast are the two windows that cannot be answered from a
    // prefix of the stream, so they buffer. -First and -Skip do not.
    const tail: PSValue[] = [];
    const delay: PSValue[] = [];
    const buffering = last !== undefined || skipLast !== undefined;

    let seen = 0;
    let taken = 0;
    let stopped = false;

    const emit = async (source: PSValue): Promise<void> => {
      const projection = project(source, requested, expand);
      for (const error of projection.errors) await context.streams.error.write(error);
      for (const value of projection.values) {
        if (unique) {
          const key = uniqueKey(value, projection.projected);
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
        }
        await sink.write(value);
      }
    };

    /** One object that has already passed the -SkipLast delay line. */
    const windowed = async (item: PSValue): Promise<void> => {
      seen += 1;
      if (seen <= skip) return;

      if (first !== undefined && taken < first) {
        taken += 1;
        await emit(item);
        // The early stop. Guarded on `first > 0` because pwsh only signals it
        // after passing an object through: `-First 0` runs the upstream to
        // completion, which the probe showed and which a `taken >= first`
        // test alone would get wrong.
        if (first > 0 && taken >= first && !buffering) stopped = true;
        return;
      }
      if (last !== undefined) {
        tail.push(item);
        if (tail.length > last) tail.shift();
        return;
      }
      // Past -First with no -Last: nothing more will be emitted, but with
      // `-First 0` we must keep draining rather than stopping the upstream.
      if (first !== undefined) return;
      await emit(item);
    };

    for await (const item of commandInput(context, parameters, COMMAND)) {
      throwIfCancelled(context.signal, 'Select-Object');

      // Nulls are dropped before anything counts them.
      if (item === null) continue;

      if (skipLast !== undefined) {
        delay.push(item);
        if (delay.length <= skipLast) continue;
        const released = delay.shift();
        if (released === undefined) continue;
        await windowed(released);
      } else {
        await windowed(item);
      }

      if (stopped || sink.closed) break;
    }

    for (const item of tail) {
      if (sink.closed || context.signal.aborted) break;
      await emit(item);
    }
    return 0;
  },
};
