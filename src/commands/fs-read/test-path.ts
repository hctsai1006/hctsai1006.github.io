/**
 * Test-Path — does this path exist, and is it the right kind of thing?
 *
 * WHAT THE PROBE CORRECTED. `-PathType` over a wildcard is the case nobody
 * guesses right, and the answers only make sense once you see all six together:
 *
 *   directory `aa`, directory `bb`, file `root.txt`
 *
 *     pwsh: Test-Path '*'      -PathType Container  ->  False
 *     pwsh: Test-Path '*'      -PathType Leaf       ->  True
 *     pwsh: Test-Path '??'     -PathType Container  ->  True
 *     pwsh: Test-Path '??'     -PathType Leaf       ->  False
 *     pwsh: Test-Path '*.txt'  -PathType Container  ->  False
 *     pwsh: Test-Path 'zz*'    -PathType Leaf       ->  False
 *
 * `Container` is an ALL: every resolved item has to be one. `Leaf` is NOT the
 * complementary ALL — `'*'` resolves to two directories and a file and still
 * answers True. The rule that produces all six is
 *
 *     Container = something resolved AND every resolved item is a container
 *     Leaf      = something resolved AND NOT every resolved item is a container
 *
 * which is what the provider does: `Exists` is an any, `IsContainer` is an all,
 * and Leaf is `Exists && !IsContainer`. An implementation that made Leaf the
 * mirror of Container answers False for `'*'` and is wrong.
 *
 * THE OTHER TWO SURPRISES:
 *
 *   pwsh: Test-Path ''     ->  False, and NO error
 *   pwsh: Test-Path $null  ->  NullPathNotPermitted,...TestPathCommand
 *
 * An empty string is a legitimate question with the answer "no". A null is a
 * binding failure. Treating them the same — which the storage layer's own
 * `resolvePath` does, since it returns EINVAL 'empty-path' for '' — would turn a
 * routine `Test-Path $env:FOO` into an error.
 *
 * And a path whose parent is a file is simply False:
 *
 *   pwsh: Test-Path 'alpha.txt/inner.txt'  ->  False, no error
 */

import { throwIfCancelled } from '../../pipeline/pipeline.ts';
import type { FileStat } from '../../storage/index.ts';
import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import type { FileSystemPort } from '../ports.ts';
import { isBound, rawValue, stringArray, stringValue, switchValue } from '../powershell/support.ts';
import {
  TEST_PATH,
  commandError,
  emit,
  fsReadManifest,
  globPath,
  matchesAny,
  requirePort,
  storageErrorRecord,
} from './support.ts';

const MANIFEST = fsReadManifest('test-path');

type PathType = 'Any' | 'Container' | 'Leaf';

function pathTypeOf(text: string | undefined): PathType | undefined {
  if (text === undefined) return 'Any';
  const lower = text.toLowerCase();
  if (lower === 'any') return 'Any';
  if (lower === 'container') return 'Container';
  if (lower === 'leaf') return 'Leaf';
  return undefined;
}

/** `-NewerThan` / `-OlderThan` take a DateTime; a string is parsed as pwsh does. */
function toEpoch(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

export const testPath: CommandModule = {
  manifest: MANIFEST,

  async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
    const parameters = bound.parameters;

    if (isBound(parameters, 'Credential')) {
      await context.streams.error.write(
        commandError(
          TEST_PATH,
          '-Credential is not implemented. This filesystem has one user and no remote providers.',
          'ParameterNotImplemented',
          'NotImplemented',
          'System.NotImplementedException',
        ),
      );
      return 1;
    }

    const literal = stringArray(parameters, 'LiteralPath');
    const supplied = rawValue(parameters, literal === undefined ? 'Path' : 'LiteralPath');
    const paths = literal ?? stringArray(parameters, 'Path');

    if (supplied === null || paths === undefined || paths.length === 0) {
      // pwsh: Test-Path $null
      //   NullPathNotPermitted,...TestPathCommand
      //   "Value cannot be null. (Parameter 'The provided Path argument was null
      //    or an empty collection.')"
      await context.streams.error.write(
        commandError(
          TEST_PATH,
          "Value cannot be null. (Parameter 'The provided Path argument was null or an empty collection.')",
          'NullPathNotPermitted',
          'InvalidArgument',
          'System.ArgumentNullException',
        ),
      );
      return 1;
    }

    const requested = pathTypeOf(stringValue(parameters, 'PathType'));
    if (requested === undefined) {
      await context.streams.error.write(
        commandError(
          TEST_PATH,
          `Cannot bind parameter 'PathType'. Cannot convert value ` +
            `"${stringValue(parameters, 'PathType') ?? ''}" to type ` +
            '"Microsoft.PowerShell.Commands.TestPathType". Error: "Unable to match the identifier ' +
            'name to a valid enumerator name. Specify one of the following enumerator names and ' +
            'try again:\nAny, Container, Leaf"',
          'CannotConvertArgumentNoMessage',
          'InvalidArgument',
          'System.Management.Automation.ParameterBindingException',
        ),
      );
      return 1;
    }

    const fs = await requirePort(context, TEST_PATH);
    if (fs === null) return 1;

    const isValid = switchValue(parameters, 'IsValid');
    const filter = stringValue(parameters, 'Filter');
    const include = stringArray(parameters, 'Include');
    const exclude = stringArray(parameters, 'Exclude');
    const newerThan = toEpoch(rawValue(parameters, 'NewerThan'));
    const olderThan = toEpoch(rawValue(parameters, 'OlderThan'));

    for (const raw of paths) {
      throwIfCancelled(context.signal, 'Test-Path');

      // The empty-string special case. See the header.
      if (raw === '') {
        if (!(await emit(context.streams.success, context.signal, false))) return 0;
        continue;
      }

      const resolved = fs.resolve(raw);

      if (isValid) {
        // `-IsValid` asks whether the path is SYNTACTICALLY usable, without
        // touching the filesystem. On Windows that rejects `a|b<c>`; on the
        // POSIX filesystem being emulated those characters are legal in a name,
        // so the Windows measurement does NOT transfer and the question here is
        // exactly what `validatePath` answers: a NUL byte, or a component over
        // NAME_MAX, or a path over PATH_MAX.
        if (!(await emit(context.streams.success, context.signal, resolved.ok))) return 0;
        continue;
      }

      if (!resolved.ok) {
        // pwsh: Test-Path "bad`0name"
        //   ItemExistsArgumentError,...TestPathCommand, InvalidArgument,
        //   System.ArgumentException, "Null character in path. (Parameter 'path')"
        await context.streams.error.write(storageErrorRecord(TEST_PATH, resolved.error, raw));
        if (!(await emit(context.streams.success, context.signal, false))) return 0;
        continue;
      }

      const stats = await statsFor(fs, raw, literal !== undefined);
      const kept = stats.filter((stat) => {
        if (filter !== undefined && !matchesAny(stat.name, [filter])) return false;
        if (include !== undefined && !matchesAny(stat.name, include)) return false;
        if (exclude !== undefined && matchesAny(stat.name, exclude)) return false;
        if (newerThan !== undefined && stat.mtime <= newerThan) return false;
        if (olderThan !== undefined && stat.mtime >= olderThan) return false;
        return true;
      });

      const exists = kept.length > 0;
      const allContainers = exists && kept.every((stat) => stat.kind === 'directory');
      const answer =
        requested === 'Any' ? exists : requested === 'Container' ? allContainers : exists && !allContainers;

      if (!(await emit(context.streams.success, context.signal, answer))) return 0;
    }
    return 0;
  },
};

/** Every item the argument names, statted. A failure to stat is simply "absent". */
async function statsFor(
  fs: FileSystemPort,
  raw: string,
  literal: boolean,
): Promise<readonly FileStat[]> {
  const resolved = literal ? fs.resolve(raw) : await globPath(fs, raw);
  if (!resolved.ok) return [];
  const list = Array.isArray(resolved.value) ? resolved.value : [resolved.value];
  const stats: FileStat[] = [];
  for (const target of list) {
    const stat = await fs.stat(target.full);
    // A missing path, a path through a file, an unreadable parent: all "no".
    // pwsh answers False for every one of them rather than raising.
    if (stat.ok) stats.push(stat.value);
  }
  return stats;
}
