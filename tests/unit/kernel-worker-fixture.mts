/**
 * kernel-worker-fixture.mts — the kernel, assembled for a `node:worker_threads`
 * Worker. This file RUNS IN THE WORKER THREAD.
 *
 * The Node twin of `src/kernel/browser-worker.ts`, and the pair is the evidence
 * for the design claim. Put them side by side: both build a `Kernel`, register
 * command modules, and call `serveKernel` with a transport. The only lines that
 * differ are which adapter is chosen and which commands are registered.
 * `serve.ts`, `client.ts` and the protocol are untouched by the difference,
 * which is what "the transport is injected so a browser entry point is a
 * different file, not a different design" has to mean if it means anything.
 *
 * Not a `.test.mts` file, deliberately: `tools/run-tests.mts` refuses to report
 * success for a suite that ran nothing, so a fixture containing no tests must
 * not look like one.
 *
 * WHY THE COMMANDS ARE DEFINED HERE. The properties this fixture exists to
 * prove — a cyclic object surviving, a script block failing to cross, a Ctrl+C
 * interrupting real work — need commands that do those specific things, and no
 * shipped command does. The shipped registry is registered ALONGSIDE them when
 * a test asks for it (`withRegistry`, implied by `withFilesystem`), so the same
 * worker also answers `Set-Location`, `Get-Location` and `Get-Content` — and a
 * test that needs none of that does not pay to load 85 commands.
 */

import { parentPort, workerData } from 'node:worker_threads';

import type { CommandModule, InvocationContext } from '../../src/commands/invocation.ts';
import type { CommandManifest } from '../../src/commands/manifest.ts';
import { brokeredFileSystem } from '../../src/commands/ports.ts';
import { scriptBlock, scriptBlocks } from '../../src/commands/powershell/support.ts';
import { Kernel } from '../../src/kernel/kernel.ts';
import { serveKernel } from '../../src/kernel/serve.ts';
import { eventEmitterTransport } from '../../src/kernel/transport.ts';
import type { MessageEmitterLike } from '../../src/kernel/transport.ts';
import { psObject, psWrap } from '../../src/pipeline/psobject.ts';
import type { PSObject, PSValue } from '../../src/pipeline/psobject.ts';
import { MemoryStorage, MountTable, VirtualFileSystem } from '../../src/storage/index.ts';
import { HOME } from '../../src/storage/seed.ts';

if (parentPort === null) throw new Error('kernel-worker-fixture must be started as a Worker');

// ---------------------------------------------------------------------------
// commands that exist only to be observed from the other side of a postMessage
// ---------------------------------------------------------------------------

function manifest(overrides: Partial<CommandManifest>): CommandManifest {
  return {
    name: 'fixture',
    display: 'Fixture',
    aliases: [],
    runtime: 'semantic',
    fidelity: 'native-semantic',
    risk: 'read',
    capabilities: [],
    parameters: [],
    outputTypeNames: [],
    synopsis: 'A command that exists only for the worker-boundary tests.',
    parameterSource: 'none',
    implementationStatus: 'implemented',
    ...overrides,
  };
}

function command(
  name: string,
  invoke: (context: InvocationContext) => Promise<number>,
): CommandModule {
  return { manifest: manifest({ name, display: name }), invoke: (context) => invoke(context) };
}

/**
 * An object graph with a cycle AND a shared subgraph.
 *
 * Both in one value on purpose: they are the same mechanism in the sanitiser —
 * a WeakMap consulted before descending — so a test that only had a cycle
 * would pass against an implementation that returned a fresh copy per visit and
 * quietly unshared everything.
 */
function tangled(): PSObject {
  const shared = psObject({ Tag: 'shared' });
  const root = psObject({ Name: 'root', Left: shared, Right: shared });
  // Written after construction because a self-reference cannot be an argument
  // to the thing it refers to.
  (root.properties as Record<string, PSValue>)['Self'] = root;
  return root;
}

/** A bag with an OWN `__proto__` data property, built the way Select-Object does. */
function protoBag(): PSObject {
  return {
    typeNames: ['System.Management.Automation.PSCustomObject', 'System.Object'],
    properties: Object.fromEntries([
      ['__proto__', 'not a prototype'],
      ['Name', 'ordinary'],
    ] as [string, PSValue][]),
  };
}

const COMMANDS: readonly CommandModule[] = [
  // Objects the boundary is supposed to preserve exactly.
  command('emit-tangled', async (context) => {
    await context.streams.success.write(tangled());
    return 0;
  }),
  command('emit-proto-bag', async (context) => {
    await context.streams.success.write(protoBag());
    return 0;
  }),
  // A script block: a HANDLE into THIS realm's registry, and a closure that
  // stays here. What crosses is two strings.
  command('emit-script-block', async (context) => {
    await context.streams.success.write(scriptBlock((value) => value));
    return 0;
  }),
  command('emit-realm', async (context) => {
    await context.streams.success.write(scriptBlocks.realm);
    return 0;
  }),
  // A host value in `baseObject` — a closure — which the sanitiser must strip
  // before `postMessage` is ever asked to carry it.
  command('emit-host-value', async (context) => {
    await context.streams.success.write(psWrap({ Name: 'holder' }, ['Host'], () => 'a closure'));
    return 0;
  }),

  // Writes to several channels so the ONE sequence can be checked for
  // monotonicity across them after a real transport has reordered nothing.
  command('emit-interleaved', async (context) => {
    for (let i = 1; i <= 5; i += 1) {
      await context.streams.success.write(i);
      await context.streams.warning.write(`warning ${i}`);
      await context.streams.verbose.write(`verbose ${i}`);
    }
    return 0;
  }),

  // Long-running and cancellable: the only way to prove a Ctrl+C sent from the
  // host actually reaches work in progress in the worker.
  command('spin', async (context) => {
    await context.streams.success.write('started');
    await new Promise<void>((resolve) => {
      if (context.signal.aborted) {
        resolve();
        return;
      }
      context.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    context.signal.throwIfAborted();
    // Only reachable if the signal never arrived, which is the failure.
    await context.streams.success.write('finished-without-being-stopped');
    return 0;
  }),

  // Runs to completion immediately. Used to show the worker is still healthy
  // after something was refused.
  command('ping-back', async (context) => {
    await context.streams.success.write('pong');
    return 0;
  }),

  // The byte channel, which the protocol insists stays bytes: since PowerShell
  // 7.4 the raw bytes between a native command and a file survive, and a UTF-16
  // round trip through the boundary is the one thing that would undo it.
  command('emit-bytes', async (context) => {
    const out = context.native?.stdout.getWriter();
    if (out !== undefined) {
      await out.write(new Uint8Array([0, 159, 146, 150, 255]));
      out.releaseLock();
    }
    const err = context.native?.stderr.getWriter();
    if (err !== undefined) {
      await err.write(new Uint8Array([1, 2, 3]));
      err.releaseLock();
    }
    return 0;
  }),

  // The other direction: bytes sent FROM the host, read here.
  command('read-stdin', async (context) => {
    const stream = context.native?.stdin ?? null;
    if (stream === null) return 1;
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      chunks.push(chunk.value);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const joined = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      joined.set(chunk, at);
      at += chunk.length;
    }
    await context.streams.success.write(new TextDecoder().decode(joined));
    return 0;
  }),
];

// ---------------------------------------------------------------------------
// the kernel this worker serves
// ---------------------------------------------------------------------------

interface FixtureConfig {
  readonly withFilesystem?: boolean;
  /**
   * Register the whole shipped command registry as well as the fixtures.
   *
   * OFF by default, and the default is not laziness: importing the registry
   * pulls in every command and manifests.json, which is most of a worker's
   * boot. Measured at 370-800 ms per spawn, and this suite spawns one per
   * test — enough contention to make a wall-clock test elsewhere in the suite
   * flake. Implied by `withFilesystem`, which needs Set-Location and
   * Get-Content to be real.
   */
  readonly withRegistry?: boolean;
  /**
   * Make the worker misbehave, so the HOST's decoder has something to refuse.
   *
   *   'garbage' — messages the protocol does not describe, at startup.
   *   'replay'  — every real event posted a second time, so its ordinal repeats.
   *
   * A compromised worker is the case this defends against: a worker runs
   * command code, PR-14's whole subject is that some of it will be
   * third-party, and the terminal's `switch (event.kind)` is a claim about a
   * sender it does not control.
   */
  readonly misbehave?: 'garbage' | 'replay' | null;
}

const config: FixtureConfig = (workerData ?? {}) as FixtureConfig;

const backend = new MemoryStorage({ clock: () => 0, user: 'thc1006', group: 'thc1006' });
const mounts = new MountTable(backend);
const setup = new VirtualFileSystem(mounts, { home: HOME, cwd: HOME });
await setup.mkdir(`${HOME}/sub`, { recursive: true });
await setup.writeText(`${HOME}/sub/note.txt`, 'read across the boundary');

const kernel = new Kernel({
  clock: () => 1_700_000_000_000,
  grants: ['filesystem.read', 'filesystem.write'],
  ...(config.withFilesystem === true
    ? {
        // One view per session over the SHARED mount table: the same split the
        // kernel's own tests pin, exercised here through a real transport.
        openFileSystem: (session) =>
          brokeredFileSystem(
            new VirtualFileSystem(mounts, { home: HOME, cwd: session.cwd }),
            () => undefined,
          ),
      }
    : {}),
});

if (config.withRegistry === true || config.withFilesystem === true) {
  const { ALL_COMMANDS } = await import('../../src/commands/registry.ts');
  for (const module of ALL_COMMANDS) kernel.register(module);
}
for (const module of COMMANDS) kernel.register(module);

const transport = eventEmitterTransport(parentPort as unknown as MessageEmitterLike);
serveKernel(kernel, transport);

// Deliberately malformed messages, sent once at startup so the host's decoder
// meets things the protocol does not describe. The kernel is untouched by them,
// which is the other half of what the test checks.
if (config.misbehave === 'garbage') {
  transport.post({ kind: 'not-an-event-kind', seq: 1 });
  transport.post('a bare string');
  transport.post({ kind: 'exit', seq: 'one' });
  // seq 0 is reserved for "nothing emitted yet" and can never be an event's own
  // number, so this is a shape failure rather than an ordering one.
  transport.post({ kind: 'objects', seq: 0, requestId: 'r', values: [] });
}

// Every real event, posted twice. The second copy is well-formed and carries an
// ordinal the host has already seen — which is the one thing a sequence number
// exists to make detectable, and would otherwise render the same output twice.
if (config.misbehave === 'replay') {
  kernel.on((event) => {
    transport.post(event);
  });
}
