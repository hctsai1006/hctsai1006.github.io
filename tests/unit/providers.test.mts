/**
 * The provider model, against what pwsh 7.6.5 actually did.
 *
 * EVERY DIFFERENTIAL EXPECTATION IN THIS FILE COMES OUT OF THE FIXTURE, not out
 * of a literal typed from memory. `tests/unit/fixtures/providers-pwsh-7.6.5.json`
 * is written by `tools/capture-pwsh-providers.ps1` (`npm run capture:providers`)
 * and read back here, so the suite runs with no pwsh and no network and
 * `npm run verify` stays hermetic.
 *
 * ONE FIXTURE FIELD IS PLATFORM-DEPENDENT and is handled in one place rather
 * than everywhere. `Get-Location` inside `Env:` reports `Env:\` on Windows and
 * `Env:/` on Linux, because the separator belongs to the platform. The fixture
 * records both `platform` and `itemSeparator`, so the assertions below check the
 * RULE — the location is the drive plus a colon plus the provider's separator —
 * and this engine's own answer is the Ubuntu one it emulates.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ALIAS_DESCRIPTOR,
  ENVIRONMENT_DESCRIPTOR,
  FILESYSTEM_PROVIDER_INFO,
  FUNCTION_DESCRIPTOR,
  FileSystemProvider,
  MapSessionStateStore,
  PROVIDER_NOT_SUPPORTED,
  ProviderRegistry,
  SessionStateProvider,
  VARIABLE_DESCRIPTOR,
  isContainerProvider,
  isContentProvider,
  isNavigationProvider,
  orderChildItems,
} from '../../src/providers/index.ts';
import type { PSProvider } from '../../src/providers/index.ts';
import { getChildItem, getContent, setLocation, testPath } from '../../src/commands/fs-read/index.ts';
import { storageErrorRecord } from '../../src/commands/fs-read/index.ts';
import { GET_CHILDITEM } from '../../src/commands/fs-read/support.ts';
import { createGetLocation } from '../../src/commands/native/index.ts';
import type { ResolvedPath } from '../../src/storage/index.ts';
import {
  MemoryStorage,
  MountTable,
  VirtualFileSystem,
  err,
  formatResolved,
  isOk,
} from '../../src/storage/index.ts';
import type { PSValue } from '../../src/pipeline/psobject.ts';
import { HOME, contextFor, harness, names, prop, run } from './fs-read-harness.mts';

// ---------------------------------------------------------------------------
// the fixture
// ---------------------------------------------------------------------------

interface ErrorShape {
  readonly errorId: string;
  readonly exceptionType: string;
  readonly category: string;
  readonly message: string;
}

interface Fixture {
  readonly pwsh: string;
  readonly platform: string;
  readonly providers: readonly {
    readonly name: string;
    readonly moduleName: string;
    readonly fullName: string;
    readonly capabilities: readonly string[];
  }[];
  readonly drives: readonly { readonly name: string; readonly root: string; readonly provider: string }[];
  readonly items: readonly {
    readonly path: string;
    readonly typeName: string;
    readonly psTypeNames: readonly string[];
    readonly properties: readonly string[];
    readonly psPath: string;
    readonly psIsContainer: boolean;
    readonly name: string;
  }[];
  readonly childOrder: Readonly<Record<string, readonly string[]>>;
  readonly clearSemantics: {
    readonly clearItem: Readonly<Record<string, { survives: boolean; valueIsNull: boolean | null }>>;
    readonly setEmpty: Readonly<Record<string, { survives: boolean; error: ErrorShape | null }>>;
    readonly setNull: Readonly<Record<string, { survives: boolean; error: ErrorShape | null }>>;
  };
  readonly content: readonly {
    readonly path: string;
    readonly typeName: string | null;
    readonly count: number;
    readonly asString: string;
  }[];
  readonly errors: Readonly<Record<string, ErrorShape | null>>;
  readonly contentOnRoot: ErrorShape;
  readonly testPath: readonly { path: string; pathType: string; result: boolean }[];
  readonly location: {
    readonly path: string;
    readonly driveName: string;
    readonly driveRoot: string;
    readonly providerName: string;
    readonly providerPath: string;
    readonly itemSeparator: string;
  };
  readonly flat: {
    readonly recurseIsNoOp: boolean;
    readonly literalLeafCount: number;
    readonly includeIsInert: number;
  };
  readonly dynamic: Readonly<Record<string, Readonly<Record<string, ErrorShape | null>>>>;
  readonly hiddenRule: { readonly plainCount: number; readonly forceCount: number };
  readonly pathSeam: Readonly<Record<string, string>>;
  readonly capabilityRefusal: { readonly probe: string; readonly shape: ErrorShape } | null;
}

const FIXTURE: Fixture = JSON.parse(
  readFileSync(new URL('./fixtures/providers-pwsh-7.6.5.json', import.meta.url), 'utf8'),
) as Fixture;

/** The engine emulates Ubuntu, so a provider drive renders with `/`. */
const SEPARATOR = '/';

function fixtureProvider(name: string) {
  const found = FIXTURE.providers.find((entry) => entry.name === name);
  assert.ok(found !== undefined, `the fixture has no provider named ${name}`);
  return found;
}

function fixtureDrive(name: string) {
  const found = FIXTURE.drives.find((entry) => entry.name === name);
  assert.ok(found !== undefined, `the fixture has no drive named ${name}`);
  return found;
}

/** The fixture writes Windows separators; the engine's paths use `/`. */
function asEnginePath(path: string): string {
  return path.replaceAll('\\', SEPARATOR);
}

/** A resolved path, rendered by the one renderer rather than by a template. */
const path = (drive: string, inside: string): ResolvedPath => ({
  drive,
  path: inside,
  full: formatResolved(drive, inside),
  clampedAtRoot: false,
});

/** A registry with no filesystem, for the four session-state drives alone. */
function sessionRegistry(entries: Readonly<Record<string, PSValue>> = {}): ProviderRegistry {
  return new ProviderRegistry({
    fs: null,
    environment: new MapSessionStateStore(Object.entries(entries)),
    variables: new MapSessionStateStore(Object.entries(entries)),
    functions: new MapSessionStateStore(Object.entries(entries)),
    aliases: new MapSessionStateStore(Object.entries(entries)),
  });
}

const DESCRIPTORS = {
  Env: ENVIRONMENT_DESCRIPTOR,
  Variable: VARIABLE_DESCRIPTOR,
  Function: FUNCTION_DESCRIPTOR,
  Alias: ALIAS_DESCRIPTOR,
} as const;

const DRIVE_TO_PROVIDER = {
  Env: 'Environment',
  Variable: 'Variable',
  Function: 'Function',
  Alias: 'Alias',
} as const;

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

describe('provider identity', () => {
  it('matches the reference implementation for the five providers modelled', () => {
    // The fixture also carries Registry, which exists only on Windows and is
    // not modelled here. The assertion is therefore "the five are right", not
    // "the lists are equal" — an equality would fail on Linux for a reason that
    // has nothing to do with this engine.
    const registry = sessionRegistry();
    for (const [drive, providerName] of Object.entries(DRIVE_TO_PROVIDER)) {
      const info = registry.infoFor(drive);
      assert.ok(info !== null, `${drive}: has no provider`);
      const expected = fixtureProvider(providerName);
      assert.equal(info.name, expected.name);
      assert.equal(info.moduleName, expected.moduleName);
      assert.equal(info.fullName, expected.fullName);
      assert.deepEqual([...info.capabilities], [...expected.capabilities]);
    }
    const fileSystem = fixtureProvider('FileSystem');
    assert.equal(FILESYSTEM_PROVIDER_INFO.fullName, fileSystem.fullName);
    assert.deepEqual([...FILESYSTEM_PROVIDER_INFO.capabilities], [...fileSystem.capabilities]);
  });

  it('gives every session-state drive an EMPTY root, as pwsh does', () => {
    const registry = sessionRegistry();
    for (const drive of Object.keys(DRIVE_TO_PROVIDER)) {
      assert.equal(registry.driveFor(drive)?.root, fixtureDrive(drive).root);
      assert.equal(registry.driveFor(drive)?.root, '');
    }
  });

  it('declares Filter for the filesystem alone, which is what refuses -Filter elsewhere', () => {
    const registry = sessionRegistry();
    for (const drive of Object.keys(DRIVE_TO_PROVIDER)) {
      assert.equal(registry.supports(drive, 'Filter'), false);
      assert.equal(registry.supports(drive, 'ShouldProcess'), true);
    }
    assert.ok(FILESYSTEM_PROVIDER_INFO.capabilities.includes('Filter'));
  });

  it('resolves a drive name case-insensitively and reports the canonical spelling', () => {
    const registry = sessionRegistry();
    assert.equal(registry.resolveDriveName('env'), 'Env');
    assert.equal(registry.resolveDriveName('ENV'), 'Env');
    assert.equal(registry.resolveDriveName('nope'), null);
  });
});

// ---------------------------------------------------------------------------
// the capability layers
// ---------------------------------------------------------------------------

describe('capability layers', () => {
  it('makes the four session-state providers containers but NOT navigation providers', async () => {
    // This is the distinction `Get-PSProvider` does not report — its
    // Capabilities are ShouldProcess/Filter/Credentials and say nothing about
    // hierarchy — so it is detected structurally and its consequence is
    // measured: `Set-Location Env:\PATH` reports a path that does not exist.
    const registry = sessionRegistry({ zzLeaf: 'v' });
    for (const drive of Object.keys(DRIVE_TO_PROVIDER)) {
      const provider = registry.providerFor(drive);
      assert.ok(provider !== null);
      assert.equal(isContainerProvider(provider), true, `${drive}: should be a container`);
      assert.equal(isNavigationProvider(provider), false, `${drive}: should NOT navigate`);
      assert.equal(isContentProvider(provider), true, `${drive}: should have content`);
    }
  });

  it('makes the filesystem a navigation provider', async () => {
    const { port } = await harness();
    const provider = new FileSystemProvider(port);
    assert.equal(isContainerProvider(provider), true);
    assert.equal(isNavigationProvider(provider), true);
    assert.equal(isContentProvider(provider), true);
  });

  it('treats only the drive root of a flat provider as a container', async () => {
    const registry = sessionRegistry({ zzLeaf: 'v' });
    assert.equal(await registry.isContainer(path('Env', '/')), true);
    assert.equal(await registry.isContainer(path('Env', '/zzLeaf')), false);
  });

  it('can express a refusal for a provider that implements neither layer', () => {
    // No SHIPPED provider lacks content or children, so the guards are proved
    // against a stub — the technique storage-path.test.mts already uses to show
    // the mount table takes a second backend. A capability model that cannot
    // say "I do not implement that" is not a capability model, and this is the
    // only place in the suite where the negative arm exists at all.
    const contentless: PSProvider = {
      info: ENVIRONMENT_DESCRIPTOR.info,
      defaultDrives: () => [{ name: 'Stub', root: '', provider: ENVIRONMENT_DESCRIPTOR.info }],
      getItem: async () => err({ code: 'ENOENT', path: '/', syscall: 'stat', message: 'stub' }),
      itemExists: async () => false,
      setItem: async () => err({ code: 'ENOENT', path: '/', syscall: 'write', message: 'stub' }),
      clearItem: async () => err({ code: 'ENOENT', path: '/', syscall: 'write', message: 'stub' }),
      isValidPath: () => true,
    };
    assert.equal(isContentProvider(contentless), false);
    assert.equal(isContainerProvider(contentless), false);
    assert.equal(isNavigationProvider(contentless), false);
  });
});

// ---------------------------------------------------------------------------
// items
// ---------------------------------------------------------------------------

describe('provider items', () => {
  it('gives each drive the .NET type chain pwsh reports', async () => {
    const registry = sessionRegistry({ zz: 'v' });
    const byPath = new Map(FIXTURE.items.map((item) => [item.path.split(':')[0], item]));
    for (const drive of Object.keys(DRIVE_TO_PROVIDER)) {
      const expected = byPath.get(drive);
      assert.ok(expected !== undefined, `no fixture item for ${drive}:`);
      const item = await registry.item(path(drive, '/zz'));
      assert.ok(isOk(item), `${drive}: item lookup failed`);
      const value = item.value.value;
      assert.ok(value !== null && typeof value === 'object' && 'typeNames' in value);
      assert.deepEqual([...value.typeNames], [...expected.psTypeNames]);
      assert.equal(item.value.isContainer, expected.psIsContainer);
    }
  });

  it('builds PSPath as <provider full name>::<name>, with an empty root', async () => {
    const registry = sessionRegistry({ zzItem: 'iv' });
    const item = await registry.item(path('Env', '/zzItem'));
    assert.ok(isOk(item));
    const expected = FIXTURE.items.find((row) => row.path === 'Env:zzItem');
    assert.ok(expected !== undefined);
    assert.equal(prop(item.value.value, 'PSPath'), expected.psPath);
    assert.equal(prop(item.value.value, 'PSPath'), 'Microsoft.PowerShell.Core\\Environment::zzItem');

    const root = await registry.item(path('Env', '/'));
    assert.ok(isOk(root));
    assert.equal(prop(root.value.value, 'PSPath'), 'Microsoft.PowerShell.Core\\Environment::');
  });

  it('omits PSParentPath and PSChildName, which a session-state row does not carry', async () => {
    // MEASURED: a `Get-ChildItem Env:` row's properties are
    // `PSPath PSDrive PSProvider PSIsContainer Name Key Value` — no parent, no
    // child name. The same fact at the other end of the seam:
    // `Split-Path 'Env:\zzTp' -Parent` is the EMPTY STRING.
    assert.equal(FIXTURE.pathSeam['splitParentLeaf'], '');
    const expected = FIXTURE.items.find((row) => row.path === 'Env:zzItem');
    assert.ok(expected !== undefined);
    assert.ok(!expected.properties.includes('PSParentPath'));
    assert.ok(!expected.properties.includes('PSChildName'));

    const registry = sessionRegistry({ zzItem: 'iv' });
    const item = await registry.item(path('Env', '/zzItem'));
    assert.ok(isOk(item));
    const value = item.value.value;
    assert.ok(value !== null && typeof value === 'object' && 'properties' in value);
    assert.deepEqual(Object.keys(value.properties), [...expected.properties]);
  });

  it('looks up item names case-insensitively and reports the STORED case', async () => {
    const registry = sessionRegistry({ zzCase: 'v' });
    assert.equal(await registry.itemExists(path('Env', '/ZZCASE')), true);
    const found = await registry.item(path('Env', '/ZZCASE'));
    assert.ok(isOk(found));
    assert.equal(found.value.name, 'zzCase');
  });

  it('reports a SECOND path segment as missing, not as "not a container"', async () => {
    // MEASURED: `Get-ChildItem Env:\zzLeaf\more` is PathNotFound, not ENOTDIR.
    // A flat provider has no second segment to be wrong about.
    const registry = sessionRegistry({ zzLeaf: 'v' });
    const deep = await registry.item(path('Env', '/zzLeaf/more'));
    assert.ok(!isOk(deep));
    assert.equal(deep.error.code, 'ENOENT');
  });
});

// ---------------------------------------------------------------------------
// ordering
// ---------------------------------------------------------------------------

describe('child ordering', () => {
  it('reproduces the collated order pwsh returns, in every session-state drive', async () => {
    const inserted = FIXTURE.childOrder['inserted'];
    assert.ok(inserted !== undefined);
    for (const drive of Object.keys(DRIVE_TO_PROVIDER)) {
      const expected = FIXTURE.childOrder[drive];
      assert.ok(expected !== undefined, `no fixture order for ${drive}`);
      const registry = sessionRegistry(Object.fromEntries(inserted.map((n) => [n, 'x'])));
      const children = await registry.childItems(path(drive, '/'));
      assert.ok(isOk(children));
      assert.deepEqual(
        children.value.map((item) => item.name),
        [...expected],
      );
    }
  });

  it('is NOT an ordinal sort, which is the mistake the punctuation set catches', () => {
    const inserted = FIXTURE.childOrder['inserted'];
    const expected = FIXTURE.childOrder['Env'];
    assert.ok(inserted !== undefined && expected !== undefined);
    const ordinal = [...inserted].sort();
    assert.notDeepEqual(ordinal, [...expected]);
  });

  it('uses ONE ordering implementation for provider items and directory entries', async () => {
    // The guard against the defect this PR set out to remove: the rule was
    // briefly written twice, once for ProviderItem and once for DirectoryEntry.
    const namesToSort = ['zzM', 'zzA', 'zz_u', 'zz.d', 'zz1'];
    const asItems = orderChildItems(
      namesToSort.map((name) => ({ name, isContainer: false })),
      (row) => row.name,
      (row) => row.isContainer,
    ).map((row) => row.name);
    const registry = sessionRegistry(Object.fromEntries(namesToSort.map((n) => [n, 'x'])));
    const children = await registry.childItems(path('Env', '/'));
    assert.ok(isOk(children));
    assert.deepEqual(children.value.map((item) => item.name), asItems);
  });

  it('puts directories first only where there ARE directories', async () => {
    const { port } = await harness({
      files: { [`${HOME}/b.txt`]: '', [`${HOME}/a.txt`]: '' },
      directories: [`${HOME}/zdir`],
    });
    const provider = new FileSystemProvider(port);
    const listed = await provider.getChildItems(path('/', HOME));
    assert.ok(isOk(listed));
    assert.deepEqual(
      listed.value.map((item) => item.name),
      ['zdir', 'a.txt', 'b.txt'],
    );
  });
});

// ---------------------------------------------------------------------------
// Clear-Item, Set-Item '' and Set-Item $null
// ---------------------------------------------------------------------------

describe('clearing and setting a session-state item', () => {
  it('reproduces the measured table: clearing writes null, and null means different things', async () => {
    for (const [drive, descriptor] of Object.entries(DESCRIPTORS)) {
      const expected = FIXTURE.clearSemantics.clearItem[drive];
      assert.ok(expected !== undefined, `no clearItem fixture for ${drive}`);

      const store = new MapSessionStateStore([['zz', 'x']]);
      const provider = new SessionStateProvider(descriptor, store);
      const cleared = await provider.clearItem(path(drive, '/zz'));
      assert.ok(isOk(cleared), `${drive}: Clear-Item failed`);
      assert.equal(
        await provider.itemExists(path(drive, '/zz')),
        expected.survives,
        `${drive}: Clear-Item survival`,
      );
      if (expected.valueIsNull !== null) {
        assert.equal(store.get('zz'), null, `${drive}: cleared value should be null`);
      }
    }
  });

  it('keeps the item when the value is the EMPTY STRING, which is not a null', async () => {
    for (const [drive, descriptor] of Object.entries(DESCRIPTORS)) {
      const expected = FIXTURE.clearSemantics.setEmpty[drive];
      assert.ok(expected !== undefined);
      const store = new MapSessionStateStore([['zz', 'x']]);
      const provider = new SessionStateProvider(descriptor, store);
      const written = await provider.setItem(path(drive, '/zz'), '');
      if (expected.error === null) {
        assert.ok(isOk(written), `${drive}: Set-Item '' should succeed`);
      } else {
        // MEASURED, and only Alias: does this:
        //   Set-Item Alias:x -Value '' -> Argument,...SetItemCommand, and the
        //   alias SURVIVES unchanged.
        assert.ok(!isOk(written), `${drive}: Set-Item '' should be refused`);
      }
      assert.equal(
        await provider.itemExists(path(drive, '/zz')),
        expected.survives,
        `${drive}: Set-Item '' survival`,
      );
    }
  });

  it('DELETES an environment variable set to null, and keeps a variable set to null', async () => {
    for (const drive of ['Env', 'Variable'] as const) {
      const expected = FIXTURE.clearSemantics.setNull[drive];
      assert.ok(expected !== undefined);
      const store = new MapSessionStateStore([['zz', 'x']]);
      const provider = new SessionStateProvider(DESCRIPTORS[drive], store);
      const written = await provider.setItem(path(drive, '/zz'), null);
      assert.ok(isOk(written), `${drive}: Set-Item $null should not error`);
      assert.equal(
        await provider.itemExists(path(drive, '/zz')),
        expected.survives,
        `${drive}: Set-Item $null survival`,
      );
    }
  });

  it('distinguishes Clear-CONTENT from Clear-ITEM on Env:, which is the whole surprise', async () => {
    const store = new MapSessionStateStore([['zz', 'x']]);
    const provider = new SessionStateProvider(ENVIRONMENT_DESCRIPTOR, store);
    // Clear-Content writes '', which survives...
    assert.ok(isOk(await provider.clearContent(path('Env', '/zz'))));
    assert.equal(await provider.itemExists(path('Env', '/zz')), true);
    assert.equal(store.get('zz'), '');
    // ...Clear-Item writes null, which does not.
    assert.ok(isOk(await provider.clearItem(path('Env', '/zz'))));
    assert.equal(await provider.itemExists(path('Env', '/zz')), false);
  });
});

// ---------------------------------------------------------------------------
// the write half of the interface
// ---------------------------------------------------------------------------

describe('the container operations no command reaches yet', () => {
  // `ItemProvider` and `ContainerProvider` are TOTAL: a provider has to answer
  // newItem, removeItem, renameItem and copyItem or it does not implement the
  // layer. No command in PR-10 calls them — Get-ChildItem, Get-Item,
  // Set-Location, Test-Path, Get-Content and Get-Location are all readers — so
  // without these they would ship entirely unexercised, which is how a method
  // that has never run gets its first caller in a later PR and fails there.

  it('creates, renames, copies and removes a session-state item', async () => {
    const store = new MapSessionStateStore();
    const provider = new SessionStateProvider(ENVIRONMENT_DESCRIPTOR, store);

    const made = await provider.newItem(path('Env', '/zzNew'), undefined, 'nv');
    assert.ok(isOk(made));
    assert.equal(store.get('zzNew'), 'nv');

    // MEASURED: New-Item over an existing session-state item is
    // "The item at path 'zzNewE' already exists." — EEXIST's condition.
    const again = await provider.newItem(path('Env', '/zzNew'), undefined, 'other');
    assert.ok(!isOk(again));
    assert.equal(again.error.code, 'EEXIST');

    assert.ok(isOk(await provider.renameItem(path('Env', '/zzNew'), 'zzMoved')));
    assert.equal(store.has('zzNew'), false);
    assert.equal(store.get('zzMoved'), 'nv');

    assert.ok(isOk(await provider.copyItem(path('Env', '/zzMoved'), path('Env', '/zzCopy'), false)));
    assert.equal(store.get('zzCopy'), 'nv');

    assert.ok(isOk(await provider.removeItem(path('Env', '/zzCopy'), false)));
    assert.equal(store.has('zzCopy'), false);
    const gone = await provider.removeItem(path('Env', '/zzCopy'), false);
    assert.ok(!isOk(gone));
    assert.equal(gone.error.code, 'ENOENT');
  });

  it('writes content, and reports the child names and whether there are any', async () => {
    const store = new MapSessionStateStore();
    const provider = new SessionStateProvider(ENVIRONMENT_DESCRIPTOR, store);
    assert.equal(await provider.hasChildItems(path('Env', '/')), false);

    assert.ok(isOk(await provider.setContent(path('Env', '/zzC'), ['written'])));
    assert.equal(store.get('zzC'), 'written');
    assert.equal(await provider.hasChildItems(path('Env', '/')), true);
    // A LEAF never has children, whatever is in the table.
    assert.equal(await provider.hasChildItems(path('Env', '/zzC')), false);

    const names_ = await provider.getChildNames(path('Env', '/'));
    assert.ok(isOk(names_));
    assert.deepEqual([...names_.value], ['zzC']);
  });

  it('refuses a path that cannot name an item at all', async () => {
    const provider = new SessionStateProvider(ENVIRONMENT_DESCRIPTOR, new MapSessionStateStore());
    assert.equal(provider.isValidPath(path('Env', '/one')), true);
    assert.equal(provider.isValidPath(path('Env', '/one/two')), false);
    const deep = await provider.setItem(path('Env', '/one/two'), 'v');
    assert.ok(!isOk(deep));
    assert.equal(deep.error.code, 'EINVAL');
  });

  it('creates, moves and removes through the FileSystem provider', async () => {
    const { port, vfs } = await harness({}, { granted: ['filesystem.read', 'filesystem.write', 'filesystem.delete'] });
    const provider = new FileSystemProvider(port);

    const made = await provider.newItem(path('/', `${HOME}/made.txt`), 'file', 'hello');
    assert.ok(isOk(made));
    assert.equal(made.value.isContainer, false);
    const read = await provider.getContent(path('/', `${HOME}/made.txt`));
    assert.ok(isOk(read));
    assert.deepEqual([...read.value], ['hello']);

    const dir = await provider.newItem(path('/', `${HOME}/madedir`), 'directory', null);
    assert.ok(isOk(dir));
    assert.equal(dir.value.isContainer, true);
    assert.equal(await provider.isContainer(path('/', `${HOME}/madedir`)), true);

    assert.ok(
      isOk(await provider.moveItem(path('/', `${HOME}/made.txt`), path('/', `${HOME}/moved.txt`))),
    );
    assert.equal(await provider.itemExists(path('/', `${HOME}/made.txt`)), false);
    assert.equal(await provider.itemExists(path('/', `${HOME}/moved.txt`)), true);

    assert.ok(isOk(await provider.clearContent(path('/', `${HOME}/moved.txt`))));
    const emptied = await vfs.readText(`${HOME}/moved.txt`);
    assert.ok(isOk(emptied));
    assert.equal(emptied.value, '');

    assert.ok(isOk(await provider.removeItem(path('/', `${HOME}/moved.txt`), false)));
    assert.equal(await provider.itemExists(path('/', `${HOME}/moved.txt`)), false);
  });

  it('joins and un-joins a filesystem path, and a flat provider does neither', async () => {
    const { port } = await harness();
    const provider = new FileSystemProvider(port);
    assert.equal(provider.makePath('/a', 'b'), '/a/b');
    assert.equal(provider.getParentPath('/a/b', '/'), '/a');
    // MEASURED: `Split-Path 'C:\a\b' -Parent` is `C:\a`; the root's parent is
    // the root, because dirname clamps there.
    assert.equal(provider.getParentPath('/', '/'), '/');
    // A flat provider has no parent at all, which is the same fact as
    // `Split-Path 'Env:\zzTp' -Parent` returning the empty string.
    assert.equal(FIXTURE.pathSeam['splitParentLeaf'], '');
    const flat = new SessionStateProvider(ENVIRONMENT_DESCRIPTOR, new MapSessionStateStore());
    assert.equal(isNavigationProvider(flat), false);
  });
});

// ---------------------------------------------------------------------------
// content
// ---------------------------------------------------------------------------

describe('provider content', () => {
  it('supports Get-Content on all four session-state drives, which is not the obvious answer', async () => {
    for (const row of FIXTURE.content) {
      assert.equal(row.count, 1, `${row.path}: pwsh returned one value`);
    }
    const registry = sessionRegistry({ zz: 'abc' });
    for (const drive of Object.keys(DRIVE_TO_PROVIDER)) {
      const content = await registry.content(path(drive, '/zz'));
      assert.ok(isOk(content), `${drive}: no content`);
      assert.equal(content.value.length, 1);
    }
  });

  it('does NOT split content into lines, where a file with the same bytes would be two', async () => {
    // MEASURED: an environment variable holding "a\nb" yields ONE item.
    const multiline = FIXTURE.content.find((row) => row.path === 'Env:zzMultiline');
    assert.ok(multiline !== undefined);
    assert.equal(multiline.count, 1);

    const registry = sessionRegistry({ zzMultiline: 'a\nb' });
    const content = await registry.content(path('Env', '/zzMultiline'));
    assert.ok(isOk(content));
    assert.deepEqual([...content.value], ['a\nb']);
  });

  it('yields the alias DEFINITION, as Get-Content Alias:ls does', async () => {
    const expected = FIXTURE.content.find((row) => row.path === 'Alias:zzContentA');
    assert.ok(expected !== undefined);
    assert.equal(expected.asString, 'Get-Process');
    const registry = new ProviderRegistry({
      fs: null,
      environment: new MapSessionStateStore(),
      aliases: new MapSessionStateStore([['zzContentA', 'Get-Process']]),
    });
    const content = await registry.content(path('Alias', '/zzContentA'));
    assert.ok(isOk(content));
    assert.deepEqual([...content.value], ['Get-Process']);
  });

  it('refuses content at the drive ROOT, as pwsh refuses Get-Content Env:\\', async () => {
    const registry = sessionRegistry({ zz: 'v' });
    const content = await registry.content(path('Env', '/'));
    assert.ok(!isOk(content));
    assert.equal(content.error.code, 'EINVAL');
  });
});

// ---------------------------------------------------------------------------
// one resolver
// ---------------------------------------------------------------------------

describe('one path resolver, used by every provider', () => {
  it('teaches the SAME resolver about provider drives instead of adding a second', async () => {
    // A view with nothing attached reports `Env:` as an unknown drive, which is
    // what a host without providers should say — and is what proves the drive
    // table really does come from the registry rather than from a second list
    // inside the resolver.
    const detached = new VirtualFileSystem(new MountTable(new MemoryStorage({ clock: () => 0 })), {
      home: HOME,
    });
    const unknown = detached.resolve('Env:/PATH');
    assert.ok(!isOk(unknown));
    assert.ok(unknown.error.code === 'EINVAL' && unknown.error.reason === 'unknown-drive');

    const { port } = await harness();
    const resolved = port.resolve('Env:/PATH');
    assert.ok(isOk(resolved));
    assert.equal(resolved.value.drive, 'Env');
    assert.equal(resolved.value.path, '/PATH');
    // The very same call shape for the filesystem.
    const file = port.resolve('/etc/hosts');
    assert.ok(isOk(file));
    assert.equal(file.value.drive, '/');
  });

  it('accepts /, \\ and a bare qualifier alike, and renders the platform separator', async () => {
    const { port } = await harness();
    for (const written of ['Env:/PATH', 'Env:\\PATH', 'Env:PATH']) {
      const resolved = port.resolve(written);
      assert.ok(isOk(resolved), `${written} should resolve`);
      assert.equal(resolved.value.path, '/PATH');
      assert.equal(resolved.value.full, 'Env:/PATH');
    }
  });

  it('resolves its own rendering back to itself, which is why a provider can re-enter the port', async () => {
    const { port } = await harness();
    for (const written of ['Env:/PATH', '/etc/hosts', HOME]) {
      const once = port.resolve(written);
      assert.ok(isOk(once));
      const twice = port.resolve(once.value.full);
      assert.ok(isOk(twice));
      assert.deepEqual(twice.value, once.value);
    }
  });

  it('reports an unknown drive as unknown and a real provider drive as not-a-filesystem', async () => {
    const { vfs } = await harness();
    const unknown = await vfs.stat('zzNope:/x');
    assert.ok(!isOk(unknown));
    assert.equal(unknown.error.code, 'EINVAL');

    const provider = await vfs.stat('Env:/PATH');
    assert.ok(!isOk(provider));
    assert.ok(provider.error.code === 'EINVAL' && provider.error.reason === 'not-a-filesystem-drive');
  });
});

// ---------------------------------------------------------------------------
// the rewired commands
// ---------------------------------------------------------------------------

describe('Get-ChildItem on a provider drive', () => {
  it('lists Env:/ which is the acceptance criterion', async () => {
    const { port, providers } = await harness({}, { environment: { zzB: '2', zzA: '1' } });
    const result = await run(getChildItem, { Path: ['Env:/'] }, { port, providers });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(names(result.values), ['zzA', 'zzB']);
    assert.equal(prop(result.values[0], 'Value'), '1');
    assert.equal(prop(result.values[0], 'PSProvider'), 'Microsoft.PowerShell.Core\\Environment');
  });

  it('accepts Env:, Env:\\ and Env:/ as the same drive root', async () => {
    const { port, providers } = await harness({}, { environment: { zzA: '1' } });
    for (const written of ['Env:', 'Env:\\', 'Env:/']) {
      const result = await run(getChildItem, { Path: [written] }, { port, providers });
      assert.deepEqual(result.errors, [], `${written} errored`);
      assert.deepEqual(names(result.values), ['zzA'], `${written} listed wrongly`);
    }
  });

  it('returns the LEAF ITSELF for -LiteralPath on an item, count 1', async () => {
    assert.equal(FIXTURE.flat.literalLeafCount, 1);
    const { port, providers } = await harness({}, { environment: { zzTp: 'v', other: 'o' } });
    const result = await run(getChildItem, { LiteralPath: ['Env:zzTp'] }, { port, providers });
    assert.deepEqual(result.errors, []);
    assert.equal(result.values.length, 1);
    assert.deepEqual(names(result.values), ['zzTp']);
  });

  it('treats -Recurse as a no-op on a flat drive', async () => {
    assert.equal(FIXTURE.flat.recurseIsNoOp, true);
    const { port, providers } = await harness({}, { environment: { zzA: '1', zzB: '2' } });
    const plain = await run(getChildItem, { Path: ['Env:/'] }, { port, providers });
    const recursed = await run(
      getChildItem,
      { Path: ['Env:/'], Recurse: true },
      { port, providers },
    );
    assert.deepEqual(names(recursed.values), names(plain.values));
  });

  it('expands a wildcard, and stays silent when it matches nothing', async () => {
    const { port, providers } = await harness({}, { environment: { zzA: '1', other: 'o' } });
    const hit = await run(getChildItem, { Path: ['Env:zz*'] }, { port, providers });
    assert.deepEqual(names(hit.values), ['zzA']);
    const miss = await run(getChildItem, { Path: ['Env:zzQQ*'] }, { port, providers });
    assert.deepEqual(miss.errors, []);
    assert.equal(miss.values.length, 0);
  });

  it('reports a missing item with the PROVIDER-INTERNAL path, no drive on it', async () => {
    const expected = FIXTURE.errors['getChildItemMissing'];
    assert.ok(expected !== undefined && expected !== null);
    const { port, providers } = await harness({}, { environment: { zzA: '1' } });
    const result = await run(getChildItem, { Path: ['Env:zzNoSuch'] }, { port, providers });
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]?.fullyQualifiedErrorId, expected.errorId);
    assert.equal(result.errors[0]?.message, expected.message);
    assert.equal(result.errors[0]?.exceptionType, expected.exceptionType);
  });

  it('reports a second segment as missing, echoing the internal path', async () => {
    const expected = FIXTURE.errors['getChildItemBelowLeaf'];
    assert.ok(expected !== undefined && expected !== null);
    const { port, providers } = await harness({}, { environment: { zzLeaf: 'v' } });
    const result = await run(getChildItem, { Path: ['Env:zzLeaf/more'] }, { port, providers });
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]?.message, asEnginePath(expected.message));
  });

  it('refuses the parameters the FileSystem provider supplies, each with its measured id', async () => {
    const cases = FIXTURE.dynamic['getChildItem'];
    assert.ok(cases !== undefined);
    const { port, providers } = await harness({}, { environment: { zzA: '1' } });

    for (const [parameter, shape] of Object.entries(cases)) {
      // -Attributes is refused one layer earlier, by the "this filesystem has
      // no Windows attributes" arm that predates providers; its id is this
      // engine's own and is asserted in fs-read.test.mts.
      if (parameter === 'Attributes') continue;
      const bound: Record<string, PSValue> =
        parameter === 'Depth'
          ? { Path: ['Env:/'], Depth: 1 }
          : parameter === 'Filter'
            ? { Path: ['Env:/'], Filter: 'zz*' }
            : parameter === 'Include'
              ? { Path: ['Env:/'], Include: ['zz*'] }
              : parameter === 'Exclude'
                ? { Path: ['Env:/'], Exclude: ['nope*'] }
                : { Path: ['Env:/'], [parameter]: true };
      const result = await run(getChildItem, bound, { port, providers });
      if (shape === null) {
        assert.deepEqual(result.errors, [], `-${parameter} should have been accepted`);
        continue;
      }
      assert.equal(result.errors.length, 1, `-${parameter} should have been refused`);
      assert.equal(result.errors[0]?.fullyQualifiedErrorId, shape.errorId, `-${parameter} id`);
      assert.equal(result.errors[0]?.message, shape.message, `-${parameter} message`);
      assert.equal(result.errors[0]?.exceptionType, shape.exceptionType, `-${parameter} exception`);
    }
  });

  it('does NOT hide a dot-named item, because that rule belongs to the filesystem', async () => {
    // The first version of the flat listing applied the leading-dot rule and
    // would have made `.zzDot` invisible without -Force. MEASURED: pwsh lists
    // it either way, and the counts agree.
    assert.equal(FIXTURE.hiddenRule.plainCount, 1);
    assert.equal(FIXTURE.hiddenRule.forceCount, 1);
    const { port, providers } = await harness({}, { environment: { '.zzDot': 'v' } });
    const plain = await run(getChildItem, { Path: ['Env:/'] }, { port, providers });
    assert.deepEqual(names(plain.values), ['.zzDot']);
    const forced = await run(getChildItem, { Path: ['Env:/'], Force: true }, { port, providers });
    assert.deepEqual(names(forced.values), names(plain.values));
  });

  it('still lists a SECOND STORAGE MOUNT, which is not a provider drive', async () => {
    // The regression an adversarial pass found. `MountTable` can mount another
    // backend at a made-up drive; the registry knows nothing about it. Branching
    // on "is it the filesystem drive" sent `Scratch:/` down the provider path,
    // where no provider owns it, and turned a working mount into DriveNotFound.
    // The branch asks "does the registry own this drive" instead.
    const { port, providers, vfs } = await harness();
    vfs.mounts.mount('Scratch', new MemoryStorage({ clock: () => 0 }));
    assert.ok(isOk(await vfs.writeText('Scratch:/note.txt', 'hello')));
    assert.equal(providers.handles('Scratch'), false);

    const result = await run(getChildItem, { Path: ['Scratch:/'] }, { port, providers });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(names(result.values), ['note.txt']);
  });

  it('makes -Include inert with a literal path, exactly as on the filesystem', async () => {
    assert.equal(FIXTURE.flat.includeIsInert, 0);
    const { port, providers } = await harness({}, { environment: { zzA: '1' } });
    const result = await run(
      getChildItem,
      { Path: ['Env:/'], Include: ['zz*'] },
      { port, providers },
    );
    assert.deepEqual(result.errors, []);
    assert.equal(result.values.length, 0);
  });
});

describe('Test-Path on a provider drive', () => {
  it('answers the whole measured table', async () => {
    const { port, providers } = await harness({}, { environment: { zzTp: 'v' } });
    for (const probe of FIXTURE.testPath) {
      const bound: Record<string, PSValue> =
        probe.pathType === 'Any'
          ? { Path: [probe.path] }
          : { Path: [probe.path], PathType: probe.pathType };
      const result = await run(testPath, bound, { port, providers });
      assert.deepEqual(result.errors, [], `${probe.path} (${probe.pathType}) raised`);
      assert.equal(
        result.values[0],
        probe.result,
        `Test-Path ${probe.path} -PathType ${probe.pathType}`,
      );
    }
  });

  it('refuses the FileSystem dynamic parameters with their measured ids', async () => {
    const cases = FIXTURE.dynamic['testPath'];
    assert.ok(cases !== undefined);
    const { port, providers } = await harness({}, { environment: { zzDyn: 'v' } });
    for (const [parameter, shape] of Object.entries(cases)) {
      const bound: Record<string, PSValue> = { Path: ['Env:zzDyn'] };
      if (parameter === 'Filter') bound['Filter'] = 'zz*';
      else if (parameter === 'Include') bound['Include'] = ['zz*'];
      else if (parameter === 'Exclude') bound['Exclude'] = ['nope*'];
      else if (parameter === 'NewerThan') bound['NewerThan'] = new Date('2000-01-01');
      else if (parameter === 'OlderThan') bound['OlderThan'] = new Date('2100-01-01');
      else bound[parameter] = true;

      const result = await run(testPath, bound, { port, providers });
      if (shape === null) {
        assert.deepEqual(result.errors, [], `-${parameter} should have been accepted`);
        continue;
      }
      assert.equal(result.errors.length, 1, `-${parameter} should have been refused`);
      assert.equal(result.errors[0]?.fullyQualifiedErrorId, shape.errorId, `-${parameter} id`);
      assert.equal(result.errors[0]?.message, shape.message, `-${parameter} message`);
    }
  });
});

describe('Get-Content on a provider drive', () => {
  it('emits the value as ONE object, unsplit', async () => {
    const { port, providers } = await harness({}, { environment: { zzC: 'a\nb' } });
    const result = await run(getContent, { Path: ['Env:zzC'] }, { port, providers });
    assert.deepEqual(result.errors, []);
    assert.deepEqual([...result.values], ['a\nb']);
  });

  it('refuses the FileSystem dynamic parameters with their measured ids', async () => {
    const cases = FIXTURE.dynamic['getContent'];
    assert.ok(cases !== undefined);
    const { port, providers } = await harness({}, { environment: { zzDyn: 'abc' } });
    for (const [parameter, shape] of Object.entries(cases)) {
      // -Wait is refused one layer earlier by the "no growing files" arm, which
      // predates providers and is asserted in fs-read.test.mts.
      if (parameter === 'Wait') continue;
      const bound: Record<string, PSValue> = { LiteralPath: ['Env:zzDyn'] };
      if (parameter === 'Delimiter') bound['Delimiter'] = ',';
      else if (parameter === 'Encoding') bound['Encoding'] = 'utf8';
      else if (parameter === 'ReadCount') bound['ReadCount'] = 1;
      else if (parameter === 'TotalCount') bound['TotalCount'] = 1;
      else if (parameter === 'Tail') bound['Tail'] = 1;
      else if (parameter === 'Filter') bound['Filter'] = 'zz*';
      else if (parameter === 'Include') bound['Include'] = ['zz*'];
      else if (parameter === 'Exclude') bound['Exclude'] = ['nope*'];
      else bound[parameter] = true;

      const result = await run(getContent, bound, { port, providers });
      if (shape === null) {
        assert.deepEqual(result.errors, [], `-${parameter} should have been accepted`);
        continue;
      }
      assert.equal(result.errors.length, 1, `-${parameter} should have been refused`);
      assert.equal(result.errors[0]?.fullyQualifiedErrorId, shape.errorId, `-${parameter} id`);
      assert.equal(result.errors[0]?.message, shape.message, `-${parameter} message`);
    }
  });

  it('refuses the drive ROOT with the measured Argument record, not the directory one', async () => {
    const expected = FIXTURE.contentOnRoot;
    const { port, providers } = await harness({}, { environment: { zzA: '1' } });
    const result = await run(getContent, { Path: ['Env:/'] }, { port, providers });
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]?.fullyQualifiedErrorId, expected.errorId);
    assert.equal(result.errors[0]?.message, expected.message);
    assert.equal(result.errors[0]?.exceptionType, expected.exceptionType);
  });

  it('reports a missing item with the drive-qualified path', async () => {
    const expected = FIXTURE.errors['getContentMissing'];
    assert.ok(expected !== undefined && expected !== null);
    const { port, providers } = await harness({}, { environment: { zzA: '1' } });
    const result = await run(getContent, { Path: ['Env:zzNoSuch'] }, { port, providers });
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]?.message, asEnginePath(expected.message));
  });
});

describe('Set-Location and Get-Location on a provider drive', () => {
  it('enters Env: and reports it the way the platform renders it', async () => {
    const { port, providers } = await harness({}, { environment: { zzA: '1' } });
    const moved = await run(setLocation, { Path: 'Env:' }, { port, providers });
    assert.deepEqual(moved.errors, []);
    assert.equal(port.location.full, `Env:${SEPARATOR}`);
    // The fixture's own answer follows the same rule with its own separator.
    assert.equal(FIXTURE.location.path, `Env:${FIXTURE.location.itemSeparator}`);
  });

  it('reports the Environment provider, an empty root and an empty ProviderPath', async () => {
    const { port, providers } = await harness({}, { environment: { zzA: '1' } });
    await run(setLocation, { Path: 'Env:' }, { port, providers });
    const { context, streams } = contextFor({ port, providers, cwd: port.location.full });
    await createGetLocation({ machine: { homeDirectory: HOME } }).invoke(context, {
      parameters: {},
      parameterSet: 'Default',
      remaining: [],
    });
    const info = streams.collected.success.values[0];
    assert.equal(prop(info, 'Path'), `Env:${SEPARATOR}`);
    assert.equal(prop(info, 'ProviderPath'), FIXTURE.location.providerPath);
    assert.equal(prop(prop(info, 'Provider'), 'Name'), FIXTURE.location.providerName);
    assert.equal(prop(prop(info, 'Drive'), 'Name'), FIXTURE.location.driveName);
    assert.equal(prop(prop(info, 'Drive'), 'Root'), FIXTURE.location.driveRoot);
    assert.equal(
      prop(prop(info, 'Provider'), 'ImplementingType'),
      'Microsoft.PowerShell.Commands.EnvironmentProvider',
    );
  });

  it('refuses a LEAF and echoes the path as TYPED, which is what pwsh does', async () => {
    const expected = FIXTURE.errors['setLocationLeafTyped'];
    assert.ok(expected !== undefined && expected !== null);
    const { port, providers } = await harness({}, { environment: { zzLeaf: 'lv' } });
    const result = await run(setLocation, { Path: 'Env:zzLeaf' }, { port, providers });
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]?.fullyQualifiedErrorId, expected.errorId);
    assert.equal(result.errors[0]?.message, expected.message);
    // The item EXISTS. That is the point.
    assert.equal(await providers.itemExists(path('Env', '/zzLeaf')), true);
  });

  it('reports a MISSING item with the resolved path, the other half of the same split', async () => {
    const { port, providers } = await harness({}, { environment: { zzA: '1' } });
    const result = await run(setLocation, { Path: 'Env:zzMissing' }, { port, providers });
    assert.equal(result.errors.length, 1);
    assert.equal(
      result.errors[0]?.message,
      `Cannot find path 'Env:${SEPARATOR}zzMissing' because it does not exist.`,
    );
  });

  it('reports an unknown drive as DriveNotFound', async () => {
    const expected = FIXTURE.errors['setLocationUnknown'];
    assert.ok(expected !== undefined && expected !== null);
    const { port, providers } = await harness();
    const result = await run(setLocation, { Path: 'zzNoDrive:' }, { port, providers });
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]?.fullyQualifiedErrorId, expected.errorId);
    assert.equal(result.errors[0]?.message, expected.message);
    assert.equal(result.errors[0]?.exceptionType, expected.exceptionType);
  });

  it('lists the drive from inside it, with no argument at all', async () => {
    const { port, providers } = await harness({}, { environment: { zzA: '1', zzB: '2' } });
    await run(setLocation, { Path: 'Env:' }, { port, providers });
    const listed = await run(getChildItem, {}, { port, providers });
    assert.deepEqual(listed.errors, []);
    assert.deepEqual(names(listed.values), ['zzA', 'zzB']);
  });

  it('leaves for the filesystem on cd /, which is what Linux pwsh does', async () => {
    const { port, providers } = await harness({}, { environment: { zzA: '1' } });
    await run(setLocation, { Path: 'Env:' }, { port, providers });
    const back = await run(setLocation, { Path: '/' }, { port, providers });
    assert.deepEqual(back.errors, []);
    assert.equal(port.location.full, '/');
  });
});

// ---------------------------------------------------------------------------
// the refusal shape
// ---------------------------------------------------------------------------

describe('refusing an unimplemented capability', () => {
  it('produces NotSupported naming the interface, never PathNotFound', () => {
    const shape = FIXTURE.capabilityRefusal;
    if (shape === null) {
      // Only the Registry provider can demonstrate this and only Windows has
      // one, so a fixture captured on Linux carries nothing to compare against.
      return;
    }
    const record = storageErrorRecord(
      GET_CHILDITEM,
      {
        code: 'EINVAL',
        path: 'Stub:/x',
        syscall: 'resolve',
        message: 'the IContentCmdletProvider interface is not implemented by this provider',
        reason: `${PROVIDER_NOT_SUPPORTED}:IContentCmdletProvider`,
      },
      'Stub:/x',
    );
    assert.equal(record.message, shape.shape.message);
    assert.equal(record.exceptionType, shape.shape.exceptionType);
    assert.equal(record.category, 'NotImplemented');
    assert.ok(record.fullyQualifiedErrorId.startsWith('NotSupported,'));
  });
});

