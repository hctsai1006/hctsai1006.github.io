/**
 * Measure-Object.
 *
 * The command with the most wrong guesses per line in the whole set. Everything
 * below was read off pwsh 7.6.5; the reasoning that produced the opposite
 * answer is recorded next to each, because it is good reasoning that happens to
 * be wrong.
 *
 * 1. NULLS ARE NOT COUNTED — but the pipeline did not drop them.
 *      @($null,1) | Measure-Object            ->  Count 1
 *      @($null,1) | ForEach-Object { }        ->  runs TWICE
 *    Already recorded in psobject.ts; restated here because this is the command
 *    that owns the behaviour.
 *
 * 2. A NULL PROPERTY VALUE *IS* COUNTED. This is the distinction that makes (1)
 *    a rule about input objects rather than about nulls in general:
 *      @(o{V=$null},o{V=$null},o{V=5}) | Measure-Object -Property V       ->  Count 3
 *      @(o{V=$null},o{V=$null},o{V=5}) | Measure-Object -Property V -Sum  ->  Count 3, Sum 5
 *    Three counted, one summed.
 *
 * 3. AN OBJECT MISSING THE PROPERTY IS NOT COUNTED, AND IT IS NOT AN ERROR:
 *      @(o{V=1},o{Name='b'},o{V=3}) | Measure-Object -Property V -Sum
 *        ->  Count 2, Sum 4, zero errors
 *    Count 2 out of three objects. The obvious guess — Count is how many
 *    objects went past — is wrong, and it is wrong SILENTLY.
 *
 * 4. IF NO OBJECT HAS THE PROPERTY, NOTHING IS EMITTED AT ALL:
 *      @(o{Other=1}) | Measure-Object -Property V   ->  $null
 *      @()           | Measure-Object               ->  Count 0 object
 *    An empty pipeline still produces a result; an empty *property* does not.
 *
 * 5. ONE NON-NUMERIC VALUE SUPPRESSES EVERY NUMERIC RESULT, not just its own:
 *      @('a',1) | Measure-Object -Sum
 *        ->  Count 2, Sum EMPTY, one NonNumericInputObject error
 *    The 1 is numeric and is still not summed.
 *
 * 6. NUMERIC STRINGS CONVERT. `@('2','10') | Measure-Object -Sum` is 12, not an
 *    error and not string concatenation.
 *
 * 7. -Line/-Word/-Character IS A DIFFERENT PARAMETER SET AND A DIFFERENT OUTPUT
 *    TYPE. `Measure-Object -Sum -Word` does not measure both; it throws
 *    AmbiguousParameterSet. The text result has no Count property at all.
 *
 * 8. THE RESULT TYPE DEPENDS ON THE DATA, not only on the switches:
 *      @(1,2)     | Measure-Object -Maximum        ->  GenericMeasureInfo
 *      @('a','b') | Measure-Object -Maximum        ->  GenericObjectMeasureInfo
 *      @('a','b') | Measure-Object -Maximum -Sum   ->  GenericMeasureInfo + errors
 *    Asking only for Min/Max over non-numeric data switches to the object-typed
 *    result, where Maximum is `System.Object` instead of `double`.
 */

import { compareForSorting } from '../../pipeline/psobject.ts';
import type { PSValue } from '../../pipeline/psobject.ts';
import { throwIfCancelled } from '../../pipeline/pipeline.ts';
import { errorRecord } from '../../pipeline/streams.ts';
import type { ErrorRecord } from '../../pipeline/streams.ts';
import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import {
  OBJECT,
  STRING_ARRAY,
  SWITCH,
  hasResolvableProperty,
  manifest,
  parameter,
  renderValue,
  resolveProperty,
  stringArray,
  switchValue,
  toNumber,
  typedObject,
} from './support.ts';

const COMMAND = 'Microsoft.PowerShell.Commands.MeasureObjectCommand';

const GENERIC_TYPE = [
  'Microsoft.PowerShell.Commands.GenericMeasureInfo',
  'Microsoft.PowerShell.Commands.MeasureInfo',
  'System.Object',
] as const;

const GENERIC_OBJECT_TYPE = [
  'Microsoft.PowerShell.Commands.GenericObjectMeasureInfo',
  'Microsoft.PowerShell.Commands.MeasureInfo',
  'System.Object',
] as const;

const TEXT_TYPE = [
  'Microsoft.PowerShell.Commands.TextMeasureInfo',
  'Microsoft.PowerShell.Commands.MeasureInfo',
  'System.Object',
] as const;

function nonNumeric(value: PSValue): ErrorRecord {
  return errorRecord(
    `Input object "${renderValue(value)}" is not numeric.`,
    'NonNumericInputObject',
    COMMAND,
    'InvalidType',
    { targetObject: value, exceptionType: 'System.InvalidOperationException' },
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

/**
 * How many lines is this string?
 *
 * Every case was measured, because the rule is not "count the newlines" and it
 * is not "split and count" either:
 *
 *   ''        -> 0        a\n     -> 1
 *   'a'       -> 1        a\nb    -> 2
 *   '\n'      -> 1        a\n\nb  -> 3
 *   'a\n\n'   -> 2        a\r\nb  -> 2
 *
 * Split on \n and drop ONE trailing empty segment fits all eight; "1 + newline
 * count" gets '' and 'a\n' wrong, and a plain split gets 'a\n' and '' wrong.
 */
function countLines(text: string): number {
  const parts = text.split('\n');
  if (parts.length > 0 && parts.at(-1) === '') parts.pop();
  return parts.length;
}

function countWords(text: string): number {
  return text.split(/\s+/u).filter((word) => word.length > 0).length;
}

interface NumericTally {
  count: number;
  readonly values: PSValue[];
  readonly numbers: number[];
  sawNonNumeric: boolean;
}

interface TextTally {
  count: number;
  lines: number;
  words: number;
  characters: number;
}

const MEASURE_OBJECT_MANIFEST = manifest({
  display: 'Measure-Object',
  aliases: ['measure'],
  synopsis: 'Calculates the numeric properties of objects, and the characters, words and lines in text.',
  notes:
    'Both parameter sets are implemented, including the data-dependent choice between ' +
    'GenericMeasureInfo and GenericObjectMeasureInfo. -StandardDeviation is NOT implemented: ' +
    'the property is present on the result and always null, matching where pwsh leaves it ' +
    'when the switch is absent. Sum/Average/Minimum/Maximum are System.Double in pwsh even ' +
    'for integer input; here they carry whatever type the shared number model reports, so ' +
    'Get-Member on a whole-number Sum says Int32 where pwsh says Double.',
  parameters: [
    parameter('Property', STRING_ARRAY, { position: 0 }),
    parameter('Sum', SWITCH),
    parameter('Average', SWITCH),
    parameter('Maximum', SWITCH, { aliases: ['Max'] }),
    parameter('Minimum', SWITCH, { aliases: ['Min'] }),
    parameter('StandardDeviation', SWITCH),
    parameter('Line', SWITCH),
    parameter('Word', SWITCH),
    parameter('Character', SWITCH),
    parameter('IgnoreWhiteSpace', SWITCH),
    parameter('InputObject', OBJECT, { valueFromPipeline: true }),
  ],
  outputTypeNames: [
    'Microsoft.PowerShell.Commands.GenericMeasureInfo',
    'Microsoft.PowerShell.Commands.GenericObjectMeasureInfo',
    'Microsoft.PowerShell.Commands.TextMeasureInfo',
  ],
});

export const measureObject: CommandModule = {
  manifest: MEASURE_OBJECT_MANIFEST,

  async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
    const parameters = bound.parameters;
    const properties = stringArray(parameters, 'Property');
    const wantSum = switchValue(parameters, 'Sum');
    const wantAverage = switchValue(parameters, 'Average');
    const wantMaximum = switchValue(parameters, 'Maximum');
    const wantMinimum = switchValue(parameters, 'Minimum');
    const wantLine = switchValue(parameters, 'Line');
    const wantWord = switchValue(parameters, 'Word');
    const wantCharacter = switchValue(parameters, 'Character');

    const textMode = wantLine || wantWord || wantCharacter;
    const numericMode = wantSum || wantAverage || wantMaximum || wantMinimum;

    if (textMode && numericMode) {
      // Not a warning and not a partial result: pwsh refuses to bind at all.
      await context.streams.error.write(ambiguousParameterSet());
      return 1;
    }

    // `Property` of `null` is what pwsh shows when the switch was not used; the
    // key must still exist so the result's shape does not depend on the input.
    const keys: readonly (string | null)[] = properties ?? [null];

    const numericTallies = new Map<string | null, NumericTally>();
    const textTallies = new Map<string | null, TextTally>();
    /**
     * Errors are raised as values arrive ONLY when Sum or Average was asked
     * for, because that is the only case where the numeric path is forced.
     * `@(1,'a') | Measure-Object -Maximum` reports no error at all — it quietly
     * switches to the object-typed result instead.
     */
    const forcedNumeric = wantSum || wantAverage;

    for await (const item of context.input) {
      throwIfCancelled(context.signal, 'Measure-Object');

      // Rule 1: a null INPUT object is skipped entirely. Not a null property.
      if (item === null) continue;

      for (const key of keys) {
        // Rule 3: no property, no contribution, no error.
        if (key !== null && !hasResolvableProperty(item, key)) continue;
        const value = key === null ? item : (resolveProperty(item, key) ?? null);

        if (textMode) {
          const tally = textTallies.get(key) ?? { count: 0, lines: 0, words: 0, characters: 0 };
          const text = renderValue(value);
          tally.count += 1;
          tally.lines += countLines(text);
          tally.words += countWords(text);
          tally.characters += text.length;
          textTallies.set(key, tally);
          continue;
        }

        const tally = numericTallies.get(key) ?? {
          count: 0,
          values: [],
          numbers: [],
          sawNonNumeric: false,
        };
        // Rule 2: counted before any numeric conversion is attempted, which is
        // why a null property value adds to Count but not to Sum.
        tally.count += 1;
        tally.values.push(value);

        // A null property value is counted and then IGNORED: it is neither
        // summed nor reported as non-numeric.
        //   @(o{V=$null},o{V=5}) | Measure-Object -Property V -Sum
        //     ->  Count 2, Sum 5, zero errors
        // Treating it as non-numeric would suppress the Sum entirely by rule 5,
        // turning a working measurement into a blank one.
        if (value !== null) {
          const asNumber = toNumber(value);
          if (asNumber === undefined) {
            tally.sawNonNumeric = true;
            if (forcedNumeric) await context.streams.error.write(nonNumeric(value));
          } else {
            tally.numbers.push(asNumber);
          }
        }
        numericTallies.set(key, tally);
      }
    }

    for (const key of keys) {
      const result = textMode
        ? buildText(key, textTallies.get(key), { wantLine, wantWord, wantCharacter })
        : buildNumeric(key, numericTallies.get(key), {
            wantSum,
            wantAverage,
            wantMaximum,
            wantMinimum,
          });
      if (result !== null) await context.streams.success.write(result);
    }
    return 0;
  },
};

function buildText(
  key: string | null,
  tally: TextTally | undefined,
  wants: { wantLine: boolean; wantWord: boolean; wantCharacter: boolean },
): PSValue | null {
  // Rule 4, in its text-mode form.
  if (tally === undefined) return key === null ? emptyText(key, wants) : null;
  return typedObject(
    {
      Lines: wants.wantLine ? tally.lines : null,
      Words: wants.wantWord ? tally.words : null,
      Characters: wants.wantCharacter ? tally.characters : null,
      Property: key,
    },
    TEXT_TYPE,
  );
}

function emptyText(
  key: string | null,
  wants: { wantLine: boolean; wantWord: boolean; wantCharacter: boolean },
): PSValue {
  return typedObject(
    {
      Lines: wants.wantLine ? 0 : null,
      Words: wants.wantWord ? 0 : null,
      Characters: wants.wantCharacter ? 0 : null,
      Property: key,
    },
    TEXT_TYPE,
  );
}

function buildNumeric(
  key: string | null,
  tally: NumericTally | undefined,
  wants: {
    wantSum: boolean;
    wantAverage: boolean;
    wantMaximum: boolean;
    wantMinimum: boolean;
  },
): PSValue | null {
  if (tally === undefined) {
    // An empty pipeline still reports Count 0 — but only when no property was
    // named. `@(o{Other=1}) | Measure-Object -Property V` emits nothing.
    if (key !== null) return null;
    return typedObject(
      {
        Count: 0,
        Average: null,
        Sum: null,
        Maximum: null,
        Minimum: null,
        StandardDeviation: null,
        Property: key,
      },
      GENERIC_TYPE,
    );
  }

  const onlyExtremes = !wants.wantSum && !wants.wantAverage;

  // Rule 8: the OBJECT-typed result is chosen by the data, and only when Sum
  // and Average were both left out.
  if (onlyExtremes && tally.sawNonNumeric) {
    const sorted = [...tally.values].sort((a, b) => compareForSorting(a, b));
    return typedObject(
      {
        Count: tally.count,
        Average: null,
        Sum: null,
        Maximum: wants.wantMaximum ? (sorted.at(-1) ?? null) : null,
        Minimum: wants.wantMinimum ? (sorted[0] ?? null) : null,
        StandardDeviation: null,
        Property: key,
      },
      GENERIC_OBJECT_TYPE,
    );
  }

  // Rule 5: one bad value suppresses every numeric result. Count survives.
  const usable = !tally.sawNonNumeric && tally.numbers.length > 0;
  const sum = usable ? tally.numbers.reduce((a, b) => a + b, 0) : null;
  return typedObject(
    {
      Count: tally.count,
      Average: usable && wants.wantAverage && sum !== null ? sum / tally.numbers.length : null,
      Sum: wants.wantSum ? sum : null,
      Maximum: usable && wants.wantMaximum ? Math.max(...tally.numbers) : null,
      Minimum: usable && wants.wantMinimum ? Math.min(...tally.numbers) : null,
      StandardDeviation: null,
      Property: key,
    },
    GENERIC_TYPE,
  );
}
