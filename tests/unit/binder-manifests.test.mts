/**
 * The binder against the real data: 78 generated manifests and the parameter
 * metadata captured from pwsh 7.6.5.
 *
 * The hand-built fixtures in the sibling files prove the RULES. This file
 * proves the rules survive contact with the actual shapes — sixteen-parameter
 * commands, aliases that prefix other parameters' names, parameter sets that
 * only one parameter distinguishes, and validation attributes whose arguments
 * live in the capture rather than in the manifest.
 *
 * Both files are read at runtime rather than imported, so a regeneration that
 * changes their shape shows up as a loud failure here instead of as a 200 kB
 * literal type slowing the compiler down.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { CompatibilityView } from '../../src/commands/invocation.ts';
import type { CommandManifest } from '../../src/commands/manifest.ts';
import { ParameterBindingError, bindParameters, tryBindParameters } from '../../src/binding/index.ts';
import type { BindOptions, ValidationDetail } from '../../src/binding/index.ts';

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------

const read = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

function profileView(file: string): CompatibilityView {
  const raw = read(`../../compat/profiles/${file}`) as {
    displayVersion?: string;
    behaviors?: Record<string, boolean | number | string>;
  };
  const behaviors = raw.behaviors ?? {};
  return {
    displayVersion: raw.displayVersion ?? '?',
    behavior<T extends boolean | number | string>(key: string, fallback: T): T {
      const value = behaviors[key];
      return (value === undefined ? fallback : value) as T;
    },
  };
}

const V76 = profileView('powershell-7.6.5-linux.json');
const V77 = profileView('powershell-7.7.0-preview.4-linux.json');

const MANIFESTS = (read('../../src/commands/manifests.json') as { commands: CommandManifest[] })
  .commands;

interface CapturedAttribute {
  type: string;
  values?: string[];
  min?: string;
  max?: string;
  minCount?: number;
  maxCount?: number;
}
interface CapturedParameter {
  attributes?: CapturedAttribute[];
  sets?: Record<string, { valueFromRemainingArguments?: boolean }>;
}
interface CapturedCommand {
  defaultParameterSet?: string;
  parameters?: Record<string, CapturedParameter>;
}

const CAPTURE = (
  read('../../compat/upstream/v7.6.5/command-metadata.json') as {
    commands: Record<string, CapturedCommand>;
  }
).commands;

/**
 * Turn the capture into the facts `CommandManifest` cannot carry: the default
 * parameter set, the ValueFromRemainingArguments flag, and the ARGUMENTS of
 * validation attributes that the manifest records by name only.
 */
function optionsFromCapture(display: string): BindOptions {
  const captured = CAPTURE[display];
  if (captured === undefined) return {};

  const validationDetails: ValidationDetail[] = [];
  const remaining: string[] = [];
  for (const [name, parameter] of Object.entries(captured.parameters ?? {})) {
    for (const attribute of parameter.attributes ?? []) {
      if (attribute.values !== undefined) {
        validationDetails.push({ parameter: name, attribute: attribute.type, arguments: attribute.values });
      } else if (attribute.min !== undefined && attribute.max !== undefined) {
        validationDetails.push({
          parameter: name,
          attribute: attribute.type,
          arguments: [attribute.min, attribute.max],
        });
      } else if (attribute.minCount !== undefined && attribute.maxCount !== undefined) {
        validationDetails.push({
          parameter: name,
          attribute: attribute.type,
          arguments: [String(attribute.minCount), String(attribute.maxCount)],
        });
      }
    }
    if (Object.values(parameter.sets ?? {}).some((s) => s.valueFromRemainingArguments === true)) {
      remaining.push(name);
    }
  }

  const options: BindOptions = {
    validationDetails,
    valueFromRemainingArguments: remaining,
  };
  return captured.defaultParameterSet === undefined
    ? options
    : { ...options, defaultParameterSet: captured.defaultParameterSet };
}

const find = (display: string): CommandManifest => {
  const found = MANIFESTS.find((candidate) => candidate.display === display);
  assert.notEqual(found, undefined, `manifest for ${display} is missing`);
  return found as CommandManifest;
};

const bindReal = (
  display: string,
  args: readonly string[],
  profile: CompatibilityView = V76,
): ReturnType<typeof tryBindParameters> =>
  tryBindParameters(args, find(display), profile, optionsFromCapture(display));

// ---------------------------------------------------------------------------

describe('the manifest file still has the shape the binder reads', () => {
  it('carries per-set bindings on every parameter of every command', () => {
    // A silent shape change would make the sweep below vacuous, so it is
    // checked rather than assumed.
    assert.ok(MANIFESTS.length >= 70, `only ${MANIFESTS.length} manifests`);
    let parameters = 0;
    for (const command of MANIFESTS) {
      assert.equal(typeof command.display, 'string', 'display');
      for (const parameter of command.parameters) {
        parameters += 1;
        assert.equal(typeof parameter.name, 'string', `${command.display} name`);
        assert.equal(typeof parameter.type, 'string', `${command.display}.${parameter.name} type`);
        assert.equal(typeof parameter.isSwitch, 'boolean', `${command.display}.${parameter.name}`);
        assert.ok(Array.isArray(parameter.aliases), `${command.display}.${parameter.name} aliases`);
        assert.ok(Array.isArray(parameter.validation), `${command.display}.${parameter.name}`);
        assert.equal(typeof parameter.sets, 'object', `${command.display}.${parameter.name} sets`);
      }
    }
    assert.ok(parameters >= 200, `only ${parameters} parameters across the manifests`);
  });
});

describe('Get-ChildItem, the sixteen-parameter case', () => {
  it('binds an unambiguous prefix', () => {
    // pwsh: Get-ChildItem -Pat $env:TEMP -Name  ->  works; Path is the only
    // parameter whose name or alias starts with 'Pat'.
    const outcome = bindReal('Get-ChildItem', ['-Pat', '/tmp']);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(outcome.result.parameters['Path'], ['/tmp']);
    assert.equal(outcome.result.parameterSet, 'Items');
  });

  it('rejects a prefix that matches a name and an alias of two parameters', () => {
    // pwsh: Get-ChildItem -P … is ambiguous. Our candidate list is shorter than
    // the reference's because the manifests do not carry the common parameters
    // (-ProgressAction, -PipelineVariable), which real pwsh also lists.
    const outcome = bindReal('Get-ChildItem', ['-P', '/tmp']);
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.error.kind, 'AmbiguousParameter');
    assert.match(outcome.error.message, /-Path/);
    assert.match(outcome.error.message, /-LiteralPath/);
  });

  it('rejects -Path together with -LiteralPath', () => {
    // pwsh: Get-ChildItem -Path a -LiteralPath b
    //   AmbiguousParameterSet,Microsoft.PowerShell.Commands.GetChildItemCommand
    const outcome = bindReal('Get-ChildItem', ['-Path', 'a', '-LiteralPath', 'b']);
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.error.kind, 'AmbiguousParameterSet');
    assert.equal(outcome.error.fullyQualifiedErrorId, 'AmbiguousParameterSet,Get-ChildItem');
  });

  it('selects the LiteralItems set from -LiteralPath alone', () => {
    const outcome = bindReal('Get-ChildItem', ['-lp', 'a']);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.result.parameterSet, 'LiteralItems');
    assert.deepEqual(outcome.result.parameters['LiteralPath'], ['a']);
    assert.equal('Path' in outcome.result.parameters, false);
  });

  it('binds positional Path then Filter', () => {
    // Path is position 0 and Filter position 1 in the capture.
    const outcome = bindReal('Get-ChildItem', ['/tmp', '*.txt']);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(outcome.result.parameters['Path'], ['/tmp']);
    assert.equal(outcome.result.parameters['Filter'], '*.txt');
  });

  it('shows the switch difference between the two profiles on a real command', () => {
    for (const [profile, expected] of [
      [V76, true],
      [V77, false],
    ] as const) {
      const outcome = bindReal('Get-ChildItem', ['-Force:$false'], profile);
      assert.equal(outcome.ok, true);
      if (!outcome.ok) return;
      assert.equal(outcome.result.parameters['Force'], expected);
      assert.deepEqual(outcome.result.explicitlyFalseSwitches, ['Force']);
    }
  });
});

describe('validation attributes recovered from the capture', () => {
  it('enforces ValidateRange on Select-Object -First', () => {
    // pwsh: 1,2,3 | Select-Object -First -1
    //   The -1 argument is less than the minimum allowed range of 0.
    const outcome = bindReal('Select-Object', ['-First', '-1']);
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.error.kind, 'ParameterArgumentValidationError');
    assert.equal(
      outcome.error.innerMessage,
      'The -1 argument is less than the minimum allowed range of 0. ' +
        'Supply an argument that is greater than or equal to 0 and then try the command again.',
    );
  });

  it('enforces ValidateRange on Get-Date -Month', () => {
    // pwsh: Get-Date -Month 13
    const outcome = bindReal('Get-Date', ['-Month', '13']);
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(
      outcome.error.innerMessage,
      'The 13 argument is greater than the maximum allowed range of 12. ' +
        'Supply an argument that is less than or equal to 12 and then try the command again.',
    );
    const fine = bindReal('Get-Date', ['-Month', '12']);
    assert.equal(fine.ok, true);
  });

  it('enforces ValidateNotNullOrEmpty on Get-Process -Name', () => {
    const outcome = bindReal('Get-Process', ['-Name', '']);
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.error.kind, 'ParameterArgumentValidationError');
  });

  it('leaves nothing unenforced once the capture supplies the arguments', () => {
    const outcome = bindReal('Select-Object', ['-First', '2']);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(outcome.result.unenforcedValidation, []);
  });

  it('reports what it could NOT enforce when the arguments are withheld', () => {
    // Without the capture the manifest only says "ValidateRangeAttribute".
    const bare = bindParameters(['-First', '2'], find('Select-Object'), V76);
    assert.deepEqual(bare.unenforcedValidation, ['First:ValidateRange']);
    assert.equal(bare.parameters['First'], 2);
  });
});

describe('ValueFromRemainingArguments, which only the capture knows about', () => {
  it('lets Write-Output collect three loose arguments', () => {
    // pwsh: Write-Output a b c emits three objects. An array-typed positional
    // alone does NOT do this — verified — so the flag is load-bearing.
    const outcome = bindReal('Write-Output', ['a', 'b', 'c']);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(outcome.result.parameters['InputObject'], ['a', 'b', 'c']);
  });

  it('fails the same command without the flag, as an array parameter would', () => {
    const outcome = tryBindParameters(['a', 'b', 'c'], find('Write-Output'), V76, {});
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.error.kind, 'PositionalParameterNotFound');
  });
});

describe('a sweep over every manifest', () => {
  it('never throws anything but a ParameterBindingError', () => {
    let bindings = 0;
    for (const command of MANIFESTS) {
      const options = optionsFromCapture(command.display);
      const attempts: string[][] = [[], ['x'], ['-NoSuchParameter'], ['-Force:$false']];
      for (const parameter of command.parameters) {
        attempts.push(parameter.isSwitch ? [`-${parameter.name}`] : [`-${parameter.name}`, 'v']);
        for (const alias of parameter.aliases) attempts.push([`-${alias}`, 'v']);
      }
      for (const args of attempts) {
        bindings += 1;
        try {
          const bound = bindParameters(args, command, V76, options);
          // Whatever came back, nothing unsupplied may be present.
          for (const key of Object.keys(bound.parameters)) {
            assert.ok(
              command.parameters.some((p) => p.name === key),
              `${command.display} bound an unknown key ${key}`,
            );
          }
        } catch (error) {
          assert.ok(
            error instanceof ParameterBindingError,
            `${command.display} ${args.join(' ')} threw ${String(error)}`,
          );
        }
      }
    }
    assert.ok(bindings > 500, `only ${bindings} bindings attempted`);
  });

  it('binds every parameter under its own name, or fails for a stated reason', () => {
    // A parameter that cannot be named at all would be a real defect; a
    // structured refusal (wrong set, unmet mandatory, bad value) is not.
    const excused = new Set([
      'AmbiguousParameter',
      'AmbiguousParameterSet',
      'MissingMandatoryParameter',
      'ParameterArgumentValidationError',
      'ParameterArgumentTransformationError',
      'PositionalParameterNotFound',
    ]);
    for (const command of MANIFESTS) {
      const options = optionsFromCapture(command.display);
      for (const parameter of command.parameters) {
        const args = parameter.isSwitch ? [`-${parameter.name}`] : [`-${parameter.name}`, 'v'];
        const outcome = tryBindParameters(args, command, V76, options);
        if (outcome.ok) {
          assert.ok(
            Object.hasOwn(outcome.result.parameters, parameter.name),
            `${command.display} -${parameter.name} bound nothing`,
          );
          continue;
        }
        assert.ok(
          excused.has(outcome.error.kind),
          `${command.display} -${parameter.name}: ${outcome.error.kind} — ${outcome.error.message}`,
        );
      }
    }
  });

  it('resolves a parameter set for every command that binds nothing', () => {
    for (const command of MANIFESTS) {
      const outcome = tryBindParameters([], command, V76, optionsFromCapture(command.display));
      if (!outcome.ok) {
        assert.ok(
          outcome.error.kind === 'MissingMandatoryParameter' ||
            outcome.error.kind === 'AmbiguousParameterSet',
          `${command.display}: ${outcome.error.kind}`,
        );
        continue;
      }
      assert.equal(typeof outcome.result.parameterSet, 'string');
      assert.deepEqual(outcome.result.parameters, {});
    }
  });
});
