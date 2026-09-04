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
 * The PathInfo for a working directory.
 *
 * Exported as a pure function so `tools/conformance.mts` can probe the same
 * code the command runs instead of a re-implementation of it.
 */
export function pathInfo(cwd: string, home = '/home/thc1006'): PSObject {
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
      await context.streams.success.write(pathInfo(context.cwd, services.machine.homeDirectory));
      return 0;
    },
  };
}
