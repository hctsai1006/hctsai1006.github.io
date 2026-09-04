/**
 * The eight portfolio commands — the site's actual content, as objects.
 *
 * v1 returned rendered rows: `table(['Repository','Merged'], rows)` produced
 * text, so `Get-Contribution | Sort-Object Merged` sorted the FORMATTED STRING
 * including its padding. These emit PSObjects with real type names, so the
 * sorting, filtering and grouping cmdlets work on them and the layout is the
 * formatter's problem.
 *
 * THE RULE THESE COMMANDS LIVE UNDER
 *
 * A count that `profile.json` states is never re-derived. The contribution top
 * list deliberately does not sum to `stats.merged` — it is a TOP LIST — so a
 * header computed by summing the rows would be confidently wrong, which is the
 * exact drift (115 -> 148) that made `stats` the single source in the first
 * place. Same for `publications.total`, which the extractor already checks
 * against `entries.length`.
 *
 * Every one of them declares `portfolio.read` and asks the broker for it before
 * reading anything, so a session that withheld the capability gets an error
 * rather than data.
 */

import { psObject } from '../../pipeline/psobject.ts';
import type { PSObject, PSValue } from '../../pipeline/psobject.ts';
import { throwIfCancelled } from '../../pipeline/pipeline.ts';
import { errorRecord } from '../../pipeline/streams.ts';
import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import { STRING, SWITCH, manifest, parameter, stringValue, switchValue } from '../powershell/support.ts';
import {
  ADVISORIES,
  AFFILIATION,
  AWARDS,
  CONTRIBUTIONS,
  FOUNDATIONS,
  HANDLE,
  NAME_EN,
  NAME_ZH,
  PROFILE_LINES,
  PROJECTS,
  PUBLICATIONS,
  PUBLICATION_TOTAL,
  STATS,
  STATS_SENTINEL,
  TIMELINE,
  identifierUrl,
  statsLine,
} from './data.ts';
import { SOURCES, SOURCE_BANNER, SOURCE_URLS } from './sources.ts';

/**
 * Type names are prefixed `BrowserShell.Portfolio.` so nothing mistakes them
 * for .NET types, and so a formatter can hang a view off one of them without
 * colliding with a real one.
 */
const T = (leaf: string): readonly string[] => [`BrowserShell.Portfolio.${leaf}`, 'System.Object'];

/** Ask the broker, then read. Never the other way round. */
async function emit(
  context: InvocationContext,
  rows: Iterable<PSObject>,
): Promise<number> {
  context.requireCapability('portfolio.read');
  for (const row of rows) {
    throwIfCancelled(context.signal, 'portfolio');
    if (context.streams.success.closed) break;
    await context.streams.success.write(row);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// whoami
// ---------------------------------------------------------------------------

const WHOAMI_MANIFEST = manifest({
  display: 'whoami',
  aliases: ['profile', 'whois'],
  synopsis: 'Print effective user name, with a profile summary.',
  notes:
    'The identity lines come from profile.json, whose `__STATS__` placeholder is composed here ' +
    'from stats.merged/projects/foundations rather than stored — storing the composed string ' +
    'would make a second copy of the three counts, which is the drift the placeholder exists to ' +
    'prevent. The user name is the simulated machine\'s, not the visitor\'s.',
  capabilities: ['portfolio.read'],
  parameters: [],
  outputTypeNames: ['BrowserShell.Portfolio.Identity'],
});

export function identityRows(userName: string): readonly PSObject[] {
  const rows: PSObject[] = [
    psObject({ Kind: 'user', Text: userName }, T('Identity')),
  ];
  for (const line of PROFILE_LINES) {
    rows.push(
      psObject(
        { Kind: line.kind, Text: line.text === STATS_SENTINEL ? statsLine() : line.text },
        T('Identity'),
      ),
    );
  }
  rows.push(psObject({ Kind: 'source', Text: SOURCE_URLS.home }, T('Identity')));
  rows.push(psObject({ Kind: 'source', Text: SOURCE_URLS.github }, T('Identity')));
  return rows;
}

export function createWhoami(services: { readonly machine: { readonly userName: string } }): CommandModule {
  return {
    manifest: WHOAMI_MANIFEST,
    invoke: (context: InvocationContext, _bound: BindingResult): Promise<number> =>
      emit(context, identityRows(services.machine.userName)),
  };
}

// ---------------------------------------------------------------------------
// Get-Contribution
// ---------------------------------------------------------------------------

const GET_CONTRIBUTION_MANIFEST = manifest({
  display: 'Get-Contribution',
  synopsis: 'List merged upstream contributions.',
  notes:
    'The rows are a TOP LIST and deliberately do not sum to the total: the total comes from ' +
    'profile.json stats.merged and is never re-derived from the rows. -Foundation CNCF filters ' +
    'on the ledger\'s `cncf` flag, never on a repository-name regex — a keyword match once ' +
    'mis-bucketed argo-workflows and community-operators — and reports the bucket\'s own merged ' +
    'and repository counts from contributions.json.',
  capabilities: ['portfolio.read'],
  parameters: [parameter('Foundation', STRING, { position: 0 })],
  outputTypeNames: ['BrowserShell.Portfolio.Contribution'],
});

export function contributionRows(foundation: string | undefined): readonly PSObject[] {
  const key = foundation?.toLowerCase();
  const bucket = key === undefined ? undefined : FOUNDATIONS[key];
  const rows = bucket === undefined ? CONTRIBUTIONS : CONTRIBUTIONS.filter((r) => r.cncf);
  return rows.map((row) =>
    psObject(
      {
        Repository: row.repository,
        Merged: row.merged,
        Foundation: row.cncf ? (FOUNDATIONS['cncf']?.label ?? 'CNCF') : '',
      },
      T('Contribution'),
    ),
  );
}

/**
 * The header, as an object rather than a rendered line. Its counts are READ,
 * not summed.
 */
export function contributionSummary(foundation: string | undefined): PSObject {
  const key = foundation?.toLowerCase();
  const bucket = key === undefined ? undefined : FOUNDATIONS[key];
  if (bucket !== undefined) {
    return psObject(
      {
        Scope: bucket.label,
        Merged: bucket.merged,
        Repositories: bucket.repositories,
        Source: SOURCE_URLS.openSource,
      },
      T('ContributionSummary'),
    );
  }
  return psObject(
    {
      Scope: 'all',
      Merged: STATS.merged,
      Projects: STATS.projects,
      Foundations: STATS.foundations,
      AsOf: STATS.asOf,
      Source: SOURCE_URLS.openSource,
    },
    T('ContributionSummary'),
  );
}

export const getContribution: CommandModule = {
  manifest: GET_CONTRIBUTION_MANIFEST,
  invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
    const foundation = stringValue(bound.parameters, 'Foundation');
    if (foundation !== undefined && FOUNDATIONS[foundation.toLowerCase()] === undefined) {
      // An unknown foundation is not silently "everything": that would answer a
      // question the user did not ask with data that looks like an answer.
      context.requireCapability('portfolio.read');
      return context.streams.error
        .write(
          errorRecord(
            `No foundation bucket named '${foundation}'. Known: ` +
              `${Object.keys(FOUNDATIONS).join(', ')}.`,
            'FoundationNotFound',
            'Get-Contribution',
            'ObjectNotFound',
            { exceptionType: 'System.ArgumentException', targetObject: foundation },
          ),
        )
        .then(() => 1);
    }
    return emit(context, [contributionSummary(foundation), ...contributionRows(foundation)]);
  },
};

// ---------------------------------------------------------------------------
// Get-Publication
// ---------------------------------------------------------------------------

const GET_PUBLICATION_MANIFEST = manifest({
  display: 'Get-Publication',
  synopsis: 'List publications.',
  notes:
    'The total comes from publications.json `total`, which the extractor already checks against ' +
    'entries.length, so nothing here counts the rows. Without -Full the list is the featured ' +
    'short list; -Full emits every entry. Identifier links follow v1\'s rule: arXiv ids and ' +
    'DOIs become URLs, anything else stays bare.',
  capabilities: ['portfolio.read'],
  parameters: [parameter('Full', SWITCH), parameter('Status', STRING), parameter('Year', STRING)],
  outputTypeNames: ['BrowserShell.Portfolio.Publication'],
});

export function publicationRows(options: {
  full: boolean;
  status?: string | undefined;
  year?: string | undefined;
}): readonly PSObject[] {
  let rows = [...PUBLICATIONS];
  if (options.status !== undefined) {
    const wanted = options.status.toLowerCase();
    rows = rows.filter((p) => p.status.toLowerCase() === wanted);
  }
  if (options.year !== undefined) rows = rows.filter((p) => p.year === options.year);
  // Featured is a SHORT LIST, not a different set: without -Full pwsh-style
  // paging is not available, so the first five entries stand in for it and the
  // count that matters is still the authoritative total.
  const visible = options.full ? rows : rows.slice(0, 5);
  return visible.map((p) =>
    psObject(
      {
        Year: p.year,
        Venue: p.venue,
        Title: p.title,
        Status: p.status,
        Identifier: p.identifier ?? '',
        Url: identifierUrl(p.identifier),
        Authors: p.authors,
      },
      T('Publication'),
    ),
  );
}

export function publicationSummary(shown: number): PSObject {
  return psObject(
    {
      Total: PUBLICATION_TOTAL,
      Shown: shown,
      Accepted: PUBLICATIONS.filter((p) => p.status === 'Accepted').length,
      Preprints: PUBLICATIONS.filter((p) => p.status === 'preprint').length,
      Orcid: SOURCE_URLS.orcid,
      Source: SOURCE_URLS.publications,
    },
    T('PublicationSummary'),
  );
}

export const getPublication: CommandModule = {
  manifest: GET_PUBLICATION_MANIFEST,
  invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
    const rows = publicationRows({
      full: switchValue(bound.parameters, 'Full'),
      status: stringValue(bound.parameters, 'Status'),
      year: stringValue(bound.parameters, 'Year'),
    });
    return emit(context, [publicationSummary(rows.length), ...rows]);
  },
};

// ---------------------------------------------------------------------------
// Get-Award
// ---------------------------------------------------------------------------

const GET_AWARD_MANIFEST = manifest({
  display: 'Get-Award',
  synopsis: 'List awards and honors.',
  notes:
    'honors.json holds the short list shown here, not the full 80-entry timeline on the site; ' +
    '-Year filters it. Emitting nothing for an unmatched year is the honest answer — v1 printed ' +
    '"No entries for that year", which is a formatter\'s job.',
  capabilities: ['portfolio.read'],
  parameters: [parameter('Year', STRING, { position: 0 })],
  outputTypeNames: ['BrowserShell.Portfolio.Award'],
});

export function awardRows(year: string | undefined): readonly PSObject[] {
  const rows = year === undefined ? AWARDS : AWARDS.filter((a) => a.year === year);
  return rows.map((a) =>
    psObject({ Year: a.year, Award: a.name, Source: SOURCE_URLS.honors }, T('Award')),
  );
}

export const getAward: CommandModule = {
  manifest: GET_AWARD_MANIFEST,
  invoke: (context: InvocationContext, bound: BindingResult): Promise<number> =>
    emit(context, awardRows(stringValue(bound.parameters, 'Year'))),
};

// ---------------------------------------------------------------------------
// Get-Advisory
// ---------------------------------------------------------------------------

const GET_ADVISORY_MANIFEST = manifest({
  display: 'Get-Advisory',
  synopsis: 'List published security advisories that credit me.',
  notes:
    'Both entries are named in the advisory credits with status accepted. Neither has a CVE ' +
    'yet, and neither is in the GitHub global advisory database or OSV yet — that is carried on ' +
    'each row as HasCve and InGlobalDatabase rather than left to a footnote, because a reader ' +
    'filtering these objects should see it too.',
  capabilities: ['portfolio.read'],
  parameters: [parameter('Severity', STRING), parameter('Foundation', STRING)],
  outputTypeNames: ['BrowserShell.Portfolio.Advisory'],
});

export function advisoryRows(filters: {
  severity?: string | undefined;
  foundation?: string | undefined;
}): readonly PSObject[] {
  let rows = [...ADVISORIES];
  if (filters.severity !== undefined) {
    const wanted = filters.severity.toLowerCase();
    rows = rows.filter((a) => a.severity.toLowerCase().includes(wanted));
  }
  if (filters.foundation !== undefined) {
    const wanted = filters.foundation.toLowerCase();
    rows = rows.filter((a) => a.foundation.toLowerCase().includes(wanted));
  }
  return rows.map((a) =>
    psObject(
      {
        Id: a.id,
        Repository: a.repository,
        Severity: a.severity,
        Role: a.role,
        Published: a.published,
        Foundation: a.foundation,
        FixedIn: a.fixedIn,
        Summary: a.summary,
        Url: a.url,
        Bulletin: a.bulletin ?? '',
        // Stated on the row, not in a trailing note: an object that is filtered
        // or exported must carry the caveat with it.
        HasCve: false,
        InGlobalDatabase: false,
      },
      T('Advisory'),
    ),
  );
}

export const getAdvisory: CommandModule = {
  manifest: GET_ADVISORY_MANIFEST,
  invoke: (context: InvocationContext, bound: BindingResult): Promise<number> =>
    emit(
      context,
      advisoryRows({
        severity: stringValue(bound.parameters, 'Severity'),
        foundation: stringValue(bound.parameters, 'Foundation'),
      }),
    ),
};

// ---------------------------------------------------------------------------
// Get-Project
// ---------------------------------------------------------------------------

const GET_PROJECT_MANIFEST = manifest({
  display: 'Get-Project',
  synopsis: 'List representative projects.',
  notes: 'A representative selection from projects.json, not the full experience page.',
  capabilities: ['portfolio.read'],
  parameters: [],
  outputTypeNames: ['BrowserShell.Portfolio.Project'],
});

export function projectRows(): readonly PSObject[] {
  return PROJECTS.map((p) =>
    psObject({ Project: p.name, Focus: p.focus, Source: SOURCE_URLS.experience }, T('Project')),
  );
}

export const getProject: CommandModule = {
  manifest: GET_PROJECT_MANIFEST,
  invoke: (context: InvocationContext, _bound: BindingResult): Promise<number> =>
    emit(context, projectRows()),
};

// ---------------------------------------------------------------------------
// Get-Timeline
// ---------------------------------------------------------------------------

const GET_TIMELINE_MANIFEST = manifest({
  display: 'Get-Timeline',
  synopsis: 'Show the year-by-year timeline.',
  notes: 'One row per year from projects.json, oldest first.',
  capabilities: ['portfolio.read'],
  parameters: [],
  outputTypeNames: ['BrowserShell.Portfolio.TimelineEntry'],
});

export function timelineRows(): readonly PSObject[] {
  return TIMELINE.map((t) =>
    psObject({ Year: t.year, Highlights: t.highlights, Source: SOURCE_URLS.experience }, T('TimelineEntry')),
  );
}

export const getTimeline: CommandModule = {
  manifest: GET_TIMELINE_MANIFEST,
  invoke: (context: InvocationContext, _bound: BindingResult): Promise<number> =>
    emit(context, timelineRows()),
};

// ---------------------------------------------------------------------------
// Get-Source
// ---------------------------------------------------------------------------

const GET_SOURCE_MANIFEST = manifest({
  display: 'Get-Source',
  synopsis: 'List every authoritative source, with links.',
  notes:
    'The command that says this terminal is the secondary surface: where it and the website ' +
    'disagree, the website wins. The link table is the one portfolio table not extracted from ' +
    'index.html — it lives beside the `D` literal rather than inside it — so it is retyped in ' +
    'sources.ts with every URL built from one SITE constant, and that duplication is stated ' +
    'there rather than left to be discovered.',
  capabilities: ['portfolio.read'],
  parameters: [],
  outputTypeNames: ['BrowserShell.Portfolio.Source'],
});

export function sourceRows(): readonly PSObject[] {
  const rows: PSObject[] = SOURCE_BANNER.map((text) =>
    psObject({ Label: '', Reference: text, Url: '', Kind: 'banner' }, T('Source')),
  );
  for (const source of SOURCES) {
    rows.push(
      psObject(
        { Label: source.label, Reference: source.reference, Url: source.url, Kind: 'source' },
        T('Source'),
      ),
    );
  }
  return rows;
}

export const getSource: CommandModule = {
  manifest: GET_SOURCE_MANIFEST,
  invoke: (context: InvocationContext, _bound: BindingResult): Promise<number> =>
    emit(context, sourceRows()),
};

// ---------------------------------------------------------------------------
// the profile summary, shared
// ---------------------------------------------------------------------------

/** Exported for tests: the identity as one object rather than a list of lines. */
export function profileObject(): PSObject {
  const properties: Record<string, PSValue> = {
    Handle: HANDLE,
    Name: NAME_EN,
    NameZh: NAME_ZH,
    Affiliation: AFFILIATION,
    Merged: STATS.merged,
    Projects: STATS.projects,
    Foundations: STATS.foundations,
    AsOf: STATS.asOf,
  };
  return psObject(properties, T('Profile'));
}
