/**
 * patches.ts — applying a profile's `parameterPatches` OVER captured metadata,
 * instead of forking a command per version.
 *
 * ── THE PROBLEM THIS SOLVES ───────────────────────────────────────────────
 *
 * `manifests.json` is captured from ONE pwsh — 7.6.5 — and carries 85 commands
 * and 341 parameters. PowerShell 7.7 adds parameters, removes parameters, and
 * changes validation attributes on parameters that already exist. Without a
 * patch mechanism there are exactly two options, and both are bad: capture a
 * second full manifest set per version (and then have two sources of truth for
 * every unchanged parameter), or fork the command.
 *
 * The delta-profile design already rejected both for COMMANDS —
 * `profile-resolver.ts`'s header says "adding a PowerShell version must never
 * mean forking a command" — and `compat/schemas/compatibility-profile.schema.json`
 * has carried the per-parameter shape for a while:
 *
 *     commands.<Name>.parameterPatches.<Parameter> =
 *       { added?, removed?, validation?, switchSemantics?, defaultValue?, notes? }
 *
 * ── WHAT WAS ACTUALLY BUILT BEFORE THIS FILE ──────────────────────────────
 *
 * The schema, the `CommandPatch.parameterPatches` type, the resolver's
 * per-parameter deep merge, and a resolver test proving the merge. All real.
 * What did not exist was anything that APPLIED a patch to a manifest — the data
 * could be declared, merged and read, and then nothing consumed it. Neither
 * shipped profile declares one, so nothing was visibly broken; the mechanism was
 * simply inert.
 *
 * ── WHY IT LIVES IN THE BINDER AND NOT IN `CompatibilityView` ─────────────
 *
 * `invocation.ts` says the view is "deliberately narrow. A command should ask
 * 'is this behaviour on?', never 'which version am I?'". A parameter patch is
 * not something a command body should ever read — it changes what BINDING
 * accepts, which is the binder's job and nobody else's. So it arrives through
 * `BindOptions` and no command can see it.
 *
 * ── THE CONFLICT GATE, WHICH IS THE POINT ─────────────────────────────────
 *
 * Switch semantics can now be spelled TWO ways:
 *
 *     behaviors["switchParameter.Get-Random.Shuffle.honourExplicitFalse"]: true
 *     commands["Get-Random"].parameterPatches.Shuffle.switchSemantics: "boolean-value"
 *
 * That is one fact with two spellings, which is the exact defect shape this
 * repository has now found seven times — value-to-string (three copies), cell
 * width, three date engines, two command-resolution orders, nine tokenizers.
 * Every previous instance drifted silently and produced a wrong answer nothing
 * caught.
 *
 * So it is not allowed to drift here: `switchHonoursExplicitFalse` is the ONE
 * function that decides, it reads both spellings, and it THROWS when they
 * disagree rather than picking a winner. A profile that says both things is
 * corrupt in the same way a profile with a type mismatch is corrupt, and
 * `profile-resolver.ts` already refuses that rather than casting.
 */

import type { CommandManifest, ParameterMetadata } from '../commands/manifest.ts';
import type { CompatibilityView } from '../commands/invocation.ts';
import { switchBehaviorKey } from '../compatibility/behavior-keys.ts';

/**
 * One parameter's patch, as `compatibility-profile.schema.json` declares it.
 *
 * Structurally typed against the schema rather than imported from the resolver,
 * because the resolver types `parameterPatches` as
 * `Record<string, Record<string, unknown>>` — deliberately loose, since it only
 * merges them. This is where they are finally read, so this is where they get a
 * shape.
 */
export interface ParameterPatch {
  /** This version HAS the parameter. Informational when the base already does. */
  readonly added?: boolean;
  /** This version does NOT have it. Binding it must fail. */
  readonly removed?: boolean;
  /** Replaces the captured validation attributes wholesale. */
  readonly validation?: readonly string[];
  /**
   * `presence` reproduces the pre-fix behaviour — `-X:$false` behaves as `-X`.
   * `boolean-value` is what the binder does by default and what pwsh's own
   * binder has always done.
   */
  readonly switchSemantics?: 'presence' | 'boolean-value';
  readonly defaultValue?: unknown;
  readonly notes?: string;
}

export type ParameterPatchSet = Readonly<Record<string, ParameterPatch>>;

export class ParameterPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParameterPatchError';
  }
}

/** What a patch application did, so a diagnostic can say it rather than guess. */
export interface PatchReport {
  readonly manifest: CommandManifest;
  /** `Parameter:what` for each patch that changed something. */
  readonly applied: readonly string[];
  /**
   * Patches that could not be honoured, with the reason.
   *
   * A patch naming a parameter the captured metadata does not have cannot be
   * invented — there is no type, no parameter sets and no position to give it —
   * so it is REPORTED rather than dropped. Silently ignoring it is how a
   * profile comes to look like it is doing something it is not.
   */
  readonly unapplied: readonly string[];
}

/** Case-insensitive lookup, because PowerShell parameter names are. */
function findPatch(patches: ParameterPatchSet, name: string): ParameterPatch | undefined {
  const exact = patches[name];
  if (exact !== undefined) return exact;
  const lowered = name.toLowerCase();
  for (const [key, value] of Object.entries(patches)) {
    if (key.toLowerCase() === lowered) return value;
  }
  return undefined;
}

/**
 * Apply a profile's parameter patches to a captured manifest.
 *
 * Pure: returns a new manifest and never mutates the argument. The manifests
 * are module-level constants shared by every invocation, and one patched
 * manifest leaking back into them would reconfigure the session — the same
 * hazard `profile-resolver.ts` deep-freezes against.
 */
export function applyParameterPatches(
  manifest: CommandManifest,
  patches: ParameterPatchSet | undefined,
): PatchReport {
  if (patches === undefined || Object.keys(patches).length === 0) {
    return { manifest, applied: [], unapplied: [] };
  }

  const applied: string[] = [];
  const unapplied: string[] = [];
  const seen = new Set<string>();

  const parameters: ParameterMetadata[] = [];
  for (const parameter of manifest.parameters) {
    const patch = findPatch(patches, parameter.name);
    if (patch === undefined) {
      parameters.push(parameter);
      continue;
    }
    seen.add(parameter.name.toLowerCase());

    if (patch.removed === true) {
      applied.push(`${parameter.name}:removed`);
      continue;
    }

    let next = parameter;
    if (patch.validation !== undefined) {
      next = { ...next, validation: [...patch.validation] };
      applied.push(`${parameter.name}:validation`);
    }
    // `switchSemantics` deliberately changes NOTHING here. It is read by
    // `switchHonoursExplicitFalse` at bind time, next to the behaviour key it
    // has to agree with — putting it on the manifest would give the conflict
    // gate two places to look and defeat its purpose.
    if (patch.switchSemantics !== undefined && !parameter.isSwitch) {
      unapplied.push(
        `${parameter.name}: switchSemantics declared for a parameter that is not a switch`,
      );
    }
    parameters.push(next);
  }

  for (const [name, patch] of Object.entries(patches)) {
    if (seen.has(name.toLowerCase())) continue;
    if (patch.removed === true) {
      // Removing something the base never had is a no-op, and saying so is
      // more useful than silence: it usually means a stale patch.
      unapplied.push(`${name}: removed, but the captured metadata has no such parameter`);
      continue;
    }
    unapplied.push(
      `${name}: ${patch.added === true ? 'added' : 'patched'}, but the captured metadata has no ` +
        'such parameter and this project does not invent parameter metadata. Re-capture the ' +
        'manifests from a pwsh that has it: npm run capture:metadata',
    );
  }

  return { manifest: { ...manifest, parameters }, applied, unapplied };
}

/**
 * Does THIS command's THIS switch honour an explicit `:$false`?
 *
 * The ONE decision, reading both spellings, refusing a disagreement.
 *
 * Default TRUE when neither is declared, and that default is measured rather
 * than chosen: pwsh 7.6.5's binder already binds `-Force:$false` to a
 * SwitchParameter whose value is False, with ContainsKey true. The ten upstream
 * 7.7 PRs each fixed a named switch on ONE cmdlet, in the COMMAND BODY, so a
 * pair no profile mentions behaves the same in both lines.
 */
export function switchHonoursExplicitFalse(
  manifest: CommandManifest,
  parameter: ParameterMetadata,
  profile: CompatibilityView,
  patches: ParameterPatchSet | undefined,
): boolean {
  const key = switchBehaviorKey(manifest.display, parameter.name);
  const fromBehaviour = profile.scopedBehavior<boolean>(key, true);

  const patch = patches === undefined ? undefined : findPatch(patches, parameter.name);
  const semantics = patch?.switchSemantics;
  if (semantics === undefined) return fromBehaviour;

  const fromPatch = semantics === 'boolean-value';

  // Is the behaviour key DECLARED, as opposed to answering from the fallback?
  // `scopedBehavior` reports absence by returning the fallback, so asking twice
  // with opposite fallbacks separates the two: a declared key gives the same
  // answer both times, an absent one echoes whatever it was handed.
  //
  // Written the other way round first — `!==` — which reads as "the answers
  // differ, so something is declared" and is exactly backwards.
  // Explicitly `<boolean>`: without it the generic infers the literal types
  // `true` and `false`, and the comparison becomes a compile error rather than a
  // question about the profile.
  const behaviourDeclared =
    profile.scopedBehavior<boolean>(key, true) === profile.scopedBehavior<boolean>(key, false);
  if (behaviourDeclared && fromBehaviour !== fromPatch) {
    throw new ParameterPatchError(
      `the compatibility profile declares switch semantics for ${manifest.display} ` +
        `-${parameter.name} twice and they disagree: "${key}" is ${String(fromBehaviour)}, while ` +
        `commands.${manifest.display}.parameterPatches.${parameter.name}.switchSemantics is ` +
        `"${semantics}". One fact, two spellings — fix the profile rather than choosing a ` +
        'winner here, because whichever this picked would be right by accident.',
    );
  }
  return fromPatch;
}
