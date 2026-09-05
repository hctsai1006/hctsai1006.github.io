/**
 * validation.ts — the attributes that reject a value after it converted.
 *
 * Two things make this more than a switch statement.
 *
 * FIRST, the captured metadata is lossy. `compat/upstream/v7.6.5/command-metadata.json`
 * records `ValidateRangeAttribute` on `Get-Date -Month` WITH its bounds, but
 * `CommandManifest` flattens the attribute list to `readonly string[]`, so by
 * the time a manifest reaches the binder the bounds are gone. Guessing them
 * would be a fiction and silently skipping them would be a lie of omission, so
 * an unparameterised attribute is recorded in `unenforcedValidation` on the
 * result and a caller that has the arguments can supply them through
 * `BindOptions.validationDetails`. What is enforced is always knowable.
 *
 * SECOND, one of these attributes is version-dependent. PowerShell 7.7 adds
 * `ValidateNotNullOrEmpty` to `-Property` on the Format-* commands (upstream
 * PR 26552). That is modelled as a profile-driven AUGMENTATION of the rule
 * list — `format.property.rejectNullOrEmpty` adds a rule — rather than an
 * `if (version === '7.7')` inside the enforcement path. Verified on 7.6.5:
 * `Format-Table -Property ''` binds without complaint there and only fails
 * later inside the formatter, with `ExpressionEmptyString2` and a
 * NotSupportedException, which is a different error from a binding failure.
 *
 * Every message below was read off pwsh 7.6.5.
 */

import type { PSValue } from '../pipeline/psobject.ts';
import type { CompatibilityView } from '../commands/invocation.ts';

// ---------------------------------------------------------------------------
// rules
// ---------------------------------------------------------------------------

export type ValidationRule =
  | { readonly kind: 'NotNull' }
  | { readonly kind: 'NotNullOrEmpty' }
  | { readonly kind: 'Set'; readonly values: readonly string[] }
  | { readonly kind: 'Range'; readonly min: string | null; readonly max: string | null }
  | { readonly kind: 'Pattern'; readonly pattern: string }
  | { readonly kind: 'Length'; readonly min: number; readonly max: number }
  | { readonly kind: 'Count'; readonly min: number; readonly max: number }
  /**
   * The manifest named an attribute that needs arguments and did not supply
   * them. Carried rather than dropped so the binder can report it.
   */
  | { readonly kind: 'Unparameterised'; readonly attribute: string };

/**
 * Arguments for an attribute the manifest could only name.
 *
 * Sourced from the upstream capture by whoever loads it; the binder never reads
 * a file. Keyed by parameter because that is how the capture is shaped.
 */
export interface ValidationDetail {
  readonly parameter: string;
  /** Canonical attribute name, with or without the `Attribute` suffix. */
  readonly attribute: string;
  readonly arguments: readonly string[];
}

/** Strip the `Attribute` suffix .NET reflection reports. */
const canonicalAttributeName = (name: string): string =>
  name.endsWith('Attribute') ? name.slice(0, -'Attribute'.length) : name;

/** `ValidateSet('A','B')` → `["A", "B"]`; unquoted items are taken verbatim. */
function splitAttributeArguments(text: string): readonly string[] {
  if (text.trim() === '') return [];
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const char of text) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === ',') {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  out.push(current.trim());
  return out;
}

const toCount = (text: string | undefined, fallback: number): number => {
  if (text === undefined) return fallback;
  const value = Number(text);
  return Number.isFinite(value) ? value : fallback;
};

/**
 * Parse one entry of `ParameterMetadata.validation`.
 *
 * Accepts both the bare reflection name the capture produces
 * (`ValidateRangeAttribute`) and a hand-written parameterised form
 * (`ValidateRange(0, 100)`), so a declared manifest can express a rule the
 * capture cannot carry.
 */
export function parseValidationRule(
  text: string,
  supplied?: readonly string[],
): ValidationRule | null {
  const open = text.indexOf('(');
  const name = canonicalAttributeName((open === -1 ? text : text.slice(0, open)).trim());
  const inline =
    open === -1 || !text.trimEnd().endsWith(')')
      ? null
      : splitAttributeArguments(text.slice(open + 1, text.trimEnd().length - 1));
  const args = inline ?? supplied ?? null;

  switch (name) {
    case 'ValidateNotNull':
      return { kind: 'NotNull' };
    case 'ValidateNotNullOrEmpty':
      return { kind: 'NotNullOrEmpty' };
    case 'ValidateSet':
      return args === null ? { kind: 'Unparameterised', attribute: name } : { kind: 'Set', values: args };
    case 'ValidateRange':
      if (args === null) return { kind: 'Unparameterised', attribute: name };
      // `Test-Connection -Count` carries a ValidateRangeKind rather than
      // bounds, so the capture records the attribute with neither min nor max.
      return { kind: 'Range', min: args[0] ?? null, max: args[1] ?? null };
    case 'ValidatePattern':
      return args === null || args[0] === undefined
        ? { kind: 'Unparameterised', attribute: name }
        : { kind: 'Pattern', pattern: args[0] };
    case 'ValidateLength':
      return args === null
        ? { kind: 'Unparameterised', attribute: name }
        : { kind: 'Length', min: toCount(args[0], 0), max: toCount(args[1], Number.MAX_SAFE_INTEGER) };
    case 'ValidateCount':
      return args === null
        ? { kind: 'Unparameterised', attribute: name }
        : { kind: 'Count', min: toCount(args[0], 0), max: toCount(args[1], Number.MAX_SAFE_INTEGER) };
    default:
      // Not a validation attribute — AliasAttribute, ArgumentCompleter,
      // CredentialAttribute and friends all appear in the same list.
      return null;
  }
}

/**
 * Behaviour flags that ADD a validation rule.
 *
 * A table rather than a branch, so adding the next one is data. `commands` is
 * matched against the manifest display name and `parameter` against the
 * parameter name, both case-insensitively.
 */
interface ValidationAugmentation {
  readonly behavior: string;
  readonly commandPattern: RegExp;
  readonly parameter: string;
  readonly rule: ValidationRule;
}

const AUGMENTATIONS: readonly ValidationAugmentation[] = [
  {
    // PR 26552. Verified absent in 7.6.5 by probing `Format-Table -Property ''`,
    // which binds there and fails only inside the formatter.
    behavior: 'format.property.rejectNullOrEmpty',
    commandPattern: /^format-/i,
    parameter: 'property',
    rule: { kind: 'NotNullOrEmpty' },
  },
];

/**
 * Every rule that applies to one parameter under the active profile.
 *
 * The profile is consulted here and nowhere else in the enforcement path, which
 * is what keeps the 7.6/7.7 difference out of the rule implementations.
 */
export function rulesFor(
  command: string,
  parameter: string,
  declared: readonly string[],
  profile: CompatibilityView,
  details: readonly ValidationDetail[],
): readonly ValidationRule[] {
  const rules: ValidationRule[] = [];

  for (const entry of declared) {
    const supplied = details.find(
      (detail) =>
        detail.parameter.toLowerCase() === parameter.toLowerCase() &&
        canonicalAttributeName(detail.attribute).toLowerCase() ===
          canonicalAttributeName(entry.split('(')[0] ?? entry).trim().toLowerCase(),
    );
    const rule = parseValidationRule(entry, supplied?.arguments);
    if (rule !== null) rules.push(rule);
  }

  for (const augmentation of AUGMENTATIONS) {
    if (!augmentation.commandPattern.test(command)) continue;
    if (augmentation.parameter !== parameter.toLowerCase()) continue;
    if (!profile.behavior(augmentation.behavior, false)) continue;
    rules.push(augmentation.rule);
  }

  return rules;
}

// ---------------------------------------------------------------------------
// enforcement
// ---------------------------------------------------------------------------

export interface ValidationFailure {
  /** The inner sentence; the binder wraps it with the parameter name. */
  readonly reason: string;
  /**
   * The exception type the failure would carry.
   *
   * `validation.throwsArgumentException` (PR 26668) changes this in 7.7. The
   * 7.6 value is verified — pwsh 7.6.5 reports ValidationMetadataException
   * inside a ParameterBindingValidationException. The 7.7 value is taken from
   * the recorded delta and could NOT be verified here, because only 7.6.5 is
   * installed; it is marked as such rather than presented as measured.
   */
  readonly exceptionTypeName: string;
}

const VALIDATION_METADATA_EXCEPTION = 'System.Management.Automation.ValidationMetadataException';

/** Numeric comparison that survives Int64, where a double would not. */
function compareNumeric(value: PSValue, bound: string): number | null {
  const trimmed = bound.trim();
  if (typeof value === 'bigint' && /^[+-]?\d+$/.test(trimmed)) {
    const other = BigInt(trimmed);
    return value < other ? -1 : value > other ? 1 : 0;
  }
  const left = typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : null;
  const right = Number(trimmed);
  if (left === null || !Number.isFinite(right)) return null;
  return left < right ? -1 : left > right ? 1 : 0;
}

const asItems = (value: PSValue): readonly PSValue[] => (Array.isArray(value) ? value : [value]);

/** True for the values `ValidateNotNullOrEmpty` calls empty. */
const isNullOrEmpty = (value: PSValue): boolean =>
  value === null || (typeof value === 'string' && value.length === 0);

function checkRule(rule: ValidationRule, value: PSValue): string | null {
  switch (rule.kind) {
    case 'NotNull':
      return value === null
        ? 'The argument is null. Provide a valid value for the argument, and then try running the command again.'
        : null;

    case 'NotNullOrEmpty': {
      // One sentence covers null, empty, empty collection and a collection
      // holding an empty element — verified with '', @() and @('A','').
      const items = asItems(value);
      const empty =
        isNullOrEmpty(value) || items.length === 0 || items.some((item) => isNullOrEmpty(item));
      return empty
        ? 'The argument is null, empty, or an element of the argument collection contains a null value. ' +
            'Supply a collection that does not contain any null values and then try the command again.'
        : null;
    }

    case 'Set': {
      // Verified CASE-INSENSITIVE, and the original casing is kept: passing
      // 'coreonly' to a set of 'CoreOnly' binds the string the user typed.
      for (const item of asItems(value)) {
        const text = String(item);
        if (rule.values.some((allowed) => allowed.toLowerCase() === text.toLowerCase())) continue;
        return (
          `The argument "${text}" does not belong to the set "${rule.values.join(',')}" ` +
          'specified by the ValidateSet attribute. Supply an argument that is in the set and then try the command again.'
        );
      }
      return null;
    }

    case 'Range': {
      for (const item of asItems(value)) {
        if (rule.min !== null) {
          const order = compareNumeric(item, rule.min);
          if (order !== null && order < 0) {
            return (
              `The ${String(item)} argument is less than the minimum allowed range of ${rule.min}. ` +
              `Supply an argument that is greater than or equal to ${rule.min} and then try the command again.`
            );
          }
        }
        if (rule.max !== null) {
          const order = compareNumeric(item, rule.max);
          if (order !== null && order > 0) {
            return (
              `The ${String(item)} argument is greater than the maximum allowed range of ${rule.max}. ` +
              `Supply an argument that is less than or equal to ${rule.max} and then try the command again.`
            );
          }
        }
      }
      return null;
    }

    case 'Pattern': {
      // .NET's Regex, not JavaScript's: close enough for the character classes
      // the captured attributes use, and a pattern we cannot compile is treated
      // as unenforceable rather than as a failure of the user's argument.
      let expression: RegExp;
      try {
        expression = new RegExp(rule.pattern);
      } catch {
        return null;
      }
      for (const item of asItems(value)) {
        const text = String(item);
        if (expression.test(text)) continue;
        return (
          `The argument "${text}" does not match the "${rule.pattern}" pattern. ` +
          `Supply an argument that matches "${rule.pattern}" and try the command again.`
        );
      }
      return null;
    }

    case 'Length': {
      for (const item of asItems(value)) {
        const length = String(item ?? '').length;
        if (length < rule.min) {
          return (
            `The character length (${length}) of the argument is too short. ` +
            `Specify an argument with a length that is greater than or equal to "${rule.min}", and then try the command again.`
          );
        }
        if (length > rule.max) {
          // Yes, "the 6 argument" — the reference implementation words the two
          // halves of this attribute differently and we copy it verbatim.
          return (
            `The character length of the ${length} argument is too long. ` +
            `Shorten the character length of the argument so it is fewer than or equal to "${rule.max}" characters, and then try the command again.`
          );
        }
      }
      return null;
    }

    case 'Count': {
      const count = Array.isArray(value) ? value.length : 1;
      return count < rule.min || count > rule.max
        ? `The parameter requires at least ${rule.min} value(s) and no more than ${rule.max} value(s) - ` +
            `${count} value(s) were provided.`
        : null;
    }

    case 'Unparameterised':
      // Nothing to check: the manifest named the attribute but not its
      // arguments. Reported through `unenforcedValidation` instead.
      return null;
  }
}

/** Run every rule; the first failure wins, as it does in the reference. */
export function validate(
  rules: readonly ValidationRule[],
  value: PSValue,
  profile: CompatibilityView,
): ValidationFailure | null {
  for (const rule of rules) {
    const reason = checkRule(rule, value);
    if (reason === null) continue;
    const throwsArgumentException =
      (rule.kind === 'NotNull' || rule.kind === 'NotNullOrEmpty') &&
      profile.behavior('validation.throwsArgumentException', false);
    return {
      reason,
      exceptionTypeName: throwsArgumentException
        ? 'System.ArgumentException'
        : VALIDATION_METADATA_EXCEPTION,
    };
  }
  return null;
}

/** Attributes that were declared but could not be enforced, for the result. */
export const unenforceable = (rules: readonly ValidationRule[]): readonly string[] =>
  rules.filter((rule) => rule.kind === 'Unparameterised').map((rule) => rule.attribute);
