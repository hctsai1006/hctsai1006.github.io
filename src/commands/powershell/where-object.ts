/**
 * Where-Object — the filter, in both of the forms PowerShell offers.
 *
 *   Get-Process | Where-Object { $_.CPU -gt 10 }     the script-block form
 *   Get-Process | Where-Object CPU -gt 10            the comparison form
 *
 * The comparison form is not sugar over the script-block form: it is a separate
 * parameter set per operator. Measured, not guessed —
 * `(Get-Command Where-Object).ParameterSets` in pwsh 7.6.5 reports THIRTY-TWO:
 * thirty-one comparison sets plus `ScriptBlockSet`, with `EqualSet` the
 * default. An earlier version of this comment said thirty-one, which was the
 * comparison sets alone.
 *
 * WHY THIS COMMAND IS `partial`
 *
 * It is built, it is tested, and it is NOT in the session registry. Two limits
 * earn that, and neither is a missing feature — both are wrong answers:
 *
 *   -Match uses JavaScript's RegExp where PowerShell uses .NET's. Measured
 *   divergences are listed at `applyOperator`. Four patterns give the opposite
 *   answer and four more are outright SyntaxErrors, so a filter that looks like
 *   it worked can silently have matched nothing.
 *
 *   -Is compares against `typeNameOf`, which models a handful of types. A type
 *   name this engine does not know reports False rather than saying so.
 *
 * The parameter-set defect that used to be the third reason is FIXED. The
 * manifest below declares the real thirty-two sets, so the binder — unchanged —
 * now reproduces pwsh's answer for every combination probed:
 *
 *   Where-Object N -eq 2                    Property=N, Value=2      (was
 *                                           FilterScript=N, Property=2)
 *   Where-Object -Property N -eq -Value 2   binds                    (was
 *                                           MissingMandatoryParameter FilterScript)
 *   Where-Object -FilterScript $sb -Property Name -EQ x
 *                                           AmbiguousParameterSet    (was
 *                                           silently accepted)
 *   Where-Object Name -EQ x -GT y           AmbiguousParameterSet    (was
 *                                           silently accepted, FilterScript=Name)
 *   Where-Object Name -EQ                   ValueNotSpecifiedForWhereObject
 *   Where-Object -EQ x                      ValueNotSpecifiedForWhereObject
 *
 * WHAT THE PROBE CORRECTED
 *
 * `Where-Object` cannot tell a missing property from one holding `$null`:
 *
 *   $q = @([pscustomobject]@{A=1}, [pscustomobject]@{A=$null}, [pscustomobject]@{B=9})
 *   ($q | Where-Object A -eq $null).Count            ->  2   (pwsh 7.6.5)
 *   ($q | Where-Object { $null -eq $_.A }).Count     ->  2
 *
 * Both forms match the object holding `$null` AND the object with no `A` at
 * all. psobject.ts is right to keep `undefined` (absent) apart from `null`, and
 * `Select-Object` below depends on that distinction — but Where-Object collapses
 * it before comparing, and a faithful implementation must collapse it too.
 * Reasoning from the object model alone gives the wrong answer here.
 */

import { compareValues, valuesEqual, isOfType, isTruthy } from '../../pipeline/psobject.ts';
import type { PSValue } from '../../pipeline/psobject.ts';
import { throwIfCancelled } from '../../pipeline/pipeline.ts';
import { errorRecord } from '../../pipeline/streams.ts';
import type { ErrorRecord } from '../../pipeline/streams.ts';
import type { ParameterSetBinding } from '../manifest.ts';
import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import {
  OBJECT,
  STRING,
  SWITCH,
  asScriptBlock,
  isBound,
  manifest,
  parameter,
  rawValue,
  renderValue,
  resolveProperty,
  stringValue,
  wildcardPattern,
} from './support.ts';

const COMMAND = 'Microsoft.PowerShell.Commands.WhereObjectCommand';

/**
 * Every comparison parameter, with the case-sensitive variant it pairs with.
 * A plain object rather than an enum: `erasableSyntaxOnly` forbids enums, and
 * the names have to survive to runtime anyway because the binder matches on
 * them.
 */
const OPERATORS = [
  ['EQ', 'EqualSet', 'CaseSensitiveEqualSet'],
  ['NE', 'NotEqualSet', 'CaseSensitiveNotEqualSet'],
  ['GT', 'GreaterThanSet', 'CaseSensitiveGreaterThanSet'],
  ['LT', 'LessThanSet', 'CaseSensitiveLessThanSet'],
  ['GE', 'GreaterOrEqualSet', 'CaseSensitiveGreaterOrEqualSet'],
  ['LE', 'LessOrEqualSet', 'CaseSensitiveLessOrEqualSet'],
  ['Like', 'LikeSet', 'CaseSensitiveLikeSet'],
  ['NotLike', 'NotLikeSet', 'CaseSensitiveNotLikeSet'],
  ['Match', 'MatchSet', 'CaseSensitiveMatchSet'],
  ['NotMatch', 'NotMatchSet', 'CaseSensitiveNotMatchSet'],
  ['Contains', 'ContainsSet', 'CaseSensitiveContainsSet'],
  ['NotContains', 'NotContainsSet', 'CaseSensitiveNotContainsSet'],
  ['In', 'InSet', 'CaseSensitiveInSet'],
  ['NotIn', 'NotInSet', 'CaseSensitiveNotInSet'],
] as const;

type Operator = (typeof OPERATORS)[number][0];

const OPERATOR_NAMES: readonly Operator[] = OPERATORS.map(([name]) => name);

/**
 * Operators with no case-sensitive twin, and their sets.
 *
 * `Not` is the odd one out twice over: its set is called `Not`, not `NotSet`,
 * and it is the only comparison set with NO `-Value` parameter at all. Both
 * read off `(Get-Command Where-Object).ParameterSets`.
 */
const UNARY_OR_TYPE = [
  ['Is', 'IsSet'],
  ['IsNot', 'IsNotSet'],
  ['Not', 'Not'],
] as const;

const UNARY_NAMES: readonly UnaryOperator[] = UNARY_OR_TYPE.map(([name]) => name);

/** The set the binder falls back to. `(Get-Command Where-Object).DefaultParameterSet`. */
const DEFAULT_SET = 'EqualSet';

const SCRIPT_BLOCK_SET = 'ScriptBlockSet';

/**
 * Every comparison set — the thirty-one that take `-Property`.
 *
 * Built from the tables rather than listed, so a new operator cannot be added
 * to one and forgotten in the other.
 */
const COMPARISON_SETS: readonly string[] = [
  ...OPERATORS.flatMap(([, plain, sensitive]) => [plain, sensitive]),
  ...UNARY_OR_TYPE.map(([, set]) => set),
];

/** The sets in which `-Value` exists. Every comparison set except `Not`. */
const VALUE_SETS: readonly string[] = COMPARISON_SETS.filter((name) => name !== 'Not');

const bindingsFor = (
  sets: readonly string[],
  binding: ParameterSetBinding,
): Record<string, ParameterSetBinding> => Object.fromEntries(sets.map((name) => [name, binding]));

type UnaryOperator = (typeof UNARY_OR_TYPE)[number][0];

interface ResolvedOperator {
  readonly kind: Operator | UnaryOperator;
  readonly caseSensitive: boolean;
}

/**
 * Every operator switch the caller supplied.
 *
 * A LIST, not the first hit. The old version walked a fixed array and returned
 * the first match, so `Where-Object Name -EQ x -GT y` silently filtered on
 * `-EQ` and threw `-GT` away. Real pwsh cannot express that combination at all:
 * `-EQ` and `-GT` live in different parameter sets, and binding fails with
 * AmbiguousParameterSet. The manifest below now says so too, so the binder
 * rejects it before this function runs — but returning every match rather than
 * the first is what makes that a checkable property instead of a coincidence.
 */
function boundOperators(bound: BindingResult['parameters']): readonly ResolvedOperator[] {
  const found: ResolvedOperator[] = [];
  for (const kind of OPERATOR_NAMES) {
    if (isBound(bound, kind)) found.push({ kind, caseSensitive: false });
    // `-ceq` is the case-sensitive form of `-eq`; the binder passes it through
    // as a separate parameter name rather than as a flag on `-eq`.
    if (isBound(bound, `C${kind}`)) found.push({ kind, caseSensitive: true });
  }
  for (const kind of UNARY_NAMES) {
    if (isBound(bound, kind)) found.push({ kind, caseSensitive: false });
  }
  return found;
}

/**
 * pwsh's own error for an operator with no `-Value`. Read off 7.6.5:
 *
 *   Where-Object Name -EQ    ->  ValueNotSpecifiedForWhereObject,
 *                                Microsoft.PowerShell.Commands.WhereObjectCommand
 *   Where-Object Name -Is    ->  the same
 *   Where-Object -EQ x       ->  the same ('x' binds POSITIONALLY to
 *                                -Property, because -EQ is a switch)
 *
 * Raised from the command body and not the binder because that is where pwsh
 * raises it: `-Value` is optional in every set that has it, so binding
 * succeeds and the cmdlet checks. `-Not` is exempt — its set has no `-Value`.
 */
function valueNotSpecified(): ErrorRecord {
  return errorRecord(
    'The specified operator requires both the -Property and -Value parameters. Provide ' +
      'values for both parameters, and then try the command again.',
    'ValueNotSpecifiedForWhereObject',
    COMMAND,
    'InvalidArgument',
    { exceptionType: 'System.Management.Automation.PSArgumentException' },
  );
}

/**
 * A combination the manifest cannot express, refused by name.
 *
 * Nothing reaches this today — the thirty-two declared sets cover every probed
 * case — and that is exactly why it is here rather than a comment. The rule
 * this file is being held to is that an unsupported combination FAILS, and a
 * body whose only defence is "the binder would have caught it" is one manifest
 * edit away from silently choosing again.
 */
function unsupportedCombination(detail: string): ErrorRecord {
  return errorRecord(
    `Where-Object cannot run this combination of parameters: ${detail}. BrowserShell models ` +
      "Where-Object's parameter sets from pwsh 7.6.5; a combination it cannot express is " +
      'refused rather than resolved by picking one.',
    'UnsupportedParameterCombination',
    COMMAND,
    'InvalidArgument',
    { exceptionType: 'System.Management.Automation.PSArgumentException' },
  );
}

/**
 * PowerShell's `-contains` treats a scalar as a one-element collection.
 * Verified: `Where-Object CPU -contains 5` matches an object whose CPU is the
 * bare number 5, not only one whose CPU is `@(5)`.
 */
function asCollection(value: PSValue | undefined): readonly PSValue[] {
  if (value === undefined) return [null];
  return Array.isArray(value) ? value : [value];
}

/**
 * `compareValues`, with the unorderable pair reported instead of faked.
 *
 * NaN is the only value that reaches this. Measured on pwsh 7.6.5 — every
 * ordering is False and NO error is raised:
 *
 *   $n = [double]::NaN
 *   $n -lt $n  False   $n -le $n  False   $n -gt 1  False   1 -ge $n  False
 *
 *   @(o{V=[double]::NaN}, o{V=1}) | Where-Object V -le 1   ->  1 object
 *   @(o{V=[double]::NaN}, o{V=1}) | Where-Object V -lt 1   ->  0 objects
 *
 * So the NaN row never matches, and every other row is unaffected. That cannot
 * be an integer: derived from a sign, `-le` is `sign <= 0`, which is true at
 * zero — and it has to be false. `undefined` is the third answer.
 *
 * Two ways of learning it, because the two live on different branches. The
 * NaN test is what this branch has today: `compareValues(NaN, 1)` currently
 * returns 0, which made NaN EQUAL to every number and got five of the six
 * operators wrong. `UnorderedComparisonError` is what psobject.ts raises on the
 * integration branch. Matching on the error NAME rather than importing the
 * class is deliberate — the class does not exist here yet, and an import would
 * not compile until the merge.
 */
function orderedCompare(left: PSValue, right: PSValue, cs: boolean): number | undefined {
  if (isUnorderable(left) || isUnorderable(right)) return undefined;
  try {
    return compareValues(left, right, cs);
  } catch (error) {
    if (error instanceof Error && error.name === 'UnorderedComparisonError') return undefined;
    throw error;
  }
}

/**
 * A value that converts to a number but does not order against one.
 *
 * Only a real NaN. The STRING 'NaN' is deliberately not included, which was
 * measured rather than assumed:
 *
 *   'NaN' -lt 1      False    -- but as a STRING comparison ('NaN' vs '1'),
 *                                not as NaN semantics
 *   'NaN' -lt 'b'    False    -- likewise; 'abc' -lt 'b' is True
 *   1 -lt 'NaN'      throws   InvalidCastFromStringToInteger
 *
 * PowerShell coerces the right operand to the LEFT operand's type, so a string
 * on the left keeps the whole comparison textual and 'NaN' is just a word.
 * Treating it as unorderable would turn three working string comparisons into
 * False.
 */
function isUnorderable(value: PSValue): boolean {
  return typeof value === 'number' && Number.isNaN(value);
}

/**
 * KNOWN DIFFERENCE: `-match` is JavaScript's RegExp, PowerShell's is .NET's.
 *
 * No compatibility layer is attempted — translating .NET regex to ECMAScript is
 * its own project — so the divergences are MEASURED and recorded instead. Each
 * row is pwsh 7.6.5's `-match` beside `new RegExp(p, 'iu').test(s)` on node
 * 24.13.0:
 *
 *   pattern              input      .NET    JS
 *   ^\d+$                '１２３'    True    false   \d is Unicode in .NET, ASCII in JS
 *   ^\w+$                'é'        True    false   same for \w
 *   ^ab$                 "ab
"     True    false   .NET $ matches before a final 

 *   ab\Z                 "ab
"     True    false   JS has no \Z
 *   (?i)abc              'ABC'      True    SyntaxError
 *   (?>a+)b              'aaab'     True    SyntaxError   atomic group
 *   ^[a-z-[aeiou]]$      'b'        True    SyntaxError   class subtraction
 *   a(?#note)b           'ab'       True    SyntaxError   comment group
 *
 * Agreement was measured too, so the list is a difference and not a shrug:
 * `a.b` against "a
b" is False in both, and `(?<x>a)b` matches in both.
 *
 * The four SyntaxErrors used to escape this function as raw JavaScript
 * exceptions. They are now an ErrorRecord that names the pattern, because a
 * filter that threw a `SyntaxError: Invalid group` at a PowerShell user was
 * telling them about the wrong language.
 *
 * This is the reason the command is `partial` and why its manifest must not
 * claim `native-semantic` fidelity for `-match`.
 */
function compilePattern(pattern: string, caseSensitive: boolean): RegExp | ErrorRecord {
  try {
    return new RegExp(pattern, caseSensitive ? 'u' : 'iu');
  } catch {
    return errorRecord(
      `The regular expression pattern ${pattern} is not valid, or uses .NET syntax that ` +
        "JavaScript's RegExp does not accept. BrowserShell's -match is JavaScript's engine, " +
        "not .NET's; inline options such as (?i), atomic groups (?>...), comment groups " +
        '(?#...) and character-class subtraction [a-z-[aeiou]] are among the constructs that ' +
        'differ.',
      'InvalidRegularExpression',
      COMMAND,
      'InvalidArgument',
      { exceptionType: 'System.ArgumentException' },
    );
  }
}

function applyOperator(
  operator: ResolvedOperator,
  left: PSValue,
  right: PSValue,
): boolean | ErrorRecord {
  const cs = operator.caseSensitive;
  switch (operator.kind) {
    case 'EQ':
      return valuesEqual(left, right, cs);
    case 'NE':
      return !valuesEqual(left, right, cs);
    // The four orderings. `undefined` means the pair does not order, and every
    // one of them is False then — see orderedCompare.
    case 'GT':
      return (orderedCompare(left, right, cs) ?? 0) > 0;
    case 'GE': {
      const sign = orderedCompare(left, right, cs);
      return sign !== undefined && sign >= 0;
    }
    case 'LT':
      return (orderedCompare(left, right, cs) ?? 0) < 0;
    case 'LE': {
      const sign = orderedCompare(left, right, cs);
      return sign !== undefined && sign <= 0;
    }
    case 'Like':
      return wildcardPattern(renderValue(right), cs).test(renderValue(left));
    case 'NotLike':
      return !wildcardPattern(renderValue(right), cs).test(renderValue(left));
    case 'Match': {
      const pattern = compilePattern(renderValue(right), cs);
      return pattern instanceof RegExp ? pattern.test(renderValue(left)) : pattern;
    }
    case 'NotMatch': {
      const pattern = compilePattern(renderValue(right), cs);
      return pattern instanceof RegExp ? !pattern.test(renderValue(left)) : pattern;
    }
    case 'Contains':
      return asCollection(left).some((item) => valuesEqual(item, right, cs));
    case 'NotContains':
      return !asCollection(left).some((item) => valuesEqual(item, right, cs));
    case 'In':
      return asCollection(right).some((item) => valuesEqual(left, item, cs));
    case 'NotIn':
      return !asCollection(right).some((item) => valuesEqual(left, item, cs));
    case 'Is':
      return isOfType(left, renderValue(right));
    case 'IsNot':
      return !isOfType(left, renderValue(right));
    case 'Not':
      return !isTruthy(left);
    default:
      return false;
  }
}

const ALL_SETS: readonly string[] = [SCRIPT_BLOCK_SET, ...COMPARISON_SETS];

const WHERE_OBJECT_MANIFEST = manifest({
  display: 'Where-Object',
  aliases: ['where', '?'],
  synopsis: 'Selects objects from a collection based on their property values.',
  implementationStatus: 'partial',
  defaultParameterSet: DEFAULT_SET,
  notes:
    'PARTIAL: built and tested, but not registered in the default session. All 32 parameter ' +
    'sets are declared and the binder reproduces pwsh 7.6.5 for every combination probed, ' +
    'including -Property/-Value positional order and AmbiguousParameterSet for two ' +
    'operators. What is NOT faithful: -match compiles the pattern with JavaScript RegExp ' +
    'where PowerShell uses .NET, which is a measured difference and not a missing feature ' +
    "(\d and \w are ASCII-only here, $ does not match before a final newline, \Z, (?i), " +
    'atomic groups, comment groups and character-class subtraction are all rejected or ' +
    'answered differently); and -is compares against a small modelled type table, so an ' +
    'unknown type name reports False rather than saying it is unknown. The script-block ' +
    'form takes a callback rather than source text: this command contains no evaluator and ' +
    'never calls eval or new Function.',
  parameters: [
    parameter('FilterScript', 'System.Management.Automation.ScriptBlock', {
      sets: {
        [SCRIPT_BLOCK_SET]: { position: 0, mandatory: true, valueFromPipeline: false },
      },
    }),
    // Position 0 in the comparison sets, exactly as pwsh reports it, and NOT in
    // ScriptBlockSet. That single fact is what fixes `Where-Object N -eq 2`:
    // with one flat set the binder saw FilterScript and Property both at
    // position 0 and took the first declared.
    parameter('Property', STRING, {
      sets: bindingsFor(COMPARISON_SETS, { position: 0, mandatory: true, valueFromPipeline: false }),
    }),
    parameter('Value', OBJECT, {
      sets: bindingsFor(VALUE_SETS, { position: 1, mandatory: false, valueFromPipeline: false }),
    }),
    parameter('InputObject', OBJECT, {
      sets: bindingsFor(ALL_SETS, { position: null, mandatory: false, valueFromPipeline: true }),
    }),
    // Measured: -EQ is OPTIONAL in EqualSet and every other operator switch is
    // MANDATORY in its own set. That asymmetry is what makes bare
    // `Where-Object -Property Name` legal (it lands in the default set and
    // tests truthiness) while `-GT` without anything else does not exist.
    ...OPERATORS.flatMap(([op, plain, sensitive]) => [
      parameter(op, SWITCH, {
        sets: { [plain]: { position: null, mandatory: op !== 'EQ', valueFromPipeline: false } },
      }),
      parameter(`C${op}`, SWITCH, {
        sets: { [sensitive]: { position: null, mandatory: true, valueFromPipeline: false } },
      }),
    ]),
    ...UNARY_OR_TYPE.map(([op, set]) =>
      parameter(op, SWITCH, {
        sets: { [set]: { position: null, mandatory: true, valueFromPipeline: false } },
      }),
    ),
  ],
  outputTypeNames: ['System.Object'],
});

export const whereObject: CommandModule = {
  manifest: WHERE_OBJECT_MANIFEST,

  async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
    const parameters = bound.parameters;
    const filter = asScriptBlock(rawValue(parameters, 'FilterScript'));
    const property = stringValue(parameters, 'Property');
    const operators = boundOperators(parameters);
    const operator = operators[0];
    const right = rawValue(parameters, 'Value') ?? null;
    const sink = context.streams.success;

    // ---- refuse before filtering, never during ----------------------------
    //
    // Every check below produces a NAMED error and exit code 1. The rule this
    // command is held to is that an unsupported combination fails; the failure
    // mode being fixed is the one where a filter runs, succeeds, and answers a
    // different question than the one asked.

    if (filter !== undefined && property !== undefined) {
      // Unreachable through the binder — FilterScript and Property are in
      // disjoint sets — and checked anyway, because "the binder would have
      // caught it" is not a property this file can enforce about itself.
      await context.streams.error.write(
        unsupportedCombination('-FilterScript and -Property name different parameter sets'),
      );
      return 1;
    }
    if (operators.length > 1) {
      await context.streams.error.write(
        unsupportedCombination(
          `-${operators.map((op) => (op.caseSensitive ? `C${op.kind}` : op.kind)).join(' and -')} ` +
            'are each their own parameter set',
        ),
      );
      return 1;
    }
    if (filter !== undefined && operators.length > 0) {
      await context.streams.error.write(
        unsupportedCombination('a script block takes no comparison operator'),
      );
      return 1;
    }
    if (filter === undefined && property === undefined) {
      // pwsh reports MissingMandatoryParameter here and never reaches the body.
      // Reached only when a caller hand-builds BoundParameters, which the tests
      // do; filtering nothing and passing everything through would be the
      // silently-wrong answer.
      await context.streams.error.write(
        unsupportedCombination('neither -FilterScript nor -Property was supplied'),
      );
      return 1;
    }
    // `-Not` is the one comparison set with no -Value, so it is exempt.
    // Everything else that names an operator needs one: measured, this is
    // pwsh's ValueNotSpecifiedForWhereObject.
    if (
      operator !== undefined &&
      operator.kind !== 'Not' &&
      !isBound(parameters, 'Value')
    ) {
      await context.streams.error.write(valueNotSpecified());
      return 1;
    }

    for await (const item of context.input) {
      throwIfCancelled(context.signal, 'Where-Object');

      let keep: boolean;
      if (filter !== undefined) {
        keep = isTruthy(await filter(item));
      } else {
        // The collapse the probe forced: absent and null are the same value to
        // every comparison operator, so `-eq $null` matches both.
        const left = resolveProperty(item, property ?? '') ?? null;
        if (operator === undefined) {
          keep = isTruthy(left);
        } else {
          const outcome = applyOperator(operator, left, right);
          if (typeof outcome !== 'boolean') {
            // A pattern JavaScript could not compile. One error, then stop:
            // the pattern will not become valid on the next object, and pwsh
            // does not emit one error per row for a bad regex either.
            await context.streams.error.write(outcome);
            return 1;
          }
          keep = outcome;
        }
      }

      if (!keep) continue;

      // `$null` that passes the filter is EMITTED, not swallowed.
      //   pwsh: @($null,1) | Where-Object { $true }  ->  two items downstream
      // Select-Object and Sort-Object drop nulls; Where-Object does not, and
      // treating "the pipeline drops nulls" as a global rule would be wrong.
      await sink.write(item);

      // Downstream stopped (`... | Select-Object -First 3`). Leaving the loop
      // closes our own input, which is what unwinds the upstream.
      if (sink.closed) break;
    }
    return 0;
  },
};
