/**
 * verify-release-truth.mts — the only thing in this repo allowed to decide what
 * "the latest PowerShell" means.
 *
 * Why this exists
 * ---------------
 * The previous site hardcoded `PowerShell 7.6.5` in a banner string. That is not
 * a version, it is a rumour: nothing checks it, nothing dates it, and it rots
 * silently the moment upstream ships. The obvious replacements are also rumours —
 * a docs page can name a version no release backs, a search engine can index a
 * Releases page months stale, and a release tag can pin an SDK that .NET itself
 * has moved past.
 *
 * Version truth is not one string. It is five axes that drift independently:
 *
 *   1. Which PowerShell releases EXIST            GitHub Releases API
 *   2. Which commit a tag really IS               GitHub tag deref (annotated!)
 *   3. Which .NET SDK a release BUILT ON          global.json at that tag
 *   4. Which RUNTIME that SDK ships               .NET per-channel releases.json
 *   5. What .NET has actually SHIPPED, and        .NET releases-index.json
 *      whether that channel is LTS or STS
 *
 * ...plus documentation, which describes 1-5 and can be wrong about any of them.
 *
 * The governing rule, quoted from the PowerShell Support Lifecycle doc:
 *
 *     "An LTS release of PowerShell is an LTS release of .NET."
 *
 * So LTS status is DERIVED (does this release's .NET channel say release-type
 * "lts"?) and cross-checked against PowerShell's own declaration, rather than
 * hardcoded as "7.6" — which silently becomes false at the next LTS.
 *
 * Traps this file exists to avoid, each of which produced a wrong answer during
 * development and would otherwise have shipped silently:
 *
 *   TRAP A — SDK is not runtime.
 *     v7.6.5 pins SDK 10.0.303; the docs say "built on the .NET 10.0.11 runtime".
 *     Both are true: SDK 10.0.303 ships runtime 10.0.11. Comparing an SDK against
 *     a runtime is a category error that happens to look fine when majors match.
 *     The two cannot be converted by string editing: SDK 10.0.100-preview.3.25201.16
 *     ships runtime 10.0.0-preview.3.25171.5 — different build numbers entirely.
 *     Always read sdks[].runtime-version.
 *
 *   TRAP B — SDK feature bands are parallel, not sequential.
 *     .NET release 10.0.11 ships THREE SDKs at once: 10.0.400, 10.0.303, 10.0.111,
 *     all carrying runtime-version 10.0.11. Bands are independently-serviced
 *     trains of the SAME runtime. "10.0.303 is behind 10.0.400" is false.
 *     Lag is measured on RUNTIME versions only.
 *
 *   TRAP C — the docs name the wrong axis.
 *     The 7.7 doc says "built on the .NET 11.0.100-preview.6 runtime", but that is
 *     the SDK; the runtime is 11.0.0-preview.6. Prose is ranked last for exactly
 *     this reason.
 *
 *   TRAP D — rc is not preview.
 *     PowerShell ships an rc before every GA (v7.6.0-rc.1, v7.5.0-rc.1, ...).
 *     Folding rc into preview makes 7.6.0-rc.1 compare as OLDER than
 *     7.6.0-preview.4, which flips an error/warning branch during precisely the
 *     window when the answer matters most.
 *
 *   TRAP E — the releases feed is not sorted by version or publish date.
 *     GitHub orders by created_at. v7.6.5 (published 16:57) is listed BEFORE
 *     v7.5.10 (published 16:58). Taking .find() on feed order is not "newest".
 *
 *   TRAP F — a source that cannot be evaluated must not degrade to `continue`.
 *     Every "I could not check this" path raises a discrepancy. A verifier that
 *     goes green because its own parser broke, or because a field was renamed, is
 *     worse than no verifier — it is the original hardcoded banner, one level up.
 *
 * Source precedence (normative — a lower-precedence source may raise a
 * discrepancy but may NEVER override a higher one):
 *
 *   1  GitHub Release API              does this release exist, when, prerelease?
 *   2  GitHub tag object -> commit     what commit is it, really?
 *   3  Files at that tag (global.json) what did it actually build against?
 *   4  .NET release metadata           what runtime is that, and is it LTS?
 *   5  Microsoft Learn docs            what does the documentation claim?
 *   6  Team blog / roadmap             intent only, never a fact about a release
 *
 * PowerShell's own tools/metadata.json sits at precedence 1 for CLASSIFICATION
 * (which tags are LTS) but is never read as evidence of EXISTENCE: it carries
 * NextReleaseTag, which names a tag that does not exist yet.
 *
 * Usage:
 *   node tools/verify-release-truth.mts --check    verify the committed lockfile
 *                                                  still matches reality (network)
 *   node tools/verify-release-truth.mts --write    regenerate the lockfile (network)
 *   node tools/verify-release-truth.mts --offline  verify the committed lockfile is
 *                                                  coherent and untampered (no network)
 *   node tools/verify-release-truth.mts --json     machine-readable report
 *
 * --check and --offline answer different questions, which is why both exist:
 * --check is the scheduled observer's question ("has upstream moved?") and needs
 * the network; --offline is required CI's question ("is the artifact we committed
 * a coherent, untampered, error-free record?") and must never need it. Putting a
 * live-network gate in required CI made an unrelated `403 rate limit exceeded`
 * fail pull requests that touched nothing near it.
 *
 * Exit codes are distinct on purpose so CI can tell the cases apart:
 *   0  clean
 *   1  drift, or an error-severity discrepancy (upstream moved / sources disagree)
 *   2  the tool could not do its job (network, rate limit, shape change, or a
 *      lockfile that is missing, malformed, hand-edited or internally incoherent)
 *   3  an unexpected internal error (a bug in this file)
 *
 * Env: GITHUB_TOKEN — optional locally (60 req/hr per IP), REQUIRED in CI and on
 * any shared/NAT'd network, where the anonymous budget is shared and exhausted.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ajv2020 from 'ajv/dist/2020.js';
import ajvFormats from 'ajv-formats';

import {
  parseVersion,
  compareVersions,
  featureBand,
  versionsAgree,
  byCodepoint,
} from './version.mts';
import type { ParsedVersion } from './version.mts';
import { parseDocsClaim, parseLifecycleTable } from './docs-claim.mts';
import type { LifecycleTable } from './docs-claim.mts';
import { narrow } from './upstream-schemas.mts';
import type {
  DotnetChannelFile,
  DotnetIndex,
  DotnetIndexEntry,
  GhPullRequest,
  GhRelease,
  PowerShellMetadata,
} from './upstream-schemas.mts';
import { POWERSHELL_77_CHANGES } from '../compat/deltas/powershell-77-changes.source.mts';

// ajv and ajv-formats are CommonJS. Under Node's ESM loader a default import of
// a CJS module yields module.exports — which IS the constructor here — but the
// NodeNext type view models it as a namespace carrying `.default`. Normalise once.
type AjvValidator = ((data: unknown) => boolean) & {
  errors?: Array<{ instancePath?: string; message?: string }> | null;
};
type AjvInstance = { compile: (schema: object) => AjvValidator };
type AjvCtor = new (opts: Record<string, unknown>) => AjvInstance;

const Ajv = ((ajv2020 as unknown as { default?: unknown }).default ??
  ajv2020) as unknown as AjvCtor;
const addFormats = ((ajvFormats as unknown as { default?: unknown }).default ??
  ajvFormats) as (ajv: AjvInstance) => void;

const TOOL = 'verify-release-truth.mts';
const TOOL_VERSION = '3.0.0';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const LOCKFILE = join(REPO, 'compat', 'upstream', 'releases.lock.json');
const SCHEMA = join(REPO, 'compat', 'schemas', 'release-truth.schema.json');

const GH = 'https://api.github.com/repos/PowerShell/PowerShell';
const RAW = 'https://raw.githubusercontent.com/PowerShell/PowerShell';
const METADATA_URL = `${RAW}/master/tools/metadata.json`;
const DOTNET_INDEX =
  'https://builds.dotnet.microsoft.com/dotnet/release-metadata/releases-index.json';
const DOCS_BASE =
  'https://raw.githubusercontent.com/MicrosoftDocs/PowerShell-Docs/main/reference/docs-conceptual';
const DOCS_WHATS_NEW = `${DOCS_BASE}/whats-new`;
const LIFECYCLE_URL = `${DOCS_BASE}/install/PowerShell-Support-Lifecycle.md`;

const FETCH_TIMEOUT_MS = 15_000;
const FETCH_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

type Severity = 'info' | 'warning' | 'error';
type Channel = 'lts' | 'sts' | 'preview' | 'servicing';

type SourceKind =
  | 'github-release-api'
  | 'github-metadata'
  | 'github-tag-object'
  | 'github-tag-file'
  | 'github-pull-request'
  | 'dotnet-release-index'
  | 'dotnet-channel-releases'
  | 'microsoft-learn-docs'
  | 'team-blog';

interface SourceRecord {
  precedence: number;
  kind: SourceKind;
  url: string;
  fetchedAt: string;
  digest: string;
}

interface DotnetBuild {
  sdk: string;
  runtime: string | null;
  featureBand: string | null;
  channelVersion: string | null;
  releaseType: string | null;
  supportPhase: string | null;
  eolDate: string | null;
}

interface ReleaseRecord {
  tag: string;
  version: string;
  channel: Channel;
  prerelease: boolean;
  publishedAt: string;
  commitSha: string;
  tagObjectSha: string | null;
  dotnet: DotnetBuild;
  supportedUntil: string | null;
  snapshotDigest: string;
}

interface Discrepancy {
  severity: Severity;
  code: string;
  message: string;
  expected?: unknown;
  actual?: unknown;
  sources?: string[];
}

interface DotnetChannel {
  channelVersion: string;
  latestRelease: string;
  latestRuntime: string;
  latestSdk: string;
  releaseType: string;
  supportPhase: string;
  eolDate: string | null;
}

/**
 * A resolved `upstreamPr:` citation.
 *
 * compat/deltas/powershell-77-changes.source.mts cites a PR number for every
 * behaviour it claims 7.7 changes, and generate-compatibility-profile.mts
 * required the field to be non-null and stopped there. Setting one to 99999999
 * regenerated the profiles and the published explorer with all eleven gates
 * green, and `pull/99999999` appeared in the shipped HTML. All 13 real
 * citations were independently verified to exist and to be merged -- which is
 * the check the repository never performed. This is that check, done once here
 * where the authenticated GitHub client and the lockfile already are.
 */
interface CitedPullRequest {
  number: number;
  title: string;
  mergeCommitSha: string;
  mergedAt: string;
}

interface Lockfile {
  schemaVersion: 1;
  generatedAt: string;
  generator: { tool: string; version: string };
  sources: SourceRecord[];
  citations: {
    source: string;
    /** Only PRs that exist AND are merged. A citation that resolves to neither
     *  raises an error-severity discrepancy and is absent, so the profile
     *  generator's assertion fails rather than passing on a fabricated number. */
    pullRequests: CitedPullRequest[];
  };
  channels: {
    lts: string;
    ltsPrevious: string[];
    preview: string;
    edge: string | null;
    next: string | null;
  };
  releases: ReleaseRecord[];
  dotnet: { channels: DotnetChannel[] };
  discrepancies: Discrepancy[];
}

/** The tool could not do its job. Distinct from "did the job, found a problem". */
class ToolFailure extends Error {}

/**
 * An HTTP answer we must respect, carrying the status.
 *
 * A 404 is not a network problem: it is upstream telling us the thing does not
 * exist, which for a citation is a FINDING and not a reason to give up. The
 * status has to survive the throw for the caller to tell the two apart.
 */
class HttpError extends ToolFailure {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// fetch plumbing
// ---------------------------------------------------------------------------

const sources = new Map<string, SourceRecord>();
const discrepancies: Discrepancy[] = [];

function sha256(text: string): string {
  return 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex');
}

function note(d: Discrepancy): void {
  discrepancies.push(d);
}

const bodyCache = new Map<string, string>();

/**
 * Digest a canonical PROJECTION of a source rather than its raw bytes.
 *
 * The GitHub Releases response is not stable across two requests a second apart:
 * every release carries assets[].download_count and reactions, which tick
 * continuously. Digesting raw bytes made --check report drift on every run, and
 * a verifier that always cries wolf is one everybody learns to ignore.
 *
 * The digest must attest to the facts a conclusion rests on — INCLUDING order,
 * where order is consumed — but not to counters nobody reads.
 */
type Canonicaliser = (body: string) => string;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve_) => setTimeout(resolve_, ms));

async function get(
  url: string,
  precedence: number,
  kind: SourceKind,
  canonicalise?: Canonicaliser,
): Promise<string> {
  const cached = bodyCache.get(url);
  if (cached !== undefined) return cached;

  const headers: Record<string, string> = {
    'user-agent': 'hctsai1006-browser-workstation-release-verifier',
    accept: url.startsWith('https://api.github.com')
      ? 'application/vnd.github+json'
      : 'text/plain,*/*',
  };
  const token = process.env['GITHUB_TOKEN'];
  if (token && url.startsWith('https://api.github.com')) {
    headers['authorization'] = `Bearer ${token}`;
  }

  let lastProblem = '';
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      // Without a timeout a hung TLS connection blocks CI until the job limit.
      res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (cause) {
      lastProblem = `network error: ${(cause as Error).message}`;
      if (attempt < FETCH_ATTEMPTS) {
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      throw new ToolFailure(`${lastProblem} for ${url}`);
    }

    if (res.ok) {
      const body = await res.text();
      bodyCache.set(url, body);
      let digestSubject = body;
      if (canonicalise) {
        try {
          digestSubject = canonicalise(body);
        } catch (cause) {
          throw new ToolFailure(
            `could not canonicalise ${url} for digesting: ${(cause as Error).message}`,
          );
        }
      }
      // Keyed by URL so a re-fetch cannot produce a duplicate row, and therefore
      // cannot produce false drift.
      sources.set(url, {
        precedence,
        kind,
        url,
        fetchedAt: new Date().toISOString(),
        digest: sha256(digestSubject),
      });
      return body;
    }

    // 5xx and 429 are transient; everything else is a real answer we must respect.
    const transient = res.status >= 500 || res.status === 429;
    lastProblem = `${res.status} ${res.statusText}`;
    if (!transient || attempt === FETCH_ATTEMPTS) {
      const rateLimited =
        res.status === 403 || res.status === 429
          ? '\n  GitHub rate limit? GITHUB_TOKEN is required in CI and on shared networks.'
          : '';
      throw new HttpError(`fetch failed: ${lastProblem} for ${url}${rateLimited}`, res.status);
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** (attempt - 1));
  }

  throw new ToolFailure(`fetch failed after ${FETCH_ATTEMPTS} attempts (${lastProblem}) for ${url}`);
}

/**
 * Fetch, parse, and NARROW to a validated shape. The narrowing step is the point:
 * `JSON.parse(x) as T` is an unchecked assertion about a third party's payload,
 * and when it becomes false the failure is silent.
 */
async function getShape<K extends Parameters<typeof narrow>[0]>(
  url: string,
  precedence: number,
  kind: SourceKind,
  shape: K,
  canonicalise?: Canonicaliser,
): Promise<Extract<ReturnType<typeof narrow<K>>, { ok: true }>['value']> {
  const text = await get(url, precedence, kind, canonicalise);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new ToolFailure(`invalid JSON from ${url}: ${(cause as Error).message}`);
  }
  const result = narrow(shape, parsed);
  if (!result.ok) {
    throw new ToolFailure(
      `upstream shape changed at ${url}\n${result.problem}\n` +
        '  Refusing to continue: a renamed field would silently disable a check.',
    );
  }
  return result.value;
}

/**
 * The docs are prose under active editorial churn: the 7.7 What's-New file has
 * had eight commits since April, including "Fix typo in title", and the
 * lifecycle doc ten. Digesting whole files makes an unrelated typo fix look like
 * upstream drift — and `truth:check` runs on every push and pull request, so an
 * unrelated PR goes red because Microsoft fixed a typo. A gate with a
 * predictable false alarm is a gate that gets switched off. Digest only the
 * claims actually consumed.
 */
/**
 * A pull-request response embeds the whole repository object, and that object
 * carries stargazers_count, forks, watchers, open_issues and pushed_at — all of
 * which tick continuously on PowerShell/PowerShell. Digesting the raw body made
 * every one of the fourteen citation sources report drift within minutes of
 * being written, which is the same wolf-crying the releases feed already taught
 * this file to avoid. Digest only the fields the citation check consumes.
 */
const canonicalisePullRequest: Canonicaliser = (body) => {
  const pr = JSON.parse(body) as Record<string, unknown>;
  return JSON.stringify([
    pr['number'],
    pr['title'],
    pr['state'],
    pr['merged_at'],
    pr['merge_commit_sha'],
    pr['html_url'],
  ]);
};

const canonicaliseDocs: Canonicaliser = (body) => JSON.stringify(parseDocsClaim(body));

const canonicaliseLifecycle: Canonicaliser = (body) =>
  JSON.stringify([...parseLifecycleTable(body).rows.entries()].sort());

/** .NET metadata is republished on the monthly patch cadence; project it too. */
const canonicaliseDotnetIndex: Canonicaliser = (body) => {
  const parsed = JSON.parse(body) as DotnetIndex;
  return JSON.stringify(
    parsed['releases-index'].map((c) => [
      c['channel-version'],
      c['latest-release'],
      c['latest-runtime'],
      c['latest-sdk'],
      c['release-type'],
      c['support-phase'],
      c['eol-date'] ?? null,
    ]),
  );
};

const canonicaliseDotnetChannel: Canonicaliser = (body) => {
  const parsed = JSON.parse(body) as DotnetChannelFile;
  return JSON.stringify(
    parsed.releases.map((r) => [
      r['release-version'],
      r.runtime?.version ?? null,
      [...(r.sdks ?? []), ...(r.sdk ? [r.sdk] : [])]
        .map((sdk) => [sdk.version, sdk['runtime-version'] ?? null])
        .sort(),
    ]),
  );
};

/**
 * Project the Releases feed to the fields consumed — INCLUDING the ordinal.
 * Order is load-bearing here only insofar as it is recorded; selection no longer
 * depends on it (TRAP E), but if upstream reorders the feed we still want the
 * digest to change, because that is a fact about the source we relied on.
 */
const canonicaliseReleases: Canonicaliser = (body) => {
  const parsed: unknown = JSON.parse(body);
  if (!Array.isArray(parsed)) throw new Error('releases payload is not an array');
  return JSON.stringify(
    (parsed as GhRelease[]).map((r, i) => ({
      i,
      tag_name: r.tag_name,
      draft: r.draft,
      prerelease: r.prerelease,
      published_at: r.published_at,
    })),
  );
};

/**
 * Newest first, by version. Never by feed order (TRAP E).
 *
 * Unrankable tags are EXCLUDED, not sorted by some fallback. A comparator that
 * falls back to codepoint order for unparseable tags is intransitive — it mixes
 * two incompatible orderings — so the "newest" it reports depends on the input
 * permutation, which is TRAP E creeping back in through the fix for TRAP E.
 * Excluding them keeps the comparator a total order over what remains, and the
 * exclusion is reported rather than silent (TRAP F).
 */
/**
 * Is this release still supported, and how close is the edge?
 *
 * Extracted as a pure function so the BOUNDARY can be tested. It used to be
 * three lines inline behind `Date.now()`, and the bug it carried was invisible
 * for exactly that reason: nothing could ask it about a specific instant.
 *
 * `expired` is a timestamp comparison. `daysLeft` is a rounded number for
 * humans and for the horizon test, and is deliberately NOT what decides
 * support — a display rounding deciding a support question is what reported a
 * release out of support up to twelve hours early.
 */
export function classifySupport(
  supportedUntil: string,
  now: number,
  horizonDays: number,
): { expired: boolean; approaching: boolean; daysLeft: number; remainingMs: number } | null {
  const deadline = Date.parse(`${supportedUntil}T00:00:00Z`);
  if (!Number.isFinite(deadline)) return null;
  const remainingMs = deadline - now;
  const expired = remainingMs <= 0;
  const daysLeft = Math.round(remainingMs / 86_400_000);
  return { expired, approaching: !expired && daysLeft <= horizonDays, daysLeft, remainingMs };
}

function newestFirst(releases: readonly GhRelease[]): GhRelease[] {
  const rankable: Array<{ release: GhRelease; parsed: ParsedVersion }> = [];
  const unrankable: string[] = [];

  for (const r of releases) {
    const parsed = parseVersion(r.tag_name.replace(/^v/, ''));
    if (parsed === null) unrankable.push(r.tag_name);
    else rankable.push({ release: r, parsed });
  }

  if (unrankable.length > 0) {
    note({
      severity: 'error',
      code: 'unrankable-release-tag',
      message: `Cannot rank ${unrankable.length} release tag(s): ${unrankable.slice(0, 5).join(', ')}${unrankable.length > 5 ? ', ...' : ''}. They were excluded from channel selection, so a newer release may have been missed. The version parser needs to learn this shape.`,
      actual: unrankable,
      sources: [`${GH}/releases`],
    });
  }

  return rankable.sort((a, b) => -compareVersions(a.parsed, b.parsed)).map((x) => x.release);
}

// ---------------------------------------------------------------------------
// GitHub resolution
// ---------------------------------------------------------------------------

/**
 * PowerShell tags are ANNOTATED, so `git/ref/tags/<tag>` returns the tag object's
 * own sha, not the commit. Dereference one more hop. Getting this wrong yields a
 * sha that looks plausible, exists, and points at nothing you can check out.
 */
async function resolveTagToCommit(
  tag: string,
): Promise<{ commitSha: string; tagObjectSha: string | null }> {
  const enc = encodeURIComponent(tag);
  const refText = await get(`${GH}/git/ref/tags/${enc}`, 2, 'github-tag-object');
  const ref = JSON.parse(refText) as { object?: { sha?: string; type?: string } };
  const sha = ref.object?.sha;
  const type = ref.object?.type;
  if (typeof sha !== 'string' || typeof type !== 'string') {
    throw new ToolFailure(`unexpected git ref shape for ${tag}`);
  }
  if (type === 'commit') return { commitSha: sha, tagObjectSha: null };

  const tagText = await get(`${GH}/git/tags/${encodeURIComponent(sha)}`, 2, 'github-tag-object');
  const tagObj = JSON.parse(tagText) as { object?: { sha?: string } };
  const commitSha = tagObj.object?.sha;
  if (typeof commitSha !== 'string') {
    throw new ToolFailure(`could not dereference annotated tag ${tag}`);
  }
  return { commitSha, tagObjectSha: sha };
}

async function readSdkPin(tag: string): Promise<string> {
  const raw = await get(`${RAW}/${encodeURIComponent(tag)}/global.json`, 3, 'github-tag-file');
  let parsed: { sdk?: { version?: string } };
  try {
    parsed = JSON.parse(raw) as { sdk?: { version?: string } };
  } catch (cause) {
    throw new ToolFailure(`global.json at ${tag} is not valid JSON: ${(cause as Error).message}`);
  }
  const version = parsed.sdk?.version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new ToolFailure(`no sdk.version in global.json at ${tag}`);
  }
  return version;
}

// ---------------------------------------------------------------------------
// .NET metadata
// ---------------------------------------------------------------------------

interface SdkResolution {
  runtime: string | null;
  /** Why runtime is null, when it is. Distinguishes the two failure modes. */
  reason: 'ok' | 'sdk-not-listed' | 'no-runtime-version' | 'no-such-channel';
}

class DotnetMetadata {
  // Explicit fields rather than constructor parameter properties: Node runs this
  // file with type-stripping only, which cannot erase parameter properties.
  // `erasableSyntaxOnly` in tsconfig keeps the repo inside that subset.
  readonly channels: DotnetChannel[];
  readonly entries: DotnetIndexEntry[];

  private constructor(channels: DotnetChannel[], entries: DotnetIndexEntry[]) {
    this.channels = channels;
    this.entries = entries;
  }

  static async load(): Promise<DotnetMetadata> {
    const idx: DotnetIndex = await getShape(
      DOTNET_INDEX,
      4,
      'dotnet-release-index',
      'dotnet-index',
      canonicaliseDotnetIndex,
    );
    const entries = idx['releases-index'];
    const channels: DotnetChannel[] = entries.map((c) => ({
      channelVersion: c['channel-version'],
      latestRelease: c['latest-release'],
      latestRuntime: c['latest-runtime'],
      latestSdk: c['latest-sdk'],
      releaseType: c['release-type'],
      supportPhase: c['support-phase'],
      // Absent (not null) on preview channels — do not require it.
      eolDate: c['eol-date'] ?? null,
    }));
    return new DotnetMetadata(channels, entries);
  }

  channelFor(sdkVersion: string): DotnetChannel | null {
    const p = parseVersion(sdkVersion);
    if (p === null) return null;
    const key = `${p.major}.${p.minor}`;
    return this.channels.find((c) => c.channelVersion === key) ?? null;
  }

  /**
   * Resolve an exact SDK version to the runtime it ships.
   *
   * Reads sdks[].runtime-version, which is the authoritative link, rather than
   * the release's runtime.version. They agree today, but the per-SDK field is the
   * one carrying the semantics — and previews prove the two version spaces are
   * genuinely independent: SDK 10.0.100-preview.3.25201.16 ships runtime
   * 10.0.0-preview.3.25171.5. No string transformation relates them.
   */
  async runtimeForSdk(sdkVersion: string): Promise<SdkResolution> {
    const p = parseVersion(sdkVersion);
    if (p === null) return { runtime: null, reason: 'no-such-channel' };
    const key = `${p.major}.${p.minor}`;
    const entry = this.entries.find((c) => c['channel-version'] === key);
    if (entry === undefined) return { runtime: null, reason: 'no-such-channel' };

    const file: DotnetChannelFile = await getShape(
      entry['releases.json'],
      4,
      'dotnet-channel-releases',
      'dotnet-channel',
      canonicaliseDotnetChannel,
    );

    for (const rel of file.releases) {
      const candidates = [...(rel.sdks ?? []), ...(rel.sdk ? [rel.sdk] : [])];
      const hit = candidates.find((s) => s.version === sdkVersion);
      if (hit === undefined) continue;
      const runtime = hit['runtime-version'] ?? rel.runtime?.version ?? null;
      return runtime === null
        ? { runtime: null, reason: 'no-runtime-version' }
        : { runtime, reason: 'ok' };
    }
    return { runtime: null, reason: 'sdk-not-listed' };
  }
}

// ---------------------------------------------------------------------------
// docs cross-checks (precedence 5)
// ---------------------------------------------------------------------------

interface DocsClaim extends ReturnType<typeof parseDocsClaim> {
  url: string;
}

async function readDocsClaim(docSlug: string): Promise<DocsClaim> {
  const url = `${DOCS_WHATS_NEW}/What-s-New-in-PowerShell-${docSlug}.md`;
  return { ...parseDocsClaim(await get(url, 5, 'microsoft-learn-docs', canonicaliseDocs)), url };
}

function crossCheckDocs(rel: ReleaseRecord, claim: DocsClaim): void {
  if (claim.builtOnSentences > 1) {
    // With more than one such sentence the first wins, which may be a historical
    // section rather than the current release — producing a false
    // "docs-version-behind-release" that looks like an upstream problem.
    note({
      severity: 'warning',
      code: 'docs-ambiguous-claim',
      message: `${claim.url} contains ${claim.builtOnSentences} "is built on" sentences; the first was used and may not describe the current release.`,
      actual: claim.builtOnSentences,
      sources: [claim.url],
    });
  }
  if (claim.psVersion === null) {
    note({
      severity: 'error',
      code: 'docs-parse-failed',
      message: `Could not extract a PowerShell version from ${claim.url}. The docs changed shape and this cross-check is now blind — fix the parser rather than trusting the green result.`,
      sources: [claim.url],
    });
  } else if (claim.psVersion !== rel.version) {
    const claimed = parseVersion(claim.psVersion);
    const actual = parseVersion(rel.version);
    const ahead = claimed !== null && actual !== null && compareVersions(claimed, actual) > 0;
    note({
      severity: ahead ? 'error' : 'warning',
      code: ahead ? 'docs-version-ahead-of-release' : 'docs-version-behind-release',
      message: ahead
        ? `Docs describe PowerShell ${claim.psVersion}, but no such release exists — newest is ${rel.version}. Documentation is not evidence that a release shipped.`
        : `Docs still describe PowerShell ${claim.psVersion} while ${rel.version} has shipped.`,
      expected: rel.version,
      actual: claim.psVersion,
      sources: [claim.url, `${GH}/releases`],
    });
  }

  if (claim.dotnetVersion === null) {
    note({
      severity: 'warning',
      code: 'docs-dotnet-parse-failed',
      message: `No ".NET <version> runtime" sentence found in ${claim.url}; cannot cross-check what ${rel.tag} was built on.`,
      sources: [claim.url],
    });
    return;
  }

  const matchesSdk = versionsAgree(claim.dotnetVersion, rel.dotnet.sdk);
  const matchesRuntime =
    rel.dotnet.runtime !== null && versionsAgree(claim.dotnetVersion, rel.dotnet.runtime);

  if (matchesRuntime) return; // docs said "runtime" and named the runtime. Correct.

  if (matchesSdk) {
    // TRAP C. Harmless to a reader who knows the difference, actively misleading
    // to one who does not — and precisely how "PowerShell 7.7.0-preview.6" gets
    // invented by someone reading the sentence too quickly.
    note({
      severity: 'warning',
      code: 'docs-axis-confusion',
      message: `Docs call .NET ${claim.dotnetVersion} the "${claim.dotnetNoun ?? 'runtime'}" of ${rel.version}, but that is the SDK version. The runtime is ${rel.dotnet.runtime ?? 'unresolved'}. SDK and runtime are different version spaces.`,
      expected: rel.dotnet.runtime,
      actual: claim.dotnetVersion,
      sources: [claim.url, `${RAW}/${rel.tag}/global.json`],
    });
    return;
  }

  note({
    severity: 'warning',
    code: 'docs-dotnet-mismatch',
    message: `Docs say ${rel.version} is built on .NET ${claim.dotnetVersion}, but ${rel.tag} pins SDK ${rel.dotnet.sdk} (runtime ${rel.dotnet.runtime ?? 'unresolved'}).`,
    expected: rel.dotnet.runtime ?? rel.dotnet.sdk,
    actual: claim.dotnetVersion,
    sources: [claim.url, `${RAW}/${rel.tag}/global.json`],
  });
}

/**
 * The support-lifecycle doc carries a parseable table of every 7.x line, whether
 * it is LTS, and its end-of-support date. It is an INDEPENDENT assertion of the
 * same facts derived from .NET metadata, so disagreement is informative.
 *
 * Row shape: `| PowerShell 7.6 (LTS)     | 18-Mar-2026  |  14-Nov-2028   | [.NET 10.0][07] |`
 */
async function readLifecycle(): Promise<LifecycleTable> {
  return parseLifecycleTable(
    await get(LIFECYCLE_URL, 5, 'microsoft-learn-docs', canonicaliseLifecycle),
  );
}

function crossCheckLifecycle(rel: ReleaseRecord, rows: LifecycleTable['rows']): void {
  const p = parseVersion(rel.version);
  if (p === null) return;
  const key = `${p.major}.${p.minor}`;
  const row = rows.get(key);
  if (row === undefined) {
    note({
      severity: 'warning',
      code: 'lifecycle-row-missing',
      message: `The support-lifecycle doc has no row for PowerShell ${key}; its LTS status and end-of-support cannot be independently cross-checked.`,
      sources: [LIFECYCLE_URL],
    });
    return;
  }

  const derivedLts = rel.channel === 'lts';
  if (row.isLts !== derivedLts) {
    note({
      severity: 'warning',
      code: 'lifecycle-lts-disagrees',
      message: `The lifecycle doc marks PowerShell ${key} as ${row.isLts ? 'LTS' : 'not LTS'}, but it was derived as ${derivedLts ? 'LTS' : 'not LTS'} from its .NET channel (${rel.dotnet.channelVersion} / ${rel.dotnet.releaseType}).`,
      expected: derivedLts,
      actual: row.isLts,
      sources: [LIFECYCLE_URL, DOTNET_INDEX],
    });
  }

  if (
    row.endOfSupport !== null &&
    rel.supportedUntil !== null &&
    row.endOfSupport !== rel.supportedUntil
  ) {
    note({
      severity: 'warning',
      code: 'lifecycle-eol-disagrees',
      message: `The lifecycle doc gives PowerShell ${key} an end-of-support of ${row.endOfSupport}, but its .NET channel says ${rel.supportedUntil}.`,
      expected: rel.supportedUntil,
      actual: row.endOfSupport,
      sources: [LIFECYCLE_URL, DOTNET_INDEX],
    });
  }
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

async function describeRelease(
  r: GhRelease,
  dotnet: DotnetMetadata,
): Promise<ReleaseRecord> {
  const { commitSha, tagObjectSha } = await resolveTagToCommit(r.tag_name);
  const sdk = await readSdkPin(r.tag_name);
  const ch = dotnet.channelFor(sdk);
  const resolution = await dotnet.runtimeForSdk(sdk);

  if (resolution.runtime === null) {
    const why =
      resolution.reason === 'sdk-not-listed'
        ? `SDK ${sdk} is not listed in the .NET ${ch?.channelVersion ?? '?'} channel releases; it may be an internal or unreleased build.`
        : resolution.reason === 'no-runtime-version'
          ? `SDK ${sdk} was found in the .NET channel data but carries no runtime-version, and its release has no runtime version either.`
          : `No .NET channel matches SDK ${sdk}.`;
    note({
      // Error, not warning. The runtime is what every downstream check is
      // measured on: if it is null the lag check silently `continue`s and the
      // run goes green having verified nothing. upstream-schemas.mts promises
      // exactly this cannot happen; the promise was kept for latest-runtime
      // (required by the schema) and broken here, where runtime-version is
      // optional, so a rename produced all-null runtimes and exit 0.
      severity: 'error',
      code: 'sdk-runtime-unresolved',
      message: `${why} Runtime-based checks for ${r.tag_name} cannot run.`,
      actual: sdk,
      sources: [DOTNET_INDEX, `${RAW}/${r.tag_name}/global.json`],
    });
  }

  if (ch === null) {
    note({
      severity: 'error',
      code: 'dotnet-channel-unknown',
      message: `${r.tag_name} pins SDK ${sdk}, which maps to no known .NET channel. Support class and end-of-support cannot be derived.`,
      actual: sdk,
      sources: [DOTNET_INDEX],
    });
  }

  // "An LTS release of PowerShell is an LTS release of .NET" — the documented
  // rule, applied rather than restated.
  const channel: Channel = r.prerelease
    ? 'preview'
    : ch?.releaseType === 'lts'
      ? 'lts'
      : ch?.releaseType === 'sts'
        ? 'sts'
        : 'servicing';

  const dotnetBuild: DotnetBuild = {
    sdk,
    runtime: resolution.runtime,
    featureBand: featureBand(sdk),
    channelVersion: ch?.channelVersion ?? null,
    releaseType: ch?.releaseType ?? null,
    supportPhase: ch?.supportPhase ?? null,
    eolDate: ch?.eolDate ?? null,
  };

  return {
    tag: r.tag_name,
    version: r.tag_name.replace(/^v/, ''),
    channel,
    prerelease: r.prerelease,
    publishedAt: r.published_at,
    commitSha,
    tagObjectSha,
    dotnet: dotnetBuild,
    supportedUntil: ch?.eolDate ?? null,
    // Covers every derived field, so two lockfiles cannot share a digest while
    // disagreeing about the runtime.
    snapshotDigest: sha256(
      JSON.stringify([r.tag_name, commitSha, r.published_at, dotnetBuild, channel]),
    ),
  };
}

/**
 * Recompute a record's digest from the record itself, so a committed lockfile
 * can be checked for hand edits. Kept next to describeRelease deliberately: the
 * two expressions must stay in step, and separating them would let one drift.
 */
function snapshotOf(r: ReleaseRecord): string {
  return sha256(JSON.stringify([r.tag, r.commitSha, r.publishedAt, r.dotnet, r.channel]));
}

const CITATION_SOURCE = 'compat/deltas/powershell-77-changes.source.mts';

/**
 * Resolve every `upstreamPr:` citation in the curated 7.7 change list against
 * the GitHub pull-request API, once, and record what came back.
 *
 * The three outcomes are deliberately different, and each maps to a different
 * exit code, the same way this tool already separates drift from could-not-run:
 *
 *   merged             recorded in the lockfile. generate-compatibility-profile
 *                      asserts every citation appears here, so a number nobody
 *                      resolved cannot reach a published profile.
 *   404, or not merged  an error-severity discrepancy -> exit 1. The citation is
 *                      wrong; that is a finding, not a failure to check.
 *   anything else       a ToolFailure -> exit 2. We could not reach GitHub, and
 *                      "the check did not run" must never look like "the check
 *                      passed". Falling back to `continue` here is the exact
 *                      TRAP F this file is organised against.
 */
async function resolveCitations(): Promise<Lockfile['citations']> {
  // Every source, in every role. A record used to carry a single `upstreamPr`;
  // it now carries `sources[]`, because the explicit-`$false` family turned out
  // to be ten upstream PRs cited as one. A supporting citation is exactly the
  // kind that would otherwise never be resolved against GitHub.
  const cited = [...new Set(POWERSHELL_77_CHANGES.flatMap((c) => c.sources.map((s) => s.pr)))].sort(
    (a, b) => a - b,
  );
  const resolved: CitedPullRequest[] = [];

  for (const number of cited) {
    const url = `${GH}/pulls/${number}`;
    let pr: GhPullRequest;
    try {
      pr = await getShape(url, 1, 'github-pull-request', 'github-pull-request', canonicalisePullRequest);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        note({
          severity: 'error',
          code: 'cited-pr-does-not-exist',
          message: `${CITATION_SOURCE} cites upstream PR #${number}, which does not exist. A citation nobody can follow is not a citation.`,
          actual: number,
          sources: [url],
        });
        continue;
      }
      throw error;
    }

    if (pr.merged_at === null || pr.merge_commit_sha === null) {
      note({
        severity: 'error',
        code: 'cited-pr-not-merged',
        message: `${CITATION_SOURCE} cites upstream PR #${number} ("${pr.title}"), which is ${pr.state} and has never been merged. It cannot be evidence for a shipped behaviour change.`,
        actual: pr.state,
        sources: [pr.html_url],
      });
      continue;
    }

    resolved.push({
      number: pr.number,
      title: pr.title,
      mergeCommitSha: pr.merge_commit_sha,
      mergedAt: pr.merged_at,
    });
  }

  return { source: CITATION_SOURCE, pullRequests: resolved };
}

async function build(): Promise<Lockfile> {
  const dotnet = await DotnetMetadata.load();

  // --- axis 1: what releases actually exist -------------------------------
  const all: GhRelease[] = await getShape(
    `${GH}/releases?per_page=100`,
    1,
    'github-release-api',
    'github-releases',
    canonicaliseReleases,
  );
  const published = all.filter((r) => !r.draft);
  if (published.length === 0) throw new ToolFailure('no published releases returned');

  // Never trust feed order (TRAP E).
  const ordered = newestFirst(published);
  const newestPreview = ordered.find((r) => r.prerelease);
  const newestStable = ordered.find((r) => !r.prerelease);
  if (newestPreview === undefined) {
    throw new ToolFailure(
      'no prerelease found in the newest 100 releases; the preview channel cannot be resolved',
    );
  }

  // PowerShell's own channel declaration. First-party and machine-readable, so
  // LTS membership need not be hardcoded — a hardcode silently becomes false at
  // the next LTS. Read for CLASSIFICATION only, never existence: this file also
  // carries NextReleaseTag, naming a tag that does not exist.
  //
  // Deliberately NOT used: aka.ms/pwsh-buildinfo-lts. It looks first-party and
  // authoritative, but tracks an INSTALL CHANNEL and today returns v7.4.19 while
  // this file and the lifecycle doc both say v7.6.5 is the current LTS. Trusting
  // it would be wrong by a full release cycle.
  const meta: PowerShellMetadata = await getShape(
    METADATA_URL,
    1,
    'github-metadata',
    'powershell-metadata',
  );

  const declaredLtsTags = Array.isArray(meta.LTSReleaseTag)
    ? meta.LTSReleaseTag
    : [meta.LTSReleaseTag];
  const ltsTags = [...new Set(declaredLtsTags)];
  if (ltsTags.length !== declaredLtsTags.length) {
    // Without the dedupe the current LTS also lands in ltsPrevious, and one
    // release is recorded twice carrying the same snapshotDigest.
    note({
      severity: 'warning',
      code: 'duplicate-lts-declaration',
      message: `metadata.json lists the same LTS tag more than once (${declaredLtsTags.join(', ')}). Duplicates were ignored.`,
      actual: declaredLtsTags,
      sources: [METADATA_URL],
    });
  }

  // Every declared LTS is kept, not just the newest: two LTS lines are supported
  // concurrently (today v7.4.19 and v7.6.5), and discarding one leaves the
  // lockfile unable to answer "is 7.4 still supported?".
  const declaredPresent: GhRelease[] = [];
  for (const tag of ltsTags) {
    const found = published.find((r) => r.tag_name === tag);
    if (found === undefined) {
      // A first-party claim we cannot corroborate is a finding, not something to
      // silently drop.
      note({
        severity: 'warning',
        code: 'declared-lts-not-in-feed',
        message: `metadata.json declares ${tag} as LTS, but it does not appear in the newest 100 published releases. It cannot be corroborated.`,
        actual: tag,
        sources: [METADATA_URL, `${GH}/releases`],
      });
      continue;
    }
    declaredPresent.push(found);
  }
  if (declaredPresent.length === 0) {
    throw new ToolFailure(
      `metadata.json declares LTS ${ltsTags.join(', ')} but none appear in the published releases feed`,
    );
  }

  const ltsOrdered = newestFirst(declaredPresent);
  const currentLtsRelease = ltsOrdered[0];
  if (currentLtsRelease === undefined) throw new ToolFailure('failed to select an LTS release');

  const ltsRecord = await describeRelease(currentLtsRelease, dotnet);
  const previousLts: ReleaseRecord[] = [];
  for (const r of ltsOrdered.slice(1)) previousLts.push(await describeRelease(r, dotnet));
  const previewRecord = await describeRelease(newestPreview, dotnet);

  const releases = [ltsRecord, ...previousLts, previewRecord];

  // An LTS that is about to expire is the single most actionable thing this tool
  // can surface: it is the moment a "supported" default silently stops being one.
  const HORIZON_DAYS = 180;
  // ONE `now` for the whole classification pass. Reading the clock per record
  // lets a run that straddles midnight classify two releases against two
  // different days, which is a disagreement with no correct answer and is
  // invisible in the output.
  const now = Date.now();
  for (const rec of [ltsRecord, ...previousLts]) {
    if (rec.supportedUntil === null) continue;
    // EXPIRY IS A TIMESTAMP COMPARISON. It used to be `Math.round(...) <= 0`,
    // which is a DISPLAY rounding deciding a support question, and it declared
    // a release out of support up to twelve hours early. MEASURED against the
    // deadline this same line computes, 2026-11-10T00:00:00Z:
    //
    //   2026-11-09T12:00:00.000Z   43,200,000 ms left   daysLeft 1   supported
    //   2026-11-09T12:00:00.001Z   43,199,999 ms left   daysLeft 0   EXPIRED  <- wrong
    //   2026-11-09T23:59:59.999Z            1 ms left   daysLeft 0   EXPIRED  <- wrong
    //
    // `lts-out-of-support` is severity `error`, so being early by half a day is
    // a red required gate for a profile that is still supported. Rounded days
    // are kept, but only for the horizon test and the human-readable countdown.
    const support = classifySupport(rec.supportedUntil, now, HORIZON_DAYS);
    if (support === null) continue;
    const { expired } = support;
    if (expired || support.approaching) {
      note({
        severity: expired ? 'error' : 'warning',
        code: expired ? 'lts-out-of-support' : 'lts-approaching-eol',
        message:
          expired
            ? `${rec.tag} reached end of support on ${rec.supportedUntil}. It must not be offered as a supported profile.`
            : // NO COUNTDOWN IN HERE. `daysLeft` is derived from Date.now(), and this
              // message is stored in the lockfile and compared, so embedding it made
              // the lockfile drift EVERY DAY -- "in 66 days" becoming "in 65 days" was
              // the entire diff on the first live check after merge. A scheduled job
              // that reports drift daily, forever, for the passage of time is a job
              // whose pull request everyone learns to ignore, which costs exactly the
              // signal it exists to provide.
              //
              // The date is the upstream fact and it is what gets recorded. The
              // countdown is a rendering of it against today, so `render` computes it
              // live from `actual`. Severity and code still turn on daysLeft, and that
              // is fine: those change once, when it actually expires.
              `${rec.tag} loses support on ${rec.supportedUntil} (.NET ${rec.dotnet.channelVersion} is in ${rec.dotnet.supportPhase}). Plan the profile's retirement before then.`,
        actual: rec.supportedUntil,
        sources: [DOTNET_INDEX, LIFECYCLE_URL],
      });
    }
  }

  // Cross-check: the declared LTS must sit on a .NET LTS channel. This is the
  // documented rule, so a disagreement means one of two first-party sources is
  // wrong and a human must look.
  for (const rec of [ltsRecord, ...previousLts]) {
    if (rec.dotnet.releaseType !== 'lts') {
      note({
        severity: 'error',
        code: 'lts-derivation-disagrees',
        message: `metadata.json declares ${rec.tag} as LTS, but it builds on .NET ${rec.dotnet.channelVersion} which is ${String(rec.dotnet.releaseType).toUpperCase()}, not LTS. The lifecycle doc states "An LTS release of PowerShell is an LTS release of .NET", so one of these sources is wrong.`,
        expected: 'lts',
        actual: rec.dotnet.releaseType,
        sources: [METADATA_URL, DOTNET_INDEX, LIFECYCLE_URL],
      });
    }
  }

  // metadata.json vs the Releases feed. Both first-party, both axis-1; if they
  // disagree, a release is probably in flight and today's conclusion is not safe
  // to cache. Note "Stable" here means metadata.json's newest-stable-tag sense.
  if (meta.PreviewReleaseTag !== undefined && meta.PreviewReleaseTag !== newestPreview.tag_name) {
    note({
      severity: 'warning',
      code: 'metadata-preview-mismatch',
      message: `metadata.json names ${meta.PreviewReleaseTag} as the preview release, but the newest published prerelease is ${newestPreview.tag_name}. A release may be in flight.`,
      expected: newestPreview.tag_name,
      actual: meta.PreviewReleaseTag,
      sources: [METADATA_URL, `${GH}/releases`],
    });
  }
  if (
    newestStable !== undefined &&
    meta.StableReleaseTag !== undefined &&
    meta.StableReleaseTag !== newestStable.tag_name
  ) {
    note({
      severity: 'warning',
      code: 'metadata-latest-stable-mismatch',
      message: `metadata.json names ${meta.StableReleaseTag} as its stable release tag, but the highest-versioned published stable is ${newestStable.tag_name}.`,
      expected: newestStable.tag_name,
      actual: meta.StableReleaseTag,
      sources: [METADATA_URL, `${GH}/releases`],
    });
  }

  // --- lag, measured on RUNTIME versions only (TRAP B) ---------------------
  for (const rel of releases) {
    const ch = dotnet.channels.find((c) => c.channelVersion === rel.dotnet.channelVersion);
    if (ch === undefined) continue; // already reported as dotnet-channel-unknown
    if (rel.dotnet.runtime === null) continue; // already reported as sdk-runtime-unresolved

    const pinned = parseVersion(rel.dotnet.runtime);
    const latest = parseVersion(ch.latestRuntime);
    if (pinned === null || latest === null) {
      // TRAP F: never let "could not evaluate" degrade to silence.
      note({
        severity: 'error',
        code: 'runtime-version-unparseable',
        message: `Could not parse runtime versions for ${rel.tag} (pinned "${rel.dotnet.runtime}", channel latest "${ch.latestRuntime}"). The lag check did not run — this is a parser or upstream-format problem, not a clean result.`,
        sources: [DOTNET_INDEX],
      });
      continue;
    }

    if (compareVersions(pinned, latest) < 0) {
      // Only meaningful for a moving target. A shipped stable release pins the
      // runtime it shipped with, permanently and correctly.
      const meaningful = rel.prerelease || ch.supportPhase === 'preview';
      note({
        severity: meaningful ? 'warning' : 'info',
        code: meaningful ? 'preview-runtime-lags-dotnet' : 'stable-pinned-at-build-time',
        message: meaningful
          ? `${rel.tag} is built on .NET runtime ${rel.dotnet.runtime}, but .NET ${ch.channelVersion} has shipped ${ch.latestRuntime}. The preview is one or more .NET drops behind — do not describe it as being on the newest .NET.`
          : `${rel.tag} is pinned to .NET runtime ${rel.dotnet.runtime} from its build date; .NET ${ch.channelVersion} has since shipped ${ch.latestRuntime}. Expected for a shipped release.`,
        expected: ch.latestRuntime,
        actual: rel.dotnet.runtime,
        sources: [DOTNET_INDEX, `${RAW}/${rel.tag}/global.json`],
      });
    }

    if (rel.dotnet.featureBand !== null && featureBand(ch.latestSdk) !== rel.dotnet.featureBand) {
      note({
        severity: 'info',
        code: 'sdk-feature-band-differs',
        message: `${rel.tag} builds with the ${rel.dotnet.featureBand} SDK band (${rel.dotnet.sdk}) while .NET ${ch.channelVersion} currently leads with ${featureBand(ch.latestSdk)} (${ch.latestSdk}). Bands are parallel trains of the same runtime, not newer/older.`,
        sources: [DOTNET_INDEX],
      });
    }
  }

  // If NO release resolved a runtime, the .NET metadata shape has changed in a
  // way the per-release findings alone could still slide past a reader.
  if (releases.every((r) => r.dotnet.runtime === null)) {
    throw new ToolFailure(
      'no release resolved a .NET runtime version. The .NET channel metadata has changed ' +
        'shape; every runtime-based check would silently be skipped.',
    );
  }

  // --- axis 5: documentation ----------------------------------------------
  for (const rel of releases) {
    const p = parseVersion(rel.version);
    if (p === null) continue;
    // Docs use the undotted minor, e.g. What-s-New-in-PowerShell-76.md. At 7.10
    // this becomes "710", which is what upstream would use too.
    const slug = `${p.major}${p.minor}`;
    // The await sits outside the try on purpose. With the cross-check inside
    // it, a TypeError in our own comparison logic would be reported as
    // "docs-unreachable" — blaming upstream for our bug.
    let claim: DocsClaim;
    try {
      claim = await readDocsClaim(slug);
    } catch {
      note({
        severity: 'warning',
        code: 'docs-unreachable',
        message: `No What's-New doc found for ${slug}; cannot cross-check ${rel.tag}.`,
        sources: [`${DOCS_WHATS_NEW}/What-s-New-in-PowerShell-${slug}.md`],
      });
      continue;
    }
    crossCheckDocs(rel, claim);
  }

  let lifecycle: LifecycleTable | null = null;
  try {
    lifecycle = await readLifecycle();
  } catch {
    note({
      severity: 'warning',
      code: 'lifecycle-unreachable',
      message: `Could not read ${LIFECYCLE_URL}; LTS status was derived from .NET metadata without an independent cross-check.`,
      sources: [LIFECYCLE_URL],
    });
  }
  if (lifecycle !== null) {
    // A row whose date cell is present but unparseable means the table gained or
    // lost a column: the row still matches, isLts is still right, and only the
    // date quietly becomes null — so the cross-check goes blind while reporting
    // nothing at all.
    for (const bad of lifecycle.unparseableDates) {
      note({
        severity: 'error',
        code: 'lifecycle-eol-unparseable',
        message: `The lifecycle row for PowerShell ${bad.line} has an end-of-support cell ("${bad.raw}") that is not a date. The table shape changed and the end-of-support cross-check is now reading the wrong column.`,
        actual: bad.raw,
        sources: [LIFECYCLE_URL],
      });
    }
    if (lifecycle.duplicates.length > 0) {
      note({
        severity: 'info',
        code: 'lifecycle-duplicate-rows',
        message: `PowerShell ${lifecycle.duplicates.join(', ')} appear in more than one lifecycle table; the first (supported-versions) row was used.`,
        actual: lifecycle.duplicates,
        sources: [LIFECYCLE_URL],
      });
    }
    if (lifecycle.rows.size === 0) {
      note({
        severity: 'error',
        code: 'lifecycle-parse-failed',
        message: `Parsed no version rows from ${LIFECYCLE_URL}. The table changed shape and the independent LTS cross-check is now blind.`,
        sources: [LIFECYCLE_URL],
      });
    } else {
      for (const rel of releases) crossCheckLifecycle(rel, lifecycle.rows);
    }
  }

  // Keep channels that a release actually references, plus anything still
  // supported. Avoids both a hardcoded floor and unbounded growth of EOL rows.
  const referenced = new Set(releases.map((r) => r.dotnet.channelVersion));
  const keptChannels = dotnet.channels
    .filter((c) => referenced.has(c.channelVersion) || c.supportPhase !== 'eol')
    .sort((a, b) => {
      const pa = parseVersion(`${a.channelVersion}.0`);
      const pb = parseVersion(`${b.channelVersion}.0`);
      return pa !== null && pb !== null
        ? -compareVersions(pa, pb)
        : byCodepoint(b.channelVersion, a.channelVersion);
    });

  const citations = await resolveCitations();

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    generator: { tool: TOOL, version: TOOL_VERSION },
    sources: [...sources.values()].sort(
      (a, b) => a.precedence - b.precedence || byCodepoint(a.url, b.url),
    ),
    citations,
    channels: {
      lts: ltsRecord.tag,
      ltsPrevious: previousLts.map((r) => r.tag),
      preview: previewRecord.tag,
      edge: null,
      // What upstream says is coming next. NOT a release — recorded so a stale
      // lockfile is visible, never read as evidence of existence.
      next: meta.NextReleaseTag ?? null,
    },
    releases,
    dotnet: { channels: keptChannels },
    discrepancies: discrepancies.sort(
      (a, b) => byCodepoint(a.code, b.code) || byCodepoint(a.message, b.message),
    ),
  };
}

// ---------------------------------------------------------------------------
// schema enforcement — a schema nothing validates against is decoration
// ---------------------------------------------------------------------------

let compiledSchema: AjvValidator | null = null;

function schemaValidator(): AjvValidator {
  if (compiledSchema !== null) return compiledSchema;
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const schema = JSON.parse(readFileSync(SCHEMA, 'utf8')) as object;
  compiledSchema = ajv.compile(schema);
  return compiledSchema;
}

function validateAgainstSchema(lock: unknown, what: string): void {
  const validate = schemaValidator();
  if (!validate(lock)) {
    const errs = (validate.errors ?? [])
      .map((e) => `    ${e.instancePath || '/'} ${e.message ?? ''}`)
      .join('\n');
    throw new ToolFailure(`${what} violates ${SCHEMA}:\n${errs}`);
  }
}

// ---------------------------------------------------------------------------
// drift reporting
// ---------------------------------------------------------------------------

/** Fields that legitimately change on every run and must not count as drift. */
function stripVolatile(lock: Lockfile): unknown {
  return {
    ...lock,
    generatedAt: '<volatile>',
    sources: [...lock.sources]
      .sort((a, b) => a.precedence - b.precedence || byCodepoint(a.url, b.url))
      .map((s) => ({ ...s, fetchedAt: '<volatile>' })),
  };
}

/**
 * The first differing JSON paths. Printing only channels.lts/preview was useless
 * in practice: the one real drift encountered had both identical and the actual
 * difference was a source digest.
 */
function diffPaths(a: unknown, b: unknown, path = '', out: string[] = [], limit = 12): string[] {
  if (out.length >= limit) return out;
  if (Object.is(a, b)) return out;

  const bothObjects =
    typeof a === 'object' && a !== null && typeof b === 'object' && b !== null;
  if (!bothObjects) {
    out.push(`${path || '/'}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
    return out;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path || '/'}: array/object mismatch`);
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of [...keys].sort(byCodepoint)) {
    if (out.length >= limit) break;
    diffPaths(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
      `${path}/${k}`,
      out,
      limit,
    );
  }
  return out;
}

function wrap(s: string, width: number): string[] {
  const words = s.split(/\s+/);
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur.length + w.length + 1 > width) {
      if (cur !== '') out.push(cur);
      cur = w;
    } else {
      cur = cur === '' ? w : `${cur} ${w}`;
    }
  }
  if (cur !== '') out.push(cur);
  return out;
}

function report(lock: Lockfile): void {
  const line = (s = ''): void => void process.stdout.write(s + '\n');
  line();
  line('  Upstream release truth');
  line('  ' + '='.repeat(70));
  for (const r of lock.releases) {
    line(`  ${r.channel.toUpperCase().padEnd(9)}${r.tag.padEnd(22)}${r.publishedAt.slice(0, 10)}`);
    line(`  ${''.padEnd(9)}commit        ${r.commitSha}`);
    line(`  ${''.padEnd(9)}.NET SDK      ${r.dotnet.sdk}  (band ${r.dotnet.featureBand ?? '?'})`);
    line(`  ${''.padEnd(9)}.NET runtime  ${r.dotnet.runtime ?? 'unresolved'}`);
    line(
      `  ${''.padEnd(9)}.NET channel  ${r.dotnet.channelVersion ?? '?'} ` +
        `${(r.dotnet.releaseType ?? '?').toUpperCase()} / ${r.dotnet.supportPhase ?? '?'}`,
    );
    line(`  ${''.padEnd(9)}supported to  ${r.supportedUntil ?? 'not a supported channel'}`);
    line();
  }
  if (lock.channels.next !== null) {
    line(`  upstream says next: ${lock.channels.next}  (declared, not released)`);
    line();
  }
  const by = (s: Severity): Discrepancy[] => lock.discrepancies.filter((d) => d.severity === s);
  line(
    `  discrepancies: ${by('error').length} error, ${by('warning').length} warning, ${by('info').length} info`,
  );
  line('  ' + '-'.repeat(70));
  for (const d of lock.discrepancies) {
    line(`  [${d.severity}] ${d.code}`);
    for (const chunk of wrap(d.message, 66)) line(`     ${chunk}`);
    // Computed here, never stored: a countdown against today is not an upstream
    // fact, and putting one in the lockfile made it drift every day. See the
    // note that raises lts-approaching-eol.
    const until = typeof d.actual === 'string' ? Date.parse(`${d.actual}T00:00:00Z`) : Number.NaN;
    if (d.code === 'lts-approaching-eol' && Number.isFinite(until)) {
      const days = Math.round((until - Date.now()) / 86_400_000);
      line(`     (${String(days)} days from today)`);
    }
  }
  line();
}

// ---------------------------------------------------------------------------
// offline verification
// ---------------------------------------------------------------------------

/**
 * Everything that can be proved about the committed lockfile WITHOUT the network.
 *
 * Why this mode exists
 * --------------------
 * `--check` is a live-network check, and it was wired into `npm run verify`,
 * which is the gate every pull request has to pass. That put a required CI gate
 * at the mercy of `api.github.com`: an anonymous or shared-IP rate limit returns
 * 403, the tool correctly reports "I could not do my job" with exit 2, and a pull
 * request that changed nothing near this code goes red. A gate that fails for
 * reasons unrelated to the change under test gets re-run, then ignored, then
 * removed. It has to be hermetic to stay required.
 *
 * The split is by question, not by strictness:
 *
 *   --offline  is the committed lockfile a coherent, untampered artifact that
 *              records no error?              (hermetic — belongs in PR CI)
 *   --check    does the committed lockfile still match live upstream?
 *              (network — belongs in the scheduled observer)
 *
 * What this mode CANNOT see is stated in its own output rather than left for a
 * reader to infer. The failure this repository keeps re-learning is a check that
 * reports success for work it did not do; a quiet offline mode would be exactly
 * that, one level up.
 */
function verifyOffline(asJson: boolean): void {
  if (!existsSync(LOCKFILE)) {
    throw new ToolFailure(`no lockfile at ${LOCKFILE}\n  run: npm run truth:write`);
  }

  let committed: Lockfile;
  try {
    committed = JSON.parse(readFileSync(LOCKFILE, 'utf8')) as Lockfile;
  } catch (cause) {
    throw new ToolFailure(
      `the committed lockfile is not valid JSON: ${(cause as Error).message}\n` +
        '  It was hand-edited or truncated. Regenerate it: npm run truth:write',
    );
  }

  validateAgainstSchema(committed, 'the committed lockfile');

  // Same integrity gate as --check, and for the same reason: a schema-valid hand
  // edit is tampering, not drift, and must not be reported as either "clean" or
  // "upstream moved".
  const tampered = committed.releases.filter((r) => snapshotOf(r) !== r.snapshotDigest);
  if (tampered.length > 0) {
    throw new ToolFailure(
      `the committed lockfile was edited by hand: ${tampered.map((r) => r.tag).join(', ')} ` +
        'no longer match the recorded snapshotDigest.\n' +
        '  Regenerate it: npm run truth:write',
    );
  }

  // Internal coherence. `channels` names tags; every name that is supposed to
  // denote a RELEASED thing must appear in `releases`.
  //
  // `next` is deliberately excluded. It comes from PowerShell's own
  // metadata.json `NextReleaseTag`, which by construction names a tag that does
  // not exist yet — requiring it here would fail on every correct lockfile.
  const known = new Set(committed.releases.map((r) => r.tag));
  const mustExist: Array<[string, string]> = [
    ['channels.lts', committed.channels.lts],
    ['channels.preview', committed.channels.preview],
    ...committed.channels.ltsPrevious.map(
      (t, i): [string, string] => [`channels.ltsPrevious[${i}]`, t],
    ),
    ...(committed.channels.edge === null
      ? []
      : ([['channels.edge', committed.channels.edge]] as Array<[string, string]>)),
  ];
  const dangling = mustExist.filter(([, tag]) => !known.has(tag));
  if (dangling.length > 0) {
    throw new ToolFailure(
      'the committed lockfile is internally incoherent — these channels name tags with no ' +
        `release record:\n${dangling.map(([w, t]) => `    ${w} = ${t}`).join('\n')}\n` +
        '  Regenerate it: npm run truth:write',
    );
  }

  if (asJson) process.stdout.write(JSON.stringify(committed, null, 2) + '\n');
  else report(committed);

  const errors = committed.discrepancies.filter((d) => d.severity === 'error');
  const ageDays = Math.floor(
    (Date.now() - new Date(committed.generatedAt).getTime()) / 86_400_000,
  );

  if (!asJson) {
    process.stdout.write(
      `  offline: the committed lockfile is schema-valid, untampered and internally\n` +
        `  coherent. Recorded ${Number.isFinite(ageDays) ? `${ageDays} day(s) ago` : 'at an unparseable time'}.\n` +
        '\n' +
        '  NOT checked here, because this mode never opens a socket: whether upstream\n' +
        '  still matches it. That is the scheduled observer\'s job (--check).\n\n',
    );
  }

  if (errors.length > 0) {
    process.stderr.write(
      `\n  ${errors.length} error-severity discrepancy/discrepancies are recorded in the ` +
        'committed lockfile:\n' +
        errors.map((d) => `    [${d.code}] ${d.message}`).join('\n') +
        '\n\n',
    );
    process.exitCode = 1;
    return;
  }

  process.exitCode = 0;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const KNOWN_FLAGS = new Set(['--check', '--write', '--offline', '--json']);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // A closed set: a typo'd `--wrte` previously ran the check path silently, and
  // the operator believed they had regenerated the lockfile.
  const unknown = argv.filter((a) => !KNOWN_FLAGS.has(a));
  if (unknown.length > 0) {
    throw new ToolFailure(
      `unknown option(s): ${unknown.join(', ')}\n  known: ${[...KNOWN_FLAGS].join(', ')}`,
    );
  }
  const write = argv.includes('--write');
  const asJson = argv.includes('--json');
  const offline = argv.includes('--offline');
  if (write && argv.includes('--check')) {
    throw new ToolFailure('--check and --write are mutually exclusive; --write would skip the check entirely');
  }
  // Silently ignoring a mode flag is how an operator ends up believing a
  // hermetic run proved something it never touched, or the reverse.
  if (offline && write) {
    throw new ToolFailure('--offline and --write are mutually exclusive; --write must reach upstream');
  }
  if (offline && argv.includes('--check')) {
    throw new ToolFailure(
      '--offline and --check are mutually exclusive; they answer different questions.\n' +
        '  --offline: is the committed lockfile coherent and untampered? (no network)\n' +
        '  --check:   does it still match live upstream?                (network)',
    );
  }

  if (offline) {
    verifyOffline(asJson);
    return;
  }

  const lock = await build();
  validateAgainstSchema(lock, 'the generated lockfile');

  if (asJson) process.stdout.write(JSON.stringify(lock, null, 2) + '\n');
  else report(lock);

  const hasError = lock.discrepancies.some((d) => d.severity === 'error');

  if (write) {
    // Idempotent on purpose. Every run produces a fresh generatedAt and a fresh
    // fetchedAt per source, so an unconditional write always dirties the file
    // even when nothing upstream moved. The sync workflow then commits 22 lines
    // of timestamps and opens a pull request headed "Upstream moved." every
    // single day, until a human intervenes. If the substance is unchanged, leave
    // the file alone.
    let unchanged = false;
    if (existsSync(LOCKFILE)) {
      try {
        const existing = JSON.parse(readFileSync(LOCKFILE, 'utf8')) as Lockfile;
        unchanged =
          JSON.stringify(stripVolatile(existing)) === JSON.stringify(stripVolatile(lock));
      } catch {
        unchanged = false; // unreadable or malformed: rewrite it
      }
    }

    if (unchanged) {
      if (!asJson) process.stdout.write('  lockfile is already current; left unchanged.\n\n');
    } else {
      mkdirSync(dirname(LOCKFILE), { recursive: true });
      writeFileSync(LOCKFILE, JSON.stringify(lock, null, 2) + '\n', 'utf8');
      if (!asJson) process.stdout.write(`  wrote ${LOCKFILE}\n\n`);
    }
    process.exitCode = hasError ? 1 : 0;
    return;
  }

  if (!existsSync(LOCKFILE)) {
    process.stderr.write(`\n  no lockfile at ${LOCKFILE}\n  run: npm run truth:write\n\n`);
    process.exitCode = 1;
    return;
  }

  let committed: Lockfile;
  try {
    committed = JSON.parse(readFileSync(LOCKFILE, 'utf8')) as Lockfile;
  } catch (cause) {
    throw new ToolFailure(
      `the committed lockfile is not valid JSON: ${(cause as Error).message}\n` +
        '  It was hand-edited or truncated. Regenerate it: npm run truth:write',
    );
  }
  // The committed file claims to be machine-generated. Enforce that, so a
  // hand-edited lockfile is diagnosed as tampering rather than as "upstream moved".
  validateAgainstSchema(committed, 'the committed lockfile');

  // Schema validity is not integrity. A schema-valid hand edit of, say,
  // dotnet.runtime was previously reported as "upstream moved" — an actively
  // wrong diagnosis. Each record carries a digest over its own derived fields,
  // so recomputing it catches the edit and names it for what it is.
  const tampered = committed.releases.filter((r) => snapshotOf(r) !== r.snapshotDigest);
  if (tampered.length > 0) {
    throw new ToolFailure(
      `the committed lockfile was edited by hand: ${tampered.map((r) => r.tag).join(', ')} ` +
        'no longer match the recorded snapshotDigest.\n' +
        '  This is not upstream drift. Regenerate it: npm run truth:write',
    );
  }

  const before = stripVolatile(committed);
  const after = stripVolatile(lock);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    process.stderr.write(
      '\n  DRIFT: upstream no longer matches compat/upstream/releases.lock.json\n\n',
    );
    for (const d of diffPaths(before, after)) process.stderr.write(`    ${d}\n`);
    process.stderr.write('\n  Review the changes above, then: npm run truth:write\n\n');
    process.exitCode = 1;
    return;
  }

  if (!asJson) process.stdout.write('  lockfile matches upstream.\n\n');
  process.exitCode = hasError ? 1 : 0;
}

// RUN ONLY AS THE ENTRY POINT. This used to be a bare `main()`, so merely
// IMPORTING this file executed the whole tool -- including its network calls.
// That is why the boundary bug in `classifySupport` went untested: nothing
// could import the function to ask it about a specific instant without also
// running a live upstream check. `import.meta.main` is true only when Node
// started this file, which is what makes the pure parts testable.
if (import.meta.main) {
  main().catch((err: unknown) => {
  const fatal = err instanceof ToolFailure;
  process.stderr.write(`\n  ${TOOL}: ${(err as Error).message}\n\n`);
  // 2 = could not do the job (network, rate limit, upstream shape change).
  // 3 = a bug in this file. Distinguishing them matters: one is upstream's
  //     problem and one is ours.
  process.exitCode = fatal ? 2 : 3;
    if (!fatal && err instanceof Error && err.stack !== undefined) {
      process.stderr.write(err.stack + '\n\n');
    }
  });
}
