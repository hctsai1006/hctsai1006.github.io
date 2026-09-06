/**
 * session-state.ts — Env:, Variable:, Function: and Alias:, written ONCE.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE IMPLEMENTATION AND NOT FOUR
 * ---------------------------------------------------------------------------
 *
 * PowerShell derives all four from `SessionStateProviderBase`, which is the
 * external evidence. The internal evidence is stronger: the defect shape this
 * repository has found SIX separate times is "one conversion implemented more
 * than once, drifting silently". Four near-identical flat providers is that
 * shape pre-assembled, and the drift would be invisible — three drives sorting
 * one way and the fourth another is not something a reader notices.
 *
 * So there is one class and four DESCRIPTORS. A descriptor answers only the
 * questions where the four genuinely differ, and the measurements below say
 * that is a short list: what an item looks like, what its content is, what an
 * incoming value has to be, and what a null MEANS.
 *
 * ---------------------------------------------------------------------------
 * THE MEASUREMENT THAT DECIDED THE SHAPE
 * ---------------------------------------------------------------------------
 *
 * `Clear-Item` looked self-contradictory next to `Set-Item -Value ''`, so both
 * directions were run on all four drives, pwsh 7.6.5 on Windows. The
 * `Clear-Item` column and the `Env:` empty-string row were re-run in the
 * pwsh-linux:7.6.5 container and came back identical; the `Function:` and
 * `Alias:` empty-string rows were NOT re-run there and are Windows-only
 * measurements.
 *
 *   drive       Clear-Item              Set-Item -Value ''      Set-Item -Value $null
 *   ----------  ----------------------  ----------------------  ---------------------
 *   Env:        REMOVED                 survives, length 0      REMOVED, no error
 *   Variable:   survives, value $null   survives                survives
 *   Function:   REMOVED                 survives                (not probed)
 *   Alias:      REMOVED                 REFUSED: Argument,      (not probed)
 *                                       ...SetItemCommand
 *
 * The rule underneath is single: CLEARING WRITES NULL. Only the answer to
 * "what does a null mean in this table" differs — a variable can hold `$null`,
 * an environment variable, a function and an alias cannot, so writing null to
 * those three deletes. That is one line of the descriptor (`nullRemoves`), not
 * four implementations.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS ENGINE ACTUALLY HAS TO PUT IN THESE DRIVES
 * ---------------------------------------------------------------------------
 *
 * `Env:` is backed by the session's environment and `Alias:` by the command
 * registry, so both list real data. `Variable:` and `Function:` are backed by
 * EMPTY stores, because this engine has neither: `src/language/parse.ts`
 * reports a variable reference as "a variable reference, which this engine
 * cannot resolve because it has no variables", and nothing defines a function.
 *
 * An empty drive is the truthful rendering of that, and it is deliberately not
 * papered over with invented automatic variables. When session state lands it
 * supplies a `SessionStateStore` and no provider code changes — which is the
 * only claim this file is making about the future.
 */

import { err, formatResolved, ok } from '../storage/index.ts';
import type { ResolvedPath, Result, StorageSyscall } from '../storage/index.ts';
import { psObject, toPSString } from '../pipeline/psobject.ts';
import type { PSValue } from '../pipeline/psobject.ts';
import { orderChildItems } from './filesystem.ts';
import type {
  ContainerProvider,
  ContentProvider,
  PSDriveInfo,
  ProviderInfo,
  ProviderItem,
} from './types.ts';

/**
 * The table a session-state provider reads and writes.
 *
 * Deliberately not a `Map`: the host owns this data, and `Env:` has to read the
 * session's real environment rather than a copy the provider keeps. Lookup is
 * CASE-INSENSITIVE and the STORED case is what comes back — measured:
 * `(Get-Item Env:ZZCASE).Name` is `zzCase`.
 */
export interface SessionStateStore {
  /** `undefined` means absent. A present entry may legitimately hold `null`. */
  get(name: string): PSValue | undefined;
  has(name: string): boolean;
  set(name: string, value: PSValue): void;
  delete(name: string): boolean;
  /** In any order; the provider sorts. */
  names(): readonly string[];
  /**
   * The spelling this name is STORED under, or the name itself when it is
   * absent. Measured: `(Get-Item Env:ZZCASE).Name` is `zzCase`.
   *
   * On the store rather than derived by the provider, because the store is
   * already the thing that decided two names are the same one. A provider that
   * scanned `names()` for a case-insensitive match would be a SECOND
   * implementation of that decision, and the day a store folds differently —
   * an invariant-culture fold, say — the two would disagree about which item
   * `Env:ZZCASE` is.
   */
  canonicalName(name: string): string;
}

/**
 * The case-insensitive, case-preserving table the four drives need.
 *
 * `MountTable` in storage/vfs.ts keeps the same lower-cased-key-to-canonical
 * map for drive names. They are NOT merged into one helper: that one answers
 * "which drive is this" for the resolver and is owned by the storage layer,
 * this one answers "which item is this" and is owned by a provider, and a
 * shared class would tie a change in either to the other. The duplication is
 * a handful of lines and is recorded here so it stays a decision rather than an
 * oversight.
 */
export class MapSessionStateStore implements SessionStateStore {
  /** lower-cased name -> the name as stored. */
  readonly #canonical = new Map<string, string>();
  readonly #values = new Map<string, PSValue>();

  constructor(initial: Iterable<readonly [string, PSValue]> = []) {
    for (const [name, value] of initial) this.set(name, value);
  }

  #key(name: string): string | undefined {
    return this.#canonical.get(name.toLowerCase());
  }

  get(name: string): PSValue | undefined {
    const key = this.#key(name);
    if (key === undefined) return undefined;
    return this.#values.get(key);
  }

  has(name: string): boolean {
    return this.#key(name) !== undefined;
  }

  set(name: string, value: PSValue): void {
    // An existing entry keeps the case it was created with, exactly as pwsh
    // does: `$env:zzCase='a'` then `Set-Item Env:ZZCASE 'b'` still lists as
    // `zzCase`.
    const key = this.#key(name) ?? name;
    this.#canonical.set(name.toLowerCase(), key);
    this.#values.set(key, value);
  }

  delete(name: string): boolean {
    const key = this.#key(name);
    if (key === undefined) return false;
    this.#canonical.delete(name.toLowerCase());
    return this.#values.delete(key);
  }

  names(): readonly string[] {
    return [...this.#values.keys()];
  }

  canonicalName(name: string): string {
    return this.#key(name) ?? name;
  }
}

/**
 * The four answers that actually differ between Env:, Variable:, Function: and
 * Alias:. Everything else is `SessionStateProvider` below.
 */
export interface SessionStateDescriptor {
  readonly info: ProviderInfo;
  /** `Env`. The drive this provider offers by default. */
  readonly driveName: string;
  /**
   * Whether writing `null` DELETES rather than stores. Measured per drive; see
   * the header table.
   */
  readonly nullRemoves: boolean;
  /** The object `Get-Item` and `Get-ChildItem` emit. */
  item(name: string, value: PSValue, psPath: string, drive: string): PSValue;
  /** What `Get-Content` yields for one item. */
  content(name: string, value: PSValue): PSValue;
  /**
   * Coerce an incoming `Set-Item` value, or refuse it.
   *
   * `null` passes through untouched — deciding what a null means is
   * `nullRemoves`' job, and doing it in two places is how they would disagree.
   */
  accept(value: PSValue): Result<PSValue>;
}

const CORE = 'Microsoft.PowerShell.Core';

/**
 * MEASURED and it is a PLATFORM fact: `(Get-Location).Provider.ItemSeparator`
 * inside `Env:` is `\` on Windows and `/` on Linux. The emulated machine is
 * Ubuntu.
 */
const ITEM_SEPARATOR = '/';

function providerInfo(name: string): ProviderInfo {
  return {
    name,
    moduleName: CORE,
    fullName: `${CORE}\\${name}`,
    implementingType: `Microsoft.PowerShell.Commands.${name}Provider`,
    // MEASURED: `Get-PSProvider` reports exactly `ShouldProcess` for all four,
    // and NOT `Filter` — which is why `Get-ChildItem Env: -Filter 'zz*'` is
    // refused rather than honoured.
    capabilities: ['ShouldProcess'],
    itemSeparator: ITEM_SEPARATOR,
  };
}

function invalidValue(path: string, syscall: StorageSyscall, reason: string, message: string) {
  return err({ code: 'EINVAL' as const, path, syscall, message, reason });
}

/**
 * The four properties every provider item carries, in the measured order.
 *
 * MEASURED: a `Get-ChildItem Env:` row's properties are
 * `PSPath PSDrive PSProvider PSIsContainer Name Key Value` — the note-worthy
 * half being what is ABSENT. There is no `PSParentPath` and no `PSChildName`,
 * which the FileSystem provider both emit. The same fact shows up at the other
 * end of the path seam: `Split-Path 'Env:\PATH' -Parent` is the EMPTY STRING,
 * not `Env:\`. A flat provider has no parent path to report, so it reports
 * none.
 *
 * `PSDrive` and `PSProvider` are STRINGS here, where pwsh has a `PSDriveInfo`
 * and a `ProviderInfo` object. That matches what `fileSystemInfo` already does
 * for the filesystem, and one shape for both is worth more than two.
 */
function common(psPath: string, drive: string, info: ProviderInfo, isContainer: boolean) {
  return {
    PSPath: psPath,
    PSDrive: drive,
    PSProvider: info.fullName,
    PSIsContainer: isContainer,
  };
}

// ---------------------------------------------------------------------------
// the four descriptors
// ---------------------------------------------------------------------------

/**
 * `Env:` — MEASURED `System.Collections.DictionaryEntry`, and PowerShell ADDS
 * `Name` to it. A bare DictionaryEntry has only `Key` and `Value`; the `Name`
 * that `Get-ChildItem Env: | Sort-Object Name` relies on is PowerShell's doing.
 */
export const ENVIRONMENT_DESCRIPTOR: SessionStateDescriptor = {
  info: providerInfo('Environment'),
  driveName: 'Env',
  nullRemoves: true,
  item(name, value, psPath, drive) {
    return psObject(
      {
        ...common(psPath, drive, this.info, false),
        Name: name,
        Key: name,
        Value: value,
      },
      ['System.Collections.DictionaryEntry', 'System.ValueType', 'System.Object'],
    );
  },
  content(_name, value) {
    return value;
  },
  accept(value) {
    if (value === null) return ok(value);
    // An environment block holds strings. `Set-Item Env:x -Value 1` storing the
    // number 1 rather than "1" would make `$env:x` a number, which no process
    // environment can be. NOT MEASURED against pwsh with a non-string value;
    // the coercion is this engine's, and it is the only one that keeps
    // `Get-Content Env:x` returning `System.String` as measured.
    return ok(toPSString(value));
  },
};

/**
 * `Variable:` — MEASURED `System.Management.Automation.PSVariable`, and the ONE
 * table where writing null does not delete, because a variable can hold `$null`.
 *
 * `Module` and `ModuleName` are measured on the real object and deliberately
 * NOT emitted: there is no module system here, and an empty string would claim
 * "this variable belongs to no module" where the truth is "this engine has no
 * modules".
 */
export const VARIABLE_DESCRIPTOR: SessionStateDescriptor = {
  info: providerInfo('Variable'),
  driveName: 'Variable',
  nullRemoves: false,
  item(name, value, psPath, drive) {
    return psObject(
      {
        ...common(psPath, drive, this.info, false),
        Name: name,
        Description: '',
        Value: value,
        Visibility: 'Public',
        Options: 'None',
        Attributes: [],
      },
      ['System.Management.Automation.PSVariable', 'System.Object'],
    );
  },
  content(_name, value) {
    // MEASURED: `Get-Content Variable:PID` is a `System.Int32`, not a string.
    // Content is the VALUE, unconverted.
    return value;
  },
  accept(value) {
    return ok(value);
  },
};

/**
 * `Function:` — MEASURED `System.Management.Automation.FunctionInfo`, whose
 * `Definition` is the function body TEXT.
 *
 * `ScriptBlock`, `Parameters`, `ParameterSets`, `OutputType`, `HelpUri` and
 * `Module` are on the real object and are not emitted: this engine has no
 * script blocks it could hand out and no parameter metadata for a function it
 * cannot define. `Get-Content Function:f` therefore yields the definition
 * STRING where pwsh yields a `ScriptBlock` — recorded as a known difference
 * rather than faked with an object that has no behaviour.
 */
export const FUNCTION_DESCRIPTOR: SessionStateDescriptor = {
  info: providerInfo('Function'),
  driveName: 'Function',
  nullRemoves: true,
  item(name, value, psPath, drive) {
    return psObject(
      {
        ...common(psPath, drive, this.info, false),
        Name: name,
        CommandType: 'Function',
        Definition: value,
        Options: 'None',
        Description: '',
        Visibility: 'Public',
      },
      [
        'System.Management.Automation.FunctionInfo',
        'System.Management.Automation.CommandInfo',
        'System.Object',
      ],
    );
  },
  content(_name, value) {
    return value;
  },
  accept(value) {
    if (value === null) return ok(value);
    return ok(toPSString(value));
  },
};

/**
 * `Alias:` — MEASURED `System.Management.Automation.AliasInfo`.
 *
 *   (Get-Item Alias:ls).Definition           Get-ChildItem
 *   (Get-Item Alias:ls).ResolvedCommandName  Get-ChildItem
 *   (Get-Item Alias:ls).DisplayName          ls -> Get-ChildItem
 *   Get-Content Alias:ls                     Get-ChildItem   (a String)
 *
 * The one drive that REFUSES an empty value — measured:
 *
 *   Set-Item Alias:x -Value ''
 *     -> Argument,...SetItemCommand, PSArgumentException, InvalidArgument
 *        and the alias SURVIVES unchanged.
 *
 * so `accept` refuses rather than storing an alias that points nowhere.
 */
export const ALIAS_DESCRIPTOR: SessionStateDescriptor = {
  info: providerInfo('Alias'),
  driveName: 'Alias',
  nullRemoves: true,
  item(name, value, psPath, drive) {
    const definition = toPSString(value);
    return psObject(
      {
        ...common(psPath, drive, this.info, false),
        Name: name,
        CommandType: 'Alias',
        Definition: definition,
        ReferencedCommand: definition,
        ResolvedCommandName: definition,
        DisplayName: `${name} -> ${definition}`,
        Options: 'None',
        Description: '',
        Visibility: 'Public',
      },
      [
        'System.Management.Automation.AliasInfo',
        'System.Management.Automation.CommandInfo',
        'System.Object',
      ],
    );
  },
  content(_name, value) {
    return toPSString(value);
  },
  accept(value) {
    if (value === null) return ok(value);
    const text = toPSString(value);
    if (text === '') {
      return invalidValue(
        'Alias:',
        'write',
        'empty-alias-definition',
        'cannot process argument because the value of argument "value" is not valid',
      );
    }
    return ok(text);
  },
};

// ---------------------------------------------------------------------------
// the one implementation
// ---------------------------------------------------------------------------

/**
 * A flat, case-insensitive table addressed as a drive.
 *
 * Implements `ContainerProvider` and `ContentProvider` and NOT
 * `NavigationProvider`, which is the whole of the difference between `Env:` and
 * the filesystem. The consequence is measured:
 *
 *   Set-Location Env:\PATH  ->  "Cannot find path 'Env:\PATH' because it does
 *                               not exist."   (the item EXISTS)
 *   Get-ChildItem Env:\PATH\more
 *                           ->  "Cannot find path 'PATH/more' because it does
 *                               not exist."   (not "not a container")
 *
 * A second path segment is therefore ENOENT here, not ENOTDIR: pwsh reports a
 * flat provider's over-long path as missing, and saying "not a directory"
 * would be a better error than the reference implementation gives.
 */
export class SessionStateProvider implements ContainerProvider, ContentProvider {
  readonly #descriptor: SessionStateDescriptor;
  readonly #store: SessionStateStore;

  constructor(descriptor: SessionStateDescriptor, store: SessionStateStore) {
    this.#descriptor = descriptor;
    this.#store = store;
  }

  get info(): ProviderInfo {
    return this.#descriptor.info;
  }

  get store(): SessionStateStore {
    return this.#store;
  }

  defaultDrives(): readonly PSDriveInfo[] {
    // MEASURED: `(Get-PSDrive Env).Root` is the EMPTY STRING, which is what
    // makes `Microsoft.PowerShell.Core\Environment::PATH` the whole PSPath with
    // no drive segment in it.
    return [{ name: this.#descriptor.driveName, root: '', provider: this.#descriptor.info }];
  }

  /**
   * `/PATH` -> `PATH`; `/` -> `null`, meaning the drive root.
   *
   * Returns `undefined` for anything with a second segment. `resolvePath` has
   * already normalised, so `Env:/a/b` arrives as `/a/b` and there is nothing
   * left to parse — only to reject.
   */
  #nameOf(path: ResolvedPath): string | null | undefined {
    const segments = path.path.split('/').filter((s) => s !== '');
    if (segments.length === 0) return null;
    if (segments.length > 1) return undefined;
    return segments[0];
  }

  #psPath(name: string | null): string {
    // MEASURED: the root's PSPath is `Microsoft.PowerShell.Core\Environment::`
    // with nothing after the separator.
    return `${this.#descriptor.info.fullName}::${name ?? ''}`;
  }

  #rootItem(path: ResolvedPath): ProviderItem {
    // pwsh returns a `Dictionary<string,DictionaryEntry>.ValueCollection` for
    // `Get-Item Env:\`. That type name carries an assembly version and a
    // generic arity; reproducing it would be transcribing a .NET internal, not
    // modelling a behaviour. This emits a container item instead and says so.
    return {
      name: this.#descriptor.driveName,
      path,
      isContainer: true,
      value: psObject(
        {
          ...common(this.#psPath(null), this.#descriptor.driveName, this.#descriptor.info, true),
          Name: this.#descriptor.driveName,
        },
        ['System.Object'],
      ),
    };
  }

  #itemFor(name: string, value: PSValue, path: ResolvedPath): ProviderItem {
    return {
      name,
      path,
      isContainer: false,
      value: this.#descriptor.item(name, value, this.#psPath(name), this.#descriptor.driveName),
    };
  }

  #missing(path: ResolvedPath, syscall: StorageSyscall) {
    return err({
      code: 'ENOENT' as const,
      path: path.path,
      syscall,
      message: `there is no ${this.#descriptor.info.name.toLowerCase()} item named '${path.path}'`,
    });
  }

  // -- item -----------------------------------------------------------------

  isValidPath(path: ResolvedPath): boolean {
    return this.#nameOf(path) !== undefined;
  }

  async getItem(path: ResolvedPath): Promise<Result<ProviderItem>> {
    const name = this.#nameOf(path);
    if (name === undefined) return this.#missing(path, 'stat');
    if (name === null) return ok(this.#rootItem(path));
    if (!this.#store.has(name)) return this.#missing(path, 'stat');
    // `has` and `get` are two lookups on purpose: a stored `null` is a real
    // value in `Variable:`, so `get(...) === undefined` cannot stand in for
    // absence.
    const stored = this.#store.get(name);
    return ok(this.#itemFor(this.#store.canonicalName(name), stored ?? null, path));
  }

  async itemExists(path: ResolvedPath): Promise<boolean> {
    const name = this.#nameOf(path);
    if (name === undefined) return false;
    if (name === null) return true;
    return this.#store.has(name);
  }

  async setItem(path: ResolvedPath, value: PSValue): Promise<Result<ProviderItem>> {
    const name = this.#nameOf(path);
    if (name === undefined || name === null) {
      return invalidValue(
        path.full,
        'write',
        'not-an-item',
        `'${path.full}' does not name an item in ${this.#descriptor.info.name}`,
      );
    }
    const accepted = this.#descriptor.accept(value);
    if (!accepted.ok) return err({ ...accepted.error, path: path.full });

    if (accepted.value === null && this.#descriptor.nullRemoves) {
      this.#store.delete(name);
      // Nothing survives to return an item for. `Set-Item` emits nothing
      // without -PassThru, so no caller can see this; what pwsh emits from
      // `Set-Item Env:x -Value $null -PassThru` is NOT MEASURED, and the item
      // returned here describes what was asked for rather than what remains.
      return ok(this.#itemFor(name, null, path));
    }
    this.#store.set(name, accepted.value);
    return ok(this.#itemFor(this.#store.canonicalName(name), accepted.value, path));
  }

  /** Clearing writes null; `nullRemoves` decides what that means. */
  async clearItem(path: ResolvedPath): Promise<Result<void>> {
    const name = this.#nameOf(path);
    if (name === undefined || name === null) {
      return invalidValue(
        path.full,
        'write',
        'not-an-item',
        `'${path.full}' does not name an item in ${this.#descriptor.info.name}`,
      );
    }
    if (!this.#store.has(name)) return this.#missing(path, 'write');
    if (this.#descriptor.nullRemoves) {
      this.#store.delete(name);
      return ok(undefined);
    }
    this.#store.set(name, null);
    return ok(undefined);
  }

  // -- container ------------------------------------------------------------

  async getChildItems(path: ResolvedPath): Promise<Result<readonly ProviderItem[]>> {
    const name = this.#nameOf(path);
    if (name === undefined) return this.#missing(path, 'readdir');
    if (name !== null) {
      // MEASURED: `Get-ChildItem -LiteralPath Env:PATH` on a LEAF returns the
      // leaf itself, count 1 — it is not an error and it is not empty.
      const item = await this.getItem(path);
      if (!item.ok) return item;
      return ok([item.value]);
    }
    const items: ProviderItem[] = [];
    for (const stored of this.#store.names()) {
      const inside = `/${stored}`;
      const child: ResolvedPath = {
        drive: path.drive,
        path: inside,
        // `formatResolved`, not a template: the separator a provider drive
        // prints is a platform fact that lives in exactly one function, and a
        // second `${drive}:/` here is how the two would disagree.
        full: formatResolved(path.drive, inside),
        clampedAtRoot: false,
      };
      items.push(this.#itemFor(stored, this.#store.get(stored) ?? null, child));
    }
    // `orderChildItems`, the SAME function the filesystem sorts with, told
    // there are no containers — which is true here and is the only difference
    // between the two orders. Calling `compareValues` directly would have been
    // a second spelling of one rule, and the day the rule changes only one
    // spelling would follow.
    return ok(orderChildItems(items, (item) => item.name, () => false));
  }

  async getChildNames(path: ResolvedPath): Promise<Result<readonly string[]>> {
    const items = await this.getChildItems(path);
    if (!items.ok) return items;
    return ok(items.value.map((item) => item.name));
  }

  async hasChildItems(path: ResolvedPath): Promise<boolean> {
    if (this.#nameOf(path) !== null) return false;
    return this.#store.names().length > 0;
  }

  async newItem(
    path: ResolvedPath,
    _itemType: string | undefined,
    value: PSValue,
  ): Promise<Result<ProviderItem>> {
    const name = this.#nameOf(path);
    if (name === undefined || name === null) {
      return invalidValue(
        path.full,
        'write',
        'not-an-item',
        `'${path.full}' does not name an item in ${this.#descriptor.info.name}`,
      );
    }
    if (this.#store.has(name)) {
      // MEASURED: New-Item over an existing session-state item is
      //   Argument,...NewItemCommand, PSArgumentException, InvalidArgument
      //   "The item at path 'zzNewE' already exists."
      // which is EEXIST's condition even though pwsh does not use its
      // filesystem id for it. The command layer owns that mapping.
      return err({
        code: 'EEXIST',
        path: path.path,
        syscall: 'write',
        message: `the item at path '${name}' already exists`,
        existing: 'file',
      });
    }
    return this.setItem(path, value);
  }

  async removeItem(path: ResolvedPath, _recurse: boolean): Promise<Result<void>> {
    const name = this.#nameOf(path);
    if (name === undefined || name === null) {
      return invalidValue(
        path.full,
        'remove',
        'not-an-item',
        `'${path.full}' does not name an item in ${this.#descriptor.info.name}`,
      );
    }
    if (!this.#store.delete(name)) return this.#missing(path, 'remove');
    return ok(undefined);
  }

  async copyItem(from: ResolvedPath, to: ResolvedPath, _recurse: boolean): Promise<Result<void>> {
    const source = await this.getItem(from);
    if (!source.ok) return source;
    const name = this.#nameOf(from);
    if (name === null || name === undefined) return this.#missing(from, 'copy');
    const written = await this.setItem(to, this.#store.get(name) ?? null);
    if (!written.ok) return written;
    return ok(undefined);
  }

  async renameItem(path: ResolvedPath, newName: string): Promise<Result<void>> {
    const name = this.#nameOf(path);
    if (name === undefined || name === null) return this.#missing(path, 'rename');
    if (!this.#store.has(name)) return this.#missing(path, 'rename');
    const value = this.#store.get(name) ?? null;
    this.#store.delete(name);
    this.#store.set(newName, value);
    return ok(undefined);
  }

  // -- content --------------------------------------------------------------

  /**
   * MEASURED, and it is the opposite of the natural assumption: all four of
   * these support `Get-Content`. It is also NOT line-split — an environment
   * variable holding `"a\nb"` yields ONE item, where a file with the same bytes
   * yields two. So this returns a single-element array and never calls
   * `splitLines`.
   */
  async getContent(path: ResolvedPath): Promise<Result<readonly PSValue[]>> {
    const item = await this.getItem(path);
    if (!item.ok) return item;
    const name = this.#nameOf(path);
    if (name === null || name === undefined) {
      // MEASURED: `Get-Content Env:\` is
      //   Argument,...GetContentCommand, PSArgumentException, InvalidArgument
      // — the drive root is not readable as content.
      return invalidValue(
        path.full,
        'read',
        'container-has-no-content',
        `cannot process argument because the value of argument "path" is not valid`,
      );
    }
    return ok([this.#descriptor.content(name, this.#store.get(name) ?? null)]);
  }

  async setContent(path: ResolvedPath, content: readonly PSValue[]): Promise<Result<void>> {
    // pwsh joins multiple content values with a newline before writing to a
    // session-state item. NOT MEASURED for more than one value; a single value
    // is the only shape this engine's `Set-Content` produces today.
    const value =
      content.length === 1
        ? content[0] ?? null
        : content.map((entry) => toPSString(entry)).join('\n');
    const written = await this.setItem(path, value);
    if (!written.ok) return written;
    return ok(undefined);
  }

  async clearContent(path: ResolvedPath): Promise<Result<void>> {
    // `Clear-Content` writes the empty string, which is NOT `Clear-Item`. The
    // difference is the whole point of the header's measurement table:
    // `Set-Item Env:x -Value ''` keeps the variable, `Clear-Item Env:x` deletes
    // it.
    const written = await this.setItem(path, '');
    if (!written.ok) return written;
    return ok(undefined);
  }
}

/** `Env:`, over the session's environment. */
export function environmentProvider(store: SessionStateStore): SessionStateProvider {
  return new SessionStateProvider(ENVIRONMENT_DESCRIPTOR, store);
}

/** `Variable:`. Empty until this engine has variables; see the header. */
export function variableProvider(store: SessionStateStore): SessionStateProvider {
  return new SessionStateProvider(VARIABLE_DESCRIPTOR, store);
}

/** `Function:`. Empty until this engine has functions; see the header. */
export function functionProvider(store: SessionStateStore): SessionStateProvider {
  return new SessionStateProvider(FUNCTION_DESCRIPTOR, store);
}

/** `Alias:`, over the command registry's alias table. */
export function aliasProvider(store: SessionStateStore): SessionStateProvider {
  return new SessionStateProvider(ALIAS_DESCRIPTOR, store);
}
