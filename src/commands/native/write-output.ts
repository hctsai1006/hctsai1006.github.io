/**
 * Write-Output — and why `Write-Output a b c` binds three arguments at all.
 *
 * `-InputObject` is declared `System.Management.Automation.PSObject`, a SCALAR
 * type, and yet three bare arguments bind to it. The reason is in the parameter
 * attribute, which the probe read directly:
 *
 *   (Get-Command Write-Output).Parameters['InputObject'].Attributes
 *     set=__AllParameterSets pos=0 pipe=True remaining=True
 *
 * `ValueFromRemainingArguments` is what collects them, and the binder in this
 * project already models it — which is exactly the argument for having a binder
 * at all rather than letting each command parse its own tokens.
 *
 * `-InputObject` is also MANDATORY: `Write-Output` with nothing at all is
 * `MissingMandatoryParameter,Microsoft.PowerShell.Commands.WriteOutputCommand`.
 *
 * WHAT -NoEnumerate ACTUALLY DOES, WHICH IS LESS THAN THE NAME SUGGESTS
 *
 *   Write-Output @(1,2,3)               ->  3 objects
 *   Write-Output @(1,2,3) -NoEnumerate  ->  1 object,  System.Object[]
 *   1,2,3 | Write-Output -NoEnumerate   ->  3 objects   <-- NOT one
 *
 * The last line is the surprise. `-NoEnumerate` suppresses the unrolling of the
 * InputObject VALUE; pipeline binding has already delivered three separate
 * objects by the time the command runs, so there is nothing left to not-unroll.
 * A reading of the name that expects one array out of a three-item pipeline is
 * wrong, and this is measured.
 *
 * ONE MEASURED DIVERGENCE, DECLARED
 *
 *   pwsh: (Write-Output 5 -NoEnumerate).GetType()  ->  List`1[System.Object]
 *   pwsh: (Write-Output -InputObject 5 -NoEnumerate).GetType()  ->  System.Int32
 *
 * A single REMAINING argument still arrives as a one-element collection in
 * pwsh, so `-NoEnumerate` emits a List rather than the bare value. This
 * project's binder collapses a single collected argument to a scalar
 * (binder.ts, `collect`), so the same line yields Int32 here. That is the
 * binder's rule, not this command's, and the binder is shared — so it is
 * recorded here rather than patched around locally.
 */

import { enumerate } from '../../pipeline/psobject.ts';
import type { PSValue } from '../../pipeline/psobject.ts';
import { throwIfCancelled } from '../../pipeline/pipeline.ts';
import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import { SWITCH, manifest, parameter, rawValue, switchValue } from '../powershell/support.ts';

const WRITE_OUTPUT_MANIFEST = manifest({
  display: 'Write-Output',
  aliases: ['echo', 'write'],
  synopsis: 'Sends the specified objects to the next command in the pipeline.',
  notes:
    '-NoEnumerate suppresses unrolling of the -InputObject value only; pipeline input has ' +
    'already been unrolled by the time the command runs, which is measured and is not what the ' +
    'name suggests. One divergence: pwsh emits a List`1[System.Object] for ' +
    '`Write-Output 5 -NoEnumerate` because a single ValueFromRemainingArguments argument still ' +
    'arrives as a collection, while this binder collapses it to a scalar and so emits Int32.',
  parameters: [
    parameter('InputObject', 'System.Management.Automation.PSObject', {
      position: 0,
      mandatory: true,
      valueFromPipeline: true,
    }),
    parameter('NoEnumerate', SWITCH),
  ],
  outputTypeNames: ['System.Management.Automation.PSObject'],
});

/** The parameters the binder must be told collect trailing arguments. */
export const WRITE_OUTPUT_REMAINING_ARGUMENTS: readonly string[] = ['InputObject'];

export const writeOutput: CommandModule = {
  manifest: WRITE_OUTPUT_MANIFEST,

  async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
    const noEnumerate = switchValue(bound.parameters, 'NoEnumerate');
    const sink = context.streams.success;

    const supplied = rawValue(bound.parameters, 'InputObject');
    if (supplied !== undefined) {
      if (noEnumerate) {
        await sink.write(supplied);
      } else {
        for (const value of enumerate(supplied)) {
          if (sink.closed) break;
          await sink.write(value);
        }
      }
    }

    // Pipeline input passes through unchanged, INCLUDING nulls: `@($null,1) |
    // Write-Output` sends two objects. Select-Object drops nulls; the pipeline
    // and this command do not, and conflating the two is how the enumerator
    // gets broken.
    for await (const item of context.input) {
      throwIfCancelled(context.signal, 'Write-Output');
      if (sink.closed) break;
      await sink.write(item as PSValue);
    }
    return 0;
  },
};
