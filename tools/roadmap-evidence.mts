/**
 * roadmap-evidence.mts — re-derive, from the repository, every claim the
 * roadmap makes about what is built.
 *
 * WHY THIS EXISTS. `roadmap/roadmap.data.mts` is consumed to answer "what is
 * left". It was consulted, it answered, and the answer was wrong: tasks marked
 * `todo` had already been implemented and shipped — `TerminalMetrics`, the
 * kernel protocol, the Format-* directives, the Result-based storage API. The
 * generator validated the plan's INTERNAL coherence (cycles, orphan
 * dependencies, an item done before its dependencies) and nothing at all about
 * whether the plan matched the code. A roadmap is an honesty surface; this one
 * had no gate, so it rotted in the one direction nobody audits, and the drift
 * was invisible because every check it had was passing.
 *
 * WHAT A CLAIM NOW COSTS. A task claiming `done` must name evidence, and every
 * piece of evidence is resolved against the tree here:
 *
 *   export   a symbol is really exported by a file — read off the TypeScript
 *            AST, not a regex, so a name occurring in a comment, a string or an
 *            import proves nothing
 *   test     a test with that exact name exists in a file the test runner
 *            actually globs, is not skipped or todo, contains an assertion, and
 *            PASSED in a run this tool performed
 *   json     a path in a data file resolves to a non-empty value
 *   absent   a pattern occurs in NO file under a glob that does match files —
 *            the evidence shape for a deletion, and half the ratchet below
 *   no-files a glob matches nothing, inside an area that does exist — the
 *            evidence shape for "this has not been built yet"
 *   code     a pattern occurs in a file, with comments blanked first
 *   script   package.json declares a script by that name
 *
 * `export`, `test`, `json`, `absent` and `no-files` count as STRONG; `code` and
 * `script` are supporting and cannot carry a `done` on their own. A task cannot
 * be `done` without at least one strong item.
 *
 * THE RATCHET, WHICH IS THE POINT. The defect here was UNDER-claiming, and no
 * amount of checking `done` tasks would have caught it. `absent` and `no-files`
 * are how a `todo` states its claim: the thing is not built, and here is the
 * search that finds nothing. The day somebody builds it, the search finds
 * something and this gate goes red until the status is corrected. That is the
 * only mechanism in here that fails in the direction the roadmap actually
 * failed.
 *
 * WHAT IT REFUSES TO DO, because three sibling tools in this directory carry
 * scars from exactly these:
 *
 *   - An absence check whose glob matches no files is a FAILURE, not a pass.
 *     A grep over nothing succeeds trivially; that is the check-that-never-ran,
 *     and it would arrive disguised as evidence.
 *   - A test run that produces zero results is a FAILURE even if the child
 *     exited 0. `node --test` exits 0 on an empty suite; tools/run-tests.mts
 *     exists because of that.
 *   - An evidence kind it does not understand is exit 2, never a skip.
 *   - A file that exists but holds nothing but whitespace or comments does not
 *     satisfy anything.
 *   - It asserts afterwards that it checked as many tasks as require checking,
 *     so a filtering bug cannot quietly empty the workload and report success.
 *
 * WHAT IT CANNOT CATCH, stated so nobody assumes otherwise:
 *
 *   - Whether a cited test asserts the thing the task DESCRIBES. It proves the
 *     test exists, runs, passes and contains assertions. A tautological test
 *     would satisfy it. Nothing mechanical closes that; it is what review is for.
 *   - Whether an exported symbol, or a value behind a json path, does what its
 *     name suggests. A symbol exported as null satisfies an `export` item and a
 *     field holding "tbd" satisfies a `json` one. Pair them with a test.
 *   - Whether an `absent` glob is the one that matters. Narrowing it to a
 *     directory the work would never land in leaves a check that passes forever
 *     while watching nothing in particular.
 *   - Whether a task is DECOMPOSED honestly. Splitting one hard task into five
 *     easy ones moves the percentage without moving the code.
 *   - A `todo` with no `absent`/`no-files` evidence is not ratcheted at all. The
 *     count of those is printed on every run rather than left implicit, because
 *     an unmeasured gap becomes an assumed zero.
 *   - A ratchet only watches the name it was given, in the glob it was given.
 *     Work landing under a name nobody predicted goes unnoticed, exactly as it
 *     did this time; and a `no-files` glob with a typo in it matches nothing
 *     forever, which is indistinguishable from work that has not started. The
 *     `within` area catches a renamed PARENT and nothing finer.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, globSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import ts from 'typescript';

import type { Evidence, Task, WorkItem } from '../roadmap/roadmap.data.mts';

// ---------------------------------------------------------------------------
// ports — so the tests can drive this without a repository
// ---------------------------------------------------------------------------

/** Read access to a checkout, addressed by repo-relative posix paths. */
export interface Repo {
  exists(rel: string): boolean;
  /** Returns null when absent, rather than throwing: absence is a finding. */
  read(rel: string): string | null;
  /** Repo-relative posix paths, sorted. */
  glob(pattern: string): string[];
}

export interface TestRunResult {
  /** Names of tests reported `ok`. */
  passed: ReadonlySet<string>;
  /** Names reported `not ok`, skipped or todo. */
  notPassed: ReadonlySet<string>;
  /** Anything that stopped the run from producing a usable answer. */
  error: string | null;
}

/** Runs test files and reports which named tests passed. */
export interface TestRunner {
  run(files: readonly string[]): TestRunResult;
}

const toPosix = (p: string): string => p.split('\\').join('/');

export function fsRepo(root: string): Repo {
  const full = (rel: string): string => (isAbsolute(rel) ? rel : join(root, rel));
  return {
    exists: (rel) => existsSync(full(rel)),
    // A glob like `src/**/*` returns directories as well as files, and
    // readFileSync throws EISDIR on one. Absence checks walk whatever the glob
    // returned, so an unguarded read here crashes the gate on a pattern that is
    // otherwise perfectly reasonable.
    read: (rel) => {
      try {
        return statSync(full(rel)).isFile() ? readFileSync(full(rel), 'utf8') : null;
      } catch {
        return null;
      }
    },
    glob: (pattern) => globSync(pattern, { cwd: root }).map(toPosix).sort(),
  };
}

// ---------------------------------------------------------------------------
// findings
// ---------------------------------------------------------------------------

export interface Finding {
  /** Task id plus the evidence index, or a file path for run-time results. */
  where: string;
  message: string;
}

export interface CheckReport {
  /** Claims that did not hold. Exit 1. */
  findings: readonly Finding[];
  /** Reasons the check could not be performed at all. Exit 2. */
  fatal: readonly string[];
  evidenceChecked: number;
  tasksRequiringEvidence: number;
  tasksChecked: number;
  citedTestsRun: number;
  /** `todo`/`blocked` tasks carrying an absence check, and those that are not. */
  ratcheted: number;
  unratcheted: readonly string[];
}

const STRONG: ReadonlySet<Evidence['kind']> = new Set(['export', 'test', 'json', 'absent', 'no-files']);

/**
 * Mirrors the glob in tools/run-tests.mts. A cited test outside it would never
 * run, and citing one is the "evidence nothing executes" trap.
 */
const TEST_GLOB = 'tests/**/*.test.mts';

/** Characters of `detail` a `partial` has to spend saying what is missing. */
const MIN_PARTIAL_DETAIL = 40;

// ---------------------------------------------------------------------------
// TypeScript-backed source reading
// ---------------------------------------------------------------------------

const TS_EXTENSIONS = ['.ts', '.mts', '.cts', '.tsx'];

const isTypeScript = (rel: string): boolean => TS_EXTENSIONS.some((e) => rel.endsWith(e));

/**
 * Blank every comment, preserving offsets and line breaks, so a `code` pattern
 * cannot be satisfied by the prose that describes the thing instead of the
 * thing. Much of this repository's source is commentary; without this the check
 * would be measuring documentation.
 */
export function stripComments(text: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  const out = [...text];
  let kind = scanner.scan();
  while (kind !== ts.SyntaxKind.EndOfFileToken) {
    if (
      kind === ts.SyntaxKind.SingleLineCommentTrivia ||
      kind === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      const start = scanner.getTokenStart();
      const end = scanner.getTokenEnd();
      for (let i = start; i < end && i < out.length; i += 1) {
        if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' ';
      }
    }
    kind = scanner.scan();
  }
  return out.join('');
}

const parse = (rel: string, text: string): ts.SourceFile =>
  ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

const hasExportModifier = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

function bindingNames(name: ts.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(name)) {
    into.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) bindingNames(element.name, into);
  }
}

/**
 * Resolve a relative module specifier the way this project writes them: the
 * source imports `./x.ts` directly (allowImportingTsExtensions), so try the
 * literal path first and only then the usual extensions.
 */
function resolveSpecifier(repo: Repo, fromRel: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = toPosix(join(dirname(fromRel), specifier));
  const candidates = [base, ...TS_EXTENSIONS.map((e) => base + e), `${base}/index.ts`];
  return candidates.find((c) => repo.exists(c)) ?? null;
}

/**
 * Every name a file exports, following `export * from` so a barrel can be
 * cited. Cycles are guarded; an unresolvable re-export is RECORDED rather than
 * ignored, because "the symbol is not there" and "we could not look" are
 * different answers and only one of them may pass quietly.
 */
export function exportedSymbols(
  repo: Repo,
  rel: string,
  seen: Set<string> = new Set(),
): { names: Set<string>; unresolved: string[] } {
  const names = new Set<string>();
  const unresolved: string[] = [];
  if (seen.has(rel)) return { names, unresolved };
  seen.add(rel);

  const text = repo.read(rel);
  if (text === null) {
    unresolved.push(rel);
    return { names, unresolved };
  }

  for (const statement of parse(rel, text).statements) {
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const decl of statement.declarationList.declarations) bindingNames(decl.name, names);
      continue;
    }
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement)) &&
      hasExportModifier(statement)
    ) {
      if (statement.name !== undefined && ts.isIdentifier(statement.name)) {
        names.add(statement.name.text);
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      names.add('default');
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause !== undefined && ts.isNamedExports(clause)) {
        for (const element of clause.elements) names.add(element.name.text);
        continue;
      }
      const spec = statement.moduleSpecifier;
      if (spec !== undefined && ts.isStringLiteral(spec)) {
        const target = resolveSpecifier(repo, rel, spec.text);
        if (target === null) {
          unresolved.push(`${rel} -> ${spec.text}`);
          continue;
        }
        const nested = exportedSymbols(repo, target, seen);
        for (const n of nested.names) names.add(n);
        unresolved.push(...nested.unresolved);
      }
    }
  }
  return { names, unresolved };
}

// ---------------------------------------------------------------------------
// test-file reading
// ---------------------------------------------------------------------------

export interface DeclaredTest {
  name: string;
  /** `it.skip`, `describe.todo`, or nested inside one. */
  inert: boolean;
  /** Whether anything in the callback subtree looks like an assertion. */
  asserts: boolean;
  line: number;
}

const TEST_CALLEES = new Set(['it', 'test', 'describe', 'suite']);
const INERT_MODIFIERS = new Set(['skip', 'todo']);
const ASSERTION_IDENTIFIERS = new Set([
  'assert',
  'ok',
  'equal',
  'strictEqual',
  'deepEqual',
  'deepStrictEqual',
  'notStrictEqual',
  'notDeepStrictEqual',
  'match',
  'doesNotMatch',
  'throws',
  'doesNotThrow',
  'rejects',
  'fail',
]);

function subtreeAsserts(node: ts.Node): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(n) && ASSERTION_IDENTIFIERS.has(n.text)) {
      found = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(node, walk);
  return found;
}

/** Every `describe`/`it`/`test` name declared in a test file. */
export function declaredTests(rel: string, text: string): DeclaredTest[] {
  const found: DeclaredTest[] = [];
  const source = parse(rel, text);

  const walk = (node: ts.Node, inheritedInert: boolean): void => {
    let inert = inheritedInert;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      let base: string | null = null;
      let modifier: string | null = null;
      if (ts.isIdentifier(callee)) {
        base = callee.text;
      } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        base = callee.expression.text;
        modifier = callee.name.text;
      }
      const first = node.arguments[0];
      if (
        base !== null &&
        TEST_CALLEES.has(base) &&
        first !== undefined &&
        (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))
      ) {
        if (modifier !== null && INERT_MODIFIERS.has(modifier)) inert = true;
        found.push({
          name: first.text,
          inert,
          asserts: subtreeAsserts(node),
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        });
      }
    }
    ts.forEachChild(node, (child) => {
      walk(child, inert);
    });
  };
  walk(source, false);
  return found;
}

// ---------------------------------------------------------------------------
// the real test runner
// ---------------------------------------------------------------------------

/** `ok 12 - name`, at any indentation, with the TAP directive still attached. */
const TAP_LINE = /^\s*(not )?ok\s+\d+\s+-\s+(.*)$/;

/** Node's TAP reporter escapes `#` and `\` inside a name. */
const unescapeTap = (s: string): string => s.replace(/\\([#\\])/g, '$1');

export function parseTap(output: string): { passed: Set<string>; notPassed: Set<string> } {
  const passed = new Set<string>();
  const notPassed = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const m = TAP_LINE.exec(line);
    if (m === null) continue;
    const failed = m[1] !== undefined;
    let name = (m[2] ?? '').trim();
    const directive = /\s+#\s*(SKIP|TODO)\b/i.exec(name);
    if (directive !== null) name = name.slice(0, directive.index).trim();
    const clean = unescapeTap(name);
    if (failed || directive !== null) notPassed.add(clean);
    else passed.add(clean);
  }
  return { passed, notPassed };
}

export function nodeTestRunner(root: string): TestRunner {
  return {
    run(files) {
      if (files.length === 0) return { passed: new Set(), notPassed: new Set(), error: null };
      const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 128 * 1024 * 1024,
      });
      if (result.error !== undefined) {
        return { passed: new Set(), notPassed: new Set(), error: String(result.error) };
      }
      const { passed, notPassed } = parseTap(`${result.stdout}\n${result.stderr}`);
      // `node --test` exits 0 on a suite that ran nothing. A run that produced
      // no results at all is a broken check, not a clean one.
      if (passed.size === 0 && notPassed.size === 0) {
        return {
          passed,
          notPassed,
          error:
            `ran ${String(files.length)} cited test file(s) and parsed no TAP results ` +
            `(child exit ${String(result.status)}). Refusing to treat that as evidence.`,
        };
      }
      return { passed, notPassed, error: null };
    },
  };
}

// ---------------------------------------------------------------------------
// evidence resolution
// ---------------------------------------------------------------------------

type ReadResult = { text: string } | { problem: string };

function readNonEmpty(repo: Repo, rel: string): ReadResult {
  const text = repo.read(rel);
  if (text === null) return { problem: `no such file: ${rel}` };
  if (text.trim() === '') return { problem: `${rel} exists but is empty` };
  if (isTypeScript(rel) && stripComments(text).trim() === '') {
    return { problem: `${rel} contains no code, only comments` };
  }
  return { text };
}

function resolveJsonPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Present-and-meaningful. `false` and `0` are real values and must pass. */
function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}

function compileRegex(pattern: string): RegExp | string {
  try {
    return new RegExp(pattern, 'm');
  } catch (err) {
    return `invalid regular expression ${JSON.stringify(pattern)}: ${String(err)}`;
  }
}

interface Context {
  repo: Repo;
  /** Cited test names, and the file each was attributed to. */
  citedTests: Map<string, { file: string }>;
  testFiles: Set<string>;
  fatal: string[];
}

function checkOne(ev: Evidence, where: string, ctx: Context): Finding[] {
  const out: Finding[] = [];
  const fail = (message: string): void => {
    out.push({ where, message });
  };

  switch (ev.kind) {
    case 'export': {
      const read = readNonEmpty(ctx.repo, ev.file);
      if ('problem' in read) {
        fail(read.problem);
        break;
      }
      const { names, unresolved } = exportedSymbols(ctx.repo, ev.file);
      if (!names.has(ev.symbol)) {
        const detail =
          unresolved.length > 0
            ? ` (and these re-exports could not be followed: ${unresolved.join(', ')})`
            : '';
        fail(`${ev.file} does not export "${ev.symbol}"${detail}`);
      }
      break;
    }

    case 'test': {
      const read = readNonEmpty(ctx.repo, ev.file);
      if ('problem' in read) {
        fail(read.problem);
        break;
      }
      if (!ctx.testFiles.has(ev.file)) {
        fail(
          `${ev.file} is not matched by ${TEST_GLOB}, so the test runner never runs it. ` +
            'A test nothing executes is not evidence.',
        );
        break;
      }
      const declared = declaredTests(ev.file, read.text).filter((t) => t.name === ev.name);
      const first = declared[0];
      if (first === undefined) {
        fail(`${ev.file} declares no test named ${JSON.stringify(ev.name)}`);
        break;
      }
      if (first.inert) {
        fail(`${ev.file}:${String(first.line)} ${JSON.stringify(ev.name)} is skipped or todo`);
        break;
      }
      if (!first.asserts) {
        fail(
          `${ev.file}:${String(first.line)} ${JSON.stringify(ev.name)} contains no assertion. ` +
            'A test that cannot fail proves nothing.',
        );
        break;
      }
      const already = ctx.citedTests.get(ev.name);
      if (already !== undefined && already.file !== ev.file) {
        ctx.fatal.push(
          `test name ${JSON.stringify(ev.name)} is cited from two files ` +
            `(${already.file}, ${ev.file}); a run result could not be attributed to either.`,
        );
        break;
      }
      ctx.citedTests.set(ev.name, { file: ev.file });
      break;
    }

    case 'json': {
      const read = readNonEmpty(ctx.repo, ev.file);
      if ('problem' in read) {
        fail(read.problem);
        break;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(read.text);
      } catch (err) {
        fail(`${ev.file} is not valid JSON: ${String(err)}`);
        break;
      }
      const value = resolveJsonPath(parsed, ev.path);
      if (isEmptyValue(value)) {
        fail(`${ev.file}: "${ev.path}" resolves to ${JSON.stringify(value) ?? 'undefined'}`);
      }
      break;
    }

    case 'code': {
      const read = readNonEmpty(ctx.repo, ev.file);
      if ('problem' in read) {
        fail(read.problem);
        break;
      }
      const re = compileRegex(ev.pattern);
      if (typeof re === 'string') {
        ctx.fatal.push(`${where}: ${re}`);
        break;
      }
      const haystack = isTypeScript(ev.file) ? stripComments(read.text) : read.text;
      if (!re.test(haystack)) {
        fail(`${ev.file} does not match /${ev.pattern}/ outside comments`);
      }
      break;
    }

    case 'script': {
      const read = readNonEmpty(ctx.repo, 'package.json');
      if ('problem' in read) {
        fail(read.problem);
        break;
      }
      let pkg: unknown;
      try {
        pkg = JSON.parse(read.text);
      } catch (err) {
        ctx.fatal.push(`package.json is not valid JSON: ${String(err)}`);
        break;
      }
      const value = resolveJsonPath(pkg, `scripts.${ev.name}`);
      if (typeof value !== 'string' || value.trim() === '') {
        fail(`package.json declares no script "${ev.name}"`);
      }
      break;
    }

    case 'absent': {
      const re = compileRegex(ev.pattern);
      if (typeof re === 'string') {
        ctx.fatal.push(`${where}: ${re}`);
        break;
      }
      const files = ctx.repo.glob(ev.glob);
      if (files.length === 0) {
        // The failure mode this repository is organised against: a search that
        // passes because it looked at nothing.
        fail(
          `absence check over "${ev.glob}" matched no files. A search with nothing ` +
            'to search proves nothing; fix the glob.',
        );
        break;
      }
      const hits: string[] = [];
      for (const file of files) {
        const text = ctx.repo.read(file);
        if (text === null) continue;
        const haystack = isTypeScript(file) ? stripComments(text) : text;
        if (re.test(haystack)) hits.push(file);
      }
      if (hits.length > 0) {
        const extra = hits.length > 5 ? ` (+${String(hits.length - 5)} more)` : '';
        fail(
          `/${ev.pattern}/ was expected to be absent from "${ev.glob}" but occurs in ` +
            `${hits.slice(0, 5).join(', ')}${extra}. If this was built, the task status is stale.`,
        );
      }
      break;
    }

    case 'no-files': {
      // "This does not exist yet" cannot be said with `absent`, which requires
      // its glob to match something. Said carelessly it is the weakest claim
      // here -- a glob matching nothing because a directory moved looks
      // identical to one matching nothing because the work is not done -- so
      // the search AREA has to be shown to exist first.
      const area = ctx.repo.glob(ev.within);
      if (area.length === 0) {
        fail(
          `the area "${ev.within}" matched no files, so "${ev.glob}" matching none proves ` +
            'nothing. Point `within` at something that exists.',
        );
        break;
      }
      const found = ctx.repo.glob(ev.glob);
      if (found.length > 0) {
        const extra = found.length > 5 ? ` (+${String(found.length - 5)} more)` : '';
        fail(
          `"${ev.glob}" was expected to match nothing but matched ` +
            `${found.slice(0, 5).join(', ')}${extra}. If this was built, the task status is stale.`,
        );
      }
      break;
    }

    default: {
      // Never a skip. An unrecognised kind means this tool is older than the
      // data it is checking, and silently passing would be the worst outcome.
      const bad: never = ev;
      ctx.fatal.push(`unknown evidence kind: ${JSON.stringify(bad)}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export interface CheckOptions {
  repo: Repo;
  runner: TestRunner;
  items: readonly WorkItem[];
}

const requiresEvidence = (t: Task): boolean => t.status === 'done' || t.status === 'partial';

export function checkEvidence({ repo, runner, items }: CheckOptions): CheckReport {
  const findings: Finding[] = [];
  const ctx: Context = {
    repo,
    citedTests: new Map(),
    testFiles: new Set(repo.glob(TEST_GLOB)),
    fatal: [],
  };

  if (ctx.testFiles.size === 0) {
    ctx.fatal.push(
      `no files matched ${TEST_GLOB}. Either the tests moved or this tool's mirror of ` +
        "tools/run-tests.mts's glob is stale; either way `test` evidence cannot be judged.",
    );
  }

  let evidenceChecked = 0;
  let tasksRequiringEvidence = 0;
  let tasksChecked = 0;
  let ratcheted = 0;
  const unratcheted: string[] = [];

  for (const item of items) {
    for (const task of item.tasks) {
      const evidence = task.evidence ?? [];
      const needs = requiresEvidence(task);
      if (needs) tasksRequiringEvidence += 1;

      // A `partial` earns its third state by saying what is MISSING. A detail of
      // "wip" satisfies a presence check and tells a reader nothing, so there is
      // a floor -- the same trick tools/conformance.mts uses on the reason field
      // of a known difference.
      if (task.status === 'partial' && (task.detail ?? '').trim().length < MIN_PARTIAL_DETAIL) {
        findings.push({
          where: task.id,
          message:
            `is "partial" with ${String((task.detail ?? '').trim().length)} characters of detail. ` +
            `Partial is only honest when it says what is missing; ${String(MIN_PARTIAL_DETAIL)} ` +
            'characters is the floor.',
        });
      }

      if (needs && evidence.length === 0) {
        findings.push({
          where: task.id,
          message:
            `is "${task.status}" and names no evidence. ` +
            'A status is a claim, and a claim needs a citation.',
        });
      } else if (task.status === 'done' && !evidence.some((e) => STRONG.has(e.kind))) {
        findings.push({
          where: task.id,
          message:
            'is "done" but cites only supporting evidence ' +
            `(${[...new Set(evidence.map((e) => e.kind))].join(', ')}). ` +
            `A done claim needs at least one of: ${[...STRONG].join(', ')}.`,
        });
      }

      if (task.status === 'todo' || task.status === 'blocked') {
        if (evidence.some((e) => e.kind === 'absent' || e.kind === 'no-files')) {
          ratcheted += 1;
        } else {
          unratcheted.push(task.id);
          // Printing the count was not enough on its own: nothing stopped
          // somebody deleting a ratchet, and the gate would have gone on
          // passing with a longer list nobody reads. Not every absence can be
          // expressed as a search -- "separate the two parsers" has no name to
          // grep for -- so the requirement is a search OR a sentence saying why
          // there cannot be one.
          if ((task.detail ?? '').trim().length < MIN_PARTIAL_DETAIL) {
            findings.push({
              where: task.id,
              message:
                'is open with no absence check and no explanation. Either name a search that ' +
                'goes red when the work lands, or say in `detail` why this one cannot be watched.',
            });
          }
        }
      }

      // Evidence is verified for EVERY status, not only the ones that require
      // it: a citation left behind on a task that regressed is drift too.
      evidence.forEach((ev, i) => {
        evidenceChecked += 1;
        findings.push(...checkOne(ev, `${task.id}[${String(i)}]`, ctx));
      });
      if (needs) tasksChecked += 1;
    }
  }

  // The cited tests must have RUN and PASSED. Static existence is not enough:
  // `npm test` proves the suite is green, but nothing tied a specific green
  // test to a specific claim until here.
  const citedFiles = [...new Set([...ctx.citedTests.values()].map((v) => v.file))].sort();
  if (citedFiles.length > 0 && ctx.fatal.length === 0) {
    const result = runner.run(citedFiles);
    if (result.error !== null) {
      ctx.fatal.push(`could not run the cited tests: ${result.error}`);
    } else {
      for (const [name, cited] of ctx.citedTests) {
        // Both, not either. A file can declare the same name twice -- in two
        // describes, say -- and TAP then reports two results under it. Taking
        // `passed` alone would let the failing one hide behind the passing one.
        if (result.passed.has(name) && !result.notPassed.has(name)) continue;
        findings.push({
          where: cited.file,
          message: result.notPassed.has(name)
            ? `cited test ${JSON.stringify(name)} did not pass`
            : `cited test ${JSON.stringify(name)} produced no result when its file was run`,
        });
      }
    }
  }

  // Self-check. A filtering mistake that empties the workload must be louder
  // than a clean run, not quieter.
  if (tasksChecked !== tasksRequiringEvidence) {
    ctx.fatal.push(
      `checked ${String(tasksChecked)} of ${String(tasksRequiringEvidence)} tasks that require ` +
        'evidence. The checker skipped work it was supposed to do.',
    );
  }
  if (tasksRequiringEvidence > 0 && evidenceChecked === 0) {
    ctx.fatal.push('no evidence was evaluated at all, yet tasks claim to be done.');
  }
  // The emptiest possible pass. Every counter above is zero when WORK is, and
  // zero findings out of zero tasks is exactly what a gate reports when it has
  // stopped being given anything to check.
  const taskCount = items.reduce((n, i) => n + i.tasks.length, 0);
  if (items.length === 0 || taskCount === 0) {
    ctx.fatal.push(
      `given ${String(items.length)} work item(s) and ${String(taskCount)} task(s). ` +
        'An empty plan is not a clean one.',
    );
  }

  return {
    findings,
    fatal: ctx.fatal,
    evidenceChecked,
    tasksRequiringEvidence,
    tasksChecked,
    citedTestsRun: ctx.citedTests.size,
    ratcheted,
    unratcheted,
  };
}
