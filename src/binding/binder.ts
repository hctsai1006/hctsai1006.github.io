/**
 * binder.ts — argument tokens in, BoundParameters out.
 *
 * This is where the version-awareness lives. The reason it lives HERE and not
 * in the commands is recorded in invocation.ts: thirteen upstream PRs fixed one
 * design mistake about switch parameters, and modelling that per command would
 * mean thirteen forks of the same fix.
 *
 * ── WHAT THE PROBE CHANGED ────────────────────────────────────────────────
 *
 * Everything below was checked against pwsh 7.6.5 before it was written. Six
 * assumptions did not survive:
 *
 *  1. `-Force:$false` is NOT mishandled by the 7.6 binder. Real 7.6.5 binds
 *     `$PSBoundParameters['Force']` to a SwitchParameter whose value is False,
 *     with ContainsKey true — exactly what 7.7 does. Re-measured 2026-09-05:
 *     IsPresent False, ToBool False, key present. The 7.6 defect is in the
 *     COMMAND BODIES, which asked "was it supplied?" instead of "what is it?".
 *     Verified per cmdlet: `Where-Object -Property A -Not:$false` filters
 *     identically to `-Not`; `Split-Path /a/b/c.txt -Leaf:$false` still returns
 *     the leaf; `New-Guid -Empty:$false` still returns the empty GUID;
 *     `Get-Random -Shuffle:$false` still shuffles.
 *
 *     We collapse that into the binder, because this project centralises
 *     version-awareness here — but SCOPED TO THE PAIRS UPSTREAM ACTUALLY FIXED.
 *     It used to be one engine-wide `switchParameters.honourExplicitFalse`
 *     boolean, justified by "thirteen upstream PRs fixed one design mistake".
 *     Reading the PRs refutes the justification: they are ten PRs, each naming
 *     specific parameters on ONE cmdlet (#26140 is `-Empty` on New-Guid alone;
 *     #26474 is four named switches on Split-Path alone). 7.7 still has the old
 *     behaviour for every switch none of them touched, and the global boolean
 *     applied one cmdlet's bug to every switch parameter in the engine —
 *     including `Test-Diff -Force`, where measurement says 7.6.5 honours the
 *     value. So the flag is now
 *     `switchParameter.<Command>.<Parameter>.honourExplicitFalse`, derived here
 *     by the same function the generator derives it with, and a pair no profile
 *     declares honours the value under BOTH profiles — which is what the
 *     reference implementation does.
 *
 *     The user's actual intent is never lost either way:
 *     `explicitlyFalseSwitches` on the result records it under both profiles.
 *
 *  2. An array-typed positional parameter does NOT swallow the extra
 *     arguments. `Test-ArrOnly a b c`, where the only positional parameter is
 *     `[string[]]$Items` at position 0, fails with PositionalParameterNotFound.
 *     `Write-Output a b c` works only because InputObject is declared
 *     ValueFromRemainingArguments — confirmed in the captured metadata.
 *
 *  3. Positional binding walks positions ASCENDING and SKIPS parameters that
 *     the already-chosen parameter set excludes. `Test-Pos -LiteralPath z a`
 *     puts `a` at position 1 (Count), not position 0 (Path), because Path is
 *     not in the LiteralPath set.
 *
 *  4. The default parameter set beats mandatory satisfiability. Given a
 *     default set A with an unmet mandatory and a viable set B, pwsh picks A
 *     and reports MissingMandatoryParameter — it does not quietly switch to B.
 *
 *  5. A token starting with `-` is an argument, not a parameter name, when the
 *     next character is a digit or another dash. `Test-Pos 1 -5` binds
 *     Count = -5; `Test-T --Path x` treats `--Path` as a value.
 *
 *  6. Once a named parameter is waiting for a value, the NEXT token is that
 *     value whatever it looks like: `Test-Pos -Path -abc` binds `-abc`.
 */

import type { BindingResult, BoundParameters, CompatibilityView } from '../commands/invocation.ts';
import { switchBehaviorKey } from '../compatibility/behavior-keys.ts';
import type { CommandManifest, ParameterMetadata } from '../commands/manifest.ts';
import type { PSValue } from '../pipeline/psobject.ts';

import { coerceArgument, coerceScalar, coerceSwitchArgument, elementTypeOf } from './coercion.ts';
import {
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
} from './errors.ts';
import {
  ALL_PARAMETER_SETS,
  bindingInSet,
  declaredDefaultParameterSet,
  inSet,
  parameterSetNames,
  resolveParameterName,
} from './parameters.ts';
import { rulesFor, unenforceable, validate } from './validation.ts';
import type { ValidationDetail } from './validation.ts';

// ---------------------------------------------------------------------------
// public shape
// ---------------------------------------------------------------------------

/**
 * Facts the binder needs that `CommandManifest` does not carry.
 *
 * Every one of these is here because the shared manifest shape genuinely lacks
 * the field, not to make the binder configurable. They are all optional and the
 * binder is correct without them for the commands that do not need them.
 */
export interface BindOptions {
  /**
   * Which set wins when several fit. `CommandManifest` has no field for it yet,
   * so a caller holding the capture can pass it; a manifest that grows a
   * `defaultParameterSet` property is picked up automatically.
   */
  readonly defaultParameterSet?: string;
  /**
   * Arguments for validation attributes the manifest could only name. Without
   * these, `ValidateRangeAttribute` on `-Month` is reported as unenforced
   * rather than guessed at.
   */
  readonly validationDetails?: readonly ValidationDetail[];
  /**
   * Parameters declared `ValueFromRemainingArguments`. Not in
   * `ParameterSetBinding`, and without it `Write-Output a b c` cannot bind —
   * verified that a plain array-typed positional does not collect the rest.
   */
  readonly valueFromRemainingArguments?: readonly string[];
  /**
   * Let unbindable positional arguments through to `remaining` instead of
   * failing. For pass-through commands; pwsh itself always errors, which is
   * the default here.
   */
  readonly allowRemainingArguments?: boolean;
}

/**
 * `BindingResult` plus what the binder learned but the shared contract has
 * nowhere to put. Assignable to `BindingResult`, so nothing downstream needs
 * to know about it.
 */
export interface BindingSuccess extends BindingResult {
  /**
   * Switches the caller wrote as `-X:$false`.
   *
   * Under the 7.7 profile these are also bound false, so this is redundant.
   * Under 7.6 they are bound TRUE to reproduce that version's observable
   * behaviour, and this is the only surviving record of what was typed. A
   * command that wants to be honest in a diagnostic can read it; nothing is
   * required to.
   */
  readonly explicitlyFalseSwitches: readonly string[];
  /**
   * `Parameter:Attribute` for each validation attribute that was declared
   * without its arguments and therefore not enforced. Empty is the good case.
   */
  readonly unenforcedValidation: readonly string[];
}

export type BindingOutcome =
  | { readonly ok: true; readonly result: BindingSuccess }
  | { readonly ok: false; readonly error: ParameterBindingError };

// ---------------------------------------------------------------------------
// tokens
// ---------------------------------------------------------------------------

export interface ParameterToken {
  readonly name: string;
  /** The `value` half of `-Name:value`, or null when there was no colon. */
  readonly attached: string | null;
}

/**
 * Is this token a parameter name, and what does it carry?
 *
 * Returns null for anything that is an argument. The three exclusions are
 * verified, not defensive: a bare `-` binds as a value, `-5` binds as the
 * number, and `--Path` binds as the string.
 */
export function parseParameterToken(token: string): ParameterToken | null {
  if (!token.startsWith('-') || token.length === 1) return null;
  const next = token[1];
  if (next === undefined) return null;
  if (next === '-') return null;
  if (next >= '0' && next <= '9') return null;
  if (next === '.' && token[2] !== undefined && token[2] >= '0' && token[2] <= '9') return null;

  const body = token.slice(1);
  const colon = body.indexOf(':');
  if (colon === -1) return { name: body, attached: null };
  return { name: body.slice(0, colon), attached: body.slice(colon + 1) };
}

// ---------------------------------------------------------------------------
// binding
// ---------------------------------------------------------------------------

interface BoundValue {
  readonly parameter: ParameterMetadata;
  readonly value: PSValue;
  readonly explicitFalseSwitch: boolean;
}

/** Bind, or throw a `ParameterBindingError`. */
export function bindParameters(
  args: readonly string[],
  manifest: CommandManifest,
  profile: CompatibilityView,
  options: BindOptions = {},
): BindingSuccess {
  const outcome = tryBindParameters(args, manifest, profile, options);
  if (!outcome.ok) throw outcome.error;
  return outcome.result;
}

/** Bind, returning the failure instead of throwing it. */
export function tryBindParameters(
  args: readonly string[],
  manifest: CommandManifest,
  profile: CompatibilityView,
  options: BindOptions = {},
): BindingOutcome {
  try {
    return { ok: true, result: bind(args, manifest, profile, options) };
  } catch (error) {
    if (error instanceof ParameterBindingError) return { ok: false, error };
    throw error;
  }
}

function bind(
  args: readonly string[],
  manifest: CommandManifest,
  profile: CompatibilityView,
  options: BindOptions,
): BindingSuccess {
  const command = manifest.display;

  // A manifest with no declared parameters cannot bind anything, and erroring
  // on every token would break the simulated pass-through commands (`ls -la`,
  // `git status`) which declare none by design. Everything is `remaining`.
  if (manifest.parameters.length === 0) {
    return {
      parameters: {},
      parameterSet: ALL_PARAMETER_SETS,
      remaining: [...args],
      explicitlyFalseSwitches: [],
      unenforcedValidation: [],
    };
  }

  const bound = new Map<string, BoundValue>();
  const unenforced: string[] = [];
  const positional: string[] = [];

  /**
   * Does THIS command's THIS switch honour an explicit `:$false`?
   *
   * Scoped, and asked through `scopedBehavior` rather than `behavior`, because
   * an undeclared key here is a fact rather than a typo: it means no upstream PR
   * ever had to fix that pair, so both profiles behave the way the reference
   * implementation's binder does. `behavior` would report every ordinary switch
   * on every command as an unknown key.
   */
  const honoursExplicitFalse = (parameter: ParameterMetadata): boolean =>
    profile.scopedBehavior(switchBehaviorKey(manifest.display, parameter.name), true);
  const details = options.validationDetails ?? [];
  const remainingArgumentParameters = new Set(
    (options.valueFromRemainingArguments ?? []).map((name) => name.toLowerCase()),
  );

  /** Coerce, validate and record. Shared by the named and positional paths. */
  const record = (parameter: ParameterMetadata, values: readonly string[]): void => {
    const coerced = coerceArgument(values, parameter.type);
    if (!coerced.ok) {
      throw new ParameterBindingError({
        kind: 'ParameterArgumentTransformationError',
        command,
        parameterName: parameter.name,
        message: transformationMessage(parameter.name, coerced.reason),
        innerMessage: coerced.reason,
        innerExceptionTypeName:
          'System.Management.Automation.ArgumentTransformationMetadataException',
      });
    }
    check(parameter, coerced.value, false);
  };

  /**
   * The ValueFromRemainingArguments path.
   *
   * `Write-Output` declares InputObject as a bare `PSObject`, yet
   * `Write-Output a b c` binds all three — verified. So a collecting parameter
   * produces an array even when its declared type is scalar, and stays scalar
   * for a single value, which is what `Write-Output a` binds.
   */
  const collect = (parameter: ParameterMetadata, values: readonly string[]): void => {
    const element = elementTypeOf(parameter.type);
    if (element === null && values.length === 1) {
      record(parameter, values);
      return;
    }
    const out: PSValue[] = [];
    for (const value of values) {
      const coerced = coerceScalar(value, element ?? parameter.type);
      if (!coerced.ok) {
        throw new ParameterBindingError({
          kind: 'ParameterArgumentTransformationError',
          command,
          parameterName: parameter.name,
          message: transformationMessage(parameter.name, coerced.reason),
          innerMessage: coerced.reason,
          innerExceptionTypeName:
            'System.Management.Automation.ArgumentTransformationMetadataException',
        });
      }
      out.push(coerced.value);
    }
    check(parameter, out, false);
  };

  /** Validation, plus the honesty record of what could not be validated. */
  const check = (
    parameter: ParameterMetadata,
    value: PSValue,
    explicitFalseSwitch: boolean,
  ): void => {
    const rules = rulesFor(command, parameter.name, parameter.validation, profile, details);
    for (const attribute of unenforceable(rules)) {
      unenforced.push(`${parameter.name}:${attribute}`);
    }
    const failure = validate(rules, value, profile);
    if (failure !== null) {
      throw new ParameterBindingError({
        kind: 'ParameterArgumentValidationError',
        command,
        parameterName: parameter.name,
        message: validationMessage(parameter.name, failure.reason),
        innerMessage: failure.reason,
        innerExceptionTypeName: failure.exceptionTypeName,
      });
    }
    bound.set(parameter.name, { parameter, value, explicitFalseSwitch });
  };

  // ---- phase 1: named parameters, left to right -------------------------
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) continue;

    const parsed = parseParameterToken(token);
    if (parsed === null) {
      positional.push(token);
      continue;
    }

    const resolution = resolveParameterName(manifest.parameters, parsed.name);
    if (resolution.kind === 'notFound') {
      throw new ParameterBindingError({
        kind: 'NamedParameterNotFound',
        command,
        parameterName: parsed.name,
        message: namedParameterNotFoundMessage(parsed.name),
      });
    }
    if (resolution.kind === 'ambiguous') {
      throw new ParameterBindingError({
        kind: 'AmbiguousParameter',
        command,
        parameterName: parsed.name,
        message: ambiguousParameterMessage(
          parsed.name,
          resolution.candidates.map((candidate) => candidate.name),
        ),
      });
    }

    const parameter = resolution.parameter;
    if (bound.has(parameter.name)) {
      throw new ParameterBindingError({
        kind: 'ParameterAlreadyBound',
        command,
        parameterName: parameter.name,
        message: parameterAlreadyBoundMessage(parameter.name),
      });
    }

    // `-Name:` with nothing after the colon is a PARSER error upstream
    // ("Parameter -Force: requires an argument"), so it never reaches the real
    // binder. We have no parser, so it surfaces here as the closest analogue.
    if (parsed.attached === '') {
      throw new ParameterBindingError({
        kind: 'MissingArgument',
        command,
        parameterName: parameter.name,
        message: missingArgumentMessage(parameter.name, parameter.type),
      });
    }

    if (parameter.isSwitch) {
      if (parsed.attached === null) {
        check(parameter, true, false);
        continue;
      }
      const coerced = coerceSwitchArgument(parsed.attached);
      if (!coerced.ok) {
        throw new ParameterBindingError({
          kind: 'ParameterArgumentTransformationError',
          command,
          parameterName: parameter.name,
          message: transformationMessage(parameter.name, coerced.reason),
          innerMessage: coerced.reason,
          innerExceptionTypeName:
            'System.Management.Automation.ArgumentTransformationMetadataException',
        });
      }
      const explicit = coerced.value === false;
      // The 7.6/7.7 difference, in one expression, for the ONE pair it applies
      // to. See header note 1: 7.6's real binder also stores false, but the
      // 7.6 COMMANDS upstream later fixed read presence, so presence is what
      // those pairs must be modelled as — and only those.
      check(parameter, honoursExplicitFalse(parameter) ? coerced.value : true, explicit);
      continue;
    }

    if (parsed.attached !== null) {
      record(parameter, [parsed.attached]);
      continue;
    }

    // Verified: the next token is the value whatever it looks like, so `-Path
    // -abc` binds the string `-abc` rather than reading a second parameter.
    const next = args[index + 1];
    if (next === undefined) {
      throw new ParameterBindingError({
        kind: 'MissingArgument',
        command,
        parameterName: parameter.name,
        message: missingArgumentMessage(parameter.name, parameter.type),
      });
    }
    index += 1;
    record(parameter, [next]);
  }

  // ---- phase 2: narrow the parameter sets --------------------------------
  const setNames = parameterSetNames(manifest);
  const hasNamedSets = setNames.length > 0;
  const defaultSet = options.defaultParameterSet ?? declaredDefaultParameterSet(manifest);
  let candidates = hasNamedSets ? [...setNames] : [ALL_PARAMETER_SETS];

  const narrow = (parameter: ParameterMetadata): void => {
    if (!hasNamedSets) return;
    candidates = candidates.filter((name) => inSet(parameter, name));
  };
  for (const entry of bound.values()) narrow(entry.parameter);

  // ---- phase 3: positional arguments -------------------------------------
  const leftover: string[] = [];
  let queue = positional;
  while (queue.length > 0) {
    const choice = nextPositional(manifest, bound, candidates);
    if (choice === null) {
      if (options.allowRemainingArguments === true) {
        leftover.push(...queue);
        break;
      }
      const first = queue[0] ?? '';
      throw new ParameterBindingError({
        kind: 'PositionalParameterNotFound',
        command,
        parameterName: first,
        message: positionalParameterNotFoundMessage(first),
      });
    }

    if (remainingArgumentParameters.has(choice.name.toLowerCase())) {
      collect(choice, queue);
      queue = [];
    } else {
      const head = queue[0];
      if (head === undefined) break;
      record(choice, [head]);
      queue = queue.slice(1);
    }
    narrow(choice);
  }

  /** Lowest still-open position among the parameters the candidate sets allow. */
  function nextPositional(
    forManifest: CommandManifest,
    alreadyBound: ReadonlyMap<string, BoundValue>,
    sets: readonly string[],
  ): ParameterMetadata | null {
    let best: { parameter: ParameterMetadata; position: number; inDefault: boolean } | null = null;
    for (const setName of sets) {
      const isDefault = defaultSet !== null && setName === defaultSet;
      for (const parameter of forManifest.parameters) {
        if (alreadyBound.has(parameter.name)) continue;
        if (hasNamedSets && !inSet(parameter, setName)) continue;
        const binding = bindingInSet(parameter, setName);
        if (binding === null || binding.position === null) continue;
        if (best === null || binding.position < best.position) {
          best = { parameter, position: binding.position, inDefault: isDefault };
          continue;
        }
        // Two different parameters really can share a position across sets —
        // `Where-Object` has FilterScript and Property both at 0. Without the
        // argument's runtime type, which we do not have, the default set is
        // the only principled tie-break, and it is what pwsh chose for
        // `Get-Random 10` and `Where-Object N -eq 2`.
        if (binding.position === best.position && isDefault && !best.inDefault) {
          best = { parameter, position: binding.position, inDefault: isDefault };
        }
      }
    }
    return best === null ? null : best.parameter;
  }

  // ---- phase 4: resolve the parameter set ---------------------------------
  let parameterSet: string;
  if (!hasNamedSets) {
    parameterSet = ALL_PARAMETER_SETS;
  } else if (candidates.length === 1 && candidates[0] !== undefined) {
    parameterSet = candidates[0];
  } else if (candidates.length === 0 || defaultSet === null || !candidates.includes(defaultSet)) {
    // Same sentence for "nothing fits" and "too many fit" — that is what the
    // reference implementation prints, and inventing a better one would make
    // our output unrecognisable to anyone matching on it.
    throw new ParameterBindingError({
      kind: 'AmbiguousParameterSet',
      command,
      message: ambiguousParameterSetMessage(),
    });
  } else {
    parameterSet = defaultSet;
  }

  // ---- phase 5: mandatory parameters of the chosen set --------------------
  const missing: string[] = [];
  for (const parameter of manifest.parameters) {
    if (bound.has(parameter.name)) continue;
    if (hasNamedSets && !inSet(parameter, parameterSet)) continue;
    const binding = bindingInSet(parameter, parameterSet);
    if (binding !== null && binding.mandatory) missing.push(parameter.name);
  }
  if (missing.length > 0) {
    throw new ParameterBindingError({
      kind: 'MissingMandatoryParameter',
      command,
      parameterName: missing.join(', '),
      message: missingMandatoryParameterMessage(missing),
    });
  }

  // ---- result -------------------------------------------------------------
  const parameters: Record<string, PSValue> = {};
  const explicitlyFalseSwitches: string[] = [];
  for (const entry of bound.values()) {
    // An unsupplied parameter never reaches this loop, which is what keeps it
    // ABSENT from BoundParameters rather than present-and-undefined.
    parameters[entry.parameter.name] = entry.value;
    if (entry.explicitFalseSwitch) explicitlyFalseSwitches.push(entry.parameter.name);
  }

  return {
    parameters: parameters as BoundParameters,
    parameterSet,
    remaining: leftover,
    explicitlyFalseSwitches,
    unenforcedValidation: unenforced,
  };
}
