/**
 * data.ts — typed access to `src/data/*.json`.
 *
 * The JSON is EXTRACTED from index.html by tools/extract-portfolio-data.mts and
 * checked by `npm run data -- --check`, so it is not something to retype and
 * not something to re-derive. Two rules follow, and both have a scar behind
 * them:
 *
 *   THE COUNTS COME FROM profile.json, ALWAYS. `stats.merged`, `stats.projects`
 *   and `stats.foundations` are the single source; the contribution TOP LIST
 *   deliberately does not sum to `stats.merged` and summing it would produce a
 *   confidently wrong number. That is the drift that took the contribution
 *   count from 115 to 148 in the first place, and the `$comment` in
 *   contributions.json says so in as many words.
 *
 *   THE CNCF BUCKET COMES FROM THE `cncf` FLAG, never from a repository-name
 *   regex. A keyword match once mis-bucketed argo-workflows and
 *   community-operators; the flag is the ledger's answer.
 *
 * `publications.total` is likewise authoritative and is asserted against
 * `entries.length` at extraction time, so nothing here recomputes it either.
 */

import advisoriesJson from '../../data/advisories.json' with { type: 'json' };
import contributionsJson from '../../data/contributions.json' with { type: 'json' };
import honorsJson from '../../data/honors.json' with { type: 'json' };
import profileJson from '../../data/profile.json' with { type: 'json' };
import projectsJson from '../../data/projects.json' with { type: 'json' };
import publicationsJson from '../../data/publications.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------

export interface Advisory {
  readonly id: string;
  readonly repository: string;
  readonly severity: string;
  readonly role: string;
  readonly published: string;
  readonly foundation: string;
  readonly fixedIn: string;
  readonly summary: string;
  readonly url: string;
  readonly bulletin: string | null;
}

export interface ContributionRow {
  readonly repository: string;
  readonly merged: number;
  readonly cncf: boolean;
}

export interface FoundationBucket {
  readonly label: string;
  readonly merged: number;
  readonly repositories: number;
}

export interface Award {
  readonly year: string;
  readonly name: string;
}

export interface ProjectRow {
  readonly name: string;
  readonly focus: string;
}

export interface TimelineRow {
  readonly year: string;
  readonly highlights: string;
}

export interface Publication {
  readonly year: string;
  readonly status: string;
  readonly venue: string;
  readonly title: string;
  readonly identifier: string | null;
  readonly authors: string;
}

export interface ProfileStats {
  readonly merged: number;
  readonly projects: number;
  readonly foundations: number;
  readonly asOf: string;
}

export interface ProfileLine {
  readonly kind: string;
  readonly text: string;
  readonly derived?: string;
}

// ---------------------------------------------------------------------------
// the data
// ---------------------------------------------------------------------------

export const ADVISORIES: readonly Advisory[] =
  (advisoriesJson as { advisories: readonly Advisory[] }).advisories;

export const CONTRIBUTIONS: readonly ContributionRow[] =
  (contributionsJson as { top: readonly ContributionRow[] }).top;

export const FOUNDATIONS: Readonly<Record<string, FoundationBucket>> =
  (contributionsJson as { foundations: Record<string, FoundationBucket> }).foundations;

export const AWARDS: readonly Award[] = (honorsJson as { awards: readonly Award[] }).awards;

export const PROJECTS: readonly ProjectRow[] =
  (projectsJson as { projects: readonly ProjectRow[] }).projects;

export const TIMELINE: readonly TimelineRow[] =
  (projectsJson as { timeline: readonly TimelineRow[] }).timeline;

export const PUBLICATIONS: readonly Publication[] =
  (publicationsJson as { entries: readonly Publication[] }).entries;

/** Authoritative. Checked against `entries.length` by the extractor. */
export const PUBLICATION_TOTAL: number = (publicationsJson as { total: number }).total;

const profile = profileJson as {
  handle: string;
  name: { en: string; zh: string };
  affiliation: string;
  stats: ProfileStats;
  lines: readonly ProfileLine[];
};

export const HANDLE: string = profile.handle;
export const NAME_EN: string = profile.name.en;
export const NAME_ZH: string = profile.name.zh;
export const AFFILIATION: string = profile.affiliation;
export const STATS: ProfileStats = profile.stats;
export const PROFILE_LINES: readonly ProfileLine[] = profile.lines;

/** The placeholder the page fills in. Kept a placeholder here for the same
 *  reason: storing the composed string would make a second copy of the counts. */
export const STATS_SENTINEL = '__STATS__';

/** The one line that composes the three counts. Composed, never stored. */
export function statsLine(): string {
  return (
    `${String(STATS.merged)} merged pull requests · ${String(STATS.projects)} projects · ` +
    `${String(STATS.foundations)} foundations`
  );
}

/** A publication identifier as a link, matching v1's `idHref`. */
export function identifierUrl(identifier: string | null): string {
  if (identifier === null || identifier === '') return '';
  if (/^arxiv:/i.test(identifier)) return `https://arxiv.org/abs/${identifier.replace(/^arXiv:/i, '')}`;
  if (/^10\./.test(identifier)) return `https://doi.org/${identifier}`;
  return '';
}
