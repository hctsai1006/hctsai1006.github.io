/**
 * The binder's public surface.
 *
 * `bindParameters` throws and `tryBindParameters` returns — the caller chooses.
 * A kernel dispatching commands wants a value it can hand to the error stream
 * without a try block; a command calling the binder directly wants an
 * exception. Offering both costs one wrapper and avoids the usual argument.
 */

export {
  bindArgumentOf,
  bindParameters,
  tryBindParameters,
  parseParameterToken,
  type BindArgument,
  type BindInput,
  type BindOptions,
  type BindingOutcome,
  type BindingSuccess,
  type ParameterToken,
} from './binder.ts';

export {
  bindCommand,
  bindCommandArguments,
  tryBindCommand,
} from './from-ast.ts';

export {
  ParameterBindingError,
  ambiguousParameterMessage,
  ambiguousParameterSetMessage,
  missingArgumentMessage,
  missingMandatoryParameterMessage,
  namedParameterNotFoundMessage,
  parameterAlreadyBoundMessage,
  positionalParameterNotFoundMessage,
  transformationMessage,
  validationMessage,
  type BindingErrorCategory,
  type BindingErrorKind,
} from './errors.ts';

export {
  booleanLiteral,
  coerceArgument,
  coerceScalar,
  coerceSwitchArgument,
  elementTypeOf,
  roundHalfToEven,
  SWITCH_TYPE,
  type CoercionResult,
} from './coercion.ts';

export {
  ALL_PARAMETER_SETS,
  bindingInSet,
  inSet,
  parameterSetNames,
  resolveParameterName,
  setsOf,
  type ParameterResolution,
} from './parameters.ts';

export {
  ParameterPatchError,
  applyParameterPatches,
  switchHonoursExplicitFalse,
  type ParameterPatch,
  type ParameterPatchSet,
  type PatchReport,
} from './patches.ts';

export {
  parseValidationRule,
  rulesFor,
  validate,
  type ValidationDetail,
  type ValidationRule,
} from './validation.ts';
