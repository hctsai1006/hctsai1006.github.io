/**
 * profile-resolver.ts — turn a stored compatibility profile into the view a
 * command reads.
 *
 * A profile on disk is a delta: `powershell/7.7.0-preview.4/linux` declares
 * `inherits: powershell/7.6.5/linux` and states only what differs. That is the
 * whole point — adding a PowerShell version must never mean forking a command —
 * but it means nothing can read a profile file directly. The inheritance chain
 * has to be resolved first, and this is the only place that happens.
 *
 * Rules enforced here rather than trusted:
 *
 *   1. A cycle in `inherits` is a hard error. Left undetected it is an infinite
 *      loop at session start, which presents as a hung page with no message.
 *
 *   2. Reading a behaviour key that no profile declares is an error, not a
 *      silent default. A command asking for `newGiud.defaultVersion` (typo)
 *      would otherwise get the fallback and behave like 7.6 forever, and
 *      nothing would ever say so. The fallback argument exists for keys that
 *      are legitimately absent in older profiles — which is why the resolver
 *      separates "declared nowhere in the chain" from "declared as false".
 *
 *   3. A declared value whose TYPE disagrees with the caller's fallback is an
 *      error. `behavior<T>` used to end in `value as T`, an assertion over data
 *      parsed from a JSON file: a profile with `"newGuid.defaultVersion": "7"`
 *      handed New-Guid a string where it typed a number, and the mismatch
 *      surfaced wherever the value was eventually used, not where it entered.
 *
 *   4. The resolved profile is deep-frozen. Commands receive it on every
 *      invocation; one command mutating a behaviour would silently reconfigure
 *      the session for every command after it.
 *
 * ── MERGE SEMANTICS, AND WHY THEY ARE WHAT THE SCHEMA SAYS ────────────────
 *
 * The schema promised command patches were deep-merged and this file used
 * `Object.assign`, which REPLACES the whole entry. A derived profile setting
 * one field on an inherited command dropped every other field that command had.
 * With the preview profile's commands now carrying `parameterPatches`, that is
 * not hypothetical: the 7.7 entry for a 7.6 command would have erased its
 * `availability: "available"` and made an existing cmdlet look undeclared.
 *
 * Resolved in favour of the schema — deep merge — rather than by changing the
 * schema to promise replacement, for two reasons. It is what the delta-profile
 * design needs: a profile that must restate every field of a command it barely
 * touches is not a delta. And removal does not depend on absence here: the
 * schema expresses it as DATA (`availability: "removed"` with `removedIn`), so
 * deep-merging cannot swallow a deletion the way it would if "gone" were
 * spelled as "missing".
 *
 * `behaviors` and `documentedBehaviors` still replace per key. They are flat
 * scalars; there is nothing inside one to merge. The schema now says exactly
 * this instead of "deep-merge" for everything.
 *
 * ── WHY NOT Object.assign, INDEPENDENT OF MERGING ─────────────────────────
 *
 * `Object.assign(target, parsed)` uses [[Set]]. An own `__proto__` key in a
 * parsed JSON profile therefore invokes the prototype SETTER rather than
 * defining a property: the key vanishes from `Object.keys` while
 * `resolved.behaviors.anything` starts resolving through attacker-supplied
 * data. This repository has fixed that class of bug twice already — the old VFS
 * and `Select-Object` — so it is built with `Object.fromEntries` here, which
 * DEFINES each key (CreateDataPropertyOrThrow) and cannot trigger a setter.
 *
 * `Object.create(null)` would also stop the setter, and it is deliberately not
 * used. The comment in `src/kernel/protocol.ts` records why: `structuredClone`
 * NORMALISES a null prototype back to `Object.prototype`, so the guarantee does
 * not survive a worker boundary — and a resolved profile is exactly the kind of
 * value that gets posted to one. A protection that silently evaporates in
 * transit is worse than none, because the code downstream is written trusting
 * it. `Object.fromEntries` keeps `Object.prototype`, so what survives the clone
 * is what was tested. `Map` was the third option and was rejected because the
 * resolved profile is serialised into diagnostics and compared in tests as a
 * plain object; a Map would have to be converted back at every such boundary,
 * which is where the guarantee would be lost again.
 */

import type { CompatibilityView } from '../commands/invocation.ts';

export type BehaviorValue = boolean | number | string | null;

export interface CommandPatch {
  availability?: string;
  since?: string;
  removedIn?: string;
  notes?: string;
  parameterPatches?: Record<string, Record<string, unknown>>;
}

export interface StoredProfile {
  schemaVersion: number;
  profile: string;
  channel: string;
  displayVersion: string;
  inherits: string | null;
  behaviors: Record<string, BehaviorValue>;
  behaviorDocs?: Record<string, { summary: string; upstreamPr: number | null; breaking: boolean }>;
  /**
   * Every documented upstream difference, emulated or not. Present so the
   * explorer and diagnostics can tell the two facts apart; deliberately NOT
   * reachable through `CompatibilityView`, because a difference we do not
   * emulate must not be able to change what a command does.
   */
  documentedBehaviors?: Record<string, { emulated?: boolean; implementation?: string }>;
  commands?: Record<string, CommandPatch>;
  engineLimits?: { nativePowerShellEngine: false; unimplementedAstNodes?: string[]; notes?: string };
  supported?: { isSupportedUpstream: boolean; endOfSupport: string | null };
}

export interface ResolvedProfile {
  readonly id: string;
  readonly displayVersion: string;
  readonly channel: string;
  /** The chain that produced this, most-derived first. Useful in diagnostics. */
  readonly lineage: readonly string[];
  readonly behaviors: Readonly<Record<string, BehaviorValue>>;
  readonly commands: Readonly<Record<string, CommandPatch>>;
  readonly supportedUpstream: boolean;
}

export class ProfileResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileResolutionError';
  }
}

/**
 * Build a plain object from entries without ever triggering a setter.
 *
 * `Object.fromEntries` defines each property. `__proto__` therefore becomes an
 * ordinary own key instead of reassigning the prototype, and the result still
 * round-trips through `structuredClone` unchanged. See the header note.
 */
function safeObject<T>(entries: Iterable<readonly [string, T]>): Record<string, T> {
  return Object.fromEntries(entries);
}

/** Recursively freeze. Shallow freezing leaves nested patch objects mutable. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    // getOwnPropertyNames rather than Object.values: a property defined as
    // `__proto__` is skipped by neither, but reading it via `value[key]` on a
    // frozen plain object is safe here precisely because it is an own data
    // property, not the accessor.
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/**
 * Merge one command patch over another, parent first.
 *
 * Field-level for the command, then parameter-level for `parameterPatches`, so
 * a child adding a patch to one parameter keeps the parent's patches on the
 * others. Nothing below a parameter merges: those are leaf declarations.
 */
function mergeCommandPatch(parent: CommandPatch, child: CommandPatch): CommandPatch {
  const merged: CommandPatch = { ...parent, ...child };
  const parentParams = parent.parameterPatches;
  const childParams = child.parameterPatches;
  if (parentParams === undefined && childParams === undefined) return merged;

  const names = new Set([...Object.keys(parentParams ?? {}), ...Object.keys(childParams ?? {})]);
  merged.parameterPatches = safeObject(
    [...names].map((name) => {
      const p = parentParams?.[name];
      const c = childParams?.[name];
      return [name, { ...(p ?? {}), ...(c ?? {}) }] as const;
    }),
  );
  return merged;
}

/**
 * Resolve a profile against a set of stored profiles keyed by their `profile` id.
 *
 * Merge order is parent-first: a derived profile overrides what it inherits,
 * and a key it does not mention keeps the inherited value. See the header for
 * which sections replace and which deep-merge, and why.
 */
export function resolveProfile(
  id: string,
  available: ReadonlyMap<string, StoredProfile>,
): ResolvedProfile {
  const chain: StoredProfile[] = [];
  const seen = new Set<string>();

  let current: string | null = id;
  while (current !== null) {
    if (seen.has(current)) {
      throw new ProfileResolutionError(
        `compatibility profile inheritance cycle: ${[...seen, current].join(' -> ')}`,
      );
    }
    seen.add(current);

    const profile = available.get(current);
    if (profile === undefined) {
      throw new ProfileResolutionError(
        `compatibility profile "${current}" was not found` +
          (chain.length > 0 ? ` (inherited by ${chain[chain.length - 1]?.profile ?? '?'})` : ''),
      );
    }
    chain.push(profile);
    current = profile.inherits;
  }

  // Apply oldest ancestor first so the most-derived profile wins. Accumulated in
  // Maps and materialised with fromEntries so no assignment to a parsed key can
  // reach a prototype setter.
  const behaviors = new Map<string, BehaviorValue>();
  const commands = new Map<string, CommandPatch>();
  for (const profile of [...chain].reverse()) {
    for (const [key, value] of Object.entries(profile.behaviors ?? {})) {
      behaviors.set(key, value);
    }
    for (const [name, patch] of Object.entries(profile.commands ?? {})) {
      const parent = commands.get(name);
      commands.set(name, parent === undefined ? { ...patch } : mergeCommandPatch(parent, patch));
    }
  }

  const root = chain[0];
  if (root === undefined) throw new ProfileResolutionError('empty profile chain');

  return deepFreeze({
    id: root.profile,
    displayVersion: root.displayVersion,
    channel: root.channel,
    lineage: Object.freeze(chain.map((p) => p.profile)),
    behaviors: safeObject(behaviors),
    commands: safeObject(commands),
    supportedUpstream: root.supported?.isSupportedUpstream ?? false,
  });
}

/**
 * The narrow view a command sees.
 *
 * `strict` decides what happens when a command asks for a key no profile in the
 * chain declares. In tests and in CI that should throw, because it is almost
 * always a typo in a behaviour key and the alternative is a command silently
 * behaving like an older version forever. At runtime in a browser it degrades
 * to the fallback, because a mistyped flag should not blank the page.
 *
 * A TYPE mismatch throws under both, and is not softened by `strict`. An
 * unknown key is a plausible accident with a safe answer — the fallback, which
 * is the older version's behaviour. A key declared as the wrong type is a
 * corrupt profile, and there is no safe answer to give a caller that has
 * already typed its variable.
 */
export function compatibilityView(
  resolved: ResolvedProfile,
  options: { strict?: boolean; onUnknownKey?: (key: string) => void } = {},
): CompatibilityView {
  const strict = options.strict ?? false;

  const typed = <T extends boolean | number | string>(
    key: string,
    value: BehaviorValue,
    fallback: T,
  ): T => {
    // A declared null means "this profile has no opinion", which is distinct
    // from the key being absent entirely.
    if (value === null) return fallback;
    if (typeof value !== typeof fallback) {
      throw new ProfileResolutionError(
        `behaviour "${key}" is declared as ${typeof value} (${JSON.stringify(value)}) by ` +
          `${resolved.id}, but is read as ${typeof fallback}. The profile and the code that ` +
          'reads it disagree; regenerate the profile rather than casting.',
      );
    }
    return value as T;
  };

  return {
    displayVersion: resolved.displayVersion,

    behavior<T extends boolean | number | string>(key: string, fallback: T): T {
      if (!Object.hasOwn(resolved.behaviors, key)) {
        options.onUnknownKey?.(key);
        if (strict) {
          throw new ProfileResolutionError(
            `behaviour "${key}" is not declared by ${resolved.id} or anything it inherits. ` +
              'Add it to the profile (with a behaviorDocs entry citing its upstream PR) rather than relying on the fallback.',
          );
        }
        return fallback;
      }
      return typed(key, resolved.behaviors[key] ?? null, fallback);
    },

    scopedBehavior<T extends boolean | number | string>(key: string, whenUndeclared: T): T {
      // Absence is the answer, not a mistake: see the interface note. Nothing is
      // reported and `strict` does not apply, because a scoped key is declared
      // only for the command/parameter pairs it applies to and every other pair
      // asking is the normal case.
      if (!Object.hasOwn(resolved.behaviors, key)) return whenUndeclared;
      return typed(key, resolved.behaviors[key] ?? null, whenUndeclared);
    },
  };
}

/**
 * A view over a flat behaviour map, with no inheritance to resolve.
 *
 * For callers that have the behaviours already — a test fixture, a profile file
 * read directly, a kernel booting with none. It exists so those callers stop
 * hand-rolling a `behavior` closure each: every such closure was a second
 * implementation of the lookup, and they had drifted. Several ended in
 * `value as unknown as T`, which is the cast this module now refuses, so the
 * type confusion the resolver guards against could still be constructed in the
 * tests that were supposed to be guarding it.
 */
export function viewOfBehaviors(
  displayVersion: string,
  behaviors: Readonly<Record<string, BehaviorValue>>,
  options: { strict?: boolean; onUnknownKey?: (key: string) => void } = {},
): CompatibilityView {
  return compatibilityView(
    {
      id: `inline/${displayVersion}`,
      displayVersion,
      channel: 'inline',
      lineage: [`inline/${displayVersion}`],
      behaviors,
      commands: {},
      supportedUpstream: false,
    },
    options,
  );
}

/** Build the lookup map `resolveProfile` needs from a list of loaded profiles. */
export function profileMap(profiles: readonly StoredProfile[]): Map<string, StoredProfile> {
  const map = new Map<string, StoredProfile>();
  for (const p of profiles) {
    if (map.has(p.profile)) {
      throw new ProfileResolutionError(`duplicate compatibility profile id: ${p.profile}`);
    }
    map.set(p.profile, p);
  }
  return map;
}
