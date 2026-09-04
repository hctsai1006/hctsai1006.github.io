/**
 * Get-Random — bounded numbers, and picking from a list.
 *
 * THE BOUND IS EXCLUSIVE, AND THE PROBE IS WHAT SETTLED IT
 *
 *   Get-Random -Minimum 0 -Maximum 1   twenty times  ->  0 every time
 *   Get-Random -Minimum 0 -Maximum 2   twenty times  ->  only 0 and 1
 *   Get-Random -Minimum 5 -Maximum 5   ->  ERROR, not "always 5"
 *
 * `-Maximum` is the exclusive upper bound, and an empty range is a terminating
 * argument error rather than a degenerate answer:
 *   MinGreaterThanOrEqualMax,Microsoft.PowerShell.Commands.GetRandomCommand
 *   InvalidArgument / System.ArgumentException
 *   "The Minimum value (5) cannot be greater than or equal to the Maximum value (5)."
 *
 * FOUR MORE THINGS THE PROBE CORRECTED
 *
 *   -SetSeed EMITS a value. `Get-Random -SetSeed 1` is not a separate "seed the
 *   generator" action; it seeds AND returns, and returns 42389573 every time.
 *
 *   The default range is [0, [int]::MaxValue). Proved rather than assumed:
 *   from the same seed, `Get-Random` and `Get-Random -Maximum ([int]::MaxValue)`
 *   both produced 988011271.
 *
 *   `-Count` larger than the list returns the WHOLE list, shuffled — three
 *   items for `-Count 5` over three — so it is a sample without replacement,
 *   capped. `-Count 0` is a binding error: the parameter carries
 *   ValidateRange(1, ...).
 *
 *   Double bounds produce a Double; integer bounds produce an Int32.
 *
 * WHAT IS DELIBERATELY NOT REPRODUCED: the exact sequence. It comes from .NET's
 * `Random`, whose algorithm is an implementation detail; the observable a script
 * depends on is that a seeded session replays, and that is reproduced.
 */

import { enumerate } from '../../pipeline/psobject.ts';
import type { PSValue } from '../../pipeline/psobject.ts';
import { throwIfCancelled } from '../../pipeline/pipeline.ts';
import { errorRecord } from '../../pipeline/streams.ts';
import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import {
  INT,
  OBJECT,
  SWITCH,
  isBound,
  manifest,
  numberValue,
  parameter,
  rawValue,
  switchValue,
  toNumber,
} from '../powershell/support.ts';
import type { NativeServices, RandomSource } from './services.ts';

const COMMAND = 'Microsoft.PowerShell.Commands.GetRandomCommand';

/** `[int]::MaxValue`, the default exclusive upper bound. */
const INT32_MAX = 2147483647;

const GET_RANDOM_MANIFEST = manifest({
  display: 'Get-Random',
  synopsis: 'Gets a random number, or selects objects randomly from a collection.',
  notes:
    'The bounds, the error on an empty range, sampling without replacement and the Int32/Double ' +
    'result type all match pwsh 7.6.5. The SEQUENCE does not: pwsh draws from .NET `Random`, ' +
    'whose algorithm is not reproducible here, so `-SetSeed 1` replays within a session but ' +
    'yields different numbers from the reference implementation. Not a CSPRNG — neither is ' +
    'pwsh\'s, which is why Get-SecureRandom exists.',
  parameters: [
    parameter('Maximum', OBJECT, { position: 0 }),
    parameter('Minimum', OBJECT),
    parameter('SetSeed', 'System.Nullable`1[System.Int32]'),
    parameter('Count', INT, { validation: ['ValidateRangeAttribute'] }),
    parameter('InputObject', 'System.Object[]', { position: 0, valueFromPipeline: true }),
    parameter('Shuffle', SWITCH),
  ],
  outputTypeNames: ['System.Int32', 'System.Int64', 'System.Double', 'System.Object'],
});

/**
 * The error an empty range produces. Exported so the conformance probe asks the
 * SAME function the command calls, rather than a copy of the message that could
 * drift away from it.
 */
export function minGreaterThanOrEqualMaxError(
  minimum: number,
  maximum: number,
): ReturnType<typeof errorRecord> {
  return errorRecord(
    `The Minimum value (${String(minimum)}) cannot be greater than or equal to the Maximum ` +
      `value (${String(maximum)}).`,
    'MinGreaterThanOrEqualMax',
    COMMAND,
    'InvalidArgument',
    { exceptionType: 'System.ArgumentException' },
  );
}

/** One draw. Integer bounds give an integer, as measured. */
export function drawInRange(random: RandomSource, minimum: number, maximum: number, whole: boolean): number {
  const value = minimum + random.next() * (maximum - minimum);
  return whole ? Math.floor(value) : value;
}

/**
 * Fisher-Yates over a copy, taking the first `count`. Sampling WITHOUT
 * replacement, which is what `-Count 2` over three distinct items showed:
 * `c, b`, never `c, c`.
 */
export function sampleWithoutReplacement(
  random: RandomSource,
  items: readonly PSValue[],
  count: number,
): PSValue[] {
  const pool = [...items];
  const wanted = Math.min(count, pool.length);
  for (let i = 0; i < wanted; i += 1) {
    const j = i + Math.floor(random.next() * (pool.length - i));
    const a = pool[i] as PSValue;
    const b = pool[j] as PSValue;
    pool[i] = b;
    pool[j] = a;
  }
  return pool.slice(0, wanted);
}

export function createGetRandom(services: NativeServices): CommandModule {
  return {
    manifest: GET_RANDOM_MANIFEST,

    async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
      const parameters = bound.parameters;
      const random = services.random;

      // Seeding happens first and does NOT suppress the emission.
      const seed = numberValue(parameters, 'SetSeed');
      if (seed !== undefined) random.setSeed(seed);

      const count = numberValue(parameters, 'Count');
      const shuffle = switchValue(parameters, 'Shuffle');

      // -InputObject wins over the numeric set, and pipeline input is the same
      // parameter, so both arrive here.
      const supplied = rawValue(parameters, 'InputObject');
      const items: PSValue[] = [];
      if (supplied !== undefined) {
        for (const item of enumerate(supplied)) items.push(item);
      } else if (!isBound(parameters, 'Minimum') && !isBound(parameters, 'Maximum')) {
        for await (const item of context.input) {
          throwIfCancelled(context.signal, 'Get-Random');
          items.push(item);
        }
      }

      if (items.length > 0 || shuffle) {
        const wanted = shuffle ? items.length : (count ?? 1);
        for (const value of sampleWithoutReplacement(random, items, wanted)) {
          if (context.streams.success.closed) break;
          await context.streams.success.write(value);
        }
        return 0;
      }

      const minimumRaw = rawValue(parameters, 'Minimum');
      const maximumRaw = rawValue(parameters, 'Maximum');
      const minimum = minimumRaw === undefined ? 0 : (toNumber(minimumRaw) ?? 0);
      const maximum = maximumRaw === undefined ? INT32_MAX : (toNumber(maximumRaw) ?? INT32_MAX);
      if (minimum >= maximum) {
        await context.streams.error.write(minGreaterThanOrEqualMaxError(minimum, maximum));
        return 1;
      }

      // Measured: `-Minimum 1.0 -Maximum 10.0` yields a Double, integer bounds
      // an Int32. The discriminator is whether both bounds are whole numbers.
      const whole = Number.isInteger(minimum) && Number.isInteger(maximum);
      for (let i = 0; i < (count ?? 1); i += 1) {
        throwIfCancelled(context.signal, 'Get-Random');
        if (context.streams.success.closed) break;
        await context.streams.success.write(drawInRange(random, minimum, maximum, whole));
      }
      return 0;
    },
  };
}
