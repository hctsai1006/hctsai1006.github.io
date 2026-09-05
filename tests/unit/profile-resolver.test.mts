/**
 * Tests for compatibility profile resolution.
 *
 * These run against the REAL generated profiles rather than fixtures. That is
 * deliberate: the resolver's whole job is to make the inheritance in those
 * files work, and a test against a hand-made two-key profile would pass while
 * the actual files failed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  resolveProfile,
  compatibilityView,
  profileMap,
  ProfileResolutionError,
} from '../../src/compatibility/profile-resolver.ts';
import type { StoredProfile } from '../../src/compatibility/profile-resolver.ts';
import { switchBehaviorKey } from '../../src/compatibility/behavior-keys.ts';

const PROFILE_DIR = join(import.meta.dirname, '..', '..', 'compat', 'profiles');

function loadRealProfiles(): StoredProfile[] {
  return readdirSync(PROFILE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(PROFILE_DIR, f), 'utf8')) as StoredProfile);
}

const LTS = 'powershell/7.6.5/linux';
const PREVIEW = 'powershell/7.7.0-preview.4/linux';

describe('resolving the real profiles', () => {
  const map = profileMap(loadRealProfiles());

  it('resolves the LTS profile, which inherits nothing', () => {
    const r = resolveProfile(LTS, map);
    assert.equal(r.id, LTS);
    assert.equal(r.channel, 'lts');
    assert.deepEqual(r.lineage, [LTS]);
    assert.equal(r.supportedUpstream, true);
  });

  it('resolves the preview profile through its parent', () => {
    const r = resolveProfile(PREVIEW, map);
    assert.deepEqual(r.lineage, [PREVIEW, LTS], 'most-derived first');
    assert.equal(r.supportedUpstream, false, 'a preview is not supported upstream');
  });

  it('inherits the parent command inventory and adds to it', () => {
    // The preview profile declares only what 7.7 ADDS. Without inheritance it
    // would look as though 7.7 has one command, which is the failure the whole
    // delta-profile design exists to avoid.
    const lts = resolveProfile(LTS, map);
    const preview = resolveProfile(PREVIEW, map);
    assert.ok(Object.keys(lts.commands).length > 40);
    assert.ok(
      Object.keys(preview.commands).length > Object.keys(lts.commands).length,
      'the preview must have MORE commands than its parent, not fewer',
    );
    assert.ok('New-TemporaryDirectory' in preview.commands, '7.7 adds New-TemporaryDirectory');
    assert.ok('Get-ChildItem' in preview.commands, 'and keeps everything it inherited');
  });

  it('lets the derived profile override every behaviour it declares', () => {
    const lts = compatibilityView(resolveProfile(LTS, map), { strict: true });
    const preview = compatibilityView(resolveProfile(PREVIEW, map), { strict: true });

    // The behaviour that matters most: New-Guid's default UUID version.
    assert.equal(lts.behavior('newGuid.defaultVersion', 0), 4);
    assert.equal(preview.behavior('newGuid.defaultVersion', 0), 7);

    // And the switch-parameter family, which is TEN upstream PRs, each fixing
    // named switches on one cmdlet — so the key is scoped to a command AND a
    // parameter rather than being one engine-wide boolean.
    const empty = switchBehaviorKey('New-Guid', 'Empty');
    assert.equal(lts.behavior(empty, true), false);
    assert.equal(preview.behavior(empty, false), true);

    // A pair upstream never touched is declared by neither profile, and asking
    // through the scoped lookup answers "honour it" — which is what the
    // reference binder measurably does in both lines.
    const untouched = switchBehaviorKey('Get-ChildItem', 'Force');
    for (const view of [lts, preview]) {
      assert.equal(view.scopedBehavior(untouched, true), true);
      assert.equal(view.scopedBehavior(untouched, false), false, 'undeclared: the fallback answers');
    }
  });

  it('makes the two profiles actually differ', () => {
    // If every behaviour resolved the same, the compatibility layer would be a
    // no-op that still looked like it was working.
    const lts = resolveProfile(LTS, map);
    const preview = resolveProfile(PREVIEW, map);
    const differing = Object.keys(preview.behaviors).filter(
      (k) => preview.behaviors[k] !== lts.behaviors[k],
    );
    assert.ok(differing.length > 0, 'the profiles must differ somewhere');
  });
});

describe('failure modes', () => {
  const base: StoredProfile = {
    schemaVersion: 1,
    profile: 'test/base/linux',
    channel: 'lts',
    displayVersion: '1.0.0',
    inherits: null,
    behaviors: { 'a.flag': true, 'a.unset': null },
  };

  it('detects an inheritance cycle instead of hanging', () => {
    // Undetected, this is an infinite loop at session start: a blank page with
    // no message.
    const x: StoredProfile = { ...base, profile: 'x', inherits: 'y' };
    const y: StoredProfile = { ...base, profile: 'y', inherits: 'x' };
    assert.throws(
      () => resolveProfile('x', profileMap([x, y])),
      (e: unknown) => e instanceof ProfileResolutionError && /cycle/.test((e as Error).message),
    );
  });

  it('names the profile that referenced a missing parent', () => {
    const child: StoredProfile = { ...base, profile: 'child', inherits: 'nowhere' };
    assert.throws(
      () => resolveProfile('child', profileMap([child])),
      (e: unknown) => e instanceof ProfileResolutionError && /nowhere/.test((e as Error).message),
    );
  });

  it('rejects duplicate profile ids', () => {
    assert.throws(() => profileMap([base, { ...base }]), ProfileResolutionError);
  });

  it('throws on an undeclared behaviour key in strict mode', () => {
    // A typo in a behaviour key would otherwise make a command behave like an
    // older version forever, silently.
    const view = compatibilityView(resolveProfile('test/base/linux', profileMap([base])), {
      strict: true,
    });
    assert.equal(view.behavior('a.flag', false), true);
    assert.throws(() => view.behavior('a.typo', false), ProfileResolutionError);
  });

  it('falls back rather than throwing at runtime, but reports the key', () => {
    const seen: string[] = [];
    const view = compatibilityView(resolveProfile('test/base/linux', profileMap([base])), {
      strict: false,
      onUnknownKey: (k) => seen.push(k),
    });
    assert.equal(view.behavior('a.typo', 'fallback'), 'fallback');
    assert.deepEqual(seen, ['a.typo'], 'a mistyped key must not be silent');
  });

  it('treats a declared null as "no opinion" rather than as a value', () => {
    const view = compatibilityView(resolveProfile('test/base/linux', profileMap([base])), {
      strict: true,
    });
    assert.equal(view.behavior('a.unset', 99), 99);
  });
});

// ---------------------------------------------------------------------------
// merge semantics, which the schema promised and the resolver did not deliver
// ---------------------------------------------------------------------------

describe('command patches merge the way the schema says they do', () => {
  // The resolver used to do `Object.assign(commands, profile.commands)`, which
  // REPLACES a whole command entry. The schema said command patches are
  // deep-merged. A derived profile touching one field of an inherited command
  // therefore dropped every other field that command had — and with the preview
  // profile's commands now able to carry `parameterPatches`, a 7.7 entry for an
  // existing 7.6 cmdlet would have erased its `availability` and made a present
  // command look undeclared.
  const parent: StoredProfile = {
    schemaVersion: 1,
    profile: 'test/parent/linux',
    channel: 'lts',
    displayVersion: '1.0.0',
    inherits: null,
    behaviors: {},
    commands: {
      'Get-Thing': {
        availability: 'available',
        notes: 'from the parent',
        parameterPatches: {
          Force: { switchSemantics: 'boolean-value' },
          Path: { validation: ['ValidateNotNullOrEmpty'] },
        },
      },
      'Only-Parent': { availability: 'available' },
    },
  };

  const child: StoredProfile = {
    ...parent,
    profile: 'test/child/linux',
    inherits: 'test/parent/linux',
    commands: {
      'Get-Thing': {
        // States ONLY what differs, which is the entire point of a delta profile.
        parameterPatches: { Force: { switchSemantics: 'presence' } },
      },
      'Only-Child': { availability: 'added', since: '2.0.0' },
    },
  };

  const resolved = resolveProfile('test/child/linux', profileMap([parent, child]));
  const thing = resolved.commands['Get-Thing'];

  it('keeps inherited fields the child did not mention', () => {
    assert.equal(thing?.availability, 'available', 'a present command must not become undeclared');
    assert.equal(thing?.notes, 'from the parent');
  });

  it('keeps inherited parameter patches the child did not mention', () => {
    assert.deepEqual(thing?.parameterPatches?.['Path'], {
      validation: ['ValidateNotNullOrEmpty'],
    });
  });

  it('lets the child override the parameter it does mention', () => {
    assert.deepEqual(thing?.parameterPatches?.['Force'], { switchSemantics: 'presence' });
  });

  it('keeps commands each side declares alone', () => {
    assert.equal(resolved.commands['Only-Parent']?.availability, 'available');
    assert.equal(resolved.commands['Only-Child']?.availability, 'added');
  });

  it('expresses removal as data, so deep merge cannot swallow a deletion', () => {
    // The argument against deep merge is that a child cannot REMOVE an
    // inherited entry. The schema answers it: removal is availability
    // "removed" plus removedIn — a value the child states, rather than an
    // absence it hopes somebody notices.
    const remover: StoredProfile = {
      ...child,
      profile: 'test/remover/linux',
      commands: { 'Only-Parent': { availability: 'removed', removedIn: '2.0.0' } },
    };
    const r = resolveProfile('test/remover/linux', profileMap([parent, remover]));
    assert.equal(r.commands['Only-Parent']?.availability, 'removed');
    assert.equal(r.commands['Only-Parent']?.removedIn, '2.0.0');
  });
});

// ---------------------------------------------------------------------------
// prototype pollution, for the third time in this repository
// ---------------------------------------------------------------------------

describe('a parsed profile cannot reach Object.prototype', () => {
  // Object.assign(target, parsed) uses [[Set]]. An own __proto__ key in a
  // profile file therefore invoked the prototype SETTER: the key vanished from
  // Object.keys while lookups started resolving through attacker-supplied data.
  // The old VFS and Select-Object were bitten by the same shape. Note the
  // constraint from src/kernel/protocol.ts that ruled out the obvious fix:
  // structuredClone NORMALISES a null prototype back to Object.prototype, so
  // Object.create(null) would not survive a worker boundary. fromEntries
  // DEFINES each key and keeps Object.prototype, so what survives the clone is
  // what was tested.
  //
  // JSON.parse is used deliberately: in an object literal, __proto__: is the
  // setter at parse time and cannot construct the hostile input at all.
  const hostileText =
    '{"schemaVersion":1,"profile":"test/evil/linux","channel":"lts","displayVersion":"1.0.0",' +
    '"inherits":null,"behaviors":{"__proto__":{"polluted":"yes"},"ok.flag":true},' +
    '"commands":{"__proto__":{"polluted":"yes"},"Get-Thing":{"availability":"available"}}}';
  const hostile = JSON.parse(hostileText) as StoredProfile;

  it('does not pollute Object.prototype', () => {
    const resolved = resolveProfile('test/evil/linux', profileMap([hostile]));
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
    assert.equal((resolved.behaviors as Record<string, unknown>)['polluted'], undefined);
    assert.equal(Object.getPrototypeOf(resolved.behaviors), Object.prototype, 'still a plain object');
  });

  it('keeps the hostile key as an ordinary own property instead of losing it', () => {
    // The tell that the setter fired is a key that disappears. Defining it means
    // it is visible, inert, and reportable.
    const resolved = resolveProfile('test/evil/linux', profileMap([hostile]));
    assert.ok(Object.hasOwn(resolved.behaviors, '__proto__'));
    assert.ok(Object.hasOwn(resolved.commands, '__proto__'));
    assert.ok(Object.keys(resolved.behaviors).includes('ok.flag'));
  });

  it('survives structuredClone with the same shape, which a null prototype would not', () => {
    const resolved = resolveProfile('test/evil/linux', profileMap([hostile]));
    const clone = structuredClone({ behaviors: { ...resolved.behaviors } });
    assert.equal(Object.getPrototypeOf(clone.behaviors), Object.prototype);
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
  });
});

// ---------------------------------------------------------------------------
// the cast that was not a check
// ---------------------------------------------------------------------------

describe('a declared value whose type disagrees with the caller is an error', () => {
  // behavior<T> ended in `value as T` — an assertion over data parsed from a
  // JSON file. A profile carrying "newGuid.defaultVersion": "7" handed New-Guid
  // a string where it had typed a number, and the mismatch surfaced wherever the
  // value was eventually used rather than where it entered.
  const wrong: StoredProfile = {
    schemaVersion: 1,
    profile: 'test/wrong/linux',
    channel: 'lts',
    displayVersion: '1.0.0',
    inherits: null,
    behaviors: { 'newGuid.defaultVersion': '7', 'a.flag': true },
  };
  const view = compatibilityView(resolveProfile('test/wrong/linux', profileMap([wrong])));

  it('throws instead of returning a string typed as a number', () => {
    assert.throws(
      () => view.behavior('newGuid.defaultVersion', 4),
      (e: unknown) =>
        e instanceof ProfileResolutionError && /declared as string/.test(e.message) &&
        /read as number/.test(e.message),
    );
  });

  it('throws under the scoped lookup too, where absence is otherwise fine', () => {
    assert.throws(() => view.scopedBehavior('newGuid.defaultVersion', 4), ProfileResolutionError);
  });

  it('does not soften to the fallback in non-strict mode', () => {
    // An unknown key has a safe answer — the older version's behaviour. A key
    // declared as the wrong type does not: the caller has already typed its
    // variable.
    const lenient = compatibilityView(resolveProfile('test/wrong/linux', profileMap([wrong])), {
      strict: false,
    });
    assert.throws(() => lenient.behavior('newGuid.defaultVersion', 4), ProfileResolutionError);
  });

  it('still accepts a value whose type matches', () => {
    assert.equal(view.behavior('a.flag', false), true);
  });
});

// ---------------------------------------------------------------------------
// immutability
// ---------------------------------------------------------------------------

describe('the resolved profile cannot be edited by a command', () => {
  // Commands receive the profile on every invocation. One command mutating a
  // behaviour would silently reconfigure the session for every command after
  // it, and the symptom would appear in an unrelated command later.
  const map = profileMap(loadRealProfiles());
  const resolved = resolveProfile(PREVIEW, map);

  it('freezes the behaviour table', () => {
    assert.ok(Object.isFrozen(resolved.behaviors));
    assert.throws(() => {
      (resolved.behaviors as Record<string, unknown>)['newGuid.defaultVersion'] = 4;
    }, TypeError);
  });

  it('freezes NESTED patch objects, not just the top level', () => {
    // Shallow freezing looks right and protects nothing that matters: the
    // interesting values are one level down.
    const command = Object.values(resolved.commands)[0];
    assert.ok(command !== undefined);
    assert.ok(Object.isFrozen(command));
  });

  it('freezes the lineage array', () => {
    assert.ok(Object.isFrozen(resolved.lineage));
    assert.throws(() => (resolved.lineage as string[]).push('nope'), TypeError);
  });
});

// ---------------------------------------------------------------------------
// found by attacking the resolver: the generator's gate is not the only gate
// ---------------------------------------------------------------------------

describe('an unemulated key cannot be made executable by editing a profile', () => {
  // The generator refuses to WRITE such a profile. That is a build step, and a
  // profile can be hand-edited, half-merged, or served from somewhere the build
  // never saw. Attacking this module with a key pasted into `behaviors` got it
  // handed straight to behavior() and answered as a live semantic — the exact
  // defect the documented/emulated split exists to prevent.
  const tampered: StoredProfile = {
    schemaVersion: 1,
    profile: 'test/tampered/linux',
    channel: 'lts',
    displayVersion: '1.0.0',
    inherits: null,
    behaviors: { 'smuggled.flag': true },
    documentedBehaviors: { 'smuggled.flag': { emulated: false, implementation: 'documented' } },
  };

  it('throws at resolve time, naming the key and the profile', () => {
    assert.throws(
      () => resolveProfile('test/tampered/linux', profileMap([tampered])),
      (e: unknown) =>
        e instanceof ProfileResolutionError &&
        /smuggled\.flag/.test(e.message) &&
        /test\/tampered\/linux/.test(e.message),
    );
  });

  it('catches it in an INHERITED profile too, not only the one asked for', () => {
    const child: StoredProfile = {
      ...tampered,
      profile: 'test/tampered-child/linux',
      inherits: 'test/tampered/linux',
      behaviors: {},
      documentedBehaviors: {},
    };
    assert.throws(
      () => resolveProfile('test/tampered-child/linux', profileMap([tampered, child])),
      ProfileResolutionError,
    );
  });

  it('allows a profile that makes no documented claim to check against', () => {
    // Synthetic fixtures carry no documentedBehaviors. Absence is not a licence
    // — the schema requires the section, so a REAL profile missing it fails
    // `npm run profiles -- --check` — but the resolver has nothing to compare.
    const plain: StoredProfile = {
      schemaVersion: 1,
      profile: 'test/plain/linux',
      channel: 'lts',
      displayVersion: '1.0.0',
      inherits: null,
      behaviors: { 'a.flag': true },
    };
    assert.doesNotThrow(() => resolveProfile('test/plain/linux', profileMap([plain])));
  });

  it('lets the real profiles through, which is the case that must not regress', () => {
    const map = profileMap(loadRealProfiles());
    assert.doesNotThrow(() => resolveProfile(PREVIEW, map));
    assert.doesNotThrow(() => resolveProfile(LTS, map));
  });
});
