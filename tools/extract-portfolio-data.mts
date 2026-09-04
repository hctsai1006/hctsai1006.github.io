/**
 * extract-portfolio-data.mts — lift the portfolio data out of index.html.
 *
 * Why extraction rather than retyping
 * ----------------------------------
 * The data in index.html is correct and hard-won: the counts were reconciled
 * against the NYCU CS ledger repo-by-repo, and the comments record exactly which
 * mistakes produced the current shape (a count that drifted from 115 to 148 out
 * of sync; a hardcoded keyword regex that silently mis-bucketed argo-workflows
 * and community-operators as non-CNCF). Retyping it by hand would risk all of
 * that; so would scraping it with regexes, which is how the drift happened in
 * the first place.
 *
 * So this evaluates the actual `D` object literal in an isolated VM context with
 * no globals, and writes it out as typed JSON. The evaluation is deliberate and
 * narrow: the source is our own committed file, the extracted span is a single
 * object literal, and the context has nothing in it to attack. This is the one
 * place in the repo where evaluation is acceptable, and it runs at build time,
 * never in the browser.
 *
 * What gets DERIVED rather than stored
 * ------------------------------------
 * index.html already has one rule that must survive the move: D.stats is the
 * single source of the three counts, and every rendering point computes from it.
 * The `__STATS__` sentinel in the profile array is a placeholder the page fills
 * in at load time. That stays a placeholder here — storing the composed string
 * would create a second copy of the counts, which is the exact failure the
 * original comment warns about.
 *
 * Usage:
 *   node tools/extract-portfolio-data.mts            write src/data/*.json
 *   node tools/extract-portfolio-data.mts --check    verify, exit 1 on drift
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

import { readNamedLiteral } from './js-literal.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const SOURCE = join(REPO, 'index.html');
const DATA_DIR = join(REPO, 'src', 'data');

/** The literal placeholder the page replaces with the composed counts line. */
const STATS_SENTINEL = '__STATS__';

// ---------------------------------------------------------------------------
// the shape as it exists in index.html
// ---------------------------------------------------------------------------

interface RawData {
  stats: { merged: number; projects: number; foundations: number; asOf: string };
  profile: Array<[string, string]>;
  contribTop: Array<[string, number, 0 | 1]>;
  cncf: [string, number, number];
  advisories: Array<{
    id: string; repo: string; sev: string; role: string; pub: string;
    fdn: string; fix: string; what: string; href: string; bul: string;
  }>;
  publications: Array<[string, string, string]>;
  pubTotal: number;
  pubsFull: Array<{ y: string; st: string; venue: string; title: string; id: string; au: string }>;
  awards: Array<[string, string]>;
  projects: Array<[string, string]>;
  timeline: Array<[string, string]>;
}

function extractRawData(): RawData {
  const html = readFileSync(SOURCE, 'utf8');

  // Brace-matched, not delimiter-searched. Searching for a closing "};" happens
  // to work for D because D is followed by one, but it is exactly the technique
  // js-literal.mts exists to replace: measured against a real parser, the same
  // search overshoots ALIAS by 5x and DISP by 4.6x. Depending on D's neighbour
  // never changing is not a property worth relying on.
  const literal = readNamedLiteral(html, 'D').text;

  // An isolated context with no globals: no require, no process, no fetch, no
  // prototype to reach through. The literal cannot call anything because there
  // is nothing to call.
  const context = createContext(Object.create(null) as Record<string, never>);
  const value = runInContext(`(${literal})`, context, {
    timeout: 1000,
    displayErrors: true,
  }) as RawData;

  assertShape(value);
  return value;
}

/**
 * Fail loudly on a shape change. index.html is hand-maintained, so a field could
 * be renamed between runs; silently writing a half-empty data file would be far
 * worse than stopping.
 */
function assertShape(d: unknown): asserts d is RawData {
  const required = [
    'stats', 'profile', 'contribTop', 'cncf', 'advisories',
    'publications', 'pubTotal', 'pubsFull', 'awards', 'projects', 'timeline',
  ] as const;
  if (typeof d !== 'object' || d === null) throw new Error('D is not an object');
  const obj = d as Record<string, unknown>;
  const missing = required.filter((k) => !(k in obj));
  if (missing.length > 0) {
    throw new Error(`D is missing expected keys: ${missing.join(', ')}`);
  }
  const stats = obj['stats'] as Record<string, unknown> | undefined;
  for (const k of ['merged', 'projects', 'foundations'] as const) {
    if (typeof stats?.[k] !== 'number') throw new Error(`D.stats.${k} is not a number`);
  }

  // Two counts of the same thing must agree. pubTotal is rendered directly, and
  // pubsFull is the list behind it; if they drift, the page states a number its
  // own data does not support — which is precisely the failure the D.stats
  // comment in index.html was written about.
  const total = obj['pubTotal'];
  const full = obj['pubsFull'];
  if (typeof total === 'number' && Array.isArray(full) && total !== full.length) {
    throw new Error(
      `D.pubTotal is ${total} but D.pubsFull has ${full.length} entries. ` +
        'Either the list is incomplete or the count is wrong; both cannot be published.',
    );
  }
}

// ---------------------------------------------------------------------------
// reshape into named, typed documents
// ---------------------------------------------------------------------------

interface Artifact {
  path: string;
  value: unknown;
}

function reshape(d: RawData): Artifact[] {
  const profileLines = d.profile.map(([kind, text]) => ({
    kind: kind === '' ? 'body' : kind,
    // Kept as a placeholder. Composing the counts here would store them twice,
    // and a second copy of a number is how the original drift happened.
    text,
    derived: text === STATS_SENTINEL ? 'stats-line' : undefined,
  }));

  return [
    {
      path: 'profile.json',
      value: {
        $comment: 'Extracted from index.html by tools/extract-portfolio-data.mts. The single source of the three contribution counts.',
        handle: 'thc1006',
        name: { en: 'Hsiu-Chi Tsai', zh: '蔡秀吉' },
        affiliation: 'National Yang Ming Chiao Tung University — Computer Science',
        stats: d.stats,
        lines: profileLines,
      },
    },
    {
      path: 'contributions.json',
      value: {
        $comment: 'Top merged-PR counts per repository. A TOP LIST, not the full set: the rows deliberately do not sum to stats.merged. The cncf flag comes from the NYCU CS ledger buckets, never from a keyword regex.',
        foundations: { cncf: { label: d.cncf[0], merged: d.cncf[1], repositories: d.cncf[2] } },
        top: d.contribTop.map(([repository, merged, isCncf]) => ({
          repository,
          merged,
          cncf: isCncf === 1,
        })),
      },
    },
    {
      path: 'publications.json',
      value: {
        $comment: 'total is the authoritative publication count. It is checked against entries.length at extraction time: two numbers that must agree are exactly how the 115-to-148 contribution drift happened, so they are never allowed to disagree silently. featured is the short list the terminal shows before -Full.',
        total: d.pubTotal,
        entries: d.pubsFull.map((p) => ({
          year: p.y,
          status: p.st,
          venue: p.venue,
          title: p.title,
          identifier: p.id === '' ? null : p.id,
          authors: p.au,
        })),
        featured: d.publications.map(([venue, title, status]) => ({ venue, title, status })),
      },
    },
    {
      path: 'honors.json',
      value: {
        $comment: 'Awards and honours, newest first.',
        awards: d.awards.map(([year, name]) => ({ year, name })),
      },
    },
    {
      path: 'advisories.json',
      value: {
        $comment: 'Published security advisories where the reporter is credited by name.',
        advisories: d.advisories.map((a) => ({
          id: a.id,
          repository: a.repo,
          severity: a.sev,
          role: a.role,
          published: a.pub,
          foundation: a.fdn,
          fixedIn: a.fix,
          summary: a.what,
          url: a.href,
          bulletin: a.bul === '' ? null : a.bul,
        })),
      },
    },
    {
      path: 'projects.json',
      value: {
        $comment: 'Projects and the year timeline.',
        projects: d.projects.map(([name, focus]) => ({ name, focus })),
        timeline: d.timeline.map(([year, highlights]) => ({ year, highlights })),
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const KNOWN_FLAGS = new Set(['--check']);

function main(): void {
  const argv = process.argv.slice(2);
  const unknown = argv.filter((a) => !KNOWN_FLAGS.has(a));
  if (unknown.length > 0) {
    process.stderr.write(
      `\n  unknown option(s): ${unknown.join(', ')}\n  known: ${[...KNOWN_FLAGS].join(', ')}\n\n`,
    );
    process.exitCode = 2;
    return;
  }

  const raw = extractRawData();
  const artifacts = reshape(raw);
  const check = argv.includes('--check');

  if (check) {
    const drift = artifacts.filter((a) => {
      const p = join(DATA_DIR, a.path);
      if (!existsSync(p)) return true;
      return readFileSync(p, 'utf8').replace(/\r\n/g, '\n') !== serialise(a.value);
    });
    if (drift.length > 0) {
      process.stderr.write(
        `\n  extracted portfolio data is out of date:\n${drift.map((a) => `    - src/data/${a.path}`).join('\n')}\n` +
          '\n  index.html changed. Run: npm run data\n\n',
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`  portfolio data is in sync (${artifacts.length} files).\n`);
    return;
  }

  mkdirSync(DATA_DIR, { recursive: true });
  for (const a of artifacts) writeFileSync(join(DATA_DIR, a.path), serialise(a.value), 'utf8');

  process.stdout.write(
    `  wrote ${artifacts.length} data files: ` +
      `${raw.stats.merged} merged PRs, ${raw.contribTop.length} top repos, ` +
      `${raw.pubsFull.length}/${raw.pubTotal} publications, ${raw.advisories.length} advisories, ` +
      `${raw.awards.length} awards\n`,
  );
}

const serialise = (v: unknown): string => JSON.stringify(v, null, 2) + '\n';

main();
