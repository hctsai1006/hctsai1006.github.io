/**
 * Binding a parsed command, without flattening it back to strings first.
 *
 * ── THE BUG THIS PINS, MEASURED ───────────────────────────────────────────
 *
 * Found by attacking the finished parser rather than by reading it. The binder
 * took `readonly string[]`, so handing it a parsed command meant serialising
 * the AST and re-deriving "is this a parameter?" from the text — a second
 * answer to a question the lexer had already answered. pwsh 7.6.5 says the two
 * answers differ:
 *
 *     function Test-Q {
 *       [CmdletBinding()]
 *       param([switch] $Force, [Parameter(Position=0)][string] $Path)
 *       "Force=$($Force.IsPresent) Path=[$Path] bound=[$(($PSBoundParameters.Keys|Sort-Object) -join ',')]"
 *     }
 *
 *     Test-Q -Force      ->  Force=True  Path=[]        bound=[Force]
 *     Test-Q '-Force'    ->  Force=False Path=[-Force]  bound=[Path]
 *     Test-Q "-Force"    ->  Force=False Path=[-Force]  bound=[Path]
 *
 *     Test-Q -Force      ->  Generic Parameter("-Force")
 *     Test-Q '-Force'    ->  Generic StringLiteral("'-Force'")
 *
 * A quoted `-Force` is an ARGUMENT. The string path binds the switch, which is
 * a command doing something the user did not ask for, quietly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bindCommandArguments, tryBindCommand } from '../../src/binding/from-ast.ts';
import { tryBindParameters } from '../../src/binding/binder.ts';
import { commandArguments, parseForEditing, pipelineStages } from '../../src/language/parse.ts';
import { viewOfBehaviors } from '../../src/compatibility/profile-resolver.ts';
import type { CommandAst, PipelineAst, PipelineChainAst } from '../../src/language/ast.ts';
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

/** `Test-Q`, exactly as the probe declared it. */
const TEST_Q: CommandManifest = {
  name: 'test-q',
  display: 'Test-Q',
  aliases: [],
  runtime: 'semantic',
  fidelity: 'native-semantic',
  risk: 'read',
  capabilities: [],
  parameters: [
    parameter('Force', {
      isSwitch: true,
      type: 'System.Management.Automation.SwitchParameter',
    }),
    parameter('Path', {
      sets: { __AllParameterSets: { position: 0, mandatory: false, valueFromPipeline: false } },
      firstPosition: 0,
    }),
  ],
  outputTypeNames: [],
  synopsis: 'The probe function, as a manifest.',
  parameterSource: 'reference-implementation',
  implementationStatus: 'implemented',
};

const view = () => viewOfBehaviors('7.6.5', {});

function commandOf(line: string): CommandAst {
  const statements = parseForEditing(line).ast.statements;
  const stages = statements.flatMap((s) =>
    s.kind === 'PipelineAst' || s.kind === 'PipelineChainAst'
      ? [...pipelineStages(s as PipelineAst | PipelineChainAst)]
      : [],
  );
  const first = stages[0];
  assert.ok(first !== undefined, `no command in ${JSON.stringify(line)}`);
  return first;
}

describe('a quoted parameter name is an argument', () => {
  it('binds the switch for a bare -Force', () => {
    // pwsh: Test-Q -Force  ->  bound=[Force]
    const bound = tryBindCommand(commandOf('Test-Q -Force'), TEST_Q, view());
    assert.equal(bound.ok, true);
    if (!bound.ok) return;
    assert.equal(bound.result.parameters['Force'], true);
    assert.equal(Object.hasOwn(bound.result.parameters, 'Path'), false);
  });

  for (const line of ["Test-Q '-Force'", 'Test-Q "-Force"']) {
    it(`binds Path, not the switch, for ${line}`, () => {
      // pwsh: bound=[Path], Path=[-Force]
      const bound = tryBindCommand(commandOf(line), TEST_Q, view());
      assert.equal(bound.ok, true);
      if (!bound.ok) return;
      assert.equal(bound.result.parameters['Path'], '-Force');
      assert.equal(
        Object.hasOwn(bound.result.parameters, 'Force'),
        false,
        'a quoted -Force bound the switch',
      );
    });
  }

  it('is exactly the case the string path gets wrong', () => {
    // Not a hypothetical: the same command, flattened to strings and rebound,
    // produces the answer pwsh does not give. This is what `from-ast.ts` exists
    // to stop, so it is asserted rather than described.
    const command = commandOf("Test-Q '-Force'");
    const flattened = commandArguments(command);
    assert.deepEqual(flattened, ['-Force']);

    const viaStrings = tryBindParameters(flattened, TEST_Q, view());
    assert.equal(viaStrings.ok, true);
    if (!viaStrings.ok) return;
    assert.equal(viaStrings.result.parameters['Force'], true, 'the string path stopped disagreeing');

    const viaAst = tryBindCommand(command, TEST_Q, view());
    assert.equal(viaAst.ok, true);
    if (!viaAst.ok) return;
    assert.equal(viaAst.result.parameters['Path'], '-Force');
  });
});

describe('the AST path carries the lexer’s answer through', () => {
  it('classifies parameters and values the way the parser did', () => {
    assert.deepEqual(bindCommandArguments(commandOf('Test-Q -Path a')), [
      { kind: 'parameter', name: 'Path', attached: null, text: '-Path' },
      { kind: 'value', text: 'a' },
    ]);
  });

  it('keeps -Name:value attached, which switch semantics need', () => {
    const args = bindCommandArguments(commandOf('Test-Q -Force:$false'));
    assert.deepEqual(args, [
      { kind: 'parameter', name: 'Force', attached: '$false', text: '-Force:$false' },
    ]);
    const bound = tryBindCommand(commandOf('Test-Q -Force:$false'), TEST_Q, view());
    assert.equal(bound.ok, true);
    if (!bound.ok) return;
    assert.equal(bound.result.parameters['Force'], false);
  });

  it('binds a parameter-shaped token as a VALUE when one is expected', () => {
    // pwsh: once a named parameter is waiting for a value, the next token is
    // that value whatever it looks like. `-Path -abc` binds the string `-abc`.
    const bound = tryBindCommand(commandOf('Test-Q -Path -abc'), TEST_Q, view());
    assert.equal(bound.ok, true);
    if (!bound.ok) return;
    assert.equal(bound.result.parameters['Path'], '-abc');
  });

  it('unquotes a value exactly once', () => {
    const bound = tryBindCommand(commandOf('Test-Q -Path "my file"'), TEST_Q, view());
    assert.equal(bound.ok, true);
    if (!bound.ok) return;
    assert.equal(bound.result.parameters['Path'], 'my file');
  });
});
