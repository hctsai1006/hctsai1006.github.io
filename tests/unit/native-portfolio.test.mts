/**
 * Tests for the portfolio commands.
 *
 * These are not differential tests — pwsh has no `Get-Contribution` — so what
 * they assert is different in kind: that the data reaches the pipeline as
 * OBJECTS, that the capability broker is asked before anything is read, and
 * above all that no count is ever re-derived.
 *
 * THE COUNT RULE IS THE POINT. `contributions.json` says in its own `$comment`
 * that the top list deliberately does not sum to `stats.merged`; the drift from
 * 115 to 148 happened because two places computed the same number differently.
 * So the strongest test here is the one that proves the header does NOT equal
 * the sum of the rows — an implementation that "helpfully" totalled them would
 * pass every other assertion in this file.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CapabilityDeniedError } from '../../src/commands/invocation.ts';
import type { CommandModule } from '../../src/commands/invocation.ts';
import {
  CONTRIBUTIONS,
  FOUNDATIONS,
  PUBLICATIONS,
  PUBLICATION_TOTAL,
  PORTFOLIO_COMMANDS,
  SOURCES,
  STATS,
  identifierUrl,
  statsLine,
} from '../../src/commands/portfolio/index.ts';
import { column, prop, run, typeNamesOf } from './native-harness.mts';

const byName = new Map<string, CommandModule>(
  PORTFOLIO_COMMANDS.map((module) => [module.manifest.name, module]),
);
const need = (name: string): CommandModule => {
  const module = byName.get(name);
  assert.ok(module !== undefined, `no portfolio module named ${name}`);
  return module;
};

describe('the portfolio registry', () => {
  it('has the eight commands the manifests declare with portfolio.read', () => {
    assert.deepEqual(
      [...byName.keys()].sort(),
      [
        'get-advisory', 'get-award', 'get-contribution', 'get-project', 'get-publication',
        'get-source', 'get-timeline', 'whoami',
      ],
    );
  });

  it('declares portfolio.read on every one of them', () => {
    for (const module of PORTFOLIO_COMMANDS) {
      assert.deepEqual(
        module.manifest.capabilities,
        ['portfolio.read'],
        `${module.manifest.display} must declare portfolio.read`,
      );
      assert.equal(module.manifest.fidelity, 'native-semantic');
    }
  });

  it('asks the broker before reading anything', async () => {
    for (const module of PORTFOLIO_COMMANDS) {
      await assert.rejects(
        () => run(module, {}, [], { granted: [] }),
        (error: unknown) => error instanceof CapabilityDeniedError,
        `${module.manifest.display} read data without asking`,
      );
    }
  });
});

describe('Get-Contribution', () => {
  it('reports the total from profile.json and NOT the sum of the rows', async () => {
    const result = await run(need('get-contribution'));
    const summary = result.values[0];
    assert.equal(prop(summary, 'Merged'), STATS.merged);
    assert.equal(prop(summary, 'Projects'), STATS.projects);
    assert.equal(prop(summary, 'Foundations'), STATS.foundations);

    // The discriminating assertion: the rows are a TOP LIST and must not add up
    // to the header. An implementation that summed them would be silently wrong
    // in exactly the way contributions.json warns about.
    const rowSum = CONTRIBUTIONS.reduce((total, row) => total + row.merged, 0);
    assert.notEqual(rowSum, STATS.merged);
    assert.equal(prop(summary, 'Merged'), STATS.merged);
  });

  it('emits one object per repository, with a real type name', async () => {
    const result = await run(need('get-contribution'));
    const rows = result.values.slice(1);
    assert.equal(rows.length, CONTRIBUTIONS.length);
    assert.deepEqual(typeNamesOf(rows[0]), [
      'BrowserShell.Portfolio.Contribution', 'System.Object',
    ]);
    assert.equal(prop(rows[0], 'Repository'), CONTRIBUTIONS[0]?.repository);
    assert.equal(prop(rows[0], 'Merged'), CONTRIBUTIONS[0]?.merged);
  });

  it('filters -Foundation CNCF on the ledger flag, never on the repository name', async () => {
    const result = await run(need('get-contribution'), { Foundation: 'CNCF' });
    const rows = result.values.slice(1);
    const expected = CONTRIBUTIONS.filter((row) => row.cncf);
    assert.deepEqual(column(rows, 'Repository'), expected.map((row) => row.repository));

    // Two rows a keyword regex gets wrong: neither name contains "cncf" or
    // "kubernetes", and both really are CNCF projects.
    const names = column(rows, 'Repository').map(String);
    assert.ok(names.includes('argoproj/argo-workflows'));
    assert.ok(names.includes('k8s-operatorhub/community-operators'));

    // And a row a keyword regex would wrongly INCLUDE.
    assert.ok(!names.includes('ROCm/k8s-gpu-dra-driver'));
  });

  it('reports the bucket\'s own counts for a foundation, not a recount', async () => {
    const result = await run(need('get-contribution'), { Foundation: 'cncf' });
    const summary = result.values[0];
    assert.equal(prop(summary, 'Merged'), FOUNDATIONS['cncf']?.merged);
    assert.equal(prop(summary, 'Repositories'), FOUNDATIONS['cncf']?.repositories);

    // The bucket's repository count is the ledger's, and it is larger than the
    // number of rows in the top list — which is the whole reason it is stored.
    const shown = result.values.length - 1;
    assert.notEqual(shown, FOUNDATIONS['cncf']?.repositories);
  });

  it('errors for an unknown foundation instead of quietly showing everything', async () => {
    const result = await run(need('get-contribution'), { Foundation: 'nope' });
    assert.deepEqual(result.values, []);
    assert.equal(result.errors[0]?.fullyQualifiedErrorId, 'FoundationNotFound,Get-Contribution');
    assert.equal(result.exitCode, 1);
  });
});

describe('Get-Publication', () => {
  it('reports the authoritative total, not a row count', async () => {
    const result = await run(need('get-publication'));
    assert.equal(prop(result.values[0], 'Total'), PUBLICATION_TOTAL);
    // The default view is a short list, so Shown is smaller than Total — which
    // is exactly why Total must not be derived from what was emitted.
    assert.ok((prop(result.values[0], 'Shown') as number) < PUBLICATION_TOTAL);
  });

  it('emits every entry for -Full', async () => {
    const result = await run(need('get-publication'), { Full: true });
    assert.equal(result.values.length - 1, PUBLICATIONS.length);
    assert.equal(PUBLICATIONS.length, PUBLICATION_TOTAL);
  });

  it('filters by -Status and -Year', async () => {
    const accepted = await run(need('get-publication'), { Full: true, Status: 'Accepted' });
    for (const row of accepted.values.slice(1)) assert.equal(prop(row, 'Status'), 'Accepted');

    const y2023 = await run(need('get-publication'), { Full: true, Year: '2023' });
    for (const row of y2023.values.slice(1)) assert.equal(prop(row, 'Year'), '2023');
  });

  it('turns arXiv ids and DOIs into links, and leaves anything else bare', () => {
    assert.equal(identifierUrl('arXiv:2607.14798'), 'https://arxiv.org/abs/2607.14798');
    assert.equal(identifierUrl('10.31224/7541'), 'https://doi.org/10.31224/7541');
    assert.equal(identifierUrl(null), '');
    assert.equal(identifierUrl('IEEE SCC 2026'), '');
  });
});

describe('Get-Award, Get-Project, Get-Timeline', () => {
  it('emits awards, and filters by -Year', async () => {
    const all = await run(need('get-award'));
    assert.ok(all.values.length > 0);
    assert.deepEqual(typeNamesOf(all.values[0]), ['BrowserShell.Portfolio.Award', 'System.Object']);

    const y2023 = await run(need('get-award'), { Year: '2023' });
    for (const row of y2023.values) assert.equal(prop(row, 'Year'), '2023');
    assert.ok(y2023.values.length < all.values.length);
  });

  it('emits nothing for a year with no entries, rather than a message', async () => {
    // The "No entries for that year" line v1 printed is a formatter's job; an
    // empty result is the pipeline's answer.
    const result = await run(need('get-award'), { Year: '1999' });
    assert.deepEqual(result.values, []);
    assert.deepEqual(result.errors, []);
  });

  it('emits projects and the timeline as objects', async () => {
    const projects = await run(need('get-project'));
    assert.deepEqual(typeNamesOf(projects.values[0]), [
      'BrowserShell.Portfolio.Project', 'System.Object',
    ]);
    assert.ok(column(projects.values, 'Project').includes('Nephio (LFN)'));

    const timeline = await run(need('get-timeline'));
    assert.deepEqual(typeNamesOf(timeline.values[0]), [
      'BrowserShell.Portfolio.TimelineEntry', 'System.Object',
    ]);
    assert.deepEqual(column(timeline.values, 'Year'), ['2023', '2024', '2025', '2026']);
  });
});

describe('Get-Advisory', () => {
  it('carries the "no CVE, not in the global database" caveat on the ROW', async () => {
    // v1 printed it as a trailing note. A note does not survive
    // `Get-Advisory | Export-Csv`; a property does.
    const result = await run(need('get-advisory'));
    assert.ok(result.values.length >= 2);
    for (const row of result.values) {
      assert.equal(prop(row, 'HasCve'), false);
      assert.equal(prop(row, 'InGlobalDatabase'), false);
    }
  });

  it('emits the id, repository, severity and links', async () => {
    const result = await run(need('get-advisory'));
    assert.deepEqual(typeNamesOf(result.values[0]), [
      'BrowserShell.Portfolio.Advisory', 'System.Object',
    ]);
    const ids = column(result.values, 'Id').map(String);
    assert.ok(ids.includes('GHSA-qm8v-g4f9-qhjx'));
    assert.match(String(prop(result.values[0], 'Url')), /^https:\/\/github\.com\//);
  });

  it('filters by -Foundation', async () => {
    const result = await run(need('get-advisory'), { Foundation: 'graduated' });
    assert.equal(result.values.length, 1);
    assert.equal(prop(result.values[0], 'Repository'), 'istio/istio');
  });
});

describe('whoami and Get-Source', () => {
  it('composes the stats line rather than storing it', async () => {
    const result = await run(need('whoami'));
    const texts = column(result.values, 'Text').map(String);
    assert.equal(texts[0], 'thc1006');
    assert.ok(texts.includes(statsLine()));
    // The placeholder must never reach the pipeline.
    assert.ok(!texts.includes('__STATS__'));
    assert.match(statsLine(), new RegExp(`^${String(STATS.merged)} merged pull requests`));
  });

  it('lists every authoritative source, banner first', async () => {
    const result = await run(need('get-source'));
    assert.equal(prop(result.values[0], 'Kind'), 'banner');
    const sources = result.values.filter((value) => prop(value, 'Kind') === 'source');
    assert.equal(sources.length, SOURCES.length);
    assert.deepEqual(
      column(sources, 'Label').map(String),
      SOURCES.map((source) => source.label),
    );
  });

  it('builds every site URL from one SITE constant', () => {
    const siteRows = SOURCES.filter((source) => source.url.startsWith('https://people.cs.nycu'));
    assert.ok(siteRows.length >= 9);
    for (const row of siteRows) {
      assert.ok(row.url.startsWith('https://people.cs.nycu.edu.tw/~hctsai1006'));
    }
  });
});
