/**
 * v1-fixtures.mts — everything about the v1 golden transcripts that does NOT
 * need a browser.
 *
 * The split is load-bearing, not tidiness. `npm run verify` is hermetic and
 * runs on a machine that may have no Chromium at all; the gate that proves the
 * committed transcripts have not been hand-edited must therefore not import
 * Playwright even transitively. Everything here is pure: paths, hashes, the
 * fixture manifest shape, and the two independent readings of v1's command list
 * that the coverage assertion is made of.
 *
 * tools/browser-harness.mts and tools/capture-v1.mts sit on top of this and add
 * the browser.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

import { readNamedLiteralFromHtml } from './js-literal.mts';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The archive under test. Never `index.html`: the live file is allowed to move. */
export const ARCHIVE = join(REPO, 'legacy', 'terminal-v1.html');
export const INDEX = join(REPO, 'index.html');
export const INVENTORY = join(REPO, 'src', 'commands', 'v1-inventory.json');
export const FIXTURES = join(REPO, 'tests', 'conformance', 'fixtures', 'v1');
export const MANIFEST = join(FIXTURES, 'manifest.json');

/** The one path the harness server answers. Everything else is a 404. */
export const ARCHIVE_PATH = '/legacy/terminal-v1.html';

/* -------------------------------------------------------------------- bytes */

/**
 * Line endings, normalised before hashing.
 *
 * `.gitattributes` declares `* text=auto eol=lf`, and `core.autocrlf` is true on
 * Windows, so a transcript committed with LF is CRLF in the working tree here
 * and LF on a Linux runner. A digest over raw bytes would therefore be a digest
 * over the checkout, and the seal would fail on one platform out of two.
 */
export const lf = (s: string): string => s.replace(/\r\n/g, '\n');
export const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
export const sha256Bytes = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/* -------------------------------------------------------------- environment */

/**
 * The knobs that make a run reproducible. Every field is recorded in the
 * fixture manifest, because a transcript is only meaningful next to the
 * environment that produced it.
 */
export interface Environment {
  /** Frozen `Date.now()`, in epoch milliseconds. */
  readonly clockMs: number;
  /** Seed for the `Math.random` replacement. */
  readonly seed: number;
  /** IANA zone. v1 renders times with local-time getters, so this is not inert. */
  readonly timezoneId: string;
  /**
   * BCP-47 tag. Expected to be inert and MEASURED not to be: V8 localises the
   * zone NAME inside `Date.prototype.toString()`, so `Get-Date` prints
   * "(Coordinated Universal Time)" under en-US and "(Koordinierte Weltzeit)"
   * under de-DE from the same instant.
   */
  readonly locale: string;
}

/**
 * The environment the committed fixtures were captured under.
 *
 * The clock is deliberately NOT v1's own `SEEDTIME` (2026-07-19T12:00:00Z). If
 * the two coincided, a freshly stamped node and a seed node would carry the
 * same `mt`, `fsSer`'s `if (n.mt !== SEEDTIME)` branch would never be taken, and
 * `ls -la` could not distinguish a file v1 created from one it shipped. Picking
 * a different instant keeps that difference visible in the transcripts.
 */
export const BASELINE: Environment = {
  clockMs: Date.UTC(2026, 0, 2, 3, 4, 5, 678),
  seed: 1006,
  timezoneId: 'UTC',
  locale: 'en-US',
};

/**
 * Alternatives used only to find out what a command depends on. Each differs
 * from BASELINE in exactly one axis, so a difference names its own cause.
 */
export const VARIANTS = {
  clock: { ...BASELINE, clockMs: Date.UTC(2027, 10, 23, 14, 15, 16, 17) },
  seed: { ...BASELINE, seed: 20260904 },
  timezone: { ...BASELINE, timezoneId: 'Asia/Taipei' },
  locale: { ...BASELINE, locale: 'de-DE' },
} as const satisfies Record<string, Environment>;

/**
 * The script installed before ANY page script runs.
 *
 * `Date` is replaced with a Proxy rather than a subclass so that `instanceof`,
 * the statics v1 uses (`Date.parse` for `SEEDTIME`), the prototype, and a bare
 * `Date()` call all keep working. A `class FrozenDate extends Date` would throw
 * on `Date()` without `new`; nothing in v1 does that today, but a capture rig
 * that changes the semantics of a global in a way the page could notice is a
 * rig that measures itself.
 *
 * `Math.random` becomes mulberry32 — four lines, well distributed, and identical
 * for identical seeds on any engine, which a `Math.random`-derived shim is not.
 */
export function determinismScript(env: Environment): string {
  return `(() => {
  'use strict';
  const FIXED = ${String(env.clockMs)};
  const RealDate = Date;
  globalThis.Date = new Proxy(RealDate, {
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length === 0 ? [FIXED] : args, newTarget);
    },
    apply() { return new RealDate(FIXED).toString(); },
    get(target, prop, receiver) {
      if (prop === 'now') return function now() { return FIXED; };
      return Reflect.get(target, prop, receiver);
    },
  });
  let seed = ${String(env.seed)} >>> 0;
  Math.random = function random() {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();`;
}

/* ------------------------------------------------------------------- shapes */

export interface V1RawCommand {
  params?: string[];
  help?: string;
  type?: string;
  disp?: string;
  paths?: boolean;
  asyncOut?: boolean;
  hidden?: boolean;
}

/** What the running page says about itself. Compared against the archive and the inventory. */
export interface LiveInventory {
  readonly cmdlets: readonly {
    readonly name: string;
    readonly display: string;
    readonly kind: string;
    readonly params: readonly string[];
    readonly help: string;
    readonly asyncOut: boolean;
    readonly paths: boolean;
    readonly hidden: boolean;
  }[];
  readonly aliases: readonly (readonly [string, string])[];
  readonly eggs: readonly string[];
  readonly apps: readonly string[];
  readonly corpus: readonly string[];
  readonly seededHistory: readonly string[];
  readonly reducedMotion: boolean;
  readonly localStorageWorks: boolean;
}

export interface CaseSpec {
  /** Exactly the text typed at the prompt. `null` for the boot and history cases. */
  readonly command: string | null;
  readonly slug: string;
  /** Every reason this case exists, e.g. `cmdlet:whoami`, `seeded-history:1`. */
  readonly reasons: readonly string[];
}

export interface CaseRecord {
  readonly slug: string;
  readonly command: string | null;
  readonly reasons: readonly string[];
  readonly file: string;
  readonly rows: number;
  /** sha256 of the .txt content, after CRLF normalisation. */
  readonly sha256: string;
  /** Per row, the elements it was built from: `span.err`, `a.cmd[href]`, and so on. */
  readonly styles: readonly string[];
  /** False only when the command wiped the boot banner (Clear-Host and friends). */
  readonly bootPrefixIntact: boolean;
  readonly editorOpen: boolean;
  readonly editorApp: string;
  readonly cwd: string;
  readonly theme: string;
  readonly clockSensitive: boolean;
  readonly seedSensitive: boolean;
  readonly timezoneSensitive: boolean;
  readonly localeSensitive: boolean;
}

export interface UnstableRecord {
  readonly slug: string;
  readonly command: string | null;
  readonly reasons: readonly string[];
  readonly reason: string;
  readonly detail: string;
}

export interface Manifest {
  readonly $comment: string;
  readonly archive: {
    readonly path: string;
    readonly bytes: number;
    readonly lines: number;
    readonly sha256: string;
    readonly sha256Normalised: string;
  };
  readonly environment: Environment & {
    readonly reducedMotion: 'reduce';
    readonly viewport: { readonly width: number; readonly height: number };
  };
  readonly counts: Record<string, number>;
  readonly corpus: readonly string[];
  readonly seededHistory: readonly string[];
  readonly cases: readonly CaseRecord[];
  readonly unstable: readonly UnstableRecord[];
  readonly digest: string;
}

/* -------------------------------------------------------------------- slugs */

/**
 * Slug for a command.
 *
 * Case-folded, because the fixture directory has to survive a case-insensitive
 * filesystem: `Get-Date` and `get-date` must not become two files that are one
 * file on Windows. Uniqueness is asserted after the fact — see buildCases.
 */
export function slugFor(command: string): string {
  const slug = command
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/_{2,}/g, '_');
  return slug === '' ? '_empty' : slug;
}

/* ------------------------------------------- reading v1 without a browser */

/**
 * The five literals, read out of the archive's own bytes.
 *
 * This is an INDEPENDENT reading. The capture also asks the running page, and
 * `src/commands/v1-inventory.json` is a third answer extracted from index.html.
 * A coverage assertion that reads the same file the enumeration read cannot
 * detect a command that file is missing; three readings can.
 *
 * Evaluation uses the isolated-context technique tools/extract-command-
 * inventory.mts documents at length: function BODIES do not run when an object
 * literal is defined, so a context with no globals evaluates every one of these
 * — and a context with no globals gives the literal nothing to reach through.
 * The extracted functions are discarded. Nothing from the archive is invoked.
 */
export function readArchiveLiterals(html: string): {
  cmdlets: Record<string, V1RawCommand>;
  alias: Record<string, string>;
  eggs: Record<string, unknown>;
  apps: string[];
  disp: Record<string, string>;
} {
  const evaluate = <T,>(name: string): T => {
    const literal = readNamedLiteralFromHtml(html, name).text;
    const context = createContext(Object.create(null) as Record<string, never>);
    try {
      return runInContext(`(${literal})`, context, { timeout: 2000 }) as T;
    } catch (cause) {
      throw new Error(`could not evaluate the ${name} literal from the v1 archive`, { cause });
    }
  };
  return {
    cmdlets: evaluate<Record<string, V1RawCommand>>('CMDLETS'),
    alias: evaluate<Record<string, string>>('ALIAS'),
    eggs: evaluate<Record<string, unknown>>('EGGS'),
    apps: evaluate<string[]>('APPS'),
    disp: evaluate<Record<string, string>>('DISP'),
  };
}

/**
 * Rebuild CORPUS with v1's own algorithm, from literals read out of the file.
 *
 * Transcribed from index.html:1435-1439. It exists so the CORPUS the browser
 * reports can be checked against something derived independently: the
 * acceptance criterion is "every command name reachable from CORPUS has a
 * transcript", and a CORPUS the capture itself supplied would make that
 * criterion satisfy itself.
 */
export function corpusFromLiterals(
  cmdlets: Record<string, V1RawCommand>,
  alias: Record<string, string>,
  disp: Record<string, string>,
  apps: readonly string[],
): string[] {
  // index.html:1333 — only Verb-Noun names are title-cased. A reimplementation
  // without the hyphen guard produced "Ls", "Cat" and "Lsb_release" once
  // already, and shipped 30 wrong names into manifests.json.
  const title = (n: string): string =>
    n
      .split('-')
      .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
      .join('-');
  const displayOf = (n: string): string => {
    const c = cmdlets[n] ?? {};
    return c.disp ?? disp[n] ?? (n.indexOf('-') > 0 && !apps.includes(n) ? title(n) : n);
  };
  const out: string[] = [];
  for (const n of Object.keys(cmdlets)) {
    if (cmdlets[n]?.hidden === true) continue;
    out.push(displayOf(n));
  }
  for (const a of Object.keys(alias)) {
    const target = alias[a];
    const t = target === undefined ? undefined : cmdlets[target];
    if (t !== undefined && t.hidden !== true) out.push(a);
  }
  return out
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort((x, y) => (x.toLowerCase() < y.toLowerCase() ? -1 : 1));
}

/* --------------------------------------------------------------- case list */

export function buildCases(live: LiveInventory): CaseSpec[] {
  const reasonsByCommand = new Map<string, string[]>();
  const add = (command: string, reason: string): void => {
    const existing = reasonsByCommand.get(command);
    if (existing === undefined) reasonsByCommand.set(command, [reason]);
    else existing.push(reason);
  };

  for (const c of live.cmdlets) add(c.display, `cmdlet:${c.name}`);
  for (const [from] of live.aliases) add(from, `alias:${from}`);
  for (const egg of live.eggs) add(egg, `egg:${egg}`);
  live.seededHistory.forEach((entry, i) => add(entry, `seeded-history:${String(i + 1)}`));

  const cases: CaseSpec[] = [
    { command: null, slug: '__boot', reasons: ['boot-banner'] },
    { command: null, slug: '__history', reasons: ['seeded-history'] },
  ];
  for (const [command, reasons] of [...reasonsByCommand].sort(([a], [b]) => (a < b ? -1 : 1))) {
    cases.push({ command, slug: slugFor(command), reasons: [...reasons].sort() });
  }

  // Two commands folding onto one file would silently drop a transcript, and
  // the coverage assertion downstream would still pass, because it counts
  // commands rather than files. Refuse rather than overwrite.
  const seen = new Map<string, string>();
  for (const c of cases) {
    const key = c.slug.toLowerCase();
    const first = seen.get(key);
    if (first !== undefined) {
      throw new Error(
        `two cases want the same fixture file "${c.slug}.txt": ${first} and ${JSON.stringify(c.command)}`,
      );
    }
    seen.set(key, JSON.stringify(c.command));
  }
  return cases;
}

/* ------------------------------------------------------------------- seals */

/**
 * Recompute the manifest seal.
 *
 * `$comment` and `digest` itself are excluded; everything else is covered,
 * including the environment, the counts and every case record. The browser
 * build is deliberately NOT in the manifest at all: it drifts for reasons that
 * have nothing to do with v1, and the defence against a forged transcript is
 * re-execution against the archive, not a number in a file.
 */
export function manifestDigest(manifest: Manifest): string {
  const { $comment: _comment, digest: _digest, ...body } = manifest;
  return sha256(JSON.stringify(body));
}

export function readManifest(path: string = MANIFEST): Manifest {
  return JSON.parse(lf(readFileSync(path, 'utf8'))) as Manifest;
}
