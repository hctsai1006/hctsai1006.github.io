/**
 * The harness the native command tests share.
 *
 * Not a `.test.mts` file on purpose: `tools/run-tests.mts` globs
 * `tests/**\/*.test.mts` and refuses to report success for a suite that ran
 * nothing, so a helper file that contains no tests must not look like one.
 *
 * THE CLOCK AND THE RNG ARE FIXED HERE, ONCE. No test in this directory may
 * read the wall clock or `Math.random()`, because a differential expectation
 * that moves is not an expectation. `native-registry.test.mts` asserts that by
 * scanning the sources.
 */

import { collectPipeline, commandStage, fromValues } from '../../src/pipeline/pipeline.ts';
import type { PipelineHost, PipelineStage } from '../../src/pipeline/pipeline.ts';
import { collectingStreams } from '../../src/pipeline/streams.ts';
import type { ErrorRecord } from '../../src/pipeline/streams.ts';
import type { PSObject, PSValue } from '../../src/pipeline/psobject.ts';
import { CapabilityDeniedError } from '../../src/commands/invocation.ts';
import type {
  BindingResult,
  BoundParameters,
  CommandModule,
} from '../../src/commands/invocation.ts';
import type { Capability } from '../../src/commands/manifest.ts';
import {
  SIMULATED_MACHINE,
  createNativeCommands,
  defaultCatalogue,
  fixedClock,
  historyOf,
  recordingTerminal,
  seededRandom,
} from '../../src/commands/native/index.ts';
import type { HistoryEntry, NativeServices } from '../../src/commands/native/index.ts';
import { NEW_GUID_MANIFEST } from '../../src/commands/native/index.ts';

/**
 * The instant every test in this directory uses.
 *
 * 2026-03-04T05:06:07 at +08:00 is the instant the pwsh probes were run
 * against, so every `// pwsh:` note in these files can be reproduced by
 * replaying the same probe. The offset is the capture host's, which is why
 * `%Z` is `+08` and `%s` differs from the UTC reading by 28800.
 */
export const TEST_OFFSET_MINUTES = 480;
/** The civil time the probes used, as an instant read in UTC. */
export const TEST_CIVIL = '2026-03-04T05:06:07Z';
/**
 * The INSTANT the fixed clock reports: 2026-03-03T21:06:07Z, whose local time
 * at +08:00 is the civil 2026-03-04T05:06:07 above. The two are eight hours
 * apart on purpose — a clock that reported the civil time directly would make
 * `Get-Date` answer 13:06 and every `%s` expectation would drift with it.
 */
export const TEST_EPOCH_MS = Date.parse(TEST_CIVIL) - TEST_OFFSET_MINUTES * 60_000;
export const TEST_INSTANT = new Date(TEST_EPOCH_MS).toISOString();

export const TEST_HISTORY: readonly HistoryEntry[] = [
  {
    id: 1,
    commandLine: 'Get-Date',
    executionStatus: 'Completed',
    startedAt: Date.parse('2026-01-01T00:00:00Z'),
    endedAt: Date.parse('2026-01-01T00:00:01Z'),
  },
  {
    id: 2,
    commandLine: 'Get-Location',
    executionStatus: 'Completed',
    startedAt: Date.parse('2026-01-01T00:00:02Z'),
    endedAt: Date.parse('2026-01-01T00:00:03Z'),
  },
];

export interface TestServices extends NativeServices {
  readonly terminal: ReturnType<typeof recordingTerminal>;
}

export function testServices(overrides: Partial<NativeServices> = {}): TestServices {
  const terminal = recordingTerminal();
  return {
    clock: overrides.clock ?? fixedClock(TEST_INSTANT, TEST_OFFSET_MINUTES),
    random: overrides.random ?? seededRandom(1),
    guidRandom: overrides.guidRandom ?? seededRandom(2),
    history: overrides.history ?? historyOf(TEST_HISTORY),
    terminal: (overrides.terminal as ReturnType<typeof recordingTerminal>) ?? terminal,
    machine: overrides.machine ?? SIMULATED_MACHINE,
    catalogue: overrides.catalogue ?? defaultCatalogue([NEW_GUID_MANIFEST]),
  };
}

/** Look one command module up by name out of a fresh, deterministic binding. */
export function commandsFor(overrides: Partial<NativeServices> = {}): Map<string, CommandModule> {
  const map = new Map<string, CommandModule>();
  for (const module of createNativeCommands(testServices(overrides))) {
    map.set(module.manifest.name, module);
  }
  return map;
}

export interface RunResult {
  readonly values: PSValue[];
  readonly errors: readonly ErrorRecord[];
  readonly exitCode: number;
}

export interface HostOptions {
  readonly cwd?: string;
  /** Behaviour flags the profile declares. Everything else uses the fallback. */
  readonly behaviors?: Readonly<Record<string, boolean | number | string>>;
  readonly displayVersion?: string;
  /** Capabilities the broker grants. `undefined` grants everything. */
  readonly granted?: readonly Capability[];
}

export function makeHost(options: HostOptions = {}): PipelineHost & {
  readonly errors: readonly ErrorRecord[];
} {
  const streams = collectingStreams();
  const behaviors = options.behaviors ?? {};
  const granted = options.granted;
  return {
    profile: {
      displayVersion: options.displayVersion ?? '7.6.5',
      behavior<T extends boolean | number | string>(key: string, fallback: T): T {
        const value = behaviors[key];
        return (value === undefined ? fallback : value) as T;
      },
    },
    streams,
    errors: streams.collected.error.values,
    native: null,
    cwd: options.cwd ?? '/home/thc1006',
    env: new Map<string, string>(),
    signal: new AbortController().signal,
    requireCapability(capability: Capability): void {
      if (granted !== undefined && !granted.includes(capability)) {
        throw new CapabilityDeniedError(capability, 'test');
      }
    },
  };
}

export function bind(parameters: BoundParameters): BindingResult {
  return { parameters, parameterSet: 'Default', remaining: [] };
}

export async function run(
  module: CommandModule,
  parameters: BoundParameters = {},
  input: readonly PSValue[] = [],
  options: HostOptions = {},
): Promise<RunResult> {
  const host = makeHost(options);
  const stage = commandStage(module, bind(parameters));
  const values = await collectPipeline(fromValues(input), [stage], host);
  return { values, errors: host.errors, exitCode: stage.exitCode };
}

export async function runChain(
  input: readonly PSValue[],
  steps: readonly (readonly [CommandModule, BoundParameters])[],
  options: HostOptions = {},
): Promise<RunResult> {
  const host = makeHost(options);
  const stages: PipelineStage[] = steps.map(([module, parameters]) =>
    commandStage(module, bind(parameters)),
  );
  const values = await collectPipeline(fromValues(input), stages, host);
  return { values, errors: host.errors, exitCode: stages.at(-1)?.exitCode ?? 0 };
}

/** Read a property off an emitted object, without narrowing gymnastics. */
export function prop(value: PSValue | undefined, name: string): PSValue | undefined {
  if (value === undefined || value === null || typeof value !== 'object') return undefined;
  if (!('properties' in value)) return undefined;
  return (value as PSObject).properties[name];
}

export function column(values: readonly PSValue[], name: string): (PSValue | undefined)[] {
  return values.map((value) => prop(value, name));
}

export function typeNamesOf(value: PSValue | undefined): readonly string[] {
  return value !== null && value !== undefined && typeof value === 'object' && 'typeNames' in value
    ? (value as PSObject).typeNames
    : [];
}
