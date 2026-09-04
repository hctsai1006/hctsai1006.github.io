/**
 * The simulated commands, as one registry.
 *
 * `simulated` is defined in `manifest.ts` as "the output is invented or fixed,
 * and nothing outside this page is read or changed". Twenty-six commands carry
 * that label, and they are the honesty surface of the whole project: they are
 * the ones most likely to mislead a visitor, because they look exactly like the
 * real thing. `ping` prints round-trip times having sent nothing. `free`
 * reports memory the browser cannot see. `sudo` looks like the command that
 * changes what you are allowed to do.
 *
 * So every one of them carries a required `notes` field saying what it does NOT
 * do, the notes come from `classification.data.mts` by way of the generated
 * manifests, and `simulatedManifest` refuses to build a command whose manifest
 * has no note. `Get-Help` and `Get-Command -Detailed` surface it.
 *
 * WHAT IS ENFORCED HERE RATHER THAN PROMISED
 *
 *   - No command in this directory reads or writes anything outside the page.
 *     There is no `fetch`, no storage, no DOM and no timer; the only import
 *     that touches data at all is `git log`'s read of the portfolio timeline,
 *     which is a JSON module compiled into the bundle.
 *   - The three capabilities any of them declare — `process.read`,
 *     `portfolio.read`, `virtual.policy.elevate` — are requested through the
 *     broker, and nothing requests one it did not declare. The broker's first
 *     gate denies an undeclared capability even when the user granted it.
 *   - `sudo` confers nothing. It asks and carries on regardless, because a
 *     granted `virtual.policy.elevate` adds the empty set.
 *   - Everything that would otherwise vary between runs — one clock, one random
 *     generator — is injected, so the same seed prints the same fiction.
 *
 * `tests/unit/simulated.test.mts` and its siblings check each of those, and one
 * of them asserts that every command `manifests.json` classifies `simulated`
 * has an implementation here, so the set cannot drift.
 *
 * THIS FILE IS NOT THE DISPATCHER. It exports a list; composing it with the
 * object cmdlets and resolving names and aliases is the coordinator's job. Two
 * resolutions it has to make, recorded here because they are visible from the
 * manifests and nowhere else: `sl` is both a command in this list and
 * `Set-Location`'s alias (the command wins for the bare word — see `jokes.ts`),
 * and `gps` is `Get-Process`'s alias.
 */

import type { CommandModule } from '../invocation.ts';
import { defaultEnvironment } from './environment.ts';
import type { SimulatedEnvironment } from './environment.ts';
import { jokeCommands } from './jokes.ts';
import { machineCommands } from './machine.ts';
import { networkCommands } from './network.ts';
import { portfolioCommands } from './portfolio.ts';
import { privilegeCommands } from './privilege.ts';
import { processCommands } from './processes.ts';

export type { SimulatedEnvironment, PackageState } from './environment.ts';
export {
  MACHINE,
  defaultEnvironment,
  fixedEnvironment,
  freshPackageState,
  seededRandom,
} from './environment.ts';
export { SIMULATED_MANIFEST_NAMES, simulatedManifest } from './support.ts';

/**
 * Build the twenty-six modules against one environment.
 *
 * A factory rather than a module-level constant because the clock, the
 * generator and the `net-tools` flag are per-session state. Two terminals in
 * one page must not share a package flag, and a test must be able to pin the
 * clock without reaching into a global.
 */
export function createSimulatedCommands(
  environment: SimulatedEnvironment = defaultEnvironment(),
): readonly CommandModule[] {
  return [
    ...machineCommands(environment),
    ...networkCommands(environment),
    ...processCommands(),
    ...portfolioCommands(),
    ...privilegeCommands(environment),
    ...jokeCommands(),
  ];
}

/**
 * The default set, for a caller that has no opinion about the environment.
 *
 * It carries the real clock and `Math.random`, exactly as v1 did, and its own
 * package state. A caller that wants determinism or a second isolated session
 * calls `createSimulatedCommands` instead.
 */
export const SIMULATED_COMMANDS: readonly CommandModule[] = createSimulatedCommands();

/** Canonical name and every alias, lower-cased, to one module. */
export const SIMULATED_COMMAND_INDEX: ReadonlyMap<string, CommandModule> = new Map(
  SIMULATED_COMMANDS.flatMap((module) => [
    [module.manifest.name, module] as const,
    ...module.manifest.aliases.map((alias) => [alias.toLowerCase(), module] as const),
  ]),
);
