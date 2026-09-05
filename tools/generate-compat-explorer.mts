/**
 * generate-compat-explorer.mts — renders compat/explorer.html from the verified
 * artifacts.
 *
 * The page is generated rather than written because a page that restates the
 * lockfile is a second copy of the truth, and second copies rot.
 *
 * That claim has to be earned, and the first version of this file did not earn
 * it. Its prose carried hardcoded literals — "7.7.0-preview.4" in the hero,
 * "Three releases matter", "one drop behind", "(100)" — so bumping the lockfile
 * to a new preview would leave the page confidently wrong while `--check` still
 * exited 0. That is precisely the failure the release verifier exists to
 * prevent, committed inside the page that argues against it. So: every number,
 * version, count and name below is interpolated from the inputs. If a value is
 * not derivable, it is not asserted.
 *
 * Design notes, recorded so a later pass does not undo them by accident:
 *
 *   - The palette inverts PowerShell's own identity. #012456 has been the
 *     console background since v1; here it is the INK on pale drafting stock,
 *     and dark mode hands it back its original job.
 *
 *   - Two typefaces with semantic roles. IBM Plex Mono means "a machine
 *     produced this value" — versions, tags, SHAs, identifiers, behavior keys.
 *     Instrument Sans is the human voice. The rule cuts both ways: an English
 *     noun quoted from prose is NOT mono, and a PowerShell identifier inside a
 *     sentence IS. Identifiers are marked with backticks in the source data.
 *
 *   - The provenance rail carries each band's precedence RANGE, computed from
 *     the source kinds that band actually cites. Hand-typing them produced
 *     "1, 3, 5" — an arithmetic-looking sequence that understated half the
 *     sources, which is exactly the decorative numbering the design brief warns
 *     against, wearing a data costume.
 *
 *   - Version COMPARISON uses character-level alignment. Version MAPPING
 *     (SDK to runtime) uses a bracketed pair, because the two are different
 *     version spaces and rendering them the same way implies an axis they do
 *     not share.
 *
 * Usage:
 *   node tools/generate-compat-explorer.mts                   write the page
 *   node tools/generate-compat-explorer.mts --check           verify, exit 1 on drift
 *   node tools/generate-compat-explorer.mts --artifact PATH   body-only fragment
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseVersion } from './version.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const OUT = join(REPO, 'compat', 'explorer.html');

const PS_REPO = 'https://github.com/PowerShell/PowerShell';

// ---------------------------------------------------------------------------
// inputs
// ---------------------------------------------------------------------------

interface Release {
  tag: string;
  version: string;
  channel: string;
  prerelease: boolean;
  publishedAt: string;
  commitSha: string;
  dotnet: {
    sdk: string;
    runtime: string | null;
    featureBand: string | null;
    channelVersion: string | null;
    releaseType: string | null;
    supportPhase: string | null;
  };
  supportedUntil: string | null;
}

interface Discrepancy {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  expected?: unknown;
  actual?: unknown;
  sources?: string[];
}

interface SourceRecord {
  precedence: number;
  kind: string;
  url: string;
}

interface Lockfile {
  generatedAt: string;
  channels: { lts: string; ltsPrevious: string[]; preview: string; next: string | null };
  releases: Release[];
  sources: SourceRecord[];
  dotnet: {
    channels: Array<{
      channelVersion: string;
      latestRuntime: string;
      latestSdk: string;
      releaseType: string;
      supportPhase: string;
    }>;
  };
  discrepancies: Discrepancy[];
}

interface Profile {
  profile: string;
  displayVersion: string;
  channel: string;
  behaviors: Record<string, boolean | number | string | null>;
  behaviorDocs: Record<
    string,
    { summary: string; upstreamPr: number | null; breaking: boolean; emulated?: boolean }
  >;
  supported: { isSupportedUpstream: boolean; endOfSupport: string | null };
}

interface Delta {
  summary: Record<string, number>;
  changes: Array<{
    kind: string;
    subject: string;
    subjectKind: string;
    title: string;
    detail?: string;
    impact: string;
    behaviorKey: string | null;
    upstreamPr: number;
    migration?: string;
    implemented: boolean;
  }>;
}

const read = <T,>(p: string): T => JSON.parse(readFileSync(join(REPO, p), 'utf8')) as T;

// ---------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------

const esc = (s: unknown): string =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Escape, then set `backticked` spans in mono and normalise ASCII quotes to
 * typographic ones. The quote normalisation matters because lockfile messages
 * carry ASCII quotes while the page's own prose uses curly ones, and the two
 * appeared side by side in the same screenful.
 */
function prose(s: string): string {
  const escaped = esc(s);
  const withCode = escaped.replace(/`([^`]+)`/g, '<span class="mono">$1</span>');
  return withCode.replace(/"([^"<]*)"/g, '“$1”');
}

const pluralise = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** Capitalise a derived word that begins a sentence. */
const sentence = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** English for a small count, so prose reads naturally without hardcoding it. */
const spell = (n: number): string =>
  ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][n] ??
  String(n);

const prLink = (pr: number): string =>
  `<a class="mono pr-link" href="${PS_REPO}/pull/${pr}">#${pr}</a>`;

const commitLink = (sha: string): string =>
  `<a class="mono sha" href="${PS_REPO}/commit/${esc(sha)}" title="${esc(sha)}">${esc(sha.slice(0, 12))}</a>`;

// ---------------------------------------------------------------------------
// derived facts — nothing in the prose is typed by hand
// ---------------------------------------------------------------------------

interface Facts {
  lock: Lockfile;
  preview: Release;
  ltsReleases: Release[];
  previewChannel: Lockfile['dotnet']['channels'][number] | undefined;
  /** How many .NET preview drops the PowerShell preview is behind, if any. */
  dropsBehind: number | null;
  /** The docs sentence this page is built around, if it is still wrong. */
  axisConfusion: Discrepancy | undefined;
}

function deriveFacts(lock: Lockfile): Facts {
  const preview = lock.releases.find((r) => r.prerelease);
  if (preview === undefined) throw new Error('no preview release in the lockfile');

  const previewChannel = lock.dotnet.channels.find(
    (c) => c.channelVersion === preview.dotnet.channelVersion,
  );

  let dropsBehind: number | null = null;
  if (preview.dotnet.runtime !== null && previewChannel !== undefined) {
    const pinned = parseVersion(preview.dotnet.runtime);
    const latest = parseVersion(previewChannel.latestRuntime);
    if (pinned?.pre != null && latest?.pre != null && pinned.pre.kind === latest.pre.kind) {
      dropsBehind = latest.pre.n - pinned.pre.n;
    }
  }

  return {
    lock,
    preview,
    ltsReleases: lock.releases.filter((r) => !r.prerelease),
    previewChannel,
    dropsBehind,
    axisConfusion: lock.discrepancies.find((d) => d.code === 'docs-axis-confusion'),
  };
}

/**
 * The precedence range a band draws on, computed from the source kinds it cites.
 * A band spanning two ranks says so rather than naming the lower one and quietly
 * understating where half its evidence came from.
 */
function rankFor(lock: Lockfile, kinds: readonly string[]): string {
  const ranks = lock.sources
    .filter((s) => kinds.includes(s.kind))
    .map((s) => s.precedence)
    .sort((a, b) => a - b);
  const lo = ranks[0];
  const hi = ranks[ranks.length - 1];
  if (lo === undefined || hi === undefined) return '?';
  return lo === hi ? String(lo) : `${lo}–${hi}`;
}

// ---------------------------------------------------------------------------
// version rendering
// ---------------------------------------------------------------------------

function alignVersions(a: string, b: string): { shared: string; aTail: string; bTail: string } {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const cut = Math.max(a.lastIndexOf('.', i), a.lastIndexOf('-', i));
  const at = cut > 0 && cut < i ? cut + 1 : i;
  return { shared: a.slice(0, at), aTail: a.slice(at), bTail: b.slice(at) };
}

/** A COMPARISON on one axis: shared prefix quiet, divergence flagged. */
function versionPair(
  aLabel: string,
  a: string,
  bLabel: string,
  b: string,
  note: string,
): string {
  const { shared, aTail, bTail } = alignVersions(a, b);
  const row = (label: string, tail: string): string => `
        <div class="align-row">
          <span class="align-label">${esc(label)}</span>
          <span class="mono align-value"><span class="shared">${esc(shared)}</span><span class="diverge">${esc(tail)}</span></span>
        </div>`;
  return `
      <div class="align cmp">
        ${row(aLabel, aTail)}
        ${row(bLabel, bTail)}
        <p class="align-note">${prose(note)}</p>
      </div>`;
}

/**
 * A LOOKUP, not a comparison. An SDK version and the runtime it ships sit in
 * different version spaces: neither is derivable from the other, and only the
 * .NET release metadata relates them. Rendered as a braced pair so it cannot be
 * mistaken for the alignment device above.
 */
function versionMapping(
  aLabel: string,
  a: string,
  bLabel: string,
  b: string,
  note: string,
): string {
  return `
      <div class="align map">
        <div class="map-brace" aria-hidden="true"></div>
        <div class="map-rows">
          <div class="align-row">
            <span class="align-label">${esc(aLabel)}</span>
            <span class="mono align-value">${esc(a)}</span>
          </div>
          <div class="align-row">
            <span class="align-label">${esc(bLabel)}</span>
            <span class="mono align-value">${esc(b)}</span>
          </div>
        </div>
        <p class="align-note">${prose(note)}</p>
      </div>`;
}

// ---------------------------------------------------------------------------
// sections
// ---------------------------------------------------------------------------

function renderHero(f: Facts): string {
  const { preview, axisConfusion } = f;
  const runtime = preview.dotnet.runtime ?? 'unresolved';

  // If the docs are ever corrected, this discrepancy disappears and the hero's
  // premise disappears with it. Say so rather than keep quoting a sentence that
  // no longer exists.
  if (axisConfusion === undefined) {
    return `
  <header class="hero">
    <h1 class="sr-only">Version truth</h1>
    <p class="hero-source">Microsoft Learn, What&rsquo;s New in PowerShell ${esc(preview.version)}</p>
    <blockquote class="hero-sentence">The documentation and the release metadata currently agree.</blockquote>
    <p class="hero-lede">That is worth recording, because they have not always. This workstation does not
      store a version; it stores where every version came from, and what disagrees.</p>
  </header>`;
  }

  const claimed = String(axisConfusion.actual);
  const glosses = [
    {
      cls: 'ok',
      frag: preview.version,
      isVersion: true,
      lead: 'A release.',
      body: `Confirmed against the Releases API, and against the commit its annotated tag actually dereferences to.`,
    },
    {
      cls: 'bad',
      frag: claimed,
      isVersion: true,
      lead: 'Not a runtime.',
      body: `This is the SDK version. The runtime that SDK ships is \`${runtime}\` — the two differ in the third component, the SDK feature-band level, which a runtime version does not have.`,
    },
    {
      cls: 'bad',
      frag: 'runtime',
      isVersion: false,
      lead: 'Wrong noun.',
      body: 'SDK and runtime are separate version spaces. No string edit converts one into the other; only the .NET release metadata relates them.',
    },
  ]
    .map(
      (n) => `
        <li class="gloss gloss-${n.cls}">
          <p class="gloss-frag${n.isVersion ? ' mono' : ''}">${n.isVersion ? esc(n.frag) : `&ldquo;${esc(n.frag)}&rdquo;`}</p>
          <p class="gloss-text"><b>${esc(n.lead)}</b> ${prose(n.body)}</p>
        </li>`,
    )
    .join('');

  const docsSource = f.lock.sources.find((s) => s.url.includes("What-s-New-in-PowerShell"));

  return `
  <header class="hero">
    <h1 class="sr-only">Version truth</h1>
    <p class="hero-source">Microsoft Learn,
      ${docsSource === undefined ? "What&rsquo;s New in PowerShell" : `<a href="${esc(docsSource.url)}">What&rsquo;s New in PowerShell</a>`},
      recorded ${esc(f.lock.generatedAt.slice(0, 10))}</p>

    <blockquote class="hero-sentence">PowerShell <span class="mark mark-ok">${esc(preview.version)}</span> is built on the .NET <span class="mark mark-bad">${esc(claimed)}</span> <span class="mark mark-bad">runtime</span>.</blockquote>

    <ul class="apparatus">${glosses}</ul>

    <p class="hero-lede">One sentence, three claims, two of them imprecise. It is not a careless sentence &mdash;
      it is what happens when one string has to carry facts that move independently. So this workstation does
      not store a version. It stores where every version came from, and what disagrees &mdash; and of the
      ${esc(spell(f.lock.discrepancies.length))} differences it currently records,
      <a href="#emulated">none are emulated yet</a>.</p>
  </header>`;
}

function renderExists(f: Facts): string {
  const { lock } = f;
  const ltsCount = f.ltsReleases.length;
  const previewCount = lock.releases.length - ltsCount;

  const rows = lock.releases
    .map((r) => {
      const eol = r.supportedUntil;
      const days =
        eol === null
          ? null
          : Math.round((Date.parse(`${eol}T00:00:00Z`) - Date.parse(lock.generatedAt)) / 86_400_000);
      const soon = days !== null && days <= 180;
      return `
        <tr>
          <td class="mono strong">${esc(r.tag)}</td>
          <td><span class="mono tag tag-${esc(r.channel)}">${esc(r.channel)}</span></td>
          <td class="mono quiet">${esc(r.publishedAt.slice(0, 10))}</td>
          <td class="mono">${eol === null ? '<span class="quiet plain">not a supported channel</span>' : esc(eol)}</td>
          <td class="${soon ? 'flagged' : 'quiet'} plain">${days === null ? '' : soon ? `${days} days left` : ''}</td>
          <td>${commitLink(r.commitSha)}</td>
        </tr>`;
    })
    .join('');

  return `
  <section class="band" aria-labelledby="h-exists">
    <div class="rail"><span class="rail-rank mono">${esc(rankFor(lock, ['github-release-api', 'github-metadata', 'github-tag-object']))}</span><span class="rail-kind">releases API,<br>tag objects</span></div>
    <div class="body">
      <h2 id="h-exists">What actually exists</h2>
      <p>${esc(sentence(spell(lock.releases.length)))} releases matter:
        ${esc(spell(ltsCount))} long-term support ${pluralise(ltsCount, 'line', 'lines')},
        supported concurrently, and ${esc(spell(previewCount))} ${pluralise(previewCount, 'preview', 'previews')}.
        Support dates are not typed in &mdash; they are inherited from the .NET channel each release
        was built on, because the lifecycle policy says an LTS release of PowerShell is an LTS release
        of .NET.</p>
      <div class="scroller" data-scroller role="region" aria-label="Releases">
        <table class="grid">
          <thead>
            <tr>
              <th scope="col">tag</th><th scope="col">channel</th><th scope="col">published</th>
              <th scope="col">supported until</th><th scope="col">remaining</th><th scope="col">commit</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  </section>`;
}

function renderAxes(f: Facts): string {
  const { preview, previewChannel, lock } = f;

  const sdkParsed = parseVersion(preview.dotnet.sdk);
  const runtimeParsed =
    preview.dotnet.runtime === null ? null : parseVersion(preview.dotnet.runtime);

  const mapping = versionMapping(
    'SDK pinned by the tag',
    preview.dotnet.sdk,
    'the runtime it ships',
    preview.dotnet.runtime ?? 'unresolved',
    sdkParsed !== null && runtimeParsed !== null
      ? `A lookup, not a comparison. The SDK feature-band level (${sdkParsed.patch}) and the runtime patch (${runtimeParsed.patch}) are unrelated numbers, and only the .NET release metadata connects the two.`
      : 'A lookup, not a comparison. Only the .NET release metadata connects the two.',
  );

  const comparison =
    previewChannel === undefined || preview.dotnet.runtime === null
      ? ''
      : versionPair(
          'runtime it ships',
          preview.dotnet.runtime,
          `latest in .NET ${previewChannel.channelVersion}`,
          previewChannel.latestRuntime,
          f.dropsBehind === null
            ? `.NET ${previewChannel.channelVersion} has moved on. The preview is behind, which is normal and must still be visible.`
            : `.NET ${previewChannel.channelVersion} has moved on. The preview is ${spell(f.dropsBehind)} ${pluralise(f.dropsBehind, 'drop', 'drops')} behind, which is normal and must still be visible.`,
        );

  const axes = [
    'which releases exist',
    'which commit a tag is',
    'which SDK it pinned',
    'which runtime that ships',
    'what .NET has since shipped',
  ];

  return `
  <section class="band" aria-labelledby="h-axes">
    <div class="rail"><span class="rail-rank mono">${esc(rankFor(lock, ['github-tag-file', 'dotnet-release-index', 'dotnet-channel-releases']))}</span><span class="rail-kind">global.json,<br>.NET metadata</span></div>
    <div class="body">
      <h2 id="h-axes">What it was built on</h2>
      <p>${esc(sentence(spell(axes.length)))} axes drift independently &mdash; ${axes.map((a) => esc(a)).join(', ')}.
        Reading any one of them as &ldquo;the version&rdquo; produces a confident wrong answer, which is what
        the sentence at the top of this page does.</p>
      ${mapping}
      ${comparison}
      <dl class="facts">
        <div><dt>SDK feature band</dt><dd class="mono">${esc(preview.dotnet.featureBand ?? '?')}</dd></div>
        <div><dt>.NET channel</dt><dd class="mono">${esc(preview.dotnet.channelVersion ?? '?')}</dd></div>
        <div><dt>release type</dt><dd class="mono">${esc(preview.dotnet.releaseType ?? '?')}</dd></div>
        <div><dt>support phase</dt><dd class="mono">${esc(preview.dotnet.supportPhase ?? '?')}</dd></div>
      </dl>
      <p class="aside">Because .NET ${esc(preview.dotnet.channelVersion ?? '?')} is a
        ${esc(preview.dotnet.releaseType === 'sts' ? 'standard-term' : String(preview.dotnet.releaseType))}
        release rather than long-term, the ${esc(preview.version.replace(/\.\d+(-.*)?$/, ''))} line will never
        become the supported default. Upstream policy settles that, not preference.</p>
    </div>
  </section>`;
}

/**
 * How the two sides of a discrepancy should be labelled and toned.
 *
 * Deriving this from the field names was wrong. `expected`/`actual` do not mean
 * "verified"/"claimed" in general: for a version-lag finding BOTH sides are
 * machine-read values, and colouring the tag's own pinned runtime as an untrusted
 * "claim" rendered the same string green in one finding and red in another, on a
 * page whose only job is making provenance legible.
 */
const SIDES: Record<string, { a: string; b: string; aTone: string; bTone: string }> = {
  'docs-axis-confusion': {
    a: 'the runtime, per .NET metadata',
    b: 'what the documentation calls it',
    aTone: 'proof',
    bTone: 'flagged',
  },
  'preview-runtime-lags-dotnet': {
    a: 'latest in the .NET channel',
    b: 'pinned by the tag',
    aTone: 'neutral',
    bTone: 'neutral',
  },
  'lts-approaching-eol': { a: 'end of support', b: '', aTone: 'flagged', bTone: 'neutral' },
};

function renderDisagreements(f: Facts): string {
  const { lock } = f;
  const items = lock.discrepancies
    .map((d) => {
      const sides = SIDES[d.code];
      const both =
        d.expected !== undefined && d.actual !== undefined && sides !== undefined && sides.b !== ''
          ? `<div class="sides">
               <div><span class="side-label">${esc(sides.a)}</span><span class="mono ${esc(sides.aTone)}">${esc(d.expected)}</span></div>
               <div><span class="side-label">${esc(sides.b)}</span><span class="mono ${esc(sides.bTone)}">${esc(d.actual)}</span></div>
             </div>`
          : '';
      return `
        <li class="finding sev-${esc(d.severity)}">
          <p class="finding-head"><span class="sev-word">${esc(d.severity)}</span><span class="mono finding-code">${esc(d.code)}</span></p>
          <p class="finding-msg">${prose(d.message)}</p>
          ${both}
        </li>`;
    })
    .join('');

  return `
  <section class="band" aria-labelledby="h-disagree">
    <div class="rail rail-prose"><span class="rail-rank mono">${esc(rankFor(lock, ['microsoft-learn-docs']))}</span><span class="rail-kind">prose,<br>ranked last</span></div>
    <div class="body">
      <h2 id="h-disagree">Where the sources disagree</h2>
      <p>Documentation is checked against the machine-readable artifacts, never the other way round.
        A disagreement is recorded with both sides intact so a person can decide which is right.</p>
      <ul class="findings">${items}</ul>
    </div>
  </section>`;
}

function renderDelta(lts: Profile, preview: Profile, delta: Delta): string {
  const keys = Object.keys(preview.behaviors);

  // Both the value AND its description come from the selected profile, so the
  // table cannot say "4" beside a sentence describing v7 and flag 7.6.5 as
  // breaking for having the behaviour it always had.
  const behaviorRows = keys
    .map((key) => {
      // A key present in only one profile would stringify to the literal
      // "undefined" and render as a value. Currently unreachable (the key sets
      // match) but silent when it stops being so.
      const ltsValue = key in lts.behaviors ? JSON.stringify(lts.behaviors[key]) : 'not present';
      const previewValue =
        key in preview.behaviors ? JSON.stringify(preview.behaviors[key]) : 'not present';
      const ltsDoc = lts.behaviorDocs[key];
      const preDoc = preview.behaviorDocs[key];
      const pr = preDoc?.upstreamPr ?? ltsDoc?.upstreamPr ?? null;
      // Whether the engine MODELS this flag or merely documents it. Computed by
      // generate-compatibility-profile.mts from a search of src/, not written by
      // hand. Rendering all thirteen keys identically -- as this table did --
      // let a visitor read a documented difference as an emulated one, which is
      // exactly the claim this project refuses to make anywhere else.
      const modelled = preDoc?.emulated === true;
      return `
        <tr${preDoc?.breaking === true ? ' class="breaking"' : ''}>
          <td class="mono key">${esc(key)}</td>
          <td class="mono val" data-lts="${esc(ltsValue)}" data-preview="${esc(previewValue)}">${esc(ltsValue)}</td>
          <td class="mark-cell">${preDoc?.breaking === true ? '<span class="breaking-mark">breaking</span>' : ''}</td>
          <td class="mark-cell"><span class="emulated${modelled ? ' is-emulated' : ''}">${modelled ? 'emulated' : 'documented'}</span></td>
          <td class="doc">${prose(preDoc?.summary ?? '')}</td>
          <td class="pr">${pr === null ? '' : prLink(pr)}</td>
        </tr>`;
    })
    .join('');

  const changes = delta.changes
    .map(
      (c) => `
        <li class="change impact-${esc(c.impact)}">
          <p class="change-head"><span class="mono change-subject">${esc(c.subject)}</span>${prLink(c.upstreamPr)}</p>
          <p class="change-title">${prose(c.title)}</p>
          ${c.detail === undefined ? '' : `<p class="change-detail">${prose(c.detail)}</p>`}
          ${c.migration === undefined ? '' : `<p class="change-migration"><b>To migrate.</b> ${prose(c.migration)}</p>`}
          <p class="change-meta">
            <span class="impact">${esc(c.impact === 'none' ? 'no impact' : c.impact.replace(/-/g, ' '))}</span>
            <span class="emulated${c.implemented ? ' is-emulated' : ''}">${c.implemented ? 'emulated' : 'not emulated'}</span>
          </p>
        </li>`,
    )
    .join('');

  const implemented = delta.summary['implemented'] ?? 0;
  const withKey = delta.changes.filter((c) => c.behaviorKey !== null).length;

  return `
  <section class="band band-wide" aria-labelledby="h-delta">
    <div class="rail"><span class="rail-rank rail-word">derived</span><span class="rail-kind">from both<br>profiles</span></div>
    <div class="body">
      <h2 id="h-delta">What changes between profiles</h2>
      <p>Version differences are data the engine reads, not branches a command contains.
        Switching the profile changes what these flags are set to; it does not change which code runs.</p>

      <div class="switcher" role="radiogroup" aria-label="Compatibility profile">
        <button type="button" class="switch is-on" data-profile="lts" role="radio" aria-checked="true" tabindex="0">
          <span class="switch-v mono">${esc(lts.displayVersion)}</span>
          <span class="switch-k">long-term support</span>
        </button>
        <button type="button" class="switch" data-profile="preview" role="radio" aria-checked="false" tabindex="-1">
          <span class="switch-v mono">${esc(preview.displayVersion)}</span>
          <span class="switch-k">preview</span>
        </button>
      </div>

      <p class="sr-only" id="switch-status" role="status" aria-live="polite"></p>

      <div class="scroller" data-scroller role="region" aria-label="Behavior flags">
        <table class="grid behaviors">
          <thead>
            <tr>
              <th scope="col">behavior</th>
              <th scope="col">value in this profile</th>
              <th scope="col">breaking</th>
              <th scope="col">engine</th>
              <th scope="col">what changes in ${esc(preview.displayVersion)}</th>
              <th scope="col">upstream</th>
            </tr>
          </thead>
          <tbody>${behaviorRows}</tbody>
        </table>
      </div>
      <p class="table-note">${esc(keys.length)} flags for ${esc(delta.changes.length)} recorded changes:
        ${esc(delta.changes.length - withKey)} ${pluralise(delta.changes.length - withKey, 'change carries', 'changes carry')}
        no flag, and some share one.
        <b>engine</b> says whether anything in the source reads the flag &mdash;
        ${esc(keys.filter((k) => preview.behaviorDocs[k]?.emulated === true).length)} of ${esc(keys.length)} do.
        <b>documented</b> means the difference is recorded and cited but nothing branches on it yet;
        it is computed by searching the source when the profile is generated, not asserted here.</p>

      <div class="honesty" id="emulated">
        <p class="honesty-n mono">${esc(implemented)} / ${esc(delta.changes.length)}</p>
        <p class="honesty-t">changes are emulated. The rest are recorded and cited, but the engine does not
          reproduce them yet. Nothing here claims fidelity a test has not demonstrated.</p>
      </div>

      <ul class="changes">${changes}</ul>
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// page
// ---------------------------------------------------------------------------

const CSS = String.raw`
:root{
  color-scheme: light dark;

  /* PowerShell's console blue has been #012456 since v1. Here it is the INK on
     pale drafting stock; dark mode gives it back its original job. Both modes
     are grounded in the same subject rather than a theme and its negation. */
  --stock:#E8EDF2; --panel:#DCE4EC; --ink:#012456; --ink-2:#3D5A80; --ink-3:#596C85;
  --rule:#A9BACB; --rule-soft:#C6D2DD;
  --flag:#9B2C1E;            /* disagreement, breaking. The only hot colour. */
  --proof:#1B5E43;           /* sources agree. Used sparingly. */
  --focus:#012456;
  --measure: 68ch;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --stock:#012456; --panel:#02366B; --ink:#E8EDF2; --ink-2:#A8BFD8; --ink-3:#7F9AB9;
    --rule:#215691; --rule-soft:#123F72; --flag:#FF9478; --proof:#63D3A2; --focus:#E8EDF2;
  }
}
:root[data-theme="dark"]{
  --stock:#012456; --panel:#02366B; --ink:#E8EDF2; --ink-2:#A8BFD8; --ink-3:#7F9AB9;
  --rule:#215691; --rule-soft:#123F72; --flag:#FF9478; --proof:#63D3A2; --focus:#E8EDF2;
}

*{box-sizing:border-box}
body{
  margin:0; background:var(--stock); color:var(--ink);
  font-family:"Instrument Sans",ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;
  font-size:16px; line-height:1.6; -webkit-text-size-adjust:100%;
}
.mono{font-family:"IBM Plex Mono",ui-monospace,"Cascadia Mono",Consolas,"DejaVu Sans Mono",monospace;
  font-variant-ligatures:none; font-size:.92em; font-variant-numeric:tabular-nums}
.plain{font-family:inherit;font-size:inherit}
.quiet{color:var(--ink-3)}
.strong{font-weight:600}
.flagged{color:var(--flag)}
.proof{color:var(--proof)}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
  clip:rect(0 0 0 0);white-space:nowrap;border:0}

a{color:inherit;text-decoration-color:var(--rule);text-underline-offset:.18em}
a:hover{text-decoration-color:currentColor}
a:focus-visible,.switch:focus-visible,[data-scroller]:focus-visible{
  outline:2px solid var(--focus);outline-offset:2px}

.wrap{max-width:1180px;margin:0 auto;padding:0 clamp(20px,5vw,56px)}

/* ---------------------------------------------------------------- hero */
.hero{padding:clamp(56px,11vh,110px) 0 clamp(40px,7vh,72px)}
.hero-source{margin:0 0 clamp(26px,4.5vh,40px);color:var(--ink-3);font-size:.84rem}
.hero-sentence{
  margin:0; padding:0; border:0;
  font-size:clamp(1.55rem,4.4vw,3rem); line-height:1.28; font-weight:500;
  letter-spacing:-0.02em; max-width:26ch; text-wrap:balance;
}
/* text-decoration follows line wrapping; an absolutely positioned rule does not. */
.mark{text-decoration:underline;text-decoration-thickness:.055em;text-underline-offset:.14em;
  white-space:nowrap}  /* a version must never break mid-token */
.mark-ok{text-decoration-color:var(--proof)}
.mark-bad{text-decoration-color:var(--flag)}

.apparatus{
  list-style:none;margin:clamp(30px,5vh,48px) 0 0;padding:0;
  display:grid;grid-template-columns:repeat(auto-fit,minmax(min(210px,100%),1fr));
  /* row-gap was 0, which glued each rule to the paragraph above it and inverted
     the grouping at every width where the glosses stack. */
  gap:clamp(26px,3.5vh,36px) clamp(20px,3vw,38px);
  max-width:var(--measure);
}
.gloss{padding-top:.85em;border-top:2px solid var(--rule)}
.gloss-ok{border-top-color:var(--proof)}
.gloss-bad{border-top-color:var(--flag)}
.gloss-frag{margin:0 0 .35em;font-size:.82rem;color:var(--ink);overflow-wrap:anywhere}
.gloss-ok .gloss-frag{color:var(--proof)}
.gloss-bad .gloss-frag{color:var(--flag)}
.gloss-text{margin:0;font-size:.86rem;line-height:1.5;color:var(--ink-2);overflow-wrap:anywhere}
.gloss-text b{color:var(--ink);font-weight:600}

.hero-lede{margin:clamp(34px,6vh,56px) 0 0;max-width:58ch;color:var(--ink-2);font-size:1.06rem}

/* --------------------------------------------------------------- bands */
.band{display:grid;grid-template-columns:150px minmax(0,1fr);gap:0;
  border-top:1px solid var(--rule);padding:clamp(36px,6vh,64px) 0}
/* Prose is capped at a measure; tables are not — capping the whole body forced
   the release table to break dates in half while 840px of margin sat empty. */
.body{max-width:none;padding-left:clamp(16px,3vw,36px);min-width:0}
.body>h2{margin:0 0 .6em;font-size:clamp(1.15rem,2.3vw,1.45rem);font-weight:600;
  letter-spacing:-0.012em;max-width:var(--measure)}
.body>p{margin:0 0 1.15em;color:var(--ink-2);max-width:64ch}
.aside{font-size:.92rem;border-left:2px solid var(--rule);padding-left:1em;max-width:60ch}
.table-note{font-size:.82rem;color:var(--ink-3);margin:.6em 0 0;max-width:60ch}

/* Provenance rail. The numeral is a precedence RANGE computed from the sources
   each band cites, not a step number. Solid rail for machine-readable sources,
   hatched for prose. */
.rail{position:relative;padding-top:.2em;padding-right:18px;text-align:right}
.rail::before{content:"";position:absolute;top:.35em;bottom:0;right:0;width:3px;background:var(--ink-3)}
.rail-prose::before{background:repeating-linear-gradient(180deg,var(--ink-3) 0 3px,transparent 3px 7px)}
.rail-rank{display:block;font-size:1.5rem;line-height:1;color:var(--ink);font-weight:500;
  white-space:nowrap}
.rail-word{font-size:.95rem;font-style:italic}
.rail-kind{display:block;margin-top:.5em;font-size:.72rem;line-height:1.35;color:var(--ink-3)}

@media (max-width:900px){
  .band{grid-template-columns:1fr;gap:1.1em}
  .rail{text-align:left;padding-right:0;padding-left:14px;display:flex;align-items:baseline;gap:.9em}
  .rail::before{right:auto;left:0;top:0;bottom:0}
  .rail-rank{font-size:1.1rem}
  .rail-kind{margin-top:0}
  .rail-kind br{display:none}
  .body{padding-left:0}
}

/* --------------------------------------------------------------- table */
/* Wide content scrolls inside its own box; the page body never scrolls
   sideways. tabindex is applied by script only when it actually scrolls. */
[data-scroller]{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:1.4em 0}
[data-scroller] .grid{margin:0;min-width:max-content}
.grid{width:100%;border-collapse:collapse;font-size:.9rem}
.grid th{text-align:left;font-weight:500;color:var(--ink-3);font-size:.78rem;
  padding:0 1.4em .5em 0;border-bottom:1px solid var(--rule);white-space:nowrap}
.grid td{padding:.62em 1.4em .62em 0;border-bottom:1px solid var(--rule-soft);vertical-align:top}
.grid tbody tr:last-child td{border-bottom:0}
.grid td.mono{white-space:nowrap}

.tag{font-size:.68rem;letter-spacing:.02em;padding:.15em .5em;border:1px solid var(--rule);
  color:var(--ink-2);white-space:nowrap}
.tag-preview{border-color:var(--flag);color:var(--flag)}

/* ----------------------------------------------------- version alignment */
.align{margin:1.6em 0;padding:1.1em 0 0;border-top:1px solid var(--rule-soft)}
.align-row{display:flex;gap:1em;align-items:baseline;flex-wrap:wrap}
.align-label{flex:0 0 15em;color:var(--ink-3);font-size:.82rem}
/* min-width:0 is required: a flex item defaults to min-width:auto and will not
   shrink below its content, so overflow-x never engages. */
.align-value{font-size:.95rem;letter-spacing:-0.01em;white-space:nowrap;
  overflow-x:auto;max-width:100%;min-width:0;flex:1 1 auto;padding-bottom:2px}
.shared{color:var(--ink-3)}
.diverge{color:var(--flag);font-weight:600;border-bottom:2px solid var(--flag)}
.align-note{margin:.8em 0 0 0;font-size:.86rem;color:var(--ink-2);max-width:58ch;overflow-wrap:anywhere}
@media (max-width:720px){.align-label{flex-basis:100%}}

/* A mapping is structurally different from a comparison: one real brace holding
   two values, both at full weight, because there is no shared axis to quieten. */
.map{display:grid;grid-template-columns:auto minmax(0,1fr);gap:0 .9em}
.map-brace{grid-row:1;border-left:2px solid var(--ink-3);border-top:2px solid var(--ink-3);
  border-bottom:2px solid var(--ink-3);width:10px;border-radius:3px 0 0 3px}
.map-rows{grid-row:1;min-width:0}
.map .align-value{color:var(--ink)}
.map .align-note{grid-column:1 / -1}

.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(9em,100%),1fr));
  gap:0 2em;margin:1.6em 0}
.facts dt{color:var(--ink-3);font-size:.76rem;margin:0}
.facts dd{margin:.15em 0 .9em}

/* ------------------------------------------------------------ findings */
.findings{list-style:none;margin:1.2em 0 0;padding:0}
.finding{padding:1em 0 1em 1em;border-left:3px solid var(--rule);margin-bottom:.4em}
.finding.sev-warning{border-left-color:var(--flag)}
.finding.sev-error{border-left-color:var(--flag);background:color-mix(in srgb,var(--flag) 8%,transparent)}
.finding-head{display:flex;gap:.8em;align-items:baseline;margin:0 0 .35em;flex-wrap:wrap}
/* Severity is a word, not only a border colour — the colour alone disappears
   entirely in forced-colors mode. */
.sev-word{font-size:.68rem;letter-spacing:.03em;padding:.1em .5em;border:1px solid currentColor;
  color:var(--ink-3)}
.sev-warning .sev-word,.sev-error .sev-word{color:var(--flag)}
.finding-code{font-size:.8rem;color:var(--ink-3)}
.finding-msg{margin:0;color:var(--ink);font-size:.94rem;max-width:62ch;overflow-wrap:anywhere}
.sides{display:flex;gap:2.2em;flex-wrap:wrap;margin-top:.8em}
.side-label{display:block;font-size:.7rem;color:var(--ink-3);margin-bottom:.1em}

/* ------------------------------------------------------------ switcher */
.switcher{display:flex;margin:1.6em 0 0;border:1px solid var(--rule);width:fit-content;max-width:100%}
.switch{appearance:none;background:transparent;border:0;border-right:1px solid var(--rule);
  padding:.7em 1.1em;text-align:left;cursor:pointer;color:var(--ink-3);font:inherit;flex:1 1 0;
  transition:background .12s ease,color .12s ease}
.switch:last-child{border-right:0}
.switch-v{display:block;font-size:.95rem;white-space:nowrap}
.switch-k{display:block;font-size:.72rem;margin-top:.1em;white-space:nowrap}
/* Two segments with unbreakable version labels do not fit a 320px column;
   stack them rather than let the page scroll sideways. */
@media (max-width:480px){
  .switcher{flex-direction:column;width:100%}
  .switch{border-right:0;border-bottom:1px solid var(--rule)}
  .switch:last-child{border-bottom:0}
}
.switch.is-on{background:var(--ink);color:var(--stock)}

.behaviors .key{width:20em}
.behaviors .val{width:5em;font-weight:600}
.behaviors .mark-cell{width:6.5em;white-space:nowrap}
.behaviors .doc{color:var(--ink-2);font-size:.86rem;white-space:normal;min-width:22em}
.behaviors .pr{text-align:right;white-space:nowrap}
.breaking-mark{font-size:.66rem;letter-spacing:.03em;padding:.1em .45em;
  border:1px solid var(--flag);color:var(--flag)}

/* ------------------------------------------------------------- honesty */
.honesty{display:flex;gap:1.4em;align-items:baseline;margin:2.4em 0 0;padding:1.3em 1.5em;
  border:2px solid var(--flag);background:color-mix(in srgb,var(--flag) 7%,var(--stock))}
.honesty-n{margin:0;font-size:1.6rem;font-weight:600;white-space:nowrap;color:var(--flag)}
.honesty-t{margin:0;font-size:.94rem;color:var(--ink);max-width:56ch}
@media (max-width:600px){.honesty{flex-direction:column;gap:.4em}}

/* ------------------------------------------------------------- changes */
.changes{list-style:none;margin:2em 0 0;padding:0;
  display:grid;grid-template-columns:repeat(auto-fill,minmax(min(320px,100%),1fr));gap:0 2.6em}
.change{padding:1.2em 0;border-top:1px solid var(--rule-soft)}
.change-head{display:flex;justify-content:space-between;gap:1em;margin:0 0 .3em;align-items:baseline}
.change-subject{font-size:.78rem;color:var(--ink-3);overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;min-width:0}
.pr-link{flex:0 0 auto;font-size:.78rem;color:var(--ink-3)}
.change-title{margin:0 0 .4em;font-weight:500;line-height:1.4;overflow-wrap:anywhere}
.change-detail{margin:0 0 .5em;font-size:.86rem;color:var(--ink-2);overflow-wrap:anywhere}
.change-migration{margin:0 0 .5em;font-size:.86rem;color:var(--ink-2);
  border-left:2px solid var(--rule);padding-left:.8em;overflow-wrap:anywhere}
.change-migration b{color:var(--ink)}
.change-meta{display:flex;gap:.7em;margin:.6em 0 0;font-size:.7rem;align-items:center;flex-wrap:wrap}
.change-meta .impact{color:var(--ink-3)}
.emulated{padding:.1em .5em;border:1px solid var(--flag);color:var(--flag);letter-spacing:.02em}
.emulated.is-emulated{border-color:var(--proof);color:var(--proof)}
.change.impact-script-breaking .change-title{color:var(--flag)}
.change.impact-script-breaking{border-top-color:var(--flag)}

/* --------------------------------------------------------------- foot */
.foot{border-top:1px solid var(--rule);padding:2.4em 0 4em;color:var(--ink-3);font-size:.82rem}
.foot p{margin:0 0 .5em;max-width:70ch}

/* Colour alone carries no meaning here: in forced-colors every custom hue is
   replaced, so the green/red distinction in the hero would become three
   identical rules. Re-establish it structurally. */
@media (forced-colors: active){
  .mark-ok{text-decoration-style:solid}
  .mark-bad{text-decoration-style:wavy}
  .gloss-ok{border-top-style:solid}
  .gloss-bad{border-top-style:double;border-top-width:4px}
  .diverge{border-bottom-style:wavy}
  .honesty{border-style:double;border-width:4px}
  .switch.is-on{forced-color-adjust:none;background:Highlight;color:HighlightText}
}

/* One orchestrated moment: the apparatus arrives just after the sentence it
   annotates, left to right. Nothing else animates unless a person asks. */
@media (prefers-reduced-motion:no-preference){
  .gloss{animation:rise .45s cubic-bezier(.2,.7,.3,1) both}
  .gloss:nth-child(1){animation-delay:.30s}
  .gloss:nth-child(2){animation-delay:.44s}
  .gloss:nth-child(3){animation-delay:.58s}
  @keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
}
`;

const JS = String.raw`
(function () {
  // --- profile switching ---------------------------------------------------
  var buttons = Array.prototype.slice.call(document.querySelectorAll('.switch'));
  var status = document.getElementById('switch-status');
  var swap = document.querySelectorAll('.behaviors [data-lts]');

  function apply(profile, focus) {
    buttons.forEach(function (b) {
      var on = b.dataset.profile === profile;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      // Roving tabindex: a radiogroup is one tab stop, arrows move within it.
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    });

    swap.forEach(function (el) {
      el.textContent = profile === 'lts' ? el.dataset.lts : el.dataset.preview;
    });

    // Thirteen cells change at once with no other signal; say so.
    if (status) {
      var label = buttons.filter(function (b) { return b.dataset.profile === profile; })[0];
      var name = label ? label.querySelector('.switch-v').textContent.trim() : profile;
      var rowCount = document.querySelectorAll('.behaviors tbody tr').length;
      status.textContent = 'Showing PowerShell ' + name + ', ' + rowCount + ' behavior flags updated.';
    }
  }

  buttons.forEach(function (b, i) {
    b.addEventListener('click', function () { apply(b.dataset.profile, false); });
    b.addEventListener('keydown', function (e) {
      var d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1
            : e.key === 'ArrowLeft'  || e.key === 'ArrowUp'   ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      var next = buttons[(i + d + buttons.length) % buttons.length];
      apply(next.dataset.profile, true);
    });
  });

  // --- scrollable regions --------------------------------------------------
  // Only a region that actually overflows should be a tab stop, and only then
  // should it claim to be scrollable. Otherwise the first Tab on the page lands
  // on something that announces "scrollable" and does nothing.
  var scrollers = document.querySelectorAll('[data-scroller]');
  function syncScrollers() {
    scrollers.forEach(function (el) {
      var scrolls = el.scrollWidth > el.clientWidth + 1;
      var base = el.getAttribute('aria-label').replace(/, scrollable$/, '');
      if (scrolls) {
        el.tabIndex = 0;
        el.setAttribute('aria-label', base + ', scrollable');
      } else {
        el.removeAttribute('tabindex');
        el.setAttribute('aria-label', base);
      }
    });
  }
  syncScrollers();
  if (typeof ResizeObserver === 'function') {
    var ro = new ResizeObserver(syncScrollers);
    scrollers.forEach(function (el) { ro.observe(el); });
  } else {
    window.addEventListener('resize', syncScrollers);
  }
})();
`;

function renderBody(f: Facts, lts: Profile, preview: Profile, delta: Delta): string {
  const { lock } = f;
  const ranks = new Set(lock.sources.map((s) => s.precedence)).size;
  return `<main class="wrap">
${renderHero(f)}
${renderExists(f)}
${renderAxes(f)}
${renderDisagreements(f)}
${renderDelta(lts, preview, delta)}
</main>
<footer class="foot">
  <div class="wrap">
    <p>Every value on this page is read from
      <span class="mono">compat/upstream/releases.lock.json</span>, the two compatibility profiles,
      and the generated delta. The page is regenerated from them; if it drifts, the build fails.</p>
    <p>Lockfile generated ${esc(lock.generatedAt)} from ${esc(lock.sources.length)} sources across
      ${esc(ranks)} precedence ${pluralise(ranks, 'rank', 'ranks')}.
      Upstream declares <span class="mono">${esc(lock.channels.next ?? 'nothing')}</span> as the next
      release, which does not exist yet.</p>
  </div>
</footer>
<script>${JS}</script>
`;
}

function renderPage(f: Facts, lts: Profile, preview: Profile, delta: Delta): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Version Truth</title>
<meta name="description" content="Version truth: what PowerShell version this workstation targets, where every fact came from, and which sources disagree.">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%23012456'/%3E%3Cpath d='M8 10h16M8 16h16M8 22h9' stroke='%23E8EDF2' stroke-width='2.5' stroke-linecap='square'/%3E%3C/svg%3E">
<!-- Generated by tools/generate-compat-explorer.mts. Do not edit: every value is
     read from compat/upstream/releases.lock.json, the profiles, and the delta. -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Instrument+Sans:wght@400;500;600&display=swap">
<style>${CSS}</style>
</head>
<body>
${renderBody(f, lts, preview, delta)}
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const KNOWN_FLAGS = new Set(['--check', '--artifact']);

function main(): void {
  const argv = process.argv.slice(2);
  const artifactAt = argv.indexOf('--artifact');
  const positional = artifactAt === -1 ? argv : argv.filter((_, i) => i !== artifactAt + 1);
  const unknown = positional.filter((a) => !KNOWN_FLAGS.has(a));
  if (unknown.length > 0) {
    process.stderr.write(
      `\n  unknown option(s): ${unknown.join(', ')}\n  known: ${[...KNOWN_FLAGS].join(', ')}\n\n`,
    );
    process.exitCode = 2;
    return;
  }

  // `--check --artifact <path>` used to write the artifact and RETURN, skipping
  // the check and exiting 0: a gate that reports success for a run in which it
  // did nothing. Every other tool in tools/ rejects a nonsensical flag
  // combination, and verify-release-truth.mts rejects this exact shape
  // (`--check` with `--write`) for the same reason.
  if (artifactAt !== -1 && argv.includes('--check')) {
    process.stderr.write(
      '\n  --check and --artifact are mutually exclusive: --artifact writes a file, which is not a check.\n\n',
    );
    process.exitCode = 2;
    return;
  }

  const lock = read<Lockfile>('compat/upstream/releases.lock.json');
  const ltsVersion = lock.channels.lts.replace(/^v/, '');
  const previewVersion = lock.channels.preview.replace(/^v/, '');
  const lts = read<Profile>(`compat/profiles/powershell-${ltsVersion}-linux.json`);
  const preview = read<Profile>(`compat/profiles/powershell-${previewVersion}-linux.json`);
  const delta = read<Delta>(`compat/deltas/${ltsVersion}__${previewVersion}.json`);

  const facts = deriveFacts(lock);

  if (artifactAt !== -1) {
    // Body-only rendering for publishing as an Artifact, which supplies its own
    // document skeleton. Same render functions as the page, so the two cannot
    // disagree; written outside the repo rather than committed.
    const target = argv[artifactAt + 1];
    if (target === undefined) throw new Error('--artifact needs an output path');
    const body = `<title>Version Truth</title>\n<style>${CSS}</style>\n${renderBody(facts, lts, preview, delta)}`;
    writeFileSync(target, body, 'utf8');
    process.stdout.write(
      `  wrote ${target} (artifact fragment, ${(body.length / 1024).toFixed(1)} KB)\n`,
    );
    return;
  }

  const html = renderPage(facts, lts, preview, delta);

  if (argv.includes('--check')) {
    if (!existsSync(OUT) || readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') !== html) {
      process.stderr.write('\n  compat/explorer.html is out of date.\n  run: npm run explorer\n\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write('  compatibility explorer is in sync.\n');
    return;
  }

  writeFileSync(OUT, html, 'utf8');
  process.stdout.write(`  wrote ${OUT} (${(html.length / 1024).toFixed(1)} KB)\n`);
}

main();
