/**
 * Tests for parsing what the documentation claims.
 *
 * The markdown fixtures below are real text observed in the live
 * MicrosoftDocs/PowerShell-Docs repository, including the hard wrapping. Wrapping
 * is not cosmetic here: the 7.6 doc breaks the line between "PowerShell" and its
 * version number, so a parser using a literal space silently stops matching.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDocsClaim,
  parseLifecycleTable,
  toIsoDate,
} from '../../tools/docs-claim.mts';

/** Real text from What-s-New-in-PowerShell-76.md, wrapping preserved. */
const DOC_76 = `# What's New in PowerShell 7.6

PowerShell 7.6.5 includes the following features, updates, and breaking changes. PowerShell
7.6.5 is built on the .NET 10.0.11 runtime.

For a complete list of changes, see the [CHANGELOG][log] in the GitHub repository.
`;

/** Real text from What-s-New-in-PowerShell-77.md. */
const DOC_77 = `# What's New in PowerShell 7.7

PowerShell 7.7.0-preview.4 includes the following features, updates, and breaking changes.
PowerShell 7.7.0-preview.4 is built on the .NET 11.0.100-preview.6 runtime.
`;

/** The shape the docs take during an rc window, before every GA. */
const DOC_RC = `# What's New in PowerShell 7.6

PowerShell 7.6.0-rc.1 includes the following features, updates, and breaking changes.
PowerShell 7.6.0-rc.1 is built on the .NET 10.0.0-rc.2 runtime.
`;

describe('parseDocsClaim', () => {
  it('reads a claim that wraps across a newline', () => {
    const claim = parseDocsClaim(DOC_76);
    assert.equal(claim.psVersion, '7.6.5');
    assert.equal(claim.dotnetVersion, '10.0.11');
    assert.equal(claim.dotnetNoun, 'runtime');
  });

  it('reads the 7.7 claim, which names an SDK while calling it a runtime', () => {
    // TRAP C. The parser's job is only to report what the prose says; deciding
    // that 11.0.100-preview.6 is an SDK rather than a runtime happens later,
    // by comparison against global.json.
    const claim = parseDocsClaim(DOC_77);
    assert.equal(claim.psVersion, '7.7.0-preview.4');
    assert.equal(claim.dotnetVersion, '11.0.100-preview.6');
    assert.equal(claim.dotnetNoun, 'runtime');
  });

  it('TRAP D: parses an rc release, not just a preview', () => {
    // A parser that only knew -preview.N returned null for the whole rc window,
    // which the caller escalates to error severity — a guaranteed false failure
    // in the month before every GA. A gate with a predictable false alarm gets
    // disabled, which turns "never silently pass" into "never runs".
    const claim = parseDocsClaim(DOC_RC);
    assert.equal(claim.psVersion, '7.6.0-rc.1');
    assert.equal(claim.dotnetVersion, '10.0.0-rc.2');
  });

  it('reports null rather than a wrong answer when the shape changes', () => {
    const claim = parseDocsClaim('# Something else entirely\n\nNo version here.\n');
    assert.equal(claim.psVersion, null);
    assert.equal(claim.dotnetVersion, null);
    assert.equal(claim.dotnetNoun, null);
  });

  it('counts the "is built on" sentences so an ambiguous doc can be flagged', () => {
    // With two such sentences the first wins, which may describe a historical
    // release and produce a false "docs are behind" finding.
    assert.equal(parseDocsClaim(DOC_76).builtOnSentences, 1);

    const withHistory = `${DOC_76}
## Older releases

PowerShell 7.6.0 is built on the .NET 10.0.0 runtime.
`;
    const claim = parseDocsClaim(withHistory);
    assert.equal(claim.builtOnSentences, 2);
    assert.equal(claim.psVersion, '7.6.5', 'the first sentence still wins');
  });

  it('falls back to the "includes the following" sentence', () => {
    const claim = parseDocsClaim('PowerShell 7.8.0-preview.1 includes the following changes.');
    assert.equal(claim.psVersion, '7.8.0-preview.1');
    assert.equal(claim.dotnetVersion, null);
  });
});

/** Real rows from PowerShell-Support-Lifecycle.md, alignment preserved. */
const LIFECYCLE = `
| Version                  | Released     | End-of-support | .NET            |
| ------------------------ | ------------ | -------------- | --------------- |
| PowerShell 7.7 (preview) |              |                | [.NET 11.0][08] |
| PowerShell 7.6 (LTS)     | 18-Mar-2026  |  14-Nov-2028   | [.NET 10.0][07] |
| PowerShell 7.5           | 23-Jan-2025  |  10-Nov-2026   | [.NET 9.0][16]  |
| PowerShell 7.4 (LTS)     | 16-Nov-2023  |  10-Nov-2026   | [.NET 8.0][15]  |
`;

describe('parseLifecycleTable', () => {
  it('recognises LTS rows and reads their end-of-support date', () => {
    const { rows } = parseLifecycleTable(LIFECYCLE);
    assert.equal(rows.get('7.6')?.isLts, true);
    assert.equal(rows.get('7.6')?.endOfSupport, '2028-11-14');
    assert.equal(rows.get('7.4')?.isLts, true);
    assert.equal(rows.get('7.4')?.endOfSupport, '2026-11-10');
  });

  it('recognises a preview row rather than skipping it', () => {
    // Matching only "(LTS)?" skipped this row, producing a false
    // "the lifecycle doc has no row for 7.7" warning.
    const { rows } = parseLifecycleTable(LIFECYCLE);
    const row = rows.get('7.7');
    assert.ok(row !== undefined, '7.7 row should be found');
    assert.equal(row.isLts, false);
    assert.equal(row.endOfSupport, null);
  });

  it('recognises an unqualified Stable row', () => {
    const { rows } = parseLifecycleTable(LIFECYCLE);
    assert.equal(rows.get('7.5')?.isLts, false);
    assert.equal(rows.get('7.5')?.endOfSupport, '2026-11-10');
  });

  it('reads the end-of-support column by name, so an inserted column cannot shift it', () => {
    // This is the dangerous case. With positional indices, adding a column made
    // the parser return the RELEASED date as the end-of-support date: a valid,
    // plausible, wrong answer that no value-level validation could catch.
    const shifted = `
| Version              | Status  | Released     | End-of-support | .NET            |
| -------------------- | ------- | ------------ | -------------- | --------------- |
| PowerShell 7.6 (LTS) | current | 18-Mar-2026  |  14-Nov-2028   | [.NET 10.0][07] |
`;
    const { rows, unparseableDates } = parseLifecycleTable(shifted);
    assert.equal(rows.get('7.6')?.isLts, true);
    assert.equal(rows.get('7.6')?.endOfSupport, '2028-11-14', 'not the Released date');
    assert.deepEqual(unparseableDates, []);
  });

  it('reports rather than guesses when the header has no end-of-support column', () => {
    const noHeader = `
| Version              | Released     |
| -------------------- | ------------ |
| PowerShell 7.6 (LTS) | 18-Mar-2026  |
`;
    const { rows, unparseableDates } = parseLifecycleTable(noHeader);
    assert.equal(rows.get('7.6')?.endOfSupport, null);
    assert.equal(unparseableDates.length, 1);
  });

  it('keeps the supported-table row when a version appears in two tables', () => {
    // The live doc carries a supported table and an end-of-life table under one
    // heading. Last-wins would take values from the end-of-life table.
    const twice = `
| Version              | Released     | End-of-support | .NET            |
| -------------------- | ------------ | -------------- | --------------- |
| PowerShell 7.6 (LTS) | 18-Mar-2026  |  14-Nov-2028   | [.NET 10.0][07] |

| Version        | Released     | End-of-support | .NET            |
| -------------- | ------------ | -------------- | --------------- |
| PowerShell 7.6 | 18-Mar-2026  |  01-Jan-2020   | [.NET 10.0][07] |
`;
    const { rows, duplicates } = parseLifecycleTable(twice);
    assert.equal(rows.get('7.6')?.endOfSupport, '2028-11-14', 'first row wins');
    assert.equal(rows.get('7.6')?.isLts, true);
    assert.deepEqual(duplicates, ['7.6']);
  });

  it('returns an empty map when the table shape changes, so the caller can escalate', () => {
    assert.equal(parseLifecycleTable('no table here').rows.size, 0);
  });
});

describe('toIsoDate', () => {
  it('converts the docs date format to ISO for comparison with .NET metadata', () => {
    assert.equal(toIsoDate('14-Nov-2028'), '2028-11-14');
    assert.equal(toIsoDate('10-Nov-2026'), '2026-11-10');
    assert.equal(toIsoDate('04-Mar-2020'), '2020-03-04');
    assert.equal(toIsoDate(' 18-Mar-2026 '), '2026-03-18');
  });

  it('returns null for anything else', () => {
    for (const bad of ['', '2026-11-10', 'Nov-2026', '32-Xyz-2026']) {
      assert.equal(toIsoDate(bad), null, `should not parse: ${bad}`);
    }
  });
});
