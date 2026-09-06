/**
 * Get-Location — and the `PathInfo` a conformance case is waiting on.
 *
 * v1 printed three lines of text with a hand-drawn rule under a `Path` header.
 * pwsh emits an OBJECT, and the header is the formatter's doing:
 *
 *   (Get-Location).GetType().FullName       ->  System.Management.Automation.PathInfo
 *   (Get-Location).PSObject.TypeNames       ->  PathInfo | System.Object
 *   properties, in order                    ->  Drive, Provider, ProviderPath, Path
 *   (Get-Location).ToString()               ->  the Path
 *   Get-Location | Out-String               ->  a one-column table headed Path
 *
 * `Path` is the cwd VERBATIM. That matters more than it looks: the conformance
 * case `normalisation.cwd-is-canonicalised` compares this string after the
 * capture's machine-path rule has rewritten it to `<REPO>`, so any decoration —
 * a trailing separator, a case change, a resolved symlink — would stop the rule
 * matching and the case would fail for a reason that is not about Get-Location.
 *
 * The Drive and Provider shapes were read off pwsh 7.6.5 on Windows and carry
 * every property it reports EXCEPT the ones that would be an invention here:
 * `Used`/`Free` (no volume to measure), `Credential`, `PSSnapIn`, `Module`,
 * `HelpFile` and `Capabilities`. Omitting them is the honest half; the manifest
 * notes say so.
 */

import { psObject } from '../../pipeline/psobject.ts';
import type { PSObject } from '../../pipeline/psobject.ts';
import { providerRelativePath } from '../../providers/index.ts';
import type { ProviderRegistry } from '../../providers/index.ts';
import type { ResolvedPath } from '../../storage/index.ts';
import { throwIfCancelled } from '../../pipeline/pipeline.ts';
import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import { STRING_ARRAY, SWITCH, manifest, parameter, switchValue } from '../powershell/support.ts';

export const PATH_INFO_TYPE_NAMES: readonly string[] = [
  'System.Management.Automation.PathInfo',
  'System.Object',
];
export const PROVIDER_INFO_TYPE_NAMES: readonly string[] = [
  'System.Management.Automation.ProviderInfo',
  'System.Object',
];
export const DRIVE_INFO_TYPE_NAMES: readonly string[] = [
  'System.Management.Automation.PSDriveInfo',
  'System.Object',
];

const GET_LOCATION_MANIFEST = manifest({
  display: 'Get-Location',
  aliases: ['pwd', 'gl'],
  synopsis: 'Gets information about the current working location.',
  notes:
    'Emits a real PathInfo whose Path is the working directory verbatim, plus the ProviderInfo ' +
    'and PSDriveInfo shapes pwsh reports. Five PSDriveInfo members are deliberately absent ' +
    'rather than invented — Used, Free, Credential, MaximumSize, Description — because there is ' +
    'no volume behind this to measure, and ProviderInfo omits PSSnapIn, Module, HelpFile and ' +
    'Capabilities for the same reason. -Stack and -StackName are not implemented: there is no ' +
    'location stack until Push-Location exists.',
  parameters: [
    parameter('PSProvider', STRING_ARRAY),
    parameter('PSDrive', STRING_ARRAY),
    parameter('Stack', SWITCH),
    parameter('StackName', STRING_ARRAY),
  ],
  outputTypeNames: [
    'System.Management.Automation.PathInfo',
    'System.Management.Automation.PathInfoStack',
  ],
});

/**
 * Which separator this path speaks, and what its drive is.
 *
 * Derived from the PATH rather than from a platform constant on purpose. The
 * virtual filesystem is POSIX-shaped, but the conformance probe hands this a
 * real host path so that the capture's machine-path rule can match it, and a
 * hardcoded `/` would report a nonsense drive for `C:\Users\...`.
 */
function shapeOf(path: string): { separator: string; driveName: string; root: string } {
  const drive = /^([A-Za-z]):[\\/]/.exec(path);
  if (drive !== null) {
    const letter = drive[1] ?? 'C';
    const separator = path.includes('\\') ? '\\' : '/';
    return { separator, driveName: letter, root: `${letter}:${separator}` };
  }
  return { separator: '/', driveName: '/', root: '/' };
}

/** The FileSystem provider, as pwsh describes it. */
export function providerInfo(path: string, home: string): PSObject {
  const shape = shapeOf(path);
  return psObject(
    {
      ImplementingType: 'Microsoft.PowerShell.Commands.FileSystemProvider',
      Name: 'FileSystem',
      ModuleName: 'Microsoft.PowerShell.Core',
      Description: '',
      Home: home,
      VolumeSeparatedByColon: shape.separator === '\\',
      ItemSeparator: shape.separator,
      AltItemSeparator: shape.separator === '\\' ? '/' : '\\',
    },
    PROVIDER_INFO_TYPE_NAMES,
  );
}

/**
 * The drive. `CurrentLocation` is the path RELATIVE TO THE ROOT, which is what
 * `Users\thc1006\Desktop\MAY\wt-native` under root `C:\` showed.
 */
export function driveInfo(path: string, home: string): PSObject {
  const shape = shapeOf(path);
  const relative = path.startsWith(shape.root) ? path.slice(shape.root.length) : path;
  return psObject(
    {
      CurrentLocation: relative,
      Name: shape.driveName,
      Provider: providerInfo(path, home),
      Root: shape.root,
      DisplayRoot: '',
      VolumeSeparatedByColon: shape.separator === '\\',
    },
    DRIVE_INFO_TYPE_NAMES,
  );
}

/**
 * Where the session is standing, when that is NOT the filesystem.
 *
 * MEASURED, pwsh 7.6.5 after `Set-Location Env:` — and every field differs from
 * the filesystem's:
 *
 *   (Get-Location).Path                    Env:\  on Windows, Env:/  on Linux
 *   (Get-Location).Drive.Name              Env
 *   (Get-Location).Drive.Root              <empty>
 *   (Get-Location).Drive.CurrentLocation   <empty>
 *   (Get-Location).Provider.Name           Environment
 *   (Get-Location).Provider.Home           <empty>
 *   (Get-Location).ProviderPath            <empty>
 *   (Get-Location).Provider.ImplementingType
 *                                          Microsoft.PowerShell.Commands.EnvironmentProvider
 *
 * `ProviderPath` being EMPTY is the one that would have been invented wrongly:
 * for the filesystem it is the same string as `Path`, and the obvious
 * generalisation ("the path without the drive") happens to give the same empty
 * answer at the root but is a different rule. It is the PROVIDER-INTERNAL path,
 * which at `Env:/` is nothing at all.
 */
export interface ProviderLocation {
  readonly providerName: string;
  readonly implementingType: string;
  readonly moduleName: string;
  readonly driveName: string;
  readonly driveRoot: string;
  readonly itemSeparator: string;
  /** The path inside the provider. Empty at a session-state drive's root. */
  readonly providerPath: string;
}

/**
 * The PathInfo for a working directory.
 *
 * Exported as a pure function so `tools/conformance.mts` can probe the same
 * code the command runs instead of a re-implementation of it.
 *
 * `location` is absent for the filesystem, where `shapeOf` derives everything
 * from the path — including for the REAL host path the conformance probe hands
 * in, which no provider registry knows about.
 */
export function pathInfo(
  cwd: string,
  home = '/home/thc1006',
  location?: ProviderLocation,
): PSObject {
  if (location === undefined) {
    return psObject(
      {
        Drive: driveInfo(cwd, home),
        Provider: providerInfo(cwd, home),
        ProviderPath: cwd,
        Path: cwd,
      },
      PATH_INFO_TYPE_NAMES,
    );
  }

  const provider = psObject(
    {
      ImplementingType: location.implementingType,
      Name: location.providerName,
      ModuleName: location.moduleName,
      Description: '',
      Home: '',
      VolumeSeparatedByColon: location.itemSeparator === '\\',
      ItemSeparator: location.itemSeparator,
      AltItemSeparator: location.itemSeparator === '\\' ? '/' : '\\',
    },
    PROVIDER_INFO_TYPE_NAMES,
  );
  const drive = psObject(
    {
      CurrentLocation: location.providerPath,
      Name: location.driveName,
      Provider: provider,
      Root: location.driveRoot,
      DisplayRoot: '',
      VolumeSeparatedByColon: location.itemSeparator === '\\',
    },
    DRIVE_INFO_TYPE_NAMES,
  );
  return psObject(
    { Drive: drive, Provider: provider, ProviderPath: location.providerPath, Path: cwd },
    PATH_INFO_TYPE_NAMES,
  );
}

/**
 * Read the session's location off the registry, or null when it is on the
 * filesystem drive and `shapeOf` already answers.
 */
export function providerLocationOf(
  registry: ProviderRegistry | null,
  where: ResolvedPath | null,
): ProviderLocation | null {
  if (registry === null || where === null) return null;
  // `handles`, not `!isFileSystem`: a second STORAGE mount is still a
  // filesystem, and `shapeOf` already describes it correctly.
  if (!registry.handles(where.drive)) return null;
  const drive = registry.driveFor(where.drive);
  if (drive === null) return null;
  return {
    providerName: drive.provider.name,
    implementingType: drive.provider.implementingType,
    moduleName: drive.provider.moduleName,
    driveName: drive.name,
    driveRoot: drive.root,
    itemSeparator: drive.provider.itemSeparator,
    providerPath: providerRelativePath(where),
  };
}

export function createGetLocation(services: { readonly machine: { readonly homeDirectory: string } }): CommandModule {
  return {
    manifest: GET_LOCATION_MANIFEST,

    async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
      throwIfCancelled(context.signal, 'Get-Location');
      if (switchValue(bound.parameters, 'Stack')) {
        // pwsh emits a PathInfoStack; with nothing pushed it emits nothing at
        // all. Emitting nothing is the honest subset — inventing an empty stack
        // object would claim a feature that does not exist here.
        return 0;
      }
      // The location comes from the filesystem VIEW rather than from
      // `context.cwd`, which is a rendered string: after `Set-Location Env:` it
      // reads `Env:/`, and `shapeOf` would parse that as a filesystem path and
      // report the FileSystem provider for an environment drive. The view still
      // holds the resolved form, drive and all.
      const where = context.fs?.location ?? null;
      const location = providerLocationOf(context.providers, where);
      await context.streams.success.write(
        location === null
          ? pathInfo(context.cwd, services.machine.homeDirectory)
          : pathInfo(where?.full ?? context.cwd, services.machine.homeDirectory, location),
      );
      return 0;
    },
  };
}
