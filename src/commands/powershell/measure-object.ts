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
 *
 * 9. -StandardDeviation IS A COMPUTATION, and it is the SAMPLE one (n-1):
 *      1..5 | Measure-Object -StandardDeviation  ->  1.58113883008419
 *      [Math]::Sqrt(2.5)                         ->  1.58113883008419
 *    It is independent of the other switches -- `-Sum -StandardDeviation`
 *    fills in both, `-StandardDeviation` alone leaves Sum null. This command
 *    used to declare the switch, accept it, and always report null, which is
 *    a successful wrong answer rather than a missing feature.
 *
 * 10. -IgnoreWhiteSpace AFFECTS CHARACTERS ONLY:
 *      'a b  c' | Measure-Object -Character                      ->  6
 *      'a b  c' | Measure-Object -Character -IgnoreWhiteSpace     ->  3
 *      'a b  c' | Measure-Object -Word -IgnoreWhiteSpace          ->  3  (same
 *                                                                    as without)
 *      " a `n b " | Measure-Object -Line -IgnoreWhiteSpace        ->  2  (same)
 *    The plausible reading -- "ignore whitespace everywhere" -- would change
 *    the word and line counts too, and it is wrong.
 *
 * 11. -IgnoreWhiteSpace IS IN THE TEXT PARAMETER SET, so it conflicts with the
 *    numeric switches even though it counts nothing itself:
 *      1..3 | Measure-Object -Sum -IgnoreWhiteSpace
 *        ->  AmbiguousParameterSet,...MeasureObjectCommand
 *    Measured sets: GenericMeasure (default) holds Sum/Average/Maximum/
 *    Minimum/StandardDeviation/AllStats, TextMeasure holds Line/Word/
 *    Character/IgnoreWhiteSpace.
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
  commandInput,
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

/**
 * Running totals, NOT the values.
 *
 * The old version pushed every value into `values` and every number into
 * `numbers`, then finished with `Math.max(...numbers)`. Two problems, one of
 * them a hard failure:
 *
 *   MEASURED on node 24.13.0, `Math.max(...a)` throws
 *   `RangeError: Maximum call stack size exceeded` at 124,767 elements --
 *   124,766 is the largest that works. `1..200000 | Measure-Object -Maximum`
 *   is an ordinary thing to type and pwsh answers it in a blink; this crashed.
 *   The same spread has already bitten this repository elsewhere.
 *
 *   And Measure-Object is a STREAMING command in pwsh -- it reports on a
 *   pipeline it never has to hold. Buffering made a fold into a collection.
 *
 * Everything wanted is a fold: count, sum, sum of squares (for the standard
 * deviation), and running min/max under two different comparisons -- numeric
 * for the GenericMeasureInfo result and `compareForSorting` for the
 * GenericObjectMeasureInfo one, which is chosen by the data and cannot be
 * known until the end.
 */
interface NumericTally {
  count: number;
  /** Numeric fold. `numberCount` is how many values converted, not `count`. */
  numberCount: number;
  sum: number;
  sumOfSquares: number;
  numericMinimum: number | null;
  numericMaximum: number | null;
  /** Total-order fold, for the object-typed result. */
  objectMinimum: PSValue;
  objectMaximum: PSValue;
  sawAnyValue: boolean;
  sawNonNumeric: boolean;
}

function emptyNumericTally(): NumericTally {
  return {
    count: 0,
    numberCount: 0,
    sum: 0,
    sumOfSquares: 0,
    numericMinimum: null,
    numericMaximum: null,
    objectMinimum: null,
    objectMaximum: null,
    sawAnyValue: false,
    sawNonNumeric: false,
  };
}

interface TextTally {
  count: number;
  lines: number;
  words: number;
  characters: number;
}

/**
 * The sample standard deviation, from the running sums.
 *
 * Sample (n-1) and not population (n): measured, `1..5 | Measure-Object
 * -StandardDeviation` reports 1.58113883008419, which is sqrt(10/4), where the
 * population figure would be sqrt(10/5) = 1.414.
 *
 * Computed from sum and sum-of-squares so the command stays a single pass. The
 * textbook warning about that form losing precision on large means is real and
 * is the reason this note exists rather than a bare formula; for the pipeline
 * sizes a browser terminal sees it is the right trade against holding every
 * value, and `Math.max(0, ...)` keeps a negative rounding artefact from
 * reaching `Math.sqrt` and returning NaN.
 */
function sampleStandardDeviation(tally: NumericTally): number {
  // ZERO, not null, below two values. Measured, and it is not the guess:
  //   @(7) | Measure-Object -StandardDeviation  ->  StandardDeviation 0
  //   @()  | Measure-Object -StandardDeviation  ->  StandardDeviation 0
  // The sample formula divides by n-1 and is undefined at n=1, so `null` was
  // the reasonable answer and the wrong one.
  if (tally.numberCount < 2) return 0;
  const mean = tally.sum / tally.numberCount;
  const variance =
    Math.max(0, tally.sumOfSquares - tally.numberCount * mean * mean) / (tally.numberCount - 1);
  return Math.sqrt(variance);
}

const MEASURE_OBJECT_MANIFEST = manifest({
  display: 'Measure-Object',
  aliases: ['measure'],
  synopsis: 'Calculates the numeric properties of objects, and the characters, words and lines in text.',
  notes:
    'Both parameter sets are implemented, including the data-dependent choice between ' +
    'GenericMeasureInfo and GenericObjectMeasureInfo, -StandardDeviation (the SAMPLE ' +
    'deviation, n-1, verified against pwsh 7.6.5) and -IgnoreWhiteSpace (which affects ' +
    'the character count only, also verified). Measuring is a single streaming pass: no ' +
    'input value is retained, so a pipeline of any length costs the same. -AllStats is ' +
    'upstream-only and is not accepted. Sum/Average/Minimum/Maximum are System.Double in ' +
    'pwsh even for integer input; here they carry whatever type the shared number model ' +
    'reports, so Get-Member on a whole-number Sum says Int32 where pwsh says Double.',
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
    const wantDeviation = switchValue(parameters, 'StandardDeviation');
    const wantLine = switchValue(parameters, 'Line');
    const wantWord = switchValue(parameters, 'Word');
    const wantCharacter = switchValue(parameters, 'Character');
    const ignoreWhiteSpace = switchValue(parameters, 'IgnoreWhiteSpace');

    // Rule 11: -IgnoreWhiteSpace is in the TEXT set even though it counts
    // nothing, so it conflicts with the numeric switches. Leaving it out of
    // this test let `Measure-Object -Sum -IgnoreWhiteSpace` succeed, where
    // pwsh refuses to bind.
    const textMode = wantLine || wantWord || wantCharacter || ignoreWhiteSpace;
    const numericMode = wantSum || wantAverage || wantMaximum || wantMinimum || wantDeviation;

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
     * Errors are raised as values arrive ONLY when the numeric path is forced.
     * `@(1,'a') | Measure-Object -Maximum` reports no error at all — it quietly
     * switches to the object-typed result instead.
     *
     * -StandardDeviation forces it too, which was measured rather than assumed:
     *   @(1,'a') | Measure-Object -StandardDeviation
     *     ->  Count 2, StandardDeviation empty, and a NonNumericInputObject
     *         error for 'a'
     * There is no object-typed standard deviation to fall back to.
     */
    const forcedNumeric = wantSum || wantAverage || wantDeviation;

    for await (const item of commandInput(context, parameters, COMMAND)) {
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
          // Rule 10: -IgnoreWhiteSpace narrows the CHARACTER count and nothing
          // else. Lines and words are counted from the untouched text above.
          tally.characters += ignoreWhiteSpace
            ? text.replace(/\s/gu, '').length
            : text.length;
          textTallies.set(key, tally);
          continue;
        }

        const tally = numericTallies.get(key) ?? emptyNumericTally();
        // Rule 2: counted before any numeric conversion is attempted, which is
        // why a null property value adds to Count but not to Sum.
        tally.count += 1;

        // The total-order fold, which the object-typed result reads. It has to
        // run over EVERY value including nulls, because that result reports the
        // extremes of the data as it arrived rather than of the numbers.
        if (!tally.sawAnyValue) {
          tally.objectMinimum = value;
          tally.objectMaximum = value;
          tally.sawAnyValue = true;
        } else {
          if (compareForSorting(value, tally.objectMinimum) < 0) tally.objectMinimum = value;
          if (compareForSorting(value, tally.objectMaximum) > 0) tally.objectMaximum = value;
        }

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
            tally.numberCount += 1;
            tally.sum += asNumber;
            tally.sumOfSquares += asNumber * asNumber;
            tally.numericMinimum =
              tally.numericMinimum === null || asNumber < tally.numericMinimum
                ? asNumber
                : tally.numericMinimum;
            tally.numericMaximum =
              tally.numericMaximum === null || asNumber > tally.numericMaximum
                ? asNumber
                : tally.numericMaximum;
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
            wantDeviation,
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
    wantDeviation: boolean;
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
        // Measured: `@() | Measure-Object -StandardDeviation` reports 0, while
        // `@() | Measure-Object` leaves it null. The switch is what decides,
        // not the emptiness.
        StandardDeviation: wants.wantDeviation ? 0 : null,
        Property: key,
      },
      GENERIC_TYPE,
    );
  }

  const onlyExtremes = !wants.wantSum && !wants.wantAverage && !wants.wantDeviation;

  // Rule 8: the OBJECT-typed result is chosen by the data, and only when Sum
  // and Average were both left out.
  if (onlyExtremes && tally.sawNonNumeric) {
    return typedObject(
      {
        Count: tally.count,
        Average: null,
        Sum: null,
        Maximum: wants.wantMaximum ? tally.objectMaximum : null,
        Minimum: wants.wantMinimum ? tally.objectMinimum : null,
        StandardDeviation: null,
        Property: key,
      },
      GENERIC_OBJECT_TYPE,
    );
  }

  // Rule 5: one bad value suppresses every numeric result. Count survives.
  const usable = !tally.sawNonNumeric && tally.numberCount > 0;
  const sum = usable ? tally.sum : null;
  return typedObject(
    {
      Count: tally.count,
      Average: usable && wants.wantAverage && sum !== null ? sum / tally.numberCount : null,
      Sum: wants.wantSum ? sum : null,
      // No spread. `Math.max(...numbers)` threw RangeError at 124,767 values;
      // these are running extremes kept as the pipeline went past.
      Maximum: usable && wants.wantMaximum ? tally.numericMaximum : null,
      Minimum: usable && wants.wantMinimum ? tally.numericMinimum : null,
      StandardDeviation:
        usable && wants.wantDeviation ? sampleStandardDeviation(tally) : null,
      Property: key,
    },
    GENERIC_TYPE,
  );
}
