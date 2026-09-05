/**
 * The ten filesystem READ commands, as one registry.
 *
 * Composed here and NOT pushed into `src/commands/registry.ts`: the coordinator
 * joins the subsystem arrays, which is what let five of them be written in
 * parallel without touching the same file. `registry.ts`'s collision check is a
 * real check for exactly that reason — no module can see what the others
 * registered.
 *
 * TEN MODULES, NOT SEVEN. `ls`, `cat`, `grep`, `tree` and `which` are separate
 * entries in `manifests.json` with no aliases of their own, and they are not
 * spellings of the cmdlets next to them:
 *
 *   Get-ChildItem  dir gci     PowerShell semantics, PSObjects, collated order
 *   ls                         coreutils: -l -a -A -h -1, ordinal order
 *   Get-Content    gc type     an array of lines, -Raw, -Tail, -AsByteStream
 *   cat                        concatenates, and keeps going past a bad file
 *   Select-String  sls         case-INSENSITIVE by default, emits MatchInfo
 *   grep                       case-SENSITIVE by default, emits text
 *   Test-Path
 *   Set-Location   cd chdir sl
 *   tree
 *   which
 *
 * PowerShell on Linux and macOS deliberately leaves `ls`, `cat`, `cp`, `mv`,
 * `rm`, `man`, `mount` and `ps` undefined so the native executables run, which
 * is why the generated manifest has both and why aliasing one to the other would
 * change answers rather than save code — `grep foo` and `Select-String foo`
 * genuinely differ on case.
 *
 * EVERY MODULE HERE DECLARES `filesystem.read` AND NOTHING ELSE.
 * `fsReadManifest` refuses to hand back a manifest that says otherwise, so the
 * claim is checked at module load rather than asserted in a comment. The broker
 * enforces the other half: `tests/unit/ports.test.mts` proves a command holding
 * only `filesystem.read` is refused every write and every delete.
 */

import type { CommandModule } from '../invocation.ts';

import { cat } from './cat.ts';
import { getChildItem, GET_CHILDITEM_ERROR_IDS } from './get-childitem.ts';
import { getContent, GET_CONTENT_ERROR_IDS } from './get-content.ts';
import { grep } from './grep.ts';
import { ls } from './ls.ts';
import { selectString, SELECT_STRING_ERROR_IDS } from './select-string.ts';
import { setLocation, SET_LOCATION_ERROR_IDS } from './set-location.ts';
import { testPath } from './test-path.ts';
import { tree } from './tree.ts';
import { which } from './which.ts';
import {
  DEFAULT_ERROR_IDS,
  GET_CHILDITEM,
  GET_CONTENT,
  SELECT_STRING,
  SET_LOCATION,
  TEST_PATH,
} from './support.ts';
import type { CommandIdentity, FsErrorIds } from './support.ts';

export const FS_READ_COMMANDS: readonly CommandModule[] = [
  getChildItem,
  getContent,
  selectString,
  testPath,
  setLocation,
  ls,
  cat,
  grep,
  tree,
  which,
];

export { cat, getChildItem, getContent, grep, ls, selectString, setLocation, testPath, tree, which };

export {
  GET_CHILDITEM_ERROR_IDS,
  GET_CONTENT_ERROR_IDS,
  SELECT_STRING_ERROR_IDS,
  SET_LOCATION_ERROR_IDS,
};

/**
 * Which identity and which error-id table each cmdlet uses, by manifest name.
 *
 * Exported for the differential corpus. `tools/conformance.mts` needs to build
 * the ErrorRecord this directory would build for a given `StorageError` and
 * compare its `FullyQualifiedErrorId` against what pwsh 7.6.5 produced — and it
 * has to use the SAME table the command uses, or the probe would be restating
 * the rule instead of testing it, and a regression in one would leave the
 * corpus green.
 */
export const FS_READ_ERROR_MAPPINGS: Readonly<
  Record<string, { readonly identity: CommandIdentity; readonly ids: FsErrorIds }>
> = {
  'get-childitem': { identity: GET_CHILDITEM, ids: GET_CHILDITEM_ERROR_IDS },
  'get-content': { identity: GET_CONTENT, ids: GET_CONTENT_ERROR_IDS },
  'select-string': { identity: SELECT_STRING, ids: SELECT_STRING_ERROR_IDS },
  'set-location': { identity: SET_LOCATION, ids: SET_LOCATION_ERROR_IDS },
  'test-path': { identity: TEST_PATH, ids: DEFAULT_ERROR_IDS },
};

export {
  DIRECTORY_INFO_TYPE_NAMES,
  FILE_INFO_TYPE_NAMES,
  FILESYSTEM_PROVIDER,
  baseNameOf,
  compareNames,
  extensionOf,
  fileSystemInfo,
  fsReadManifest,
  globPath,
  isHidden,
  modeString,
  noFileSystemError,
  sortDirectoryEntries,
  splitLines,
  splitOnDelimiter,
  storageErrorRecord,
} from './support.ts';
export type { CommandIdentity, FsErrorIds, Target } from './support.ts';
export { GET_CHILDITEM, GET_CONTENT, SELECT_STRING, SET_LOCATION, TEST_PATH, DEFAULT_ERROR_IDS, nativeIdentity } from './support.ts';
export {
  INPUT_STREAM,
  MATCH_INFO_CONTEXT_TYPE_NAMES,
  MATCH_INFO_TYPE_NAMES,
} from './select-string.ts';
