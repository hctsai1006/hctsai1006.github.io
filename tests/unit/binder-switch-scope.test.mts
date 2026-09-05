/**
 * binder-switch-scope.test.mts — the explicit `-Switch:$false` behaviour is
 * scoped to the command/parameter pairs upstream actually fixed.
 *
 * WHY THIS FILE EXISTS
 *
 * The binder used to read one engine-wide flag,
 * `switchParameters.honourExplicitFalse`, justified in its own header by
 * "thirteen upstream PRs fixed one design mistake, and modelling that per
 * command would mean thirteen forks". Reading the PRs refutes the premise. They
 * are TEN PRs, each correcting NAMED switches on ONE cmdlet:
 *
 *   #26140 New-Guid -Empty          #26463 Get-TimeZone -ListAvailable
 *   #26141 Get-Uptime -Since        #26469 New-PSSession (six switches)
 *   #26457 Get-Random -Shuffle      #26474 Split-Path -Qualifier/-NoQualifier/-Leaf/-IsAbsolute
 *   #26460 Get-SecureRandom -Shuffle #26479 Test-Connection (ten switches)
 *   #26485 Where-Object (the operator switches)
 *   #26719 ConvertTo-Csv/Export-Csv -NoTypeInformation/-IncludeTypeInformation
 *
 * PowerShell 7.7 therefore still has the OLD behaviour for every switch none of
 * them touched — which the global boolean could not express, and which it got
 * actively wrong: it applied one cmdlet's bug to every switch parameter in the
 * engine, including switches on commands upstream never had a defect in.
 *
 * WHAT WAS MEASURED (pwsh 7.6.5, 2026-09-05, Windows)
 *
 *   The 7.6.5 BINDER honours an explicit `:$false` — for an advanced function
 *   with `[switch] $Force`, `-Force:$false` binds with ContainsKey true,
 *   IsPresent False and ToBool False. Identical to 7.7. So the DEFAULT for an
 *   undeclared pair is "honour the value", in both profiles.
 *
 *   The bug is per cmdlet, in the command body:
 *     New-Guid -Empty:$false                      -> 00000000-0000-0000-0000-000000000000
 *     Get-Random -InputObject (1..6) -Shuffle:$false -SetSeed 1
 *                                                 -> 1,3,5,2,4,6, identical to -Shuffle,
 *                                                    across seeds 1, 2, 7 and 42
 *
 * Those two cmdlets are the ones BrowserShell implements, so they are the two
 * this file proves. The other eight are recorded as `documented` in the curated
 * change list and emit no behaviour key at all: nothing to prove, and nothing
 * that can change what a command does.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { tryBindParameters } from '../../src/binding/index.ts';
import { switchBehaviorKey } from '../../src/compatibility/behavior-keys.ts';
import { viewOfBehaviors } from '../../src/compatibility/profile-resolver.ts';
import type { CompatibilityView, CommandModule } from '../../src/commands/invocation.ts';
import type { BoundParameters } from '../../src/commands/invocation.ts';
import { EMPTY_GUID } from '../../src/commands/native/new-guid.ts';
import { commandsFor, run, prop } from './native-harness.mts';

const PROFILE_DIR = join(import.meta.dirname, '..', '..', 'compat', 'profiles');

interface RawProfile {
  displayVersion?: string;
  behaviors?: Record<string, boolean | number | string>;
  documentedBehaviors?: Record<string, { emulated?: boolean; implementation?: string }>;
}

function raw(file: string): RawProfile {
  return JSON.parse(readFileSync(join(PROFILE_DIR, file), 'utf8')) as RawProfile;
}

const RAW_76 = raw('powershell-7.6.5-linux.json');
const RAW_77 = raw('powershell-7.7.0-preview.4-linux.json');

const view = (r: RawProfile): CompatibilityView =>
  viewOfBehaviors(r.displayVersion ?? '?', r.behaviors ?? {});

const V76 = view(RAW_76);
const V77 = view(RAW_77);

const commands = commandsFor();
function need(name: string): CommandModule {
  const module = commands.get(name);
  assert.ok(module !== undefined, `${name} must exist for this test to mean anything`);
  return module;
}

/** Bind real argument tokens against a command's real manifest. */
function bindArgs(module: CommandModule, args: readonly string[], profile: CompatibilityView) {
  const outcome = tryBindParameters(args, module.manifest, profile);
  assert.equal(outcome.ok, true, `binding ${args.join(' ')} must succeed`);
  if (!outcome.ok) throw new Error('unreachable');
  return outcome.result;
}

describe('the switch-explicit-false behaviour is scoped, not engine-wide', () => {
  it('declares a key per command AND parameter, for the pairs upstream fixed', () => {
    // Declaredness is probed by asking TWICE with opposite fallbacks. A declared
    // key answers the same both times; an undeclared one echoes each fallback.
    // (A string sentinel would be neater and is deliberately not used: the view
    // now refuses a fallback whose type disagrees with the declared value, which
    // is the point of defect 3 in the review — so the probe has to be typed.)
    const declared = (view: CompatibilityView, key: string): boolean | 'undeclared' => {
      // Annotated: without it T infers the literal types `true` and `false`,
      // and the comparison below is rejected as provably never equal.
      const high = view.scopedBehavior<boolean>(key, true);
      const low = view.scopedBehavior<boolean>(key, false);
      return high === low ? high : 'undeclared';
    };

    const empty = switchBehaviorKey('New-Guid', 'Empty');
    const shuffle = switchBehaviorKey('Get-Random', 'Shuffle');

    assert.equal(declared(V76, empty), false, '7.6 has the New-Guid bug');
    assert.equal(declared(V77, empty), true, '7.7 fixed it (PR 26140)');
    assert.equal(declared(V76, shuffle), false, '7.6 has the Get-Random bug');
    assert.equal(declared(V77, shuffle), true, '7.7 fixed it (PR 26457)');

    // And a pair upstream never touched is declared by NEITHER profile.
    const untouched = switchBehaviorKey('Get-ChildItem', 'Force');
    assert.equal(declared(V76, untouched), 'undeclared');
    assert.equal(declared(V77, untouched), 'undeclared');
  });

  it('has no engine-wide flag standing in for those per-cmdlet fixes', () => {
    // The key this replaced. Asserted absent from the real profiles so a merge
    // cannot quietly reintroduce a boolean that changes every switch at once.
    for (const r of [RAW_76, RAW_77]) {
      assert.equal(
        Object.hasOwn(r.behaviors ?? {}, 'switchParameters.honourExplicitFalse'),
        false,
        'an engine-wide switch flag is back in the profile',
      );
    }
  });

  it('leaves an undeclared pair honouring the value under BOTH profiles', () => {
    // What the reference binder measurably does. Under the old global flag the
    // 7.6 profile mis-bound EVERY switch on EVERY command, this one included.
    const getRandom = need('get-random');
    const key = switchBehaviorKey('Get-Random', 'SomeSwitchNobodyFixed');
    for (const profile of [V76, V77]) {
      assert.equal(profile.scopedBehavior(key, true), true, 'undeclared means honoured');
    }
    // `Get-Random -Shuffle` IS declared, so use the profile-free view to show
    // the default path rather than the declared one.
    const bare = viewOfBehaviors('7.6.5', {});
    const bound = bindArgs(getRandom, ['-Shuffle:$false'], bare);
    assert.equal(bound.parameters['Shuffle'], false);
  });

  it('binds New-Guid -Empty:$false as PRESENT under 7.6 and as FALSE under 7.7', () => {
    const newGuid = need('new-guid');
    assert.equal(bindArgs(newGuid, ['-Empty:$false'], V76).parameters['Empty'], true);
    assert.equal(bindArgs(newGuid, ['-Empty:$false'], V77).parameters['Empty'], false);
  });

  it('keeps the typed intent recoverable under both profiles', () => {
    // Modelling 7.6 must not destroy what the user wrote; a diagnostic has to
    // be able to say "you typed :$false and this version ignores it".
    const newGuid = need('new-guid');
    for (const profile of [V76, V77]) {
      assert.deepEqual(bindArgs(newGuid, ['-Empty:$false'], profile).explicitlyFalseSwitches, [
        'Empty',
      ]);
    }
  });

  it('reaches the COMMAND: New-Guid -Empty:$false returns the empty GUID on 7.6 only', async () => {
    // The end the whole mechanism exists for, and the measured pwsh 7.6.5
    // result. A binder-only assertion would pass even if nothing consumed it.
    const newGuid = need('new-guid');
    const behaviors76 = RAW_76.behaviors ?? {};
    const behaviors77 = RAW_77.behaviors ?? {};

    const on76 = await run(
      newGuid,
      bindArgs(newGuid, ['-Empty:$false'], V76).parameters as BoundParameters,
      [],
      { behaviors: behaviors76, displayVersion: '7.6.5' },
    );
    assert.equal(prop(on76.values[0], 'Guid'), EMPTY_GUID, 'pwsh 7.6.5 measurably does this');

    const on77 = await run(
      newGuid,
      bindArgs(newGuid, ['-Empty:$false'], V77).parameters as BoundParameters,
      [],
      { behaviors: behaviors77, displayVersion: '7.7.0-preview.4' },
    );
    assert.notEqual(prop(on77.values[0], 'Guid'), EMPTY_GUID, '7.7 honours the $false');
  });

  it('reaches the COMMAND: Get-Random -Shuffle:$false still shuffles on 7.6 only', async () => {
    const getRandom = need('get-random');
    const input = [1, 2, 3, 4, 5, 6];

    const on76 = await run(
      getRandom,
      bindArgs(getRandom, ['-Shuffle:$false'], V76).parameters as BoundParameters,
      input,
      { behaviors: RAW_76.behaviors ?? {}, displayVersion: '7.6.5' },
    );
    assert.equal(on76.values.length, input.length, 'a whole shuffled sequence, as measured');

    const on77 = await run(
      getRandom,
      bindArgs(getRandom, ['-Shuffle:$false'], V77).parameters as BoundParameters,
      input,
      { behaviors: RAW_77.behaviors ?? {}, displayVersion: '7.7.0-preview.4' },
    );
    assert.equal(on77.values.length, 1, '7.7 honours the $false and draws one');
  });
});

describe('the runtime behaviour table contains only what is emulated', () => {
  // The defect this whole change set exists for. The generator used to filter
  // on `behaviorKey === undefined` and never on the implementation status, so
  // all thirteen documented-but-unemulated flags were written into the profile
  // the engine boots against. Asserted against the REAL generated files, so a
  // regression in the generator fails here and not only in --check.
  const files = readdirSync(PROFILE_DIR).filter((f) => f.endsWith('.json'));

  it('finds profiles to check', () => {
    assert.ok(files.length >= 2);
  });

  for (const file of files) {
    it(`${file}: every executable key is marked emulated`, () => {
      const r = raw(file);
      const documented = r.documentedBehaviors ?? {};
      assert.ok(
        Object.keys(documented).length > 0,
        'documentedBehaviors must exist: it is the half of the record that stays honest',
      );
      for (const key of Object.keys(r.behaviors ?? {})) {
        const record = documented[key];
        assert.ok(record !== undefined, `${key} is executable but undocumented`);
        assert.equal(
          record.emulated,
          true,
          `${key} is readable by a command but is not emulated — a claim served as a semantic`,
        );
        assert.ok(
          record.implementation === 'implemented' || record.implementation === 'verified',
          `${key} has implementation "${String(record.implementation)}", which must not execute`,
        );
      }
    });

    it(`${file}: documented-but-unemulated differences are recorded and unreachable`, () => {
      const r = raw(file);
      const documented = r.documentedBehaviors ?? {};
      const behaviors = r.behaviors ?? {};
      const notEmulated = Object.keys(documented).filter((k) => documented[k]?.emulated !== true);
      assert.ok(
        notEmulated.length > 0,
        'the explorer must still be able to show what we do NOT emulate',
      );
      for (const key of notEmulated) {
        assert.equal(Object.hasOwn(behaviors, key), false, `${key} leaked into execution`);
      }
    });
  }
});
