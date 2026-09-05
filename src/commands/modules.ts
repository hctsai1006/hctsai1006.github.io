/**
 * modules.ts — every command MODULE that exists, and nothing else.
 *
 * Split out of `registry.ts` so that two different questions stop sharing an
 * answer:
 *
 *   "what did somebody build?"        this file
 *   "what can a visitor type?"        registry.ts
 *
 * The split has a second, concrete purpose. `tools/generate-command-manifests.mts`
 * needs the first list in order to write what THIS engine implements into
 * `manifests.json`, and it cannot import `registry.ts` to get it: the registry
 * imports `manifests.json` and throws at load if an implemented command has no
 * entry, so regenerating a stale manifest file would fail on the staleness it
 * was being run to fix. This module imports nothing generated, which is what
 * makes it safe to read from the generator.
 *
 * Composing here rather than having each subsystem push into a shared mutable
 * list is what let the subsystems be built in parallel without touching the
 * same file — and it is why the registry's collision check is a real check
 * rather than a formality, since no subsystem can see what the others declared.
 */

import type { CommandModule } from './invocation.ts';

import { OBJECT_CMDLETS } from './powershell/index.ts';
import { SIMULATED_COMMANDS } from './simulated/index.ts';
import { NATIVE_COMMANDS } from './native/index.ts';
import { PORTFOLIO_COMMANDS } from './portfolio/index.ts';
import { FORMAT_CMDLETS } from './format/index.ts';
import { FS_READ_COMMANDS } from './fs-read/index.ts';
import { FS_WRITE_COMMANDS } from './fs-write/index.ts';
import { FS_MANAGE_COMMANDS } from './fs-manage/index.ts';

/**
 * Every module with an implementation, registered or not.
 *
 * Includes the ones held back — `partial` implementations and shadowed tokens.
 * That is the point: a module nobody can reach is still a module somebody
 * wrote and tests exercise, and hiding it here would put the honest accounting
 * of what exists behind the same filter as the accounting of what runs.
 */
export const BUILT_COMMANDS: readonly CommandModule[] = [
  ...OBJECT_CMDLETS,
  ...SIMULATED_COMMANDS,
  ...NATIVE_COMMANDS,
  ...PORTFOLIO_COMMANDS,
  ...FORMAT_CMDLETS,
  ...FS_READ_COMMANDS,
  ...FS_WRITE_COMMANDS,
  ...FS_MANAGE_COMMANDS,
];

/** Lower-cased canonical name to the module that owns it. Aliases excluded. */
export const BUILT_BY_NAME: ReadonlyMap<string, CommandModule> = new Map(
  BUILT_COMMANDS.map((module) => [module.manifest.name, module] as const),
);
