/**
 * The brokered filesystem is the answer to a specific review finding: no command
 * in the repository called `requireCapability`, so `capabilities: []` in a
 * manifest was decoration. A command handed a raw VirtualFileSystem could read,
 * write and delete without ever asking.
 *
 * These tests make the denial happen rather than assuming it. A guard that has
 * only ever been passed is a guard of unknown strength.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStorage, VirtualFileSystem, MountTable, isOk } from '../../src/storage/index.ts';
import { brokeredFileSystem } from '../../src/commands/ports.ts';
import { CapabilityDeniedError } from '../../src/commands/invocation.ts';
import type { Capability } from '../../src/commands/manifest.ts';

function portFor(declared: readonly Capability[]): ReturnType<typeof brokeredFileSystem> {
  const backend = new MemoryStorage({ clock: () => 0 });
  const fs = new VirtualFileSystem(new MountTable(backend), { home: '/home/visitor' });
  const granted = new Set<Capability>(declared);
  return brokeredFileSystem(fs, (capability) => {
    if (!granted.has(capability)) throw new CapabilityDeniedError(capability, 'probe');
  });
}

describe('a command that declared only filesystem.read', () => {
  const port = portFor(['filesystem.read']);

  it('may read', async () => {
    await assert.doesNotReject(() => port.readdir('/'));
    await assert.doesNotReject(() => port.exists('/home'));
    await assert.doesNotReject(() => port.stat('/home'));
  });

  for (const [label, run] of [
    ['writeText', () => port.writeText('/tmp/x', 'hi')],
    ['writeBytes', () => port.writeBytes('/tmp/x', new Uint8Array([1]))],
    ['appendText', () => port.appendText('/tmp/x', 'hi')],
    ['mkdir', () => port.mkdir('/tmp/d')],
    ['chmod', () => port.chmod('/tmp/x', 0o644)],
    ['rename', () => port.rename('/a', '/b')],
  ] as const) {
    it(`may not ${label}`, async () => {
      await assert.rejects(run, CapabilityDeniedError);
    });
  }

  it('may not remove — that is its own capability, not part of write', async () => {
    await assert.rejects(() => port.remove('/tmp/x'), CapabilityDeniedError);
  });
});

describe('a command that declared write but not delete', () => {
  const port = portFor(['filesystem.read', 'filesystem.write']);

  it('may create and rename', async () => {
    // A bare VirtualFileSystem has no tree — bootStorage installs the seed, and
    // this test is about the broker, not the seed. So it makes its own directory.
    assert.ok(isOk(await port.mkdir('/home/visitor', { recursive: true })));
    assert.ok(isOk(await port.writeText('/home/visitor/a.txt', 'hello')));
    assert.ok(isOk(await port.rename('/home/visitor/a.txt', '/home/visitor/b.txt')));
  });

  it('still may not remove', async () => {
    // Move-Item needs no delete permission in PowerShell either: renaming moves
    // a name, it does not destroy content. Deleting is the one mistake that
    // cannot be taken back, which is why it has its own grant.
    await assert.rejects(() => port.remove('/home/visitor/b.txt'), CapabilityDeniedError);
  });
});

describe('a command that declared nothing', () => {
  const port = portFor([]);

  it('cannot read one byte', async () => {
    await assert.rejects(() => port.readText('/etc/os-release'), CapabilityDeniedError);
    await assert.rejects(() => port.readdir('/'), CapabilityDeniedError);
  });

  it('can still resolve a path', () => {
    // Ungated on purpose: turning "../notes.txt" into an absolute path reveals
    // nothing the command did not already type, and the binder needs it before
    // any capability question is meaningful.
    assert.ok(isOk(port.resolve('../notes.txt')));
    assert.equal(typeof port.location.path, 'string');
  });
});

describe('the denial names what was refused', () => {
  it('carries the capability, not a generic failure', async () => {
    const port = portFor(['filesystem.read']);
    await assert.rejects(
      () => port.writeText('/tmp/x', 'hi'),
      (error: unknown) => {
        assert.ok(error instanceof CapabilityDeniedError);
        assert.match(error.message, /filesystem\.write/);
        return true;
      },
    );
  });
});
