/**
 * compat-curation.mts — the rules the curated 7.7 change list must satisfy, and
 * the tables derived from it.
 *
 * Split out of generate-compatibility-profile.mts so it can be TESTED. The
 * generator runs `main()` at module load: importing it to reach a gate would
 * regenerate every artifact as a side effect, which is exactly the shape of
 * failure the `--chek` typo produced — a check that repairs what it is meant to
 * be checking. A gate that cannot be exercised against adversarial input is a
 * gate nobody has ever seen fail.
 *
 * Everything here is a pure function of the change list plus a repo root, so a
 * test can hand it a hostile record and watch it refuse.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Change } from '../compat/deltas/powershell-77-changes.source.mts';
import { switchBehaviorKey } from '../src/compatibility/behavior-keys.ts';

/** The namespace `switchBehaviorKey` owns. Nothing may hand-type into it. */
const SWITCH_KEY_PREFIX = 'switchParameter';

/**
 * The engine-wide flag this design replaced, refused by name.
 *
 * Not paranoia: it is the obvious thing to reach for, it reads as a tidier
 * version of ten scoped keys, and reintroducing it silently un-fixes a measured
 * divergence from the reference implementation.
 */
const RETIRED_GLOBAL_SWITCH_KEY = 'switchParameters.honourExplicitFalse';

export type BehaviorValue = boolean | number | string | null;

/**
 * Whether BrowserShell actually reproduces this difference.
 *
 * THIS is the predicate the runtime behaviour table is built on, and its
 * absence was the most fundamental defect in the compatibility layer. The old
 * `buildBehaviorTables` filtered only on `behaviorKey === undefined` and never
 * consulted the implementation status at all, so every documented-but-unemulated
 * change was written into the profile the engine boots against and served to
 * commands as live execution semantics. Measured before the fix: thirteen
 * distinct behaviour keys emitted, thirteen of them unimplemented.
 *
 * A documented change still reaches the explorer — through `documentedBehaviors`
 * and the delta — but it can no longer change a value a command reads.
 */
export function isEmulated(change: Change): boolean {
  return change.implementation === 'implemented' || change.implementation === 'verified';
}

/** The one PR that made the change. Exactly one exists; the gate proves it. */
export function primaryPr(change: Change): number {
  const primary = change.sources.filter((s) => s.role === 'primary');
  const first = primary[0];
  if (first === undefined) {
    throw new Error(`change "${change.title}" has no primary upstream source`);
  }
  return first.pr;
}

/**
 * Every behaviour key a change declares, with the value 7.7 gives it.
 *
 * A `mechanism` expands over `scope.parameters` using the SAME derivation the
 * binder uses, so a record can never name a key no code path computes. A
 * hand-typed `switchParameter.Where-Object.<operator>.honourExplicitFalse` would
 * have sat in the table looking authoritative while being unreachable.
 */
export function keysFor(change: Change): readonly string[] {
  if (change.mechanism === 'switch-explicit-false') {
    if (change.behaviorKey !== undefined) {
      // Found by attacking this file: `keysFor` returned the derived keys and
      // dropped the hand-typed one without a word, so a record could name a key
      // that reached neither the profile nor any lookup while looking declared.
      throw new Error(
        `change "${change.title}" sets both mechanism and behaviorKey ` +
          `("${change.behaviorKey}"). One of them would be silently ignored; say which you mean.`,
      );
    }
    const command = change.scope?.command;
    const parameters = change.scope?.parameters ?? [];
    if (command === undefined || command === null || parameters.length === 0) {
      throw new Error(
        `change "${change.title}" uses the switch-explicit-false mechanism but does not scope ` +
          'a command and at least one parameter, so no key can be derived',
      );
    }
    return parameters.map((parameter) => switchBehaviorKey(command, parameter));
  }
  return change.behaviorKey === undefined ? [] : [change.behaviorKey];
}

/**
 * The 7.6.5 value for a key, derived from the 7.7 value rather than restated.
 *
 * If both were hand-written they could agree by accident, which would make the
 * two profiles identical and quietly turn the entire compatibility layer into a
 * no-op that still looks like it is working.
 */
export function baselineValueFor(change: Change, key: string): BehaviorValue {
  const v = change.upstreamValue;
  if (typeof v === 'boolean') return !v;
  if (key === 'newGuid.defaultVersion') return 4; // was UUID v4
  if (typeof v === 'number') return null;
  return null;
}

export interface DocumentedBehavior {
  summary: string;
  /** What upstream 7.7 does. Recorded whatever we emulate. */
  upstreamValue: BehaviorValue;
  /** What 7.6.5 does, derived from the above. */
  baselineValue: BehaviorValue;
  /** What BrowserShell does about it. Only implemented/verified reach `behaviors`. */
  implementation: Change['implementation'];
  /** True when a command can read this key from `behaviors`. */
  emulated: boolean;
  upstreamPr: number;
  breaking: boolean;
  since: string;
  scope: { command: string | null; parameters: readonly string[] };
}

export interface BehaviorTables {
  /** Runtime values for 7.6.5. EMULATED KEYS ONLY. */
  baseline: Record<string, BehaviorValue>;
  /** Runtime values for 7.7. EMULATED KEYS ONLY. */
  target: Record<string, BehaviorValue>;
  docs: Record<string, { summary: string; upstreamPr: number | null; breaking: boolean; since: string }>;
  /** Every documented key, emulated or not. Read by the explorer, never by a command. */
  documented: Record<string, DocumentedBehavior>;
}

export function buildBehaviorTables(changes: readonly Change[], targetVersion: string): BehaviorTables {
  const baseline: Record<string, BehaviorValue> = {};
  const target: Record<string, BehaviorValue> = {};
  const docs: BehaviorTables['docs'] = {};
  const documented: Record<string, DocumentedBehavior> = {};

  for (const c of changes) {
    const upstream = c.upstreamValue ?? null;
    for (const key of keysFor(c)) {
      const base = baselineValueFor(c, key);

      // One key claimed by two records with different values is a contradiction,
      // not a merge. Reported rather than resolved last-writer-wins.
      const existing = documented[key];
      if (existing !== undefined && existing.upstreamValue !== upstream) {
        throw new Error(
          `behavior "${key}" is given conflicting values (${JSON.stringify(existing.upstreamValue)} and ` +
            `${JSON.stringify(upstream)}) by different changes`,
        );
      }

      documented[key] ??= {
        summary: c.title,
        upstreamValue: upstream,
        baselineValue: base,
        implementation: c.implementation,
        emulated: isEmulated(c),
        upstreamPr: primaryPr(c),
        breaking: c.kind === 'breaking',
        since: targetVersion,
        scope: { command: c.scope?.command ?? null, parameters: c.scope?.parameters ?? [] },
      };

      // The gate this whole file exists for: an unemulated change contributes
      // NOTHING a command can read.
      if (!isEmulated(c)) continue;

      target[key] = upstream;
      baseline[key] = base;
      docs[key] ??= {
        summary: c.title,
        upstreamPr: primaryPr(c),
        breaking: c.kind === 'breaking',
        since: targetVersion,
      };
    }
  }

  return { baseline, target, docs, documented };
}

// ---------------------------------------------------------------------------
// curation gates
// ---------------------------------------------------------------------------

/**
 * Everything the curation must satisfy, as errors rather than warnings.
 *
 * The PR-sharing check used to write to stderr and exit 0. A gate nobody can
 * fail is decoration: the curation it was watching drifted into claiming one
 * CSV PR covered thirteen unrelated cmdlets, and the build stayed green for as
 * long as that was true.
 */
export function assertCurationIsSound(changes: readonly Change[], repoRoot: string): void {
  const problems: string[] = [];
  const where = (c: Change): string => `${c.subject}: ${c.title}`;

  for (const c of changes) {
    if (c.sources.length === 0) {
      problems.push(`${where(c)} — cites no upstream PR`);
    }
    const primaries = c.sources.filter((s) => s.role === 'primary');
    if (primaries.length !== 1) {
      problems.push(
        `${where(c)} — has ${String(primaries.length)} primary sources; exactly one PR made the change`,
      );
    }
    for (const s of c.sources) {
      if (!Number.isInteger(s.pr) || s.pr <= 0) {
        problems.push(`${where(c)} — cites a non-PR "${String(s.pr)}"`);
      }
      if (s.covers.trim().length === 0) {
        problems.push(`${where(c)} — cites #${String(s.pr)} with no record of what it covers`);
      }
    }

    const keys = keysFor(c);

    // A behaviour key with no scope is how one global boolean came to change
    // every switch parameter in the binder. Engine-wide is allowed, but it has
    // to be SAID, not defaulted into.
    if (keys.length > 0 && c.scope === undefined) {
      problems.push(
        `${where(c)} — declares behaviour keys but no scope. State the command, or ` +
          'scope.command: null to claim it is genuinely engine-wide.',
      );
    }

    // A key shaped like a derived one must BE a derived one. Hand-typing
    // `switchParameter.Where-Object.<operator>.honourExplicitFalse` produces a
    // key the binder can never compute: it sits in the table looking
    // authoritative and is unreachable.
    for (const key of keys) {
      if (key.startsWith(`${SWITCH_KEY_PREFIX}.`) && c.mechanism !== 'switch-explicit-false') {
        problems.push(
          `${where(c)} — hand-types "${key}", which is the shape the switch-explicit-false ` +
            'mechanism derives. Set the mechanism and scope the parameters instead.',
        );
      }
      if (key === RETIRED_GLOBAL_SWITCH_KEY) {
        problems.push(
          `${where(c)} — reintroduces "${key}". That engine-wide boolean applied one cmdlet's ` +
            'bug to every switch parameter in the binder, and made the 7.6 profile diverge from ' +
            'the reference on Get-ChildItem -Force:$false. Upstream fixed this per cmdlet.',
        );
      }
    }

    if (isEmulated(c)) {
      const evidence = c.evidence ?? [];
      if (evidence.length === 0) {
        problems.push(
          `${where(c)} — is "${c.implementation}" with no evidence. A status that outruns its ` +
            'proof is the failure this project is organised against.',
        );
      }
      for (const path of evidence) {
        if (!existsSync(join(repoRoot, path))) {
          problems.push(`${where(c)} — cites evidence "${path}", which does not exist`);
        }
      }
      // The proof has to be a test. Pointing at an implementation file alone
      // proves the code exists, which was never in doubt.
      if (evidence.length > 0 && !evidence.some((p) => p.startsWith('tests/'))) {
        problems.push(
          `${where(c)} — is "${c.implementation}" but no evidence path is under tests/. ` +
            'Only a test can prove the engine reproduces a difference.',
        );
      }
      if (keys.length === 0) {
        problems.push(
          `${where(c)} — is "${c.implementation}" but declares no behaviour key, so nothing it ` +
            'claims can reach the engine',
        );
      }

      // "Cite a test" was satisfiable by any test that happened to exist —
      // found by attacking this file with evidence pointing at
      // tests/unit/version.test.mts. A citation has to be ABOUT the thing.
      // Deliberately a substring search rather than anything cleverer: a test
      // that never names the key or the command it is offered as proof of is
      // not proof, and static analysis cannot decide the rest.
      const wanted = [...keys, c.scope?.command ?? ''].filter((w) => w.length > 0);
      const relevant = evidence.some((path) => {
        if (!path.startsWith('tests/')) return false;
        const full = join(repoRoot, path);
        if (!existsSync(full)) return false;
        const text = readFileSync(full, 'utf8');
        return wanted.some((w) => text.includes(w));
      });
      if (evidence.length > 0 && !relevant) {
        problems.push(
          `${where(c)} — no evidence test mentions ${wanted.map((w) => `"${w}"`).join(' or ')}. ` +
            'A test that never names what it is offered as proof of is not proof of it.',
        );
      }
    } else if ((c.evidence ?? []).length > 0) {
      problems.push(
        `${where(c)} — is "${c.implementation}" yet cites evidence. Either it is emulated or it ` +
          'is not; evidence for a change nothing reads is a claim without a consumer.',
      );
    }

    if (c.implementation === 'partial' && (c.partialityNote ?? '').trim().length === 0) {
      problems.push(`${where(c)} — is "partial" without saying what is missing`);
    }

    // THE TOP RUNG COSTS A FIXTURE. src/commands/manifest.ts defines `verified`
    // as "implemented AND compared against a captured reference-implementation
    // run", and adds: "Nothing claims this yet; it exists so that `implemented`
    // cannot quietly come to mean it." Two records claimed it here anyway, on
    // the strength of unit tests whose expected values were transcribed by hand
    // from a pwsh session into a comment — a real measurement that nothing can
    // re-check.
    //
    // Checked in BOTH directions. A fixture named by a record the engine does
    // not emulate would be evidence about the reference implementation alone,
    // which is not what the field means. What this gate cannot see is whether
    // the named case exists and agreed; tools/conformance.mts owns that, because
    // only the run knows.
    if (c.implementation === 'verified' && c.conformanceFixture === undefined) {
      problems.push(
        `${where(c)} — is "verified" but names no conformance case. "verified" means compared against a ` +
          'captured reference-implementation run; name the case, or say "implemented".',
      );
    }
    if (c.conformanceFixture !== undefined && !isEmulated(c)) {
      problems.push(
        `${where(c)} — is "${c.implementation}", so the engine reproduces nothing, yet names conformance ` +
          `case "${c.conformanceFixture}". A case can only prove a difference this project emulates.`,
      );
    }

    if (c.impact === 'script-breaking' && (c.migration ?? '').trim().length === 0) {
      problems.push(`${where(c)} — is script-breaking with no migration guidance`);
    }
  }

  // One PR cannot support two unrelated claims. Two records sharing a PR under
  // DIFFERENT behaviour keys is a curation error until somebody writes down why
  // it is not — which is exactly the situation #26719 was in, cited both for the
  // CSV type-information change and for a claim about thirteen cmdlets.
  const byPr = new Map<number, Change[]>();
  for (const c of changes) {
    for (const s of c.sources) {
      if (s.role === 'docs') continue; // a docs citation is prose, not a claim of authorship
      const list = byPr.get(s.pr) ?? [];
      if (!list.includes(c)) list.push(c);
      byPr.set(s.pr, list);
    }
  }
  for (const [pr, records] of byPr) {
    if (records.length < 2) continue;
    const keySets = new Set(records.map((c) => keysFor(c).join('|') || '(none)'));
    if (keySets.size < 2) continue;
    const unexplained = records.filter((c) => (c.sharedPrRationale ?? '').trim().length === 0);
    if (unexplained.length > 0) {
      problems.push(
        `upstream #${String(pr)} is cited by ${String(records.length)} changes with different behaviour keys ` +
          `(${[...keySets].join(' / ')}). Record a sharedPrRationale on each, or narrow the citation. ` +
          `Missing on: ${unexplained.map((c) => where(c)).join('; ')}`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `the curated 7.7 change list is not sound:\n${problems.map((p) => `    - ${p}`).join('\n')}`,
    );
  }
}

