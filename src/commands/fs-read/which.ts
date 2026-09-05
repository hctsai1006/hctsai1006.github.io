/**
 * which — locate a command.
 *
 * It is a filesystem command, which is why it lives here: v1's rule looks at the
 * FILE SYSTEM FIRST and only then at the command table.
 *
 *   1. `/usr/bin/<name>` exists  ->  print that path
 *   2. otherwise, look the name up as a command (aliases included)
 *      - not found      ->  print NOTHING and exit non-zero, which is what GNU
 *                           `which` does; v1 returns null for the same reason
 *      - an Application ->  print `/usr/bin/<name>`
 *      - a cmdlet       ->  print `<name>: PowerShell cmdlet`
 *
 * Step 1 is not decoration. The seed installs `bash`, `dash`, `pwsh`, `rbash`
 * and `sh` under `/usr/bin`, and v1's own comment says the filesystem is
 * authoritative so that those five are found even though none of them is a
 * command this shell implements. A `which` that only consulted the command table
 * would report that `pwsh` does not exist on a machine whose prompt is pwsh.
 *
 * The lookup reads `manifests.json` directly rather than taking a
 * `CommandCatalogue` service, because `InvocationContext` carries no catalogue
 * and the generated file is the same data the catalogue is built from.
 * `commandTypeOf` is imported rather than reimplemented so that the
 * Cmdlet/Application judgement is made in exactly one place.
 */

import manifestsJson from '../manifests.json' with { type: 'json' };

import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import { commandTypeOf } from '../native/index.ts';
import type { CommandManifest } from '../manifest.ts';
import { emit, fsReadManifest, nativeIdentity, requirePort, stripQuotes } from './support.ts';

const MANIFEST = fsReadManifest('which');
const WHICH = nativeIdentity('which');

const EXIT_FOUND = 0;
const EXIT_NOT_FOUND = 1;

const BY_NAME: ReadonlyMap<string, CommandManifest> = new Map(
  (manifestsJson as unknown as { commands: readonly CommandManifest[] }).commands.flatMap(
    (manifest) => [
      [manifest.name.toLowerCase(), manifest] as const,
      ...manifest.aliases.map((alias) => [alias.toLowerCase(), manifest] as const),
    ],
  ),
);

export const which: CommandModule = {
  manifest: MANIFEST,

  async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
    // v1's `firstArg`: the first token that does not start with a dash. Note the
    // test is `/^-/` and not the binder's `/^-{1,2}[A-Za-z]/`, so `which -5`
    // finds nothing where the binder would have bound a negative number.
    const target = bound.remaining.map(stripQuotes).find((token) => !token.startsWith('-'));

    if (target === undefined || target === '') {
      await emit(context.streams.success, context.signal, 'Usage: which <command>');
      return EXIT_NOT_FOUND;
    }

    const name = target.toLowerCase();

    const fs = await requirePort(context, WHICH);
    if (fs === null) return EXIT_NOT_FOUND;

    const binary = `/usr/bin/${name}`;
    if (await fs.exists(binary)) {
      await emit(context.streams.success, context.signal, binary);
      return EXIT_FOUND;
    }

    const found = BY_NAME.get(name);
    // GNU which is SILENT when it finds nothing; the exit code is the answer.
    if (found === undefined) return EXIT_NOT_FOUND;

    await emit(
      context.streams.success,
      context.signal,
      commandTypeOf(found) === 'Application' ? binary : `${target}: PowerShell cmdlet`,
    );
    return EXIT_FOUND;
  },
};
