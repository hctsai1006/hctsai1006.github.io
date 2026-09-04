/**
 * simulated-v1-archive.mts — run the ARCHIVE, not a transcription of it.
 *
 * The rewrite's simulated commands are held to one standard: a visitor who used
 * the old page must not see the output change. The obvious way to test that is
 * to paste v1's expected strings into an assertion — and it is the wrong way,
 * because a paste is a copy, a copy can be made from the implementation instead
 * of from the archive, and a test that agrees with the code because both were
 * typed by the same person at the same time proves nothing.
 *
 * So the expectations are EXTRACTED from `legacy/terminal-v1.html` at run time.
 * The archive is frozen — `legacy/PROVENANCE.md` records its git blob hash and
 * says not to edit it — and its command bodies are plain functions over a small
 * set of helpers. This slices those bodies out by brace matching, evaluates
 * them with the helpers stubbed, and returns what v1 would have printed.
 *
 * WHY `new Function` IS ACCEPTABLE HERE AND NOWHERE ELSE
 *
 * `where-object.ts` states the rule for the engine: a command must never reach
 * for `eval` or `new Function`, because a command that can evaluate arbitrary
 * text makes the capability broker a fiction. That rule is about the SHIPPED
 * ENGINE. This is a test harness reading a committed fixture, in the same
 * spirit as `tools/conformance.mts` replaying a captured pwsh fixture: the
 * input is a file in the repository, it is not reachable from the page, and
 * nothing it produces is shipped. The alternative — hand-copied expectations —
 * is the thing that actually weakens the test.
 *
 * The stubs are deliberately minimal. Anything a sliced body needs that is not
 * provided throws, loudly, rather than resolving to something plausible.
 */

import { readFileSync } from 'node:fs';

const ARCHIVE_URL = new URL('../../legacy/terminal-v1.html', import.meta.url);

/**
 * Newlines are normalised because `.gitattributes` marks `legacy/*.html` as
 * `-text`, so the archive keeps whatever line endings it was committed with and
 * a checkout can hand us CRLF. Slicing JavaScript source does not care, but a
 * regex anchored on `\n` would.
 */
const SOURCE = readFileSync(ARCHIVE_URL, 'utf8').replace(/\r\n/gu, '\n');

const BACKSLASH = String.fromCharCode(92);

// ---------------------------------------------------------------------------
// slicing
// ---------------------------------------------------------------------------

/**
 * Balanced-delimiter slice that understands JavaScript strings and comments.
 *
 * A plain brace count would stop early on `'}'` inside a string, and v1's
 * `matrix` alphabet contains `{}` — so it is not a hypothetical.
 */
function sliceBalanced(text: string, start: number, open: string, close: string): string {
  let depth = 0;
  let inString: string | null = null;
  let inComment: 'line' | 'block' | null = null;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index] ?? '';
    const next = text[index + 1] ?? '';

    if (inComment === 'line') {
      if (char === '\n') inComment = null;
      continue;
    }
    if (inComment === 'block') {
      if (char === '*' && next === '/') {
        inComment = null;
        index += 1;
      }
      continue;
    }
    if (inString !== null) {
      if (char === BACKSLASH) index += 1;
      else if (char === inString) inString = null;
      continue;
    }
    if (char === '/' && next === '/') {
      inComment = 'line';
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inComment = 'block';
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      inString = char;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced ${open}${close} from offset ${start} in the v1 archive`);
}

function indexOfOrThrow(needle: string): number {
  const at = SOURCE.indexOf(needle);
  if (at < 0) {
    throw new Error(
      `the v1 archive no longer contains ${JSON.stringify(needle)}. The archive is frozen, ` +
        'so either it was edited (it must not be) or this harness is out of date.',
    );
  }
  return at;
}

/** The whole `EGGS` object literal. */
const EGGS_SOURCE = ((): string => {
  const at = indexOfOrThrow('const EGGS={');
  return sliceBalanced(SOURCE, SOURCE.indexOf('{', at), '{', '}');
})();

/** One `CMDLETS` entry, e.g. `'df':{ … }`. */
function cmdletSource(name: string): string {
  const marker = `\n  '${name}':{`;
  const at = indexOfOrThrow(marker);
  return sliceBalanced(SOURCE, at + marker.length - 1, '{', '}');
}

function functionSource(name: string): string {
  const at = indexOfOrThrow(`function ${name}(`);
  const brace = SOURCE.indexOf('{', at);
  return SOURCE.slice(at, brace) + sliceBalanced(SOURCE, brace, '{', '}');
}

const TIMELINE_SOURCE = ((): string => {
  const at = indexOfOrThrow('  timeline:[');
  return sliceBalanced(SOURCE, SOURCE.indexOf('[', at), '[', ']');
})();

const IDENTITY = ((): { readonly user: string; readonly hostname: string } => {
  const match =
    /const HOME='[^']*', USERNAME='([^']*)', GROUPNAME='[^']*', HOSTN='([^']*)'/u.exec(SOURCE);
  if (match === null) throw new Error('the v1 archive no longer declares USERNAME and HOSTN');
  return { user: match[1] ?? '', hostname: match[2] ?? '' };
})();

export const V1_USER = IDENTITY.user;
export const V1_HOSTNAME = IDENTITY.hostname;

// ---------------------------------------------------------------------------
// evaluating
// ---------------------------------------------------------------------------

export interface V1Line {
  readonly cls: string;
  readonly txt: string;
}

export interface V1Table {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export interface V1Run {
  /** Rows the command returned. Empty when it returned null (async output). */
  readonly rows: readonly V1Line[];
  /** Rows handed to `asyncPrint` — how v1 streamed ping, traceroute and apt. */
  readonly async: readonly V1Line[];
  /** Every `table(headers, rows)` call, unrendered. */
  readonly tables: readonly V1Table[];
  /** The net-tools joke state after the call. */
  readonly packages: { readonly netToolsInstalled: boolean; readonly ifconfigFailures: number };
  /** Whatever the body returned, untouched. Only the data slices use it. */
  readonly raw: unknown;
}

export interface V1Options {
  readonly netToolsInstalled?: boolean;
  readonly ifconfigFailures?: number;
  /** Values `Math.random()` will return, in order. Running out throws. */
  readonly randoms?: readonly number[];
  /** Epoch milliseconds `new Date()` will report. */
  readonly now?: number;
}

interface RawLine {
  cls?: string;
  txt?: string;
  parts?: unknown;
}

interface MutableState {
  netToolsInstalled: boolean;
  ifconfigFailures: number;
}

type ArchiveFactory = (
  tables: V1Table[],
  asyncRows: RawLine[][],
  state: MutableState,
  math: Math,
  dateStub: DateConstructor,
) => unknown;

/**
 * The helpers a sliced body may use, transcribed from the archive's own
 * definitions. `argOf`, `firstArg`, `stripQ` and `lpad` are v1's, character for
 * character; `line`, `table` and `asyncPrint` are stubs that record instead of
 * rendering.
 *
 * `line(cls)` with no second argument yields `txt: undefined` in v1, and the
 * renderer prints `r.txt != null ? r.txt : ''` — so the empty string here is
 * what a visitor saw, not a convenience.
 */
const PRELUDE = `
  const USERNAME = ${JSON.stringify(V1_USER)};
  const HOSTN = ${JSON.stringify(V1_HOSTNAME)};
  const D = { timeline: ${TIMELINE_SOURCE} };
  function stripQ(s){ return String(s).replace(/^["']|["']$/g,''); }
  function argOf(a,n){ let k=Object.keys(a),i; for(i=0;i<k.length;i++){ if(k[i].toLowerCase()===String(n).toLowerCase()) return a[k[i]]; } return undefined; }
  function firstArg(raw){ for(let i=1;i<raw.length;i++){ if(!/^-/.test(raw[i])) return stripQ(raw[i]); } return ''; }
  function lpad(s,n){ s=String(s); return new Array(Math.max(0,n-s.length)+1).join(' ')+s; }
  function line(cls,txt){ return { cls: cls, txt: txt === undefined ? '' : txt }; }
  function table(headers,rows){
    __tables.push({ headers: headers, rows: rows });
    return rows.map(function(r){ return { cls: '', txt: r.join('  ') }; });
  }
  function asyncPrint(rows,gap,done){ __async.push(rows); if(done) done(); }
  ${functionSource('pingRun')}
`;

function toLines(rows: readonly RawLine[] | null | undefined): readonly V1Line[] {
  if (rows === null || rows === undefined) return [];
  return rows.map((row) => ({
    cls: row.cls ?? '',
    // A `parts` row (v1's only hyperlink form) carries a plain-text fallback in
    // `txt`, which is what the renderer shows when the anchor is not built.
    txt: row.txt ?? '',
  }));
}

function evaluate(body: string, options: V1Options): V1Run {
  const tables: V1Table[] = [];
  const asyncRows: RawLine[][] = [];
  const state: MutableState = {
    netToolsInstalled: options.netToolsInstalled ?? false,
    ifconfigFailures: options.ifconfigFailures ?? 0,
  };

  const randoms = options.randoms ?? [];
  let drawn = 0;
  // `Object.create(Math)` rather than a spread: Math's methods are
  // non-enumerable, so `{...Math}` is an empty object and `Math.max` inside a
  // sliced body would be undefined.
  const mathStub = Object.create(Math) as Math;
  Reflect.set(mathStub, 'random', (): number => {
    const value = randoms[drawn];
    drawn += 1;
    if (value === undefined) {
      throw new Error(
        `the v1 body drew ${drawn} random values but only ${randoms.length} were supplied`,
      );
    }
    return value;
  });

  const fixedNow = options.now;
  const dateStub =
    fixedNow === undefined
      ? Date
      : (function DateStub(this: unknown): Date {
          return new Date(fixedNow);
        } as unknown as DateConstructor);

  const factory = new Function(
    '__tables',
    '__async',
    '__state',
    'Math',
    'Date',
    `
    "use strict";
    let netToolsInstalled = __state.netToolsInstalled;
    let ifconfigFail = __state.ifconfigFailures;
    ${PRELUDE}
    const __result = (function(){ ${body} })();
    __state.netToolsInstalled = netToolsInstalled;
    __state.ifconfigFailures = ifconfigFail;
    return __result;
    `,
  ) as ArchiveFactory;

  const result = factory(tables, asyncRows, state, mathStub, dateStub);

  return {
    rows: toLines(result as readonly RawLine[] | null),
    async: asyncRows.flatMap((rows) => toLines(rows)),
    tables,
    packages: { ...state },
    raw: result,
  };
}

/** v1's `parseArgsOf`, so a cmdlet body sees the argument object it expects. */
function parseArgs(parts: readonly string[]): Record<string, string | true> {
  const flag = /^-{1,2}[A-Za-z]/u;
  const args: Record<string, string | true> = {};
  for (let index = 1; index < parts.length; index += 1) {
    const token = parts[index] ?? '';
    if (!flag.test(token)) continue;
    const key = token.replace(/^-+/u, '');
    const next = parts[index + 1];
    if (next !== undefined && next !== '' && !flag.test(next)) {
      index += 1;
      args[key] = next.replace(/^["']|["']$/gu, '');
    } else {
      args[key] = true;
    }
  }
  return args;
}

/**
 * Run one v1 CMDLETS entry. `parts` is the whole command line as v1 tokenised
 * it, INCLUDING the command name, because v1's bodies index `raw[0]`.
 */
export function v1Cmdlet(
  name: string,
  parts: readonly string[],
  options: V1Options = {},
): V1Run {
  return evaluate(
    `const C = ${cmdletSource(name)};
     return C.run(${JSON.stringify(parseArgs(parts))}, ${JSON.stringify(parts)}, null);`,
    options,
  );
}

/** Run one v1 easter egg. */
export function v1Egg(name: string, parts: readonly string[], options: V1Options = {}): V1Run {
  return evaluate(
    `const EGGS = ${EGGS_SOURCE};
     return EGGS[${JSON.stringify(name)}](${JSON.stringify(parts)});`,
    options,
  );
}

// ---------------------------------------------------------------------------
// projections
// ---------------------------------------------------------------------------

/** Everything v1 printed, in order: the returned rows then the streamed ones. */
export function v1Lines(run: V1Run): readonly V1Line[] {
  return [...run.rows, ...run.async];
}

/** Every line v1 printed, in order, whatever colour it painted them. */
export function v1Texts(run: V1Run): readonly string[] {
  return v1Lines(run).map((row) => row.txt);
}

/**
 * The rows v1 classed `err`.
 *
 * NOT a list of errors. `err` is the RED class in v1's stylesheet, and `rocket`
 * uses it for the exhaust flames. What it is good for is bounding the other
 * direction: a line this rewrite puts on stream 2 had better have been red in
 * v1, or the two disagree about what an error is.
 */
export function v1RedRows(run: V1Run): readonly string[] {
  return v1Lines(run)
    .filter((row) => row.cls === 'err')
    .map((row) => row.txt);
}

/**
 * The timeline literal the archive holds, as `[year, highlights]` pairs.
 *
 * Read from the archive rather than from `src/data/projects.json` on purpose:
 * the point of the test that uses it is that the extracted data still says what
 * the page said, and reading the same file twice would prove nothing.
 */
export function v1Timeline(): readonly (readonly [string, string])[] {
  return evaluate('return D.timeline;', {}).raw as readonly (readonly [string, string])[];
}
