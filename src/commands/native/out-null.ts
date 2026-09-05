/**
 * Out-Null — the command that must do nothing, correctly.
 *
 * Measured in pwsh 7.6.5:
 *   @(1,2,3 | Out-Null).Count        ->  0
 *   @(Out-Null -InputObject 5).Count ->  0
 *   1 | Out-Null; $?                 ->  True
 *   Write-Error x 2>$null | Out-Null ->  the ErrorVariable still catches it
 *
 * The last line is the one that matters: Out-Null discards stream 1 and NOTHING
 * else. An implementation that swallowed the whole invocation — v1's did, by
 * returning null from its `pipe` hook — would also swallow errors, warnings and
 * verbose output, which is a different command.
 *
 * It still has to DRAIN. A stage that returns without reading its input leaves
 * the upstream parked on a write that will never be acknowledged, so
 * `1..10 | Out-Null` would hang rather than complete. Draining is the work.
 */

import { throwIfCancelled } from '../../pipeline/pipeline.ts';
import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import { OBJECT, manifest, parameter } from '../powershell/support.ts';

const OUT_NULL_MANIFEST = manifest({
  display: 'Out-Null',
  synopsis: 'Hides the output instead of sending it down the pipeline or displaying it.',
  notes:
    'Discards the success stream only. Errors, warnings, verbose, debug and information all ' +
    'pass through untouched, which is measured: an ErrorVariable still fills in behind an ' +
    'Out-Null. The input is fully drained rather than abandoned, or the upstream stage would ' +
    'park forever on an unacknowledged write.',
  parameters: [parameter('InputObject', OBJECT, { valueFromPipeline: true })],
  outputTypeNames: [],
});

export const outNull: CommandModule = {
  manifest: OUT_NULL_MANIFEST,

  async invoke(context: InvocationContext, _bound: BindingResult): Promise<number> {
    for await (const item of context.input) {
      // Read and dropped. `void` rather than an unused binding so the discard is
      // deliberate and visible instead of something a linter has to forgive.
      void item;
      throwIfCancelled(context.signal, 'Out-Null');
    }
    return 0;
  },
};
