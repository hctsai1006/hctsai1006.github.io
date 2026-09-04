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
 * Two rules are enforced here rather than trusted:
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
 */

import type { CompatibilityView } from '../commands/invocation.ts';

export type BehaviorValue = boolean | number | string | null;

export interface StoredProfile {
  schemaVersion: number;
  profile: string;
  channel: string;
  displayVersion: string;
  inherits: string | null;
  behaviors: Record<string, BehaviorValue>;
  behaviorDocs?: Record<string, { summary: string; upstreamPr: number | null; breaking: boolean }>;
  commands?: Record<string, { availability?: string; since?: string; notes?: string }>;
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
  readonly commands: Readonly<Record<string, { availability?: string; since?: string; notes?: string }>>;
  readonly supportedUpstream: boolean;
}

export class ProfileResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileResolutionError';
  }
}

/**
 * Resolve a profile against a set of stored profiles keyed by their `profile` id.
 *
 * Merge order is parent-first: a derived profile overrides what it inherits,
 * and a key it does not mention keeps the inherited value. Deliberately a
 * shallow merge per top-level section — behaviours are flat by design, and a
 * deep merge would make it impossible for a derived profile to REMOVE something.
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

  // Apply oldest ancestor first so the most-derived profile wins.
  const behaviors: Record<string, BehaviorValue> = {};
  const commands: Record<string, { availability?: string; since?: string; notes?: string }> = {};
  for (const profile of [...chain].reverse()) {
    Object.assign(behaviors, profile.behaviors);
    Object.assign(commands, profile.commands ?? {});
  }

  const root = chain[0];
  if (root === undefined) throw new ProfileResolutionError('empty profile chain');

  return {
    id: root.profile,
    displayVersion: root.displayVersion,
    channel: root.channel,
    lineage: chain.map((p) => p.profile),
    behaviors,
    commands,
    supportedUpstream: root.supported?.isSupportedUpstream ?? false,
  };
}

/**
 * The narrow view a command sees.
 *
 * `strict` decides what happens when a command asks for a key no profile in the
 * chain declares. In tests and in CI that should throw, because it is almost
 * always a typo in a behaviour key and the alternative is a command silently
 * behaving like an older version forever. At runtime in a browser it degrades
 * to the fallback, because a mistyped flag should not blank the page.
 */
export function compatibilityView(
  resolved: ResolvedProfile,
  options: { strict?: boolean; onUnknownKey?: (key: string) => void } = {},
): CompatibilityView {
  const strict = options.strict ?? false;
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
      const value = resolved.behaviors[key];
      // A declared null means "this profile has no opinion", which is distinct
      // from the key being absent entirely.
      if (value === null) return fallback;
      return value as T;
    },
  };
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
