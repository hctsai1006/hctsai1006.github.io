/**
 * Where-Object — the filter, in both of the forms PowerShell offers.
 *
 *   Get-Process | Where-Object { $_.CPU -gt 10 }     the script-block form
 *   Get-Process | Where-Object CPU -gt 10            the comparison form
 *
 * The comparison form is not sugar over the script-block form: it is a separate
 * parameter set per operator, thirty-one of them, and `(Get-Command
 * Where-Object).Parameters` in pwsh 7.6.5 lists every one. They are enumerated
 * here rather than guessed.
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
  scriptBlockHandleOf,
  stringValue,
  wildcardPattern,
} from './support.ts';

/**
 * Every comparison parameter, with the case-sensitive variant it pairs with.
 * A plain object rather than an enum: `erasableSyntaxOnly` forbids enums, and
 * the names have to survive to runtime anyway because the binder matches on
 * them.
 */
const OPERATORS = [
  'EQ',
  'NE',
  'GT',
  'LT',
  'GE',
  'LE',
  'Like',
  'NotLike',
  'Match',
  'NotMatch',
  'Contains',
  'NotContains',
  'In',
  'NotIn',
] as const;

type Operator = (typeof OPERATORS)[number];

/** Operators with no case-sensitive twin. */
const UNARY_OR_TYPE = ['Is', 'IsNot', 'Not'] as const;

interface ResolvedOperator {
  readonly kind: Operator | (typeof UNARY_OR_TYPE)[number];
  readonly caseSensitive: boolean;
}

function resolveOperator(bound: BindingResult['parameters']): ResolvedOperator | undefined {
  for (const kind of OPERATORS) {
    if (isBound(bound, kind)) return { kind, caseSensitive: false };
    // `-ceq` is the case-sensitive form of `-eq`; the binder passes it through
    // as a separate parameter name rather than as a flag on `-eq`.
    if (isBound(bound, `C${kind}`)) return { kind, caseSensitive: true };
  }
  for (const kind of UNARY_OR_TYPE) {
    if (isBound(bound, kind)) return { kind, caseSensitive: false };
  }
  return undefined;
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

function applyOperator(
  operator: ResolvedOperator,
  left: PSValue,
  right: PSValue,
): boolean {
  const cs = operator.caseSensitive;
  switch (operator.kind) {
    case 'EQ':
      return valuesEqual(left, right, cs);
    case 'NE':
      return !valuesEqual(left, right, cs);
    case 'GT':
      return compareValues(left, right, cs) > 0;
    case 'GE':
      return compareValues(left, right, cs) >= 0;
    case 'LT':
      return compareValues(left, right, cs) < 0;
    case 'LE':
      return compareValues(left, right, cs) <= 0;
    case 'Like':
      return wildcardPattern(renderValue(right), cs).test(renderValue(left));
    case 'NotLike':
      return !wildcardPattern(renderValue(right), cs).test(renderValue(left));
    case 'Match':
      return new RegExp(renderValue(right), cs ? 'u' : 'iu').test(renderValue(left));
    case 'NotMatch':
      return !new RegExp(renderValue(right), cs ? 'u' : 'iu').test(renderValue(left));
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

const WHERE_OBJECT_MANIFEST = manifest({
  display: 'Where-Object',
  aliases: ['where', '?'],
  synopsis: 'Selects objects from a collection based on their property values.',
  notes:
    'Both parameter sets are implemented. The script-block form takes a callback rather ' +
    'than source text: this command contains no evaluator, and never calls eval or ' +
    'new Function. Comparison-operator behaviour, including -eq matching objects that ' +
    'lack the property entirely, was verified against pwsh 7.6.5.',
  parameters: [
    parameter('FilterScript', 'System.Management.Automation.ScriptBlock', {
      position: 0,
      mandatory: true,
    }),
    parameter('Property', STRING, { position: 0, mandatory: true }),
    parameter('Value', OBJECT, { position: 1 }),
    parameter('InputObject', OBJECT, { valueFromPipeline: true }),
    ...OPERATORS.flatMap((op) => [parameter(op, SWITCH), parameter(`C${op}`, SWITCH)]),
    ...UNARY_OR_TYPE.map((op) => parameter(op, SWITCH)),
  ],
  outputTypeNames: ['System.Object'],
});

export const whereObject: CommandModule = {
  manifest: WHERE_OBJECT_MANIFEST,

  async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
    const parameters = bound.parameters;
    const filterScript = rawValue(parameters, 'FilterScript');
    const filter = asScriptBlock(filterScript);
    // A script block is a HANDLE into this realm's registry, so "not a script
    // block" and "a script block whose closure lives somewhere else" are two
    // different answers. Collapsing them would leave `filter` undefined and
    // Where-Object would fall through to its no-filter branch, which passes
    // every object — a filter that silently stops filtering.
    if (filter === undefined && scriptBlockHandleOf(filterScript) !== undefined) {
      await context.streams.error.write(
        errorRecord(
          'The script block was created in another execution context and cannot be run here. ' +
            'A script block travels as a handle; its closure does not cross a worker boundary.',
          'ScriptBlockNotInThisRuntime',
          'Where-Object',
          'InvalidOperation',
          { exceptionType: 'System.Management.Automation.PSInvalidOperationException' },
        ),
      );
      return 1;
    }
    const property = stringValue(parameters, 'Property');
    const operator = resolveOperator(parameters);
    const right = rawValue(parameters, 'Value') ?? null;
    const sink = context.streams.success;

    for await (const item of context.input) {
      throwIfCancelled(context.signal, 'Where-Object');

      let keep: boolean;
      if (filter !== undefined) {
        keep = isTruthy(await filter(item));
      } else if (property !== undefined) {
        // The collapse the probe forced: absent and null are the same value to
        // every comparison operator, so `-eq $null` matches both.
        const left = resolveProperty(item, property) ?? null;
        keep = operator === undefined ? isTruthy(left) : applyOperator(operator, left, right);
      } else {
        // No filter and no property: PowerShell's binder rejects this before a
        // command body ever runs, so nothing here can meaningfully filter.
        keep = true;
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
