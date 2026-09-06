/**
 * The harness the fs-manage tests share.
 *
 * Not a `.test.mts` file on purpose: `tools/run-tests.mts` globs
 * `tests/**\/*.test.mts` and refuses to report success for a suite that ran
 * nothing, so a helper containing no tests must not look like one.
 *
 * THREE THINGS THIS DOES DIFFERENTLY FROM `native-harness.mts`, each for a
 * reason that is the point of these commands:
 *
 *   1. IT BUILDS THE CONTEXT BY HAND rather than going through
 *      `commandStage`. `pipeline.ts` hard-codes `fs: null, preferences: null,
 *      dialog: null` on every `InvocationContext` it makes, and `PipelineHost`
 *      has no field to carry them, so NOTHING in the repository can currently
 *      run a filesystem command through a pipeline. That is reported rather
 *      than patched here — `src/pipeline/` is shared with other work in flight.
 *
 *   2. IT USES THE REAL BROKER. `CapabilityBroker.forCommand(manifest, pid)`
 *      applies both gates — declared in the manifest, granted to the session —
 *      so "a command that declared only write cannot delete" is demonstrated
 *      against the mechanism rather than against a stub that agrees with it.
 *
 *   3. THE PORTS ARE STUBS THAT RECORD. A DialogPort that returns text, one
 *      that returns null, and one that throws are three different behaviours a
 *      command has to get right, and the third is the one nobody writes by
 *      accident.
 */

import {
  MemoryStorage,
  MountTable,
  VirtualFileSystem,
  isOk,
} from '../../src/storage/index.ts';
import type { RemoveOptions, Result, SeedSpec, StorageBackend } from '../../src/storage/index.ts';
import { brokeredFileSystem } from '../../src/commands/ports.ts';
import type { DialogPort, FileSystemPort, PreferencesPort } from '../../src/commands/ports.ts';
import { CapabilityBroker } from '../../src/kernel/capabilities.ts';
import type { AuditRecord } from '../../src/kernel/capabilities.ts';
import type {
  BindingResult,
  BoundParameters,
  CommandModule,
  InvocationContext,
} from '../../src/commands/invocation.ts';
import type { Capability } from '../../src/commands/manifest.ts';
import { collectingStreams } from '../../src/pipeline/streams.ts';
import type { ErrorRecord } from '../../src/pipeline/streams.ts';
import type { PSValue } from '../../src/pipeline/psobject.ts';
import { viewOfBehaviors } from '../../src/compatibility/profile-resolver.ts';

/** A fixed instant, so nothing in these tests reads a wall clock. */
export const TEST_EPOCH_MS = Date.parse('2026-03-04T05:06:07Z');

export const TEST_USER = 'thc1006';
export const TEST_HOME = `/home/${TEST_USER}`;

// ---------------------------------------------------------------------------
// stub ports
// ---------------------------------------------------------------------------

/** An in-memory `PreferencesPort` that records every write. */
export class StubPreferences implements PreferencesPort {
  readonly values = new Map<string, string>();
  readonly writes: { key: string; value: string }[] = [];
  /** Set to make `set` throw, which is what a full or disabled store does. */
  failure: Error | null = null;

  get(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  set(key: string, value: string): void {
    if (this.failure !== null) throw this.failure;
    this.values.set(key, value);
    this.writes.push({ key, value });
  }

  keys(): readonly string[] {
    return [...this.values.keys()];
  }
}

export interface EditRequest {
  readonly path: string;
  readonly contents: string;
  readonly editor: string;
}

export interface ConfirmRequest {
  readonly title: string;
  readonly detail: string;
}

export interface DialogBehaviour {
  /**
   * What `editText` resolves to. A STRING is a save, NULL is "the visitor quit
   * without saving", and an Error is thrown.
   */
  readonly edit?: string | null | Error | ((request: EditRequest) => string | null);
  /** What `confirm` resolves to, or an Error to throw. */
  readonly confirm?: boolean | Error;
}

/** A `DialogPort` that answers however the test says, and records what it was asked. */
export class StubDialog implements DialogPort {
  readonly edits: EditRequest[] = [];
  readonly confirms: ConfirmRequest[] = [];
  readonly #behaviour: DialogBehaviour;

  constructor(behaviour: DialogBehaviour = {}) {
    this.#behaviour = behaviour;
  }

  editText(request: EditRequest): Promise<string | null> {
    this.edits.push(request);
    const answer = this.#behaviour.edit;
    if (answer instanceof Error) return Promise.reject(answer);
    if (typeof answer === 'function') return Promise.resolve(answer(request));
    return Promise.resolve(answer ?? null);
  }

  confirm(request: ConfirmRequest): Promise<boolean> {
    this.confirms.push(request);
    const answer = this.#behaviour.confirm;
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer ?? false);
  }
}

// ---------------------------------------------------------------------------
// the filesystem
// ---------------------------------------------------------------------------

/**
 * A `VirtualFileSystem` that says when it is about to remove something.
 *
 * This is how "a recursive delete cancelled part way" is tested: the hook fires
 * inside the walk, aborts the signal, and the next node is the one the command
 * has to report as still standing. Nothing else can reach into the middle of a
 * delete — which is exactly why the walk had to be driven by the command rather
 * than left to a single atomic `remove(recursive: true)`.
 */
export class WatchedFileSystem extends VirtualFileSystem {
  onRemove: ((path: string) => void) | null = null;

  override async remove(path: string, options?: RemoveOptions): Promise<Result<void>> {
    this.onRemove?.(path);
    return super.remove(path, options);
  }
}

export interface TreeSpec {
  /** Absolute paths to create as directories, parents included. */
  readonly directories?: readonly string[];
  /** Absolute path to UTF-8 content. Parents are created. */
  readonly files?: Readonly<Record<string, string>>;
}

export interface RigOptions {
  /**
   * A seed image, installed privileged before anything else.
   *
   * Only `Reset-FileSystem` needs it: telling a file the visitor made from one
   * that came with the page is the whole basis of what it sweeps, and `origin`
   * is the only thing that carries that distinction.
   */
  readonly seed?: SeedSpec;
  readonly tree?: TreeSpec;
  readonly cwd?: string;
  /**
   * What the session grants. Undefined grants everything the command declares,
   * which is the ordinary case; a narrower set is how a denial is provoked.
   */
  readonly granted?: readonly Capability[];
  readonly dialog?: StubDialog | null;
  readonly preferences?: StubPreferences | null;
  /** Null makes `context.fs` null, which is a case every command must handle. */
  readonly withFileSystem?: boolean;
}

export interface Rig {
  readonly backend: StorageBackend;
  readonly vfs: WatchedFileSystem;
  readonly preferences: StubPreferences | null;
  readonly dialog: StubDialog | null;
  readonly abort: AbortController;
  readonly audit: readonly AuditRecord[];
  /** Everything written to stream 1. */
  readonly values: readonly PSValue[];
  readonly errors: readonly ErrorRecord[];
  readonly warnings: readonly string[];
  readonly verbose: readonly string[];
  run(module: CommandModule, bound?: Partial<BindingResult>): Promise<number>;
  read(path: string): Promise<string | null>;
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<readonly string[]>;
}

/**
 * Build a filesystem, a broker, and the three ports, and hand back something
 * that can invoke a command against them.
 *
 * `MemoryStorage` directly rather than `bootStorage`, so the tree under test is
 * exactly what the test wrote and a seed change cannot move an expectation.
 * `origin` is therefore `'user'` for everything here, which is what
 * `Reset-FileSystem` sweeps; the seeded case gets its own rig below.
 */
export async function rig(options: RigOptions = {}): Promise<Rig> {
  const backend = new MemoryStorage({
    clock: () => TEST_EPOCH_MS,
    user: TEST_USER,
    group: TEST_USER,
  });
  const vfs = new WatchedFileSystem(new MountTable(backend), {
    home: TEST_HOME,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });

  if (options.seed !== undefined) {
    // Privileged and boot-time only, exactly as `bootStorage` does it: the seed
    // is the disk image, and it exists before the visitor does.
    const installed = await backend.installImage(options.seed);
    if (!installed.ok) throw new Error(`could not install the seed: ${installed.error.message}`);
  }

  const made = await vfs.mkdir(options.cwd ?? TEST_HOME, { recursive: true });
  if (!made.ok) throw new Error(`could not make the home directory: ${made.error.message}`);

  for (const directory of options.tree?.directories ?? []) {
    const result = await vfs.mkdir(directory, { recursive: true });
    if (!result.ok) throw new Error(`could not make ${directory}: ${result.error.message}`);
  }
  for (const [path, content] of Object.entries(options.tree?.files ?? {})) {
    const result = await vfs.writeText(path, content, { createParents: true });
    if (!result.ok) throw new Error(`could not write ${path}: ${result.error.message}`);
  }

  const streams = collectingStreams();
  const abort = new AbortController();
  const preferences = options.preferences === undefined ? new StubPreferences() : options.preferences;
  const dialog = options.dialog === undefined ? null : options.dialog;
  const broker = new CapabilityBroker({
    // `undefined` here would grant nothing; the ordinary case is a session that
    // granted what the command declares, so gate 2 passes and gate 1 is what is
    // being tested.
    grants: options.granted ?? ALL_CAPABILITIES,
    clock: () => TEST_EPOCH_MS,
  });

  return {
    backend,
    vfs,
    preferences,
    dialog,
    abort,
    get audit(): readonly AuditRecord[] {
      return broker.audit.records;
    },
    get values(): readonly PSValue[] {
      return streams.collected.success.values;
    },
    get errors(): readonly ErrorRecord[] {
      return streams.collected.error.values;
    },
    get warnings(): readonly string[] {
      return streams.collected.warning.values;
    },
    get verbose(): readonly string[] {
      return streams.collected.verbose.values;
    },

    async run(module: CommandModule, bound: Partial<BindingResult> = {}): Promise<number> {
      const scoped = broker.forCommand(module.manifest, 1);
      const require = (capability: Capability): void => {
        scoped.require(capability);
      };
      const fs: FileSystemPort | null =
        options.withFileSystem === false ? null : brokeredFileSystem(vfs, require);

      const context: InvocationContext = {
        profile: viewOfBehaviors('7.6.5', {}),
        streams,
        native: null,
        input: emptyInput(),
        cwd: vfs.location.path,
        env: new Map<string, string>(),
        signal: abort.signal,
        requireCapability: require,
        fs,
        // These tests drive the WRITE and DELETE commands, none of which is
        // rewired through providers in PR-10. Null is the honest wiring, and
        // it also keeps the "no providers" branch of the rewired readers
        // covered by something other than a bespoke test.
        providers: null,
        preferences,
        dialog,
      };

      const binding: BindingResult = {
        parameters: bound.parameters ?? ({} as BoundParameters),
        parameterSet: bound.parameterSet ?? '__AllParameterSets',
        remaining: bound.remaining ?? [],
      };
      return module.invoke(context, binding);
    },

    async read(path: string): Promise<string | null> {
      const result = await vfs.readText(path);
      return result.ok ? result.value : null;
    },

    async exists(path: string): Promise<boolean> {
      return vfs.exists(path);
    },

    async list(path: string): Promise<readonly string[]> {
      const result = await vfs.readdir(path);
      return result.ok ? result.value.map((entry) => entry.name).sort() : [];
    },
  };
}

/** Every capability there is, so the default rig exercises gate 1 and not gate 2. */
const ALL_CAPABILITIES: readonly Capability[] = [
  'filesystem.read',
  'filesystem.write',
  'filesystem.delete',
  'portfolio.read',
  'preferences.write',
  'terminal.control',
  'ui.dialog',
  'process.read',
  'process.control',
  'network.fetch',
  'clipboard.read',
  'clipboard.write',
  'device.request',
  'virtual.policy.elevate',
];

async function* emptyInput(): AsyncGenerator<PSValue> {
  // Nothing. `Remove-Item` binds Path from the pipeline in pwsh; the binder
  // owns that, and none of these commands read `context.input`.
}

/** `isOk`, re-exported so the tests do not each import the storage layer. */
export { isOk };

/** The first ErrorRecord, or a readable failure. */
export function firstError(errors: readonly ErrorRecord[]): ErrorRecord {
  const record = errors[0];
  if (record === undefined) throw new Error('expected an ErrorRecord on stream 2, and there was none');
  return record;
}
