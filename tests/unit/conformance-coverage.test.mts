/**
 * conformance-coverage.test.mts — the rules a coverage number has to obey.
 *
 * A percentage is the easiest thing in this repository to fake. "87% conformant"
 * computed over a corpus chosen to make it 87% is worse than no number at all,
 * because people believe it — and the ways to fake one are cheap and quiet:
 * delete the case that was failing, point a claim at a case that does not exist,
 * shrink the denominator until the fraction improves.
 *
 * So the two functions the number is computed by are pure, and this file attacks
 * them directly instead of asserting today's figures. Asserting the figures
 * would only prove they had not changed; what has to be true is that they cannot
 * move in the wrong direction, whatever the inputs.
 *
 * The properties, one test each:
 *
 *   the denominator never reads the evidence
 *   the numerator is monotone in the evidence — less evidence never means more
 *   a capture of the wrong version awards nothing
 *   a command nothing can invoke is never promoted, and never leaves the count
 *   naming a case that is missing, or that failed, is a build failure
 *
 * The last one is what makes deleting a fixture case a loud act rather than a
 * quiet improvement.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyDeltaProof,
  classifyProfileCoverage,
  type CaseEvidence,
  type CoverageCommand,
  type ProfileCoverageInput,
} from '../../tools/conformance.mts';

// ---------------------------------------------------------------------------
// fixtures for the pure functions -- deliberately synthetic, so a change to the
// real corpus cannot make a rule here vacuous without the test noticing
// ---------------------------------------------------------------------------

const COMMANDS: readonly CoverageCommand[] = [
  { name: 'get-date', declared: 'implemented', runnable: true },
  { name: 'get-random', declared: 'implemented', runnable: true },
  { name: 'sort-object', declared: 'implemented', runnable: true },
  // Held back from the session registry: a visitor cannot type it.
  { name: 'where-object', declared: 'partial', runnable: false },
  { name: 'test-connection', declared: 'declared', runnable: false },
];

const base = (over: Partial<ProfileCoverageInput> = {}): ProfileCoverageInput => ({
  profile: 'powershell/7.6.5/linux',
  displayVersion: '7.6.5',
  emulatedBehaviorKeys: ['newGuid.defaultVersion', 'format.property.rejectNullOrEmpty'],
  comparedAgainstVersion: '7.6.5',
  commands: COMMANDS,
  behaviourallyEvidenced: new Set(['get-date', 'get-random']),
  provenBehaviorKeys: new Set(['newGuid.defaultVersion']),
  ...over,
});

describe('classifyProfileCoverage', () => {
  it('counts every declared command, and says what the denominator is', () => {
    const c = classifyProfileCoverage(base());
    assert.equal(c.commands.population, COMMANDS.length);
    assert.equal(c.behaviors.population, 2);
    // A number without a stated population is a claim. Both halves carry one,
    // and it has to actually say something.
    assert.ok(c.commands.populationIs.length > 40, c.commands.populationIs);
    assert.ok(c.behaviors.populationIs.length > 40, c.behaviors.populationIs);
  });

  it('never lets the evidence touch the denominator', () => {
    // The attack: delete the fixture cases behind every credit and watch the
    // fraction improve because the bottom shrank with the top. It must not.
    const full = classifyProfileCoverage(base());
    const stripped = classifyProfileCoverage(
      base({ behaviourallyEvidenced: new Set<string>(), provenBehaviorKeys: new Set<string>() }),
    );
    assert.equal(stripped.commands.population, full.commands.population);
    assert.equal(stripped.behaviors.population, full.behaviors.population);
    assert.equal(stripped.commands.byLevel.verified, 0);
    assert.equal(stripped.behaviors.proven, 0);
    assert.ok(
      stripped.commands.verifiedPercent < full.commands.verifiedPercent,
      'removing every credit did not lower the percentage',
    );
    assert.ok(stripped.behaviors.provenPercent < full.behaviors.provenPercent);
  });

  it('is monotone: removing one credit lowers the count by one, never raises it', () => {
    const full = classifyProfileCoverage(base());
    for (const dropped of ['get-date', 'get-random']) {
      const less = new Set([...base().behaviourallyEvidenced].filter((n) => n !== dropped));
      const after = classifyProfileCoverage(base({ behaviourallyEvidenced: less }));
      assert.equal(
        after.commands.byLevel.verified,
        full.commands.byLevel.verified - 1,
        `dropping ${dropped} did not cost exactly one verified command`,
      );
      assert.ok(after.commands.verifiedPercent < full.commands.verifiedPercent);
    }
  });

  it('awards nothing from a capture of a different version, however much evidence there is', () => {
    // The per-profile part, and the reason it exists. There is one fixture and
    // it is a recording of 7.6.5; asked about 7.7.0-preview.4 the honest answer
    // is zero. Handing this the SAME evidence sets must not move it.
    const other = classifyProfileCoverage(
      base({ profile: 'powershell/7.7.0-preview.4/linux', displayVersion: '7.7.0-preview.4' }),
    );
    assert.equal(other.fixture.applies, false);
    assert.equal(other.commands.byLevel.verified, 0);
    assert.equal(other.commands.verifiedPercent, 0);
    assert.equal(other.behaviors.proven, 0);
    assert.equal(other.behaviors.unproven.length, other.behaviors.population);
    // ...and the population is untouched, so the zero reads as "nothing has been
    // checked" rather than "there was nothing to check".
    assert.equal(other.commands.population, COMMANDS.length);
    assert.match(other.fixture.reason, /no fixture was captured from PowerShell 7\.7\.0-preview\.4/);
  });

  it('says so when nothing was compared at all', () => {
    const none = classifyProfileCoverage(base({ comparedAgainstVersion: null }));
    assert.equal(none.fixture.applies, false);
    assert.equal(none.commands.byLevel.verified, 0);
    assert.match(none.fixture.reason, /nothing was compared/);
  });

  it('never promotes a command nothing can invoke, and never drops it either', () => {
    // where-object holds fifteen behavioural cases in the real corpus and is
    // held back from the session registry. Counting it would make the headline
    // number describe a command a visitor cannot type; dropping it from the
    // denominator would shrink the population to flatter the fraction. Neither.
    const c = classifyProfileCoverage(
      base({ behaviourallyEvidenced: new Set(['get-date', 'get-random', 'where-object']) }),
    );
    assert.equal(c.commands.byLevel.verified, 2, 'an unreachable command was promoted');
    assert.equal(c.commands.byLevel.partial, 1, 'an unreachable command left the population');
    assert.equal(c.commands.population, COMMANDS.length);
  });

  it('cannot promote a command that was never implemented in the first place', () => {
    // Evidence that a `declared` or `partial` command agrees about one
    // behaviour does not make it whole, and `verified` means the whole thing.
    const c = classifyProfileCoverage(
      base({
        commands: [{ name: 'test-connection', declared: 'declared', runnable: true }],
        behaviourallyEvidenced: new Set(['test-connection']),
      }),
    );
    assert.equal(c.commands.byLevel.verified, 0);
    assert.equal(c.commands.byLevel.declared, 1);
  });

  it('refuses a `verified` that a manifest simply declares', () => {
    // The relabel attack one level up. Crediting only established connections
    // closed "rename the command a case is labelled with"; this closes "rename
    // the command's own status", which would otherwise buy the top rung for a
    // one-word edit. src/commands/manifest.ts reserves `verified` for
    // "compared against a captured reference-implementation run", and this is
    // the thing that holds it to that.
    const c = classifyProfileCoverage(
      base({
        commands: [
          { name: 'whoami', declared: 'verified', runnable: true },
          { name: 'get-date', declared: 'verified', runnable: true },
        ],
        behaviourallyEvidenced: new Set(['get-date']),
      }),
    );
    assert.equal(c.commands.byLevel.verified, 1, 'a declared verified was counted without evidence');
    assert.equal(c.commands.byLevel.implemented, 1, 'the unearned claim was not capped at implemented');
    assert.deepEqual(c.commands.unearnedVerified, ['whoami']);
  });

  it('does not accuse a manifest of an unearned claim under a profile it cannot adjudicate', () => {
    // Under a profile nothing was captured from, "verified" is neither
    // confirmed nor refuted, so reporting it as unearned there would turn one
    // missing PowerShell install into a list of accusations about every command.
    const c = classifyProfileCoverage(
      base({
        displayVersion: '7.7.0-preview.4',
        commands: [{ name: 'whoami', declared: 'verified', runnable: true }],
      }),
    );
    assert.deepEqual(c.commands.unearnedVerified, []);
    assert.equal(c.commands.byLevel.verified, 0);
    assert.equal(c.commands.byLevel.implemented, 1);
  });

  it('reports 0% rather than NaN for an empty population', () => {
    const c = classifyProfileCoverage(base({ commands: [], emulatedBehaviorKeys: [] }));
    assert.equal(c.commands.verifiedPercent, 0);
    assert.equal(c.behaviors.provenPercent, 0);
  });

  it('names the behaviour keys nothing proves, so a zero cannot read as an absence of work', () => {
    const c = classifyProfileCoverage(base());
    assert.deepEqual(c.behaviors.unproven, ['format.property.rejectNullOrEmpty']);
    assert.equal(c.behaviors.proven, 1);
  });

  it('every rung of the ladder accounts for exactly one command', () => {
    const c = classifyProfileCoverage(base());
    const total =
      c.commands.byLevel.declared +
      c.commands.byLevel.partial +
      c.commands.byLevel.implemented +
      c.commands.byLevel.verified;
    assert.equal(total, c.commands.population, 'the ladder loses or duplicates commands');
  });
});

// ---------------------------------------------------------------------------
// what a fixture proves about a recorded version difference
// ---------------------------------------------------------------------------

const CASES = new Map<string, CaseEvidence>([
  // Credited to get-random, and agreed. The stand-in for a real proof.
  ['random.maximum-is-exclusive-pair', { outcome: 'match', credits: 'get-random', command: 'get-random' }],
  // Agreed, but about something else entirely. The forgery this rule closes.
  ['date.ticks-are-int64', { outcome: 'match', credits: 'get-date', command: 'get-date' }],
  // Agreed, and about the engine rather than any cmdlet.
  ['type.int-literal', { outcome: 'match', credits: null, command: null }],
  // Labelled get-random, but the credit was never established -- documentation.
  ['label.only', { outcome: 'match', credits: null, command: 'get-random' }],
  ['type.null-has-no-type', { outcome: 'unimplemented', credits: null, command: null }],
  ['made.up.difference', { outcome: 'difference', credits: 'get-random', command: 'get-random' }],
  ['made.up.error', { outcome: 'error', credits: 'get-random', command: 'get-random' }],
]);

const change = (over: Partial<Parameters<typeof classifyDeltaProof>[0]> = {}): Parameters<
  typeof classifyDeltaProof
>[0] => ({
  where: "compat/deltas/x.json: 'Get-Random'",
  emulated: true,
  implementation: 'implemented',
  conformanceFixture: null,
  behaviorKeys: ['switchParameter.Get-Random.Shuffle.honourExplicitFalse'],
  scope: { declared: 'Get-Random', commands: ['get-random'], engineWide: false },
  ...over,
});

describe('classifyDeltaProof', () => {
  it('is not proven, and not a failure, when no case is named', () => {
    // The state of all 22 entries today. It must report honestly without going
    // red, or the only way to a green build is to claim a proof.
    const v = classifyDeltaProof(change(), CASES);
    assert.equal(v.proven, false);
    assert.equal(v.problem, null);
  });

  it('fails the build when "verified" names nothing', () => {
    // src/commands/manifest.ts defines verified as "compared against a captured
    // reference-implementation run". Two entries claimed it on the strength of
    // unit tests whose expected values were transcribed by hand into a comment.
    const v = classifyDeltaProof(change({ implementation: 'verified' }), CASES);
    assert.equal(v.proven, false);
    assert.match(String(v.problem), /is "verified" but names no conformance case/);
  });

  it('proves it when the named case ran, agreed, and is credited to the right command', () => {
    const v = classifyDeltaProof(
      change({ conformanceFixture: 'random.maximum-is-exclusive-pair' }),
      CASES,
    );
    assert.equal(v.proven, true);
    assert.equal(v.problem, null);
  });

  it('fails the build when the named case is gone', () => {
    // THE property this design exists for: deleting the case that proved an
    // entry cannot be a quiet improvement. It turns the entry into a failure.
    const v = classifyDeltaProof(change({ conformanceFixture: 'case.that.was.deleted' }), CASES);
    assert.equal(v.proven, false);
    assert.match(String(v.problem), /which is not in the corpus/);
  });

  for (const [id, outcome] of [
    ['made.up.difference', 'difference'],
    ['type.null-has-no-type', 'unimplemented'],
    ['made.up.error', 'error'],
  ] as const) {
    it(`fails the build when the named case is '${outcome}'`, () => {
      // Pointing at a case that did not agree is worse than pointing at
      // nothing, because it reads as proof. Including 'unimplemented': a case
      // the project has nothing to answer with proves the least of all.
      const v = classifyDeltaProof(change({ conformanceFixture: id }), CASES);
      assert.equal(v.proven, false);
      assert.match(String(v.problem), new RegExp(`which is '${outcome}'`));
    });
  }

  it('refuses a proof for a difference the engine does not reproduce', () => {
    const v = classifyDeltaProof(
      change({
        emulated: false,
        implementation: 'documented',
        conformanceFixture: 'random.maximum-is-exclusive-pair',
      }),
      CASES,
    );
    assert.equal(v.proven, false);
    assert.match(String(v.problem), /can only prove a difference this project emulates/);
  });

  it('refuses a passing case about something else', () => {
    // Found by attacking the first version of this function: pointing the
    // New-Guid UUID-version change at `date.ticks-are-int64` — a case that
    // passes, and has nothing to do with it — took the proven count from 0 to 1
    // with every gate green. Green is not relevant.
    const v = classifyDeltaProof(change({ conformanceFixture: 'date.ticks-are-int64' }), CASES);
    assert.equal(v.proven, false);
    assert.match(String(v.problem), /credits 'get-date'/);
  });

  it('refuses a case whose own credit was never established', () => {
    // A corpus LABEL is documentation; creditFor decides what a case may be
    // evidence for. A proof must rest on the credit, or relabelling a case
    // would be enough to manufacture one.
    const v = classifyDeltaProof(change({ conformanceFixture: 'label.only' }), CASES);
    assert.equal(v.proven, false);
    assert.match(String(v.problem), /credits nothing/);
  });

  it('refuses a case about the engine as proof of a command-scoped change', () => {
    const v = classifyDeltaProof(change({ conformanceFixture: 'type.int-literal' }), CASES);
    assert.equal(v.proven, false);
    assert.match(String(v.problem), /credits nothing/);
  });

  it('accepts an engine-level case for an engine-wide change, and only that', () => {
    // The weaker half of the relevance rule, and it is weaker on purpose: an
    // engine-wide change has no command for a case to be credited to. What it
    // still rules out is proving an engine-wide claim with a cmdlet's case.
    const engineWide = { declared: null, commands: [], engineWide: true } as const;
    const ok = classifyDeltaProof(
      change({ scope: engineWide, conformanceFixture: 'type.int-literal' }),
      CASES,
    );
    assert.equal(ok.proven, true);

    const bad = classifyDeltaProof(
      change({ scope: engineWide, conformanceFixture: 'random.maximum-is-exclusive-pair' }),
      CASES,
    );
    assert.equal(bad.proven, false);
    assert.match(String(bad.problem), /A case scoped to one command cannot be evidence/);
  });

  it('refuses any proof for a change scoped to a command this project does not have', () => {
    // Get-SecureRandom, Get-TimeZone, Test-Connection and the rest: upstream
    // fixed them, nothing here implements them, so no case can be about them.
    const v = classifyDeltaProof(
      change({
        scope: { declared: 'Get-SecureRandom', commands: [], engineWide: false },
        conformanceFixture: 'random.maximum-is-exclusive-pair',
      }),
      CASES,
    );
    assert.equal(v.proven, false);
    assert.match(String(v.problem), /which manifests\.json does not\s+declare/);
  });
});
