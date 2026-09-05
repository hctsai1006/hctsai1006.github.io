/**
 * Get-History — session history as objects.
 *
 * v1 printed `padw(String(i+1),4) + ' ' + line`. pwsh emits
 * `Microsoft.PowerShell.Commands.HistoryInfo`, and the difference is not
 * cosmetic: `Get-History | Where-Object Duration -gt 1` is a sentence in one
 * model and impossible in the other.
 *
 * Measured in pwsh 7.6.5 (with two entries added through Add-History):
 *
 *   typeNames                        HistoryInfo | System.Object
 *   properties, in order             Id, CommandLine, ExecutionStatus,
 *                                    StartExecutionTime, EndExecutionTime, Duration
 *   Id type                          System.Int64      (and -Id is Int64[])
 *   ExecutionStatus                  a PipelineState name, e.g. Completed
 *   Duration                         a TimeSpan, derived from the two times
 *   .ToString()                      the CommandLine
 *   default table                    Id | Duration | CommandLine
 *
 * TWO THINGS THE PROBE CORRECTED
 *
 * 1. `-Count 1` returns the LAST entry, not the first. `Get-History -Count 1`
 *    over [Get-Date, Get-Location] yields Get-Location. It is "the N most
 *    recent", and the obvious reading is backwards.
 *
 * 2. `-Id` with no such entry is a TERMINATING-looking error, not silence:
 *      GetHistoryNoHistoryForId,Microsoft.PowerShell.Commands.GetHistoryCommand
 *      ObjectNotFound / System.ArgumentException
 *      "Cannot locate the history for Id 99."
 *    `-Count` carries ValidateRange(0, ...), so -1 is a binding error while 0 is
 *    legal and returns nothing.
 */

import { psObject } from '../../pipeline/psobject.ts';
import type { PSObject, PSValue } from '../../pipeline/psobject.ts';
import { throwIfCancelled } from '../../pipeline/pipeline.ts';
import { errorRecord } from '../../pipeline/streams.ts';
import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import { INT, manifest, numberValue, parameter, rawValue } from '../powershell/support.ts';
import { PSDateTime, psTimeSpan } from './datetime.ts';
import type { HistoryEntry, NativeServices } from './services.ts';

const COMMAND = 'Microsoft.PowerShell.Commands.GetHistoryCommand';

export const HISTORY_INFO_TYPE_NAMES: readonly string[] = [
  'Microsoft.PowerShell.Commands.HistoryInfo',
  'System.Object',
];

const GET_HISTORY_MANIFEST = manifest({
  display: 'Get-History',
  aliases: ['h', 'history', 'ghy'],
  synopsis: 'Gets a list of the commands entered during the current session.',
  notes:
    'Emits HistoryInfo objects with the property set and order pwsh reports, so the history is ' +
    'filterable and sortable rather than a block of text. Ids are numbers here, not Int64: this ' +
    'engine has no 64-bit integer in the pipeline unless a value is a bigint, and a session ' +
    'cannot reach 2^53 commands. -Count returns the MOST RECENT n, which is measured and is the ' +
    'opposite of the obvious reading.',
  parameters: [
    parameter('Id', 'System.Int64[]', { position: 0, valueFromPipeline: true }),
    parameter('Count', INT, { position: 1, validation: ['ValidateRangeAttribute'] }),
  ],
  outputTypeNames: ['Microsoft.PowerShell.Commands.HistoryInfo'],
});

/**
 * One HistoryInfo. `Duration` is DERIVED from the two timestamps rather than
 * stored alongside them — two numbers that must agree are where drift starts,
 * which is the same rule profile.json's counts live under.
 */
export function historyInfo(entry: HistoryEntry, offsetMinutes: number): PSObject {
  const local = (epochMs: number): PSDateTime =>
    new PSDateTime(epochMs + offsetMinutes * 60_000, { kind: 'Local', offsetMinutes });
  return psObject(
    {
      Id: entry.id,
      CommandLine: entry.commandLine,
      ExecutionStatus: entry.executionStatus,
      StartExecutionTime: local(entry.startedAt),
      EndExecutionTime: local(entry.endedAt),
      Duration: psTimeSpan(entry.endedAt - entry.startedAt),
    },
    HISTORY_INFO_TYPE_NAMES,
  );
}

function requestedIds(bound: BindingResult): readonly number[] | undefined {
  const raw = rawValue(bound.parameters, 'Id');
  if (raw === undefined || raw === null) return undefined;
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((value) => Number(value as PSValue));
}

export function createGetHistory(services: NativeServices): CommandModule {
  return {
    manifest: GET_HISTORY_MANIFEST,

    async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
      throwIfCancelled(context.signal, 'Get-History');
      const offset = services.clock.offsetMinutes();
      const entries = services.history.entries();

      const ids = requestedIds(bound);
      if (ids !== undefined) {
        let failed = false;
        for (const id of ids) {
          const found = entries.find((entry) => entry.id === id);
          if (found === undefined) {
            failed = true;
            await context.streams.error.write(
              errorRecord(
                `Cannot locate the history for Id ${String(id)}.`,
                'GetHistoryNoHistoryForId',
                COMMAND,
                'ObjectNotFound',
                { exceptionType: 'System.ArgumentException', targetObject: id },
              ),
            );
            continue;
          }
          await context.streams.success.write(historyInfo(found, offset));
        }
        return failed ? 1 : 0;
      }

      const count = numberValue(bound.parameters, 'Count');
      // The MOST RECENT n, in oldest-first order — measured.
      const selected = count === undefined ? entries : entries.slice(Math.max(0, entries.length - count));
      for (const entry of selected) {
        if (context.streams.success.closed) break;
        await context.streams.success.write(historyInfo(entry, offset));
      }
      return 0;
    },
  };
}
