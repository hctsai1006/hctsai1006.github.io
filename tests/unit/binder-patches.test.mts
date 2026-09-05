/**
 * Profile `parameterPatches`, applied over captured metadata.
 *
 * ── WHAT THIS TESTS AND WHY IT DID NOT EXIST BEFORE ───────────────────────
 *
 * `compat/schemas/compatibility-profile.schema.json` has carried
 * `commands.<Name>.parameterPatches.<Parameter>` for a while, and
 * `profile-resolver.ts` merges them per parameter — `profile-resolver.test.mts`
 * proves the merge. What did not exist was anything that APPLIED one. The data
 * could be declared, inherited, merged and read, and then nothing consumed it,
 * so `Get-Item -Path` behaved identically under every profile no matter what
 * the profile said about it. Neither shipped profile declares a patch, which is
 * why nothing looked broken.
 *
 * ── THE CONFLICT GATE ─────────────────────────────────────────────────────
 *
 * Applying patches creates a hazard the repository has been bitten by six times:
 * switch semantics can now be spelled twice, once as a behaviour key and once as
 * `switchSemantics`. The gate is that `switchHonoursExplicitFalse` is the single
 * decision and THROWS on a disagreement rather than picking a winner — because
 * whichever it picked would be right by accident.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ParameterPatchError,
  applyParameterPatches,
  switchHonoursExplicitFalse,
} from '../../src/binding/patches.ts';
import { tryBindParameters } from '../../src/binding/binder.ts';
import { viewOfBehaviors } from '../../src/compatibility/profile-resolver.ts';
import type { CommandManifest, ParameterMetadata } from '../../src/commands/manifest.ts';

const parameter = (
  name: string,
  extra: Partial<ParameterMetadata> = {},
): ParameterMetadata => ({
  name,
  aliases: [],
  type: 'System.String',
  isSwitch: false,
  sets: { __AllParameterSets: { position: null, mandatory: false, valueFromPipeline: false } },
  mandatoryInAnySet: false,
  mandatoryInEverySet: false,
  firstPosition: null,
  valueFromPipelineInAnySet: false,
  validation: [],
  verified: true,
  ...extra,
});

const manifestOf = (parameters: readonly ParameterMetadata[]): CommandManifest => ({
  name: 'test-command',
  display: 'Test-Command',
  aliases: [],
  runtime: 'semantic',
  fidelity: 'native-semantic',
  risk: 'read',
  capabilities: [],
  parameters,
  outputTypeNames: [],
  synopsis: 'A manifest for testing patches.',
  parameterSource: 'reference-implementation',
  implementationStatus: 'implemented',
});

const view = (behaviors: Record<string, boolean> = {}) => viewOfBehaviors('7.6.5', behaviors);

describe('applying parameterPatches over captured metadata', () => {
  it('changes nothing when there are no patches', () => {
    const manifest = manifestOf([parameter('Path')]);
    const report = applyParameterPatches(manifest, undefined);
    assert.equal(report.manifest, manifest);
    assert.deepEqual(report.applied, []);
    assert.deepEqual(report.unapplied, []);
  });

  it('removes a parameter the profile says this version does not have', () => {
    const manifest = manifestOf([parameter('Path'), parameter('Gone')]);
    const report = applyParameterPatches(manifest, { Gone: { removed: true } });
    assert.deepEqual(report.manifest.parameters.map((p) => p.name), ['Path']);
    assert.deepEqual(report.applied, ['Gone:removed']);
  });

  it('makes a removed parameter unbindable, which is the whole point', () => {
    // Without the patch this binds. The patch is what makes the version
    // difference observable, and it does it without forking the command.
    const manifest = manifestOf([parameter('Path'), parameter('Gone')]);

    const unpatched = tryBindParameters(['-Gone', 'x'], manifest, view());
    assert.equal(unpatched.ok, true);

    const patched = tryBindParameters(['-Gone', 'x'], manifest, view(), {
      parameterPatches: { Gone: { removed: true } },
    });
    assert.equal(patched.ok, false);
    if (patched.ok) return;
    assert.equal(patched.error.kind, 'NamedParameterNotFound');
  });

  it('replaces validation attributes rather than merging them', () => {
    const manifest = manifestOf([parameter('Count', { validation: ['ValidateNotNull'] })]);
    const report = applyParameterPatches(manifest, {
      Count: { validation: ['ValidateRange'] },
    });
    assert.deepEqual(report.manifest.parameters[0]?.validation, ['ValidateRange']);
    assert.deepEqual(report.applied, ['Count:validation']);
  });

  it('matches parameter names case-insensitively, as PowerShell does', () => {
    const manifest = manifestOf([parameter('Path')]);
    const report = applyParameterPatches(manifest, { pATH: { removed: true } });
    assert.deepEqual(report.manifest.parameters, []);
  });

  it('never mutates the manifest it was given', () => {
    // The manifests are module-level constants shared by every invocation; one
    // patched manifest leaking back would reconfigure the whole session.
    const original = parameter('Count', { validation: ['ValidateNotNull'] });
    const manifest = manifestOf([original]);
    applyParameterPatches(manifest, { Count: { validation: ['ValidateRange'] } });
    assert.deepEqual(manifest.parameters[0]?.validation, ['ValidateNotNull']);
    assert.equal(manifest.parameters[0], original);
  });

  it('REPORTS a patch it cannot honour instead of dropping it', () => {
    // This project does not invent parameter metadata: there is no type, no
    // parameter set and no position to give a parameter that was never
    // captured. Saying so is the honest answer; silence would make the profile
    // look like it was doing something it was not.
    const manifest = manifestOf([parameter('Path')]);
    const report = applyParameterPatches(manifest, { Brand: { added: true } });
    assert.deepEqual(report.manifest.parameters.map((p) => p.name), ['Path']);
    assert.equal(report.unapplied.length, 1);
    assert.match(report.unapplied[0] ?? '', /Brand/u);
    assert.match(report.unapplied[0] ?? '', /does not invent parameter metadata/u);
    assert.match(report.unapplied[0] ?? '', /npm run capture:metadata/u);
  });

  it('surfaces the unapplied patches on the binding result', () => {
    const manifest = manifestOf([parameter('Path')]);
    const bound = tryBindParameters(['-Path', 'x'], manifest, view(), {
      parameterPatches: { Brand: { added: true } },
    });
    assert.equal(bound.ok, true);
    if (!bound.ok) return;
    assert.equal(bound.result.unappliedPatches.length, 1);
  });

  it('notices switchSemantics declared for something that is not a switch', () => {
    const manifest = manifestOf([parameter('Path')]);
    const report = applyParameterPatches(manifest, {
      Path: { switchSemantics: 'presence' },
    });
    assert.equal(report.unapplied.length, 1);
    assert.match(report.unapplied[0] ?? '', /not a switch/u);
  });
});

describe('switch semantics have exactly one decision point', () => {
  const manifest = manifestOf([parameter('Shuffle', { isSwitch: true, type: 'SwitchParameter' })]);
  const shuffle = manifest.parameters[0]!;
  const key = 'switchParameter.Test-Command.Shuffle.honourExplicitFalse';

  it('honours the value when neither spelling is declared', () => {
    // Measured: pwsh 7.6.5's binder already binds -Force:$false to False with
    // ContainsKey true. A pair no upstream PR ever fixed behaves that way in
    // both lines.
    assert.equal(switchHonoursExplicitFalse(manifest, shuffle, view(), undefined), true);
  });

  it('reads the behaviour key when only that is declared', () => {
    assert.equal(switchHonoursExplicitFalse(manifest, shuffle, view({ [key]: false }), undefined), false);
  });

  it('reads switchSemantics when only that is declared', () => {
    assert.equal(
      switchHonoursExplicitFalse(manifest, shuffle, view(), {
        Shuffle: { switchSemantics: 'presence' },
      }),
      false,
    );
    assert.equal(
      switchHonoursExplicitFalse(manifest, shuffle, view(), {
        Shuffle: { switchSemantics: 'boolean-value' },
      }),
      true,
    );
  });

  it('accepts both spellings when they agree', () => {
    assert.equal(
      switchHonoursExplicitFalse(manifest, shuffle, view({ [key]: false }), {
        Shuffle: { switchSemantics: 'presence' },
      }),
      false,
    );
  });

  it('THROWS when the two spellings disagree, rather than picking a winner', () => {
    // The gate. One fact spelled twice is how five earlier defects in this
    // repository began; each was found only by comparing the copies. Picking a
    // winner here would make the engine right by accident.
    assert.throws(
      () =>
        switchHonoursExplicitFalse(manifest, shuffle, view({ [key]: true }), {
          Shuffle: { switchSemantics: 'presence' },
        }),
      (error: unknown) => {
        assert.ok(error instanceof ParameterPatchError);
        assert.match(error.message, /disagree/u);
        assert.match(error.message, new RegExp(key.replace(/\./gu, '\\.'), 'u'));
        assert.match(error.message, /right by accident/u);
        return true;
      },
    );
  });

  it('drives what the binder actually binds', () => {
    // End to end: the patch alone changes the bound value.
    const asPresence = tryBindParameters(['-Shuffle:$false'], manifest, view(), {
      parameterPatches: { Shuffle: { switchSemantics: 'presence' } },
    });
    assert.equal(asPresence.ok, true);
    if (!asPresence.ok) return;
    assert.equal(asPresence.result.parameters['Shuffle'], true);
    // The intent is never lost, under either semantics.
    assert.deepEqual(asPresence.result.explicitlyFalseSwitches, ['Shuffle']);

    const asValue = tryBindParameters(['-Shuffle:$false'], manifest, view(), {
      parameterPatches: { Shuffle: { switchSemantics: 'boolean-value' } },
    });
    assert.equal(asValue.ok, true);
    if (!asValue.ok) return;
    assert.equal(asValue.result.parameters['Shuffle'], false);
  });

  it('still tells -Switch:$false from -Switch absent', () => {
    // The distinction the whole switchSemantics model exists for.
    const absent = tryBindParameters([], manifest, view());
    assert.equal(absent.ok, true);
    if (!absent.ok) return;
    assert.equal(Object.hasOwn(absent.result.parameters, 'Shuffle'), false);

    const explicit = tryBindParameters(['-Shuffle:$false'], manifest, view());
    assert.equal(explicit.ok, true);
    if (!explicit.ok) return;
    assert.equal(Object.hasOwn(explicit.result.parameters, 'Shuffle'), true);
    assert.equal(explicit.result.parameters['Shuffle'], false);
  });
});
