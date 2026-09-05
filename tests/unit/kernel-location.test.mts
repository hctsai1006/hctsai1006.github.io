/**
 * kernel-location.test.mts — there is ONE current directory, and it belongs to
 * the session.
 *
 * There used to be two, and they disagreed the moment `cd` worked. The kernel
 * held `TerminalState.cwd` and handed it to every process as `context.cwd`; the
 * `FileSystemPort` closed over a filesystem view with a location of its own.
 * `Set-Location` moved the view (`fs.setLocation`) and `Get-Location` read the
 * kernel's copy (`pathInfo(context.cwd, ...)`), so after a SUCCESSFUL `cd`:
 *
 *     relative paths resolved against  /home/thc1006/sub
 *     Get-Location, $PWD, Kernel.cwd   /home/thc1006
 *
 * MEASURED, through the kernel, before the fix:
 *
 *     after cd: kernel.cwd = /home/thc1006
 *     after cd: fs.location = /home/thc1006/sub
 *     processes cwd: [ '1:Set-Location:/home/thc1006',
 *                      '2:Get-Location:/home/thc1006' ]
 *
 * And because every terminal was handed a port closing over the SAME view,
 * terminal A's `cd` moved terminal B's relative-path baseline.
 *
 * The fix is a design decision and it is stated as one: share the storage
 * BACKEND, do not share the session LOCATION. One `MountTable` over one
 * backend, one `VirtualFileSystem` view per session, and the kernel reads the
 * session's view live rather than keeping a copy that can drift.
 *
 * The background rule comes from pwsh 7.6.5, measured on this machine:
 *
 *     session location          : C:\Users\...\Temp
 *     job start location        : C:\Users\...\Temp   (inherited)
 *     job after its own cd      : C:\                 (moved only itself)
 *     session location after    : C:\Users\...\Temp   (unchanged)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Kernel } from '../../src/kernel/kernel.ts';
import type { FileSystemSession } from '../../src/kernel/kernel.ts';
import type { KernelEvent } from '../../src/kernel/protocol.ts';
import { MemoryStorage, MountTable, VirtualFileSystem, isOk } from '../../src/storage/index.ts';
import { brokeredFileSystem } from '../../src/commands/ports.ts';
import type { FileSystemPort } from '../../src/commands/ports.ts';
import { ALL_COMMANDS } from '../../src/commands/registry.ts';
import type { PSObject, PSValue } from '../../src/pipeline/psobject.ts';
import { HOME } from '../../src/storage/seed.ts';

const GRANTS = ['filesystem.read', 'filesystem.write'] as const;

/**
 * One backend, one mount table, and a view factory over them.
 *
 * The MountTable is SHARED on purpose — that is the half that must be shared,
 * and a test that built one per view would prove isolation by proving the
 * sessions were looking at different filesystems.
 */
async function tree(): Promise<{
  open: (session: FileSystemSession) => FileSystemPort;
  views: VirtualFileSystem[];
}> {
  const backend = new MemoryStorage({ clock: () => 0, user: 'thc1006', group: 'thc1006' });
  const mounts = new MountTable(backend);
  const setup = new VirtualFileSystem(mounts, { home: HOME, cwd: HOME });
  await setup.mkdir(`${HOME}/sub`, { recursive: true });
  await setup.mkdir(`${HOME}/other`, { recursive: true });
  await setup.writeText(`${HOME}/sub/note.txt`, 'in sub');

  const views: VirtualFileSystem[] = [];
  return {
    views,
    open: (session) => {
      const view = new VirtualFileSystem(mounts, { home: HOME, cwd: session.cwd });
      views.push(view);
      return brokeredFileSystem(view, () => undefined);
    },
  };
}

function newKernel(options: ConstructorParameters<typeof Kernel>[0]): {
  kernel: Kernel;
  events: KernelEvent[];
} {
  const kernel = new Kernel({ clock: () => 1_700_000_000_000, grants: GRANTS, ...options });
  for (const module of ALL_COMMANDS) kernel.register(module);
  const events: KernelEvent[] = [];
  kernel.on((event) => events.push(event));
  return { kernel, events };
}

let nextRequest = 0;
async function run(
  kernel: Kernel,
  terminalId: string,
  source: string,
  background = false,
): Promise<void> {
  nextRequest += 1;
  kernel.send({
    kind: 'exec',
    requestId: `r${nextRequest}`,
    terminalId,
    source,
    background,
  });
  await kernel.drain();
}

/** The `Path` of the last PathInfo emitted. What `Get-Location` printed. */
function lastPath(events: readonly KernelEvent[]): string | undefined {
  const values = events
    .filter((event) => event.kind === 'objects')
    .flatMap((event) => [...event.values]) as PSValue[];
  const last = values[values.length - 1];
  if (last === null || typeof last !== 'object' || Array.isArray(last)) return undefined;
  const path = (last as PSObject).properties['Path'];
  return typeof path === 'string' ? path : undefined;
}

describe('after a cd, every reader agrees', () => {
  it('moves Kernel.cwd, $PWD, the next snapshot, Get-Location and relative resolution together', async () => {
    const { open } = await tree();
    const { kernel, events } = newKernel({ openFileSystem: open });

    await run(kernel, 't1', 'Set-Location sub');

    // 1. the kernel
    assert.equal(kernel.cwd('t1'), `${HOME}/sub`);

    // 2. the event a terminal renders its prompt from
    const changed = events.filter((e) => e.kind === 'cwd-changed');
    assert.equal(changed.length, 1);
    assert.equal(changed[0]?.cwd, `${HOME}/sub`);

    // 3. Get-Location, which reads the process's own cwd
    const before = events.length;
    await run(kernel, 't1', 'Get-Location');
    assert.equal(lastPath(events.slice(before)), `${HOME}/sub`);

    // 4. the next process's snapshot, which is what a task manager shows
    const snapshot = events
      .filter((e) => e.kind === 'process-changed')
      .map((e) => e.snapshot)
      .find((s) => s.name === 'Get-Location');
    assert.equal(snapshot?.cwd, `${HOME}/sub`);

    // 5. relative resolution, which is the reader that used to be alone in
    //    being right
    const listed = events.length;
    await run(kernel, 't1', 'Get-Content note.txt');
    const text = events
      .slice(listed)
      .filter((e) => e.kind === 'objects')
      .flatMap((e) => [...e.values]);
    assert.deepEqual(text, ['in sub'], 'a relative path resolved against the new directory');
  });

  it('reports the move once, and says nothing when nothing moved', async () => {
    const { open } = await tree();
    const { kernel, events } = newKernel({ openFileSystem: open });

    await run(kernel, 't1', 'Set-Location sub');
    await run(kernel, 't1', 'Get-Location');
    await run(kernel, 't1', 'Set-Location .');

    assert.equal(events.filter((e) => e.kind === 'cwd-changed').length, 1);
  });
});

describe('two terminals share the files and not the location', () => {
  it('leaves the other terminal where it was', async () => {
    const { open } = await tree();
    const { kernel } = newKernel({ openFileSystem: open });

    await run(kernel, 't1', 'Get-Location');
    await run(kernel, 't2', 'Get-Location');
    assert.equal(kernel.cwd('t1'), HOME);
    assert.equal(kernel.cwd('t2'), HOME);

    await run(kernel, 't1', 'Set-Location sub');

    assert.equal(kernel.cwd('t1'), `${HOME}/sub`);
    assert.equal(kernel.cwd('t2'), HOME, 'one terminal must not move another');
  });

  it('does not move the other terminal’s relative-path baseline', async () => {
    const { open } = await tree();
    const { kernel, events } = newKernel({ openFileSystem: open });

    await run(kernel, 't1', 'Set-Location sub');

    // The same command line, typed in the other pane, must still fail to find
    // a file that only exists inside sub.
    const before = events.length;
    await run(kernel, 't2', 'Get-Content note.txt');
    const errors = events.slice(before).filter((e) => e.kind === 'stream' && e.which === 'error');
    assert.equal(errors.length, 1, 't2 is still in the home directory');
  });

  it('still shares every file, which is the half that MUST be shared', async () => {
    const { open } = await tree();
    const { kernel, events } = newKernel({ openFileSystem: open });

    await run(kernel, 't1', 'Set-Location sub');
    await run(kernel, 't1', 'Set-Content -Path fresh.txt -Value written-by-t1');

    const before = events.length;
    await run(kernel, 't2', `Get-Content ${HOME}/sub/fresh.txt`);
    const read = events
      .slice(before)
      .filter((e) => e.kind === 'objects')
      .flatMap((e) => [...e.values]);
    assert.deepEqual(read, ['written-by-t1'], 'one backend, two views');
  });

  it('emits cwd-changed for the terminal that moved, and only that one', async () => {
    const { open } = await tree();
    const { kernel, events } = newKernel({ openFileSystem: open });

    await run(kernel, 't2', 'Get-Location');
    await run(kernel, 't1', 'Set-Location sub');
    await run(kernel, 't2', 'Get-Location');

    const changed = events.filter((e) => e.kind === 'cwd-changed');
    assert.deepEqual(changed.map((e) => e.terminalId), ['t1']);
  });
});

describe('a background job keeps the location it started with', () => {
  it('starts where the terminal was and does not take it with it', async () => {
    // Measured in pwsh 7.6.5: a job inherits the session's location, its own
    // `cd` moves only itself, and the session is unchanged afterwards.
    const { open } = await tree();
    const { kernel, events } = newKernel({ openFileSystem: open });

    await run(kernel, 't1', 'Set-Location sub');
    assert.equal(kernel.cwd('t1'), `${HOME}/sub`);

    await run(kernel, 't1', 'Set-Location ..', true);

    assert.equal(kernel.cwd('t1'), `${HOME}/sub`, 'the job moved itself, not the session');
    assert.equal(
      events.filter((e) => e.kind === 'cwd-changed').length,
      1,
      'and the terminal was not told its prompt changed',
    );
  });

  it('inherits the directory the terminal was standing in', async () => {
    const { open } = await tree();
    const { kernel } = newKernel({ openFileSystem: open });

    await run(kernel, 't1', 'Set-Location sub');
    await run(kernel, 't1', 'Get-Location', true);

    // The job's output is buffered for Receive-Job rather than printed, which
    // is where a background pipeline's objects go.
    const job = kernel.jobs.list()[0];
    assert.notEqual(job, undefined);
    const values = kernel.jobs.peek((job as { id: number }).id).values;
    const value = values[0];
    const path =
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as PSObject).properties['Path']
        : undefined;
    assert.equal(path, `${HOME}/sub`);
  });
});

describe('one shared port is a supported choice, with one location', () => {
  it('refuses to be given both a port and a factory', async () => {
    const { open } = await tree();
    const backend = new MemoryStorage({ clock: () => 0 });
    const port = brokeredFileSystem(
      new VirtualFileSystem(new MountTable(backend), { home: HOME }),
      () => undefined,
    );
    assert.throws(
      () => new Kernel({ fs: port, openFileSystem: open }),
      /alternatives/u,
      'two answers to "which filesystem" must not be resolved silently',
    );
  });

  it('shares one location across terminals, which is the documented consequence', async () => {
    // Asserted rather than left unstated: with a single port there is a single
    // filesystem view, and a view has one location. An embedder that wants two
    // independent panes supplies `openFileSystem`; this is what it gets if it
    // does not.
    const backend = new MemoryStorage({ clock: () => 0, user: 'thc1006', group: 'thc1006' });
    const view = new VirtualFileSystem(new MountTable(backend), { home: HOME, cwd: HOME });
    assert.equal(isOk(await view.mkdir(`${HOME}/sub`, { recursive: true })), true);
    const { kernel } = newKernel({ fs: brokeredFileSystem(view, () => undefined) });

    await run(kernel, 't1', 'Set-Location sub');
    assert.equal(kernel.cwd('t1'), `${HOME}/sub`);
    assert.equal(kernel.cwd('t2'), `${HOME}/sub`, 'one port, one location — by construction');
  });
});
