/**
 * filesystem.ts — the FileSystem provider, as an ADAPTER over what already
 * exists.
 *
 * ---------------------------------------------------------------------------
 * IT DOES NOT REPLACE `StorageBackend`, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 *
 * The OPFS and memory backends are unchanged by PR-10, and `VirtualFileSystem`
 * still owns mounts, resolution and the seed/overlay split. This class is a
 * thin translation: `ResolvedPath` in, `ProviderItem` out, with a
 * `FileSystemPort` doing the work — which keeps every call BROKERED. A provider
 * that reached `VirtualFileSystem` directly would give a command holding no
 * `filesystem.read` capability a way around the broker, and `ports.ts` exists
 * to make that impossible.
 *
 * The item shaping (`fileSystemInfo` and the four helpers under it) MOVED here
 * from `commands/fs-read/support.ts`. It was always the FileSystem provider's
 * answer to "what does one of my items look like", which is exactly the
 * question `ProviderItem.value` asks; leaving it in a command directory would
 * have meant the session-state providers built their items in the provider
 * layer and the filesystem built its somewhere else. `support.ts` re-exports
 * the same symbols, so nothing that used them had to change.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE ONLY NAVIGATION PROVIDER HERE
 * ---------------------------------------------------------------------------
 *
 * `isContainer`, `makePath`, `getParentPath` and `moveItem` are implemented
 * because a filesystem really is a hierarchy. The four session-state providers
 * implement none of them, and the registry's dispatch reads that difference
 * structurally rather than off a flag — see `isNavigationProvider`.
 */

import { basename, dirname, formatMode, formatResolved, joinPath, ok } from '../storage/index.ts';
import type { FileStat, ResolvedPath, Result } from '../storage/index.ts';
import { compareValues, psObject } from '../pipeline/psobject.ts';
import type { PSObject, PSValue } from '../pipeline/psobject.ts';
import type { FileSystemPort } from '../commands/ports.ts';
import type {
  ContentProvider,
  NavigationProvider,
  PSDriveInfo,
  ProviderInfo,
  ProviderItem,
} from './types.ts';

// ---------------------------------------------------------------------------
// item shaping (moved from commands/fs-read/support.ts; see the header)
// ---------------------------------------------------------------------------

/** Hidden, by the only rule this filesystem has: a leading dot. */
export function isHidden(name: string): boolean {
  return name.startsWith('.');
}

/**
 * `.NET`'s `Path.GetExtension`: everything from the LAST dot, dot included.
 *
 *   pwsh: (Get-Item zeta.md).Extension       ->  .md
 *   pwsh: (Get-Item dotted.dir).Extension    ->  .dir   (directories too)
 *   pwsh: (Get-Item .dotonly).Extension      ->  .dotonly
 */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot);
}

/**
 * `BaseName`, which is NOT the same script property on the two types.
 *
 *   pwsh: (Get-Item zeta.md).BaseName        ->  zeta        (file: strip it)
 *   pwsh: (Get-Item .dotonly).BaseName       ->  <empty>     (file: strip it)
 *   pwsh: (Get-Item dotted.dir).BaseName     ->  dotted.dir  (directory: keep it)
 */
export function baseNameOf(name: string, kind: FileStat['kind']): string {
  if (kind === 'directory') return name;
  const dot = name.lastIndexOf('.');
  return dot === -1 ? name : name.slice(0, dot);
}

export const FILE_INFO_TYPE_NAMES: readonly string[] = [
  'System.IO.FileInfo',
  'System.IO.FileSystemInfo',
  'System.MarshalByRefObject',
  'System.Object',
];
export const DIRECTORY_INFO_TYPE_NAMES: readonly string[] = [
  'System.IO.DirectoryInfo',
  'System.IO.FileSystemInfo',
  'System.MarshalByRefObject',
  'System.Object',
];

/** pwsh: `(Get-Item x).PSProvider` -> `Microsoft.PowerShell.Core\FileSystem`. */
export const FILESYSTEM_PROVIDER = 'Microsoft.PowerShell.Core\\FileSystem';

/**
 * `Mode`, the five-character attribute string.
 *
 * Measured on Windows, where the positions and the letters come from:
 *
 *   pwsh: a directory   ->  d----
 *   pwsh: a file        ->  -a---
 *   pwsh: a hidden file ->  -a-h-
 *
 * so the columns are `d a r h s`. WHICH of them this filesystem can set is a
 * different question, and inventing the rest would be worse than omitting them:
 *
 *   d  from `FileStat.kind`
 *   a  ARCHIVE is a Windows attribute with no POSIX bit behind it. `FileStat`
 *      has nowhere to store one, so it is always '-'. On Windows every ordinary
 *      file shows `a`; that is a property of NTFS, not of this store.
 *   r  from the owner's write bit — .NET derives IsReadOnly the same way on Unix
 *   h  from the leading dot, which is the only hidden rule this filesystem has
 *      and the rule v1's `ls` already used (`k.charAt(0) !== '.'`)
 *   s  SYSTEM, as with ARCHIVE: no bit, always '-'
 *
 * `UnixMode` below is the one that carries the whole truth, which is why the
 * default table leads with it.
 */
export function modeString(stat: FileStat): string {
  const readOnly = (stat.mode & 0o200) === 0;
  return (
    (stat.kind === 'directory' ? 'd' : '-') +
    '-' +
    (readOnly ? 'r' : '-') +
    (isHidden(stat.name) ? 'h' : '-') +
    '-'
  );
}

/**
 * The object `Get-ChildItem` emits.
 *
 * TYPE NAMES ARE MEASURED. `(Get-Item x).PSTypeNames` is
 * `System.IO.FileInfo, System.IO.FileSystemInfo, System.MarshalByRefObject,
 * System.Object` for a file and the DirectoryInfo chain for a directory, and
 * `Get-ChildItem` really does emit two different types from one call.
 *
 * PROPERTY ORDER IS THE PS7-ON-UNIX DEFAULT TABLE, then everything else. There
 * is no format view for FileInfo in this engine yet, so `Format-Table` builds
 * its columns from the first object's properties in order; leading with
 * `UnixMode User Group LastWriteTime Length Name` is what makes the default
 * rendering resemble the reference implementation's on Linux, which is the
 * platform being emulated and the column set v1 chose for the same reason.
 * (pwsh on Linux labels the Length column `Size`; the PROPERTY is `Length`
 * there too, so the label is the formatter's business and not modelled here.)
 *
 * `Length` IS ABSENT ON A DIRECTORY, which was measured and is easy to get
 * wrong:
 *
 *   pwsh: (Get-Item sub).PSObject.Properties['Length']   ->  $null
 *   pwsh: (Get-Item sub).Length                          ->  1
 *
 * The 1 is PowerShell's intrinsic collection Count showing through, not a size,
 * and `Get-Member` on a DirectoryInfo lists no Length at all. So a directory
 * here has no Length property and its cell in the table is blank, exactly as
 * `Get-ChildItem | Format-Table` shows.
 *
 * `PSParentPath` and `PSChildName` ARE emitted here and are ABSENT on a
 * session-state item — measured on both sides. The same asymmetry shows at the
 * other end of the path seam: `Split-Path 'Env:\PATH' -Parent` is the empty
 * string while `Split-Path 'C:\a\b' -Parent` is `C:\a`. Only a navigation
 * provider has parents.
 *
 * DELIBERATELY NOT EMITTED, because this storage cannot answer them and a
 * plausible-looking wrong value is worse than a missing one: `LastAccessTime`
 * (no atime in `FileStat`), `Attributes` (a Windows flags enum), `LinkType`,
 * `LinkTarget`, `Target`, `ResolvedTarget` (there are no symbolic links —
 * `storage/types.ts` says so), `VersionInfo`, `UnixFileMode` (the .NET enum
 * rendering), `Directory`, `Parent` and `Root` (which are FileSystemInfo
 * OBJECTS in pwsh; `DirectoryName` is the string form and is emitted).
 */
export function fileSystemInfo(stat: FileStat, resolved: ResolvedPath): PSObject {
  const isDirectory = stat.kind === 'directory';
  const full = resolved.full;
  const parent = dirname(resolved.path);

  const properties: Record<string, PSValue> = {
    UnixMode: formatMode(stat.mode, stat.kind),
    User: stat.owner,
    Group: stat.group,
    LastWriteTime: new Date(stat.mtime),
  };
  // Files only. See the note above: a DirectoryInfo has no Length member.
  if (!isDirectory) properties['Length'] = stat.size;
  properties['Name'] = stat.name;

  properties['Mode'] = modeString(stat);
  properties['FullName'] = full;
  properties['PSIsContainer'] = isDirectory;
  properties['Extension'] = extensionOf(stat.name);
  properties['BaseName'] = baseNameOf(stat.name, stat.kind);
  properties['CreationTime'] = new Date(stat.birthtime);
  properties['Exists'] = true;
  if (!isDirectory) properties['IsReadOnly'] = (stat.mode & 0o200) === 0;
  if (!isDirectory) properties['DirectoryName'] = formatResolved(resolved.drive, parent);

  // pwsh: (Get-Item x).PSPath -> Microsoft.PowerShell.Core\FileSystem::<full>
  properties['PSPath'] = `${FILESYSTEM_PROVIDER}::${full}`;
  properties['PSParentPath'] = `${FILESYSTEM_PROVIDER}::${formatResolved(resolved.drive, parent)}`;
  properties['PSChildName'] = stat.name;
  properties['PSDrive'] = resolved.drive;
  properties['PSProvider'] = FILESYSTEM_PROVIDER;

  return psObject(properties, isDirectory ? DIRECTORY_INFO_TYPE_NAMES : FILE_INFO_TYPE_NAMES);
}

// ---------------------------------------------------------------------------
// ordering
// ---------------------------------------------------------------------------

/**
 * The order `Get-ChildItem` lists a directory in: DIRECTORIES FIRST, then
 * files, each collated.
 *
 * Both halves were measured, and the second one was the surprise. A directory
 * holding `a.txt B.txt C.txt _u.txt 1.txt a-b.txt ab.txt Z.txt` plus the
 * directories `a` and `M` lists as
 *
 *   pwsh: a | M | _u.txt | 1.txt | a-b.txt | a.txt | ab.txt | B.txt | C.txt | Z.txt
 *
 * which is neither ordinal (`1.txt` would precede `B.txt` and `_u.txt` would
 * follow `Z.txt`) nor natural (`f1 f10 f2` stays in that order, measured
 * separately). It is a CULTURE-AWARE collation, and the pinned `en` collator
 * behind `compareValues` reproduces it exactly — checked element by element,
 * and re-checked against a 19-character punctuation set measured on `Variable:`.
 *
 * GENERIC over the row type, and that is the point: this function had been
 * written twice within one change — once here for `ProviderItem` and once in
 * `commands/fs-read/support.ts` for `DirectoryEntry` — which is the "one
 * conversion implemented more than once" shape this repository keeps finding.
 * `sortDirectoryEntries` now delegates here, so the ordering rule exists once.
 *
 * The four flat providers sort with the same collator and WITHOUT the
 * directories-first split, because they have no containers to split on; that is
 * the only difference between the two orders, and it falls out of the predicate
 * rather than needing a second function.
 */
export function compareItemNames(a: string, b: string): number {
  return compareValues(a, b);
}

export function orderChildItems<T>(
  items: readonly T[],
  nameOf: (item: T) => string,
  isContainer: (item: T) => boolean,
): readonly T[] {
  const byName = (a: T, b: T): number => compareItemNames(nameOf(a), nameOf(b));
  return [
    ...items.filter((item) => isContainer(item)).sort(byName),
    ...items.filter((item) => !isContainer(item)).sort(byName),
  ];
}

// ---------------------------------------------------------------------------
// the provider
// ---------------------------------------------------------------------------

/**
 * MEASURED: `(Get-Location).Provider.ItemSeparator` for FileSystem is `\` on
 * Windows and `/` on Linux. The emulated machine is Ubuntu.
 */
export const FILESYSTEM_PROVIDER_INFO: ProviderInfo = {
  name: 'FileSystem',
  moduleName: 'Microsoft.PowerShell.Core',
  fullName: FILESYSTEM_PROVIDER,
  implementingType: 'Microsoft.PowerShell.Commands.FileSystemProvider',
  // MEASURED: `(Get-PSProvider FileSystem).Capabilities` is
  // `Filter, ShouldProcess, Credentials`, and it is the ONLY provider of the
  // six that carries `Filter` — which is why `Get-ChildItem Env: -Filter` is
  // refused and `Get-ChildItem C:\ -Filter` is not.
  capabilities: ['Filter', 'ShouldProcess', 'Credentials'],
  itemSeparator: '/',
};

/** The filesystem drive, as `Get-PSDrive` would report it. */
export const FILESYSTEM_DRIVE_INFO: PSDriveInfo = {
  name: '/',
  root: '/',
  provider: FILESYSTEM_PROVIDER_INFO,
};

export class FileSystemProvider implements NavigationProvider, ContentProvider {
  readonly #fs: FileSystemPort;

  constructor(fs: FileSystemPort) {
    this.#fs = fs;
  }

  get info(): ProviderInfo {
    return FILESYSTEM_PROVIDER_INFO;
  }

  defaultDrives(): readonly PSDriveInfo[] {
    return [FILESYSTEM_DRIVE_INFO];
  }

  /**
   * A resolved filesystem path renders back as an ordinary absolute POSIX path,
   * and re-resolving it is the identity — which is what lets this hand
   * `ResolvedPath.full` straight back to the port instead of reaching around
   * it. `tests/unit/providers.test.mts` asserts the idempotence rather than
   * assuming it.
   */
  #text(path: ResolvedPath): string {
    return path.full;
  }

  #item(stat: FileStat, path: ResolvedPath): ProviderItem {
    return {
      name: stat.name,
      path,
      isContainer: stat.kind === 'directory',
      value: fileSystemInfo(stat, path),
    };
  }

  isValidPath(path: ResolvedPath): boolean {
    return path.path.startsWith('/');
  }

  async getItem(path: ResolvedPath): Promise<Result<ProviderItem>> {
    const stat = await this.#fs.stat(this.#text(path));
    if (!stat.ok) return stat;
    return ok(this.#item(stat.value, path));
  }

  async itemExists(path: ResolvedPath): Promise<boolean> {
    return this.#fs.exists(this.#text(path));
  }

  async isContainer(path: ResolvedPath): Promise<boolean> {
    const stat = await this.#fs.stat(this.#text(path));
    return stat.ok && stat.value.kind === 'directory';
  }

  async setItem(path: ResolvedPath, value: PSValue): Promise<Result<ProviderItem>> {
    // `Set-Item <file>` REPLACES the file's content in pwsh — it is Set-Content
    // with a different name, not a metadata write. NOT MEASURED here; this
    // engine has no Set-Item command yet, and the arm exists so the interface
    // is total rather than because a caller uses it.
    const written = await this.#fs.writeText(this.#text(path), String(value));
    if (!written.ok) return written;
    return this.getItem(path);
  }

  async clearItem(path: ResolvedPath): Promise<Result<void>> {
    const written = await this.#fs.writeText(this.#text(path), '');
    if (!written.ok) return written;
    return ok(undefined);
  }

  async getChildItems(path: ResolvedPath): Promise<Result<readonly ProviderItem[]>> {
    const rows = await this.#fs.readdir(this.#text(path));
    if (!rows.ok) return rows;
    return ok(
      orderChildItems(
        rows.value.map((entry) => this.#item(entry.stat, this.makeChildPath(path, entry.name))),
        (item) => item.name,
        (item) => item.isContainer,
      ),
    );
  }

  async getChildNames(path: ResolvedPath): Promise<Result<readonly string[]>> {
    const items = await this.getChildItems(path);
    if (!items.ok) return items;
    return ok(items.value.map((item) => item.name));
  }

  async hasChildItems(path: ResolvedPath): Promise<boolean> {
    const rows = await this.#fs.readdir(this.#text(path));
    return rows.ok && rows.value.length > 0;
  }

  async newItem(
    path: ResolvedPath,
    itemType: string | undefined,
    value: PSValue,
  ): Promise<Result<ProviderItem>> {
    const kind = (itemType ?? 'file').toLowerCase();
    if (kind === 'directory') {
      const made = await this.#fs.mkdir(this.#text(path));
      if (!made.ok) return made;
      return this.getItem(path);
    }
    const written = await this.#fs.writeText(this.#text(path), value === null ? '' : String(value), {
      exclusive: true,
    });
    if (!written.ok) return written;
    return this.getItem(path);
  }

  async removeItem(path: ResolvedPath, recurse: boolean): Promise<Result<void>> {
    return this.#fs.remove(this.#text(path), { recursive: recurse });
  }

  async copyItem(from: ResolvedPath, to: ResolvedPath, recurse: boolean): Promise<Result<void>> {
    return this.#fs.copy(this.#text(from), this.#text(to), { recursive: recurse });
  }

  async renameItem(path: ResolvedPath, newName: string): Promise<Result<void>> {
    const target = joinPath(dirname(path.path), newName);
    return this.#fs.rename(this.#text(path), formatResolved(path.drive, target));
  }

  async moveItem(from: ResolvedPath, to: ResolvedPath): Promise<Result<void>> {
    return this.#fs.rename(this.#text(from), this.#text(to));
  }

  // -- navigation -----------------------------------------------------------

  makePath(parent: string, child: string): string {
    return joinPath(parent, child);
  }

  /**
   * MEASURED: `Split-Path 'C:\a\b' -Parent` is `C:\a`; `Split-Path 'Env:\PATH'
   * -Parent` is the EMPTY STRING, because a flat provider has no parents at all.
   *
   * `_root` is in the signature for parity with PowerShell's
   * `NavigationCmdletProvider.GetParentPath(path, root)` and is NOT read. The
   * first version did read it — `if (root !== '' && parent === root) return
   * root;` — which is vacuous, since that branch returns the value it was about
   * to return anyway. `dirname` already clamps at `/` (see `normalizeTracked`),
   * so there is nothing for a root to stop.
   */
  getParentPath(path: string, _root: string): string {
    return dirname(path);
  }

  /** A child of a resolved directory, with `full` rendered by the one renderer. */
  makeChildPath(parent: ResolvedPath, name: string): ResolvedPath {
    const child = parent.path === '/' ? `/${name}` : `${parent.path}/${name}`;
    return {
      drive: parent.drive,
      path: child,
      full: formatResolved(parent.drive, child),
      clampedAtRoot: false,
    };
  }

  // -- content --------------------------------------------------------------

  /**
   * The RAW text as one value.
   *
   * `Get-Content` splits a file into lines, and that split lives in the command
   * (`splitLines`, whose three measured cases include a lone `\r` separating).
   * It is not repeated here: a provider returns content, and how many objects
   * one file's content becomes is `-Raw`/`-Delimiter`/`-TotalCount`'s business.
   * The session-state providers return exactly one value for the same reason —
   * measured, `Get-Content` on an environment variable holding "a\nb" is ONE
   * item.
   */
  async getContent(path: ResolvedPath): Promise<Result<readonly PSValue[]>> {
    const text = await this.#fs.readText(this.#text(path));
    if (!text.ok) return text;
    return ok([text.value]);
  }

  async setContent(path: ResolvedPath, content: readonly PSValue[]): Promise<Result<void>> {
    const written = await this.#fs.writeText(this.#text(path), content.map(String).join('\n'));
    if (!written.ok) return written;
    return ok(undefined);
  }

  async clearContent(path: ResolvedPath): Promise<Result<void>> {
    const written = await this.#fs.writeText(this.#text(path), '');
    if (!written.ok) return written;
    return ok(undefined);
  }
}

export { basename, dirname };
