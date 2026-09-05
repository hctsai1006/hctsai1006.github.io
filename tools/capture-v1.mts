/**
 * capture-v1.mts — record what the v1 terminal actually prints.
 *
 * Before this file there were zero fixtures under tests/conformance/fixtures/v1
 * and no way to produce one. "Parity with v1" was the only claim in this
 * repository with no measurement behind it, and it is the baseline every other
 * claim is compared against.
 *
 * WHAT IT PRODUCES
 *
 *   tests/conformance/fixtures/v1/<command>.txt   one line per printed row
 *   tests/conformance/fixtures/v1/manifest.json   what each file is, and a seal
 *
 * The .txt is exactly what v1 put on the screen: `textContent` of every `.row`
 * under `#out`, one per line, nothing added. No header, no timestamp, no
 * capture metadata — a fixture that carries the moment it was taken is a
 * fixture that differs from itself.
 *
 * The style each row was printed with (`err`, `muted`, `head`, a link and its
 * href) lives in the manifest instead of the transcript. It is not decoration:
 * v1 prints "not recognized" in `err` and "Run help" in `muted`, and a rewrite
 * that emits the right words in the wrong stream would be wrong. Keeping it out
 * of the .txt keeps the transcript readable and keeps the check total.
 *
 * HOW THE COMMAND LIST IS BUILT, AND WHY NOT FROM THE INVENTORY
 *
 * `src/commands/v1-inventory.json` is used, but only as the second opinion. The
 * list is read out of the RUNNING page — its own `CMDLETS`, `ALIAS`, `EGGS`,
 * `APPS` and `CORPUS` — and then compared field by field against the checked-in
 * inventory. Either side disagreeing is a hard failure. An enumeration that
 * reads the same file the coverage assertion reads cannot detect a command the
 * file is missing; two independent readings can.
 *
 * DETERMINISM IS MEASURED, NOT ASSUMED
 *
 * Every case is run six times: twice under the recorded environment, and once
 * under each of four single-axis variants (clock, seed, timezone, locale). The
 * second identical run is the one that matters most — it is the only thing that
 * can tell a transcript that is stable from a transcript that merely looked
 * stable once. A case whose two identical runs disagree is NOT written as a
 * fixture; it is recorded in `unstable` with the diff, because a fixture that
 * flakes is worse than a missing one.
 *
 * Usage:
 *   node tools/capture-v1.mts             capture and write
 *   node tools/capture-v1.mts --check     re-capture and diff, exit 1 on drift
 *   node tools/capture-v1.mts --only <s>  capture a subset (REFUSED with --check)
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Browser } from 'playwright';

import { launchBrowser, openV1, serveArchive } from './browser-harness.mts';
import type { ArchiveServer } from './browser-harness.mts';
import {
  ARCHIVE,
  ARCHIVE_PATH,
  BASELINE,
  FIXTURES,
  INVENTORY,
  MANIFEST,
  REPO,
  VARIANTS,
  buildCases,
  corpusFromLiterals,
  lf,
  readArchiveLiterals,
  sha256,
  sha256Bytes,
} from './v1-fixtures.mts';
import type {
  CaseRecord,
  CaseSpec,
  Environment,
  LiveInventory,
  Manifest,
  UnstableRecord,
  V1RawCommand,
} from './v1-fixtures.mts';

/* ------------------------------------------------------------------ page API */

/**
 * Declared, never defined. These are v1's own top-level bindings; the bodies
 * below run inside the page, where they exist. Declaring them is what lets the
 * evaluate callbacks be type-checked instead of being untyped strings.
 */
declare const CMDLETS: Record<string, V1RawCommand>;
declare const ALIAS: Record<string, string>;
declare const EGGS: Record<string, unknown>;
declare const APPS: readonly string[];
declare const DISP: Record<string, string>;
declare const CORPUS: readonly string[];
declare const hist: string[];
declare const CWD: string;
declare const ED: { open: boolean; app: string; name: string; ro: boolean; isNew: boolean };
declare const reduceMotion: boolean;
declare function setVal(s: string): void;
declare function run(): void;

/* --------------------------------------------------------------- transcripts */

export interface Transcript {
  /** The .txt body: one row per line, LF separated, trailing LF. Empty means no rows. */
  readonly text: string;
  readonly rows: number;
  /** Per row, a compact description of the elements it was built from. */
  readonly styles: readonly string[];
  /** False only when the command wiped the boot banner (Clear-Host and friends). */
  readonly bootPrefixIntact: boolean;
  readonly editorOpen: boolean;
  readonly editorApp: string;
  readonly cwd: string;
  readonly theme: string;
  /** True when the rows were identical again after a settle delay. */
  readonly settled: boolean;
  readonly pageErrors: readonly string[];
}

/* --------------------------------------------------------- reading the page */

async function readLiveInventory(server: ArchiveServer, browser: Browser): Promise<LiveInventory> {
  const v1 = await openV1(browser, server, BASELINE);
  try {
    const live = await v1.page.evaluate((): LiveInventory => {
      const cmdlets = Object.keys(CMDLETS)
        .sort()
        .map((name) => {
          const c = CMDLETS[name] ?? {};
          const title = (n: string): string =>
            n
              .split('-')
              .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
              .join('-');
          return {
            name,
            display: c.disp ?? DISP[name] ?? (name.indexOf('-') > 0 ? title(name) : name),
            kind: c.type ?? (APPS.includes(name) ? 'Application' : 'Cmdlet'),
            params: c.params ?? [],
            help: c.help ?? '',
            asyncOut: c.asyncOut === true,
            paths: c.paths === true,
            hidden: c.hidden === true,
          };
        });
      let localStorageWorks = false;
      try {
        localStorage.setItem('__probe', '1');
        localStorage.removeItem('__probe');
        localStorageWorks = true;
      } catch {
        localStorageWorks = false;
      }
      return {
        cmdlets,
        aliases: Object.keys(ALIAS)
          .sort()
          .map((a) => [a, ALIAS[a] ?? ''] as const),
        eggs: Object.keys(EGGS).sort(),
        apps: [...APPS].sort(),
        corpus: [...CORPUS],
        seededHistory: [...hist],
        reducedMotion: reduceMotion,
        localStorageWorks,
      };
    });
    if (v1.pageErrors.length > 0) {
      throw new Error(`the archive threw while booting: ${v1.pageErrors.join('; ')}`);
    }
    return live;
  } finally {
    await v1.close();
  }
}

/* ----------------------------------------------------------------- capturing */

/** Settle delay, in ms, used to prove no output arrived late. */
const SETTLE_MS = 150;

async function captureOne(
  browser: Browser,
  server: ArchiveServer,
  env: Environment,
  spec: CaseSpec,
): Promise<Transcript> {
  const v1 = await openV1(browser, server, env);
  try {
    const first = await v1.page.evaluate((command: string | null) => {
      const describe = (row: Element): { text: string; style: string } => {
        const parts: string[] = [];
        for (const child of row.children) {
          const cls = child.className === '' ? '' : `.${child.className}`;
          const href = child.tagName === 'A' ? `[${child.getAttribute('href') ?? ''}]` : '';
          parts.push(`${child.tagName.toLowerCase()}${cls}${href}`);
        }
        const inline = row.getAttribute('style');
        if (inline !== null && inline !== '') parts.push(`@${inline}`);
        return { text: row.textContent ?? '', style: parts.join(' ') };
      };
      const snapshot = (): { text: string; style: string }[] =>
        [...document.querySelectorAll('#out .row')].map(describe);

      const before = snapshot();
      if (command !== null) {
        setVal(command);
        run();
      }
      const after = snapshot();
      const intact =
        after.length >= before.length &&
        before.every((row, i) => after[i]?.text === row.text && after[i]?.style === row.style);
      const body = intact && command !== null ? after.slice(before.length) : after;
      return {
        body,
        all: after,
        bootPrefixIntact: intact,
        editorOpen: ED.open,
        editorApp: ED.app,
        cwd: CWD,
        theme: document.documentElement.getAttribute('data-theme') ?? '',
        // The history case records what v1 seeded, which is otherwise invisible:
        // nothing is printed, so its transcript would be an empty file.
        seeded: command === null ? [...hist] : [],
      };
    }, spec.command);

    // Prove nothing arrived late. `prefers-reduced-motion` makes v1 print async
    // output in one batch, but that is a claim about a branch in someone else's
    // code, and a claim is not a measurement. `ping` streams eight rows over
    // 180ms each when the branch is NOT taken, so a settle this short is enough
    // to catch it having been missed.
    await v1.page.waitForTimeout(SETTLE_MS);
    const afterSettle = await v1.page.evaluate(() =>
      [...document.querySelectorAll('#out .row')].map((r) => r.textContent ?? '').join(''),
    );
    const atCapture = first.all.map((r) => r.text).join('');
    const settled = afterSettle === atCapture;

    // `__history` prints nothing, so its transcript is the seeded list itself.
    const lines =
      spec.slug === '__history'
        ? first.seeded
        : first.body.map((r) => r.text);
    const styles = spec.slug === '__history' ? first.seeded.map(() => '') : first.body.map((r) => r.style);

    for (const line of lines) {
      if (/[\r\n]/.test(line)) {
        throw new Error(
          `${spec.slug}: a printed row contains a newline, which the one-row-per-line ` +
            `transcript format cannot represent: ${JSON.stringify(line)}`,
        );
      }
    }

    return {
      text: lines.length === 0 ? '' : `${lines.join('\n')}\n`,
      rows: lines.length,
      styles,
      bootPrefixIntact: first.bootPrefixIntact,
      editorOpen: first.editorOpen,
      editorApp: first.editorApp,
      cwd: first.cwd,
      theme: first.theme,
      settled,
      pageErrors: [...v1.pageErrors],
    };
  } finally {
    await v1.close();
  }
}

/** Everything about a transcript that a replay has to reproduce. */
const shapeOf = (t: Transcript): string =>
  JSON.stringify({
    text: t.text,
    styles: t.styles,
    bootPrefixIntact: t.bootPrefixIntact,
    editorOpen: t.editorOpen,
    editorApp: t.editorApp,
    cwd: t.cwd,
    theme: t.theme,
  });

function firstDifference(a: string, b: string): string {
  const left = a.split('\n');
  const right = b.split('\n');
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n; i += 1) {
    if (left[i] !== right[i]) {
      return `line ${String(i + 1)}: ${JSON.stringify(left[i])} vs ${JSON.stringify(right[i])}`;
    }
  }
  return 'identical';
}

/* -------------------------------------------------------------------- report */

export interface CaptureReport {
  readonly manifest: Manifest;
  readonly transcripts: ReadonlyMap<string, Transcript>;
  readonly inventoryProblems: readonly string[];
  readonly requestedPaths: readonly string[];
}

export interface CaptureOptions {
  /** Vary the environment and classify every case. Off makes one pass per case. */
  readonly probeSensitivity: boolean;
  /** Substring filter over slugs. Never allowed on the path that writes or checks. */
  readonly only?: string;
  readonly onProgress?: (done: number, total: number, slug: string) => void;
}

export async function runCapture(options: CaptureOptions): Promise<CaptureReport> {
  const archiveBytes = readFileSync(ARCHIVE);
  const archiveText = archiveBytes.toString('utf8');

  const server = await serveArchive();
  const browser = await launchBrowser();
  try {
    const live = await readLiveInventory(server, browser);
    const inventoryProblems = compareInventories(live, archiveText);

    let cases = buildCases(live);
    if (options.only !== undefined && options.only !== '') {
      const needle = options.only.toLowerCase();
      cases = cases.filter((c) => c.slug.toLowerCase().includes(needle));
      if (cases.length === 0) throw new Error(`--only ${options.only} matched no case`);
    }

    const transcripts = new Map<string, Transcript>();
    const records: CaseRecord[] = [];
    const unstable: UnstableRecord[] = [];

    let done = 0;
    for (const spec of cases) {
      const baseline = await captureOne(browser, server, BASELINE, spec);
      const repeat = await captureOne(browser, server, BASELINE, spec);

      done += 1;
      options.onProgress?.(done, cases.length, spec.slug);

      if (baseline.pageErrors.length > 0) {
        unstable.push({
          slug: spec.slug,
          command: spec.command,
          reasons: spec.reasons,
          reason: 'page-error',
          detail: baseline.pageErrors.join('; '),
        });
        continue;
      }
      if (shapeOf(baseline) !== shapeOf(repeat)) {
        unstable.push({
          slug: spec.slug,
          command: spec.command,
          reasons: spec.reasons,
          reason: 'nondeterministic',
          detail:
            'two runs under an identical pinned environment disagreed: ' +
            firstDifference(baseline.text, repeat.text),
        });
        continue;
      }
      if (!baseline.settled) {
        unstable.push({
          slug: spec.slug,
          command: spec.command,
          reasons: spec.reasons,
          reason: 'late-output',
          detail: `rows changed after ${String(SETTLE_MS)}ms of settling`,
        });
        continue;
      }

      let clockSensitive = false;
      let seedSensitive = false;
      let timezoneSensitive = false;
      let localeSensitive = false;
      if (options.probeSensitivity) {
        const same = async (env: Environment): Promise<boolean> =>
          shapeOf(await captureOne(browser, server, env, spec)) === shapeOf(baseline);
        clockSensitive = !(await same(VARIANTS.clock));
        seedSensitive = !(await same(VARIANTS.seed));
        timezoneSensitive = !(await same(VARIANTS.timezone));
        localeSensitive = !(await same(VARIANTS.locale));
      }

      transcripts.set(spec.slug, baseline);
      records.push({
        slug: spec.slug,
        command: spec.command,
        reasons: spec.reasons,
        file: `${spec.slug}.txt`,
        rows: baseline.rows,
        sha256: sha256(baseline.text),
        styles: baseline.styles,
        bootPrefixIntact: baseline.bootPrefixIntact,
        editorOpen: baseline.editorOpen,
        editorApp: baseline.editorApp,
        cwd: baseline.cwd,
        theme: baseline.theme,
        clockSensitive,
        seedSensitive,
        timezoneSensitive,
        localeSensitive,
      });
    }

    const manifest = buildManifest({
      archiveBytes,
      archiveText,
      live,
      records,
      unstable,
    });

    return {
      manifest,
      transcripts,
      inventoryProblems,
      requestedPaths: [...server.requested],
    };
  } finally {
    await browser.close();
    await server.close();
  }
}

/* ---------------------------------------------------------- inventory checks */

interface InventoryFile {
  counts: Record<string, number>;
  commands: { name: string; display: string; kind: string; params: string[]; help: string; aliases: string[]; streamsOutput: boolean; offersPaths: boolean }[];
  easterEggs: string[];
  applications: string[];
}

/**
 * Three readings, compared. The page, the archive's own literals, and the
 * checked-in inventory extracted from index.html.
 *
 * The third comparison is what makes acceptance criterion 1 mechanical: the
 * inventory is generated from `index.html`, so if the archive and index.html
 * had drifted apart the archive's literals would disagree with it here.
 */
export function compareInventories(live: LiveInventory, archiveText: string): string[] {
  const problems: string[] = [];
  const literals = readArchiveLiterals(archiveText);

  const liveCmdlets = live.cmdlets.map((c) => c.name).sort();
  const archiveCmdlets = Object.keys(literals.cmdlets).sort();
  if (JSON.stringify(liveCmdlets) !== JSON.stringify(archiveCmdlets)) {
    problems.push('the running page and the archive literals disagree about CMDLETS');
  }

  const liveAliases = live.aliases.map(([a, t]) => `${a}=${t}`).sort();
  const archiveAliases = Object.entries(literals.alias)
    .map(([a, t]) => `${a}=${t}`)
    .sort();
  if (JSON.stringify(liveAliases) !== JSON.stringify(archiveAliases)) {
    problems.push('the running page and the archive literals disagree about ALIAS');
  }

  const liveEggs = [...live.eggs].sort();
  const archiveEggs = Object.keys(literals.eggs).sort();
  if (JSON.stringify(liveEggs) !== JSON.stringify(archiveEggs)) {
    problems.push('the running page and the archive literals disagree about EGGS');
  }

  const derived = corpusFromLiterals(literals.cmdlets, literals.alias, literals.disp, literals.apps);
  const reported = [...live.corpus];
  if (JSON.stringify(derived) !== JSON.stringify(reported)) {
    problems.push(
      `CORPUS derived from the archive literals differs from the one the page reports:\n` +
        `    only in derived: ${JSON.stringify(derived.filter((x) => !reported.includes(x)))}\n` +
        `    only in page:    ${JSON.stringify(reported.filter((x) => !derived.includes(x)))}`,
    );
  }

  if (!existsSync(INVENTORY)) {
    problems.push(`src/commands/v1-inventory.json is missing`);
    return problems;
  }
  const inventory = JSON.parse(lf(readFileSync(INVENTORY, 'utf8'))) as InventoryFile;

  const invNames = inventory.commands.map((c) => c.name).sort();
  const missing = liveCmdlets.filter((n) => !invNames.includes(n));
  const extra = invNames.filter((n) => !liveCmdlets.includes(n));
  if (missing.length > 0) {
    problems.push(`v1-inventory.json does not list ${String(missing.length)} command(s) reachable in v1: ${missing.join(', ')}`);
  }
  if (extra.length > 0) {
    problems.push(`v1-inventory.json lists ${String(extra.length)} command(s) that v1 does not define: ${extra.join(', ')}`);
  }

  for (const c of live.cmdlets) {
    const found = inventory.commands.find((x) => x.name === c.name);
    if (found === undefined) continue;
    if (found.display !== c.display) {
      problems.push(`display name for ${c.name}: inventory says ${found.display}, v1 renders ${c.display}`);
    }
    if (found.kind !== c.kind) {
      problems.push(`kind for ${c.name}: inventory says ${found.kind}, v1 says ${c.kind}`);
    }
    if (found.streamsOutput !== c.asyncOut) {
      problems.push(`asyncOut for ${c.name}: inventory says ${String(found.streamsOutput)}, v1 says ${String(c.asyncOut)}`);
    }
    if (JSON.stringify(found.params) !== JSON.stringify([...c.params])) {
      problems.push(`params for ${c.name} disagree between inventory and v1`);
    }
  }

  const invEggs = [...inventory.easterEggs].sort();
  if (JSON.stringify(invEggs) !== JSON.stringify(liveEggs)) {
    problems.push(
      `easter eggs disagree: inventory ${JSON.stringify(invEggs)} vs v1 ${JSON.stringify(liveEggs)}`,
    );
  }

  const invAliasCount = inventory.counts['aliases'] ?? -1;
  if (invAliasCount !== live.aliases.length) {
    problems.push(`alias count: inventory ${String(invAliasCount)}, v1 ${String(live.aliases.length)}`);
  }

  if (!live.localStorageWorks) {
    problems.push('localStorage was unavailable in the page, so the filesystem never persisted');
  }
  if (!live.reducedMotion) {
    problems.push('the page did not see prefers-reduced-motion, so async output was not batched');
  }

  return problems;
}

/* ------------------------------------------------------------------ manifest */

function buildManifest(input: {
  archiveBytes: Buffer;
  archiveText: string;
  live: LiveInventory;
  records: CaseRecord[];
  unstable: UnstableRecord[];
}): Manifest {
  const { archiveBytes, archiveText, live, records, unstable } = input;
  const archive = {
    path: 'legacy/terminal-v1.html',
    bytes: archiveBytes.byteLength,
    lines: lf(archiveText).split('\n').length - (archiveText.endsWith('\n') ? 1 : 0),
    sha256: sha256Bytes(archiveBytes),
    sha256Normalised: sha256(lf(archiveText)),
  };
  const environment = {
    ...BASELINE,
    reducedMotion: 'reduce' as const,
    viewport: { width: 1280, height: 900 },
  };
  const counts = {
    commands: live.cmdlets.length,
    aliases: live.aliases.length,
    easterEggs: live.eggs.length,
    corpus: live.corpus.length,
    cases: records.length,
    unstable: unstable.length,
    rows: records.reduce((n, r) => n + r.rows, 0),
    clockSensitive: records.filter((r) => r.clockSensitive).length,
    seedSensitive: records.filter((r) => r.seedSensitive).length,
    timezoneSensitive: records.filter((r) => r.timezoneSensitive).length,
    localeSensitive: records.filter((r) => r.localeSensitive).length,
  };
  const body = {
    archive,
    environment,
    counts,
    corpus: [...live.corpus],
    seededHistory: [...live.seededHistory],
    cases: records,
    unstable,
  };
  return {
    $comment:
      'Golden transcripts of the v1 terminal, captured from legacy/terminal-v1.html by ' +
      'tools/capture-v1.mts in a real headless Chromium. Each .txt is one printed row per ' +
      'line, exactly as v1 rendered it. `digest` seals everything below it; the browser ' +
      'build is deliberately not sealed, because the defence against a forged transcript is ' +
      're-execution (npm run test:browser), not a number.',
    ...body,
    digest: sha256(JSON.stringify(body)),
  };
}

/* ---------------------------------------------------------------------- main */

const serialise = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function writeFixtures(report: CaptureReport, partial: boolean): void {
  mkdirSync(FIXTURES, { recursive: true });
  // Remove transcripts that no longer correspond to a case. A stale .txt is a
  // fixture for a command that no longer exists, and it would keep passing.
  //
  // NOT after a filtered run. `--only whoami` produces a manifest with one case
  // in it; pruning against that would delete the other transcripts and then
  // write a manifest saying the suite has one case -- destroying the fixtures
  // while reporting success.
  if (partial) {
    for (const record of report.manifest.cases) {
      const transcript = report.transcripts.get(record.slug);
      if (transcript === undefined) throw new Error(`no transcript for ${record.slug}`);
      writeFileSync(join(FIXTURES, record.file), transcript.text, 'utf8');
    }
    process.stderr.write(
      '\n  --only was used, so this was a partial capture: the manifest and every\n' +
        '  other transcript are left alone. Re-run without --only before committing.\n\n',
    );
    return;
  }
  const keep = new Set(report.manifest.cases.map((c) => c.file));
  keep.add('manifest.json');
  for (const entry of readdirSync(FIXTURES)) {
    if (!keep.has(entry)) rmSync(join(FIXTURES, entry), { force: true });
  }
  for (const record of report.manifest.cases) {
    const transcript = report.transcripts.get(record.slug);
    if (transcript === undefined) throw new Error(`no transcript for ${record.slug}`);
    writeFileSync(join(FIXTURES, record.file), transcript.text, 'utf8');
  }
  writeFileSync(MANIFEST, serialise(report.manifest), 'utf8');
}

function diffAgainstDisk(report: CaptureReport): string[] {
  const problems: string[] = [];
  if (!existsSync(MANIFEST)) return ['tests/conformance/fixtures/v1/manifest.json does not exist'];

  const onDisk = JSON.parse(lf(readFileSync(MANIFEST, 'utf8'))) as Manifest;
  const fresh = report.manifest;

  const bySlug = new Map(onDisk.cases.map((c) => [c.slug, c]));
  for (const record of fresh.cases) {
    const recorded = bySlug.get(record.slug);
    if (recorded === undefined) {
      problems.push(`${record.slug}: captured now, absent from the committed manifest`);
      continue;
    }
    bySlug.delete(record.slug);
    const path = join(FIXTURES, record.file);
    if (!existsSync(path)) {
      problems.push(`${record.file}: recorded in the manifest, missing on disk`);
      continue;
    }
    const committed = lf(readFileSync(path, 'utf8'));
    const captured = report.transcripts.get(record.slug)?.text ?? '';
    if (committed !== captured) {
      problems.push(`${record.file}: ${firstDifference(committed, captured)}`);
    }
    if (recorded.sha256 !== record.sha256) {
      problems.push(`${record.slug}: manifest sha256 ${recorded.sha256} but capture gives ${record.sha256}`);
    }
    if (JSON.stringify(recorded.styles) !== JSON.stringify(record.styles)) {
      problems.push(`${record.slug}: the row styles changed`);
    }
    if (JSON.stringify(recorded.reasons) !== JSON.stringify(record.reasons)) {
      problems.push(`${record.slug}: the reasons this case exists changed`);
    }
  }
  for (const orphan of bySlug.keys()) {
    problems.push(`${orphan}: in the committed manifest, but the capture produced no such case`);
  }
  if (JSON.stringify(onDisk.corpus) !== JSON.stringify(fresh.corpus)) {
    problems.push('CORPUS changed since the fixtures were captured');
  }
  if (JSON.stringify(onDisk.unstable) !== JSON.stringify(fresh.unstable)) {
    problems.push(
      `the unstable list changed:\n    was ${JSON.stringify(onDisk.unstable.map((u) => u.slug))}` +
        `\n    now ${JSON.stringify(fresh.unstable.map((u) => u.slug))}`,
    );
  }
  if (onDisk.archive.sha256Normalised !== fresh.archive.sha256Normalised) {
    problems.push('the archive itself changed since the fixtures were captured');
  }
  return problems;
}

const KNOWN_FLAGS = new Set(['--check', '--only', '--no-sensitivity']);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const onlyIndex = argv.indexOf('--only');
  const only = onlyIndex >= 0 ? argv[onlyIndex + 1] : undefined;
  const unknown = argv.filter(
    (a, i) => a.startsWith('-') && !KNOWN_FLAGS.has(a) && !(onlyIndex >= 0 && i === onlyIndex + 1),
  );
  if (unknown.length > 0) {
    process.stderr.write(`\n  unknown option(s): ${unknown.join(', ')}\n\n`);
    process.exit(2);
  }
  // A filter is for a human iterating on one command. Allowing it on the gate
  // would let `--check --only nothing` report success having compared nothing,
  // which is the exact shape of failure tools/run-tests.mts exists to prevent.
  if (check && only !== undefined) {
    process.stderr.write('\n  --only cannot be combined with --check.\n\n');
    process.exit(2);
  }

  const report = await runCapture({
    probeSensitivity: !check && !argv.includes('--no-sensitivity'),
    ...(only === undefined ? {} : { only }),
    // Only on a terminal. A carriage-returned progress line in a CI log is one
    // very long line that hides everything printed before it.
    ...(process.stdout.isTTY === true
      ? {
          onProgress: (done: number, total: number, slug: string): void => {
            process.stdout.write(
              `\r  ${String(done)}/${String(total)}  ${slug.padEnd(28).slice(0, 28)}`,
            );
          },
        }
      : {}),
  });
  if (process.stdout.isTTY === true) process.stdout.write(`\r${' '.repeat(52)}\r`);

  if (report.inventoryProblems.length > 0) {
    process.stderr.write('\n  the three readings of v1 disagree:\n');
    for (const p of report.inventoryProblems) process.stderr.write(`    ${p}\n`);
    process.stderr.write('\n');
    process.exit(1);
  }

  const served = report.requestedPaths.filter((p) => p !== ARCHIVE_PATH);
  if (served.length > 0) {
    process.stderr.write(
      `\n  the page asked for something other than the archive: ${JSON.stringify([...new Set(served)])}\n` +
        '  The capture is only reproducible if the archive is the whole input.\n\n',
    );
    process.exit(1);
  }

  const m = report.manifest;
  if (check) {
    const problems = diffAgainstDisk(report);
    if (problems.length > 0) {
      process.stderr.write(`\n  ${String(problems.length)} transcript(s) no longer match v1:\n`);
      for (const p of problems.slice(0, 40)) process.stderr.write(`    ${p}\n`);
      if (problems.length > 40) process.stderr.write(`    ... and ${String(problems.length - 40)} more\n`);
      process.stderr.write('\n  If v1 really changed, re-capture: npm run capture:v1\n\n');
      process.exit(1);
    }
    process.stdout.write(
      `  ${String(m.cases.length)} v1 transcripts replayed and identical ` +
        `(${String(m.counts['rows'] ?? 0)} rows, ${String(m.unstable.length)} unstable).\n`,
    );
    return;
  }

  writeFixtures(report, only !== undefined);
  process.stdout.write(
    `  wrote ${relative(REPO, FIXTURES)}\n` +
      `  ${String(m.counts['commands'] ?? 0)} commands, ${String(m.counts['aliases'] ?? 0)} aliases, ` +
      `${String(m.counts['easterEggs'] ?? 0)} easter eggs -> ${String(m.cases.length)} transcripts, ` +
      `${String(m.counts['rows'] ?? 0)} rows\n` +
      `  clock-sensitive ${String(m.counts['clockSensitive'] ?? 0)}, ` +
      `seed-sensitive ${String(m.counts['seedSensitive'] ?? 0)}, ` +
      `timezone-sensitive ${String(m.counts['timezoneSensitive'] ?? 0)}, ` +
      `locale-sensitive ${String(m.counts['localeSensitive'] ?? 0)}, ` +
      `unstable ${String(m.unstable.length)}\n`,
  );
  for (const u of m.unstable) {
    process.stdout.write(`    unstable: ${u.slug} — ${u.reason}: ${u.detail}\n`);
  }
}

// Run only when this file is the entry point. `file://` + a Windows path is not
// the URL Node uses (`file:///C:/...`, three slashes), so this compares URLs
// built the same way rather than pasting a path into a string.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main();
}

