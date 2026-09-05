/**
 * errors.ts — what a binding failure IS.
 *
 * PowerShell does not report "bad arguments". It reports a specific error id, a
 * category, an exception type and a sentence, and scripts branch on all four:
 * `$_.FullyQualifiedErrorId -like 'AmbiguousParameter*'` is real code people
 * write. Emitting a generic message would look right in a terminal and be
 * useless to anything reading it.
 *
 * Every id, category, exception type and message below was READ OFF pwsh 7.6.5
 * rather than reasoned about. Where the reference implementation surprised us,
 * the surprise is recorded at the site.
 *
 * Probe (all of these were run):
 *
 *   Test-Binder -Pat a        → AmbiguousParameter,Test-Binder
 *   Test-Binder -Nope a       → NamedParameterNotFound,Test-Binder
 *   Test-Pos a 5 f extra      → PositionalParameterNotFound,Test-Pos
 *   Test-Pos -Path a -Path b  → ParameterAlreadyBound,Test-Pos
 *   Test-Sw -Flag             → MissingArgument,Test-Sw
 *   Test-Mand -Optional x     → MissingMandatoryParameter,Test-Mand
 *   Test-Pos -Path a -LiteralPath b → AmbiguousParameterSet,Test-Pos
 *   Test-Pos -Count abc       → ParameterArgumentTransformationError,Test-Pos
 *   Get-Date -Month 13        → ParameterArgumentValidationError,…GetDateCommand
 */

/**
 * The `FullyQualifiedErrorId` prefix. The full id is `<kind>,<command>`, which
 * is why this is a string union rather than an opaque code: the id is part of
 * the observable contract, not an internal label.
 */
export type BindingErrorKind =
  /** `-Nope` matched no parameter name or alias. */
  | 'NamedParameterNotFound'
  /** A prefix matched more than one parameter. */
  | 'AmbiguousParameter'
  /** The same parameter was supplied twice. */
  | 'ParameterAlreadyBound'
  /** A parameter that needs a value was given none. */
  | 'MissingArgument'
  /** A positional argument had nowhere left to go. */
  | 'PositionalParameterNotFound'
  /** The resolved parameter set has an unsatisfied mandatory parameter. */
  | 'MissingMandatoryParameter'
  /** Zero, or more than one, parameter set fits the arguments. */
  | 'AmbiguousParameterSet'
  /** The argument could not be converted to the declared .NET type. */
  | 'ParameterArgumentTransformationError'
  /** The argument converted, but failed a validation attribute. */
  | 'ParameterArgumentValidationError';

/**
 * `$_.CategoryInfo.Category`. Verified split: everything that is a *shape*
 * problem is InvalidArgument, and the two failures that happen once a value
 * exists — conversion and validation — are InvalidData.
 */
export type BindingErrorCategory = 'InvalidArgument' | 'InvalidData';

const PARAMETER_BINDING_EXCEPTION = 'System.Management.Automation.ParameterBindingException';
const TRANSFORMATION_EXCEPTION =
  'System.Management.Automation.ParameterBindingArgumentTransformationException';
const VALIDATION_EXCEPTION = 'System.Management.Automation.ParameterBindingValidationException';

const EXCEPTION_TYPE: Record<BindingErrorKind, string> = {
  NamedParameterNotFound: PARAMETER_BINDING_EXCEPTION,
  AmbiguousParameter: PARAMETER_BINDING_EXCEPTION,
  ParameterAlreadyBound: PARAMETER_BINDING_EXCEPTION,
  MissingArgument: PARAMETER_BINDING_EXCEPTION,
  PositionalParameterNotFound: PARAMETER_BINDING_EXCEPTION,
  MissingMandatoryParameter: PARAMETER_BINDING_EXCEPTION,
  AmbiguousParameterSet: PARAMETER_BINDING_EXCEPTION,
  ParameterArgumentTransformationError: TRANSFORMATION_EXCEPTION,
  ParameterArgumentValidationError: VALIDATION_EXCEPTION,
};

const CATEGORY: Record<BindingErrorKind, BindingErrorCategory> = {
  NamedParameterNotFound: 'InvalidArgument',
  AmbiguousParameter: 'InvalidArgument',
  ParameterAlreadyBound: 'InvalidArgument',
  MissingArgument: 'InvalidArgument',
  PositionalParameterNotFound: 'InvalidArgument',
  MissingMandatoryParameter: 'InvalidArgument',
  AmbiguousParameterSet: 'InvalidArgument',
  ParameterArgumentTransformationError: 'InvalidData',
  ParameterArgumentValidationError: 'InvalidData',
};

export interface BindingErrorInit {
  readonly kind: BindingErrorKind;
  /** The command's display name; it becomes the second half of the error id. */
  readonly command: string;
  readonly message: string;
  /** `$_.Exception.ParameterName`, when the failure is about one parameter. */
  readonly parameterName?: string;
  /**
   * The message of the wrapped exception. Transformation and validation
   * failures nest: the outer sentence names the parameter, the inner one says
   * what was wrong. Scripts match on both, so both are kept.
   */
  readonly innerMessage?: string;
  readonly innerExceptionTypeName?: string;
}

/**
 * A binding failure, carrying everything the error stream needs.
 *
 * This is thrown rather than returned by `bindParameters`, and returned rather
 * than thrown by `tryBindParameters` — the caller picks. A kernel dispatching
 * commands wants a value it can write to the error stream without a try block;
 * a command implementation calling the binder directly wants an exception.
 */
export class ParameterBindingError extends Error {
  readonly kind: BindingErrorKind;
  readonly command: string;
  readonly parameterName: string | null;
  readonly category: BindingErrorCategory;
  readonly exceptionTypeName: string;
  readonly innerMessage: string | null;
  readonly innerExceptionTypeName: string | null;

  constructor(init: BindingErrorInit) {
    super(init.message);
    this.name = 'ParameterBindingError';
    this.kind = init.kind;
    this.command = init.command;
    this.parameterName = init.parameterName ?? null;
    this.category = CATEGORY[init.kind];
    this.exceptionTypeName = EXCEPTION_TYPE[init.kind];
    this.innerMessage = init.innerMessage ?? null;
    this.innerExceptionTypeName = init.innerExceptionTypeName ?? null;
  }

  /** `$_.FullyQualifiedErrorId`. */
  get fullyQualifiedErrorId(): string {
    return `${this.kind},${this.command}`;
  }
}

// ---------------------------------------------------------------------------
// message builders
//
// Kept as pure functions so a test can assert the exact sentence, which is the
// only way to notice a wording drift. Every template below is a byte-for-byte
// copy of what pwsh 7.6.5 printed for the probe named above it.
// ---------------------------------------------------------------------------

/** `Test-Binder -Nope a` */
export const namedParameterNotFoundMessage = (name: string): string =>
  `A parameter cannot be found that matches parameter name '${name}'.`;

/**
 * `Test-Binder -Pat a`
 *
 * The candidate list is names, never the alias that matched — `-X` matching
 * `Alpha` through its alias `Xy` still prints `-Alpha`. Verified, and the
 * opposite is the obvious guess.
 */
export const ambiguousParameterMessage = (name: string, candidates: readonly string[]): string =>
  `Parameter cannot be processed because the parameter name '${name}' is ambiguous. ` +
  `Possible matches include: ${candidates.map((c) => `-${c}`).join(' ')}.`;

/** `Test-Pos -Path a -Path b` */
export const parameterAlreadyBoundMessage = (name: string): string =>
  `Cannot bind parameter because parameter '${name}' is specified more than once. ` +
  'To provide multiple values to parameters that can accept multiple values, use the array syntax. ' +
  'For example, "-parameter value1,value2,value3".';

/** `Test-Sw -Flag` — the .NET type name is part of the sentence. */
export const missingArgumentMessage = (name: string, typeName: string): string =>
  `Missing an argument for parameter '${name}'. Specify a parameter of type '${typeName}' and try again.`;

/** `Test-Pos a 5 f extra` */
export const positionalParameterNotFoundMessage = (argument: string): string =>
  `A positional parameter cannot be found that accepts argument '${argument}'.`;

/** `Test-Mand -Optional x` — several names are joined with ', '. */
export const missingMandatoryParameterMessage = (names: readonly string[]): string =>
  `Cannot process command because of one or more missing mandatory parameters: ${names.join(', ')}.`;

/**
 * `Test-Pos -Path a -LiteralPath b`
 *
 * Note the reference implementation says nothing about WHICH parameters
 * conflicted, and gives the identical sentence for "no set matches" and "more
 * than one set matches". We keep the wording, and put the discrimination in
 * `kind` plus the candidate list on the error object instead of inventing a
 * message pwsh never prints.
 */
export const ambiguousParameterSetMessage = (): string =>
  'Parameter set cannot be resolved using the specified named parameters. ' +
  'One or more parameters issued cannot be used together or an insufficient number of parameters were provided.';

/** `Test-Pos -Count abc` — the outer half of a nested transformation failure. */
export const transformationMessage = (name: string, inner: string): string =>
  `Cannot process argument transformation on parameter '${name}'. ${inner}`;

/** `Get-Date -Month 13` — the outer half of a nested validation failure. */
export const validationMessage = (name: string, inner: string): string =>
  `Cannot validate argument on parameter '${name}'. ${inner}`;
