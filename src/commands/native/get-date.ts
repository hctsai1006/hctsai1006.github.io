/**
 * Get-Date — the clock, and the two format languages.
 *
 * WHAT THE PROBE CORRECTED
 *
 * 1. `-Year`, `-Month`, `-Day`, `-Hour`, `-Minute`, `-Second`, `-Millisecond`
 *    are NOT switches. They are Int32 parameters that REPLACE that component of
 *    the base date and leave the rest alone:
 *      Get-Date -Date '2026-03-04T05:06:07' -Year 2000  ->  2000-03-04T05:06:07
 *    Treating them as "show only this component" — which is what the name
 *    suggests — would be wrong in both the value and the type.
 *
 * 2. `-Format` and `-UFormat` are in DIFFERENT parameter sets, so passing both
 *    is `AmbiguousParameterSet,Microsoft.PowerShell.Commands.GetDateCommand`,
 *    InvalidArgument, ParameterBindingException.
 *
 * 3. A ONE-CHARACTER `-Format` is a STANDARD specifier, never a custom one:
 *      -Format 'd'  ->  3/4/2026      (not the day of the month)
 *      -Format 'M'  ->  March 4       (not the month number)
 *      -Format 'H'  ->  throws        (H is not a standard specifier)
 *
 * 4. What goes into the PIPELINE is a `System.DateTime`, even with `-Format`,
 *    which sends a `System.String` instead. The long
 *    `Wednesday, March 4, 2026 5:06:07 AM` form everyone sees is neither: it is
 *    the `DateTime` ScriptProperty, rendered by the formatter.
 *
 * 5. `-DisplayHint` changes only that ScriptProperty. The emitted object is a
 *    DateTime in all three cases, and `-DisplayHint Date` still carries the
 *    time in `Hour`/`Minute`/`Second`.
 */

import { throwIfCancelled } from '../../pipeline/pipeline.ts';
import { errorRecord } from '../../pipeline/streams.ts';
import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import {
  INT,
  STRING,
  SWITCH,
  isBound,
  manifest,
  numberValue,
  parameter,
  rawValue,
  stringValue,
  switchValue,
} from '../powershell/support.ts';
import {
  DateFormatError,
  PSDateTime,
  formatDotNet,
  formatUnix,
  nowAsLocal,
} from './datetime.ts';
import type { DisplayHint } from './datetime.ts';
import type { NativeServices } from './services.ts';

const COMMAND = 'Microsoft.PowerShell.Commands.GetDateCommand';

const GET_DATE_MANIFEST = manifest({
  display: 'Get-Date',
  synopsis: 'Gets the current date and time.',
  notes:
    'The clock is injected, so the value is deterministic in tests and a fixed session offset ' +
    'stands in for a real timezone database — `%Z` and `zzz` report that offset, not IANA rules. ' +
    '-Format implements the standard specifiers (d D f F g G m M o O r R s t T u U y Y), ' +
    "PowerShell's four File* forms, and the custom language including its ' \" and \\ quoting; " +
    '-UFormat implements every specifier pwsh 7.6.5 recognises. Culture is pinned to en-US ' +
    'invariant names, as psobject.ts pins its collator. NOT implemented: -UnixTimeSeconds, ' +
    'and a trailing bare `%` in -UFormat, which throws IndexOutOfRangeException in pwsh 7.6.5 ' +
    '(an upstream bug) and emits the percent here.',
  parameters: [
    parameter('Date', 'System.DateTime', { position: 0, valueFromPipeline: true, aliases: ['LastWriteTime'] }),
    parameter('Year', INT),
    parameter('Month', INT),
    parameter('Day', INT),
    parameter('Hour', INT),
    parameter('Minute', INT),
    parameter('Second', INT),
    parameter('Millisecond', INT),
    parameter('DisplayHint', 'Microsoft.PowerShell.Commands.DisplayHintType'),
    parameter('UFormat', STRING),
    parameter('Format', STRING),
    parameter('AsUTC', SWITCH),
  ],
  outputTypeNames: ['System.String', 'System.DateTime'],
});

/** The base instant: `-Date` when given, otherwise the injected clock. */
function baseDate(bound: BindingResult, services: NativeServices): PSDateTime {
  const supplied = rawValue(bound.parameters, 'Date');
  const offsetMinutes = services.clock.offsetMinutes();
  if (supplied === undefined || supplied === null) {
    return nowAsLocal(services.clock.now(), offsetMinutes);
  }
  if (supplied instanceof PSDateTime) return supplied;
  if (supplied instanceof Date) {
    // A bare JS Date reaching here came from the binder's coercion, which reads
    // an ISO string. Its UTC fields are the civil ones, matching PSDateTime.
    return new PSDateTime(supplied.getTime(), { kind: 'Unspecified', offsetMinutes });
  }
  const parsed = Date.parse(String(supplied));
  if (Number.isNaN(parsed)) {
    throw new DateFormatError(`Cannot convert "${String(supplied)}" to a DateTime.`);
  }
  // Date.parse of a bare `2026-03-04T05:06:07` is UTC in every modern engine,
  // which is the civil reading PowerShell gives an unzoned literal.
  return new PSDateTime(parsed, { kind: 'Unspecified', offsetMinutes });
}

/** Apply the component overrides, each of which replaces exactly one field. */
function withComponents(value: PSDateTime, bound: BindingResult): PSDateTime {
  const p = bound.parameters;
  const pick = (name: string, fallback: number): number => numberValue(p, name) ?? fallback;
  return new PSDateTime(
    Date.UTC(
      pick('Year', value.getUTCFullYear()),
      pick('Month', value.getUTCMonth() + 1) - 1,
      pick('Day', value.getUTCDate()),
      pick('Hour', value.getUTCHours()),
      pick('Minute', value.getUTCMinutes()),
      pick('Second', value.getUTCSeconds()),
      pick('Millisecond', value.getUTCMilliseconds()),
    ),
    {
      kind: value.kind,
      offsetMinutes: value.offsetMinutes,
      // A component override discards sub-millisecond precision, matching pwsh:
      // the parameters bottom out at -Millisecond.
      subMillisecondTicks: anyComponentBound(bound) ? 0 : value.subMillisecondTicks,
    },
  );
}

function anyComponentBound(bound: BindingResult): boolean {
  return ['Year', 'Month', 'Day', 'Hour', 'Minute', 'Second', 'Millisecond'].some((name) =>
    isBound(bound.parameters, name),
  );
}

function displayHintOf(bound: BindingResult): DisplayHint {
  const raw = stringValue(bound.parameters, 'DisplayHint');
  if (raw === undefined) return 'DateTime';
  const lower = raw.toLowerCase();
  if (lower === 'date') return 'Date';
  if (lower === 'time') return 'Time';
  return 'DateTime';
}

export function createGetDate(services: NativeServices): CommandModule {
  return {
    manifest: GET_DATE_MANIFEST,

    async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
      throwIfCancelled(context.signal, 'Get-Date');

      const format = stringValue(bound.parameters, 'Format');
      const uformat = stringValue(bound.parameters, 'UFormat');
      if (format !== undefined && uformat !== undefined) {
        await context.streams.error.write(
          errorRecord(
            'Parameter set cannot be resolved using the specified named parameters. One or more ' +
              'parameters issued cannot be used together or an insufficient number of parameters ' +
              'were provided.',
            'AmbiguousParameterSet',
            COMMAND,
            'InvalidArgument',
            { exceptionType: 'System.Management.Automation.ParameterBindingException' },
          ),
        );
        return 1;
      }

      try {
        let value = withComponents(baseDate(bound, services), bound);
        if (switchValue(bound.parameters, 'AsUTC')) {
          // Measured: -AsUTC makes Kind Utc. It CONVERTS the value, so a Local
          // 05:06 at +08:00 becomes 21:06 the previous day.
          const shift = value.kind === 'Utc' ? 0 : value.offsetMinutes;
          value = new PSDateTime(value.getTime() - shift * 60_000, {
            kind: 'Utc',
            offsetMinutes: value.offsetMinutes,
            subMillisecondTicks: value.subMillisecondTicks,
          });
        }

        value = new PSDateTime(value.getTime(), {
          kind: value.kind,
          offsetMinutes: value.offsetMinutes,
          subMillisecondTicks: value.subMillisecondTicks,
          displayHint: displayHintOf(bound),
        });

        if (format !== undefined) {
          await context.streams.success.write(formatDotNet(value, format));
          return 0;
        }
        if (uformat !== undefined) {
          await context.streams.success.write(formatUnix(value, uformat));
          return 0;
        }
        await context.streams.success.write(value);
        return 0;
      } catch (error) {
        if (!(error instanceof DateFormatError)) throw error;
        await context.streams.error.write(
          errorRecord(error.message, 'CannotConvertArgument', COMMAND, 'InvalidArgument', {
            exceptionType: 'System.FormatException',
          }),
        );
        return 1;
      }
    },
  };
}
