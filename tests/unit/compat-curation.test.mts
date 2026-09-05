/**
 * compat-curation.test.mts — the gates that decide what may become an
 * execution semantic, exercised against hostile input.
 *
 * WHAT THIS IS FOR
 *
 * The compatibility layer's most fundamental defect was that its own stated
 * rule was unenforced. `powershell-77-changes.source.mts` said `implemented`
 * starts false and the UI must say "documented, not emulated" until a fixture
 * proves otherwise; `buildBehaviorTables` filtered only on
 * `behaviorKey === undefined` and never read the flag. So all thirteen
 * documented-but-unemulated behaviour keys were written into the profile the
 * engine boots against and served to commands as live semantics.
 *
 * Two of the gates below were WARNINGS that exited 0. A gate nobody can fail is
 * decoration, and the curation it was watching had already drifted into citing
 * one CSV pull request as authority for a claim about thirteen unrelated
 * cmdlets. So every rule here is asserted to THROW, and each is fed data
 * designed to slip past it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  assertCurationIsSound,
  buildBehaviorTables,
  isEmulated,
  keysFor,
} from '../../tools/compat-curation.mts';
import type { Change } from '../../compat/deltas/powershell-77-changes.source.mts';
import { POWERSHELL_77_CHANGES } from '../../compat/deltas/powershell-77-changes.source.mts';
import { switchBehaviorKey } from '../../src/compatibility/behavior-keys.ts';

const REPO = join(import.meta.dirname, '..', '..');

/**
 * A minimal record that PASSES every gate. Each test breaks exactly one thing.
 *
 * `drop` removes a property rather than setting it to undefined, because the
 * project compiles with `exactOptionalPropertyTypes` — `{ scope: undefined }`
 * is a different type from a record with no `scope`, and only the latter is
 * what a real author would write.
 */
function sound(over: Partial<Change> = {}, drop: readonly string[] = []): Change {
  const base: Change = {
    kind: 'changed',
    subject: 'Test-Thing',
    subjectKind: 'command',
    title: 'a documented difference',
    impact: 'observable',
    behaviorKey: 'testThing.flag',
    upstreamValue: true,
    scope: { command: 'Test-Thing' },
    sources: [{ pr: 1, role: 'primary', covers: 'the diff' }],
    implementation: 'documented',
  };
  const merged = { ...base, ...over } as Record<string, unknown>;
  for (const key of drop) delete merged[key];
  return merged as unknown as Change;
}

const throwsWith = (pattern: RegExp) => (e: unknown) =>
  e instanceof Error && pattern.test(e.message);

describe('the curation gate refuses what it used to warn about', () => {
  it('accepts the baseline record, so every failure below is the change under test', () => {
    assert.doesNotThrow(() => assertCurationIsSound([sound()], REPO));
  });

  it('rejects one PR cited by two records under different behaviour keys', () => {
    // The real case: #26719 was cited both for the CSV type-information change
    // and for a claim that it corrected thirteen unrelated cmdlets. The
    // generator printed a warning and exited 0 for as long as that was true.
    const a = sound({ subject: 'A', behaviorKey: 'a.flag' });
    const b = sound({ subject: 'B', behaviorKey: 'b.flag' });
    assert.throws(
      () => assertCurationIsSound([a, b], REPO),
      throwsWith(/upstream #1 is cited by 2 changes with different behaviour keys/),
    );
  });

  it('allows it when, and only when, a written rationale is recorded on each', () => {
    const why = 'one upstream change, split for presentation; the PR covers both keys';
    const a = sound({ subject: 'A', behaviorKey: 'a.flag', sharedPrRationale: why });
    const b = sound({ subject: 'B', behaviorKey: 'b.flag', sharedPrRationale: why });
    assert.doesNotThrow(() => assertCurationIsSound([a, b], REPO));

    // A rationale on only one side is not an agreement.
    const half = sound({ subject: 'B', behaviorKey: 'b.flag' });
    assert.throws(() => assertCurationIsSound([a, half], REPO), throwsWith(/Missing on: B/));

    // Whitespace is not a rationale.
    const blank = sound({ subject: 'B', behaviorKey: 'b.flag', sharedPrRationale: '   ' });
    assert.throws(() => assertCurationIsSound([a, blank], REPO), throwsWith(/sharedPrRationale/));
  });

  it('does not fire when two records share a PR AND a key set', () => {
    // Same claim stated twice is a duplication problem, not a citation problem;
    // the conflicting-value check in buildBehaviorTables owns that case.
    const a = sound({ subject: 'A' });
    const b = sound({ subject: 'B' });
    assert.doesNotThrow(() => assertCurationIsSound([a, b], REPO));
  });

  it('treats a docs-role citation as prose, not as a second claim of authorship', () => {
    // A record may cite the changelog alongside the PR without that counting as
    // the PR supporting two behaviours.
    const a = sound({ subject: 'A', behaviorKey: 'a.flag' });
    const b = sound({
      subject: 'B',
      behaviorKey: 'b.flag',
      sources: [
        { pr: 2, role: 'primary', covers: 'the diff' },
        { pr: 1, role: 'docs', covers: 'the changelog also mentions this, unsupported by the diff' },
      ],
    });
    assert.doesNotThrow(() => assertCurationIsSound([a, b], REPO));
  });

  it('requires exactly one primary source', () => {
    assert.throws(
      () => assertCurationIsSound([sound({ sources: [] })], REPO),
      throwsWith(/cites no upstream PR/),
    );
    assert.throws(
      () =>
        assertCurationIsSound(
          [
            sound({
              sources: [
                { pr: 1, role: 'primary', covers: 'x' },
                { pr: 2, role: 'primary', covers: 'y' },
              ],
            }),
          ],
          REPO,
        ),
      throwsWith(/has 2 primary sources/),
    );
  });

  it('refuses a citation with no record of what the PR covers', () => {
    assert.throws(
      () => assertCurationIsSound([sound({ sources: [{ pr: 1, role: 'primary', covers: '  ' }] })], REPO),
      throwsWith(/with no record of what it covers/),
    );
  });

  it('refuses an emulated status without evidence', () => {
    assert.throws(
      () => assertCurationIsSound([sound({ implementation: 'verified' })], REPO),
      throwsWith(/is "verified" with no evidence/),
    );
  });

  it('refuses evidence that does not exist on disk', () => {
    assert.throws(
      () =>
        assertCurationIsSound(
          [sound({ implementation: 'implemented', evidence: ['tests/unit/no-such-file.test.mts'] })],
          REPO,
        ),
      throwsWith(/does not exist/),
    );
  });

  it('refuses evidence that is not a test', () => {
    // Pointing at the implementation proves the code exists, which was never in
    // doubt. Only a test can show the engine reproduces a difference — and this
    // is the gate an author routes around first, by citing the source file they
    // just wrote.
    assert.throws(
      () =>
        assertCurationIsSound(
          [sound({ implementation: 'verified', evidence: ['src/binding/binder.ts'] })],
          REPO,
        ),
      throwsWith(/no evidence path is under tests\//),
    );
  });

  it('refuses evidence attached to something we do not emulate', () => {
    // The reverse smuggling route: leave the status at `documented` so no gate
    // demands proof, but attach evidence so the UI shows a citation.
    assert.throws(
      () =>
        assertCurationIsSound(
          [sound({ evidence: ['tests/unit/compat-curation.test.mts'] })],
          REPO,
        ),
      throwsWith(/yet cites evidence/),
    );
  });

  it('refuses an emulated status that declares no behaviour key', () => {
    assert.throws(
      () =>
        assertCurationIsSound(
          [
            sound(
              {
                implementation: 'implemented',
                evidence: ['tests/unit/compat-curation.test.mts'],
              },
              ['behaviorKey', 'scope'],
            ),
          ],
          REPO,
        ),
      throwsWith(/declares no behaviour key/),
    );
  });

  it('refuses a behaviour key with no declared scope', () => {
    // How one global boolean came to change every switch parameter in the
    // binder. Engine-wide is allowed, but it has to be said.
    assert.throws(
      () => assertCurationIsSound([sound({}, ['scope'])], REPO),
      throwsWith(/declares behaviour keys but no scope/),
    );
    assert.doesNotThrow(() =>
      assertCurationIsSound([sound({ scope: { command: null } })], REPO),
    );
  });

  it('refuses a partial status that does not say what is missing', () => {
    assert.throws(
      () => assertCurationIsSound([sound({ implementation: 'partial' })], REPO),
      throwsWith(/is "partial" without saying what is missing/),
    );
    assert.doesNotThrow(() =>
      assertCurationIsSound(
        [sound({ implementation: 'partial', partialityNote: 'only the binder half' })],
        REPO,
      ),
    );
  });

  it('refuses a script-breaking change with no migration guidance', () => {
    assert.throws(
      () => assertCurationIsSound([sound({ impact: 'script-breaking' })], REPO),
      throwsWith(/script-breaking with no migration guidance/),
    );
  });

  it('refuses a switch-explicit-false record that scopes no parameters', () => {
    assert.throws(
      () =>
        keysFor(
          sound({ mechanism: 'switch-explicit-false', scope: { command: 'X' } }, ['behaviorKey']),
        ),
      throwsWith(/does not scope\s+a command and at least one parameter/),
    );
  });
});

describe('only what is emulated becomes an execution semantic', () => {
  it('keeps a documented change out of the runtime tables and in the record', () => {
    // The defect, reduced to its smallest form.
    const documented = sound({ behaviorKey: 'kept.out', upstreamValue: true });
    const tables = buildBehaviorTables([documented], '7.7.0-preview.4');

    assert.deepEqual(Object.keys(tables.target), [], 'nothing a command can read');
    assert.deepEqual(Object.keys(tables.baseline), []);
    assert.deepEqual(Object.keys(tables.docs), []);
    assert.deepEqual(Object.keys(tables.documented), ['kept.out'], 'but still recorded');
    assert.equal(tables.documented['kept.out']?.emulated, false);
    assert.equal(tables.documented['kept.out']?.upstreamValue, true, 'upstream fact preserved');
    assert.equal(tables.documented['kept.out']?.baselineValue, false, 'derived, not restated');
  });

  it('lets an emulated change through, with the baseline derived from upstream', () => {
    const emulated = sound({
      behaviorKey: 'let.in',
      upstreamValue: true,
      implementation: 'verified',
      evidence: ['tests/unit/compat-curation.test.mts'],
    });
    const tables = buildBehaviorTables([emulated], '7.7.0-preview.4');
    assert.deepEqual(tables.target, { 'let.in': true });
    assert.deepEqual(tables.baseline, { 'let.in': false });
    assert.equal(tables.documented['let.in']?.emulated, true);
  });

  it('expands a switch-explicit-false record into one key per parameter', () => {
    const family = sound(
      {
        subject: 'Split-Path',
        mechanism: 'switch-explicit-false',
        scope: { command: 'Split-Path', parameters: ['Leaf', 'Qualifier'] },
        upstreamValue: true,
      },
      ['behaviorKey'],
    );
    assert.deepEqual(keysFor(family), [
      switchBehaviorKey('Split-Path', 'Leaf'),
      switchBehaviorKey('Split-Path', 'Qualifier'),
    ]);
  });

  it('rejects two records giving one key contradictory values', () => {
    const a = sound({ behaviorKey: 'x', upstreamValue: true });
    const b = sound({ behaviorKey: 'x', upstreamValue: 7 });
    assert.throws(
      () => buildBehaviorTables([a, b], '7.7.0-preview.4'),
      throwsWith(/conflicting values/),
    );
  });
});

describe('the real curated change list', () => {
  const changes = POWERSHELL_77_CHANGES as readonly Change[];

  it('passes every gate', () => {
    assert.doesNotThrow(() => assertCurationIsSound(changes, REPO));
  });

  it('still records the differences it does not emulate', () => {
    // The point of the split: recording MORE than we implement is the honest
    // state, and the count must not quietly collapse to what we implement.
    const documented = changes.filter((c) => !isEmulated(c));
    assert.ok(documented.length > 10, 'most 7.7 differences are recorded, not reproduced');
    for (const c of documented) {
      assert.deepEqual(c.evidence ?? [], [], 'nothing unemulated may carry proof');
    }
  });

  it('cites a separate PR per cmdlet for the explicit-:$false family', () => {
    // The claim that replaced "thirteen cmdlets, one PR". Each record names one
    // cmdlet and cites the PR that fixed it.
    const family = changes.filter((c) => c.mechanism === 'switch-explicit-false');
    assert.equal(family.length, 9, 'nine per-cmdlet records; the CSV one is its own change');
    const prs = new Set(family.map((c) => c.sources.find((s) => s.role === 'primary')?.pr));
    assert.equal(prs.size, family.length, 'one PR each, never one PR for all of them');
    for (const c of family) {
      assert.ok((c.scope?.parameters ?? []).length > 0, `${c.subject} must name its parameters`);
      assert.notEqual(c.scope?.command, null, `${c.subject} is not an engine-wide change`);
    }
  });

  it('never cites #26719 for anything but the CSV cmdlets', () => {
    // Measured refutation: in 7.6.5 the only switches Import-Csv and
    // ConvertFrom-Csv declare are UseCulture, Verbose and Debug, so the
    // changelog's claim that #26719 fixed their switch handling cannot be true.
    // The PR's diff touches CsvCommands.cs, its resx, and the ConvertTo-Csv and
    // Export-Csv tests — nothing else.
    const citing = changes.filter((c) =>
      c.sources.some((s) => s.pr === 26719 && s.role !== 'docs'),
    );
    assert.equal(citing.length, 1);
    assert.equal(citing[0]?.subject, 'ConvertTo-Csv, Export-Csv');
  });
});
