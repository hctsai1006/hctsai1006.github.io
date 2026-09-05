/**
 * The conformance harness, wired into the ordinary test gate.
 *
 * tools/conformance.mts is a CLI, and a CLI that nobody runs proves nothing.
 * This makes the comparison part of `npm test`, so a change to the object model
 * that disagrees with the recorded pwsh 7.6.5 behaviour fails the suite rather
 * than waiting for someone to remember the tool exists.
 *
 * It does NOT need pwsh: it compares against the committed fixture. Capturing a
 * new fixture is a separate, deliberate act that requires a real PowerShell.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runConformance } from '../../tools/conformance.mts';

const report = runConformance();

describe('differential conformance against pwsh 7.6.5', () => {
  it('has no unexplained problems', () => {
    // The message is the report itself: a failure here should say which case
    // diverged, not just that something did.
    assert.deepEqual(report.problems, [], `\n  ${report.problems.join('\n  ')}\n`);
  });

  it('compared against a fixture from the version the corpus targets', () => {
    assert.equal(report.engine['psVersion'], '7.6.5');
    assert.equal(report.engine['psEdition'], 'Core');
    assert.equal(report.capture['pinnedCulture'], 'en-US');
    // Rendering must have been pinned, or the fixture could contain ANSI escapes
    // that happen to match today and not tomorrow.
    assert.equal(report.capture['outputRendering'], 'PlainText');
    // The corpus's help.* cases model the help PowerShell SYNTHESISES from a
    // cmdlet's own metadata. On a host where someone has run Update-Help,
    // Get-Help returns MamlCommandHelpInfo out of a downloaded XML file
    // instead, and those cases would record a different answer and blame the
    // project for the difference. That happened: this repository's Windows host
    // was Update-Help'd on 2026-09-05 and a recapture there turned three
    // passing cases into unexplained differences. It is a property of the
    // capture host, so it is pinned here next to the culture and the rendering
    // rather than discovered again.
    assert.equal(
      report.capture['updatableHelp'],
      'not-installed',
      'the fixture was captured on a host with updatable help installed; the help.* cases do not mean what they say there',
    );
  });

  it('actually compared something', () => {
    // Guards the failure mode this repo cares most about: a check that reports
    // success because it never ran. If every case became unimplemented, the
    // problems list would still be empty and coverage would still be a number.
    assert.ok(report.totals.compared >= 60, `only ${report.totals.compared} cases were compared`);
    assert.ok(report.totals.matched >= 60, `only ${report.totals.matched} cases matched`);
    assert.ok(
      report.coverage.commandsWithBehaviouralEvidence >= 7,
      `behavioural evidence for only ${report.coverage.commandsWithBehaviouralEvidence} commands`,
    );
  });

  it('counts coverage from established credits, never from the corpus label', () => {
    // The attack this closes: relabelling the `command` field of 28 already
    // passing cases moved behaviouralCoveragePercent from 50 to 100 with
    // problems: 0 and every gate green. Coverage is now computed from
    // `credits`, which a case only gets when the credit can be established
    // mechanically -- so a label alone must never be able to put a command in
    // the covered set.
    const credited = new Set(
      report.cases
        .filter((c) => c.outcome === 'match' && c.area !== 'metadata' && c.credits !== null)
        .map((c) => c.credits),
    );
    assert.equal(
      report.coverage.commandsWithBehaviouralEvidence,
      report.perCommand.filter((row) => credited.has(row.command)).length,
      'behavioural coverage disagrees with the set of commands that actually hold a credited match',
    );
    for (const c of report.cases) {
      if (c.creditBasis === 'not-established') {
        assert.equal(c.credits, null, `${c.id} has an unestablished credit that still counts`);
      }
    }
    // And the reverse: a case whose label was never checkable must be visible,
    // not silently dropped. Today five cases are in that state; if the list
    // ever empties the report should say so rather than the field disappearing.
    assert.ok(Array.isArray(report.uncreditedLabels));
  });

  it('pins the three semantics that were wrong before they were measured', () => {
    // These are the cases the object model's own comments cite. If any of them
    // stops being compared -- not just stops passing -- the citation is stale.
    const byId = new Map(report.cases.map((c) => [c.id, c]));
    for (const id of [
      'pipeline.measure-nested-array',
      'collation.b-lt-a',
      'pipeline.foreach-runs-for-null',
    ]) {
      const found = byId.get(id);
      assert.ok(found !== undefined, `${id} is missing from the corpus`);
      assert.equal(found.outcome, 'match', `${id} is '${found.outcome}', not a compared match`);
    }
  });

  it('does not count a known gap as evidence of fidelity', () => {
    // A known-gap entry explains a difference so the run can be green; it must
    // never make a command look verified.
    //
    // This used to assert `gapCases.size > 0` — "expected at least one known
    // gap to be recorded" — which made the suite depend on the project still
    // having the defects. Both gaps it was written for (right-operand coercion,
    // the Int32/Int64 boundary) were then fixed, and the test failed for having
    // nothing left to complain about. A test that goes red when a bug is fixed
    // is measuring the wrong thing.
    //
    // What it should establish is that the file was really read and the rule
    // really applies, so: the parsed entries must be non-empty, and no gap may
    // match. With no gaps the loop is vacuous, which is the correct state of
    // affairs rather than a hole — the entries assertion is what keeps a
    // silently empty known-differences.yml from passing.
    assert.ok(
      report.knownDifferences.length > 0,
      'known-differences.yml parsed to nothing; the file is not being read',
    );
    const gapCases = new Set(
      report.knownDifferences.filter((k) => k.kind === 'known-gap').flatMap((k) => k.cases),
    );
    for (const c of report.cases) {
      if (gapCases.has(c.id)) assert.notEqual(c.outcome, 'match', `${c.id} is explained as a gap but matched`);
    }
  });
});
