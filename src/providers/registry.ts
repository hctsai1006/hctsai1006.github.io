/**
 * registry.ts — which drive belongs to which provider, and the ONE dispatch.
 *
 * ---------------------------------------------------------------------------
 * ONE PATH RESOLVER, WHICH IS PR-10's ACCEPTANCE CRITERION VERBATIM
 * ---------------------------------------------------------------------------
 *
 * There is no `resolve` in this file. `resolvePath` in storage/vfs.ts stays the
 * single resolver, and this registry supplies the one thing it was always
 * missing — a drive table with more than mounts in it. The seam is
 * `ForeignDrives`, which `VirtualFileSystem` consults for any drive it has no
 * backend for; the registry implements it. So `Get-ChildItem Env:/` and
 * `Get-ChildItem /etc` go through the same `resolvePath` call with the same
 * `..` rules, and there is nowhere for a second interpretation to live.
 *
 * The alternative — a resolver here with its own drive table — was rejected for
 * a specific reason rather than on principle: the session's LOCATION is a
 * resolved path, `Set-Location Env:` has to move it, and `Kernel.cwd` reads it
 * back off the filesystem view. Two resolvers means two locations, and the one
 * the prompt shows would stop being the one relative paths resolve against.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT MODELLED, AND WHY IT IS STILL A PURE ADDITION LATER
 * ---------------------------------------------------------------------------
 *
 * PowerShell has a FIFTH capability layer the roadmap's four words (drive,
 * item, child-item, content) do not name: `IPropertyCmdletProvider`, which is
 * how `Get-ItemProperty` works. MEASURED on Windows, where the only provider
 * that needs it lives:
 *
 *   Get-ChildItem HKCU:\Environment               ->  0 children
 *   (Get-Item HKCU:\Environment).GetValueNames()  ->  TEMP | TMP | ...
 *
 * — registry VALUES are item properties, not child items. None of the five
 * providers here has anything to put in that layer, and an interface with zero
 * implementations is the "declared but not implemented" dishonesty this
 * repository tracks, so it is not written. It is a PURE ADDITION when
 * `Process:` or `Package:` want it: `ProviderItem` carries a `value` that is
 * already an arbitrary `PSObject`, the layer would be a new interface plus a
 * new type guard beside the three below, and nothing in this file or in
 * `ProviderItem` has to change shape.
 *
 * The refusal shape is modelled, though, because a capability model that cannot
 * express "I do not implement that" is not a capability model. MEASURED:
 *
 *   Get-Content HKCU:\Software
 *     -> NotSupported,...GetContentCommand, PSNotSupportedException,
 *        NotImplemented,
 *        "Cannot use interface. The IContentCmdletProvider interface is not
 *         implemented by this provider."
 *   Get-ChildItem Env: -Filter 'zz*'
 *     -> NotSupported,...GetChildItemCommand, PSNotSupportedException,
 *        NotImplemented,
 *        "Cannot call method. The provider does not support the use of filters."
 *
 * Both are `NotSupported` NAMING what is missing, never `PathNotFound`.
 *
 * NOTHING SHIPPED HERE CAN REACH THE FIRST ARM, and that is said plainly rather
 * than implied: all five providers implement both container and content, so
 * `#notSupported` is unreachable until a provider arrives that does not. It is
 * written anyway because a capability model that cannot express "I do not
 * implement that" is not a capability model, and because the ERROR RECORD it
 * produces is asserted against the measured Registry-provider shape in
 * `providers.test.mts` — so the arm is dead, not unverified.
 */

import { FILESYSTEM_DRIVE, err, ok } from '../storage/index.ts';
import type {
  ForeignDrives,
  ResolvedPath,
  Result,
  VirtualFileSystem,
} from '../storage/index.ts';
import type { PSValue } from '../pipeline/psobject.ts';
import type { FileSystemPort } from '../commands/ports.ts';
import { FileSystemProvider } from './filesystem.ts';
import {
  MapSessionStateStore,
  aliasProvider,
  environmentProvider,
  functionProvider,
  variableProvider,
} from './session-state.ts';
import type { SessionStateStore } from './session-state.ts';
import {
  isContainerProvider,
  isContentProvider,
  isNavigationProvider,
} from './types.ts';
import type {
  PSDriveInfo,
  PSProvider,
  ProviderCapability,
  ProviderInfo,
  ProviderItem,
} from './types.ts';

/**
 * The provider-internal path, which is what a MESSAGE names — sometimes.
 *
 * MEASURED, and the three commands disagree, so a single shared answer would be
 * wrong for two of them:
 *
 *   Get-ChildItem Env:zzNoSuch    "Cannot find path 'zzNoSuch' ..."
 *                                 the provider-internal path, NO drive
 *   Get-Item      Env:zzNoSuch    "Cannot find path 'Env:\zzNoSuch' ..."
 *                                 drive-qualified
 *   Set-Location  Env:zzLeaf      "Cannot find path 'Env:zzLeaf' ..."
 *                                 exactly what was TYPED
 *
 * `storageErrorRecord` already takes `displayPath` from the caller for this
 * reason. This helper is the first of the three.
 */
export function providerRelativePath(path: ResolvedPath): string {
  return path.path.replace(/^\//, '');
}

export interface ProviderRegistryOptions {
  /** The filesystem, already brokered. Every filesystem call keeps its gate. */
  readonly fs: FileSystemPort | null;
  /** Backs `Env:`. */
  readonly environment: SessionStateStore;
  /** Backs `Variable:`. Empty until this engine has variables. */
  readonly variables?: SessionStateStore;
  /** Backs `Function:`. Empty until this engine has functions. */
  readonly functions?: SessionStateStore;
  /** Backs `Alias:`. The command registry's alias table. */
  readonly aliases?: SessionStateStore;
}

/**
 * Drive name -> provider, plus the dispatch every rewired command shares.
 *
 * Implements `ForeignDrives` so `VirtualFileSystem` can answer `Env:` without
 * knowing what a provider is: the storage layer declares the seam, this layer
 * fills it, and the dependency points the way the layering does.
 */
export class ProviderRegistry implements ForeignDrives {
  /** lower-cased drive name -> the drive. PowerShell drive names are case-insensitive. */
  readonly #drives = new Map<string, PSDriveInfo>();
  readonly #providers = new Map<string, PSProvider>();

  constructor(options: ProviderRegistryOptions) {
    const providers: PSProvider[] = [
      environmentProvider(options.environment),
      variableProvider(options.variables ?? new MapSessionStateStore()),
      functionProvider(options.functions ?? new MapSessionStateStore()),
      aliasProvider(options.aliases ?? new MapSessionStateStore()),
    ];
    // A host with no storage still has the other four drives, which is what
    // `Get-ChildItem Env:` needs and what the "there is no filesystem" branch
    // in every command already handles for the fifth.
    if (options.fs !== null) providers.unshift(new FileSystemProvider(options.fs));

    for (const provider of providers) {
      for (const drive of provider.defaultDrives()) {
        this.#drives.set(drive.name.toLowerCase(), drive);
        this.#providers.set(drive.name.toLowerCase(), provider);
      }
    }
  }

  // -- ForeignDrives --------------------------------------------------------

  /** `'env'` -> `'Env'`. The canonical spelling, or null. */
  resolveDriveName(name: string): string | null {
    return this.#drives.get(name.toLowerCase())?.name ?? null;
  }

  /**
   * `Set-Location`'s whole question, and the measured oddity it reproduces.
   *
   *   pwsh: Set-Location Env:        ->  ok, location becomes Env:/
   *   pwsh: Set-Location Env:\PATH   ->  PathNotFound, "Cannot find path
   *                                      'Env:\PATH' because it does not exist."
   *
   * The item EXISTS. `Set-Location` asks "is this a container?", a
   * non-navigation provider answers "only my root is", and pwsh reports the
   * negative as a missing path. ENOTDIR is returned rather than ENOENT because
   * that is the true condition AND because `set-location.ts` already prints the
   * raw argument for ENOTDIR — which is exactly the path form measured here.
   */
  async canEnter(target: ResolvedPath): Promise<Result<void>> {
    const provider = this.providerFor(target.drive);
    if (provider === null) {
      return err({
        code: 'EINVAL',
        path: target.full,
        syscall: 'stat',
        message: `there is no drive named '${target.drive}'`,
        reason: 'unknown-drive',
      });
    }
    if (await this.isContainer(target)) return ok(undefined);
    if (await provider.itemExists(target)) {
      return err({
        code: 'ENOTDIR',
        path: target.full,
        syscall: 'stat',
        message: 'not a container',
        component: providerRelativePath(target),
      });
    }
    return err({
      code: 'ENOENT',
      path: target.full,
      syscall: 'stat',
      message: `there is no item at '${target.full}'`,
    });
  }

  // -- lookup ---------------------------------------------------------------

  get drives(): readonly PSDriveInfo[] {
    return [...this.#drives.values()];
  }

  driveFor(name: string): PSDriveInfo | null {
    return this.#drives.get(name.toLowerCase()) ?? null;
  }

  providerFor(drive: string): PSProvider | null {
    return this.#providers.get(drive.toLowerCase()) ?? null;
  }

  infoFor(drive: string): ProviderInfo | null {
    return this.providerFor(drive)?.info ?? null;
  }

  /** True for the drive the ordinary filesystem commands already handle. */
  isFileSystem(drive: string): boolean {
    return drive === FILESYSTEM_DRIVE;
  }

  /**
   * Does this registry own the drive, and is it NOT the filesystem?
   *
   * The question every rewired command actually asks, and it is NOT
   * `!isFileSystem(...)`. That was the first version and it had a defect an
   * adversarial pass found: `MountTable` can mount a SECOND `StorageBackend` at
   * a made-up drive — `storage-path.test.mts` does exactly that — and the
   * registry knows nothing about it. Asking "is it the filesystem drive" sent
   * `Scratch:/note.txt` down the provider branch, where the registry has no
   * provider for it, and turned a working mount into `DriveNotFound`. Asking
   * "do I own it" sends the unknown drive back to the filesystem path, where
   * the mount table answers.
   */
  handles(drive: string): boolean {
    return drive !== FILESYSTEM_DRIVE && this.providerFor(drive) !== null;
  }

  supports(drive: string, capability: ProviderCapability): boolean {
    return this.infoFor(drive)?.capabilities.includes(capability) ?? false;
  }

  // -- dispatch -------------------------------------------------------------

  /**
   * Is this path something `Set-Location` can stand in?
   *
   * ONE rule, in one place, and it is where the container/navigation
   * distinction actually bites: a navigation provider answers for itself; a
   * merely-container provider has exactly one container, its drive root. That
   * second clause is what makes `Set-Location Env:` work and
   * `Set-Location Env:\PATH` fail, and writing it per provider is how the four
   * flat drives would have ended up disagreeing.
   */
  async isContainer(target: ResolvedPath): Promise<boolean> {
    const provider = this.providerFor(target.drive);
    if (provider === null) return false;
    if (isNavigationProvider(provider)) return provider.isContainer(target);
    return target.path === '/';
  }

  async itemExists(target: ResolvedPath): Promise<boolean> {
    const provider = this.providerFor(target.drive);
    if (provider === null) return false;
    return provider.itemExists(target);
  }

  async item(target: ResolvedPath): Promise<Result<ProviderItem>> {
    const provider = this.providerFor(target.drive);
    if (provider === null) return this.#noDrive(target);
    return provider.getItem(target);
  }

  async childItems(target: ResolvedPath): Promise<Result<readonly ProviderItem[]>> {
    const provider = this.providerFor(target.drive);
    if (provider === null) return this.#noDrive(target);
    if (!isContainerProvider(provider)) return this.#notSupported(target, 'ContainerCmdletProvider');
    return provider.getChildItems(target);
  }

  async content(target: ResolvedPath): Promise<Result<readonly PSValue[]>> {
    const provider = this.providerFor(target.drive);
    if (provider === null) return this.#noDrive(target);
    if (!isContentProvider(provider)) return this.#notSupported(target, 'IContentCmdletProvider');
    return provider.getContent(target);
  }

  // `containerFor` and `contentFor` were here — typed accessors returning the
  // narrowed provider — and nothing called them. Removed rather than left as a
  // convenience nobody needs: an exported method with no caller is a claim
  // about a use case that has not arrived, and `providerFor` plus the type
  // guards give the same answer at the one place that wants it.

  #noDrive(target: ResolvedPath) {
    return err({
      code: 'EINVAL' as const,
      path: target.full,
      syscall: 'resolve' as const,
      message: `there is no drive named '${target.drive}'`,
      reason: 'unknown-drive',
    });
  }

  /**
   * A capability the provider does not implement.
   *
   * `reason` is `PROVIDER_NOT_SUPPORTED + ':' + interfaceName`, and the command
   * layer turns that into the measured record — `NotSupported` /
   * `PSNotSupportedException` / `NotImplemented`, "Cannot use interface. The
   * <name> interface is not implemented by this provider." — rather than the
   * InvalidArgument shape every other EINVAL gets.
   *
   * The name rides in `reason` because `StorageError` has no field for it and
   * because `reason` is already documented as this layer's own free-form
   * vocabulary ("unknown drive", "copy into itself"). A new `StorageErrorCode`
   * would have been the alternative and it is worse: it widens an exhaustive
   * switch in eight commands to carry an arm only the provider layer can raise.
   */
  #notSupported(target: ResolvedPath, interfaceName: string) {
    return err({
      code: 'EINVAL' as const,
      path: target.full,
      syscall: 'resolve' as const,
      message: `the ${interfaceName} interface is not implemented by this provider`,
      reason: `${PROVIDER_NOT_SUPPORTED}:${interfaceName}`,
    });
  }
}

/**
 * The `StorageError.reason` PREFIX that means "capability refused", not "bad
 * argument". The interface name follows a colon.
 */
export const PROVIDER_NOT_SUPPORTED = 'provider-capability-not-implemented';

/**
 * Build the registry and hand it to the filesystem view that has to resolve
 * through it.
 *
 * The attachment is a separate call rather than a constructor argument because
 * the cycle is real: the registry needs the brokered port, the port wraps the
 * view, and the view needs the registry. One of the three edges has to be late,
 * and this is the one whose lateness is checkable — a view with no drives
 * attached simply reports `Env:` as an unknown drive, which is what a host
 * without providers should do anyway.
 */
export function installProviders(
  view: VirtualFileSystem,
  options: ProviderRegistryOptions,
): ProviderRegistry {
  const registry = new ProviderRegistry(options);
  view.attachForeignDrives(registry);
  return registry;
}
