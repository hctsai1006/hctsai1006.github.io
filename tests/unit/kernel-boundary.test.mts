/**
 * kernel-boundary.test.mts — the attacks, not the behaviour.
 *
 * Every other kernel test asks "does this do what it says". This one asks "can
 * I make it lie", and each case is a transcript of something that WORKED
 * against the shipped classes before the read-only views existed:
 *
 *     grants before                       => filesystem.read
 *     cast ReadonlySet -> Set and add()   => filesystem.read,filesystem.write
 *     policy object mutable?              => ["injected"]
 *     audit.records push / truncate       => 1 / 0
 *
 * `ReadonlySet<T>`, `readonly` and `Readonly<T>` are compiler opinions. They
 * are erased before anything runs, so a getter typed `ReadonlySet` that returns
 * the live Set hands out a mutable Set to anyone willing to write `as Set`.
 * These tests are written in exactly that voice — cast, then mutate — because
 * the only interesting question is what happens at runtime.
 *
 * `Object.freeze` is NOT what closes this, and the test below proves it rather
 * than asserting it, because reaching for freeze on a Set is the obvious wrong
 * fix and it fails silently.
 *
 * WHAT THESE TESTS DO NOT CLAIM. None of this is a sandbox. Code sharing this
 * Worker's global calls `fetch`, IndexedDB and every other browser API without
 * asking the kernel at all, and nothing here would notice — the audit log would
 * show nothing, because nothing was asked. What is defended is narrower and
 * still worth defending: a command that goes THROUGH the kernel cannot obtain a
 * capability it was not granted, and what it did obtain stays on the record.
 * Isolation is ROADMAP 14.3 and does not exist yet.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Capability, CommandManifest } from '../../src/commands/manifest.ts';
import {
  AuditLog,
  CapabilityBroker,
  REAL_CAPABILITIES,
  RISK_AUDITED,
  VirtualPolicy,
} from '../../src/kernel/capabilities.ts';
import type { AuditRecord } from '../../src/kernel/capabilities.ts';
import { Kernel } from '../../src/kernel/kernel.ts';
import { readonlySetView } from '../../src/kernel/inspect.ts';

function manifest(overrides: Partial<CommandManifest> = {}): CommandManifest {
  return {
    name: 'set-content',
    display: 'Set-Content',
    aliases: [],
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

/** `as any` in one place with a name, so the casts below read as attacks. */
function asMutable<T>(value: unknown): T {
  return value as T;
}

// ---------------------------------------------------------------------------
// the premise
// ---------------------------------------------------------------------------

describe('the premise: freezing a Set does nothing', () => {
  it('lets a frozen Set be added to anyway', () => {
    // Measured on Node 24.13.0. Set mutation goes through internal slots, not
    // properties, so `Object.freeze` — which only seals properties — is not a
    // defence. Anyone reaching for it as the fix here needs to see this fail.
    const set = new Set(['a']);
    Object.freeze(set);
    set.add('b');
    assert.equal(Object.isFrozen(set), true);
    assert.deepEqual([...set], ['a', 'b'], 'if this ever passes, V8 changed and the note is stale');
  });

  it('gives a read-only view that fails loudly instead', () => {
    const view = readonlySetView(new Set(['a']));
    assert.throws(() => asMutable<Set<string>>(view).add('b'), TypeError);
    // Absent rather than present-and-throwing, so a feature test agrees with
    // reality instead of finding a method that always fails.
    assert.equal(typeof asMutable<Record<string, unknown>>(view)['add'], 'undefined');
    assert.equal(typeof asMutable<Record<string, unknown>>(view)['delete'], 'undefined');
    assert.equal(typeof asMutable<Record<string, unknown>>(view)['clear'], 'undefined');
    // …and it is still a usable ReadonlySet.
    assert.equal(view.has('a'), true);
    assert.equal(view.size, 1);
    assert.deepEqual([...view], ['a']);
  });

  it('reads through to the live set rather than freezing a copy in time', () => {
    const inner = new Set(['a']);
    const view = readonlySetView(inner);
    inner.add('b');
    assert.deepEqual([...view], ['a', 'b']);
  });

  it('does not hand the live Set to a forEach callback', () => {
    // FOUND BY THE ADVERSARIAL PASS ON THIS FILE'S OWN FIX, and it defeated the
    // first version of it completely. `Set.prototype.forEach` invokes its
    // callback as `callback(value, value, THE SET)`, so a view that delegated
    // to `inner.forEach` handed the live Set straight to the caller:
    //
    //   broker.grants.forEach((_v,_v2,s) => (s as Set).add('device.request'))
    //   => filesystem.read,device.request
    //
    // The third argument is now the view. The test asserts the identity as well
    // as the throw, because a view that merely lacked `add` while still passing
    // `inner` would be one `new Set(third)` away from the same escape.
    const inner = new Set(['a']);
    const view = readonlySetView(inner);
    const seen: unknown[] = [];
    view.forEach((value, value2, set) => {
      seen.push(value, value2, set);
    });
    assert.deepEqual(seen.slice(0, 2), ['a', 'a']);
    assert.equal(seen[2], view, 'the third argument must be the view, not the Set');
    assert.equal(seen[2] instanceof Set, false);
    assert.throws(() => {
      view.forEach((_v, _v2, set) => asMutable<Set<string>>(set).add('b'));
    }, TypeError);
    assert.deepEqual([...inner], ['a']);
  });

  it('honours thisArg in forEach, since it is no longer Set.prototype doing it', () => {
    // Reimplementing a standard method means owning its contract. A caller
    // passing thisArg must still get it.
    const view = readonlySetView(new Set([1, 2]));
    const box = { total: 0 };
    view.forEach(function (this: typeof box, value: number) {
      this.total += value;
    }, box);
    assert.equal(box.total, 3);
  });
});

// ---------------------------------------------------------------------------
// the proven attack
// ---------------------------------------------------------------------------

describe('a caller cannot grant itself a capability', () => {
  it('refuses the cast-and-add that used to work', () => {
    // THE TRANSCRIPT. This exact sequence printed
    //   grants before                     => filesystem.read
    //   cast ReadonlySet -> Set and add() => filesystem.read,filesystem.write
    const broker = new CapabilityBroker({ grants: ['filesystem.read'] });
    assert.deepEqual([...broker.grants], ['filesystem.read']);

    assert.throws(
      () => asMutable<Set<Capability>>(broker.grants).add('filesystem.write'),
      TypeError,
    );
    assert.deepEqual([...broker.grants], ['filesystem.read']);

    // And the decision agrees, which is the half that actually matters: a
    // mutation that failed but left the broker deciding otherwise would be
    // worse than no defence at all.
    const scoped = broker.forCommand(manifest(), 1);
    assert.equal(scoped.check('filesystem.write'), 'denied:not-granted');
  });

  it('refuses delete and clear on the grant set too', () => {
    // The mirror attack: remove a capability so a denial looks like a grant
    // failure somewhere else, or empty the set to make the log unreadable.
    const broker = new CapabilityBroker({ grants: ['filesystem.read', 'network.fetch'] });
    const grants = asMutable<Set<Capability>>(broker.grants);
    assert.throws(() => grants.delete('network.fetch'), TypeError);
    assert.throws(() => grants.clear(), TypeError);
    assert.deepEqual([...broker.grants].sort(), ['filesystem.read', 'network.fetch']);
  });

  it('refuses the same thing through a Kernel', () => {
    // The reachable path in practice: an embedder or a module holds a Kernel,
    // not a broker.
    //   kernel.capabilities.grants => filesystem.read,device.request
    const kernel = new Kernel({ grants: ['filesystem.read'] });
    assert.throws(
      () => asMutable<Set<Capability>>(kernel.capabilities.grants).add('device.request'),
      TypeError,
    );
    assert.deepEqual([...kernel.capabilities.grants], ['filesystem.read']);
  });

  it('hands out a container that cannot be spliced into the broker', () => {
    // A copy would be enough to make the attack inert; this asserts the
    // stronger property, that the view is not a Set the caller can repurpose
    // and hand back.
    const broker = new CapabilityBroker({ grants: ['filesystem.read'] });
    assert.equal(broker.grants instanceof Set, false);
    // Mutating a real Set built FROM the view is fine and changes nothing.
    const copy = new Set(broker.grants);
    copy.add('device.request');
    assert.deepEqual([...broker.grants], ['filesystem.read']);
  });
});

// ---------------------------------------------------------------------------
// the policy object
// ---------------------------------------------------------------------------

describe('a caller cannot reach the privilege object', () => {
  it('refuses the property injection that used to work', () => {
    //   policy object mutable? => ["injected"]
    const broker = new CapabilityBroker({ grants: [] });
    assert.throws(() => {
      asMutable<Record<string, unknown>>(broker.policy)['injected'] = true;
    }, TypeError);
    assert.equal(Object.hasOwn(broker.policy, 'injected'), false);
  });

  it('does not expose elevate or drop on the policy view', () => {
    // Neither confers anything real — ELEVATION_CONFERS is empty and checked —
    // but both change what `whoami` and the prompt say, and a UI that can be
    // made to display "root" without an elevation having been decided is
    // telling the user something that did not happen.
    const broker = new CapabilityBroker({ grants: [] });
    const policy = asMutable<Record<string, unknown>>(broker.policy);
    assert.equal(typeof policy['elevate'], 'undefined');
    assert.equal(typeof policy['drop'], 'undefined');
  });

  it('reads through, so the view never reports a stale elevation', () => {
    // A snapshot would be correct once and wrong from then on, in the one
    // display whose entire job is to say whether you are elevated.
    const policy = new VirtualPolicy();
    const broker = new CapabilityBroker({ grants: ['virtual.policy.elevate'], policy });
    const view = broker.policy;
    assert.equal(view.elevated, false);
    assert.equal(view.user, 'visitor');

    broker.forCommand(
      manifest({
        name: 'sudo',
        display: 'sudo',
        runtime: 'semantic',
        fidelity: 'simulated',
        risk: 'privileged-simulation',
        capabilities: ['virtual.policy.elevate'],
      }),
      1,
    ).elevate();

    assert.equal(view.elevated, true, 'the same view object must see the elevation');
    assert.equal(view.user, 'root');
  });

  it('freezes the policy the embedder constructed, too', () => {
    // The broker no longer hands this object out, but whoever built it still
    // holds it, and injecting into it would reach the same state.
    const policy = new VirtualPolicy();
    assert.throws(() => {
      asMutable<Record<string, unknown>>(policy)['injected'] = true;
    }, TypeError);
  });
});

// ---------------------------------------------------------------------------
// the audit log
// ---------------------------------------------------------------------------

describe('the audit log is append-only at runtime, not just in the docstring', () => {
  function withOneRecord(): { audit: AuditLog; broker: CapabilityBroker } {
    const audit = new AuditLog();
    const broker = new CapabilityBroker({ grants: ['filesystem.write'], audit, clock: () => 5 });
    broker.forCommand(manifest(), 1).require('filesystem.write', '/a');
    return { audit, broker };
  }

  it('refuses the push that used to forge a record', () => {
    //   audit.records push => 1
    const { audit } = withOneRecord();
    assert.throws(
      () => asMutable<AuditRecord[]>(audit.records).push({ sequence: 999 } as AuditRecord),
      TypeError,
    );
    assert.equal(audit.records.length, 1);
    assert.deepEqual(audit.records.map((r) => r.sequence), [1]);
  });

  it('refuses the truncation that used to erase the log', () => {
    //   audit.records truncate => 0
    const { audit } = withOneRecord();
    assert.throws(() => {
      asMutable<AuditRecord[]>(audit.records).length = 0;
    }, TypeError);
    assert.throws(() => asMutable<AuditRecord[]>(audit.records).splice(0, 1), TypeError);
    assert.equal(audit.records.length, 1);
  });

  it('never hands out the same array twice', () => {
    // The subtler version of the same attack: a getter that returns a cached
    // array lets a caller keep a reference, wait, and mutate what a later
    // reader will see. Each read is its own frozen copy.
    const { audit } = withOneRecord();
    const first = audit.records;
    const second = audit.records;
    assert.notEqual(first, second, 'each read must be its own array');
    assert.deepEqual(first, second);
    assert.equal(Object.isFrozen(first), true);
  });

  it('freezes what denials() hands back as well', () => {
    const audit = new AuditLog();
    const broker = new CapabilityBroker({ grants: [], audit, clock: () => 5 });
    assert.throws(() => broker.forCommand(manifest(), 1).require('filesystem.write'));
    const denials = audit.denials();
    assert.equal(denials.length, 1);
    assert.throws(() => asMutable<AuditRecord[]>(denials).push(denials[0] as AuditRecord), TypeError);
  });

  it('has no clear, on the class or on the view', () => {
    const { audit, broker } = withOneRecord();
    for (const target of [audit, broker.audit] as unknown[]) {
      const bag = asMutable<Record<string, unknown>>(target);
      assert.equal(typeof bag['clear'], 'undefined');
      assert.equal(typeof bag['delete'], 'undefined');
    }
  });

  it('keeps append off the view the kernel exposes', () => {
    // The view is for reading. Appending is the broker's, at the one place a
    // decision was actually made.
    const kernel = new Kernel({ grants: [] });
    assert.equal(typeof asMutable<Record<string, unknown>>(kernel.audit)['append'], 'undefined');
  });

  it('refuses injection onto the log object itself', () => {
    const audit = new AuditLog();
    assert.throws(() => {
      asMutable<Record<string, unknown>>(audit)['records'] = [];
    }, TypeError);
  });
});

// ---------------------------------------------------------------------------
// the module constants
// ---------------------------------------------------------------------------

describe('the classification tables cannot be edited from outside', () => {
  it('refuses to flip a risk from audited to not', () => {
    // RISK_AUDITED was the one table left unfrozen. `RISK_AUDITED.write = false`
    // would have turned off auditing for every write in the session, silently,
    // from any module that could import it.
    assert.throws(() => {
      asMutable<Record<string, boolean>>(RISK_AUDITED)['write'] = false;
    }, TypeError);
    assert.equal(RISK_AUDITED.write, true);
  });

  it('refuses to remove a capability from the real set', () => {
    // Typed ReadonlySet, and a bare `new Set(...)` underneath, so
    // `(REAL_CAPABILITIES as Set).delete('filesystem.write')` reclassified a
    // real capability as virtual for every reader of the table.
    assert.throws(
      () => asMutable<Set<Capability>>(REAL_CAPABILITIES).delete('filesystem.write'),
      TypeError,
    );
    assert.equal(REAL_CAPABILITIES.has('filesystem.write'), true);
  });

  it('refuses the forEach route into the real set as well', () => {
    // A module constant corrupted this way stays corrupted for every reader in
    // the process, which makes it the worse half of the forEach hole.
    assert.throws(() => {
      REAL_CAPABILITIES.forEach((_v, _v2, set) =>
        asMutable<Set<Capability>>(set).delete('filesystem.write'),
      );
    }, TypeError);
    assert.equal(REAL_CAPABILITIES.has('filesystem.write'), true);
  });
});

// ---------------------------------------------------------------------------
// the kernel's own surface
// ---------------------------------------------------------------------------

describe('the Kernel exposes no mutator through an inspection getter', () => {
  /** Every method that changes kernel state, per manager. */
  const MUTATORS: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['processes', ['create', 'transition', 'exit', 'reap', 'reapBefore']],
    ['jobs', ['start', 'record', 'recordError', 'receive', 'transition', 'finish', 'remove']],
    ['signals', ['register', 'unregister', 'raise', 'raiseGroup', 'deliver', 'interrupt', 'setForeground']],
    ['capabilities', ['forCommand']],
    ['audit', ['append', 'clear']],
  ];

  it('has none of them on any of the five views', () => {
    const kernel = new Kernel({ grants: ['filesystem.read'] });
    const surface = asMutable<Record<string, Record<string, unknown>>>(kernel);
    for (const [getter, mutators] of MUTATORS) {
      const view = surface[getter] as Record<string, unknown>;
      for (const name of mutators) {
        assert.equal(
          typeof view[name],
          'undefined',
          `kernel.${getter}.${name} must not be reachable`,
        );
      }
    }
  });

  it('still answers everything a reader needs', () => {
    // The views must not be so narrow that a UI has to reach past them, which
    // is how a hole gets reopened.
    const kernel = new Kernel({ grants: ['filesystem.read'] });
    assert.deepEqual(kernel.processes.list(), []);
    assert.deepEqual(kernel.processes.live(), []);
    assert.equal(kernel.processes.nextPid, 1);
    assert.deepEqual(kernel.jobs.list(), []);
    assert.equal(kernel.jobs.nextId, 1);
    assert.equal(kernel.signals.foregroundGroup('t1'), undefined);
    assert.equal(kernel.capabilities.grants.has('filesystem.read'), true);
    assert.equal(kernel.capabilities.policy.elevated, false);
    assert.equal(kernel.audit.size, 0);
    assert.deepEqual(kernel.audit.records, []);
    assert.equal(kernel.capabilities.evaluate(manifest(), 'filesystem.write'), 'denied:not-granted');
    assert.equal(kernel.capabilities.shouldAudit(manifest(), 'filesystem.write', 'granted'), true);
    // Subscribing is not mutating: the unsubscribe closure removes only itself.
    const stop = kernel.processes.onChange(() => undefined);
    assert.equal(typeof stop, 'function');
    stop();
  });

  it('refuses injection onto the views themselves', () => {
    const kernel = new Kernel({ grants: [] });
    for (const view of [
      kernel.processes,
      kernel.jobs,
      kernel.signals,
      kernel.capabilities,
      kernel.audit,
      kernel.capabilities.policy,
    ] as unknown[]) {
      assert.equal(Object.isFrozen(view), true);
      assert.throws(() => {
        asMutable<Record<string, unknown>>(view)['reap'] = () => true;
      }, TypeError);
    }
  });

  it('cannot have an inspection getter shadowed on the instance', () => {
    // FOUND BY THE ADVERSARIAL PASS. A getter on a prototype is shadowed by an
    // own property on the instance, so the views could be swapped out wholesale
    // on a Kernel someone already held:
    //
    //   Object.defineProperty(kernel, 'capabilities',
    //     { value: { grants: new Set(['device.request']) } })
    //   => kernel.capabilities.grants  is whatever the attacker said
    //
    // It gains the attacker nothing directly. It matters when a page hands the
    // same kernel to a third-party module and then renders the grant list or
    // the audit log itself: what it renders would be a fabrication.
    const kernel = new Kernel({ grants: ['filesystem.read'] });
    for (const name of ['capabilities', 'audit', 'processes', 'jobs', 'signals']) {
      assert.throws(
        () => Object.defineProperty(kernel, name, { value: { lie: true } }),
        TypeError,
        `kernel.${name} must not be shadowable`,
      );
    }
    assert.throws(() => {
      asMutable<Record<string, unknown>>(kernel)['extra'] = 1;
    }, TypeError);
    assert.deepEqual([...kernel.capabilities.grants], ['filesystem.read']);
  });

  it('gives the same view object back on every read', () => {
    // Not a security property — a fresh frozen view each time would be safe
    // too — but a correctness one: a UI that stores `kernel.processes` and
    // compares it later must not see a new identity on every render.
    const kernel = new Kernel({ grants: [] });
    assert.equal(kernel.processes, kernel.processes);
    assert.equal(kernel.jobs, kernel.jobs);
    assert.equal(kernel.signals, kernel.signals);
    assert.equal(kernel.capabilities, kernel.capabilities);
    assert.equal(kernel.audit, kernel.audit);
  });
});

// ---------------------------------------------------------------------------
// the adversarial sweep: other routes to the same objects
// ---------------------------------------------------------------------------

describe('no other exported path reaches a mutator', () => {
  it('does not leak the live table through a change listener', () => {
    // A listener is the classic leak: it receives the object rather than
    // fetching it, so a read-only getter can be bypassed by subscribing.
    const kernel = new Kernel({ grants: [] });
    const seen: unknown[] = [];
    kernel.processes.onChange((snapshot) => seen.push(snapshot));
    kernel.send({
      kind: 'exec',
      requestId: 'r1',
      terminalId: 't1',
      source: 'nope',
      background: false,
    });
    assert.equal(seen.length > 0, true, 'the listener must actually have fired');
    for (const snapshot of seen) {
      assert.equal(Object.isFrozen(snapshot), true);
      assert.throws(() => {
        asMutable<Record<string, unknown>>(snapshot)['exitCode'] = 0;
      }, TypeError);
    }
  });

  it('does not leak the live log through an audit listener', () => {
    const audit = new AuditLog();
    const broker = new CapabilityBroker({ grants: [], audit, clock: () => 5 });
    const heard: AuditRecord[] = [];
    audit.onAppend((record) => heard.push(record));
    assert.throws(() => broker.forCommand(manifest(), 1).require('filesystem.write'));
    assert.equal(heard.length, 1);
    assert.equal(Object.isFrozen(heard[0]), true);
    assert.throws(() => {
      asMutable<Record<string, unknown>>(heard[0])['real'] = true;
    }, TypeError);
  });

  it('does not leak a mutable scope through the elevation result', () => {
    // `conferred` is derived from a module constant. Handing the constant
    // itself out would let a caller redefine what elevation means for everyone.
    const broker = new CapabilityBroker({ grants: ['virtual.policy.elevate'] });
    const result = broker.forCommand(
      manifest({
        name: 'sudo',
        display: 'sudo',
        fidelity: 'simulated',
        risk: 'privileged-simulation',
        capabilities: ['virtual.policy.elevate'],
      }),
      1,
    ).elevate();
    asMutable<Capability[]>(result.conferred).push('filesystem.write');
    // The copy moved; the broker did not.
    const second = broker.forCommand(
      manifest({
        name: 'sudo',
        display: 'sudo',
        fidelity: 'simulated',
        risk: 'privileged-simulation',
        capabilities: ['virtual.policy.elevate'],
      }),
      2,
    ).elevate();
    assert.deepEqual(second.conferred, []);
    assert.equal(broker.grants.has('filesystem.write'), false);
  });

  it('does not leak a job buffer through peek', () => {
    // `peek` copies and freezes, so a reader cannot splice the copy and pass it
    // on as what the job produced — and, unlike `receive`, cannot empty the
    // buffer before Receive-Job asks for it.
    const kernel = new Kernel({ grants: [] });
    const output = kernel.jobs.peek(1);
    assert.equal(Object.isFrozen(output), true);
    assert.equal(Object.isFrozen(output.values), true);
    assert.equal(Object.isFrozen(output.errors), true);
  });

  it('keeps a process snapshot frozen everywhere it can be reached', () => {
    const kernel = new Kernel({ grants: [] });
    kernel.send({
      kind: 'exec',
      requestId: 'r1',
      terminalId: 't1',
      source: 'nope',
      background: false,
    });
    for (const snapshot of kernel.processes.list()) {
      assert.equal(Object.isFrozen(snapshot), true);
    }
    // The list itself is rebuilt per call, so splicing it changes nothing.
    const list = kernel.processes.list();
    asMutable<unknown[]>(list).length = 0;
    assert.equal(kernel.processes.list().length > 0, true);
  });
});
