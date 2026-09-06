/**
 * The harness the filesystem-read tests share.
 *
 * Not a `.test.mts` file on purpose: `tools/run-tests.mts` refuses to report
 * success for a suite that ran nothing, so a helper that contains no tests must
 * not look like one.
 *
 * WHY THIS BUILDS ITS OWN `InvocationContext` INSTEAD OF USING `commandStage`.
 *
 * `src/pipeline/pipeline.ts` constructs the context with `fs: null`, hard-coded,
 * and so does `src/kernel/kernel.ts`. Neither takes a `FileSystemPort` from the
 * host — `PipelineHost` has no field for one. So a filesystem command run
 * through `commandStage` can only ever exercise its "there is no storage"
 * branch, and every behavioural test here would test that branch instead of the
 * command. Wiring the port through the pipeline is a change to a file this task
 * was told not to edit, so it is REPORTED rather than made, and the tests build
 * the context directly. Everything else — the stream set, the cancellation
 * signal, the profile — is the same shape `runCommand` builds.
 *
 * THE CLOCK IS FIXED. Every `LastWriteTime` expectation would otherwise move.
 */

import { MemoryStorage, MountTable, VirtualFileSystem, isErr } from '../../src/storage/index.ts';
import type { StorageError, StorageSyscall } from '../../src/storage/index.ts';
import { brokeredFileSystem } from '../../src/commands/ports.ts';
import type { FileSystemPort } from '../../src/commands/ports.ts';
import { MapSessionStateStore, installProviders } from '../../src/providers/index.ts';
import type { ProviderRegistry } from '../../src/providers/index.ts';
import { CapabilityDeniedError } from '../../src/commands/invocation.ts';
import type {
  BindingResult,
  BoundParameters,
  CommandModule,
  InvocationContext,
} from '../../src/commands/invocation.ts';
import type { Capability } from '../../src/commands/manifest.ts';
import { collectingStreams } from '../../src/pipeline/streams.ts';
import type { ErrorRecord } from '../../src/pipeline/streams.ts';
import type { PSObject, PSValue } from '../../src/pipeline/psobject.ts';
import { viewOfBehaviors } from '../../src/compatibility/profile-resolver.ts';

/** 2026-03-04T05:06:07Z, the instant the native tests already use. */
export const TEST_EPOCH_MS = Date.parse('2026-03-04T05:06:07Z');
export const HOME = '/home/thc1006';
export const USER = 'thc1006';

export interface Tree {
  /** `path -> contents`. Parent directories are created automatically. */
  readonly files?: Readonly<Record<string, string>>;
  /** Directories to create even though nothing lives in them. */
  readonly directories?: readonly string[];
  /** `path -> mode`, applied after everything exists. */
  readonly modes?: Readonly<Record<string, number>>;
}

export interface Harness {
  readonly vfs: VirtualFileSystem;
  readonly backend: MemoryStorage;
  readonly port: FileSystemPort;
  /**
   * Attached to `vfs`, so `Env:` resolves through the SAME `resolvePath` the
   * filesystem does — which is PR-10's acceptance criterion and would be
   * untested if the harness built a second drive table of its own.
   */
  readonly providers: ProviderRegistry;
}

export interface HarnessOptions {
  readonly cwd?: string;
  readonly granted?: readonly Capability[];
  /** Raise EIO from the backend on the syscalls named here. */
  readonly faultOn?: readonly StorageSyscall[];
  /** Seeds `Env:`. Empty by default, as a fresh session's environment is here. */
  readonly environment?: Readonly<Record<string, string>>;
  /** Seeds `Alias:`. The real registry's alias table in the shipped host. */
  readonly aliases?: Readonly<Record<string, string>>;
}

function unwrapOrThrow<T>(result: { ok: true; value: T } | { ok: false; error: StorageError }): T {
  if (isErr(result)) {
    throw new Error(`fixture setup failed: ${result.error.code} on ${result.error.path}`);
  }
  return result.value;
}

/** Build a filesystem, populate it, and wrap it in a broker. */
export async function harness(tree: Tree = {}, options: HarnessOptions = {}): Promise<Harness> {
  const faults = new Set(options.faultOn ?? []);
  const backend = new MemoryStorage({
    clock: () => TEST_EPOCH_MS,
    user: USER,
    group: USER,
    // Returns the CAUSE string, or null for "no fault". That is the seam
    // `storage/memory.ts` documents as the only way to produce an EIO, and EIO
    // is the one StorageError arm no probe of pwsh can reach.
    injectFault: (syscall: StorageSyscall): string | null =>
      faults.has(syscall) ? 'injected by the test harness' : null,
  });
  const vfs = new VirtualFileSystem(new MountTable(backend), {
    home: HOME,
    cwd: options.cwd ?? HOME,
  });

  unwrapOrThrow(await vfs.mkdir(HOME, { recursive: true }));
  for (const directory of tree.directories ?? []) {
    unwrapOrThrow(await vfs.mkdir(directory, { recursive: true }));
  }
  for (const [path, contents] of Object.entries(tree.files ?? {})) {
    const parent = path.slice(0, path.lastIndexOf('/')) || '/';
    unwrapOrThrow(await vfs.mkdir(parent, { recursive: true }));
    unwrapOrThrow(await vfs.writeText(path, contents));
  }
  for (const [path, mode] of Object.entries(tree.modes ?? {})) {
    unwrapOrThrow(await vfs.chmod(path, mode));
  }

  const granted = new Set<Capability>(options.granted ?? ['filesystem.read']);
  const port = brokeredFileSystem(vfs, (capability) => {
    if (!granted.has(capability)) throw new CapabilityDeniedError(capability, 'test');
  });
  const providers = installProviders(vfs, {
    fs: port,
    environment: new MapSessionStateStore(Object.entries(options.environment ?? {})),
    aliases: new MapSessionStateStore(Object.entries(options.aliases ?? {})),
  });
  return { vfs, backend, port, providers };
}

export interface RunResult {
  readonly values: readonly PSValue[];
  readonly errors: readonly ErrorRecord[];
  readonly exitCode: number;
}

export interface RunOptions {
  readonly remaining?: readonly string[];
  readonly input?: readonly PSValue[];
  /** null runs the command with no filesystem at all, which is the shipped case. */
  readonly port?: FileSystemPort | null;
  readonly providers?: ProviderRegistry | null;
  readonly signal?: AbortSignal;
  readonly cwd?: string;
  readonly granted?: readonly Capability[];
}

async function* iterate(values: readonly PSValue[]): AsyncGenerator<PSValue> {
  for (const value of values) yield value;
}

export function contextFor(options: RunOptions & { port: FileSystemPort | null }): {
  context: InvocationContext;
  streams: ReturnType<typeof collectingStreams>;
} {
  const streams = collectingStreams();
  const granted = options.granted;
  const context: InvocationContext = {
    profile: viewOfBehaviors('7.6.5', {}),
    streams,
    native: null,
    input: iterate(options.input ?? []),
    cwd: options.cwd ?? HOME,
    env: new Map<string, string>(),
    signal: options.signal ?? new AbortController().signal,
    requireCapability(capability: Capability): void {
      if (granted !== undefined && !granted.includes(capability)) {
        throw new CapabilityDeniedError(capability, 'test');
      }
    },
    fs: options.port,
    providers: options.providers ?? null,
    preferences: null,
    dialog: null,
  };
  return { context, streams };
}

export async function run(
  module: CommandModule,
  parameters: BoundParameters,
  options: RunOptions & { port: FileSystemPort | null },
): Promise<RunResult> {
  const { context, streams } = contextFor(options);
  const bound: BindingResult = {
    parameters,
    parameterSet: 'Default',
    remaining: [...(options.remaining ?? [])],
  };
  const exitCode = await module.invoke(context, bound);
  return {
    values: streams.collected.success.values,
    errors: streams.collected.error.values,
    exitCode,
  };
}

/** Read a property off an emitted object, without narrowing gymnastics. */
export function prop(value: PSValue | undefined, name: string): PSValue | undefined {
  if (value === undefined || value === null || typeof value !== 'object') return undefined;
  if (!('properties' in value)) return undefined;
  return (value as PSObject).properties[name];
}

export function has(value: PSValue | undefined, name: string): boolean {
  if (value === undefined || value === null || typeof value !== 'object') return false;
  if (!('properties' in value)) return false;
  return Object.hasOwn((value as PSObject).properties, name);
}

export function column(values: readonly PSValue[], name: string): (PSValue | undefined)[] {
  return values.map((value) => prop(value, name));
}

export function names(values: readonly PSValue[]): string[] {
  return values.map((value) => String(prop(value, 'Name') ?? value));
}

export function typeNamesOf(value: PSValue | undefined): readonly string[] {
  return value !== null && value !== undefined && typeof value === 'object' && 'typeNames' in value
    ? (value as PSObject).typeNames
    : [];
}

export function errorIds(errors: readonly ErrorRecord[]): string[] {
  return errors.map((error) => error.fullyQualifiedErrorId);
}
