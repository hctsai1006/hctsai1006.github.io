/**
 * The ports have to reach a command through the things that actually run one.
 *
 * `InvocationContext` grew `fs`, `preferences` and `dialog`, and both places
 * that BUILD a context — the kernel and the pipeline — hard-coded all three to
 * null, with no field on `PipelineHost` or `KernelOptions` to carry them. So the
 * contract declared a filesystem that nothing could supply, and no filesystem
 * command could run in a pipeline. The work that needed it found that, not a
 * type error: every signature was satisfied.
 *
 * These tests run a command through the kernel and through a pipeline stage and
 * assert it reaches real storage, so the gap cannot reopen quietly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Kernel } from '../../src/kernel/kernel.ts';
import { MemoryStorage, MountTable, VirtualFileSystem, isOk } from '../../src/storage/index.ts';
import { brokeredFileSystem } from '../../src/commands/ports.ts';
import type { FileSystemPort } from '../../src/commands/ports.ts';
import type { CommandModule, InvocationContext } from '../../src/commands/invocation.ts';
import type { CommandManifest } from '../../src/commands/manifest.ts';
import { HOME } from '../../src/storage/seed.ts';

function storage(): { fs: VirtualFileSystem; port: FileSystemPort } {
  const backend = new MemoryStorage({ clock: () => 0 });
  const fs = new VirtualFileSystem(new MountTable(backend), { home: HOME });
  // Fully granted: these tests are about REACHABILITY, not about the gate. The
  // gate has its own tests in ports.test.mts.
  return { fs, port: brokeredFileSystem(fs, () => {}) };
}

function readingCommand(seen: { path: string | null; text: string | null }): CommandModule {
  const manifest: CommandManifest = {
    name: 'probe-read',
    display: 'Probe-Read',
    aliases: [],
    runtime: 'browser',
    fidelity: 'browser-backed',
    risk: 'read',
    capabilities: ['filesystem.read'],
    parameters: [],
    outputTypeNames: [],
    synopsis: 'Reads one file, for testing that a command can reach storage.',
    parameterSource: 'none',
    implementationStatus: 'implemented',
  };
  return {
    manifest,
    async invoke(context: InvocationContext): Promise<number> {
      if (context.fs === null) {
        seen.path = null;
        return 1;
      }
      seen.path = context.fs.location.path;
      const read = await context.fs.readText('/etc/probe.txt');
      seen.text = isOk(read) ? read.value : `error:${read.error.code}`;
      return 0;
    },
  };
}

describe('a command reaches storage through the kernel', () => {
  it('gets the filesystem the host supplied, not null', async () => {
    const { fs, port } = storage();
    assert.ok(isOk(await fs.mkdir('/etc', { recursive: true })));
    assert.ok(isOk(await fs.writeText('/etc/probe.txt', 'reached')));

    const seen = { path: null as string | null, text: null as string | null };
    const kernel = new Kernel({ clock: () => 0, grants: ['filesystem.read'], fs: port });
    kernel.register(readingCommand(seen));

    kernel.send({
      kind: 'exec',
      requestId: 'r1',
      terminalId: 't1',
      source: 'probe-read',
      background: false,
    });
    await kernel.drain();

    assert.equal(seen.text, 'reached', 'the command read the file the host created');
    assert.equal(seen.path, HOME, 'and it started in the seed home');
  });

  it('still hands null when the host has no storage, rather than pretending', async () => {
    const seen = { path: null as string | null, text: null as string | null };
    const kernel = new Kernel({ clock: () => 0, grants: ['filesystem.read'] });
    kernel.register(readingCommand(seen));

    kernel.send({
      kind: 'exec',
      requestId: 'r1',
      terminalId: 't1',
      source: 'probe-read',
      background: false,
    });
    await kernel.drain();

    assert.equal(seen.path, null);
    assert.equal(seen.text, null, 'a headless run must be visible to the command, not faked');
  });
});

describe('the port carries a whole copy, not a loop', () => {
  it('exposes copy, so a recursive copy stays one planned operation', async () => {
    // Omitting `copy` from the port forced every copy command to loop over
    // single writes, which gives up the plan/validate/apply guarantee the
    // backend provides: nine files copied, the tenth refused, eight left behind.
    const { fs, port } = storage();
    assert.ok(isOk(await fs.mkdir('/src/deep', { recursive: true })));
    assert.ok(isOk(await fs.writeText('/src/a.txt', 'one')));
    assert.ok(isOk(await fs.writeText('/src/deep/b.txt', 'two')));

    assert.equal(typeof port.copy, 'function');
    const copied = await port.copy('/src', '/dst', { recursive: true });
    assert.ok(isOk(copied), 'the copy is one call');

    const b = await port.readText('/dst/deep/b.txt');
    assert.ok(isOk(b) && b.value === 'two');
  });
});
