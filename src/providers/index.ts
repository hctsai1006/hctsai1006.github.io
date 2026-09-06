/**
 * index.ts — the provider layer's public surface.
 *
 * A command imports from here and from nowhere else under `src/providers/`,
 * which is the rule `storage/index.ts` already sets for its own directory. The
 * point is the same: the five providers can be re-shaped, and the four
 * remaining ones (Portfolio, Process, Package, Browser — PR-10 task 3) can be
 * added, without a command changing.
 *
 * WHAT TASK 3 WILL HAVE TO DO, so that the claim "it is a pure addition" is
 * checkable rather than hopeful:
 *
 *   1. write a provider — for a flat one, a `SessionStateDescriptor` and a
 *      store, and nothing else; for a hierarchical one (Portfolio:), a class
 *      implementing `NavigationProvider`;
 *   2. add it to `ProviderRegistry`'s constructor list;
 *   3. nothing in `resolvePath`, `VirtualFileSystem`, `ForeignDrives` or any
 *      rewired command.
 *
 * `Set-Location Portfolio:/` — the second half of PR-10's acceptance criterion
 * — needs step 1 to implement `isContainer`, and then works through the same
 * `canEnter` this file's registry already provides. `Process:` and `Package:`
 * are the two likely to want the property layer `registry.ts` explains is
 * deliberately absent.
 */

export type {
  ContainerProvider,
  ContentProvider,
  DriveProvider,
  ItemProvider,
  NavigationProvider,
  PSDriveInfo,
  PSProvider,
  ProviderCapability,
  ProviderInfo,
  ProviderItem,
} from './types.ts';

export {
  isContainerProvider,
  isContentProvider,
  isNavigationProvider,
} from './types.ts';

export {
  ALIAS_DESCRIPTOR,
  ENVIRONMENT_DESCRIPTOR,
  FUNCTION_DESCRIPTOR,
  MapSessionStateStore,
  SessionStateProvider,
  VARIABLE_DESCRIPTOR,
  aliasProvider,
  environmentProvider,
  functionProvider,
  variableProvider,
} from './session-state.ts';
export type { SessionStateDescriptor, SessionStateStore } from './session-state.ts';

export {
  DIRECTORY_INFO_TYPE_NAMES,
  FILESYSTEM_DRIVE_INFO,
  FILESYSTEM_PROVIDER,
  FILESYSTEM_PROVIDER_INFO,
  FILE_INFO_TYPE_NAMES,
  FileSystemProvider,
  baseNameOf,
  compareItemNames,
  extensionOf,
  fileSystemInfo,
  isHidden,
  modeString,
  orderChildItems,
} from './filesystem.ts';

export {
  PROVIDER_NOT_SUPPORTED,
  ProviderRegistry,
  installProviders,
  providerRelativePath,
} from './registry.ts';
export type { ProviderRegistryOptions } from './registry.ts';
