/**
 * index.ts — the seven commands that were blocked on `ports.ts`.
 *
 * `registry.ts` composes this with the other subsystems; nothing here edits a
 * shared registry, for the same reason `native/index.ts` says so: these were
 * built in parallel with everything else, and a module that pushed into a
 * shared mutable list could not have been.
 *
 * WHY SEVEN AND NOT SIX. The brief called them "Remove-Item (rm, del, erase,
 * rd, ri, rmdir) and reset-filesystem", which is how real pwsh 7.6.5 has it —
 * measured, `Get-Alias -Definition Remove-Item` lists rm among the six. The
 * generated manifests do NOT: `rm` is its own entry, `Application`, with
 * `parameterSource: 'none'`, because v1 models a Linux box where the PowerShell
 * aliases for native tools are gone. So `rm` is a seventh COMMAND rather than a
 * sixth alias, it answers to GNU coreutils instead of to pwsh, and the two were
 * measured separately. See the header of `rm.ts`.
 *
 * The grouping is by what they NEED, which is why they were blocked together:
 *
 *   Remove-Item, rm    filesystem.delete, gated per call by the broker
 *   Reset-FileSystem   the same, plus a question it must be able to ask
 *   nano, vi, vim      filesystem.read + write + a person, through DialogPort
 *   Set-Theme          preferences.write, and no filesystem at all
 */

import type { CommandModule } from '../invocation.ts';

import { nano, vi, vim } from './editors.ts';
import { removeItem } from './remove-item.ts';
import { resetFileSystem } from './reset-filesystem.ts';
import { rm } from './rm.ts';
import { setTheme } from './set-theme.ts';

export { nano, vi, vim } from './editors.ts';
export { removeItem } from './remove-item.ts';
export { resetFileSystem } from './reset-filesystem.ts';
export { rm } from './rm.ts';
export { THEMES, THEME_ALIASES, THEME_PREFERENCE_KEY, resolveTheme, setTheme } from './set-theme.ts';
export {
  argumentsOf,
  declares,
  firstArgument,
  fsManageManifest,
  removeTree,
  strerror,
} from './support.ts';
export type { Removal } from './support.ts';

/** Everything this directory implements. */
export const FS_MANAGE_COMMANDS: readonly CommandModule[] = [
  removeItem,
  rm,
  resetFileSystem,
  nano,
  vi,
  vim,
  setTheme,
];
