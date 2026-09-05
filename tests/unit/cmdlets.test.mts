/**
 * Tests for the object cmdlets.
 *
 * Every expectation carrying a `// pwsh:` note was READ OFF pwsh 7.6.5 with a
 * probe script, not reasoned about. The ones that matter most are the ones
 * where the reasoning and the reference implementation disagree, and there are
 * more of those than there are commands:
 *
 *   Measure-Object   Count with -Property counts objects that HAVE the
 *                    property, not objects that went past
 *   Measure-Object   a null property VALUE counts; a null INPUT object does not
 *   Measure-Object   one non-numeric value blanks Sum for every other value too
 *   Measure-Object   no object with the property means NO OUTPUT AT ALL
 *   Sort-Object      the default sort is NOT stable in pwsh
 *   Sort-Object      nulls are DROPPED, not sorted first
 *   Sort-Object      a missing property sorts LAST in BOTH directions
 *   Select-Object    nulls are dropped and do not count toward -First
 *   Select-Object    -First 0 does not stop the upstream
 *   Select-Object    -Unique is case-SENSITIVE (Sort-Object -Unique is not)
 *   Group-Object     -NoElement keeps an empty Group property
 *   Group-Object     groups come out in key order, not first-appearance order
 *   Get-Member       only the FIRST object of each type contributes members
 *   Where-Object     a missing property and $null are the same to -eq
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { psObject } from '../../src/pipeline/psobject.ts';
import type { PSObject, PSValue } from '../../src/pipeline/psobject.ts';
import { collectingStreams } from '../../src/pipeline/streams.ts';
import type { ErrorRecord } from '../../src/pipeline/streams.ts';
import {
  collectPipeline,
  commandStage,
  fromValues,
} from '../../src/pipeline/pipeline.ts';
import type { PipelineHost, PipelineStage } from '../../src/pipeline/pipeline.ts';
import type {
  BindingResult,
  BoundParameters,
  CommandModule,
  CompatibilityView,
  InvocationContext,
} from '../../src/commands/invocation.ts';
import { tryBindParameters } from '../../src/binding/binder.ts';
import type { CommandManifest } from '../../src/commands/manifest.ts';
import {
  OBJECT_CMDLET_INDEX,
  getMember,
  groupObject,
  measureObject,
  scriptBlock,
  selectObject,
  sortObject,
  whereObject,
} from '../../src/commands/powershell/index.ts';
import { viewOfBehaviors } from '../../src/compatibility/profile-resolver.ts';

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

interface RunResult {
  readonly values: PSValue[];
  readonly errors: readonly ErrorRecord[];
  readonly exitCode: number;
}

function makeHost(): PipelineHost & {
  readonly errors: readonly ErrorRecord[];
} {
  const streams = collectingStreams();
  return {
    profile: viewOfBehaviors('7.6.5', {}),
    streams,
    errors: streams.collected.error.values,
    native: null,
    cwd: '/',
    env: new Map<string, string>(),
    signal: new AbortController().signal,
    requireCapability: (): void => {},
  };
}

function bind(parameters: BoundParameters): BindingResult {
  return { parameters, parameterSet: 'Default', remaining: [] };
}

async function run(
  module: CommandModule,
  parameters: BoundParameters,
  input: readonly PSValue[],
): Promise<RunResult> {
  const host = makeHost();
  const stage = commandStage(module, bind(parameters));
  const values = await collectPipeline(fromValues(input), [stage], host);
  return { values, errors: host.errors, exitCode: stage.exitCode };
}

/** Chain several cmdlets, which is how they are actually used. */
async function runChain(
  input: readonly PSValue[],
  ...steps: readonly (readonly [CommandModule, BoundParameters])[]
): Promise<RunResult> {
  const host = makeHost();
  const stages: PipelineStage[] = steps.map(([module, parameters]) =>
    commandStage(module, bind(parameters)),
  );
  const values = await collectPipeline(fromValues(input), stages, host);
  return { values, errors: host.errors, exitCode: stages.at(-1)?.exitCode ?? 0 };
}

const obj = (properties: Record<string, PSValue>): PSObject => psObject(properties);

function prop(value: PSValue | undefined, name: string): PSValue | undefined {
  if (value === undefined || value === null || typeof value !== 'object') return undefined;
  if (!('properties' in value)) return undefined;
  return (value as PSObject).properties[name];
}

/** Read one property off every emitted object. */
function column(values: readonly PSValue[], name: string): (PSValue | undefined)[] {
  return values.map((value) => prop(value, name));
}

function typeNamesOf(value: PSValue | undefined): readonly string[] {
  return value !== null && typeof value === 'object' && 'typeNames' in value
    ? (value as PSObject).typeNames
    : [];
}

// ---------------------------------------------------------------------------
// Where-Object
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// parameters that were accepted and ignored
// ---------------------------------------------------------------------------

/**
 * Every case below covers a parameter that the manifest declared, the binder
 * accepted, and the command body never read -- so the caller got exit code 0
 * and a result that answered a different question. Each expectation was read
 * off pwsh 7.6.5 first.
 */
describe('Measure-Object -StandardDeviation is a computation, not a null', () => {
  it('reports the SAMPLE standard deviation', async () => {
    // pwsh: 1..5 | Measure-Object -StandardDeviation -> 1.58113883008419
    //       [Math]::Sqrt(2.5)                        -> 1.58113883008419
    // The population figure would be sqrt(2) = 1.414, so this pins n-1.
    const result = await run(measureObject, { StandardDeviation: true }, [1, 2, 3, 4, 5]);
    const sd = prop(result.values[0], 'StandardDeviation');
    assert.equal(typeof sd, 'number');
    assert.ok(Math.abs((sd as number) - Math.sqrt(2.5)) < 1e-12, `got ${String(sd)}`);
    // Independent of the others: Sum stays null when it was not asked for.
    assert.equal(prop(result.values[0], 'Sum'), null);
    assert.equal(prop(result.values[0], 'Count'), 5);
  });

  it('fills in Sum and StandardDeviation together', async () => {
    // pwsh: 1..5 | Measure-Object -Sum -StandardDeviation -> Sum 15, SD 1.5811
    const result = await run(measureObject, { Sum: true, StandardDeviation: true }, [1, 2, 3, 4, 5]);
    assert.equal(prop(result.values[0], 'Sum'), 15);
    assert.ok(Math.abs((prop(result.values[0], 'StandardDeviation') as number) - Math.sqrt(2.5)) < 1e-12);
  });

  it('reports ZERO, not null, below two values', async () => {
    // Measured, and the opposite of the reasonable guess: the sample formula
    // divides by n-1 and is undefined at n=1, but pwsh reports 0.
    //   @(7) | Measure-Object -StandardDeviation  ->  0
    //   @()  | Measure-Object -StandardDeviation  ->  0
    //   @()  | Measure-Object                     ->  <null>
    assert.equal(
      prop((await run(measureObject, { StandardDeviation: true }, [7])).values[0], 'StandardDeviation'),
      0,
    );
    assert.equal(
      prop((await run(measureObject, { StandardDeviation: true }, [])).values[0], 'StandardDeviation'),
      0,
    );
    assert.equal(
      prop((await run(measureObject, {}, [])).values[0], 'StandardDeviation'),
      null,
    );
  });

  it('forces the numeric path, so a non-numeric value is an error', async () => {
    // Measured: @(1,'a') | Measure-Object -StandardDeviation
    //   ->  Count 2, StandardDeviation empty, NonNumericInputObject for 'a'
    // -Maximum alone reports no error at all and switches result type instead;
    // there is no object-typed standard deviation to switch to.
    const result = await run(measureObject, { StandardDeviation: true }, [1, 'a']);
    assert.equal(prop(result.values[0], 'Count'), 2);
    assert.equal(prop(result.values[0], 'StandardDeviation'), null);
    assert.equal(
      result.errors[0]?.fullyQualifiedErrorId,
      'NonNumericInputObject,Microsoft.PowerShell.Commands.MeasureObjectCommand',
    );
  });

  it('matches the two-value and float cases', async () => {
    // pwsh: @(1,3) -> 1.4142135623731 = sqrt(2)
    //       @(1.5,2.5,3.5) -> 1
    const two = await run(measureObject, { StandardDeviation: true }, [1, 3]);
    assert.ok(Math.abs((prop(two.values[0], 'StandardDeviation') as number) - Math.SQRT2) < 1e-12);
    const floats = await run(measureObject, { StandardDeviation: true }, [1.5, 2.5, 3.5]);
    assert.ok(Math.abs((prop(floats.values[0], 'StandardDeviation') as number) - 1) < 1e-12);
  });
});

describe('Measure-Object -IgnoreWhiteSpace narrows the character count only', () => {
  it('drops whitespace from Characters and nothing else', async () => {
    // pwsh: 'a b  c' | Measure-Object -Character                  -> 6
    //       'a b  c' | Measure-Object -Character -IgnoreWhiteSpace -> 3
    const plain = await run(measureObject, { Character: true }, ['a b  c']);
    assert.equal(prop(plain.values[0], 'Characters'), 6);
    const ignoring = await run(
      measureObject,
      { Character: true, IgnoreWhiteSpace: true },
      ['a b  c'],
    );
    assert.equal(prop(ignoring.values[0], 'Characters'), 3);
  });

  it('leaves Words and Lines exactly where they were', async () => {
    // pwsh: -Word -IgnoreWhiteSpace on 'a b  c' -> 3, same as without.
    const words = await run(measureObject, { Word: true, IgnoreWhiteSpace: true }, ['a b  c']);
    assert.equal(prop(words.values[0], 'Words'), 3);
    const lines = await run(measureObject, { Line: true, IgnoreWhiteSpace: true }, [' a \n b ']);
    assert.equal(prop(lines.values[0], 'Lines'), 2);
  });

  it('conflicts with the numeric switches, because it is in the text set', async () => {
    // pwsh: 1..3 | Measure-Object -Sum -IgnoreWhiteSpace
    //   ->  AmbiguousParameterSet,...MeasureObjectCommand
    const result = await run(measureObject, { Sum: true, IgnoreWhiteSpace: true }, [1, 2, 3]);
    assert.equal(result.exitCode, 1);
    assert.equal(
      result.errors[0]?.fullyQualifiedErrorId,
      'AmbiguousParameterSet,Microsoft.PowerShell.Commands.MeasureObjectCommand',
    );
  });
});

describe('Measure-Object folds instead of buffering', () => {
  it('survives more values than a spread can carry', async () => {
    // MEASURED on node 24.13.0 by bisection: `Math.max(...a)` succeeds at
    // 124,766 elements and throws `RangeError: Maximum call stack size
    // exceeded` at 124,767. 130,000 is the smallest round number past it --
    // chosen rather than a bigger one because every element costs an await in
    // the async pipeline and the suite pays for it.
    // pwsh answers `1..200000 | Measure-Object -Maximum` without noticing.
    const SPREAD_LIMIT = 124_766;
    const many = Array.from({ length: 130_000 }, (_, i) => i + 1);
    assert.ok(many.length > SPREAD_LIMIT, 'the input must exceed the measured spread limit');
    const result = await run(measureObject, { Maximum: true, Minimum: true, Sum: true }, many);
    assert.deepEqual(result.errors, []);
    assert.equal(prop(result.values[0], 'Maximum'), 130_000);
    assert.equal(prop(result.values[0], 'Minimum'), 1);
    assert.equal(prop(result.values[0], 'Count'), 130_000);
  });

  it('still picks the extremes by the total order for non-numeric data', async () => {
    // pwsh: @('a','b') | Measure-Object -Maximum -> GenericObjectMeasureInfo
    const result = await run(measureObject, { Maximum: true, Minimum: true }, ['b', 'a', 'c']);
    assert.equal(prop(result.values[0], 'Maximum'), 'c');
    assert.equal(prop(result.values[0], 'Minimum'), 'a');
    assert.ok(
      typeNamesOf(result.values[0]).includes(
        'Microsoft.PowerShell.Commands.GenericObjectMeasureInfo',
      ),
    );
  });
});

describe('Group-Object refuses -AsHashTable rather than pretending', () => {
  const rows = [obj({ K: 'a' }), obj({ K: 'b' }), obj({ K: 'a' })];

  it('names the parameter instead of emitting ordinary groups', async () => {
    // pwsh returns ONE System.Collections.Hashtable. This engine has no
    // hashtable, and the old code emitted the normal GroupInfo stream with a
    // successful exit -- a different shape under the same request.
    const result = await run(groupObject, { Property: 'K', AsHashTable: true }, rows);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.values, []);
    assert.equal(
      result.errors[0]?.fullyQualifiedErrorId,
      'ParameterNotSupported,Microsoft.PowerShell.Commands.GroupObjectCommand',
    );
  });

  it("reproduces pwsh's own error for -AsString without -AsHashTable", async () => {
    // pwsh: 'The command cannot be run because the AsString parameter requires
    //        that you specify the AsHashtable parameter.'
    const result = await run(groupObject, { Property: 'K', AsString: true }, rows);
    assert.equal(result.exitCode, 1);
    assert.equal(
      result.errors[0]?.fullyQualifiedErrorId,
      'ArgumentException,Microsoft.PowerShell.Commands.GroupObjectCommand',
    );
    assert.match(result.errors[0]?.message ?? '', /requires that you specify the AsHashtable/u);
  });

  it('still groups normally when neither is asked for', async () => {
    const result = await run(groupObject, { Property: 'K' }, rows);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(column(result.values, 'Name'), ['a', 'b']);
  });
});

describe('Get-Member refuses -Force and an unknown -MemberType', () => {
  const rows = [obj({ A: 1 })];

  it('says no to -Force instead of returning the unforced list', async () => {
    // pwsh: ([pscustomobject]@{A=1} | Get-Member).Count       ->  5
    //       ([pscustomobject]@{A=1} | Get-Member -Force).Count -> 10
    // The extra five are pstypenames, psadapted, psbase, psextended, psobject.
    const result = await run(getMember, { Force: true }, rows);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.values, []);
    assert.equal(
      result.errors[0]?.fullyQualifiedErrorId,
      'ParameterNotSupported,Microsoft.PowerShell.Commands.GetMemberCommand',
    );
  });

  it('rejects an unrecognised -MemberType, listing the valid ones', async () => {
    // pwsh: CannotConvertArgumentNoMessage,...GetMemberCommand
    // Before: the filter matched nothing and Get-Member emitted nothing, which
    // reads as 'this object has no members of that kind'.
    const result = await run(getMember, { MemberType: 'Bogus' }, rows);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.values, []);
    assert.equal(
      result.errors[0]?.fullyQualifiedErrorId,
      'CannotConvertArgumentNoMessage,Microsoft.PowerShell.Commands.GetMemberCommand',
    );
    assert.match(result.errors[0]?.message ?? '', /NoteProperty/u);
  });

  it('accepts a recognised -MemberType, case-insensitively', async () => {
    const result = await run(getMember, { MemberType: 'noteproperty' }, rows);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(column(result.values, 'Name'), ['A']);
  });
});

describe('Select-Object enforces the parameter sets it declares', () => {
  it('refuses -SkipLast with -First or -Last', async () => {
    // pwsh: 1..5 | Select-Object -Last 2 -SkipLast 1 -> AmbiguousParameterSet.
    // SkipLastParameter declares neither -First nor -Last.
    for (const window of [{ Last: 2, SkipLast: 1 }, { First: 2, SkipLast: 1 }]) {
      const result = await run(selectObject, window, [1, 2, 3, 4, 5]);
      assert.equal(result.exitCode, 1, JSON.stringify(window));
      assert.deepEqual(result.values, []);
      assert.equal(
        result.errors[0]?.fullyQualifiedErrorId,
        'AmbiguousParameterSet,Microsoft.PowerShell.Commands.SelectObjectCommand',
      );
    }
  });

  it('still allows the combinations pwsh allows', async () => {
    // pwsh: -First 2 -Last 2 over 1..5 -> 1,2,4,5; over 1..3 -> 1,2,3
    //       -Skip 1 -SkipLast 1 over 1..5 -> 2,3,4
    assert.deepEqual(
      (await run(selectObject, { First: 2, Last: 2 }, [1, 2, 3, 4, 5])).values,
      [1, 2, 4, 5],
    );
    assert.deepEqual((await run(selectObject, { First: 2, Last: 2 }, [1, 2, 3])).values, [1, 2, 3]);
    assert.deepEqual(
      (await run(selectObject, { Skip: 1, SkipLast: 1 }, [1, 2, 3, 4, 5])).values,
      [2, 3, 4],
    );
  });
});

describe('Select-Object -ExpandProperty keeps the expanded value on a collision', () => {
  it('does not let -Property overwrite it, and says so', async () => {
    // pwsh:
    //   $src = @([pscustomobject]@{K=1; V=[pscustomobject]@{K=9; Z=8}})
    //   $src | Select-Object -Property K -ExpandProperty V
    //     ->  ONE object with K=9 and Z=8
    //     ->  AlreadyExistingUserSpecifiedPropertyExpand,...SelectObjectCommand
    // Before: the spread ran the other way and K came out as 1, silently, with
    // exit code 0.
    const source = [obj({ K: 1, V: obj({ K: 9, Z: 8 }) })];
    const result = await run(selectObject, { Property: 'K', ExpandProperty: 'V' }, source);
    assert.equal(result.values.length, 1);
    assert.equal(prop(result.values[0], 'K'), 9, 'the EXPANDED value wins');
    assert.equal(prop(result.values[0], 'Z'), 8);
    assert.equal(
      result.errors[0]?.fullyQualifiedErrorId,
      'AlreadyExistingUserSpecifiedPropertyExpand,Microsoft.PowerShell.Commands.SelectObjectCommand',
    );
  });

  it('keeps the two error ids apart', async () => {
    // pwsh uses a DIFFERENT id for the duplicate -Property case, same sentence.
    const result = await run(selectObject, { Property: ['A', 'A'] }, [obj({ A: 1 })]);
    assert.equal(
      result.errors[0]?.fullyQualifiedErrorId,
      'AlreadyExistingUserSpecifiedPropertyNoExpand,Microsoft.PowerShell.Commands.SelectObjectCommand',
    );
  });

  it('adds a non-colliding property after the expanded object own ones', async () => {
    // pwsh: -Property K -ExpandProperty V over V=@{Z=8} -> Z then K
    const source = [obj({ K: 1, V: obj({ Z: 8 }) })];
    const result = await run(selectObject, { Property: 'K', ExpandProperty: 'V' }, source);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(Object.keys((result.values[0] as PSObject).properties), ['Z', 'K']);
  });
});

describe('Sort-Object -Stable is satisfied, and the DEFAULT is the divergence', () => {
  const rows = Array.from({ length: 20 }, (_, i) =>
    obj({ K: (i + 1) % 3, I: i + 1 }),
  );

  it('gives the same order with and without the switch', async () => {
    // Measured: pwsh's default scrambles ties above .NET's insertion-sort
    // threshold and -Stable does not. This engine gives the -Stable order both
    // times, which is a recorded divergence and must not read as agreement.
    const withSwitch = await run(sortObject, { Property: 'K', Stable: true }, rows);
    const without = await run(sortObject, { Property: 'K' }, rows);
    assert.deepEqual(column(withSwitch.values, 'I'), column(without.values, 'I'));
    // And it really is the stable order: ties in input order.
    const zeros = column(withSwitch.values, 'I').slice(0, 6);
    assert.deepEqual(zeros, [3, 6, 9, 12, 15, 18]);
  });

  it('declares -Stable and refuses the upstream-only windowing parameters', () => {
    const declared = sortObject.manifest.parameters.map((p) => p.name);
    assert.ok(declared.includes('Stable'));
    for (const upstreamOnly of ['Top', 'Bottom', 'Culture']) {
      assert.ok(!declared.includes(upstreamOnly), `-${upstreamOnly} must not be accepted`);
    }
    assert.match(sortObject.manifest.notes ?? '', /KNOWN DIFFERENCE/u);
  });
});

describe('-InputObject is a direct argument, not decoration', () => {
  it('measures the one object it was handed, unenumerated', async () => {
    // pwsh: Measure-Object -InputObject @(1,2,3) -Sum
    //   ->  Count 1, Sum empty, NonNumericInputObject 'System.Object[]'
    // Before: the parameter bound, nothing read it, the empty pipeline gave
    // Count 0 and exit 0.
    const result = await run(measureObject, { InputObject: [1, 2, 3], Sum: true }, []);
    assert.equal(prop(result.values[0], 'Count'), 1);
    assert.equal(prop(result.values[0], 'Sum'), null);
    assert.equal(
      result.errors[0]?.fullyQualifiedErrorId,
      'NonNumericInputObject,Microsoft.PowerShell.Commands.MeasureObjectCommand',
    );
  });

  it('sends exactly one object through Sort-Object and Group-Object', async () => {
    // pwsh: @(Sort-Object -InputObject 3,1,2).Count  -> 1
    //       (Group-Object -InputObject 3,1,2).Name   -> '3 1 2'
    const sorted = await run(sortObject, { InputObject: [3, 1, 2] }, []);
    assert.equal(sorted.values.length, 1);
    const grouped = await run(groupObject, { InputObject: [3, 1, 2] }, []);
    assert.equal(grouped.values.length, 1);
    assert.equal(prop(grouped.values[0], 'Name'), '3 1 2');
  });

  it('inspects the array itself in Get-Member', async () => {
    // pwsh: (Get-Member -InputObject 3,1,2).TypeName -> System.Object[]
    const result = await run(getMember, { InputObject: [3, 1, 2] }, []);
    assert.equal(prop(result.values[0], 'TypeName'), 'System.Object[]');
  });

  it('filters the one object in Where-Object', async () => {
    // pwsh: Where-Object -InputObject 3,1,2 -Property Length -EQ 3 -> 1 object
    const result = await run(
      whereObject,
      { InputObject: [3, 1, 2], Property: 'Length', EQ: true, Value: 3 },
      [],
    );
    assert.equal(result.values.length, 1);
  });

  it('rejects each pipeline object when both were supplied', async () => {
    // pwsh:
    //   1..2 | Measure-Object -InputObject 9 -ErrorVariable e -EA SilentlyContinue
    //     ->  Count 0, and TWO errors
    //   $e[0].FullyQualifiedErrorId
    //     ->  InputObjectNotBound,...MeasureObjectCommand
    // Count 0, not 1: the direct argument is not measured either.
    const result = await run(measureObject, { InputObject: 9, Sum: true }, [1, 2]);
    assert.equal(result.errors.length, 2);
    assert.equal(
      result.errors[0]?.fullyQualifiedErrorId,
      'InputObjectNotBound,Microsoft.PowerShell.Commands.MeasureObjectCommand',
    );
    assert.equal(prop(result.values[0], 'Count'), 0);
  });
});

// ---------------------------------------------------------------------------
// Where-Object parameter sets, bound the way pwsh binds them
// ---------------------------------------------------------------------------

/**
 * Every case here was RUN against pwsh 7.6.5 and its answer recorded before the
 * expectation was written. They go through the real binder, not a hand-built
 * BoundParameters, because the defect was in the manifest's parameter sets and
 * a hand-built binding cannot see it.
 *
 * Before this change the manifest collapsed 32 sets into one, with FilterScript
 * and Property BOTH mandatory at position 0. The `ours (before)` notes are what
 * that produced, measured the same way.
 */
describe('Where-Object binds its parameter sets the way pwsh does', () => {
  const profile: CompatibilityView = {
    displayVersion: '7.6.5',
    behavior: <T extends boolean | number | string>(_key: string, fallback: T): T => fallback,
    // Scoped keys arrived with the compatibility truth model. An undeclared
    // pair takes the fallback under both profiles, which is what this stub is
    // for: these cases are about parameter-set binding, not about 7.7 deltas.
    scopedBehavior: <T extends boolean | number | string>(_key: string, whenUndeclared: T): T =>
      whenUndeclared,
  };

  const bindArgs = (args: readonly string[]) =>
    tryBindParameters(args, whereObject.manifest, profile);

  it('binds -Property first and -Value second, not the other way round', () => {
    // pwsh: @(o{N=2},o{N=5}) | Where-Object N -eq 2   ->  the N=2 object
    // ours (before): FilterScript='N', Property='2', no Value at all
    const outcome = bindArgs(['N', '-eq', '2']);
    assert.ok(outcome.ok, 'must bind');
    assert.equal(outcome.result.parameters['Property'], 'N');
    // A string, because -Value is System.Object and the argument arrived as
    // text. pwsh binds it the same way from a command line.
    assert.equal(outcome.result.parameters['Value'], '2');
    assert.equal(outcome.result.parameters['FilterScript'], undefined);
    assert.equal(outcome.result.parameterSet, 'EqualSet');
  });

  it('accepts the fully named comparison form', () => {
    // pwsh: Where-Object -Property N -eq -Value 2  ->  works
    // ours (before): MissingMandatoryParameter: FilterScript. A valid pwsh
    // command line was REJECTED, which is the same defect facing the other way.
    const outcome = bindArgs(['-Property', 'N', '-eq', '-Value', '2']);
    assert.ok(outcome.ok, 'must bind');
    assert.equal(outcome.result.parameters['Property'], 'N');
    assert.equal(outcome.result.parameters['Value'], '2');
  });

  it('accepts -Property with no operator, which is the truthiness test', () => {
    // pwsh: @(o{Name='x'},o{Name='y'}) | Where-Object -Property Name  ->  both
    // -EQ is OPTIONAL in EqualSet, which is why this binds at all.
    const outcome = bindArgs(['-Property', 'Name']);
    assert.ok(outcome.ok, 'must bind');
    assert.equal(outcome.result.parameterSet, 'EqualSet');
  });

  it('refuses a script block and a property together', () => {
    // pwsh: AmbiguousParameterSet,...WhereObjectCommand
    // ours (before): accepted BOTH and quietly filtered on the script block.
    const outcome = bindArgs(['-FilterScript', '{}', '-Property', 'Name', '-EQ', 'x']);
    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok && outcome.error.kind === 'AmbiguousParameterSet', 'kind');
  });

  it('refuses two comparison operators', () => {
    // pwsh: AmbiguousParameterSet -- -EQ and -GT are different sets.
    // ours (before): FilterScript='Name', Property='x', Value='y'. Three
    // parameters bound wrongly and a successful exit.
    const outcome = bindArgs(['Name', '-EQ', 'x', '-GT', 'y']);
    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok && outcome.error.kind === 'AmbiguousParameterSet', 'kind');
  });

  it('gives -Not its own set, which has no -Value', () => {
    // pwsh: `Where-Object N -Not` binds; the Not set declares no -Value.
    const outcome = bindArgs(['N', '-Not']);
    assert.ok(outcome.ok, 'must bind');
    assert.equal(outcome.result.parameterSet, 'Not');
    assert.equal(outcome.result.parameters['Property'], 'N');
  });

  it('binds -Is against a type name at position 1', () => {
    // pwsh: `Where-Object Name -Is System.String` -> both objects, so Property
    // is 'Name' and Value is the type name.
    const outcome = bindArgs(['Name', '-Is', 'System.String']);
    assert.ok(outcome.ok, 'must bind');
    assert.equal(outcome.result.parameters['Property'], 'Name');
    assert.equal(outcome.result.parameters['Value'], 'System.String');
  });

  it('declares all 32 sets pwsh declares, with EqualSet the default', () => {
    // (Get-Command Where-Object).ParameterSets.Count -> 32
    // (Get-Command Where-Object).DefaultParameterSet -> EqualSet
    const sets = new Set<string>();
    for (const p of whereObject.manifest.parameters) {
      for (const name of Object.keys(p.sets)) sets.add(name);
    }
    assert.equal(sets.size, 32);
    assert.equal(whereObject.manifest.defaultParameterSet, 'EqualSet');
    assert.ok(sets.has('ScriptBlockSet'));
    assert.ok(sets.has('CaseSensitiveNotContainsSet'));
    assert.ok(sets.has('Not'), 'the -Not set is called Not, not NotSet');
  });

  it('binds every case-sensitive operator to its own set', () => {
    // The fourteen C-prefixed switches are matched by TEMPLATE -- isBound(bound,
    // `C${kind}`) -- so a search for their names as string literals finds
    // nothing and they look unread. They are not: each is its own parameter set
    // in pwsh and each binds here. Spot-checked end to end rather than by
    // reading the table that generated them.
    for (const [written, set] of [
      ['-ceq', 'CaseSensitiveEqualSet'],
      ['-clike', 'CaseSensitiveLikeSet'],
      ['-cnotcontains', 'CaseSensitiveNotContainsSet'],
    ] as const) {
      const outcome = bindArgs(['Name', written, 'B']);
      assert.ok(outcome.ok, written);
      assert.equal(outcome.result.parameterSet, set, written);
      assert.equal(outcome.result.parameters['Property'], 'Name');
      assert.equal(outcome.result.parameters['Value'], 'B');
    }
    // And all 28 are declared, one set each.
    const switches = whereObject.manifest.parameters.filter((p) => /^C[A-Z]/u.test(p.name));
    assert.equal(switches.length, 14);
    for (const p of switches) assert.equal(Object.keys(p.sets).length, 1, p.name);
  });

  it('is held out of the session registry, and says so', () => {
    assert.equal(whereObject.manifest.implementationStatus, 'partial');
    assert.match(whereObject.manifest.notes ?? '', /PARTIAL/u);
    // The two limits that earn it, named in the notes rather than implied.
    assert.match(whereObject.manifest.notes ?? '', /RegExp/u);
    assert.match(whereObject.manifest.notes ?? '', /-is/u);
  });
});

// ---------------------------------------------------------------------------
// Where-Object refuses rather than choosing
// ---------------------------------------------------------------------------

describe('Where-Object fails by name instead of guessing', () => {
  const rows = [obj({ Name: 'x', N: 2 })];

  it('reports ValueNotSpecifiedForWhereObject for an operator with no -Value', async () => {
    // pwsh: Where-Object Name -EQ
    //   ValueNotSpecifiedForWhereObject,Microsoft.PowerShell.Commands.WhereObjectCommand
    //   'The specified operator requires both the -Property and -Value parameters.'
    // ours (before): the operator ran against $null and filtered SILENTLY.
    const result = await run(whereObject, { Property: 'Name', EQ: true }, rows);
    assert.deepEqual(result.values, []);
    assert.equal(result.exitCode, 1);
    assert.equal(result.errors[0]?.fullyQualifiedErrorId,
      'ValueNotSpecifiedForWhereObject,Microsoft.PowerShell.Commands.WhereObjectCommand');
  });

  it('exempts -Not, whose parameter set has no -Value', async () => {
    // pwsh: `Where-Object N -Not` runs and filters on truthiness. N=2 is truthy,
    // so -Not keeps nothing.
    const result = await run(whereObject, { Property: 'N', Not: true }, rows);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.values, []);
  });

  it('refuses two operators rather than taking the first', async () => {
    // The binder rejects this spelling, but a hand-built binding reaches the
    // body -- and the body used to walk a fixed array and return the FIRST
    // match, so -GT was discarded without a word.
    const result = await run(whereObject, { Property: 'N', EQ: true, GT: true, Value: 2 }, rows);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.values, []);
    assert.equal(result.errors[0]?.fullyQualifiedErrorId,
      'UnsupportedParameterCombination,Microsoft.PowerShell.Commands.WhereObjectCommand');
  });

  it('refuses a script block combined with a property', async () => {
    const filter = scriptBlock(() => true);
    const result = await run(whereObject, { FilterScript: filter, Property: 'N' }, rows);
    assert.equal(result.exitCode, 1);
    assert.equal(result.errors[0]?.fullyQualifiedErrorId,
      'UnsupportedParameterCombination,Microsoft.PowerShell.Commands.WhereObjectCommand');
  });

  it('refuses to pass everything through when nothing was supplied', async () => {
    // The old body's else-branch was `keep = true`, on the reasoning that the
    // binder rejects this first. It does -- and a filter that silently becomes
    // the identity function is the exact shape of failure this file is about.
    const result = await run(whereObject, {}, rows);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.values, []);
  });
});

// ---------------------------------------------------------------------------
// Where-Object: the measured differences from PowerShell
// ---------------------------------------------------------------------------

describe('Where-Object -match is JavaScript RegExp, and says so', () => {
  const one = (value: string): readonly PSValue[] => [obj({ V: value })];

  it('reports the four .NET constructs JavaScript rejects, as an ErrorRecord', async () => {
    // Each pattern is TRUE in pwsh 7.6.5 and a SyntaxError in JavaScript.
    // Before this change the SyntaxError escaped applyOperator as a raw JS
    // exception, so a PowerShell user was shown 'Invalid group'.
    for (const [pattern, subject] of [
      ['(?i)abc', 'ABC'],
      ['(?>a+)b', 'aaab'],
      ['^[a-z-[aeiou]]$', 'b'],
      ['a(?#note)b', 'ab'],
    ] as const) {
      const result = await run(
        whereObject,
        { Property: 'V', Match: true, Value: pattern },
        one(subject),
      );
      assert.equal(result.exitCode, 1, pattern);
      assert.equal(result.errors[0]?.fullyQualifiedErrorId,
        'InvalidRegularExpression,Microsoft.PowerShell.Commands.WhereObjectCommand', pattern);
    }
  });

  it('gives the JavaScript answer for the patterns that differ silently', async () => {
    // pwsh says True for every one of these; JavaScript says false. Asserted as
    // the JS answer ON PURPOSE -- this is a recorded divergence, and a test that
    // asserted pwsh's answer would fail rather than document it.
    for (const [pattern, subject] of [
      ['^\\d+$', '１２３'],
      ['^\\w+$', 'é'],
      ['^ab$', 'ab\n'],
    ] as const) {
      const result = await run(
        whereObject,
        { Property: 'V', Match: true, Value: pattern },
        one(subject),
      );
      assert.equal(result.exitCode, 0, pattern);
      assert.deepEqual(result.values, [], `${pattern} matches in .NET and not here`);
    }
  });

  it('agrees with .NET where it was measured to agree', async () => {
    // Measured in both: `a.b` does NOT match "a\nb", and named groups work.
    const dot = await run(whereObject, { Property: 'V', Match: true, Value: 'a.b' }, one('a\nb'));
    assert.deepEqual(dot.values, []);
    const named = await run(
      whereObject,
      { Property: 'V', Match: true, Value: '(?<x>a)b' },
      one('ab'),
    );
    assert.equal(named.values.length, 1);
  });
});

describe('Where-Object orders NaN the way pwsh does', () => {
  // Measured on pwsh 7.6.5, every one False and no error raised:
  //   $n = [double]::NaN;  $n -lt 1  $n -le 1  $n -gt 1  $n -ge 1  ->  all False
  //   @(o{V=NaN}, o{V=1}) | Where-Object V -le 1  ->  ONE object, the V=1 one
  //   @(o{V=NaN}, o{V=1}) | Where-Object V -lt 1  ->  none
  const rows = [obj({ Tag: 'nan', V: Number.NaN }), obj({ Tag: 'one', V: 1 })];

  for (const [op, expected] of [
    ['LT', []],
    ['LE', ['one']],
    ['GT', []],
    ['GE', ['one']],
  ] as const) {
    it(`-${op} never matches a NaN and never raises`, async () => {
      const result = await run(whereObject, { Property: 'V', [op]: true, Value: 1 }, rows);
      assert.equal(result.exitCode, 0, 'must not raise');
      assert.deepEqual(result.errors, []);
      assert.deepEqual(column(result.values, 'Tag'), [...expected]);
    });
  }
});

describe('Where-Object', () => {
  const machines = [
    obj({ Name: 'a', CPU: 5 }),
    obj({ Name: 'b', CPU: 15 }),
    obj({ Name: 'c', CPU: 25 }),
  ];

  it('filters with a script block', async () => {
    const filter = scriptBlock((current) => {
      const cpu = prop(current, 'CPU');
      return typeof cpu === 'number' && cpu > 10;
    });
    const result = await run(whereObject, { FilterScript: filter }, machines);
    assert.deepEqual(column(result.values, 'Name'), ['b', 'c']);
  });

  it('awaits an async script block', async () => {
    const filter = scriptBlock(async (current) => {
      await Promise.resolve();
      return prop(current, 'Name') === 'b';
    });
    const result = await run(whereObject, { FilterScript: filter }, machines);
    assert.deepEqual(column(result.values, 'Name'), ['b']);
  });

  it('filters with the comparison-operator form', async () => {
    // pwsh: $p | Where-Object CPU -gt 10  ->  b, c
    const result = await run(whereObject, { Property: 'CPU', GT: true, Value: 10 }, machines);
    assert.deepEqual(column(result.values, 'Name'), ['b', 'c']);
  });

  it('is case-insensitive for -eq and case-sensitive for -ceq', async () => {
    // pwsh: Where-Object Name -eq 'B'   ->  b
    //       Where-Object Name -ceq 'B'  ->  (nothing)
    const insensitive = await run(whereObject, { Property: 'Name', EQ: true, Value: 'B' }, machines);
    assert.deepEqual(column(insensitive.values, 'Name'), ['b']);
    const sensitive = await run(whereObject, { Property: 'Name', CEQ: true, Value: 'B' }, machines);
    assert.deepEqual(sensitive.values, []);
  });

  it('supports -like, -match, -in, -contains and -ne', async () => {
    // Each read off pwsh 7.6.5 against the same three objects.
    const like = await run(whereObject, { Property: 'Name', Like: true, Value: '[ab]' }, machines);
    assert.deepEqual(column(like.values, 'Name'), ['a', 'b']);

    const match = await run(whereObject, { Property: 'Name', Match: true, Value: '^[ab]$' }, machines);
    assert.deepEqual(column(match.values, 'Name'), ['a', 'b']);

    const inSet = await run(whereObject, { Property: 'CPU', In: true, Value: [5, 25] }, machines);
    assert.deepEqual(column(inSet.values, 'Name'), ['a', 'c']);

    // -contains treats a scalar property as a one-element collection.
    const contains = await run(whereObject, { Property: 'CPU', Contains: true, Value: 5 }, machines);
    assert.deepEqual(column(contains.values, 'Name'), ['a']);

    const ne = await run(whereObject, { Property: 'CPU', NE: true, Value: 15 }, machines);
    assert.deepEqual(column(ne.values, 'Name'), ['a', 'c']);
  });

  it('treats a MISSING property as $null, exactly as pwsh does', async () => {
    // pwsh: ($q | Where-Object A -eq $null).Count      -> 2
    //       ($q | Where-Object { $null -eq $_.A }).Count -> 2
    // Both the explicit null AND the object with no A at all.
    const q = [obj({ A: 1 }), obj({ A: null }), obj({ B: 9 })];
    const result = await run(whereObject, { Property: 'A', EQ: true, Value: null }, q);
    assert.equal(result.values.length, 2);
  });

  it('uses the property as a truth test when no operator is given', async () => {
    // pwsh: $q | Where-Object A  ->  only the object whose A is 1
    // 0 is false, $null is false, and a missing A is false.
    const q = [obj({ A: 1 }), obj({ A: 0 }), obj({ A: null }), obj({ B: 9 })];
    const result = await run(whereObject, { Property: 'A' }, q);
    assert.deepEqual(column(result.values, 'A'), [1]);
  });

  it('inverts with -Not', async () => {
    // pwsh: ($q | Where-Object A -Not).Count  ->  2
    const q = [obj({ A: 1 }), obj({ A: 0 }), obj({ B: 2 })];
    const result = await run(whereObject, { Property: 'A', Not: true }, q);
    assert.equal(result.values.length, 2);
  });

  it('EMITS a $null that passes the filter — unlike Select-Object', async () => {
    // pwsh: @($null,1) | Where-Object { $true }  ->  two objects downstream
    const filter = scriptBlock(() => true);
    const result = await run(whereObject, { FilterScript: filter }, [null, 1]);
    assert.deepEqual(result.values, [null, 1]);
  });

  it('runs the script block for null items', async () => {
    // pwsh: the block runs three times for @($null,1,$null)
    let calls = 0;
    const filter = scriptBlock(() => {
      calls += 1;
      return false;
    });
    await run(whereObject, { FilterScript: filter }, [null, 1, null]);
    assert.equal(calls, 3);
  });
});

// ---------------------------------------------------------------------------
// Select-Object
// ---------------------------------------------------------------------------

describe('Select-Object', () => {
  const numbers: PSValue[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it('windows with -First, -Skip, -Last and -SkipLast', async () => {
    // pwsh, in order: 1,2,3 / 3,4,5,6 / 3,4,5 / 8,9,10 / 1..7 / 1,2,9,10
    assert.deepEqual((await run(selectObject, { First: 3 }, numbers)).values, [1, 2, 3]);
    assert.deepEqual((await run(selectObject, { Skip: 2 }, [1, 2, 3, 4, 5, 6])).values, [3, 4, 5, 6]);
    assert.deepEqual((await run(selectObject, { Skip: 2, First: 3 }, numbers)).values, [3, 4, 5]);
    assert.deepEqual((await run(selectObject, { Last: 3 }, numbers)).values, [8, 9, 10]);
    assert.deepEqual((await run(selectObject, { SkipLast: 3 }, numbers)).values, [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual((await run(selectObject, { First: 2, Last: 2 }, numbers)).values, [1, 2, 9, 10]);
  });

  it('asks for more than there is without complaining', async () => {
    assert.deepEqual((await run(selectObject, { First: 10 }, [1, 2, 3])).values, [1, 2, 3]);
    assert.deepEqual((await run(selectObject, { Last: 10 }, [1, 2, 3])).values, [1, 2, 3]);
  });

  it('DROPS null input objects, which then do not count toward the window', async () => {
    // pwsh: @($null,$null,1,2) | Select-Object -First 2  ->  1,2
    //       @($null,1,2)       | Select-Object -Skip 1   ->  2
    //       @(1,$null,$null)   | Select-Object -Last 2   ->  one object
    assert.deepEqual((await run(selectObject, { First: 2 }, [null, null, 1, 2])).values, [1, 2]);
    assert.deepEqual((await run(selectObject, { Skip: 1 }, [null, 1, 2])).values, [2]);
    assert.deepEqual((await run(selectObject, { Last: 2 }, [1, null, null])).values, [1]);
  });

  it('stops the upstream for -First but not for -First 0', async () => {
    // pwsh: -First 3 -> producer saw 1,2,3;  -First 0 -> producer saw 1..10
    const seen: PSValue[] = [];
    const watcher: CommandModule = {
      manifest: {
        name: 'watch',
        display: 'Watch',
        aliases: [],
        runtime: 'semantic',
        fidelity: 'native-semantic',
        risk: 'read',
        capabilities: [],
        parameters: [],
        outputTypeNames: [],
        synopsis: 'test double',
        parameterSource: 'none',
        implementationStatus: 'implemented',
      } satisfies CommandManifest,
      async invoke(context: InvocationContext): Promise<number> {
        for await (const item of context.input) {
          seen.push(item);
          await context.streams.success.write(item);
          if (context.streams.success.closed) break;
        }
        return 0;
      },
    };

    const stopped = await runChain(numbers, [watcher, {}], [selectObject, { First: 3 }]);
    assert.deepEqual(stopped.values, [1, 2, 3]);
    assert.deepEqual(seen, [1, 2, 3]);

    seen.length = 0;
    const notStopped = await runChain(numbers, [watcher, {}], [selectObject, { First: 0 }]);
    assert.deepEqual(notStopped.values, []);
    assert.deepEqual(seen, numbers);
  });

  it('projects with -Property, adding a missing property as null', async () => {
    // pwsh: [pscustomobject]@{A=1} | Select-Object A,Nope  ->  A=1, Nope=$null
    const result = await run(selectObject, { Property: ['A', 'Nope'] }, [obj({ A: 1, B: 2 })]);
    const first = result.values[0];
    assert.deepEqual(Object.keys((first as PSObject).properties), ['A', 'Nope']);
    assert.equal(prop(first, 'A'), 1);
    assert.equal(prop(first, 'Nope'), null);
  });

  it('follows the order of the -Property arguments, not the source order', async () => {
    // pwsh: [pscustomobject]@{A=1;B=2;C=3} | Select-Object C,A  ->  C, A
    const result = await run(selectObject, { Property: ['C', 'A'] }, [obj({ A: 1, B: 2, C: 3 })]);
    assert.deepEqual(Object.keys((result.values[0] as PSObject).properties), ['C', 'A']);
  });

  it('stamps the Selected. type name pwsh stamps', async () => {
    // pwsh: Selected.System.Management.Automation.PSCustomObject |
    //       System.Management.Automation.PSCustomObject | System.Object
    const result = await run(selectObject, { Property: ['A'] }, [obj({ A: 1 })]);
    assert.deepEqual(typeNamesOf(result.values[0]), [
      'Selected.System.Management.Automation.PSCustomObject',
      'System.Management.Automation.PSCustomObject',
      'System.Object',
    ]);
  });

  it('expands wildcards in -Property, in source declaration order', async () => {
    // pwsh: ...@{Alpha=1;Beta=2;Alt=3} | Select-Object A*  ->  Alpha, Alt
    const result = await run(selectObject, { Property: ['A*'] }, [
      obj({ Alpha: 1, Beta: 2, Alt: 3 }),
    ]);
    assert.deepEqual(Object.keys((result.values[0] as PSObject).properties), ['Alpha', 'Alt']);
  });

  it('errors on a duplicate -Property and keeps the first', async () => {
    // pwsh: AlreadyExistingUserSpecifiedPropertyNoExpand
    const result = await run(selectObject, { Property: ['A', 'A'] }, [obj({ A: 1 })]);
    assert.deepEqual(Object.keys((result.values[0] as PSObject).properties), ['A']);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]?.fullyQualifiedErrorId ?? '', /^AlreadyExistingUserSpecified/u);
  });

  it('selects an intrinsic property off a primitive', async () => {
    // pwsh: 'hello' | Select-Object Length  ->  Selected.System.String, Length 5
    const result = await run(selectObject, { Property: ['Length'] }, ['hello']);
    assert.equal(prop(result.values[0], 'Length'), 5);
    assert.equal(typeNamesOf(result.values[0])[0], 'Selected.System.String');
  });

  it('expands with -ExpandProperty, unrolling an array value one level', async () => {
    // pwsh: @(o{V=1},o{V=2}) | Select-Object -ExpandProperty V  ->  1,2
    //       @(o{V=@(1,2)})   | Select-Object -ExpandProperty V  ->  two objects
    const simple = await run(selectObject, { ExpandProperty: 'V' }, [obj({ V: 1 }), obj({ V: 2 })]);
    assert.deepEqual(simple.values, [1, 2]);
    const nested = await run(selectObject, { ExpandProperty: 'V' }, [obj({ V: [1, 2] })]);
    assert.deepEqual(nested.values, [1, 2]);
  });

  it('ERRORS on -ExpandProperty for a missing property and carries on', async () => {
    // pwsh: ExpandPropertyNotFound,Microsoft.PowerShell.Commands.SelectObjectCommand
    //       InvalidArgument / PSArgumentException / 'Property "V" cannot be found.'
    //       and the object that DOES have V is still emitted.
    const result = await run(selectObject, { ExpandProperty: 'V' }, [obj({ V: 1 }), obj({ W: 2 })]);
    assert.deepEqual(result.values, [1]);
    assert.equal(result.errors.length, 1);
    const error = result.errors[0];
    assert.equal(
      error?.fullyQualifiedErrorId,
      'ExpandPropertyNotFound,Microsoft.PowerShell.Commands.SelectObjectCommand',
    );
    assert.equal(error?.category, 'InvalidArgument');
    assert.equal(error?.exceptionType, 'System.Management.Automation.PSArgumentException');
    assert.equal(error?.message, 'Property "V" cannot be found.');
  });

  it('attaches -Property values onto each expanded object', async () => {
    // pwsh: $r = o{V=@(1,2); Tag='t'} | Select-Object -Property Tag -ExpandProperty V
    //       $r.Count -> 2; $r[0] -> 1; $r[0].Tag -> t; $r[0].GetType() -> System.Int32
    const result = await run(
      selectObject,
      { Property: ['Tag'], ExpandProperty: 'V' },
      [obj({ V: [1, 2], Tag: 't' })],
    );
    assert.equal(result.values.length, 2);
    assert.equal(prop(result.values[0], 'Tag'), 't');
    assert.equal((result.values[0] as PSObject).baseObject, 1);
    assert.equal(typeNamesOf(result.values[0])[0], 'System.Int32');
  });

  it('has a CASE-SENSITIVE -Unique that keeps input order', async () => {
    // pwsh: @('a','A')       | Select-Object -Unique  ->  a, A     (both kept)
    //       @('c','a','c','b') | Select-Object -Unique -> c, a, b  (not sorted)
    //       @(1,'1')         | Select-Object -Unique  ->  1        (string forms collide)
    assert.deepEqual((await run(selectObject, { Unique: true }, ['a', 'A'])).values, ['a', 'A']);
    assert.deepEqual((await run(selectObject, { Unique: true }, ['c', 'a', 'c', 'b'])).values, [
      'c',
      'a',
      'b',
    ]);
    assert.deepEqual((await run(selectObject, { Unique: true }, [1, '1'])).values, [1]);
  });

  it('reproduces the pwsh quirk that -Unique collapses distinct PSCustomObjects', async () => {
    // pwsh: @(o{K=1},o{K=1},o{K=2}) | Select-Object -Unique  ->  ONE object,
    // because ([pscustomobject]@{K=1}).ToString() is the empty string and every
    // custom object therefore hashes the same. Reproduced deliberately: a user
    // who learns this here must not be surprised by real PowerShell.
    const collapsed = await run(selectObject, { Unique: true }, [
      obj({ K: 1 }),
      obj({ K: 1 }),
      obj({ K: 2 }),
    ]);
    assert.equal(collapsed.values.length, 1);

    // ...and that with -Property it compares the constructed objects instead,
    // so it DOES tell them apart.
    const projected = await run(selectObject, { Property: ['K'], Unique: true }, [
      obj({ K: 1 }),
      obj({ K: 1 }),
      obj({ K: 2 }),
    ]);
    assert.equal(projected.values.length, 2);
  });

  it('applies -First to the input before -Unique dedupes', async () => {
    // pwsh: @(1,1,2,3) | Select-Object -Unique -First 2  ->  1
    // The window takes 1 and 1, and only then are they deduplicated.
    const result = await run(selectObject, { Unique: true, First: 2 }, [1, 1, 2, 3]);
    assert.deepEqual(result.values, [1]);
  });
});

// ---------------------------------------------------------------------------
// Sort-Object
// ---------------------------------------------------------------------------

describe('Sort-Object', () => {
  it('sorts strings culture-aware and case-insensitively', async () => {
    // pwsh: @('b','A','a','B') | Sort-Object  ->  A,a,b,B
    const result = await run(sortObject, {}, ['b', 'A', 'a', 'B']);
    assert.deepEqual(result.values, ['A', 'a', 'b', 'B']);
  });

  it('sorts numbers numerically', async () => {
    // pwsh: @(10,9,2) | Sort-Object  ->  2,9,10
    assert.deepEqual((await run(sortObject, {}, [10, 9, 2])).values, [2, 9, 10]);
  });

  it('puts lowercase first under -CaseSensitive', async () => {
    // pwsh: @('b','A','a','B') | Sort-Object -CaseSensitive  ->  a,A,b,B
    const result = await run(sortObject, { CaseSensitive: true }, ['b', 'A', 'a', 'B']);
    assert.deepEqual(result.values, ['a', 'A', 'b', 'B']);
  });

  it('is STABLE, which pwsh only guarantees with -Stable', async () => {
    // pwsh default at n=20 scrambles ties: 0:18 0:3 0:15 0:6 0:12 0:9 ...
    // pwsh -Stable gives:                  0:3 0:6 0:9 0:12 0:15 0:18 ...
    // This implementation always gives the -Stable answer. Recorded divergence.
    const input = Array.from({ length: 20 }, (_unused, index) =>
      obj({ Key: (index + 1) % 3, Idx: index + 1 }),
    );
    const result = await run(sortObject, { Property: ['Key'] }, input);
    const zeros = result.values.filter((value) => prop(value, 'Key') === 0);
    assert.deepEqual(column(zeros, 'Idx'), [3, 6, 9, 12, 15, 18]);
  });

  it('DROPS null input objects rather than sorting them anywhere', async () => {
    // pwsh: @(3,$null,1,$null,2) | Sort-Object  ->  1,2,3   (THREE objects)
    //       @(3,$null,1) | Sort-Object -Descending -> 3,1
    assert.deepEqual((await run(sortObject, {}, [3, null, 1, null, 2])).values, [1, 2, 3]);
    const desc = await run(sortObject, { Descending: true }, [3, null, 1]);
    assert.deepEqual(desc.values, [3, 1]);
  });

  it('sorts a null PROPERTY value first ascending and last descending', async () => {
    // pwsh: asc  -> null, one, three
    //       desc -> three, one, null
    const input = [obj({ N: 'three', V: 3 }), obj({ N: 'null', V: null }), obj({ N: 'one', V: 1 })];
    const asc = await run(sortObject, { Property: ['V'] }, input);
    assert.deepEqual(column(asc.values, 'N'), ['null', 'one', 'three']);
    const desc = await run(sortObject, { Property: ['V'], Descending: true }, input);
    assert.deepEqual(column(desc.values, 'N'), ['three', 'one', 'null']);
  });

  it('sorts an object MISSING the property LAST in both directions', async () => {
    // pwsh: asc  -> has1, has3, none
    //       desc -> has3, has1, none
    // A missing property is NOT a null: null flips with -Descending, this does not.
    const input = [obj({ N: 'has3', V: 3 }), obj({ N: 'none' }), obj({ N: 'has1', V: 1 })];
    const asc = await run(sortObject, { Property: ['V'] }, input);
    assert.deepEqual(column(asc.values, 'N'), ['has1', 'has3', 'none']);
    const desc = await run(sortObject, { Property: ['V'], Descending: true }, input);
    assert.deepEqual(column(desc.values, 'N'), ['has3', 'has1', 'none']);
  });

  it('sorts by several properties, with -Descending applying to all of them', async () => {
    // pwsh: A,B      ->  0/9 1/1 1/2
    //       A,B desc ->  1/2 1/1 0/9
    const input = [obj({ A: 1, B: 2 }), obj({ A: 1, B: 1 }), obj({ A: 0, B: 9 })];
    const asc = await run(sortObject, { Property: ['A', 'B'] }, input);
    assert.deepEqual(
      asc.values.map((v) => `${String(prop(v, 'A'))}/${String(prop(v, 'B'))}`),
      ['0/9', '1/1', '1/2'],
    );
    const desc = await run(sortObject, { Property: ['A', 'B'], Descending: true }, input);
    assert.deepEqual(
      desc.values.map((v) => `${String(prop(v, 'A'))}/${String(prop(v, 'B'))}`),
      ['1/2', '1/1', '0/9'],
    );
  });

  it('has a CASE-INSENSITIVE -Unique, unlike Select-Object -Unique', async () => {
    // pwsh: @('b','A','a','B','b') | Sort-Object -Unique              ->  A,b
    //       @('b','A','a','B','b') | Sort-Object -Unique -Descending  ->  b,A
    //       @(3,1,3,2,1)           | Sort-Object -Unique              ->  1,2,3
    assert.deepEqual((await run(sortObject, { Unique: true }, ['b', 'A', 'a', 'B', 'b'])).values, [
      'A',
      'b',
    ]);
    const desc = await run(sortObject, { Unique: true, Descending: true }, [
      'b',
      'A',
      'a',
      'B',
      'b',
    ]);
    assert.deepEqual(desc.values, ['b', 'A']);
    assert.deepEqual((await run(sortObject, { Unique: true }, [3, 1, 3, 2, 1])).values, [1, 2, 3]);
  });

  it('keeps the first object of each -Property -Unique group', async () => {
    // pwsh: @(o{K=1;T='first'},o{K=1;T='second'},o{K=2;T='third'})
    //         | Sort-Object K -Unique  ->  first, third
    const input = [
      obj({ K: 1, T: 'first' }),
      obj({ K: 1, T: 'second' }),
      obj({ K: 2, T: 'third' }),
    ];
    const result = await run(sortObject, { Property: ['K'], Unique: true }, input);
    assert.deepEqual(column(result.values, 'T'), ['first', 'third']);
  });

  it('handles an empty pipeline', async () => {
    assert.deepEqual((await run(sortObject, {}, [])).values, []);
  });
});

// ---------------------------------------------------------------------------
// Measure-Object
// ---------------------------------------------------------------------------

describe('Measure-Object', () => {
  it('does NOT count null input objects, though the pipeline passes them', async () => {
    // pwsh: (@($null,1) | Measure-Object).Count  ->  1
    //       @($null,1) | ForEach-Object { }      ->  runs TWICE
    const result = await run(measureObject, {}, [null, 1]);
    assert.equal(prop(result.values[0], 'Count'), 1);
    assert.equal(prop((await run(measureObject, {}, [null, null])).values[0], 'Count'), 0);
  });

  it('reports Count only, unless a switch asks for more', async () => {
    // pwsh: @(1,2) | Measure-Object  ->  Count 2, everything else blank
    const bare = (await run(measureObject, {}, [1, 2])).values[0];
    assert.equal(prop(bare, 'Count'), 2);
    assert.equal(prop(bare, 'Sum'), null);
    assert.equal(prop(bare, 'Average'), null);
    assert.equal(prop(bare, 'Maximum'), null);
  });

  it('computes Sum, Average, Minimum and Maximum', async () => {
    // pwsh: @(1,2,3) | Measure-Object -Sum -Average -Minimum -Maximum
    const result = await run(
      measureObject,
      { Sum: true, Average: true, Minimum: true, Maximum: true },
      [1, 2, 3],
    );
    const info = result.values[0];
    assert.equal(prop(info, 'Count'), 3);
    assert.equal(prop(info, 'Sum'), 6);
    assert.equal(prop(info, 'Average'), 2);
    assert.equal(prop(info, 'Minimum'), 1);
    assert.equal(prop(info, 'Maximum'), 3);
  });

  it('counts only the objects that HAVE the property, silently', async () => {
    // pwsh: @(o{V=1},o{Name='b'},o{V=3}) | Measure-Object -Property V -Sum
    //         ->  Count 2, Sum 4, ZERO errors
    // Count 2 of three objects. Not an error, and not Count 3.
    const result = await run(measureObject, { Property: ['V'], Sum: true }, [
      obj({ V: 1 }),
      obj({ Name: 'b' }),
      obj({ V: 3 }),
    ]);
    assert.equal(prop(result.values[0], 'Count'), 2);
    assert.equal(prop(result.values[0], 'Sum'), 4);
    assert.equal(result.errors.length, 0);
  });

  it('COUNTS a null property value but does not sum it', async () => {
    // pwsh: @(o{V=$null},o{V=$null},o{V=5}) | Measure-Object -Property V -Sum
    //         ->  Count 3, Sum 5
    // This is what makes "nulls are not counted" a rule about INPUT objects.
    const result = await run(measureObject, { Property: ['V'], Sum: true }, [
      obj({ V: null }),
      obj({ V: null }),
      obj({ V: 5 }),
    ]);
    assert.equal(prop(result.values[0], 'Count'), 3);
    assert.equal(prop(result.values[0], 'Sum'), 5);
    assert.equal(result.errors.length, 0);
  });

  it('emits NOTHING when no object has the property', async () => {
    // pwsh: @(o{Other=1}) | Measure-Object -Property V   ->  $null
    //       @()           | Measure-Object               ->  a Count 0 object
    const missing = await run(measureObject, { Property: ['V'] }, [obj({ Other: 1 })]);
    assert.deepEqual(missing.values, []);
    const empty = await run(measureObject, {}, []);
    assert.equal(empty.values.length, 1);
    assert.equal(prop(empty.values[0], 'Count'), 0);
  });

  it('lets ONE non-numeric value blank every numeric result', async () => {
    // pwsh: @('a',1) | Measure-Object -Sum
    //         ->  Count 2, Sum EMPTY, one NonNumericInputObject error
    // The 1 is perfectly numeric and is still not summed.
    const result = await run(measureObject, { Sum: true }, ['a', 1]);
    assert.equal(prop(result.values[0], 'Count'), 2);
    assert.equal(prop(result.values[0], 'Sum'), null);
    assert.equal(result.errors.length, 1);
    assert.equal(
      result.errors[0]?.fullyQualifiedErrorId,
      'NonNumericInputObject,Microsoft.PowerShell.Commands.MeasureObjectCommand',
    );
    assert.equal(result.errors[0]?.category, 'InvalidType');
    assert.equal(result.errors[0]?.message, 'Input object "a" is not numeric.');
  });

  it('converts numeric strings, booleans and empty strings', async () => {
    // pwsh: @('2','10') -Sum -> 12 ; @(' 5 ','3') -> 8 ; @('1e3') -> 1000
    //       @('') -> 0 ; @($true,$false) -> 1
    const cases: readonly (readonly [PSValue[], number])[] = [
      [['2', '10'], 12],
      [[' 5 ', '3'], 8],
      [['1e3'], 1000],
      [[''], 0],
      [[true, false], 1],
    ];
    for (const [input, expected] of cases) {
      const result = await run(measureObject, { Sum: true }, input);
      assert.equal(prop(result.values[0], 'Sum'), expected, JSON.stringify(input));
      assert.equal(result.errors.length, 0);
    }
  });

  it('switches to the object-typed result for non-numeric Min/Max', async () => {
    // pwsh: @('a','b') | Measure-Object -Maximum  ->  GenericObjectMeasureInfo
    //       @(1,2)     | Measure-Object -Maximum  ->  GenericMeasureInfo
    //       @('a','b') | Measure-Object -Maximum -Sum -> GenericMeasureInfo + errors
    const strings = await run(measureObject, { Maximum: true, Minimum: true }, ['pear', 'apple']);
    assert.equal(
      typeNamesOf(strings.values[0])[0],
      'Microsoft.PowerShell.Commands.GenericObjectMeasureInfo',
    );
    assert.equal(prop(strings.values[0], 'Maximum'), 'pear');
    assert.equal(prop(strings.values[0], 'Minimum'), 'apple');
    assert.equal(strings.errors.length, 0);

    const numeric = await run(measureObject, { Maximum: true }, [1, 2]);
    assert.equal(
      typeNamesOf(numeric.values[0])[0],
      'Microsoft.PowerShell.Commands.GenericMeasureInfo',
    );

    const forced = await run(measureObject, { Maximum: true, Sum: true }, ['a', 'b']);
    assert.equal(
      typeNamesOf(forced.values[0])[0],
      'Microsoft.PowerShell.Commands.GenericMeasureInfo',
    );
    assert.equal(forced.errors.length, 2);
  });

  it('orders mixed types the way pwsh does for Min/Max', async () => {
    // pwsh: @(3,'apple',1) | Measure-Object -Minimum -Maximum  ->  Min 1, Max apple
    const result = await run(measureObject, { Minimum: true, Maximum: true }, [3, 'apple', 1]);
    assert.equal(prop(result.values[0], 'Minimum'), 1);
    assert.equal(prop(result.values[0], 'Maximum'), 'apple');
  });

  it('measures text with a different result type and no Count at all', async () => {
    // pwsh: @('hello world','second line here') | Measure-Object -Line -Word -Character
    //         ->  Lines 2, Words 5, Characters 27, and the type is TextMeasureInfo
    const result = await run(measureObject, { Line: true, Word: true, Character: true }, [
      'hello world',
      'second line here',
    ]);
    const info = result.values[0];
    assert.equal(typeNamesOf(info)[0], 'Microsoft.PowerShell.Commands.TextMeasureInfo');
    assert.equal(prop(info, 'Lines'), 2);
    assert.equal(prop(info, 'Words'), 5);
    assert.equal(prop(info, 'Characters'), 27);
    assert.ok(!Object.hasOwn((info as PSObject).properties, 'Count'));
  });

  it('counts lines the way pwsh counts them, including the empty-string case', async () => {
    // Every row read off pwsh 7.6.5.
    const cases: readonly (readonly [string, number, number, number])[] = [
      ['', 0, 0, 0],
      ['a', 1, 1, 1],
      ['a\n', 1, 1, 2],
      ['a\nb', 2, 2, 3],
      ['a\n\nb', 3, 2, 4],
      ['\n', 1, 0, 1],
      ['a\r\nb', 2, 2, 4],
      ['a\n\n', 2, 1, 3],
      ['  spaced   out  ', 1, 2, 16],
    ];
    for (const [text, lines, words, characters] of cases) {
      const result = await run(measureObject, { Line: true, Word: true, Character: true }, [text]);
      const info = result.values[0];
      assert.equal(prop(info, 'Lines'), lines, `lines of ${JSON.stringify(text)}`);
      assert.equal(prop(info, 'Words'), words, `words of ${JSON.stringify(text)}`);
      assert.equal(prop(info, 'Characters'), characters, `chars of ${JSON.stringify(text)}`);
    }
  });

  it('leaves unrequested text fields null', async () => {
    // pwsh: @(123,4567) | Measure-Object -Character  ->  Characters 7, Lines and Words blank
    const result = await run(measureObject, { Character: true }, [123, 4567]);
    assert.equal(prop(result.values[0], 'Characters'), 7);
    assert.equal(prop(result.values[0], 'Lines'), null);
    assert.equal(prop(result.values[0], 'Words'), null);
  });

  it('skips nulls in text mode too', async () => {
    // pwsh: @($null,'a b') | Measure-Object -Line -Word -Character -> 1, 2, 3
    const result = await run(measureObject, { Line: true, Word: true, Character: true }, [
      null,
      'a b',
    ]);
    assert.equal(prop(result.values[0], 'Lines'), 1);
    assert.equal(prop(result.values[0], 'Words'), 2);
    assert.equal(prop(result.values[0], 'Characters'), 3);
  });

  it('refuses to mix the numeric and text parameter sets', async () => {
    // pwsh: @('a b') | Measure-Object -Sum -Word
    //         ->  AmbiguousParameterSet, and NO result object
    const result = await run(measureObject, { Sum: true, Word: true }, ['a b']);
    assert.deepEqual(result.values, []);
    assert.equal(result.exitCode, 1);
    assert.match(result.errors[0]?.fullyQualifiedErrorId ?? '', /^AmbiguousParameterSet,/u);
  });

  it('emits one result per -Property, each naming its property', async () => {
    // pwsh: $objs | Measure-Object -Property V,Name -Maximum  ->  two result objects
    const result = await run(measureObject, { Property: ['V', 'Name'], Maximum: true }, [
      obj({ Name: 'a', V: 1 }),
      obj({ Name: 'b' }),
      obj({ Name: 'c', V: 3 }),
    ]);
    assert.equal(result.values.length, 2);
    assert.deepEqual(column(result.values, 'Property'), ['V', 'Name']);
    assert.equal(prop(result.values[0], 'Count'), 2);
    assert.equal(prop(result.values[0], 'Maximum'), 3);
    assert.equal(prop(result.values[1], 'Count'), 3);
    assert.equal(prop(result.values[1], 'Maximum'), 'c');
  });

  it('measures an intrinsic property', async () => {
    // pwsh: @('abc','de') | Measure-Object -Property Length -Sum  ->  Count 2, Sum 5
    const result = await run(measureObject, { Property: ['Length'], Sum: true }, ['abc', 'de']);
    assert.equal(prop(result.values[0], 'Count'), 2);
    assert.equal(prop(result.values[0], 'Sum'), 5);
  });
});

// ---------------------------------------------------------------------------
// Group-Object
// ---------------------------------------------------------------------------

describe('Group-Object', () => {
  it('emits GroupInfo with Count, Name, Group and Values', async () => {
    // pwsh: element type Microsoft.PowerShell.Commands.GroupInfo,
    //       Name is a STRING even when the key is a number.
    const result = await run(groupObject, { Property: ['K'] }, [
      obj({ K: 'a', N: 1 }),
      obj({ K: 'b', N: 2 }),
      obj({ K: 'a', N: 3 }),
    ]);
    assert.deepEqual(typeNamesOf(result.values[0]), [
      'Microsoft.PowerShell.Commands.GroupInfo',
      'System.Object',
    ]);
    assert.deepEqual(column(result.values, 'Name'), ['a', 'b']);
    assert.deepEqual(column(result.values, 'Count'), [2, 1]);
    const firstGroup = prop(result.values[0], 'Group');
    assert.ok(Array.isArray(firstGroup));
    assert.deepEqual(column(firstGroup, 'N'), [1, 3]);
  });

  it('makes Name a string while Values keeps the raw value', async () => {
    // pwsh: @(1,1,2) | Group-Object  ->  Name is System.String, Values[0] is System.Int32
    const result = await run(groupObject, {}, [1, 1, 2]);
    assert.equal(prop(result.values[0], 'Name'), '1');
    assert.deepEqual(prop(result.values[0], 'Values'), [1]);
  });

  it('orders groups by key, not by first appearance', async () => {
    // pwsh: @('z','m','b','a') | Group-Object  ->  a,b,m,z   (same for m,z,a,b)
    //       @(10,9,2)          | Group-Object  ->  2,9,10    (by value, not by text)
    assert.deepEqual(
      column((await run(groupObject, {}, ['z', 'm', 'b', 'a'])).values, 'Name'),
      ['a', 'b', 'm', 'z'],
    );
    assert.deepEqual(
      column((await run(groupObject, {}, ['m', 'z', 'a', 'b'])).values, 'Name'),
      ['a', 'b', 'm', 'z'],
    );
    assert.deepEqual(column((await run(groupObject, {}, [10, 9, 2])).values, 'Name'), [
      '2',
      '9',
      '10',
    ]);
  });

  it('groups case-insensitively unless -CaseSensitive', async () => {
    // pwsh: @('a','A','b') | Group-Object                 ->  a:2 b:1
    //       @('a','A','b') | Group-Object -CaseSensitive  ->  a:1 A:1 b:1
    const insensitive = await run(groupObject, {}, ['a', 'A', 'b']);
    assert.deepEqual(column(insensitive.values, 'Name'), ['a', 'b']);
    assert.deepEqual(column(insensitive.values, 'Count'), [2, 1]);
    const sensitive = await run(groupObject, { CaseSensitive: true }, ['a', 'A', 'b']);
    assert.equal(sensitive.values.length, 3);
  });

  it('keeps an EMPTY Group property under -NoElement, and changes type', async () => {
    // pwsh: typenames GroupInfoNoElement | GroupInfo | System.Object
    //       and ($g)[0].Group.Count -> 0 — the property is still there.
    const result = await run(groupObject, { Property: ['K'], NoElement: true }, [
      obj({ K: 'a' }),
      obj({ K: 'a' }),
    ]);
    assert.deepEqual(typeNamesOf(result.values[0]), [
      'Microsoft.PowerShell.Commands.GroupInfoNoElement',
      'Microsoft.PowerShell.Commands.GroupInfo',
      'System.Object',
    ]);
    assert.equal(prop(result.values[0], 'Count'), 2);
    assert.deepEqual(prop(result.values[0], 'Group'), []);
  });

  it('gives a null or missing key the EMPTY STRING as its Name', async () => {
    // pwsh: Name is '' and `$null -eq $group.Name` is False.
    const nulls = await run(groupObject, { Property: ['K'] }, [
      obj({ K: null }),
      obj({ K: 'a' }),
      obj({ K: null }),
    ]);
    assert.deepEqual(column(nulls.values, 'Name'), ['', 'a']);
    assert.equal(prop(nulls.values[0], 'Count'), 2);

    const missing = await run(groupObject, { Property: ['K'] }, [obj({ K: 'a' }), obj({ Other: 1 })]);
    assert.deepEqual(column(missing.values, 'Name'), ['', 'a']);
  });

  it('joins a multi-property Name with a comma AND a space', async () => {
    // pwsh: Group-Object A,B  ->  Name "1, x"; Values is the raw pair.
    const result = await run(groupObject, { Property: ['A', 'B'] }, [
      obj({ A: 1, B: 'x' }),
      obj({ A: 1, B: 'x' }),
      obj({ A: 1, B: 'y' }),
    ]);
    assert.deepEqual(column(result.values, 'Name'), ['1, x', '1, y']);
    assert.deepEqual(prop(result.values[0], 'Values'), [1, 'x']);
  });

  it('drops null input objects', async () => {
    // pwsh: @($null,1) | Group-Object  ->  one group, Name "1", Count 1
    const result = await run(groupObject, {}, [null, 1, null]);
    assert.equal(result.values.length, 1);
    assert.equal(prop(result.values[0], 'Count'), 1);
  });

  it('produces nothing from an empty pipeline', async () => {
    assert.deepEqual((await run(groupObject, {}, [])).values, []);
  });
});

// ---------------------------------------------------------------------------
// Get-Member
// ---------------------------------------------------------------------------

describe('Get-Member', () => {
  it('reports the members of a custom object with pwsh definitions', async () => {
    // pwsh: [pscustomobject]@{Name='x'; Size=42} | Get-Member
    //   Equals      Method       bool Equals(System.Object obj)
    //   GetHashCode Method       int GetHashCode()
    //   GetType     Method       type GetType()
    //   ToString    Method       string ToString()
    //   Name        NoteProperty string Name=x
    //   Size        NoteProperty int Size=42
    const result = await run(getMember, {}, [obj({ Name: 'x', Size: 42 })]);
    assert.deepEqual(typeNamesOf(result.values[0]), [
      'Microsoft.PowerShell.Commands.MemberDefinition',
      'System.Object',
    ]);
    assert.deepEqual(
      result.values.map((v) => `${String(prop(v, 'Name'))}|${String(prop(v, 'MemberType'))}`),
      [
        'Equals|Method',
        'GetHashCode|Method',
        'GetType|Method',
        'ToString|Method',
        'Name|NoteProperty',
        'Size|NoteProperty',
      ],
    );
    assert.deepEqual(column(result.values, 'Definition').slice(0, 4), [
      'bool Equals(System.Object obj)',
      'int GetHashCode()',
      'type GetType()',
      'string ToString()',
    ]);
    assert.equal(prop(result.values[4], 'Definition'), 'string Name=x');
    assert.equal(prop(result.values[5], 'Definition'), 'int Size=42');
    assert.equal(
      prop(result.values[0], 'TypeName'),
      'System.Management.Automation.PSCustomObject',
    );
  });

  it('uses the C# keyword aliases pwsh uses in a Definition', async () => {
    // pwsh: double D=1.5 / bool B=True / object N=null / Object[] Arr=System.Object[]
    const result = await run(getMember, { MemberType: ['NoteProperty'] }, [
      obj({ D: 1.5, B: true, N: null, Arr: [1, 2] }),
    ]);
    const definitions = new Map(
      result.values.map((v) => [String(prop(v, 'Name')), String(prop(v, 'Definition'))]),
    );
    assert.equal(definitions.get('D'), 'double D=1.5');
    assert.equal(definitions.get('B'), 'bool B=True');
    assert.equal(definitions.get('N'), 'object N=null');
    assert.equal(definitions.get('Arr'), 'Object[] Arr=System.Object[]');
  });

  it('sorts by member type and then by name, case-insensitively', async () => {
    // pwsh: [pscustomobject]@{Zed=1;Alpha=2;mid=3} | Get-Member
    //         ->  Methods first, then Alpha, mid, Zed
    const result = await run(getMember, {}, [obj({ Zed: 1, Alpha: 2, mid: 3 })]);
    assert.deepEqual(column(result.values, 'Name'), [
      'Equals',
      'GetHashCode',
      'GetType',
      'ToString',
      'Alpha',
      'mid',
      'Zed',
    ]);
  });

  it('takes members from only the FIRST object of each type', async () => {
    // pwsh: @(o{A=1},o{B=2},o{A=1;C=3}) | Get-Member  ->  ...,A     (no B, no C)
    const result = await run(getMember, { MemberType: ['NoteProperty'] }, [
      obj({ A: 1 }),
      obj({ B: 2 }),
      obj({ A: 1, C: 3 }),
    ]);
    assert.deepEqual(column(result.values, 'Name'), ['A']);
  });

  it('reports the intrinsic members it does model, for a string and an array', async () => {
    // pwsh reports 54 members for a string; this reports the modelled subset,
    // and the manifest says so rather than implying completeness.
    const text = await run(getMember, { MemberType: ['Property'] }, ['abc']);
    assert.deepEqual(column(text.values, 'Name'), ['Length']);
    assert.equal(prop(text.values[0], 'Definition'), 'int Length {get;}');
    assert.equal(prop(text.values[0], 'TypeName'), 'System.String');

    const array = await run(getMember, { MemberType: ['Property'] }, [[1, 2] as PSValue]);
    assert.deepEqual(column(array.values, 'Name'), ['Count', 'Length']);
    assert.equal(prop(array.values[0], 'TypeName'), 'System.Object[]');
  });

  it('errors when there is nothing to inspect', async () => {
    // pwsh: @() | Get-Member and @($null) | Get-Member both report
    //   NoObjectInGetMember,Microsoft.PowerShell.Commands.GetMemberCommand
    for (const input of [[], [null]] as PSValue[][]) {
      const result = await run(getMember, {}, input);
      assert.deepEqual(result.values, []);
      assert.equal(result.exitCode, 1);
      assert.equal(
        result.errors[0]?.fullyQualifiedErrorId,
        'NoObjectInGetMember,Microsoft.PowerShell.Commands.GetMemberCommand',
      );
      assert.equal(result.errors[0]?.message, 'You must specify an object for the Get-Member cmdlet.');
    }
  });

  it('accepts a null followed by a real object without complaint', async () => {
    // pwsh: @($null,[pscustomobject]@{A=1}) | Get-Member  ->  no error
    const result = await run(getMember, {}, [null, obj({ A: 1 })]);
    assert.equal(result.errors.length, 0);
    assert.deepEqual(column(result.values, 'Name').slice(-1), ['A']);
  });

  it('filters by -Name with wildcards', async () => {
    const result = await run(getMember, { Name: ['Get*'] }, [obj({ A: 1 })]);
    assert.deepEqual(column(result.values, 'Name'), ['GetHashCode', 'GetType']);
  });

  it('reports members for several types, in first-seen order', async () => {
    const result = await run(getMember, { MemberType: ['Property', 'NoteProperty'] }, [
      'abc',
      obj({ A: 1 }),
    ]);
    assert.deepEqual(column(result.values, 'TypeName'), [
      'System.String',
      'System.Management.Automation.PSCustomObject',
    ]);
  });
});

// ---------------------------------------------------------------------------
// the registry, and the commands working together
// ---------------------------------------------------------------------------

describe('the object cmdlets as a set', () => {
  it('registers every command under its name and its aliases', () => {
    for (const [name, module] of [
      ['where-object', whereObject],
      ['where', whereObject],
      ['?', whereObject],
      ['select-object', selectObject],
      ['select', selectObject],
      ['sort-object', sortObject],
      ['sort', sortObject],
      ['measure-object', measureObject],
      ['measure', measureObject],
      ['group-object', groupObject],
      ['group', groupObject],
      ['get-member', getMember],
      ['gm', getMember],
    ] as const) {
      assert.equal(OBJECT_CMDLET_INDEX.get(name), module, name);
    }
  });

  it('declares every command as native-semantic and read-only', () => {
    for (const module of OBJECT_CMDLET_INDEX.values()) {
      assert.equal(module.manifest.fidelity, 'native-semantic');
      assert.equal(module.manifest.risk, 'read');
      assert.deepEqual(module.manifest.capabilities, []);
      assert.ok((module.manifest.notes ?? '').length > 0, `${module.manifest.display} needs notes`);
    }
  });

  it('never claims hand-written parameter metadata came from real pwsh', () => {
    for (const module of OBJECT_CMDLET_INDEX.values()) {
      assert.equal(module.manifest.parameterSource, 'declared');
      for (const parameter of module.manifest.parameters) {
        assert.equal(parameter.verified, false, `${module.manifest.display} -${parameter.name}`);
      }
    }
  });

  it('runs a realistic chain end to end', async () => {
    // Get-Process | Where-Object CPU -gt 10 | Sort-Object CPU -Descending |
    //   Select-Object Name,CPU -First 2
    const processes = [
      obj({ Name: 'idle', CPU: 1 }),
      obj({ Name: 'chrome', CPU: 95 }),
      obj({ Name: 'code', CPU: 42 }),
      obj({ Name: 'node', CPU: 11 }),
    ];
    const result = await runChain(
      processes,
      [whereObject, { Property: 'CPU', GT: true, Value: 10 }],
      [sortObject, { Property: ['CPU'], Descending: true }],
      [selectObject, { Property: ['Name', 'CPU'], First: 2 }],
    );
    assert.deepEqual(column(result.values, 'Name'), ['chrome', 'code']);
    assert.deepEqual(column(result.values, 'CPU'), [95, 42]);
    assert.equal(typeNamesOf(result.values[0])[0], 'Selected.System.Management.Automation.PSCustomObject');
  });

  it('groups and then measures, which is the shape a report takes', async () => {
    const rows = [
      obj({ Team: 'red', Score: 3 }),
      obj({ Team: 'blue', Score: 5 }),
      obj({ Team: 'red', Score: 7 }),
    ];
    const grouped = await run(groupObject, { Property: ['Team'] }, rows);
    assert.deepEqual(column(grouped.values, 'Name'), ['blue', 'red']);
    const counted = await run(measureObject, { Property: ['Count'], Sum: true }, grouped.values);
    assert.equal(prop(counted.values[0], 'Sum'), 3);
  });

  it('lets Get-Member describe what Select-Object produced', async () => {
    const selected = await run(selectObject, { Property: ['A'] }, [obj({ A: 1, B: 2 })]);
    const members = await run(getMember, { MemberType: ['NoteProperty'] }, selected.values);
    assert.deepEqual(column(members.values, 'Name'), ['A']);
    assert.equal(
      prop(members.values[0], 'TypeName'),
      'Selected.System.Management.Automation.PSCustomObject',
    );
  });
});
