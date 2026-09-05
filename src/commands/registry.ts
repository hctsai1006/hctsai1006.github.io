/**
 * registry.ts — every implemented command, in one place.
 *
 * Five subsystems each export their own `readonly CommandModule[]`, and until
 * this file existed nothing joined them: 56 implemented commands and no way to
 * resolve a name to one. Composing here rather than having each module push into
 * a shared mutable list is what let them be built in parallel without touching
 * the same file — and it is why the collision check below is a real check rather
 * than a formality, since no module can see what the others registered.
 *
 * Two invariants, both enforced at module load rather than in a test, because a
 * duplicate name is not something to discover at runtime:
 *
 *   1. No two modules may claim the same name or alias. PowerShell's namespace
 *      is flat and case-insensitive, and `?` really is `Where-Object`, so an
 *      alias collision is as bad as a name collision.
 *   2. Every implemented command must have a manifest. The manifest is where
 *      fidelity, capabilities and the required note live — the honesty surface
 *      `Get-Command` reads — so a command without one is a command a visitor
 *      cannot be told the truth about. Seven were in exactly that state before
 *      `rewrite-inventory.data.mts` existed.
 *
 * The reverse direction is NOT an error: a manifest with no implementation is
 * the work that remains, and `UNIMPLEMENTED` reports it rather than hiding it.
 */

import type { CommandModule } from './invocation.ts';
import manifests from './manifests.json' with { type: 'json' };
import { SHADOWED_V1_TOKENS } from './rewrite-inventory.data.mts';

import { OBJECT_CMDLETS } from './powershell/index.ts';
import { SIMULATED_COMMANDS } from './simulated/index.ts';
import { NATIVE_COMMANDS } from './native/index.ts';
import { PORTFOLIO_COMMANDS } from './portfolio/index.ts';
import { FORMAT_CMDLETS } from './format/index.ts';
import { FS_READ_COMMANDS } from './fs-read/index.ts';
import { FS_WRITE_COMMANDS } from './fs-write/index.ts';
import { FS_MANAGE_COMMANDS } from './fs-manage/index.ts';

/**
 * Every command with an implementation and a name to be reached by.
 *
 * A module whose token is shadowed is built and tested but not registered — see
 * SHADOWED_V1_TOKENS for which and why. `sl` is the one, and the reason stated
 * here was wrong until it was checked against v1: the claim was that v1's
 * dispatcher resolved the alias first "so the egg has never been reachable".
 * The egg fires. v1 resolves `sl` to `set-location`, and `set-location` then
 * looks at the raw word it was invoked by (legacy/terminal-v1.html:789), so
 * bare `sl` prints the train and `sl /tmp` changes directory.
 *
 * `sl` still belongs to Set-Location here, for the reason that survived the
 * correction — it is a real alias of a `native-semantic` cmdlet — but the train
 * is a v1 behaviour this rewrite has NOT reproduced rather than one it decided
 * against. It cannot be, yet: `InvocationContext` carries no invocation name,
 * so `set-location` cannot tell bare `sl` from bare `Set-Location`, and in v1
 * those differ. Filtering here rather than deleting the module keeps the
 * implementation, its tests and its captured v1 archive as the evidence of what
 * the behaviour should be when the context can express it.
 */
export const ALL_COMMANDS: readonly CommandModule[] = [
  ...OBJECT_CMDLETS,
  ...SIMULATED_COMMANDS,
  ...NATIVE_COMMANDS,
  ...PORTFOLIO_COMMANDS,
  ...FORMAT_CMDLETS,
  ...FS_READ_COMMANDS,
  ...FS_WRITE_COMMANDS,
  ...FS_MANAGE_COMMANDS,
].filter((module) => !SHADOWED_V1_TOKENS.has(module.manifest.name));

function buildIndex(): ReadonlyMap<string, CommandModule> {
  const index = new Map<string, CommandModule>();
  const collisions: string[] = [];

  for (const module of ALL_COMMANDS) {
    for (const name of [module.manifest.name, ...module.manifest.aliases]) {
      const key = name.toLowerCase();
      const existing = index.get(key);
      if (existing !== undefined) {
        collisions.push(`${key} (${existing.manifest.display} and ${module.manifest.display})`);
        continue;
      }
      index.set(key, module);
    }
  }

  if (collisions.length > 0) {
    throw new Error(
      `two commands claim the same name or alias: ${collisions.join(', ')}. ` +
        'PowerShell resolves names case-insensitively across one flat namespace, ' +
        'so whichever module loaded first would silently win.',
    );
  }
  return index;
}

/** Canonical names and every alias, lower-cased, to the module that owns them. */
export const COMMAND_INDEX: ReadonlyMap<string, CommandModule> = buildIndex();

/** Resolve a typed name. Case-insensitive, aliases included. */
export function resolveCommand(name: string): CommandModule | undefined {
  return COMMAND_INDEX.get(name.trim().toLowerCase());
}

const MANIFEST_NAMES: ReadonlySet<string> = new Set(manifests.commands.map((c) => c.name));

/** Implemented but undeclared — checked at load, because it is never acceptable. */
const undeclared = ALL_COMMANDS.map((m) => m.manifest.name).filter((n) => !MANIFEST_NAMES.has(n));
if (undeclared.length > 0) {
  throw new Error(
    `implemented commands with no manifest: ${undeclared.join(', ')}. ` +
      'Get-Command, Get-Help and the fidelity badge all read manifests.json, so a ' +
      'command without an entry there cannot be described to a visitor. Declare it ' +
      'in rewrite-inventory.data.mts and classify it.',
  );
}

/**
 * Declared but not implemented. This is the honest measure of what remains, and
 * it is exported rather than asserted away: 28 of these are waiting on the
 * filesystem commands, which the storage layer now makes possible.
 */
export const UNIMPLEMENTED: readonly string[] = manifests.commands
  .map((c) => c.name)
  .filter((n) => !COMMAND_INDEX.has(n))
  .sort();
