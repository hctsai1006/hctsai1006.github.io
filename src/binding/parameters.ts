/**
 * parameters.ts — finding the parameter a token names, and the sets it lives in.
 *
 * PowerShell's name resolution is not a dictionary lookup. `-Pat` binds `-Path`
 * when nothing else starts with those letters and fails when something does,
 * aliases participate on equal terms, and case never matters. Getting the
 * precedence wrong is not a cosmetic bug: `-F` silently binding the wrong
 * parameter changes what a command does.
 *
 * Verified against pwsh 7.6.5, and two of the rules were not the obvious guess:
 *
 *   - an EXACT match wins outright. `-Pa` binds a parameter literally named
 *     `Pa` even when `-Path` and `-PathType` also exist; only a non-exact
 *     prefix can be ambiguous.
 *   - ambiguity is per PARAMETER, not per name. `-L` matches both the name
 *     `LiteralPath` and its alias `LP`, and binds without complaint because
 *     they are the same parameter.
 *
 * The candidate list in the ambiguity message is name matches first, in
 * manifest order, then alias matches. Verified: on a function declaring
 * `[Alias('Xy')] $Alpha` before `$Xyz`, `-X` reports "-Xyz -Alpha" — the
 * alias-matched parameter goes last despite being declared first, and it is
 * listed by its NAME, not by the alias that matched it.
 */

import type { CommandManifest, ParameterMetadata } from '../commands/manifest.ts';

/** The set name PowerShell uses for "belongs to every set". */
export const ALL_PARAMETER_SETS = '__AllParameterSets';

export type ParameterResolution =
  | { readonly kind: 'found'; readonly parameter: ParameterMetadata }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly ParameterMetadata[] };

const equalsIgnoreCase = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const startsWithIgnoreCase = (haystack: string, prefix: string): boolean =>
  haystack.toLowerCase().startsWith(prefix.toLowerCase());

/**
 * Resolve a written parameter name against a manifest.
 *
 * An empty name cannot match anything, which is how `--Path` ends up being an
 * argument rather than a parameter: the caller strips one dash and is left with
 * `-Path`, which no parameter is called.
 */
export function resolveParameterName(
  parameters: readonly ParameterMetadata[],
  written: string,
): ParameterResolution {
  if (written === '') return { kind: 'notFound' };

  for (const parameter of parameters) {
    if (equalsIgnoreCase(parameter.name, written)) return { kind: 'found', parameter };
  }
  for (const parameter of parameters) {
    if (parameter.aliases.some((alias) => equalsIgnoreCase(alias, written))) {
      return { kind: 'found', parameter };
    }
  }

  const byName = parameters.filter((parameter) => startsWithIgnoreCase(parameter.name, written));
  const byAlias = parameters.filter(
    (parameter) =>
      !byName.includes(parameter) &&
      parameter.aliases.some((alias) => startsWithIgnoreCase(alias, written)),
  );
  const candidates = [...byName, ...byAlias];

  if (candidates.length === 0) return { kind: 'notFound' };
  const only = candidates[0];
  if (candidates.length === 1 && only !== undefined) return { kind: 'found', parameter: only };
  return { kind: 'ambiguous', candidates };
}

// ---------------------------------------------------------------------------
// parameter sets
// ---------------------------------------------------------------------------

/**
 * The sets a parameter belongs to, or `'all'`.
 *
 * `ParameterMetadata.sets` keys the per-set bindings by set name and uses
 * `__AllParameterSets` for a parameter declared outside any named set. Keeping
 * `'all'` as a distinct answer rather than expanding it to "every set name"
 * matters when a manifest declares no named sets at all.
 */
export function setsOf(parameter: ParameterMetadata): ReadonlySet<string> | 'all' {
  const names = Object.keys(parameter.sets);
  if (names.length === 0 || names.includes(ALL_PARAMETER_SETS)) return 'all';
  return new Set(names);
}

/** Every named parameter set the command declares, in first-seen order. */
export function parameterSetNames(manifest: CommandManifest): readonly string[] {
  const names: string[] = [];
  for (const parameter of manifest.parameters) {
    for (const name of Object.keys(parameter.sets)) {
      if (name === ALL_PARAMETER_SETS) continue;
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

/** Is this parameter usable in the named set? */
export function inSet(parameter: ParameterMetadata, setName: string): boolean {
  const sets = setsOf(parameter);
  return sets === 'all' || sets.has(setName);
}

/**
 * The per-set facts for one parameter in one set, falling back to the
 * all-sets entry.
 *
 * A parameter really can differ between sets: `New-Item -Path` is mandatory at
 * position 0 in `pathSet` and optional at position 0 in `nameSet`. Reading a
 * flattened `mandatory` would make the binder reject `New-Item -Name x
 * -ItemType File`, which the reference implementation accepts.
 */
export function bindingInSet(
  parameter: ParameterMetadata,
  setName: string,
): { position: number | null; mandatory: boolean } | null {
  const exact = parameter.sets[setName];
  if (exact !== undefined) return exact;
  const all = parameter.sets[ALL_PARAMETER_SETS];
  if (all !== undefined) return all;
  return Object.keys(parameter.sets).length === 0
    ? { position: parameter.firstPosition, mandatory: parameter.mandatoryInAnySet }
    : null;
}

/**
 * A manifest may name its default parameter set; `CommandManifest` does not yet
 * declare the field, so it is read structurally rather than by widening the
 * shared contract. When it is absent the caller can supply one, and when
 * neither exists a command with more than one viable set is ambiguous — which
 * is exactly what pwsh does for a function with no `DefaultParameterSetName`.
 */
export function declaredDefaultParameterSet(manifest: CommandManifest): string | null {
  const candidate: unknown = (manifest as { defaultParameterSet?: unknown }).defaultParameterSet;
  return typeof candidate === 'string' && candidate !== '' ? candidate : null;
}
