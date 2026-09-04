/**
 * Clear-Host — the one command here that has a side effect outside the pipeline,
 * and therefore the one that has to ask permission.
 *
 * In pwsh 7.6.5 this is not a cmdlet at all:
 *   (Get-Command Clear-Host).CommandType  ->  Function
 *   (Get-Alias -Definition Clear-Host)    ->  clear, cls
 *   its Definition sets $Host.UI.RawUI.CursorPosition and calls SetBufferContents
 *
 * So clearing the screen is something the HOST does, not something the language
 * does — and that is exactly the split the capability broker models. This module
 * declares `terminal.control`, calls `requireCapability` before touching
 * anything, and reaches the terminal through the injected `TerminalControl`
 * rather than through a DOM it is not allowed to see.
 *
 * It emits nothing: `@(Clear-Host).Count` is 0.
 */

import { throwIfCancelled } from '../../pipeline/pipeline.ts';
import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import { manifest } from '../powershell/support.ts';
import type { NativeServices } from './services.ts';

const CLEAR_HOST_MANIFEST = manifest({
  display: 'Clear-Host',
  aliases: ['clear', 'cls'],
  synopsis: 'Clears the display in the host program.',
  notes:
    'Goes through the capability broker: `terminal.control` is requested before anything is ' +
    'cleared, so a session that did not grant it gets a CapabilityDeniedError rather than a ' +
    'blanked screen. In pwsh this is a Function over $Host.UI.RawUI, not a cmdlet, which is ' +
    'why clearing is the host\'s job here too rather than the command\'s.',
  capabilities: ['terminal.control'],
  parameters: [],
  outputTypeNames: [],
});

export function createClearHost(services: NativeServices): CommandModule {
  return {
    manifest: CLEAR_HOST_MANIFEST,

    invoke(context: InvocationContext, _bound: BindingResult): Promise<number> {
      throwIfCancelled(context.signal, 'Clear-Host');
      // Before the effect, never after. A command that cleared and then asked
      // would have already done the thing the broker exists to gate.
      context.requireCapability('terminal.control');
      services.terminal.clear();
      return Promise.resolve(0);
    },
  };
}
