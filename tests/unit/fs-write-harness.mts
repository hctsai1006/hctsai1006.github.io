/**
 * The harness the filesystem-write tests share.
 *
 * Not a `.test.mts` file on purpose: `tools/run-tests.mts` globs
 * `tests/**\/*.test.mts` and refuses to report success for a suite that ran
 * nothing, so a helper that contains no tests must not look like one.
 *
 * WHY THIS DOES NOT USE `tests/unit/native-harness.mts`
 *
 * That harness runs a command through `commandStage`, which builds the
 * `InvocationContext` itself and sets `fs: null` unconditionally — the pipeline
 * host has no storage to hand over yet. Every test here needs a REAL
 * `FileSystemPort`, so the context is built directly and `module.invoke` is
 * called. Nothing is mocked: the storage is `MemoryStorage` behind a
 * `VirtualFileSystem` behind `brokeredFileSystem`, which is the same stack the
 * browser will run.
 *
 * THE CLOCK IS FIXED and the capacity is explicit, because a filesystem that
 * reads the wall clock cannot be tested for anything involving ordering, and a
 * quota test needs a quota it chose.
 */

import { CapabilityDeniedError } from '../../src/commands/invocation.ts';
import type {
  BoundParameters,
  CommandModule,
  InvocationContext,
} from '../../src/commands/invocation.ts';
import type { Capability } from '../../src/commands/manifest.ts';
import { brokeredFileSystem } from '../../src/commands/ports.ts';
import type { FileSystemPort } from '../../src/commands/ports.ts';
import { fromValues } from '../../src/pipeline/pipeline.ts';
import { collectingStreams } from '../../src/pipeline/streams.ts';
import type { ErrorRecord } from '../../src/pipeline/streams.ts';
import type { PSObject, PSValue } from '../../src/pipeline/psobject.ts';
import {
  MemoryStorage,
  MountTable,
  VirtualFileSystem,
  formatMode,
  isOk,
} from '../../src/storage/index.ts';
import type { FileStat, Result } from '../../src/storage/index.ts';

export const HOME = '/home/thc1006';
export const USER = 'thc1006';
/** 2026-03-04T05:06:07Z, the instant the rest of the suite already uses. */
export const FIXED_TIME = Date.parse('2026-03-04T05:06:07Z');

export interface SessionOptions {
  /** Bytes the whole filesystem may hold. Null is unlimited. */
  readonly capacity?: number | null;
  /** Capabilities the broker grants. Everything, unless named. */
  readonly granted?: readonly Capability[];
}

export interface RunOptions {
  /** Tokens the binder left over, for the coreutils that declare no parameters. */
  readonly remaining?: readonly string[];
  /** Objects arriving from a previous pipeline stage. */
  readonly input?: readonly PSValue[];
  /** Ctrl+C. Defaults to a signal that never fires. */
  readonly signal?: AbortSignal;
  /** Override the port, so a test can wrap or withhold it. */
  readonly fs?: FileSystemPort | null;
}

export interface RunResult {
  readonly values: readonly PSValue[];
  readonly errors: readonly ErrorRecord[];
  readonly exitCode: number;
}

export interface Session {
  readonly port: FileSystemPort;
  readonly vfs: VirtualFileSystem;
  run(
    module: CommandModule,
    parameters?: BoundParameters,
    options?: RunOptions,
  ): Promise<RunResult>;
  /** Read a file back as text, or throw. */
  text(path: string): Promise<string>;
  bytes(path: string): Promise<Uint8Array>;
  stat(path: string): Promise<FileStat>;
  exists(path: string): Promise<boolean>;
  /** `ls -l`-style mode, for the chmod assertions. */
  mode(path: string): Promise<string>;
  /** Every path under a root, sorted, relative to it. */
  tree(root: string): Promise<readonly string[]>;
  write(path: string, text: string): Promise<void>;
  makeDirectory(path: string): Promise<void>;
}

function unwrapped<T>(result: Result<T>, what: string): T {
  if (isOk(result)) return result.value;
  throw new Error(`${what} failed: ${result.error.code} ${result.error.message}`);
}

export async function session(options: SessionOptions = {}): Promise<Session> {
  const backend = new MemoryStorage({
    clock: () => FIXED_TIME,
    user: USER,
    group: USER,
    capacity: options.capacity ?? null,
  });
  const vfs = new VirtualFileSystem(new MountTable(backend), { home: HOME, cwd: HOME });
  const granted = options.granted;
  const port = brokeredFileSystem(vfs, (capability) => {
    if (granted !== undefined && !granted.includes(capability)) {
      throw new CapabilityDeniedError(capability, 'test');
    }
  });
  // A bare VirtualFileSystem has no tree; `bootStorage` installs the seed and
  // these tests are not about the seed.
  unwrapped(await vfs.mkdir(HOME, { recursive: true }), 'mkdir home');

  const readText = async (path: string): Promise<string> =>
    unwrapped(await vfs.readText(path), `read ${path}`);

  const walk = async (root: string, prefix: string, out: string[]): Promise<void> => {
    const entries = unwrapped(await vfs.readdir(root), `readdir ${root}`);
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const here = `${prefix}/${entry.name}`;
      out.push(entry.stat.kind === 'directory' ? `${here}/` : here);
      if (entry.stat.kind === 'directory') await walk(`${root}/${entry.name}`, here, out);
    }
  };

  return {
    port,
    vfs,

    async run(module, parameters = {}, runOptions = {}): Promise<RunResult> {
      const streams = collectingStreams();
      const context: InvocationContext = {
        profile: {
          displayVersion: '7.6.5',
          behavior<T extends boolean | number | string>(_key: string, fallback: T): T {
            return fallback;
          },
        },
        streams,
        native: null,
        input: fromValues(runOptions.input ?? []),
        cwd: HOME,
        env: new Map<string, string>(),
        signal: runOptions.signal ?? new AbortController().signal,
        requireCapability(capability: Capability): void {
          if (granted !== undefined && !granted.includes(capability)) {
            throw new CapabilityDeniedError(capability, module.manifest.display);
          }
        },
        fs: runOptions.fs === undefined ? port : runOptions.fs,
        preferences: null,
        dialog: null,
      };
      const exitCode = await module.invoke(context, {
        parameters,
        parameterSet: 'Default',
        remaining: [...(runOptions.remaining ?? [])],
      });
      return {
        values: streams.collected.success.values,
        errors: streams.collected.error.values,
        exitCode,
      };
    },

    text: readText,
    async bytes(path: string): Promise<Uint8Array> {
      return unwrapped(await vfs.readBytes(path), `readBytes ${path}`);
    },
    async stat(path: string): Promise<FileStat> {
      return unwrapped(await vfs.stat(path), `stat ${path}`);
    },
    exists: (path: string) => vfs.exists(path),
    async mode(path: string): Promise<string> {
      const stat = unwrapped(await vfs.stat(path), `stat ${path}`);
      return formatMode(stat.mode, stat.kind);
    },
    async tree(root: string): Promise<readonly string[]> {
      const out: string[] = [];
      await walk(root, '', out);
      return out;
    },
    async write(path: string, text: string): Promise<void> {
      unwrapped(await vfs.writeText(path, text, { createParents: true }), `write ${path}`);
    },
    async makeDirectory(path: string): Promise<void> {
      unwrapped(await vfs.mkdir(path, { recursive: true }), `mkdir ${path}`);
    },
  };
}

/**
 * A port that aborts the run once it has performed `limit` mutating calls.
 *
 * This is how "a write cancelled by the signal" is made DETERMINISTIC rather
 * than raced. Counting the port's own calls, instead of setting a timer, means
 * the test knows exactly how much had been written when the signal fired — and
 * the whole point of these tests is that the state after a cancellation can be
 * described.
 */
export function abortAfter(
  port: FileSystemPort,
  limit: number,
  controller: AbortController,
): FileSystemPort {
  let performed = 0;
  const tick = (): void => {
    performed += 1;
    if (performed >= limit) controller.abort();
  };
  return {
    ...port,
    get location() {
      return port.location;
    },
    async writeText(path, text, writeOptions) {
      const out = await port.writeText(path, text, writeOptions);
      tick();
      return out;
    },
    async writeBytes(path, data, writeOptions) {
      const out = await port.writeBytes(path, data, writeOptions);
      tick();
      return out;
    },
    async appendText(path, text, writeOptions) {
      const out = await port.appendText(path, text, writeOptions);
      tick();
      return out;
    },
    async mkdir(path, mkdirOptions) {
      const out = await port.mkdir(path, mkdirOptions);
      tick();
      return out;
    },
    async utimes(path, times, create) {
      const out = await port.utimes(path, times, create);
      tick();
      return out;
    },
    async rename(from, to, renameOptions) {
      const out = await port.rename(from, to, renameOptions);
      tick();
      return out;
    },
  };
}

/** Read a property off an emitted object without narrowing gymnastics. */
export function prop(value: PSValue | undefined, name: string): PSValue | undefined {
  if (value === null || value === undefined || typeof value !== 'object') return undefined;
  if (!('properties' in value)) return undefined;
  return (value as PSObject).properties[name];
}

export function typeNamesOf(value: PSValue | undefined): readonly string[] {
  return value !== null && value !== undefined && typeof value === 'object' && 'typeNames' in value
    ? (value as PSObject).typeNames
    : [];
}

/** The ids of every error a run produced, in order. */
export function errorIds(result: RunResult): readonly string[] {
  return result.errors.map((error) => error.fullyQualifiedErrorId);
}
