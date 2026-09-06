/**
 * The system commands, as one registry.
 *
 * Every module that needs ambient state — a clock, entropy, the session
 * history, the terminal — is a FACTORY over `NativeServices`, so a test binds a
 * fixed clock and a seeded PRNG and gets the same answer on every machine, and
 * the browser binds the real ones. `NATIVE_COMMANDS` is the default binding;
 * `createNativeCommands` is what a test and the conformance harness call.
 *
 * The coordinator composes this with `OBJECT_CMDLETS` and
 * `PORTFOLIO_COMMANDS`; nothing here edits a shared registry.
 */

import type { CommandModule } from '../invocation.ts';
import type { CommandManifest } from '../manifest.ts';
import { defaultCatalogue } from './catalogue.ts';
import { createClearHost } from './clear-host.ts';
import { createGetCommand } from './get-command.ts';
import { createGetDate } from './get-date.ts';
import { createGetHelp } from './get-help.ts';
import { createGetHistory } from './get-history.ts';
import { createGetLocation } from './get-location.ts';
import { createGetRandom } from './get-random.ts';
import { NEW_GUID_MANIFEST, createNewGuid } from './new-guid.ts';
import { createPSVersionTable } from './ps-version-table.ts';
import { outNull } from './out-null.ts';
import { quickHelp } from './quick-help.ts';
import {
  SIMULATED_MACHINE,
  historyOf,
  recordingTerminal,
  systemClock,
  systemRandom,
} from './services.ts';
import type { NativeServices } from './services.ts';
import { writeOutput } from './write-output.ts';

export * from './services.ts';
export { commandTypeOf, defaultCatalogue } from './catalogue.ts';
export {
  DATETIME_TYPE_NAMES,
  DateFormatError,
  PSDateTime,
  TIMESPAN_TYPE_NAMES,
  epochSeconds,
  formatDotNet,
  formatUnix,
  longDateTimeString,
  nowAsLocal,
  psDateTime,
  psTimeSpan,
  timeSpanText,
} from './datetime.ts';
export type { DateTimeKind, DisplayHint } from './datetime.ts';
export { createClearHost } from './clear-host.ts';
export {
  ALIAS_INFO_TYPE_NAMES,
  APPLICATION_INFO_TYPE_NAMES,
  CMDLET_INFO_TYPE_NAMES,
  FIDELITY_INFO_TYPE_NAMES,
  commandTypeNames,
  createGetCommand,
  fidelityInfo,
  syntaxOf,
} from './get-command.ts';
export { createGetDate } from './get-date.ts';
export {
  HELP_INFO_TYPE_NAMES,
  HELP_PARAMETER_TYPE_NAMES,
  createGetHelp,
  helpInfo,
  helpParameter,
  helpViewTypeNames,
} from './get-help.ts';
export { HISTORY_INFO_TYPE_NAMES, createGetHistory, historyInfo } from './get-history.ts';
export {
  DRIVE_INFO_TYPE_NAMES,
  PATH_INFO_TYPE_NAMES,
  PROVIDER_INFO_TYPE_NAMES,
  createGetLocation,
  driveInfo,
  pathInfo,
  providerLocationOf,
  providerInfo,
} from './get-location.ts';
export {
  createGetRandom,
  drawInRange,
  minGreaterThanOrEqualMaxError,
  sampleWithoutReplacement,
} from './get-random.ts';
export {
  EMPTY_GUID,
  GUID_TYPE_NAMES,
  NEW_GUID_MANIFEST,
  NEW_GUID_VERSION_KEY,
  createNewGuid,
  guidText,
  guidVersionFor,
  psGuid,
} from './new-guid.ts';
export { outNull } from './out-null.ts';
export {
  SEMANTIC_VERSION_TYPE_NAMES,
  VERSION_TABLE_TYPE_NAMES,
  VERSION_TYPE_NAMES,
  createPSVersionTable,
  gitCommitIdFor,
  psSemanticVersion,
  psVersion,
  psVersionTable,
  versionText,
} from './ps-version-table.ts';
export { HELP_TOPIC_TYPE_NAMES, quickHelp, quickStartRows } from './quick-help.ts';
export { WRITE_OUTPUT_REMAINING_ARGUMENTS, writeOutput } from './write-output.ts';

/**
 * Everything this directory implements, given a service binding.
 *
 * `New-Guid` is in the catalogue as an EXTRA: it has no entry in
 * `manifests.json`, because that file is generated from the archived v1
 * terminal's inventory and v1 had no New-Guid. Passing it in here rather than
 * editing the generated file keeps the generator the single author of that
 * file, and keeps it visible that this one command is ours.
 */
export function createNativeCommands(overrides: Partial<NativeServices> = {}): readonly CommandModule[] {
  const extras: readonly CommandManifest[] = [NEW_GUID_MANIFEST];

  const services: NativeServices = {
    clock: overrides.clock ?? systemClock(),
    random: overrides.random ?? systemRandom(),
    guidRandom: overrides.guidRandom ?? systemRandom(),
    history: overrides.history ?? historyOf([]),
    terminal: overrides.terminal ?? recordingTerminal(),
    machine: overrides.machine ?? SIMULATED_MACHINE,
    catalogue: overrides.catalogue ?? defaultCatalogue(extras),
  };

  return [
    createGetDate(services),
    createGetRandom(services),
    createNewGuid(services),
    createGetCommand(services),
    createGetHelp(services),
    createGetHistory(services),
    createGetLocation(services),
    createPSVersionTable(services),
    createClearHost(services),
    writeOutput,
    outNull,
    quickHelp,
  ];
}

/** The default registry: the real clock, real entropy, an empty history. */
export const NATIVE_COMMANDS: readonly CommandModule[] = createNativeCommands();

/** Canonical name and every alias, all lower-cased, to one module. */
export function nativeCommandIndex(
  modules: readonly CommandModule[],
): ReadonlyMap<string, CommandModule> {
  return new Map(
    modules.flatMap((module) => [
      [module.manifest.name, module] as const,
      ...module.manifest.aliases.map((alias) => [alias.toLowerCase(), module] as const),
    ]),
  );
}
