/**
 * A recorded differential against pwsh 7.6.5.
 *
 * The other test files assert rules one at a time. This one asserts the whole
 * binder at once, against a transcript taken from the reference implementation
 * rather than from anybody's understanding of it.
 *
 * The transcript below is the literal output of running these forty argument
 * lists through a pwsh 7.6.5 advanced function with the same parameter
 * declaration as the fixture in this file, printing `$PSCmdlet.ParameterSetName`
 * and a sorted `$PSBoundParameters` on success, and the error id plus
 * `$_.Exception.ParameterName` on failure. What matters is that these strings
 * were MEASURED, not derived.
 *
 * The result, which is the strongest single claim this binder can make:
 *
 *   under BOTH profiles the binder reproduces pwsh 7.6.5 EXACTLY on all forty
 *   cases.
 *
 * It used to be forty under 7.7 and thirty-nine under 7.6, with the
 * `-Force:$false` case diverging on purpose: the engine-wide
 * `switchParameters.honourExplicitFalse` flag made the 7.6 profile bind
 * Force=true. That divergence was a defect, not a design. `Test-Diff` is a
 * synthetic advanced function, and none of the ten upstream 7.7 PRs that
 * corrected explicit `:$false` handling touch anything like it — they each fix
 * NAMED switches on ONE cmdlet. Measured 2026-09-05, pwsh 7.6.5 binds
 * `-Force:$false` to False with the key present, exactly as the transcript
 * below records. Scoping the flag to the pairs upstream actually fixed removed
 * the divergence and made the claim stronger: forty for forty, both ways.
 *
 * The per-cmdlet behaviour that flag was standing in for is proved where it
 * belongs, in tests/unit/binder-switch-scope.test.mts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { CompatibilityView } from '../../src/commands/invocation.ts';
import type { CommandManifest, ParameterMetadata, ParameterSetBinding } from '../../src/commands/manifest.ts';
import { tryBindParameters } from '../../src/binding/index.ts';
import { viewOfBehaviors } from '../../src/compatibility/profile-resolver.ts';

function profileView(file: string): CompatibilityView {
  const raw = JSON.parse(
    readFileSync(new URL(`../../compat/profiles/${file}`, import.meta.url), 'utf8'),
  ) as { displayVersion?: string; behaviors?: Record<string, boolean | number | string> };
  return viewOfBehaviors(raw.displayVersion ?? '?', raw.behaviors ?? {});
}

const V76 = profileView('powershell-7.6.5-linux.json');
const V77 = profileView('powershell-7.7.0-preview.4-linux.json');

const ALL = '__AllParameterSets';
const set = (over: Partial<ParameterSetBinding> = {}): ParameterSetBinding => ({
  position: null,
  mandatory: false,
  valueFromPipeline: false,
  ...over,
});

function param(
  name: string,
  type: string,
  sets: Record<string, ParameterSetBinding>,
  extra: { aliases?: readonly string[]; isSwitch?: boolean; validation?: readonly string[] } = {},
): ParameterMetadata {
  return {
    name,
    aliases: extra.aliases ?? [],
    type,
    isSwitch: extra.isSwitch ?? false,
    sets,
    mandatoryInAnySet: Object.values(sets).some((s) => s.mandatory),
    mandatoryInEverySet: Object.values(sets).every((s) => s.mandatory),
    firstPosition:
      Object.values(sets)
        .map((s) => s.position)
        .find((p) => p !== null) ?? null,
    valueFromPipelineInAnySet: Object.values(sets).some((s) => s.valueFromPipeline),
    validation: extra.validation ?? [],
    verified: false,
  };
}

/**
 * The exact shape of the pwsh function the transcript came from:
 *
 *   [CmdletBinding(DefaultParameterSetName='ByPath')]
 *   param(
 *     [Parameter(ParameterSetName='ByPath', Position=0)] [string[]] $Path,
 *     [Parameter(ParameterSetName='ByLiteral', Mandatory)] [Alias('PSPath','LP')] [string[]] $LiteralPath,
 *     [Parameter(Position=1)] [int] $Count,
 *     [Parameter(Position=2)] [string] $Filter,
 *     [switch] $Force,
 *     [string] $Pattern,
 *     [ValidateSet('CoreOnly','EnumOnly','Both')] [string] $Expand,
 *     [ValidateRange(0,100)] [int] $Depth)
 */
const TEST_DIFF: CommandManifest = {
  name: 'test-diff',
  display: 'Test-Diff',
  aliases: [],
  runtime: 'semantic',
  fidelity: 'native-semantic',
  risk: 'read',
  capabilities: [],
  parameters: [
    param('Path', 'System.String[]', { ByPath: set({ position: 0, valueFromPipeline: true }) }),
    param(
      'LiteralPath',
      'System.String[]',
      { ByLiteral: set({ mandatory: true }) },
      { aliases: ['PSPath', 'LP'] },
    ),
    param('Count', 'System.Int32', { [ALL]: set({ position: 1 }) }),
    param('Filter', 'System.String', { [ALL]: set({ position: 2 }) }),
    param('Force', 'System.Management.Automation.SwitchParameter', { [ALL]: set() }, {
      isSwitch: true,
    }),
    param('Pattern', 'System.String', { [ALL]: set() }),
    param('Expand', 'System.String', { [ALL]: set() }, {
      validation: ["ValidateSet('CoreOnly','EnumOnly','Both')"],
    }),
    param('Depth', 'System.Int32', { [ALL]: set() }, { validation: ['ValidateRange(0,100)'] }),
  ],
  outputTypeNames: [],
  synopsis: 'differential fixture',
  parameterSource: 'declared',
  implementationStatus: 'implemented',
};

/** The same rendering the pwsh probe used, so the two are comparable. */
function render(args: readonly string[], profile: CompatibilityView): string {
  const outcome = tryBindParameters(args, TEST_DIFF, profile, { defaultParameterSet: 'ByPath' });
  if (!outcome.ok) {
    return `ERR|${outcome.error.kind}|${outcome.error.parameterName ?? ''}`;
  }
  const shown = Object.keys(outcome.result.parameters)
    .sort()
    .map((key) => {
      const value = outcome.result.parameters[key];
      return `${key}=${Array.isArray(value) ? `[${value.map(String).join(',')}]` : String(value)}`;
    });
  return `OK|${outcome.result.parameterSet}|${shown.join(';')}`;
}

/** Argument list → what pwsh 7.6.5 actually did with it. */
const TRANSCRIPT: readonly (readonly [readonly string[], string])[] = [
  [['-Path', 'a'], 'OK|ByPath|Path=[a]'],
  [['-path', 'a'], 'OK|ByPath|Path=[a]'],
  [['-Pat', 'a'], 'ERR|AmbiguousParameter|Pat'],
  [['-Fi', 'f'], 'OK|ByPath|Filter=f'],
  [['-Fo'], 'OK|ByPath|Force=true'],
  [['-LP', 'z'], 'OK|ByLiteral|LiteralPath=[z]'],
  [['-PSP', 'z'], 'OK|ByLiteral|LiteralPath=[z]'],
  [['a', '5', 'f'], 'OK|ByPath|Count=5;Filter=f;Path=[a]'],
  [['a', '-Count', '5'], 'OK|ByPath|Count=5;Path=[a]'],
  [['-Count', '5', 'a'], 'OK|ByPath|Count=5;Path=[a]'],
  [['a', 'b'], 'ERR|ParameterArgumentTransformationError|Count'],
  [['a', '5', 'f', 'extra'], 'ERR|PositionalParameterNotFound|extra'],
  [['-Path', 'a', '-LiteralPath', 'b'], 'ERR|AmbiguousParameterSet|'],
  [['-LiteralPath', 'z', '5'], 'OK|ByLiteral|Count=5;LiteralPath=[z]'],
  [['-LiteralPath', 'z', 'a'], 'ERR|ParameterArgumentTransformationError|Count'],
  [['-Force:$false'], 'OK|ByPath|Force=false'],
  [['-Force:$true'], 'OK|ByPath|Force=true'],
  [['-Force'], 'OK|ByPath|Force=true'],
  [['-Force', 'x'], 'OK|ByPath|Force=true;Path=[x]'],
  [['-Count', '-5'], 'OK|ByPath|Count=-5'],
  [['1', '-5'], 'OK|ByPath|Count=-5;Path=[1]'],
  [['-Path', '-abc'], 'OK|ByPath|Path=[-abc]'],
  [['-Nope', 'a'], 'ERR|NamedParameterNotFound|Nope'],
  [['-Path', 'a', '-Path', 'b'], 'ERR|ParameterAlreadyBound|Path'],
  [['-Count'], 'ERR|MissingArgument|Count'],
  [['-Expand', 'nope'], 'ERR|ParameterArgumentValidationError|Expand'],
  [['-Expand', 'coreonly'], 'OK|ByPath|Expand=coreonly'],
  [['-Depth', '101'], 'ERR|ParameterArgumentValidationError|Depth'],
  [['-Depth', '5.5'], 'OK|ByPath|Depth=6'],
  [['-Depth', '2.5'], 'OK|ByPath|Depth=2'],
  [['-Depth', '0x10'], 'OK|ByPath|Depth=16'],
  [['-Count', '1,000'], 'OK|ByPath|Count=1000'],
  [['-Count', ''], 'OK|ByPath|Count=0'],
  [['-Count', 'abc'], 'ERR|ParameterArgumentTransformationError|Count'],
  [['-Count', '2147483648'], 'ERR|ParameterArgumentTransformationError|Count'],
  [[], 'OK|ByPath|'],
  [['-Force:0'], 'ERR|ParameterArgumentTransformationError|Force'],
  [['-Depth', '-1'], 'ERR|ParameterArgumentValidationError|Depth'],
  [['-Filter', 'f', '-Path', 'p'], 'OK|ByPath|Filter=f;Path=[p]'],
  [['-Ex', 'Both'], 'OK|ByPath|Expand=Both'],
];

describe('differential against pwsh 7.6.5', () => {
  it('reproduces the reference exactly under the 7.7 profile', () => {
    for (const [args, expected] of TRANSCRIPT) {
      assert.equal(render(args, V77), expected, `Test-Diff ${args.join(' ')}`);
    }
    assert.equal(TRANSCRIPT.length, 40);
  });

  it('reproduces the reference exactly under the 7.6 profile too, with no exceptions', () => {
    // There used to be one deliberate divergence here. It came from an
    // engine-wide switch flag that has been scoped away; see the header. An
    // empty divergence list is asserted rather than assumed, so a flag that
    // starts applying to every command again fails HERE, naming the case.
    const diverged: string[] = [];
    for (const [args, expected] of TRANSCRIPT) {
      if (render(args, V76) !== expected) diverged.push(args.join(' '));
    }
    assert.deepEqual(diverged, [], 'the 7.6 profile must not invent a difference upstream lacks');
  });

  it('keeps the typed intent recoverable under both profiles', () => {
    for (const profile of [V76, V77]) {
      const outcome = tryBindParameters(['-Force:$false'], TEST_DIFF, profile, {
        defaultParameterSet: 'ByPath',
      });
      assert.equal(outcome.ok, true);
      if (!outcome.ok) return;
      assert.equal(outcome.result.parameters['Force'], false);
      assert.deepEqual(outcome.result.explicitlyFalseSwitches, ['Force']);
    }
  });
});
