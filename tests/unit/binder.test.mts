/**
 * Tests for the parameter binder.
 *
 * Every expectation here was READ OFF pwsh 7.6.5 with a probe script rather
 * than reasoned about, and the probe that produced it is quoted in a `// pwsh:`
 * comment. That matters more here than anywhere else in the project: parameter
 * binding is full of rules that are *plausible* and wrong, and six of them were
 * wrong in the first draft of this binder.
 *
 * The ones the reference implementation contradicted:
 *
 *   1. `-Force:$false` is bound correctly by the real 7.6.5 BINDER. The 7.6
 *      defect lives in the command bodies, which test presence instead of
 *      value. Modelled here anyway, because this project puts version-awareness
 *      in the binder on purpose.
 *   2. An array-typed positional parameter does not swallow later arguments;
 *      only ValueFromRemainingArguments does.
 *   3. Positional binding skips positions whose parameter the chosen set
 *      excludes, so the first loose argument is not necessarily position 0.
 *   4. The default parameter set beats mandatory satisfiability.
 *   5. `-5` and `--Path` are arguments, not parameter names.
 *   6. `[int]'2.5'` is 2 and `[int]'3.5'` is 4 — .NET rounds half to even.
 *
 * The two compatibility profiles are loaded from `compat/profiles/`, not
 * hand-written, so a test that claims "this falls out of the profile" is
 * actually reading the profile.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { CompatibilityView } from '../../src/commands/invocation.ts';
import type { CommandManifest, ParameterMetadata, ParameterSetBinding } from '../../src/commands/manifest.ts';
import {
  ParameterBindingError,
  bindParameters,
  parseParameterToken,
  resolveParameterName,
  tryBindParameters,
} from '../../src/binding/index.ts';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** A CompatibilityView backed by a real profile file. */
function profileView(file: string): CompatibilityView {
  const raw: unknown = JSON.parse(
    readFileSync(new URL(`../../compat/profiles/${file}`, import.meta.url), 'utf8'),
  );
  const behaviors = (raw as { behaviors?: Record<string, boolean | number | string> }).behaviors ?? {};
  const displayVersion = (raw as { displayVersion?: string }).displayVersion ?? '?';
  return {
    displayVersion,
    behavior<T extends boolean | number | string>(key: string, fallback: T): T {
      const value = behaviors[key];
      return (value === undefined ? fallback : value) as T;
    },
  };
}

const V76 = profileView('powershell-7.6.5-linux.json');
const V77 = profileView('powershell-7.7.0-preview.4-linux.json');

const ALL = '__AllParameterSets';
const anySet = (over: Partial<ParameterSetBinding> = {}): Record<string, ParameterSetBinding> => ({
  [ALL]: { position: null, mandatory: false, valueFromPipeline: false, ...over },
});

function param(
  name: string,
  over: Partial<Omit<ParameterMetadata, 'name'>> = {},
): ParameterMetadata {
  const sets = over.sets ?? anySet();
  return {
    name,
    aliases: over.aliases ?? [],
    type: over.type ?? 'System.String',
    isSwitch: over.isSwitch ?? false,
    sets,
    mandatoryInAnySet: Object.values(sets).some((s) => s.mandatory),
    mandatoryInEverySet: Object.values(sets).every((s) => s.mandatory),
    firstPosition:
      Object.values(sets)
        .map((s) => s.position)
        .find((p) => p !== null) ?? null,
    valueFromPipelineInAnySet: Object.values(sets).some((s) => s.valueFromPipeline),
    validation: over.validation ?? [],
    verified: false,
  };
}

function manifest(display: string, parameters: readonly ParameterMetadata[]): CommandManifest {
  return {
    name: display.toLowerCase(),
    display,
    aliases: [],
    runtime: 'semantic',
    fidelity: 'native-semantic',
    risk: 'read',
    capabilities: [],
    parameters,
    outputTypeNames: [],
    synopsis: 'test fixture',
    parameterSource: 'declared',
  };
}

/** The probe function used throughout: a two-set command with positions. */
const TEST_POS = manifest('Test-Pos', [
  param('Path', { type: 'System.String[]', sets: { ByPath: { position: 0, mandatory: false, valueFromPipeline: true } } }),
  param('LiteralPath', {
    type: 'System.String[]',
    aliases: ['PSPath', 'LP'],
    sets: { ByLiteral: { position: null, mandatory: true, valueFromPipeline: false } },
  }),
  param('Count', { type: 'System.Int32', sets: anySet({ position: 1 }) }),
  param('Filter', { sets: anySet({ position: 2 }) }),
  param('Force', { type: 'System.Management.Automation.SwitchParameter', isSwitch: true }),
]);

const POS_OPTIONS = { defaultParameterSet: 'ByPath' } as const;

/** Bind and return the error, asserting that binding failed at all. */
function failure(
  args: readonly string[],
  target: CommandManifest = TEST_POS,
  profile: CompatibilityView = V76,
  options: Parameters<typeof bindParameters>[3] = POS_OPTIONS,
): ParameterBindingError {
  const outcome = tryBindParameters(args, target, profile, options);
  assert.equal(outcome.ok, false, 'expected binding to fail');
  if (outcome.ok) throw new Error('unreachable');
  return outcome.error;
}

// ---------------------------------------------------------------------------

describe('token classification', () => {
  it('reads -Name, -Name:value and plain arguments', () => {
    assert.deepEqual(parseParameterToken('-Path'), { name: 'Path', attached: null });
    assert.deepEqual(parseParameterToken('-Path:a'), { name: 'Path', attached: 'a' });
    assert.deepEqual(parseParameterToken('-Force:$false'), { name: 'Force', attached: '$false' });
    assert.equal(parseParameterToken('value'), null);
  });

  it('splits at the FIRST colon, so a drive-qualified path survives', () => {
    assert.deepEqual(parseParameterToken('-Path:C:\\x'), { name: 'Path', attached: 'C:\\x' });
  });

  it('treats a negative number as an argument, not a parameter name', () => {
    // pwsh: Test-Pos 1 -5   ->   Path=[1] Count=-5
    assert.equal(parseParameterToken('-5'), null);
    assert.equal(parseParameterToken('-.5'), null);
    const bound = bindParameters(['1', '-5'], TEST_POS, V76, POS_OPTIONS);
    assert.deepEqual(bound.parameters['Path'], ['1']);
    assert.equal(bound.parameters['Count'], -5);
  });

  it('treats a bare dash and a double dash as arguments', () => {
    // pwsh: Test-T -            ->  Path = '-'
    // pwsh: Test-T --Path x     ->  PositionalParameterNotFound on 'x',
    //       because '--Path' itself became the positional value.
    assert.equal(parseParameterToken('-'), null);
    assert.equal(parseParameterToken('--Path'), null);
    const bound = bindParameters(['--Path'], TEST_POS, V76, POS_OPTIONS);
    assert.deepEqual(bound.parameters['Path'], ['--Path']);

    // The probe used a command whose only positional is -Path, so `--Path`
    // filled position 0 and `x` had nowhere left to go.
    const onePosition = manifest('Test-T', [param('Path', { sets: anySet({ position: 0 }) })]);
    const error = failure(['--Path', 'x'], onePosition, V76, {});
    assert.equal(error.kind, 'PositionalParameterNotFound');
    assert.equal(error.message, "A positional parameter cannot be found that accepts argument 'x'.");
  });
});

describe('named parameters', () => {
  it('is case-insensitive', () => {
    // pwsh: Test-Binder -path a / -PATH a  ->  both bind Path
    for (const written of ['-Path', '-path', '-PATH', '-PaTh']) {
      const bound = bindParameters([written, 'a'], TEST_POS, V76, POS_OPTIONS);
      assert.deepEqual(bound.parameters['Path'], ['a']);
    }
  });

  it('binds -Name:value as well as -Name value', () => {
    // pwsh: Test-Sw -Count:5  ->  Count = 5
    assert.equal(bindParameters(['-Count:5'], TEST_POS, V76, POS_OPTIONS).parameters['Count'], 5);
    assert.equal(bindParameters(['-Count', '5'], TEST_POS, V76, POS_OPTIONS).parameters['Count'], 5);
  });

  it('takes the next token as the value even when it looks like a parameter', () => {
    // pwsh: Test-Pos -Path -abc  ->  Path = [-abc]
    const bound = bindParameters(['-Path', '-abc'], TEST_POS, V76, POS_OPTIONS);
    assert.deepEqual(bound.parameters['Path'], ['-abc']);
  });

  it('rejects an unknown name with NamedParameterNotFound', () => {
    // pwsh: Test-Binder -Nope a
    //   A parameter cannot be found that matches parameter name 'Nope'.
    const error = failure(['-Nope', 'a']);
    assert.equal(error.kind, 'NamedParameterNotFound');
    assert.equal(error.fullyQualifiedErrorId, 'NamedParameterNotFound,Test-Pos');
    assert.equal(error.category, 'InvalidArgument');
    assert.equal(error.exceptionTypeName, 'System.Management.Automation.ParameterBindingException');
    assert.equal(error.message, "A parameter cannot be found that matches parameter name 'Nope'.");
  });

  it('rejects a repeated parameter with ParameterAlreadyBound', () => {
    // pwsh: Test-Pos -Path a -Path b
    const error = failure(['-Path', 'a', '-Path', 'b']);
    assert.equal(error.kind, 'ParameterAlreadyBound');
    assert.equal(
      error.message,
      "Cannot bind parameter because parameter 'Path' is specified more than once. " +
        'To provide multiple values to parameters that can accept multiple values, use the array syntax. ' +
        'For example, "-parameter value1,value2,value3".',
    );
  });

  it('rejects a repeated SWITCH too, even when the second is :$false', () => {
    // pwsh: Test-Pos -Force -Force:$false  ->  ParameterAlreadyBound
    assert.equal(failure(['-Force', '-Force:$false']).kind, 'ParameterAlreadyBound');
  });

  it('reports MissingArgument when a value-taking parameter has no value', () => {
    // pwsh: Test-Sw -Flag
    //   Missing an argument for parameter 'Flag'. Specify a parameter of type
    //   'System.Boolean' and try again.
    const error = failure(['-Count']);
    assert.equal(error.kind, 'MissingArgument');
    assert.equal(
      error.message,
      "Missing an argument for parameter 'Count'. Specify a parameter of type 'System.Int32' and try again.",
    );
  });

  it('reports MissingArgument for a dangling colon', () => {
    // pwsh rejects `-Force:` in the PARSER ("Parameter -Force: requires an
    // argument"), so it never reaches the binder there. With no parser of our
    // own this is the closest analogue.
    assert.equal(failure(['-Count:']).kind, 'MissingArgument');
  });
});

describe('prefix matching', () => {
  const PREFIXES = manifest('Test-Binder', [
    param('Path'),
    param('LiteralPath', { aliases: ['PSPath', 'LP'] }),
    param('Count', { type: 'System.Int32' }),
    param('Force', { type: 'System.Management.Automation.SwitchParameter', isSwitch: true }),
    param('Pattern'),
    param('Property'),
  ]);

  it('binds an unambiguous prefix', () => {
    // pwsh: Test-Binder -Patt a -> Pattern; -Pro a -> Property; -F -> Force
    assert.equal(bindParameters(['-Patt', 'a'], PREFIXES, V76).parameters['Pattern'], 'a');
    assert.equal(bindParameters(['-Pro', 'a'], PREFIXES, V76).parameters['Property'], 'a');
    assert.equal(bindParameters(['-F'], PREFIXES, V76).parameters['Force'], true);
    assert.equal(bindParameters(['-C', '5'], PREFIXES, V76).parameters['Count'], 5);
  });

  it('rejects an ambiguous prefix with the reference wording', () => {
    // pwsh: Test-Binder -Pat a
    //   Parameter cannot be processed because the parameter name 'Pat' is
    //   ambiguous. Possible matches include: -Path -Pattern.
    const error = failure(['-Pat', 'a'], PREFIXES, V76, {});
    assert.equal(error.kind, 'AmbiguousParameter');
    assert.equal(error.fullyQualifiedErrorId, 'AmbiguousParameter,Test-Binder');
    assert.equal(
      error.message,
      "Parameter cannot be processed because the parameter name 'Pat' is ambiguous. " +
        'Possible matches include: -Path -Pattern.',
    );
  });

  it('lists name matches before alias matches, each by parameter NAME', () => {
    // pwsh: on a function declaring [Alias('Xy')]$Alpha BEFORE $Xyz,
    //   Test-Amb -X v
    //   -> Possible matches include: -Xyz -Alpha.
    // The alias-matched parameter is listed last despite being declared first,
    // and by its name rather than by the alias that matched.
    const amb = manifest('Test-Amb', [param('Alpha', { aliases: ['Xy'] }), param('Xyz')]);
    const error = failure(['-X', 'v'], amb, V76, {});
    assert.equal(
      error.message,
      "Parameter cannot be processed because the parameter name 'X' is ambiguous. " +
        'Possible matches include: -Xyz -Alpha.',
    );
  });

  it('lets an EXACT name win over a prefix that would be ambiguous', () => {
    // pwsh: a function with -Path, -PathType and -Pa binds -Pa to Pa, and
    //   -Pat is still ambiguous between Path and PathType.
    const exact = manifest('Test-Exact', [param('Path'), param('PathType'), param('Pa')]);
    assert.equal(bindParameters(['-Pa', 'a'], exact, V76).parameters['Pa'], 'a');
    assert.equal(bindParameters(['-Path', 'a'], exact, V76).parameters['Path'], 'a');
    assert.equal(failure(['-Pat', 'a'], exact, V76, {}).kind, 'AmbiguousParameter');
  });

  it('treats ambiguity as per-PARAMETER, not per-name', () => {
    // pwsh: Test-Binder -L a -> LiteralPath, with no ambiguity, even though
    // 'L' prefixes both the name LiteralPath and its alias LP. They are one
    // parameter, so there is nothing to be ambiguous between.
    assert.equal(bindParameters(['-L', 'a'], PREFIXES, V76).parameters['LiteralPath'], 'a');
    assert.equal(bindParameters(['-Li', 'a'], PREFIXES, V76).parameters['LiteralPath'], 'a');
  });

  it('resolves aliases, exactly and by prefix', () => {
    // pwsh: -LP a, -PSPath a and -PSP a all bind LiteralPath
    for (const written of ['-LP', '-PSPath', '-PSP', '-lp']) {
      assert.equal(bindParameters([written, 'a'], PREFIXES, V76).parameters['LiteralPath'], 'a');
    }
  });

  it('exposes the resolution directly for callers that need it', () => {
    assert.equal(resolveParameterName(PREFIXES.parameters, 'pat').kind, 'ambiguous');
    assert.equal(resolveParameterName(PREFIXES.parameters, 'nope').kind, 'notFound');
    assert.equal(resolveParameterName(PREFIXES.parameters, 'PATH').kind, 'found');
  });
});

describe('positional binding', () => {
  it('fills positions in order', () => {
    // pwsh: Test-Pos a 5 f  ->  Path=[a] Count=5 Filter=f
    const bound = bindParameters(['a', '5', 'f'], TEST_POS, V76, POS_OPTIONS);
    assert.deepEqual(bound.parameters['Path'], ['a']);
    assert.equal(bound.parameters['Count'], 5);
    assert.equal(bound.parameters['Filter'], 'f');
  });

  it('mixes with named parameters in any order', () => {
    // pwsh: all three of these bind Path=[a] Count=5
    for (const args of [
      ['-Count', '5', 'a'],
      ['a', '-Count', '5'],
      ['-Path', 'a', '5'],
    ]) {
      const bound = bindParameters(args, TEST_POS, V76, POS_OPTIONS);
      assert.deepEqual(bound.parameters['Path'], ['a']);
      assert.equal(bound.parameters['Count'], 5);
    }
  });

  it('lets a switch sit between positional arguments without consuming one', () => {
    // pwsh: Test-Pos a -Force 5   ->  Path=[a] Force=True Count=5
    // pwsh: Test-Pos -Force a 5   ->  the same
    for (const args of [
      ['a', '-Force', '5'],
      ['-Force', 'a', '5'],
    ]) {
      const bound = bindParameters(args, TEST_POS, V76, POS_OPTIONS);
      assert.deepEqual(bound.parameters['Path'], ['a']);
      assert.equal(bound.parameters['Count'], 5);
      assert.equal(bound.parameters['Force'], true);
    }
  });

  it('does NOT let an array-typed positional swallow the next argument', () => {
    // pwsh: Test-Pos a b
    //   Cannot process argument transformation on parameter 'Count'.
    //   Cannot convert value "b" to type "System.Int32".
    // Path is String[] and still takes exactly one positional argument; 'b'
    // falls through to position 1. The obvious guess — that an array parameter
    // collects the rest — is wrong.
    const error = failure(['a', 'b']);
    assert.equal(error.kind, 'ParameterArgumentTransformationError');
    assert.equal(error.parameterName, 'Count');
  });

  it('errors when a positional argument has nowhere to go', () => {
    // pwsh: Test-Pos a 5 f extra
    //   A positional parameter cannot be found that accepts argument 'extra'.
    const error = failure(['a', '5', 'f', 'extra']);
    assert.equal(error.kind, 'PositionalParameterNotFound');
    assert.equal(
      error.message,
      "A positional parameter cannot be found that accepts argument 'extra'.",
    );
  });

  it('skips a position whose parameter the chosen set excludes', () => {
    // pwsh: Test-Pos -LiteralPath z a
    //   Cannot process argument transformation on parameter 'Count'.
    // Naming -LiteralPath selects ByLiteral, which has no position 0, so the
    // loose 'a' lands on position 1 rather than on Path.
    const error = failure(['-LiteralPath', 'z', 'a']);
    assert.equal(error.kind, 'ParameterArgumentTransformationError');
    assert.equal(error.parameterName, 'Count');

    const bound = bindParameters(['-LiteralPath', 'z', '5'], TEST_POS, V76, POS_OPTIONS);
    assert.equal(bound.parameterSet, 'ByLiteral');
    assert.equal(bound.parameters['Count'], 5);
    assert.equal(bound.parameters['Path'], undefined);
  });

  it('collects the rest into a ValueFromRemainingArguments parameter', () => {
    // pwsh: Write-Output a b c emits three objects because InputObject is
    // declared ValueFromRemainingArguments — confirmed in the capture. Without
    // that declaration the same shape fails, which is the test above.
    const output = manifest('Write-Output', [
      param('InputObject', { type: 'System.Object[]', sets: anySet({ position: 0 }) }),
    ]);
    const bound = bindParameters(['a', 'b', 'c'], output, V76, {
      valueFromRemainingArguments: ['InputObject'],
    });
    assert.deepEqual(bound.parameters['InputObject'], ['a', 'b', 'c']);
  });

  it('gives remaining arguments to the LAST position, not the first', () => {
    // pwsh: Test-Remaining a b c  ->  First=a Rest=[b,c]
    const remaining = manifest('Test-Remaining', [
      param('First', { sets: anySet({ position: 0 }) }),
      param('Rest', { type: 'System.String[]', sets: anySet({ position: 1 }) }),
    ]);
    const bound = bindParameters(['a', 'b', 'c'], remaining, V76, {
      valueFromRemainingArguments: ['Rest'],
    });
    assert.equal(bound.parameters['First'], 'a');
    assert.deepEqual(bound.parameters['Rest'], ['b', 'c']);
  });

  it('prefers the default set when two sets share a position', () => {
    // pwsh: Where-Object has FilterScript and Property both at position 0, and
    //   @(...) | Where-Object N -eq 2   binds Property (EqualSet is default).
    //   Get-Random 10 likewise binds Maximum, not InputObject.
    const shared = manifest('Where-Object', [
      param('FilterScript', {
        type: 'System.Management.Automation.ScriptBlock',
        sets: { ScriptBlockSet: { position: 0, mandatory: true, valueFromPipeline: false } },
      }),
      param('Property', {
        sets: { EqualSet: { position: 0, mandatory: true, valueFromPipeline: false } },
      }),
    ]);
    const bound = bindParameters(['N'], shared, V76, { defaultParameterSet: 'EqualSet' });
    assert.equal(bound.parameterSet, 'EqualSet');
    assert.equal(bound.parameters['Property'], 'N');
  });
});

describe('switch semantics', () => {
  // The single most important behaviour in the binder: thirteen upstream PRs
  // exist because `-X`, `-X:$true` and `-X:$false` were treated as one thing.
  const SW = manifest('Test-Sw', [
    param('Force', { type: 'System.Management.Automation.SwitchParameter', isSwitch: true }),
    param('Path', { sets: anySet({ position: 0 }) }),
  ]);

  it('binds a bare switch to true and leaves an unsupplied one absent', () => {
    // pwsh: Test-Sw -Path a          ->  BOUND-KEYS: Path        (no Force)
    // pwsh: Test-Sw -Path a -Force   ->  Force = True
    const without = bindParameters(['-Path', 'a'], SW, V76);
    assert.equal('Force' in without.parameters, false);
    assert.equal(bindParameters(['-Force'], SW, V76).parameters['Force'], true);
  });

  it('binds -Force:$true to true under both profiles', () => {
    // pwsh: Test-Sw -Force:$true  ->  Force = True
    assert.equal(bindParameters(['-Force:$true'], SW, V76).parameters['Force'], true);
    assert.equal(bindParameters(['-Force:$TRUE'], SW, V77).parameters['Force'], true);
  });

  it('honours -Force:$false only under the 7.7 profile', () => {
    // The 7.6 binder really does store False — verified — but every 7.6 COMMAND
    // asks ContainsKey instead of reading the value, so the observable 7.6
    // behaviour is that -Not:$false filters exactly like -Not:
    //
    //   pwsh 7.6.5: @(..) | Where-Object -Property A -Not:$false  ==  -Not
    //   pwsh 7.6.5: Split-Path /a/b/c.txt -Leaf:$false            ==  -Leaf
    //
    // so the binder reproduces the version's behaviour, not its internals.
    assert.equal(bindParameters(['-Force:$false'], SW, V76).parameters['Force'], true);
    assert.equal(bindParameters(['-Force:$false'], SW, V77).parameters['Force'], false);
  });

  it('records the explicit $false under BOTH profiles, so intent is never lost', () => {
    assert.deepEqual(bindParameters(['-Force:$false'], SW, V76).explicitlyFalseSwitches, ['Force']);
    assert.deepEqual(bindParameters(['-Force:$false'], SW, V77).explicitlyFalseSwitches, ['Force']);
    assert.deepEqual(bindParameters(['-Force'], SW, V77).explicitlyFalseSwitches, []);
    assert.deepEqual(bindParameters(['-Force:$true'], SW, V77).explicitlyFalseSwitches, []);
  });

  it('reads the behaviour from the profile, not from a version number', () => {
    // The flag is what decides; a hand-made view with the flag on behaves as
    // 7.7 does even while calling itself 7.6.5.
    const pretender: CompatibilityView = {
      displayVersion: '7.6.5',
      behavior: <T extends boolean | number | string>(key: string, fallback: T): T =>
        (key === 'switchParameters.honourExplicitFalse' ? true : fallback) as T,
    };
    assert.equal(bindParameters(['-Force:$false'], SW, pretender).parameters['Force'], false);
    assert.equal(V76.behavior('switchParameters.honourExplicitFalse', true), false);
    assert.equal(V77.behavior('switchParameters.honourExplicitFalse', false), true);
  });

  it('never consumes the following token as a switch value', () => {
    // pwsh: Test-Sw -Force $true  ->  Force = True AND Path = 'True'
    // The $true became a POSITIONAL argument. A switch takes its value only
    // through the colon form.
    const bound = bindParameters(['-Force', 'x'], SW, V76);
    assert.equal(bound.parameters['Force'], true);
    assert.equal(bound.parameters['Path'], 'x');
  });

  it('rejects a non-boolean colon argument on a switch', () => {
    // pwsh: Test-Sw2 -Force:'false'
    //   Cannot process argument transformation on parameter 'Force'. Cannot
    //   convert value "System.String" to type "…SwitchParameter". Boolean
    //   parameters accept only Boolean values and numbers, such as $True,
    //   $False, 1 or 0.
    // Note the reference implementation contradicts its own advice: it says
    // numbers are accepted, yet `-Force:0` fails in 7.6.5 too. We follow the
    // behaviour and reject both.
    for (const token of ['-Force:false', '-Force:0', '-Force:1', '-Force:yes']) {
      const error = failure([token], SW, V76, {});
      assert.equal(error.kind, 'ParameterArgumentTransformationError');
      assert.equal(error.parameterName, 'Force');
      assert.equal(
        error.exceptionTypeName,
        'System.Management.Automation.ParameterBindingArgumentTransformationException',
      );
    }
  });

  it('distinguishes a switch from a [bool] parameter', () => {
    // pwsh: Test-B -Flag:0 -> False, -Flag:1 -> True, -Flag $false -> False,
    //       but a bare -Flag is MissingArgument because [bool] needs a value.
    const bools = manifest('Test-B', [param('Flag', { type: 'System.Boolean' })]);
    assert.equal(bindParameters(['-Flag:0'], bools, V76).parameters['Flag'], false);
    assert.equal(bindParameters(['-Flag:1'], bools, V76).parameters['Flag'], true);
    assert.equal(bindParameters(['-Flag', '$false'], bools, V76).parameters['Flag'], false);
    assert.equal(failure(['-Flag'], bools, V76, {}).kind, 'MissingArgument');
  });
});

describe('parameter set resolution', () => {
  it('picks the set implied by the named parameters', () => {
    // pwsh: Test-Pos -Path a -> ByPath ; -LiteralPath b -> ByLiteral
    assert.equal(bindParameters(['-Path', 'a'], TEST_POS, V76, POS_OPTIONS).parameterSet, 'ByPath');
    assert.equal(
      bindParameters(['-LiteralPath', 'b'], TEST_POS, V76, POS_OPTIONS).parameterSet,
      'ByLiteral',
    );
  });

  it('rejects parameters from two different sets', () => {
    // pwsh: Test-Pos -Path a -LiteralPath b  ->  AmbiguousParameterSet
    //   Parameter set cannot be resolved using the specified named parameters.
    //   One or more parameters issued cannot be used together or an
    //   insufficient number of parameters were provided.
    const error = failure(['-Path', 'a', '-LiteralPath', 'b']);
    assert.equal(error.kind, 'AmbiguousParameterSet');
    assert.equal(error.parameterName, null);
    assert.equal(
      error.message,
      'Parameter set cannot be resolved using the specified named parameters. ' +
        'One or more parameters issued cannot be used together or an insufficient number of parameters were provided.',
    );
  });

  it('falls back to the default set when several remain possible', () => {
    // pwsh: Test-DefaultWins -Shared s  ->  SET: A
    const two = manifest('Test-DefaultWins', [
      param('OnlyA', { sets: { A: { position: null, mandatory: false, valueFromPipeline: false } } }),
      param('OnlyB', { sets: { B: { position: null, mandatory: false, valueFromPipeline: false } } }),
      param('Shared'),
    ]);
    assert.equal(
      bindParameters(['-Shared', 's'], two, V76, { defaultParameterSet: 'A' }).parameterSet,
      'A',
    );
    assert.equal(bindParameters([], two, V76, { defaultParameterSet: 'A' }).parameterSet, 'A');
  });

  it('is ambiguous when several sets remain and none is the default', () => {
    // pwsh: a function with no DefaultParameterSetName and two sets fails with
    //   AmbiguousParameterSet even for `Test-NoDefault -Shared s` and for no
    //   arguments at all.
    const two = manifest('Test-NoDefault', [
      param('OnlyA', { sets: { A: { position: null, mandatory: false, valueFromPipeline: false } } }),
      param('OnlyB', { sets: { B: { position: null, mandatory: false, valueFromPipeline: false } } }),
      param('Shared'),
    ]);
    assert.equal(failure(['-Shared', 's'], two, V76, {}).kind, 'AmbiguousParameterSet');
    assert.equal(failure([], two, V76, {}).kind, 'AmbiguousParameterSet');
    assert.equal(bindParameters(['-OnlyB', 'b'], two, V76, {}).parameterSet, 'B');
  });

  it('reads a defaultParameterSet declared on the manifest itself', () => {
    // CommandManifest has no such field yet, so it is read structurally rather
    // than by widening a contract three other layers depend on.
    const withDefault = {
      ...manifest('Test-Declared', [
        param('OnlyA', { sets: { A: { position: null, mandatory: false, valueFromPipeline: false } } }),
        param('OnlyB', { sets: { B: { position: null, mandatory: false, valueFromPipeline: false } } }),
      ]),
      defaultParameterSet: 'B',
    };
    assert.equal(bindParameters([], withDefault, V76).parameterSet, 'B');
  });

  it('reports __AllParameterSets when the command declares no named sets', () => {
    // pwsh: a function without ParameterSetName reports __AllParameterSets.
    const flat = manifest('Test-Flat', [param('Path')]);
    assert.equal(bindParameters(['-Path', 'a'], flat, V76).parameterSet, '__AllParameterSets');
  });
});

describe('mandatory parameters', () => {
  it('reports the mandatory parameters of the RESOLVED set', () => {
    // pwsh: Test-Mand -Optional x
    //   Cannot process command because of one or more missing mandatory
    //   parameters: Required.
    const mand = manifest('Test-Mand', [
      param('Required', { sets: anySet({ position: 0, mandatory: true }) }),
      param('Optional'),
    ]);
    const error = failure(['-Optional', 'x'], mand, V76, {});
    assert.equal(error.kind, 'MissingMandatoryParameter');
    assert.equal(
      error.message,
      'Cannot process command because of one or more missing mandatory parameters: Required.',
    );
    assert.equal(bindParameters(['-Required', 'x'], mand, V76).parameters['Required'], 'x');
  });

  it('ignores a mandatory that belongs to a set we did not choose', () => {
    // pwsh: Test-Pos -Path a succeeds even though LiteralPath is mandatory in
    // the other set. A flattened `mandatory` flag would reject this.
    const bound = bindParameters(['-Path', 'a'], TEST_POS, V76, POS_OPTIONS);
    assert.equal(bound.parameterSet, 'ByPath');
    assert.equal('LiteralPath' in bound.parameters, false);
  });

  it('lets the default set win even when its mandatory is unmet', () => {
    // pwsh: given default set A with an unmet mandatory and a viable set B,
    //   Test-MandPrefer -Shared s
    //   -> MissingMandatoryParameter: NeedA
    // It does NOT quietly switch to B. This was the assumption most likely to
    // be got backwards.
    const prefer = manifest('Test-MandPrefer', [
      param('NeedA', { sets: { A: { position: null, mandatory: true, valueFromPipeline: false } } }),
      param('OptB', { sets: { B: { position: null, mandatory: false, valueFromPipeline: false } } }),
      param('Shared'),
    ]);
    const error = failure(['-Shared', 's'], prefer, V76, { defaultParameterSet: 'A' });
    assert.equal(error.kind, 'MissingMandatoryParameter');
    assert.equal(error.parameterName, 'NeedA');

    // …but a parameter unique to B does select B, and then A's mandatory is
    // irrelevant. pwsh: Test-MandOtherSet -OptB b -> SET: B
    assert.equal(
      bindParameters(['-OptB', 'b'], prefer, V76, { defaultParameterSet: 'A' }).parameterSet,
      'B',
    );
  });
});

describe('the absence invariant', () => {
  it('omits unsupplied parameters entirely', () => {
    // The contract in invocation.ts: a parameter that was not supplied is
    // ABSENT, not present-and-undefined, because that is what lets a command
    // tell "-Force was not passed" from "-Force:$false was passed".
    const bound = bindParameters(['-Path', 'a'], TEST_POS, V76, POS_OPTIONS);
    assert.deepEqual(Object.keys(bound.parameters), ['Path']);
    for (const name of ['Force', 'Count', 'Filter', 'LiteralPath']) {
      assert.equal(Object.hasOwn(bound.parameters, name), false, `${name} should be absent`);
      assert.equal(name in bound.parameters, false);
    }
  });

  it('binds nothing at all for an empty argument list', () => {
    const bound = bindParameters([], TEST_POS, V76, POS_OPTIONS);
    assert.deepEqual(bound.parameters, {});
    assert.deepEqual(bound.remaining, []);
    assert.equal(bound.parameterSet, 'ByPath');
  });
});

describe('remaining arguments', () => {
  it('passes everything through for a command that declares no parameters', () => {
    // The simulated pass-through commands (`ls -la`, `git status`) declare no
    // parameters at all. Erroring on every token would make them unusable, and
    // there is nothing they could bind to, so it all becomes `remaining`.
    const passthrough = manifest('git', []);
    const bound = bindParameters(['status', '--short', '-v'], passthrough, V76);
    assert.deepEqual(bound.remaining, ['status', '--short', '-v']);
    assert.deepEqual(bound.parameters, {});
  });

  it('can be asked to collect leftovers instead of failing', () => {
    const bound = bindParameters(['a', '5', 'f', 'extra', 'more'], TEST_POS, V76, {
      ...POS_OPTIONS,
      allowRemainingArguments: true,
    });
    assert.deepEqual(bound.remaining, ['extra', 'more']);
    assert.equal(bound.parameters['Filter'], 'f');
  });

  it('fails by default, as pwsh does', () => {
    assert.deepEqual(bindParameters(['a'], TEST_POS, V76, POS_OPTIONS).remaining, []);
    assert.equal(failure(['a', '5', 'f', 'extra']).kind, 'PositionalParameterNotFound');
  });
});

describe('the two entry points', () => {
  it('bindParameters throws the same error tryBindParameters returns', () => {
    assert.throws(
      () => bindParameters(['-Nope'], TEST_POS, V76, POS_OPTIONS),
      (error: unknown) =>
        error instanceof ParameterBindingError &&
        error.kind === 'NamedParameterNotFound' &&
        error.name === 'ParameterBindingError',
    );
    const outcome = tryBindParameters(['-Nope'], TEST_POS, V76, POS_OPTIONS);
    assert.equal(outcome.ok, false);
  });
});
