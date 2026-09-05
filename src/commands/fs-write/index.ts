/**
 * The twelve filesystem WRITE commands, as one registry.
 *
 * Twelve, not the ten a reader counts from the display names, because
 * `manifests.json` declares `cp` and `mv` as ENTRIES OF THEIR OWN rather than
 * as aliases of `Copy-Item` and `Move-Item`. That is not a quirk of the
 * generated file: PowerShell on Linux deliberately removes those aliases so the
 * real binaries run, v1 reproduces it, and the two behave differently — GNU
 * `mv` overwrites where `Move-Item` demands `-Force`, and GNU `cp` refuses a
 * directory where `Copy-Item` copies an empty one. Aliasing them would have
 * silently picked one answer for both.
 *
 * The aliases each command claims come from the generated manifests and are not
 * repeated here: `Copy-Item` carries `ci` and `copy`, `Move-Item` carries `mi`
 * and `move`, `New-Item` carries `md` and `ni`, `Rename-Item` carries `ren` and
 * `rni`, `Set-Content` carries `sc`, `Add-Content` carries `ac`, and the four
 * coreutils carry none.
 *
 * Composed here rather than pushed into a shared list, for the reason
 * `registry.ts` gives: nothing in this directory edits a file another branch is
 * also editing, and the collision check in the registry stays a real check
 * because no module can see what the others registered.
 */

import type { CommandModule } from '../invocation.ts';

import { newItem } from './new-item.ts';
import { addContent, setContent } from './set-content.ts';
import { copyItem, cp } from './copy-item.ts';
import { moveItem, mv, renameItem } from './move-item.ts';
import { chmod, chown, mkdir, touch } from './unix.ts';

export { newItem } from './new-item.ts';
export { addContent, setContent } from './set-content.ts';
export { copyItem, cp } from './copy-item.ts';
export { moveItem, mv, renameItem } from './move-item.ts';
export { applyMode, chmod, chown, mkdir, touch } from './unix.ts';
export {
  DIRECTORY_INFO_TYPE_NAMES,
  FILE_INFO_TYPE_NAMES,
  MESSAGES,
  contentBody,
  contentLines,
  fileSystemInfo,
  fsWriteManifest,
  storageShape,
} from './support.ts';
export type { PSErrorShape, ProviderErrorIds } from './support.ts';

/** Every command this directory implements. The coordinator composes it. */
export const FS_WRITE_COMMANDS: readonly CommandModule[] = [
  newItem,
  setContent,
  addContent,
  copyItem,
  cp,
  moveItem,
  mv,
  renameItem,
  mkdir,
  touch,
  chmod,
  chown,
];
