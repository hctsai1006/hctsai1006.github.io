/**
 * Tests for the capability broker and the audit log.
 *
 * Two claims are being defended here, and they fail in opposite directions.
 *
 * The first is that the manifest is ENFORCEABLE. `manifest.ts` says a command
 * declares what it needs and `invocation.ts` says the kernel decides; if
 * nothing checks, `capabilities: []` is documentation, and documentation that
 * nothing checks is eventually wrong.
 *
 * The second is that `sudo` GRANTS NOTHING. That claim is easy to make in a
 * comment and easy to break in code — someone adds `if (elevated) return true`
 * because it obviously should work that way, and the page now has a privilege
 * model that lies. So it is asserted from three angles: the scope table, the
 * decision, and the throw.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CapabilityDeniedError } from '../../src/commands/invocation.ts';
import type { Capability, CommandManifest, Risk } from '../../src/commands/manifest.ts';
import {
  AuditLog,
  CAPABILITY_AUDITED,
  CAPABILITY_REALITY,
  CapabilityBroker,
  ELEVATION_CONFERS,
  ELEVATION_DISCLOSURE,
  REAL_CAPABILITIES,
  RISK_AUDITED,
  VIRTUAL_CAPABILITIES,
  VirtualPolicy,
  assertElevationCannotConferReality,
  isGranted,
} from '../../src/kernel/capabilities.ts';

function manifest(overrides: Partial<CommandManifest> = {}): CommandManifest {
  return {
    name: 'set-content',
    display: 'Set-Content',
    aliases: ['sc'],
    runtime: 'browser',
    fidelity: 'browser-backed',
    risk: 'write',
    capabilities: ['filesystem.write'],
    parameters: [],
    outputTypeNames: [],
    synopsis: 'Writes content to a file.',
    parameterSource: 'declared',
    ...overrides,
  };
}

/** The `sudo` manifest, as the real one will have to declare itself. */
const SUDO: CommandManifest = manifest({
  name: 'sudo',
  display: 'sudo',
  aliases: [],
  runtime: 'semantic',
  fidelity: 'simulated',
  risk: 'privileged-simulation',
  // It also declares filesystem.write, because a `sudo` wrapper would need to
  // ask for whatever it is wrapping. That makes this the strongest form of the
  // test: declaration is satisfied, and elevation still must not help.
  capabilities: ['virtual.policy.elevate', 'filesystem.write'],
  synopsis: 'Runs a command with simulated elevated privilege.',
  notes: 'Grants nothing outside the virtual policy engine.',
});

/**
 * The union members, read out of the contract source.
 *
 * The compiler already forces `CAPABILITY_REALITY` to cover the union — it is
 * a `Record<Capability, boolean>`. This is the belt to that braces: it fails
 * loudly if the extraction stops matching, which is the failure mode a check
 * like this normally dies of.
 */
function unionMembers(typeName: string): readonly string[] {
  const source = readFileSync(new URL('../../src/commands/manifest.ts', import.meta.url), 'utf8');
  const start = source.indexOf(`export type ${typeName} =`);
  assert.notEqual(start, -1, `could not find "export type ${typeName} =" in manifest.ts`);
  const declaration = source.slice(start, source.indexOf(';', start));
  const members = [...declaration.matchAll(/'([^']+)'/gu)].map((m) => m[1] as string);
  assert.equal(members.length > 3, true, `extracted only ${members.length} ${typeName} members`);
  return members;
}

describe('the classification tables', () => {
  it('classify every capability the contract declares', () => {
    const declared = [...unionMembers('Capability')].sort();
    assert.deepEqual(Object.keys(CAPABILITY_REALITY).sort(), declared);
    assert.deepEqual(Object.keys(CAPABILITY_AUDITED).sort(), declared);
  });

  it('classify every risk the contract declares', () => {
    assert.deepEqual(Object.keys(RISK_AUDITED).sort(), [...unionMembers('Risk')].sort());
  });

  it('treat virtual.policy.elevate as the only non-real capability', () => {
    // This asymmetry is what makes "elevation confers only virtual
    // capabilities" reduce to "elevation confers only itself".
    assert.deepEqual([...VIRTUAL_CAPABILITIES], ['virtual.policy.elevate']);
    assert.equal(REAL_CAPABILITIES.has('virtual.policy.elevate'), false);
    assert.equal(REAL_CAPABILITIES.has('filesystem.write'), true);
    assert.equal(REAL_CAPABILITIES.has('network.fetch'), true);
    assert.equal(REAL_CAPABILITIES.has('device.request'), true);
  });

  it('audit every write, delete, network, device and privileged simulation', () => {
    for (const capability of [
      'filesystem.write',
      'filesystem.delete',
      'preferences.write',
      'clipboard.write',
      'network.fetch',
      'device.request',
      'virtual.policy.elevate',
    ] as const) {
      assert.equal(CAPABILITY_AUDITED[capability], true, `${capability} must be audited`);
    }
    for (const risk of ['write', 'destructive', 'device', 'privileged-simulation', 'query-external'] as const) {
      assert.equal(RISK_AUDITED[risk], true, `${risk} must be audited`);
    }
    // A plain read is not an event worth a log line, or the log is unreadable.
    assert.equal(CAPABILITY_AUDITED['filesystem.read'], false);
    assert.equal(RISK_AUDITED.read, false);
  });
});

describe('the two gates', () => {
  it('denies a capability that is granted but not declared', () => {
    // Declaration is what keeps the manifest honest: the only way to gain a
    // capability is to declare it, and a declaration is visible in a diff.
    const broker = new CapabilityBroker({ grants: ['filesystem.write', 'network.fetch'] });
    const scoped = broker.forCommand(manifest({ capabilities: ['filesystem.write'] }), 1);

    assert.equal(scoped.check('network.fetch'), 'denied:undeclared');
    assert.throws(() => scoped.require('network.fetch'), CapabilityDeniedError);
  });

  it('denies a capability that is declared but not granted', () => {
    const broker = new CapabilityBroker({ grants: [] });
    const scoped = broker.forCommand(manifest(), 1);

    assert.equal(scoped.check('filesystem.write'), 'denied:not-granted');
    assert.throws(
      () => scoped.require('filesystem.write', '/home/visitor/notes.txt'),
      (error: unknown) => {
        assert.equal(error instanceof CapabilityDeniedError, true);
        const denied = error as CapabilityDeniedError;
        assert.equal(denied.capability, 'filesystem.write');
        assert.equal(denied.name, 'CapabilityDeniedError');
        // The contract composes the message from the display name.
        assert.match(denied.message, /^Set-Content requires the filesystem\.write capability/u);
        return true;
      },
    );
  });

  it('allows a capability that is both declared and granted', () => {
    const broker = new CapabilityBroker({ grants: ['filesystem.write'] });
    const scoped = broker.forCommand(manifest(), 1);

    assert.equal(scoped.check('filesystem.write'), 'granted');
    assert.doesNotThrow(() => scoped.require('filesystem.write', '/tmp/x'));
  });

  it('leaves `check` free of side effects, so a dry run costs nothing', () => {
    const audit = new AuditLog();
    const broker = new CapabilityBroker({ grants: [], audit });
    broker.forCommand(manifest(), 1).check('filesystem.write');
    assert.deepEqual(audit.records, []);
  });
});

describe('virtual.policy.elevate confers nothing', () => {
  it('has an empty scope containing nothing real', () => {
    assert.deepEqual(ELEVATION_CONFERS, []);
    assert.doesNotThrow(assertElevationCannotConferReality);
    for (const capability of ELEVATION_CONFERS as readonly Capability[]) {
      assert.equal(CAPABILITY_REALITY[capability], false);
    }
  });

  it('does not confer filesystem.write, even to a command that declares both', () => {
    // The load-bearing test. `sudo` holds the elevation, declares the write,
    // and the write is still refused — with its own decision code, so the
    // outcome is observable rather than an absence of behaviour.
    const policy = new VirtualPolicy();
    const broker = new CapabilityBroker({ grants: ['virtual.policy.elevate'], policy });
    const scoped = broker.forCommand(SUDO, 1);

    const result = scoped.elevate();
    assert.equal(result.granted, true);
    assert.deepEqual(result.conferred, []);
    assert.equal(policy.elevated, true);
    assert.equal(policy.user, 'root');

    assert.equal(scoped.check('filesystem.write'), 'denied:elevation-not-transferable');
    assert.throws(() => scoped.require('filesystem.write', '/etc/passwd'), CapabilityDeniedError);
    assert.equal(broker.grants.has('filesystem.write'), false);
  });

  it('does not widen the grant set for any real capability', () => {
    const policy = new VirtualPolicy();
    const broker = new CapabilityBroker({ grants: ['virtual.policy.elevate'], policy });
    broker.forCommand(SUDO, 1).elevate();

    for (const capability of REAL_CAPABILITIES) {
      const scoped = broker.forCommand(manifest({ capabilities: [capability] }), 2);
      assert.equal(
        isGranted(scoped.check(capability)),
        false,
        `elevation must not confer ${capability}`,
      );
    }
  });

  it('refuses to elevate a command that was not granted the elevation', () => {
    const broker = new CapabilityBroker({ grants: [] });
    assert.throws(() => broker.forCommand(SUDO, 1).elevate(), CapabilityDeniedError);
    assert.equal(broker.policy.elevated, false);
  });

  it('hands back a copy of the scope, so a caller cannot redefine elevation', () => {
    const broker = new CapabilityBroker({ grants: ['virtual.policy.elevate'] });
    const conferred = broker.forCommand(SUDO, 1).elevate().conferred as Capability[];
    conferred.push('filesystem.write');
    assert.deepEqual(ELEVATION_CONFERS, []);
  });

  it('drops back to the unelevated user', () => {
    const policy = new VirtualPolicy();
    const broker = new CapabilityBroker({ grants: ['virtual.policy.elevate'], policy });
    broker.forCommand(SUDO, 1).elevate();
    policy.drop();

    assert.equal(policy.elevated, false);
    assert.equal(policy.user, 'visitor');
    // Back to the plain denial: there is no elevation left to blame.
    assert.equal(broker.forCommand(SUDO, 1).check('filesystem.write'), 'denied:not-granted');
  });
});

describe('the audit log', () => {
  it('records a granted write with what it touched', () => {
    const audit = new AuditLog();
    const broker = new CapabilityBroker({ grants: ['filesystem.write'], audit, clock: () => 1_700 });
    broker.forCommand(manifest(), 42).require('filesystem.write', '/home/visitor/notes.txt');

    assert.equal(audit.records.length, 1);
    const record = audit.records[0];
    assert.equal(record?.sequence, 1);
    assert.equal(record?.at, 1_700);
    assert.equal(record?.pid, 42);
    assert.equal(record?.command, 'Set-Content');
    assert.equal(record?.capability, 'filesystem.write');
    assert.equal(record?.decision, 'granted');
    assert.equal(record?.target, '/home/visitor/notes.txt');
    assert.equal(record?.real, true);
  });

  it('records a denial, which is the line a reviewer actually looks for', () => {
    const audit = new AuditLog();
    const broker = new CapabilityBroker({ grants: [], audit, clock: () => 1 });
    assert.throws(() => broker.forCommand(manifest(), 7).require('filesystem.write'));

    assert.deepEqual(
      audit.denials().map((r) => r.decision),
      ['denied:not-granted'],
    );
    assert.equal(audit.records[0]?.real, false);
    assert.equal(audit.records[0]?.target, null);
  });

  it('records a denial even for a capability that is otherwise not audited', () => {
    // A read is not worth a log line when it succeeds; an attempted read that
    // was refused always is. A log showing only successes cannot answer
    // "did anything try?".
    const audit = new AuditLog();
    const broker = new CapabilityBroker({ grants: [], audit, clock: () => 1 });
    const reader = manifest({ risk: 'read', capabilities: ['filesystem.read'] });
    assert.throws(() => broker.forCommand(reader, 7).require('filesystem.read'));
    assert.equal(audit.records.length, 1);
  });

  it('records a network call because the risk says so, not only the capability', () => {
    // Both directions are checked: a command that under-declares one is still
    // caught by the other.
    const audit = new AuditLog();
    const broker = new CapabilityBroker({ grants: ['portfolio.read'], audit, clock: () => 1 });
    const fetcher = manifest({
      display: 'Invoke-RestMethod',
      risk: 'query-external',
      capabilities: ['portfolio.read'],
    });
    broker.forCommand(fetcher, 3).require('portfolio.read', 'https://example.invalid');
    assert.equal(audit.records.length, 1);
  });

  it('records an elevation as real:false, with the disclosure the UI must show', () => {
    const audit = new AuditLog();
    const broker = new CapabilityBroker({
      grants: ['virtual.policy.elevate'],
      audit,
      clock: () => 9,
    });
    broker.forCommand(SUDO, 5).elevate();

    const record = audit.records[0];
    assert.equal(record?.capability, 'virtual.policy.elevate');
    assert.equal(record?.decision, 'granted');
    // The field a reviewer scans. A log full of sudo lines must read as
    // "nothing happened", not as alarming.
    assert.equal(record?.real, false);
    assert.equal(record?.fidelity, 'simulated');
    assert.equal(record?.risk, 'privileged-simulation');
    assert.equal(record?.disclosure, ELEVATION_DISCLOSURE);
    assert.match(ELEVATION_DISCLOSURE, /grants nothing to the browser, the origin, or the host/u);
  });

  it('does not log a plain successful read', () => {
    const audit = new AuditLog();
    const broker = new CapabilityBroker({ grants: ['filesystem.read'], audit, clock: () => 1 });
    const reader = manifest({ risk: 'read', capabilities: ['filesystem.read'] });
    broker.forCommand(reader, 1).require('filesystem.read', '/etc/hosts');
    assert.deepEqual(audit.records, []);
  });

  it('numbers entries from a counter, not a clock', () => {
    // Two records written in the same millisecond must still have an order, or
    // the log's ordering cannot be argued from.
    const audit = new AuditLog();
    const broker = new CapabilityBroker({ grants: ['filesystem.write'], audit, clock: () => 5 });
    const scoped = broker.forCommand(manifest(), 1);
    scoped.require('filesystem.write', 'a');
    scoped.require('filesystem.write', 'b');

    assert.deepEqual(
      audit.records.map((r) => [r.sequence, r.at]),
      [
        [1, 5],
        [2, 5],
      ],
    );
  });

  it('has no way to remove an entry at all', () => {
    // This test used to be 'does not restart the sequence after a clear', and
    // it was the ONLY caller of `AuditLog.clear` anywhere in the repository —
    // a method whose entire effect was to make an append-only log not be one.
    // It is gone from the class, so the property that matters is now the
    // stronger one: there is nothing on this object that removes a record.
    const audit = new AuditLog();
    const broker = new CapabilityBroker({ grants: ['filesystem.write'], audit, clock: () => 5 });
    broker.forCommand(manifest(), 1).require('filesystem.write', 'a');
    broker.forCommand(manifest(), 1).require('filesystem.write', 'b');

    const mutators = ['clear', 'delete', 'remove', 'truncate', 'splice', 'reset', 'pop', 'shift'];
    for (const name of mutators) {
      assert.equal(
        typeof (audit as unknown as Record<string, unknown>)[name],
        'undefined',
        `AuditLog must not expose ${name}`,
      );
    }
    // The sequence is still a counter and still never reused.
    assert.deepEqual(audit.records.map((r) => r.sequence), [1, 2]);
  });

  it('freezes records and tells subscribers about each one', () => {
    const audit = new AuditLog();
    const heard: Risk[] = [];
    audit.onAppend((record) => heard.push(record.risk));
    const broker = new CapabilityBroker({ grants: ['filesystem.write'], audit, clock: () => 5 });
    broker.forCommand(manifest(), 1).require('filesystem.write', 'a');

    assert.deepEqual(heard, ['write']);
    assert.equal(Object.isFrozen(audit.records[0]), true);
  });
});

describe('the audit `real` flag tells the truth about the command', () => {
  // `real` is what makes a log readable as "nothing happened" — its own doc
  // comment calls it "the field a reviewer scans". It was computed from the
  // capability's category alone, so a SIMULATED command holding a real
  // capability would have been recorded real:true for doing nothing.
  //
  // Measured before writing this: no shipped command is in that state. The four
  // simulated commands that declare anything hold process.read, portfolio.read
  // or virtual.policy.elevate, none of which is both real and audited. So this
  // guards a reclassification — giving `ping` network.fetch, say — rather than
  // repairing a live defect.
  it('is false for a simulated command holding a real, audited capability', () => {
    const broker = new CapabilityBroker({ grants: ['network.fetch'] });
    const scoped = broker.forCommand(
      manifest({
        name: 'ping',
        display: 'ping',
        runtime: 'semantic',
        fidelity: 'simulated',
        risk: 'query-external',
        capabilities: ['network.fetch'],
        notes: 'Invents round-trip times. Sends no packet.',
      }),
      1,
    );

    scoped.require('network.fetch');
    const record = broker.audit.records.at(-1);
    assert.ok(record !== undefined, 'a real, audited capability must leave a line');
    assert.equal(record.decision, 'granted');
    assert.equal(record.fidelity, 'simulated');
    assert.equal(record.real, false, 'a simulated command sends nothing');
  });

  it('is still true for a browser-backed command doing the same thing', () => {
    const broker = new CapabilityBroker({ grants: ['filesystem.write'] });
    broker.forCommand(manifest(), 1).require('filesystem.write');
    const record = broker.audit.records.at(-1);
    assert.equal(record?.real, true);
  });

  it('no shipped simulated command declares a real, audited capability today', async () => {
    // The measurement the comment above rests on, kept as a test so the claim
    // cannot quietly stop being true.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const manifests = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', '..', 'src', 'commands', 'manifests.json'), 'utf8'),
    ) as { commands: ReadonlyArray<{ name: string; fidelity: string; capabilities: readonly string[] }> };

    const offenders = manifests.commands
      .filter((c) => c.fidelity === 'simulated')
      .filter((c) => c.capabilities.some((k) => CAPABILITY_REALITY[k as Capability] && CAPABILITY_AUDITED[k as Capability]))
      .map((c) => c.name);

    assert.deepEqual(offenders, [], 'if this fires, the guard above is now load-bearing');
  });
});
