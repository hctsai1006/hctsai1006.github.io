/**
 * behavior-keys.ts — the key shapes the profile system and the engine must
 * agree on, in the one place both can import.
 *
 * A behaviour key is a contract between a generator that writes it into a
 * profile and a code path that looks it up. When each end spells the key
 * itself, the contract holds only by coincidence, and it fails silently: the
 * generator emits `switchParameter.Where-Object.Not.honourExplicitFalse`, the
 * binder asks for something a character different, the lookup misses, the
 * fallback answers, and the profile looks populated while changing nothing.
 * There is no error to see, because "key absent" is a legitimate state.
 *
 * So the derivation lives here and both ends call it. This module deliberately
 * has no imports: it is shared by `src/binding/binder.ts` (shipped) and
 * `tools/generate-compatibility-profile.mts` (build-time), and a dependency
 * would drag one side's world into the other's.
 */

/**
 * The key asking whether one cmdlet's one switch parameter honours `:$false`.
 *
 * Scoped to a command AND a parameter because upstream fixed it that way. Ten
 * PowerShell 7.7 PRs each corrected NAMED switches on ONE cmdlet — #26140 is
 * `-Empty` on New-Guid; #26474 is `-Qualifier`, `-NoQualifier`, `-Leaf` and
 * `-IsAbsolute` on Split-Path — so 7.7 still has the old behaviour for every
 * switch none of them touched. The engine-wide boolean this replaced could not
 * express that, and applied one cmdlet's bug to every switch in the binder.
 *
 * `command` is the manifest's display name (`New-Guid`) and `parameter` its
 * canonical name (`Empty`); both are already canonical at every call site, and
 * JSON keys are case-sensitive, so neither is re-cased here.
 */
export function switchBehaviorKey(command: string, parameter: string): string {
  return `switchParameter.${command}.${parameter}.honourExplicitFalse`;
}
