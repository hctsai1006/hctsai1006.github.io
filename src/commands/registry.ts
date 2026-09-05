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
import { BUILT_COMMANDS } from './modules.ts';
import { SHADOWED_V1_TOKENS } from './rewrite-inventory.data.mts';

/**
 * Why a built module is not in the session registry.
 *
 * Two reasons, and they are not the same kind of thing, so they are not one
 * flag. A shadowed token is a NAMING decision — the module works, something
 * else owns the name. A partial implementation is a CORRECTNESS decision — the
 * name is free and the module would answer to it, wrongly.
 */
export interface HeldBack {
  readonly module: CommandModule;
  readonly reason: 'shadowed-token' | 'partial-implementation';
  readonly explanation: string;
}

const heldBack: HeldBack[] = [];
const registered: CommandModule[] = [];

for (const module of BUILT_COMMANDS) {
  if (SHADOWED_V1_TOKENS.has(module.manifest.name)) {
    heldBack.push({
      module,
      reason: 'shadowed-token',
      explanation:
        `another command already owns the token "${module.manifest.name}". ` +
        'See SHADOWED_V1_TOKENS.',
    });
    continue;
  }
  const status = module.manifest.implementationStatus;
  if (status === 'partial' || status === 'declared') {
    heldBack.push({
      module,
      reason: 'partial-implementation',
      explanation:
        `${module.manifest.display} declares implementationStatus '${status}'. ` +
        'A command that would answer a visitor wrongly is worse than one that ' +
        'is not there: the wrong answer looks like a right one. See its notes.',
    });
    continue;
  }
  registered.push(module);
}

/**
 * Every command with an implementation and a name to be reached by — the
 * SESSION registry.
 *
 * Two things are filtered out, for two different reasons:
 *
 *   a SHADOWED token, where the module is fine and something else owns the
 *   name. `sl` is the one: v1 declares it both as an easter egg and as an alias
 *   of Set-Location, and its own dispatcher resolved the alias, so the egg has
 *   never been reachable.
 *
 *   a PARTIAL implementation, where the name is free and the module would take
 *   it and give a wrong answer. `Where-Object` is the one: its comparison form
 *   is thirty-one parameter sets in pwsh, and until the manifest could express
 *   them the binder chose an operator by declaration order and bound
 *   `Where-Object N -eq 2` as FilterScript=N, Property=2.
 *
 * Filtering here rather than deleting the modules keeps both decisions visible,
 * reversible, and testable — `HELD_BACK` names them and the tests import the
 * modules directly.
 */
export const ALL_COMMANDS: readonly CommandModule[] = registered;

/**
 * Built, tested, and deliberately not reachable from the prompt.
 *
 * Exported rather than dropped because "we chose not to register this, and
 * here is why" is information, and a silently absent command is
 * indistinguishable from one nobody wrote.
 */
export const HELD_BACK: readonly HeldBack[] = heldBack;

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

/**
 * Implemented but undeclared — checked at load, because it is never acceptable.
 *
 * Over BUILT_COMMANDS and not ALL_COMMANDS: a module held back from the session
 * still has to be describable. Where-Object is not registered, and
 * `Get-Command -All` and the fidelity badge must still be able to say what it
 * is and why it is unavailable.
 */
const undeclared = BUILT_COMMANDS.map((m) => m.manifest.name).filter((n) => !MANIFEST_NAMES.has(n));
if (undeclared.length > 0) {
  throw new Error(
    `implemented commands with no manifest: ${undeclared.join(', ')}. ` +
      'Get-Command, Get-Help and the fidelity badge all read manifests.json, so a ' +
      'command without an entry there cannot be described to a visitor. Declare it ' +
      'in rewrite-inventory.data.mts and classify it.',
  );
}

const BUILT_NAMES: ReadonlySet<string> = new Set(BUILT_COMMANDS.map((m) => m.manifest.name));

/**
 * Declared and NOT BUILT. The honest measure of what remains, exported rather
 * than asserted away: most of these are waiting on the filesystem commands,
 * which the storage layer now makes possible.
 *
 * Held-back modules are deliberately NOT in here. `sl` and `Where-Object` are
 * written, tested and unreachable, which is a third state — `HELD_BACK` — and
 * folding them into "nobody has written this yet" would misreport both the work
 * done and the work left. Measured before the split: this list was 28 names;
 * counting the held-back ones would have made it 30 without anyone deleting a
 * line of code.
 */
export const UNIMPLEMENTED: readonly string[] = manifests.commands
  .map((c) => c.name)
  .filter((n) => !BUILT_NAMES.has(n))
  .sort();

/**
 * Declared, built, and not reachable in this session, by name.
 *
 * The third answer the two lists above cannot give. A consumer asking "can I
 * run this?" wants COMMAND_INDEX; one asking "does this exist?" wants
 * BUILT_COMMANDS; one asking "what is missing?" wants UNIMPLEMENTED. Silence
 * about the overlap is what made `Where-Object` count as implemented.
 */
export const HELD_BACK_NAMES: readonly string[] = heldBack
  .map((entry) => entry.module.manifest.name)
  .sort();

/** Every command name a visitor can type in this session, sorted. */
export const REGISTERED_NAMES: readonly string[] = ALL_COMMANDS.map((m) => m.manifest.name).sort();
