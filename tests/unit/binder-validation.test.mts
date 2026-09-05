/**
 * Coercion and validation, measured against pwsh 7.6.5.
 *
 * Conversion is where a binder can be confidently, silently wrong: every case
 * below produces a number either way, and four of them produce the WRONG number
 * under the obvious implementation.
 *
 *   [int]'2.5' is 2 and [int]'3.5' is 4 — .NET rounds half to EVEN, so
 *              Math.round is wrong on half of all midpoints.
 *   [int]'1,000' is 1000, and so is '1,0,0' — group separators are dropped
 *              without the grouping being checked.
 *   [int]'' is 0, not a failure.
 *   [bool]'false' is TRUE, because a non-empty string is truthy. Only the
 *              literal token $false is false, which is exactly why
 *              `-Flag:$false` and `-Flag:'false'` are different things.
 *
 * The validation half carries the reference implementation's own sentences.
 * They are asserted verbatim because a paraphrase is indistinguishable from a
 * regression when someone greps the output.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { CompatibilityView } from '../../src/commands/invocation.ts';
import type { CommandManifest, ParameterMetadata, ParameterSetBinding } from '../../src/commands/manifest.ts';
import {
  bindParameters,
  coerceArgument,
  coerceScalar,
  parseValidationRule,
  roundHalfToEven,
  tryBindParameters,
  validate,
} from '../../src/binding/index.ts';
import type { ParameterBindingError } from '../../src/binding/index.ts';

// --- fixtures (kept local so each test file stands on its own) --------------

function profileView(file: string): CompatibilityView {
  const raw: unknown = JSON.parse(
    readFileSync(new URL(`../../compat/profiles/${file}`, import.meta.url), 'utf8'),
  );
  const behaviors = (raw as { behaviors?: Record<string, boolean | number | string> }).behaviors ?? {};
  return {
    displayVersion: (raw as { displayVersion?: string }).displayVersion ?? '?',
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
    implementationStatus: 'implemented',
  };
}

function failure(
  args: readonly string[],
  target: CommandManifest,
  profile: CompatibilityView = V76,
): ParameterBindingError {
  const outcome = tryBindParameters(args, target, profile);
  assert.equal(outcome.ok, false, 'expected binding to fail');
  if (outcome.ok) throw new Error('unreachable');
  return outcome.error;
}

// ---------------------------------------------------------------------------

describe('integer conversion', () => {
  const INT = manifest('Test-Int', [param('Count', { type: 'System.Int32' })]);
  const count = (text: string): unknown =>
    bindParameters(['-Count', text], INT, V76).parameters['Count'];

  it('parses the ordinary forms', () => {
    // pwsh: Test-Pos -Count '5' / ' 5 ' / '+7' / '-7' / ''
    assert.equal(count('5'), 5);
    assert.equal(count(' 5 '), 5);
    assert.equal(count('+7'), 7);
    assert.equal(count('-7'), -7);
    assert.equal(count(''), 0); // an empty string is a zero, not a failure
  });

  it('rounds midpoints to EVEN, not away from zero', () => {
    // pwsh: '5.7'->6  '5.4'->5  '2.5'->2  '3.5'->4  '4.5'->4  '5.5'->6
    // Math.round would give 3 for 2.5 and 5 for 4.5. This is the single most
    // likely silent wrongness in the whole coercion path.
    assert.equal(count('5.7'), 6);
    assert.equal(count('5.4'), 5);
    assert.equal(count('2.5'), 2);
    assert.equal(count('3.5'), 4);
    assert.equal(count('4.5'), 4);
    assert.equal(count('5.5'), 6);
    assert.equal(roundHalfToEven(-2.5), -2);
  });

  it('accepts hex, binary and exponent forms', () => {
    // pwsh: [int]'0x10' -> 16 ; [int]'0b101' -> 5 ; [int]'1e3' -> 1000
    assert.equal(count('0x10'), 16);
    assert.equal(count('0b101'), 5);
    assert.equal(count('1e3'), 1000);
  });

  it('drops group separators without checking the grouping', () => {
    // pwsh: [int]'1,000' -> 1000, and so are '1,0,0' -> 100, '12,34' -> 1234.
    assert.equal(count('1,000'), 1000);
    assert.equal(count('1,0,0'), 100);
    assert.equal(count('12,34'), 1234);
  });

  it('normalises negative zero, which PowerShell does not have', () => {
    // assert.equal is Object.is-based, so this fails loudly if -0 leaks.
    assert.equal(count('-0'), 0);
    assert.equal(Object.is(count('-0'), -0), false);
  });

  it('rejects what .NET rejects, using the reference sentence', () => {
    // pwsh: Test-Pos -Count abc
    //   Cannot process argument transformation on parameter 'Count'.
    //   Cannot convert value "abc" to type "System.Int32".
    //   Error: "The input string 'abc' was not in a correct format."
    const error = failure(['-Count', 'abc'], INT);
    assert.equal(error.kind, 'ParameterArgumentTransformationError');
    assert.equal(
      error.message,
      "Cannot process argument transformation on parameter 'Count'. " +
        'Cannot convert value "abc" to type "System.Int32". ' +
        'Error: "The input string \'abc\' was not in a correct format."',
    );
    assert.equal(
      error.innerMessage,
      'Cannot convert value "abc" to type "System.Int32". ' +
        'Error: "The input string \'abc\' was not in a correct format."',
    );
    assert.equal(
      error.innerExceptionTypeName,
      'System.Management.Automation.ArgumentTransformationMetadataException',
    );
  });

  it('rejects underscores, infinities and overflow', () => {
    // pwsh: '1_000', 'Infinity' and '1e400' all fail; JavaScript's Number()
    // would happily return Infinity for two of them.
    assert.equal(failure(['-Count', '1_000'], INT).kind, 'ParameterArgumentTransformationError');
    assert.equal(failure(['-Count', 'Infinity'], INT).kind, 'ParameterArgumentTransformationError');
    assert.equal(failure(['-Count', '1e400'], INT).kind, 'ParameterArgumentTransformationError');
  });

  it('reports overflow with the range sentence, not the format one', () => {
    // pwsh: Test-T -Count '2147483648'
    //   Error: "Value was either too large or too small for an Int32."
    assert.equal(count('2147483647'), 2147483647);
    assert.equal(
      failure(['-Count', '2147483648'], INT).innerMessage,
      'Cannot convert value "2147483648" to type "System.Int32". ' +
        'Error: "Value was either too large or too small for an Int32."',
    );
  });

  it('keeps Int64 exact by binding a bigint', () => {
    // pwsh: [long]'9223372036854775807' binds exactly. A JS number would round
    // it to …808, and psobject.ts already maps bigint to System.Int64.
    const long = manifest('Test-Long', [param('Big', { type: 'System.Int64' })]);
    assert.equal(
      bindParameters(['-Big', '9223372036854775807'], long, V76).parameters['Big'],
      9223372036854775807n,
    );
  });
});

describe('other conversions', () => {
  it('wraps a single value in an array for an array-typed parameter', () => {
    // pwsh: Test-Pos -Path 'one'  ->  Path = [one] (System.String[])
    const result = coerceArgument(['one'], 'System.String[]');
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.value : null, ['one']);
  });

  it('does not treat an assembly-qualified generic as an array', () => {
    // Get-ChildItem -Attributes is a FlagsExpression`1[[…]] and ends in ']]'.
    // Testing for a bracket rather than a '[]' suffix would array-ify it.
    const type =
      'System.Management.Automation.FlagsExpression`1[[System.IO.FileAttributes, System.Private.CoreLib]]';
    const result = coerceScalar('Hidden', type);
    assert.equal(result.ok && result.value, 'Hidden');
  });

  it('reads $true and $false as booleans and anything else as a string', () => {
    // pwsh: [bool]'false' is True and [bool]'' is False, but -Flag:$false
    // binds False. Only the literal token is a boolean.
    const asBool = (text: string): unknown => {
      const result = coerceScalar(text, 'System.Boolean');
      assert.equal(result.ok, true, `expected ${text} to convert`);
      return result.ok ? result.value : undefined;
    };
    assert.equal(asBool('$false'), false);
    assert.equal(asBool('$TRUE'), true);
    assert.equal(asBool('false'), true);
    assert.equal(asBool(''), false);
    assert.equal(asBool('0'), false);
  });

  it('passes an unmodelled type through as the original string', () => {
    // Inventing a conversion for an enum or a provider type would be a
    // fiction; the string is exactly what the user typed.
    const result = coerceScalar('Ascii', 'System.Text.Encoding');
    assert.equal(result.ok && result.value, 'Ascii');
  });
});

describe('validation attributes', () => {
  const withRules = (validation: readonly string[], type = 'System.String'): CommandManifest =>
    manifest('Test-Val', [param('Value', { type, validation })]);

  const reject = (validation: readonly string[], text: string, type?: string): string => {
    const error = failure(['-Value', text], withRules(validation, type));
    assert.equal(error.kind, 'ParameterArgumentValidationError');
    assert.equal(error.exceptionTypeName, 'System.Management.Automation.ParameterBindingValidationException');
    return error.innerMessage ?? '';
  };

  it('ValidateNotNullOrEmpty', () => {
    // pwsh: Test-Val -Property ''  /  @()  /  @('A','')  — one sentence covers
    // all three, which is not what the attribute's name suggests.
    assert.equal(
      reject(['ValidateNotNullOrEmptyAttribute'], ''),
      'The argument is null, empty, or an element of the argument collection contains a null value. ' +
        'Supply a collection that does not contain any null values and then try the command again.',
    );
    assert.equal(
      reject(['ValidateNotNullOrEmpty'], '', 'System.String[]'),
      'The argument is null, empty, or an element of the argument collection contains a null value. ' +
        'Supply a collection that does not contain any null values and then try the command again.',
    );
  });

  it('ValidateSet, which is CASE-INSENSITIVE and does not normalise', () => {
    // pwsh: Test-Val -Expand 'coreonly' binds 'coreonly' — the user's casing
    // survives — while 'Nope' is rejected.
    assert.equal(
      reject(["ValidateSet('CoreOnly','EnumOnly','Both')"], 'Nope'),
      'The argument "Nope" does not belong to the set "CoreOnly,EnumOnly,Both" ' +
        'specified by the ValidateSet attribute. Supply an argument that is in the set and then try the command again.',
    );
    const ok = bindParameters(
      ['-Value', 'coreonly'],
      withRules(["ValidateSet('CoreOnly','EnumOnly','Both')"]),
      V76,
    );
    assert.equal(ok.parameters['Value'], 'coreonly');
  });

  it('ValidateRange, both ends', () => {
    // pwsh: Test-Val -Depth -1 and -Depth 101 against ValidateRange(0,100)
    assert.equal(
      reject(['ValidateRange(0,100)'], '-1', 'System.Int32'),
      'The -1 argument is less than the minimum allowed range of 0. ' +
        'Supply an argument that is greater than or equal to 0 and then try the command again.',
    );
    assert.equal(
      reject(['ValidateRange(0,100)'], '101', 'System.Int32'),
      'The 101 argument is greater than the maximum allowed range of 100. ' +
        'Supply an argument that is less than or equal to 100 and then try the command again.',
    );
  });

  it('ValidatePattern', () => {
    // pwsh: Test-Val -Digits 'ab' against ValidatePattern('^\d+$')
    assert.equal(
      reject(['ValidatePattern(\'^\\d+$\')'], 'ab'),
      'The argument "ab" does not match the "^\\d+$" pattern. ' +
        'Supply an argument that matches "^\\d+$" and try the command again.',
    );
    assert.equal(
      bindParameters(['-Value', '12'], withRules(['ValidatePattern(\'^\\d+$\')']), V76).parameters[
        'Value'
      ],
      '12',
    );
  });

  it('ValidateLength, whose two halves are worded differently', () => {
    // pwsh, verbatim — note "the 6 argument" in the second sentence. The
    // reference implementation really does phrase the two ends inconsistently.
    assert.equal(
      reject(['ValidateLength(2,5)'], 'a'),
      'The character length (1) of the argument is too short. ' +
        'Specify an argument with a length that is greater than or equal to "2", and then try the command again.',
    );
    assert.equal(
      reject(['ValidateLength(2,5)'], 'abcdef'),
      'The character length of the 6 argument is too long. ' +
        'Shorten the character length of the argument so it is fewer than or equal to "5" characters, and then try the command again.',
    );
  });

  it('ValidateCount, over an argument list rather than one token', () => {
    // pwsh: Test-Val -Context 1,2,3 against ValidateCount(1,2)
    //   The parameter requires at least 1 value(s) and no more than 2 value(s)
    //   - 3 value(s) were provided.
    // Three values reach one parameter only through remaining-arguments here,
    // because a named parameter takes exactly one token.
    const counted = manifest('Select-String', [
      param('Context', {
        type: 'System.Int32[]',
        validation: ['ValidateCount(1,2)'],
        sets: anySet({ position: 0 }),
      }),
    ]);
    const outcome = tryBindParameters(['1', '2', '3'], counted, V76, {
      valueFromRemainingArguments: ['Context'],
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(
      outcome.error.innerMessage,
      'The parameter requires at least 1 value(s) and no more than 2 value(s) - 3 value(s) were provided.',
    );
    const fine = bindParameters(['1', '2'], counted, V76, {
      valueFromRemainingArguments: ['Context'],
    });
    assert.deepEqual(fine.parameters['Context'], [1, 2]);
  });

  it('ValidateNotNull, checked directly because a token is never null', () => {
    const rule = parseValidationRule('ValidateNotNullAttribute');
    assert.notEqual(rule, null);
    const failed = validate(rule === null ? [] : [rule], null, V76);
    assert.equal(
      failed?.reason,
      'The argument is null. Provide a valid value for the argument, and then try running the command again.',
    );
  });
});

describe('validation the manifest cannot express', () => {
  // CommandManifest flattens attributes to bare names, so the captured
  // `ValidateRangeAttribute` on Get-Date -Month arrives without its bounds.
  const bare = manifest('Get-Date', [
    param('Month', { type: 'System.Int32', validation: ['ValidateRangeAttribute'] }),
  ]);

  it('does not enforce an attribute whose arguments were lost, and says so', () => {
    const bound = bindParameters(['-Month', '13'], bare, V76);
    assert.equal(bound.parameters['Month'], 13);
    assert.deepEqual(bound.unenforcedValidation, ['Month:ValidateRange']);
  });

  it('enforces it once the arguments are supplied out of band', () => {
    // pwsh: Get-Date -Month 13
    //   The 13 argument is greater than the maximum allowed range of 12.
    const outcome = tryBindParameters(['-Month', '13'], bare, V76, {
      validationDetails: [{ parameter: 'Month', attribute: 'ValidateRange', arguments: ['1', '12'] }],
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(
      outcome.error.innerMessage,
      'The 13 argument is greater than the maximum allowed range of 12. ' +
        'Supply an argument that is less than or equal to 12 and then try the command again.',
    );
    const fine = bindParameters(['-Month', '12'], bare, V76, {
      validationDetails: [{ parameter: 'Month', attribute: 'ValidateRangeAttribute', arguments: ['1', '12'] }],
    });
    assert.equal(fine.parameters['Month'], 12);
    assert.deepEqual(fine.unenforcedValidation, []);
  });

  it('tolerates a ValidateRange with no bounds at all', () => {
    // Test-Connection -Count carries a ValidateRangeKind rather than numbers,
    // and the capture records the attribute with neither min nor max.
    const kind = manifest('Test-Connection', [
      param('Count', { type: 'System.Int32', validation: ['ValidateRange()'] }),
    ]);
    assert.equal(bindParameters(['-Count', '4'], kind, V76).parameters['Count'], 4);
  });
});

describe('validation that depends on the profile', () => {
  // PR 26552 adds ValidateNotNullOrEmpty to -Property on the Format-* commands.
  // Verified on 7.6.5: `Format-Table -Property ''` BINDS there and only fails
  // later inside the formatter, with ExpressionEmptyString2 and a
  // NotSupportedException — a different error from a binding failure.
  const formatTable = manifest('Format-Table', [
    param('Property', { type: 'System.Object[]', sets: anySet({ position: 0 }) }),
  ]);

  it('accepts an empty -Property under 7.6 and rejects it under 7.7', () => {
    const bound = bindParameters(['-Property', ''], formatTable, V76);
    assert.deepEqual(bound.parameters['Property'], ['']);

    const error = failure(['-Property', ''], formatTable, V77);
    assert.equal(error.kind, 'ParameterArgumentValidationError');
    assert.equal(
      error.innerMessage,
      'The argument is null, empty, or an element of the argument collection contains a null value. ' +
        'Supply a collection that does not contain any null values and then try the command again.',
    );
  });

  it('comes from the flag, not from the command name or the version string', () => {
    // The same manifest under a view that only differs in the flag.
    const off: CompatibilityView = {
      displayVersion: '7.7.0-preview.4',
      behavior: <T extends boolean | number | string>(_key: string, fallback: T): T => fallback,
    };
    assert.deepEqual(bindParameters(['-Property', ''], formatTable, off).parameters['Property'], ['']);
    assert.equal(V76.behavior('format.property.rejectNullOrEmpty', true), false);
    assert.equal(V77.behavior('format.property.rejectNullOrEmpty', false), true);
  });

  it('leaves a non-Format command alone under either profile', () => {
    const other = manifest('Select-Object', [param('Property', { type: 'System.Object[]' })]);
    assert.deepEqual(bindParameters(['-Property', ''], other, V77).parameters['Property'], ['']);
  });

  it('changes the exception type reported for a null-or-empty failure', () => {
    // PR 26668. The 7.6 value is verified — pwsh 7.6.5 reports
    // ValidationMetadataException inside a ParameterBindingValidationException.
    // The 7.7 value comes from the recorded delta and could NOT be verified
    // here, because only 7.6.5 is installed.
    const vnoe = manifest('Test-Val', [
      param('Value', { validation: ['ValidateNotNullOrEmpty'] }),
    ]);
    assert.equal(
      failure(['-Value', ''], vnoe, V76).innerExceptionTypeName,
      'System.Management.Automation.ValidationMetadataException',
    );
    assert.equal(
      failure(['-Value', ''], vnoe, V77).innerExceptionTypeName,
      'System.ArgumentException',
    );
  });
});

describe('attribute parsing', () => {
  it('accepts the bare reflection name and the parameterised form alike', () => {
    assert.deepEqual(parseValidationRule('ValidateNotNullOrEmptyAttribute'), {
      kind: 'NotNullOrEmpty',
    });
    assert.deepEqual(parseValidationRule('ValidateSet("A", "B")'), {
      kind: 'Set',
      values: ['A', 'B'],
    });
    assert.deepEqual(parseValidationRule('ValidateSetAttribute'), {
      kind: 'Unparameterised',
      attribute: 'ValidateSet',
    });
  });

  it('ignores attributes that are not validation at all', () => {
    // The captured list mixes AliasAttribute, ArgumentCompleter and
    // CredentialAttribute in with the real rules.
    for (const name of ['AliasAttribute', 'ArgumentCompleterAttribute', 'CredentialAttribute']) {
      assert.equal(parseValidationRule(name), null);
    }
  });
});
