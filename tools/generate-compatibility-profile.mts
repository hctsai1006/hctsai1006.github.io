/**
 * generate-compatibility-profile.mts — turn verified upstream facts into the
 * profiles the engine boots against.
 *
 * The rule this enforces: adding a PowerShell version must never mean forking a
 * command. A version difference is data the engine reads, not a branch a command
 * contains. So nothing here is hand-typed —
 *
 *   provenance        <- compat/upstream/releases.lock.json  (verified)
 *   command inventory <- compat/upstream/v<ver>/command-metadata.json (captured
 *                        from a real pwsh)
 *   semantics         <- compat/deltas/powershell-77-changes.source.mts (curated,
 *                        every entry citing an upstream PR)
 *
 * — and the output is regenerated rather than edited.
 *
 * Two invariants are enforced here rather than merely documented:
 *
 *   1. Every behavior key has a behaviorDocs entry with an upstream PR. An
 *      undocumented flag is a guess wearing the costume of a fact.
 *
 *   2. The baseline profile's value for every key is the OPPOSITE of the 7.7
 *      value, derived mechanically. Writing both by hand invites them to agree
 *      by accident, which would silently make the two profiles identical and the
 *      whole compatibility plane a no-op.
 *
 * Usage:
 *   node tools/generate-compatibility-profile.mts           write
 *   node tools/generate-compatibility-profile.mts --check   verify, exit 1 on drift
 */

import { readFileSync, readdirSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ajv2020 from 'ajv/dist/2020.js';
import ajvFormats from 'ajv-formats';

import { POWERSHELL_77_CHANGES, BUNDLED_MODULES } from '../compat/deltas/powershell-77-changes.source.mts';
import type { Change } from '../compat/deltas/powershell-77-changes.source.mts';
import { byCodepoint } from './version.mts';

type AjvValidator = ((data: unknown) => boolean) & {
  errors?: Array<{ instancePath?: string; message?: string }> | null;
};
type AjvInstance = { compile: (schema: object) => AjvValidator };
type AjvCtor = new (opts: Record<string, unknown>) => AjvInstance;
const Ajv = ((ajv2020 as unknown as { default?: unknown }).default ?? ajv2020) as unknown as AjvCtor;
const addFormats = ((ajvFormats as unknown as { default?: unknown }).default ??
  ajvFormats) as (ajv: AjvInstance) => void;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const LOCKFILE = join(REPO, 'compat', 'upstream', 'releases.lock.json');
const PROFILE_DIR = join(REPO, 'compat', 'profiles');
const DELTA_DIR = join(REPO, 'compat', 'deltas');
const PROFILE_SCHEMA = join(REPO, 'compat', 'schemas', 'compatibility-profile.schema.json');
const DELTA_SCHEMA = join(REPO, 'compat', 'schemas', 'behavior-delta.schema.json');

const PLATFORM = 'linux';

// ---------------------------------------------------------------------------
// inputs
// ---------------------------------------------------------------------------

interface LockRelease {
  tag: string;
  version: string;
  channel: string;
  prerelease: boolean;
  publishedAt: string;
  commitSha: string;
  dotnet: { sdk: string; runtime: string | null; releaseType: string | null };
  supportedUntil: string | null;
  snapshotDigest: string;
}

interface CitedPullRequest {
  number: number;
  title: string;
  mergeCommitSha: string;
  mergedAt: string;
}

interface Lockfile {
  generatedAt: string;
  channels: { lts: string; preview: string };
  releases: LockRelease[];
  citations?: { source: string; pullRequests: CitedPullRequest[] };
}

interface CapturedMetadata {
  engine: { psVersion: string };
  commands: Record<string, unknown>;
  missing: string[];
}

function readLockfile(): Lockfile {
  if (!existsSync(LOCKFILE)) {
    throw new CannotCheck(
      `no release lockfile at ${LOCKFILE}. Profiles are derived from verified upstream facts, ` +
        'so there is nothing to derive from. Run: npm run truth:write',
    );
  }
  return JSON.parse(readFileSync(LOCKFILE, 'utf8')) as Lockfile;
}

function readCapturedMetadata(version: string): CapturedMetadata | null {
  const p = join(REPO, 'compat', 'upstream', `v${version}`, 'command-metadata.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as CapturedMetadata;
}

// ---------------------------------------------------------------------------
// behaviors
// ---------------------------------------------------------------------------

type BehaviorValue = boolean | number | string | null;

/**
 * The 7.6.5 value for a key, derived from the 7.7 value rather than restated.
 *
 * If both were hand-written they could agree by accident, which would make the
 * two profiles identical and quietly turn the entire compatibility layer into a
 * no-op that still looks like it is working.
 */
function baselineValueFor(change: Change): BehaviorValue {
  const v = change.behaviorValue;
  if (typeof v === 'boolean') return !v;
  if (change.behaviorKey === 'newGuid.defaultVersion') return 4; // was UUID v4
  if (typeof v === 'number') return null;
  return null;
}

interface BehaviorTables {
  baseline: Record<string, BehaviorValue>;
  target: Record<string, BehaviorValue>;
  docs: Record<
    string,
    { summary: string; upstreamPr: number | null; breaking: boolean; since: string; emulated: boolean }
  >;
}

/**
 * Does anything in src/ actually read this flag?
 *
 * Thirteen behaviour keys ship; four are wired to code. The explorer presented
 * all thirteen identically, so a visitor could not tell a difference the engine
 * MODELS from one the repository merely DOCUMENTS — which is the precise claim
 * this project is organised against making. Computed here by searching the
 * source at generation time rather than hand-maintained, because a hand-kept
 * flag is the thing that goes stale the first time somebody wires a key up.
 *
 * The search is for the key as a literal string. That is what a consumer must
 * write to read the flag out of a profile (`behaviors['newGuid.defaultVersion']`),
 * so a hit is meaningful; what it cannot prove is that the code does anything
 * useful with it. `emulated: true` therefore means "at least one place in src/
 * names this flag", never "the difference is faithfully reproduced" — that is
 * what the conformance corpus is for.
 */
const SRC_DIR = join(REPO, 'src');

function collectSourceText(dir: string, into: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectSourceText(full, into);
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.mts')) {
      into.push(readFileSync(full, 'utf8'));
    }
  }
}

const SOURCE_TEXTS: readonly string[] = ((): readonly string[] => {
  const out: string[] = [];
  collectSourceText(SRC_DIR, out);
  return out;
})();

const isEmulated = (behaviorKey: string): boolean =>
  SOURCE_TEXTS.some((text) => text.includes(behaviorKey));

function buildBehaviorTables(changes: readonly Change[], targetVersion: string): BehaviorTables {
  const baseline: Record<string, BehaviorValue> = {};
  const target: Record<string, BehaviorValue> = {};
  const docs: BehaviorTables['docs'] = {};

  for (const c of changes) {
    if (c.behaviorKey === undefined) continue;
    const value = c.behaviorValue ?? null;

    // Several upstream PRs can land on one behavior key — the explicit-$false
    // family is thirteen PRs and one flag. Keep the first citation and require
    // the value to agree, so a contradiction is a hard error rather than a
    // last-writer-wins surprise.
    const existing = target[c.behaviorKey];
    if (existing !== undefined && existing !== value) {
      throw new Error(
        `behavior "${c.behaviorKey}" is given conflicting values (${JSON.stringify(existing)} and ${JSON.stringify(value)}) by different changes`,
      );
    }

    target[c.behaviorKey] = value;
    baseline[c.behaviorKey] = baselineValueFor(c);
    docs[c.behaviorKey] ??= {
      summary: c.title,
      upstreamPr: c.upstreamPr,
      breaking: c.kind === 'breaking',
      since: targetVersion,
      emulated: isEmulated(c.behaviorKey),
    };
  }

  return { baseline, target, docs };
}

const sortKeys = <T,>(o: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(o).sort(([a], [b]) => byCodepoint(a, b)));

// ---------------------------------------------------------------------------
// profiles
// ---------------------------------------------------------------------------

interface BuildProfileArgs {
  release: LockRelease;
  channel: 'lts' | 'preview';
  inherits: string | null;
  behaviors: Record<string, BehaviorValue>;
  docs: BehaviorTables['docs'];
  commands: Record<string, unknown>;
  lockGeneratedAt: string;
}

function buildProfile(args: BuildProfileArgs): Record<string, unknown> {
  const { release } = args;
  const modules = BUNDLED_MODULES[release.version as keyof typeof BUNDLED_MODULES];

  return {
    schemaVersion: 1,
    profile: `powershell/${release.version}/${PLATFORM}`,
    channel: args.channel,
    displayVersion: release.version,
    inherits: args.inherits,
    supported: {
      isSupportedUpstream: !release.prerelease,
      endOfSupport: release.supportedUntil,
      notes: release.prerelease
        ? 'Preview releases are not supported upstream and must never own durable state. This profile is for exploring 7.7 semantics, not for persistence.'
        : `Support is inherited from .NET: this line builds on a .NET ${release.dotnet.releaseType?.toUpperCase() ?? '?'} channel.`,
    },
    source: {
      releaseTag: release.tag,
      publishedAt: release.publishedAt,
      dotnetSdk: release.dotnet.sdk,
      sourceCommit: release.commitSha,
      snapshotDigest: release.snapshotDigest,
      derivedFrom: `releases.lock.json generated ${args.lockGeneratedAt}`,
    },
    ...(modules ? { bundledModules: sortKeys({ ...modules }) } : {}),
    behaviors: sortKeys(args.behaviors),
    behaviorDocs: sortKeys(args.docs),
    commands: sortKeys(args.commands),
    experimentalFeatures: [],
    engineLimits: {
      // Stated, not implied. The site must never let a visitor believe a real
      // pwsh binary is running in their browser.
      nativePowerShellEngine: false,
      unimplementedAstNodes: [],
      notes:
        'BrowserShell emulates observable semantics; it does not execute PowerShell. Recognised-but-unimplemented syntax must fail with an explicit error naming the AST node rather than silently doing something approximate.',
    },
  };
}

// ---------------------------------------------------------------------------
// delta
// ---------------------------------------------------------------------------

function buildDelta(
  from: LockRelease,
  to: LockRelease,
  changes: readonly Change[],
  generatedAt: string,
): Record<string, unknown> {
  const entries = changes.map((c) => ({
    kind: c.kind,
    subject: c.subject,
    subjectKind: c.subjectKind,
    title: c.title,
    ...(c.detail !== undefined ? { detail: c.detail } : {}),
    impact: c.impact,
    behaviorKey: c.behaviorKey ?? null,
    upstreamPr: c.upstreamPr,
    ...(c.migration !== undefined ? { migration: c.migration } : {}),
    conformanceFixture: null,
    implemented: c.implemented,
  }));

  const count = (k: Change['kind']): number => changes.filter((c) => c.kind === k).length;

  const summary = {
    breaking: count('breaking'),
    added: count('added'),
    changed: count('changed'),
    removed: count('removed'),
    fixed: count('fixed'),
    implemented: changes.filter((c) => c.implemented).length,
  };

  // A summary that silently omits a kind is worse than no summary: it looks
  // authoritative while under-reporting. Assert it accounts for everything.
  const counted = summary.breaking + summary.added + summary.changed + summary.removed + summary.fixed;
  if (counted !== changes.length) {
    throw new Error(
      `delta summary counts ${counted} changes but there are ${changes.length}; a change kind is unaccounted for`,
    );
  }

  return {
    schemaVersion: 1,
    from: `powershell/${from.version}/${PLATFORM}`,
    to: `powershell/${to.version}/${PLATFORM}`,
    generatedAt,
    summary,
    changes: entries,
  };
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

// ajv registers a schema by its $id and refuses to register the same $id twice,
// so compiling per call throws on the second profile. Compile once, reuse.
const compiled = new Map<string, AjvValidator>();

function validatorFor(schemaPath: string): AjvValidator {
  const cached = compiled.get(schemaPath);
  if (cached !== undefined) return cached;
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object;
  const check = ajv.compile(schema);
  compiled.set(schemaPath, check);
  return check;
}

function validate(schemaPath: string, doc: unknown, what: string): void {
  const check = validatorFor(schemaPath);
  if (!check(doc)) {
    const errs = (check.errors ?? [])
      .map((e) => `    ${e.instancePath || '/'} ${e.message ?? ''}`)
      .join('\n');
    throw new Error(`${what} violates ${schemaPath}:\n${errs}`);
  }
}

/** Every behavior key must be documented, and every doc must cite a PR. */
function assertBehaviorsDocumented(
  profile: Record<string, unknown>,
  verified: ReadonlyMap<number, CitedPullRequest>,
): void {
  const behaviors = profile['behaviors'] as Record<string, unknown>;
  const docs = profile['behaviorDocs'] as Record<string, { upstreamPr?: number | null }>;
  const problems: string[] = [];
  for (const key of Object.keys(behaviors)) {
    const doc = docs[key];
    if (doc === undefined) {
      problems.push(`behavior "${key}" has no behaviorDocs entry — an undocumented flag is a guess`);
      continue;
    }
    if (doc.upstreamPr === undefined || doc.upstreamPr === null) {
      problems.push(`behavior "${key}" has no upstream PR citation`);
      continue;
    }
    // "non-null" was the whole check, and non-null is not the same as REAL.
    // Setting a citation to 99999999 regenerated the profiles and the published
    // explorer with every gate green, and pull/99999999 appeared in the shipped
    // HTML. verify-release-truth.mts now resolves each cited number against the
    // GitHub pull-request API and records the merged ones in the lockfile; this
    // is where the profile refuses to ship one that is not there.
    if (!verified.has(doc.upstreamPr)) {
      problems.push(
        `behavior "${key}" cites upstream PR #${doc.upstreamPr}, which is not among the citations ` +
          'verified in compat/upstream/releases.lock.json. Either the number is wrong, or the ' +
          'lockfile predates it: npm run truth:write',
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(`${String(profile['profile'])}:\n${problems.map((p) => `    ${p}`).join('\n')}`);
  }
}

/**
 * Every citation in the curated change list, not only the ones that reached a
 * behaviour flag: a change with no behaviorKey still renders as a card in the
 * published explorer, carrying its PR number as a link.
 */
function assertCitationsVerified(
  changes: readonly Change[],
  verified: ReadonlyMap<number, CitedPullRequest>,
): void {
  const missing = [...new Set(changes.map((c) => c.upstreamPr))]
    .filter((n) => !verified.has(n))
    .sort((a, b) => a - b);
  if (missing.length > 0) {
    throw new Error(
      `compat/deltas/powershell-77-changes.source.mts cites ${missing.length} pull request(s) that ` +
        `compat/upstream/releases.lock.json does not list as existing and merged: ${missing.map((n) => `#${n}`).join(', ')}.\n` +
        '    A citation is the evidence for a behaviour claim. If the number is right, refresh the\n' +
        '    lockfile (npm run truth:write); if the lockfile already refused it, the number is wrong.',
    );
  }
}

/**
 * The inputs to a check are missing, so the check did not run.
 *
 * Distinct from "the check ran and the data is wrong", and given a distinct
 * exit code for the same reason verify-release-truth.mts separates 1 from 2: a
 * lockfile that predates citation verification cannot say a citation is bad,
 * and reporting that as a bad citation would send the next reader to fix the
 * wrong file.
 */
class CannotCheck extends Error {}

function verifiedCitations(lock: Lockfile): ReadonlyMap<number, CitedPullRequest> {
  const citations = lock.citations;
  if (citations === undefined) {
    throw new CannotCheck(
      'compat/upstream/releases.lock.json has no `citations` section, so no upstream PR citation in ' +
        'the curated change list has been checked against anything. Regenerate it: npm run truth:write',
    );
  }
  return new Map(citations.pullRequests.map((p) => [p.number, p]));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

interface Artifact {
  path: string;
  content: string;
}

function collect(): Artifact[] {
  const lock = readLockfile();
  const byTag = new Map(lock.releases.map((r) => [r.tag, r]));

  const lts = byTag.get(lock.channels.lts);
  const preview = byTag.get(lock.channels.preview);
  if (lts === undefined || preview === undefined) {
    throw new Error('the lockfile does not contain both the LTS and preview releases');
  }

  const { baseline, target, docs } = buildBehaviorTables(POWERSHELL_77_CHANGES, preview.version);

  // Command availability, taken from the reference implementation where a
  // capture exists rather than asserted.
  const ltsCaptured = readCapturedMetadata(lts.version);
  const ltsCommands: Record<string, unknown> = {};
  if (ltsCaptured !== null) {
    for (const name of Object.keys(ltsCaptured.commands).sort(byCodepoint)) {
      ltsCommands[name] = { availability: 'available' };
    }
  }

  // Commands the curated changes say 7.7 adds. Their absence in 7.6.5 was
  // independently confirmed by the capture.
  const previewCommands: Record<string, unknown> = {};
  for (const c of POWERSHELL_77_CHANGES) {
    if (c.kind !== 'added' || c.subjectKind !== 'command') continue;
    for (const name of c.subject.split(',').map((s) => s.trim())) {
      if (ltsCaptured !== null && name in ltsCaptured.commands) continue;
      previewCommands[name] = {
        availability: 'added',
        since: preview.version,
        notes: `${c.title} (upstream #${c.upstreamPr})`,
      };
    }
  }

  const ltsProfile = buildProfile({
    release: lts,
    channel: 'lts',
    inherits: null,
    behaviors: baseline,
    docs,
    commands: ltsCommands,
    lockGeneratedAt: lock.generatedAt,
  });

  const previewProfile = buildProfile({
    release: preview,
    channel: 'preview',
    inherits: `powershell/${lts.version}/${PLATFORM}`,
    behaviors: target,
    docs,
    commands: previewCommands,
    lockGeneratedAt: lock.generatedAt,
  });

  const verified = verifiedCitations(lock);
  assertCitationsVerified(POWERSHELL_77_CHANGES as readonly Change[], verified);
  for (const p of [ltsProfile, previewProfile]) {
    validate(PROFILE_SCHEMA, p, String(p['profile']));
    assertBehaviorsDocumented(p, verified);
  }

  // Two changes citing one PR with different behaviour keys means the curation
  // is probably wrong: a PR number is the citation, and one citation cannot
  // support two unrelated claims. Surfaced rather than silently rendered as two
  // cards showing the same number.
  const byPr = new Map<number, Set<string>>();
  // `as const satisfies` narrows each entry to its literal shape, so an entry
  // that omits the optional behaviorKey has no such property to read. Widen.
  for (const c of POWERSHELL_77_CHANGES as readonly Change[]) {
    const keys = byPr.get(c.upstreamPr) ?? new Set<string>();
    keys.add(c.behaviorKey ?? '(none)');
    byPr.set(c.upstreamPr, keys);
  }
  for (const [pr, keys] of byPr) {
    if (keys.size > 1) {
      process.stderr.write(
        `  warning: upstream #${pr} is cited by changes with different behavior keys ` +
          `(${[...keys].join(', ')}). Check the curation.
`,
      );
    }
  }

  const delta = buildDelta(lts, preview, POWERSHELL_77_CHANGES, lock.generatedAt);
  validate(DELTA_SCHEMA, delta, 'the behavior delta');

  // Sanity: the two profiles must actually differ, or the compatibility layer is
  // a no-op that still looks like it is working.
  const differing = Object.keys(target).filter((k) => target[k] !== baseline[k]);
  if (differing.length === 0) {
    throw new Error('the two profiles have identical behaviors — the compatibility layer would be a no-op');
  }

  return [
    {
      path: join(PROFILE_DIR, `powershell-${lts.version}-${PLATFORM}.json`),
      content: JSON.stringify(ltsProfile, null, 2) + '\n',
    },
    {
      path: join(PROFILE_DIR, `powershell-${preview.version}-${PLATFORM}.json`),
      content: JSON.stringify(previewProfile, null, 2) + '\n',
    },
    {
      path: join(DELTA_DIR, `${lts.version}__${preview.version}.json`),
      content: JSON.stringify(delta, null, 2) + '\n',
    },
  ];
}

/**
 * A closed set, for the same reason generate-roadmap.mts has one — and this
 * tool was the one that never got it.
 *
 * The default action here is to WRITE. So a mistyped `--chek` did not verify
 * anything: it regenerated the files, REPAIRED the corruption it was supposed
 * to detect, and exited 0. Demonstrated on a deliberately corrupted profile,
 * where `npm run profiles -- --chek` printed "wrote 3 files" and left a clean
 * tree. In CI that is the gate rewriting the thing it was meant to be checking,
 * which is the failure this repository exists to prevent, inside the safety net.
 */
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
  const check = argv.includes('--check');
  const artifacts = collect();

  const expected = new Set(artifacts.map((a) => a.path));

  /**
   * A generated file with no data behind it is drift too.
   *
   * generate-roadmap.mts already guards this; this tool never got it. Copying
   * compat/profiles/powershell-7.6.5-linux.json to powershell-7.5.0-linux.json
   * left a profile for a release the lockfile has never heard of sitting in the
   * served directory, with --check at rc=0 — a version claim with nothing
   * behind it, which is the one thing this pipeline exists to make impossible.
   *
   * Only the generated shapes are considered, so the hand-authored
   * powershell-77-changes.source.mts living in compat/deltas is not an orphan.
   */
  const orphansIn = (dir: string, generated: (name: string) => boolean): string[] => {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      const full = join(entry.parentPath, entry.name);
      if (entry.isDirectory()) {
        out.push(`unexpected directory: ${full}`);
        continue;
      }
      if (!generated(entry.name)) continue;
      if (!expected.has(full)) out.push(`orphan: ${full}`);
    }
    return out;
  };
  const isProfileFile = (name: string): boolean => /^powershell-.*\.json$/i.test(name);
  const isDeltaFile = (name: string): boolean => /^.+__.+\.json$/i.test(name);
  const orphans = [
    ...orphansIn(PROFILE_DIR, isProfileFile),
    ...orphansIn(DELTA_DIR, isDeltaFile),
  ];

  if (check) {
    const drift = artifacts
      .filter((a) => !existsSync(a.path) || readFileSync(a.path, 'utf8').replace(/\r\n/g, '\n') !== a.content)
      .map((a) => a.path);
    const problems = [...drift, ...orphans];
    if (problems.length > 0) {
      process.stderr.write('\n  generated compatibility profiles are out of date:\n');
      for (const d of problems) process.stderr.write(`    - ${d}\n`);
      process.stderr.write('\n  run: npm run profiles\n\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`  compatibility profiles are in sync (${artifacts.length} files).\n`);
    return;
  }

  // Writing removes what the data no longer produces, so `npm run profiles`
  // actually resolves what --check reports rather than leaving it forever red.
  for (const orphan of orphans) {
    if (!orphan.startsWith('orphan: ')) continue;
    rmSync(orphan.slice('orphan: '.length));
  }
  for (const a of artifacts) {
    mkdirSync(dirname(a.path), { recursive: true });
    writeFileSync(a.path, a.content, 'utf8');
  }

  const behaviorCount = Object.keys(
    (JSON.parse(artifacts[1]?.content ?? '{}') as { behaviors?: object }).behaviors ?? {},
  ).length;
  process.stdout.write(
    `  wrote ${artifacts.length} files: 2 profiles, 1 delta, ${behaviorCount} behavior flags, ` +
      `${POWERSHELL_77_CHANGES.length} recorded changes.\n`,
  );
}

try {
  main();
} catch (error) {
  // A stack trace is not an error message. The two exit codes say which file the
  // reader should open: 1 means the curated data is wrong, 2 means the inputs the
  // check needs are not there yet.
  process.stderr.write(`
  ${(error as Error).message}

`);
  process.exitCode = error instanceof CannotCheck ? 2 : 1;
}
