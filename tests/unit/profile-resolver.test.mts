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

    // And the switch-parameter family, which is thirteen upstream PRs.
    assert.equal(lts.behavior('switchParameters.honourExplicitFalse', true), false);
    assert.equal(preview.behavior('switchParameters.honourExplicitFalse', false), true);
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
