/**
 * types.ts — what a PowerShell PROVIDER is, and why it is not a `StorageBackend`.
 *
 * ---------------------------------------------------------------------------
 * THE MISTAKE THIS FILE EXISTS TO AVOID
 * ---------------------------------------------------------------------------
 *
 * The roadmap's reason for PR-10 is that "Env, Variable, Function, Process and
 * Package are not files. Forcing them into /proc and /dev is less faithful than
 * modelling providers." The obvious next move — make every provider implement
 * `StorageBackend` — is the SAME mistake moved one level down. `StorageBackend`
 * has `chmod`, `utimes`, `quota`, `readBytes`, `copy` with a mutation journal
 * and a `NodeOrigin` seed marker. An environment variable has none of those.
 * Nine of its methods would have had to return a plausible lie or an invented
 * `EINVAL`, and the first caller to believe one would have the bug.
 *
 * So the shape here is PowerShell's own: CAPABILITY LAYERS, which a provider
 * implements as many of as it can honestly answer. The names are the ones
 * `System.Management.Automation.Provider` uses, because they are the names the
 * behaviour is documented under:
 *
 *   DriveProvider       DriveCmdletProvider       — which drives exist
 *   ItemProvider        ItemCmdletProvider        — get/set/clear one item
 *   ContainerProvider   ContainerCmdletProvider   — children, new, remove
 *   NavigationProvider  NavigationCmdletProvider  — a hierarchy, and moving in it
 *   ContentProvider     IContentCmdletProvider    — Get-Content / Set-Content
 *
 * A flat provider (`Env:`) implements the first three and content, and stops.
 * The filesystem implements all five. Nothing has to pretend.
 *
 * ---------------------------------------------------------------------------
 * WHY `StorageError` IS STILL THE ERROR TYPE
 * ---------------------------------------------------------------------------
 *
 * Every command in this repository already turns a `StorageError` into the
 * ErrorRecord pwsh produces for the same condition, and that mapping is
 * measured, tested, and per-command (`storageErrorRecord` in
 * `commands/fs-read/support.ts`). Inventing a second error union for providers
 * would mean a second mapping, and the two would disagree the first time one
 * was updated — this repository's most-repeated defect shape.
 *
 * It also lands on the right answers by itself. MEASURED, pwsh 7.6.5:
 *
 *   Get-Item Env:NoSuchVar_zz   PathNotFound,...GetItemCommand   ObjectNotFound
 *                               "Cannot find path 'Env:\NoSuchVar_zz' because
 *                                it does not exist."
 *
 * which is exactly what `ENOENT` already produces. The POSIX name is a label
 * for a condition, not a claim that a filesystem was involved.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE
 * ---------------------------------------------------------------------------
 *
 *   - No `New-PSDrive` / `Remove-PSDrive`. `defaultDrives()` is the whole drive
 *     story for now. The seam is the method, not a mutable registry that
 *     nothing can add to.
 *   - No dynamic parameters. `Get-ChildItem -Filter` on `Env:` is a REFUSAL in
 *     pwsh, not a dynamic parameter (measured below), and refusing needs only
 *     the capability list.
 *   - No `Invoke-Item`, no security descriptors, no transactions.
 */

import type { ResolvedPath, Result } from '../storage/index.ts';
import type { PSValue } from '../pipeline/psobject.ts';

/**
 * What `Get-PSProvider` reports under `Capabilities`.
 *
 * MEASURED, pwsh 7.6.5 on Windows:
 *
 *   Registry     ShouldProcess
 *   Alias        ShouldProcess
 *   Environment  ShouldProcess
 *   FileSystem   Filter, ShouldProcess, Credentials
 *   Function     ShouldProcess
 *   Variable     ShouldProcess
 *
 * Note what is NOT in that list: nothing says whether a provider is a container
 * or a navigation provider. That distinction is BEHAVIOURAL — you find it by
 * trying `Set-Location Env:\PATH` — which is why `NavigationProvider` below is
 * detected with a type guard rather than read off a flag.
 *
 * `Filter` is the one that is load-bearing today. MEASURED:
 *
 *   Get-ChildItem Env: -Filter 'zz*'
 *     -> "Cannot call method. The provider does not support the use of filters."
 *   Get-ChildItem C:\ -Filter 'W*'   -> accepted
 *
 * so the capability list is what a command consults before honouring -Filter.
 */
export type ProviderCapability = 'ShouldProcess' | 'Filter' | 'Credentials';

/** A provider's identity, in the shape `Get-PSProvider` prints. */
export interface ProviderInfo {
  /** `Environment`, `FileSystem`. */
  readonly name: string;
  /** `Microsoft.PowerShell.Core` for every provider pwsh ships. */
  readonly moduleName: string;
  /**
   * `Microsoft.PowerShell.Core\Environment` — the string that prefixes every
   * `PSPath`. MEASURED: `(Get-Item Env:PATH).PSPath` is
   * `Microsoft.PowerShell.Core\Environment::PATH`, and the drive ROOT's PSPath
   * is `Microsoft.PowerShell.Core\Environment::` with nothing after it.
   */
  readonly fullName: string;
  /**
   * MEASURED, `(Get-PSProvider <name>).ImplementingType.FullName`, all six:
   *
   *   Alias        Microsoft.PowerShell.Commands.AliasProvider
   *   Environment  Microsoft.PowerShell.Commands.EnvironmentProvider
   *   FileSystem   Microsoft.PowerShell.Commands.FileSystemProvider
   *   Function     Microsoft.PowerShell.Commands.FunctionProvider
   *   Registry     Microsoft.PowerShell.Commands.RegistryProvider
   *   Variable     Microsoft.PowerShell.Commands.VariableProvider
   *
   * A field rather than `Microsoft.PowerShell.Commands.${name}Provider` derived
   * at the use site: the rule happens to hold for all six, and a derivation
   * that happens to hold is how the seventh gets it wrong silently.
   */
  readonly implementingType: string;
  readonly capabilities: readonly ProviderCapability[];
  /**
   * MEASURED, and it is a PLATFORM fact rather than a provider fact. pwsh
   * 7.6.5, inside `Env:`:
   *
   *   Windows  (Get-Location).Provider.ItemSeparator  ->  \    Path  Env:\
   *   Linux    (Get-Location).Provider.ItemSeparator  ->  /    Path  Env:/
   *
   * The emulated machine is Ubuntu, so it is `/` here. See `formatResolved` in
   * storage/vfs.ts, whose comment used to claim backslashes "on every
   * platform"; the Linux container measurement is what corrected it.
   */
  readonly itemSeparator: string;
}

/**
 * A drive, as `Get-PSDrive` reports it.
 *
 * MEASURED: `Root` is the EMPTY STRING for Env, Variable, Function and Alias,
 * and `C:\` for the filesystem drive on Windows. An empty root is not a missing
 * value — it is what makes `Microsoft.PowerShell.Core\Environment::PATH` the
 * whole PSPath, with no drive segment in it.
 */
export interface PSDriveInfo {
  /** `Env`. Compared case-insensitively; PowerShell drive names are. */
  readonly name: string;
  readonly root: string;
  readonly provider: ProviderInfo;
}

/**
 * One addressable thing, whatever kind of thing the provider deals in.
 *
 * `value` is the object the pipeline sees, and it is genuinely different per
 * provider — MEASURED, `.GetType().FullName`:
 *
 *   Env:PATH         System.Collections.DictionaryEntry
 *   Variable:PID     System.Management.Automation.PSVariable
 *   Function:prompt  System.Management.Automation.FunctionInfo
 *   Alias:ls         System.Management.Automation.AliasInfo
 *   a file           System.IO.FileInfo
 *
 * so a `ProviderItem` cannot carry a `FileStat`; the four session-state
 * providers have nothing to put in one.
 */
export interface ProviderItem {
  /** The leaf name, in the case the provider stores it in. */
  readonly name: string;
  readonly path: ResolvedPath;
  /** MEASURED: False for Env:PATH, Variable:PID and Alias:ls. */
  readonly isContainer: boolean;
  readonly value: PSValue;
}

// ---------------------------------------------------------------------------
// the capability layers
// ---------------------------------------------------------------------------

/** Every provider is at least this: an identity and the drives it offers. */
export interface DriveProvider {
  readonly info: ProviderInfo;
  /**
   * The drives this provider mounts at startup.
   *
   * `New-PSDrive` would add to this later; nothing here is mutable yet, and a
   * method that returns a fixed list is an honest way to say so.
   */
  defaultDrives(): readonly PSDriveInfo[];
}

/** get / set / clear ONE item, and decide whether a path could name one. */
export interface ItemProvider extends DriveProvider {
  getItem(path: ResolvedPath): Promise<Result<ProviderItem>>;
  itemExists(path: ResolvedPath): Promise<boolean>;
  setItem(path: ResolvedPath, value: PSValue): Promise<Result<ProviderItem>>;
  /**
   * `Clear-Item`.
   *
   * MEASURED, and the answers are NOT uniform — this is the measurement that
   * decided the shape of `SessionStateProvider`:
   *
   *   Clear-Item Env:x       -> the variable is GONE      (Test-Path False)
   *   Clear-Item Variable:x  -> the variable SURVIVES, holding $null
   *   Clear-Item Function:f  -> the function is GONE
   *   Clear-Item Alias:a     -> the alias is GONE
   *
   * One rule underneath ("clearing writes null") with a per-table answer to
   * "what does a null mean here", which is why it is one implementation.
   */
  clearItem(path: ResolvedPath): Promise<Result<void>>;
  /** Could this path name an item at all? Not whether one is there. */
  isValidPath(path: ResolvedPath): boolean;
}

/** Children, and the operations that create and destroy them. */
export interface ContainerProvider extends ItemProvider {
  /** Already ordered; see `orderChildItems` in providers/filesystem.ts. */
  getChildItems(path: ResolvedPath): Promise<Result<readonly ProviderItem[]>>;
  getChildNames(path: ResolvedPath): Promise<Result<readonly string[]>>;
  hasChildItems(path: ResolvedPath): Promise<boolean>;
  newItem(
    path: ResolvedPath,
    itemType: string | undefined,
    value: PSValue,
  ): Promise<Result<ProviderItem>>;
  removeItem(path: ResolvedPath, recurse: boolean): Promise<Result<void>>;
  copyItem(from: ResolvedPath, to: ResolvedPath, recurse: boolean): Promise<Result<void>>;
  renameItem(path: ResolvedPath, newName: string): Promise<Result<void>>;
}

/**
 * A provider whose items can themselves hold items.
 *
 * The distinction is not decoration and it is not readable from
 * `Get-PSProvider`. MEASURED, and this is the behaviour that proves `Env:` is
 * NOT one:
 *
 *   Set-Location Env:\PATH
 *     -> PathNotFound,...SetLocationCommand
 *        "Cannot find path 'Env:\PATH' because it does not exist."
 *
 * The item plainly EXISTS — `Test-Path Env:PATH` is True in the same session.
 * `Set-Location` asks "is this a container?", a non-navigation provider answers
 * "only my root is", and pwsh reports the negative as a path that is not there.
 * Reproduced deliberately; saying "not a container" would be an improvement on
 * the reference implementation, which is not the job.
 */
export interface NavigationProvider extends ContainerProvider {
  isContainer(path: ResolvedPath): Promise<boolean>;
  makePath(parent: string, child: string): string;
  getParentPath(path: string, root: string): string;
  moveItem(from: ResolvedPath, to: ResolvedPath): Promise<Result<void>>;
}

/**
 * `Get-Content` / `Set-Content` / `Clear-Content`.
 *
 * SURPRISING AND MEASURED: ALL FOUR session-state providers support content.
 * The natural assumption is that `Get-Content Env:PATH` is an error — it is
 * not, and neither are the other three:
 *
 *   Get-Content Env:PATH         System.String
 *   Get-Content Variable:PID     System.Int32      (the VALUE, not a string)
 *   Get-Content Function:prompt  System.Management.Automation.ScriptBlock
 *   Get-Content Alias:ls         System.String     ("Get-ChildItem")
 *
 * They share `SessionStateProviderBase`, which implements
 * `IContentCmdletProvider`. Content is a SEPARATE interface here for the same
 * reason it is separate in PowerShell: a provider can be a container without
 * having content, and vice versa.
 *
 * ALSO MEASURED, and it contradicts the filesystem: content is NOT split into
 * lines. An environment variable holding "a\nb" yields ONE item from
 * `Get-Content`, where a file with the same bytes yields two.
 */
export interface ContentProvider {
  getContent(path: ResolvedPath): Promise<Result<readonly PSValue[]>>;
  setContent(path: ResolvedPath, content: readonly PSValue[]): Promise<Result<void>>;
  clearContent(path: ResolvedPath): Promise<Result<void>>;
}

/** What a registry stores: at minimum an item provider. */
export type PSProvider = ItemProvider;

// ---------------------------------------------------------------------------
// narrowing
// ---------------------------------------------------------------------------

/**
 * Structural guards rather than a flag on `ProviderInfo`.
 *
 * A flag would be a second statement of the same fact — the methods are either
 * there or not — and the two would drift. `Get-PSProvider` does not carry the
 * fact either (see `ProviderCapability`), so there is nothing to mirror.
 */
export function isContainerProvider(provider: PSProvider): provider is ContainerProvider {
  return typeof (provider as Partial<ContainerProvider>).getChildItems === 'function';
}

export function isNavigationProvider(provider: PSProvider): provider is NavigationProvider {
  return typeof (provider as Partial<NavigationProvider>).isContainer === 'function';
}

export function isContentProvider(provider: PSProvider): provider is PSProvider & ContentProvider {
  return typeof (provider as Partial<ContentProvider>).getContent === 'function';
}

