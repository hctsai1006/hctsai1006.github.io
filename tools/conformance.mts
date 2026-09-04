/**
 * conformance.mts -- compare this project against a REAL PowerShell.
 *
 * The claim "browser-hosted PowerShell-compatible" is unfalsifiable until
 * something measures it. This is the thing that measures it.
 *
 *   tools/generate-conformance-fixtures.ps1   runs the corpus against pwsh
 *   tests/conformance/fixtures/pwsh-*.json    what pwsh actually did
 *   this file                                 runs the corpus against US, and
 *                                             compares
 *
 * WHAT COUNTS AS EVIDENCE, AND WHAT DOES NOT
 *
 * A case is only evidence if the project computed something and it matched. The
 * three other outcomes are reported separately and never inflate the number:
 *
 *   match          the project answered, and agrees with the reference
 *   difference     the project answered, and disagrees. Unexplained is a
 *                  FAILURE; explained lives in known-differences.yml with a
 *                  reason, and a `known-gap` explanation still does not count as
 *                  fidelity
 *   unimplemented  the project has nothing to ask. Counted, named, and excluded
 *                  from coverage -- this is most of the corpus today, and saying
 *                  so is the point
 *
 * Coverage is therefore a floor, not a ceiling: it is the share of
 * native-semantic commands for which at least one behaviour has been shown to
 * agree with pwsh 7.6.5 on this machine. It is deliberately not the share of
 * cases that "pass", because a case with no implementation behind it passes
 * nothing.
 *
 * WHY THERE IS A TINY YAML READER IN HERE
 *
 * No YAML parser is installed. known-differences.yml is forty lines of a narrow
 * subset, and taking a dependency to read it would be a worse trade than the
 * fifty lines below -- which reject anything they do not understand, with a line
 * number, rather than misparsing it. The alternative considered was to use JSON
 * with a .yml name, which was rejected: the file is written and read by humans
 * arguing about whether a divergence is defensible, and JSON cannot hold a
 * paragraph of prose without escaping every newline.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareValues,
  enumerate,
  getProperty,
  hasProperty,
  isOfType,
  isTruthy,
  propertyNames,
  psObject,
  typeNameOf,
  valuesEqual,
} from '../src/pipeline/psobject.ts';
import type { PSValue } from '../src/pipeline/psobject.ts';
import { errorRecord } from '../src/pipeline/streams.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// small strict helpers
// ---------------------------------------------------------------------------

/**
 * Everything below refuses to guess. A harness that quietly tolerates a
 * malformed input file is a harness that can report success without having read
 * anything, which is the exact failure this repo's other verifiers exist to
 * prevent.
 */
class ConformanceInputError extends Error {}

function fail(message: string): never {
  throw new ConformanceInputError(message);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function requireString(source: Record<string, unknown>, key: string, where: string): string {
  const v = source[key];
  if (typeof v !== 'string' || v.trim() === '') fail(`${where}: '${key}' must be a non-empty string`);
  return v as string;
}

function requireArray(source: Record<string, unknown>, key: string, where: string): readonly unknown[] {
  const v = source[key];
  if (!Array.isArray(v)) fail(`${where}: '${key}' must be an array`);
  return v as readonly unknown[];
}

function requireRecord(source: Record<string, unknown>, key: string, where: string): Record<string, unknown> {
  const v = source[key];
  if (!isRecord(v)) fail(`${where}: '${key}' must be an object`);
  return v as Record<string, unknown>;
}

function rejectUnknownKeys(source: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(source)) {
    // An unknown key is either a typo or a feature nobody implemented. Both
    // mean the file does not do what it appears to say.
    if (!allowed.includes(key)) fail(`${where}: unknown key '${key}' (allowed: ${allowed.join(', ')})`);
  }
}

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    return fail(`cannot read ${relative(REPO, path)}: ${(error as Error).message}`);
  }
};

// ---------------------------------------------------------------------------
// the tiny YAML reader
// ---------------------------------------------------------------------------

type YamlScalar = string | readonly string[];

/**
 * Parse the subset documented at the top of known-differences.yml:
 * top-level scalars, one top-level block sequence of mappings, plain and
 * double-quoted scalars, flow sequences, and folded (`>` / `>-`) block scalars.
 *
 * Every unsupported construct throws with a line number. That is the whole
 * design: it is better to refuse a file than to read half of it.
 */
function parseNarrowYaml(text: string, file: string): {
  scalars: Record<string, string>;
  sequences: Record<string, readonly Record<string, YamlScalar>[]>;
} {
  const lines = text.split(/\r?\n/);
  const scalars: Record<string, string> = {};
  const sequences: Record<string, Record<string, YamlScalar>[]> = {};

  const at = (n: number): string => `${file}:${n + 1}`;

  /** Split `key: rest`, rejecting anything that is not a plain mapping key. */
  const splitKey = (body: string, lineNo: number): { key: string; rest: string } => {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$/.exec(body);
    if (match === null || match[1] === undefined) {
      fail(`${at(lineNo)}: expected 'key: value' or 'key:', got: ${body}`);
    }
    return { key: match[1] as string, rest: (match[2] ?? '').trim() };
  };

  /** A value that fits on one line. */
  const parseInlineValue = (raw: string, lineNo: number): YamlScalar => {
    if (raw.startsWith('[')) {
      if (!raw.endsWith(']')) fail(`${at(lineNo)}: unterminated flow sequence`);
      const inner = raw.slice(1, -1).trim();
      if (inner === '') return [];
      return inner.split(',').map((part) => {
        const item = part.trim();
        if (item === '') fail(`${at(lineNo)}: empty item in flow sequence`);
        if (item.startsWith('"')) return parseInlineValue(item, lineNo) as string;
        if (/[:[\]{}"']/.test(item)) fail(`${at(lineNo)}: flow item needs quoting: ${item}`);
        return item;
      });
    }
    if (raw.startsWith('"')) {
      if (!raw.endsWith('"') || raw.length < 2) fail(`${at(lineNo)}: unterminated quoted scalar`);
      // Only the two escapes the subset admits. An unknown escape is an error,
      // not a backslash passed through.
      return raw.slice(1, -1).replace(/\\(.)/g, (_whole, ch: string) => {
        if (ch === '"' || ch === '\\') return ch;
        return fail(`${at(lineNo)}: unsupported escape \\${ch}`);
      });
    }
    if (raw.includes('#')) fail(`${at(lineNo)}: inline comments are not supported; quote the value or move the comment to its own line`);
    return raw;
  };

  /**
   * A folded block scalar: every following line indented deeper than `minIndent`
   * joins with a single space. `>-` and `>` are treated identically because the
   * subset has no use for a trailing newline.
   */
  const readFolded = (start: number, minIndent: number): { value: string; next: number } => {
    const parts: string[] = [];
    let i = start;
    for (; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (line.trim() === '') {
        // A blank line between entries is fine and simply ends the scalar. A
        // blank line WITH more indented content after it would be a paragraph
        // break, which real YAML supports and this reader does not -- so it is
        // rejected rather than guessed at.
        let peek = i + 1;
        while (peek < lines.length && (lines[peek] ?? '').trim() === '') peek++;
        const following = lines[peek];
        if (following !== undefined && following.length - following.trimStart().length > minIndent) {
          fail(`${at(i)}: blank line inside a folded block scalar is not supported`);
        }
        break;
      }
      const indent = line.length - line.trimStart().length;
      if (indent <= minIndent) break;
      parts.push(line.trim());
    }
    if (parts.length === 0) fail(`${at(start)}: folded block scalar is empty`);
    return { value: parts.join(' '), next: i };
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      i++;
      continue;
    }
    if (line.includes('\t')) fail(`${at(i)}: tabs are not valid YAML indentation`);

    const indent = line.length - line.trimStart().length;
    if (indent !== 0) fail(`${at(i)}: expected a top-level key, found an indented line`);

    const { key, rest } = splitKey(line.trim(), i);
    if (rest !== '') {
      const value = parseInlineValue(rest, i);
      if (Array.isArray(value)) fail(`${at(i)}: top-level sequences must be block sequences`);
      scalars[key] = value as string;
      i++;
      continue;
    }

    // `key:` with nothing after it introduces a block sequence of mappings.
    i++;
    const items: Record<string, YamlScalar>[] = [];
    let current: Record<string, YamlScalar> | null = null;
    let itemIndent = -1;

    while (i < lines.length) {
      const raw = lines[i] ?? '';
      if (raw.trim() === '' || raw.trimStart().startsWith('#')) {
        i++;
        continue;
      }
      if (raw.includes('\t')) fail(`${at(i)}: tabs are not valid YAML indentation`);
      const thisIndent = raw.length - raw.trimStart().length;
      if (thisIndent === 0) break;

      const body = raw.trim();
      if (body.startsWith('- ')) {
        current = {};
        items.push(current);
        itemIndent = thisIndent + 2;
        const entry = splitKey(body.slice(2).trim(), i);
        if (entry.rest === '') fail(`${at(i)}: a sequence item must start with 'key: value'`);
        current[entry.key] = parseInlineValue(entry.rest, i);
        i++;
        continue;
      }
      if (current === null) fail(`${at(i)}: mapping key outside a sequence item`);
      if (thisIndent !== itemIndent) {
        fail(`${at(i)}: expected indent ${itemIndent} to continue the sequence item, found ${thisIndent}`);
      }
      const entry = splitKey(body, i);
      if (entry.key in current) fail(`${at(i)}: duplicate key '${entry.key}' in one item`);
      if (entry.rest === '>' || entry.rest === '>-') {
        const folded = readFolded(i + 1, thisIndent);
        current[entry.key] = folded.value;
        i = folded.next;
        continue;
      }
      if (entry.rest === '') fail(`${at(i)}: '${entry.key}:' has no value (nested mappings are not supported)`);
      current[entry.key] = parseInlineValue(entry.rest, i);
      i++;
    }

    if (items.length === 0) fail(`${at(i)}: '${key}:' introduced an empty block sequence`);
    sequences[key] = items;
  }

  return { scalars, sequences };
}

// ---------------------------------------------------------------------------
// corpus, fixtures, known differences
// ---------------------------------------------------------------------------

interface CorpusCase {
  readonly id: string;
  readonly area: string;
  readonly command: string | null;
  readonly why: string;
  readonly source: string;
  readonly observe: string;
  readonly probeKind: string;
  readonly probeArgs: Record<string, unknown>;
  readonly pending: string | null;
}

const CASE_KEYS = [
  'id', 'area', 'command', 'why', 'source', 'observe', 'probe',
  'pending', 'volatile', 'platformSensitive', 'passes', 'passesReason',
] as const;

function loadCorpus(path: string): { targetVersion: string; cases: readonly CorpusCase[] } {
  const doc = readJson(path);
  if (!isRecord(doc)) return fail('corpus.json must be an object');
  const targetVersion = requireString(doc, 'targetVersion', 'corpus');
  const rawCases = requireArray(doc, 'cases', 'corpus');

  const seen = new Set<string>();
  const cases: CorpusCase[] = [];
  for (const raw of rawCases) {
    if (!isRecord(raw)) fail('corpus: every case must be an object');
    const entry = raw as Record<string, unknown>;
    const id = requireString(entry, 'id', 'corpus case');
    const where = `corpus case '${id}'`;
    rejectUnknownKeys(entry, CASE_KEYS, where);
    if (seen.has(id)) fail(`${where}: duplicate id`);
    seen.add(id);

    const probe = requireRecord(entry, 'probe', where);
    rejectUnknownKeys(probe, ['kind', 'args'], `${where}.probe`);
    const probeKind = requireString(probe, 'kind', `${where}.probe`);
    const probeArgs = probe['args'] === undefined ? {} : requireRecord(probe, 'args', `${where}.probe`);

    const command = entry['command'];
    if (command !== null && typeof command !== 'string') fail(`${where}: 'command' must be a string or null`);

    const pending = entry['pending'];
    if (probeKind === 'none' && (typeof pending !== 'string' || pending.trim() === '')) {
      fail(`${where}: probe kind 'none' requires a 'pending' reason`);
    }

    cases.push({
      id,
      area: requireString(entry, 'area', where),
      command: (command as string | null),
      why: requireString(entry, 'why', where),
      source: requireString(entry, 'source', where),
      observe: requireString(entry, 'observe', where),
      probeKind,
      probeArgs,
      pending: typeof pending === 'string' ? pending : null,
    });
  }
  return { targetVersion, cases };
}

interface FixtureOutcome {
  readonly objectCount: number;
  readonly typeNames: readonly unknown[];
  readonly values: readonly unknown[];
  readonly text: string;
  /** null when the source TERMINATED before $? could be read -- which is not
   *  the same as $? being False, and must not be recorded as if it were. */
  readonly ok: boolean | null;
  readonly terminated: boolean;
  readonly lastExitCode: number | null;
  readonly errorCount: number;
  readonly errors: readonly Record<string, unknown>[];
}

interface FixtureCase {
  readonly id: string;
  readonly sourceHash: string;
  readonly determinism: string;
  readonly outcome: FixtureOutcome;
  readonly cultureFindings: readonly Record<string, unknown>[];
}

interface Fixture {
  readonly partial: boolean;
  readonly capturedAt: string;
  readonly engine: Record<string, unknown>;
  readonly capture: Record<string, unknown>;
  readonly cases: ReadonlyMap<string, FixtureCase>;
}

/**
 * The trust boundary between pwsh's JSON and this program's types.
 *
 * Everything below CHECKS rather than casts. A cast here would let a shape
 * change in a future PowerShell -- or a half-written fixture -- arrive as
 * undefined in the middle of a comparison and quietly turn a real difference
 * into a match. The whole point of the harness is that it cannot do that.
 */
function requireNumber(source: Record<string, unknown>, key: string, where: string): number {
  const v = source[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${where}: '${key}' must be a finite number, got ${JSON.stringify(v)}`);
  return v;
}

function requireBoolean(source: Record<string, unknown>, key: string, where: string): boolean {
  const v = source[key];
  if (typeof v !== 'boolean') fail(`${where}: '${key}' must be a boolean, got ${JSON.stringify(v)}`);
  return v;
}

function requireRecordArray(source: Record<string, unknown>, key: string, where: string): readonly Record<string, unknown>[] {
  const items = requireArray(source, key, where);
  const out: Record<string, unknown>[] = [];
  for (const [index, item] of items.entries()) {
    if (!isRecord(item)) fail(`${where}: '${key}[${index}]' must be an object`);
    out.push(item);
  }
  return out;
}

/** $? is a boolean, or null when the source never got far enough to have one. */
function optionalBoolean(source: Record<string, unknown>, key: string, where: string): boolean | null {
  const v = source[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'boolean') fail(`${where}: '${key}' must be a boolean or null, got ${JSON.stringify(v)}`);
  return v;
}

/** Rendered text: a string, and legitimately EMPTY when a case emitted nothing.
 *  requireString rejects empty, which is right for an id and wrong for this. */
function requireTextField(source: Record<string, unknown>, key: string, where: string): string {
  const v = source[key];
  if (typeof v !== 'string') fail(`${where}: '${key}' must be a string, got ${JSON.stringify(v)}`);
  return v;
}

/** ConvertTo-Json writes an absent value as JSON null, never as a missing key,
 *  so "null or an integer" is a real state here rather than a shrug. */
function optionalNumber(source: Record<string, unknown>, key: string, where: string): number | null {
  const v = source[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${where}: '${key}' must be a number or null, got ${JSON.stringify(v)}`);
  return v;
}

function loadFixture(path: string): Fixture {
  const where0 = relative(REPO, path);
  const doc = readJson(path);
  if (!isRecord(doc)) return fail(`${where0}: fixture must be an object`);
  const cases = new Map<string, FixtureCase>();
  for (const entry of requireRecordArray(doc, 'cases', where0)) {
    const id = requireString(entry, 'id', `${where0}: case`);
    const where = `${where0}: case '${id}'`;
    if (cases.has(id)) fail(`${where}: duplicate case id in the fixture`);
    const outcome = requireRecord(entry, 'outcome', where);
    cases.set(id, {
      id,
      sourceHash: requireString(entry, 'sourceHash', where),
      determinism: requireString(entry, 'determinism', where),
      cultureFindings: requireRecordArray(entry, 'cultureFindings', where),
      outcome: {
        objectCount: requireNumber(outcome, 'objectCount', `${where}.outcome`),
        typeNames: requireArray(outcome, 'typeNames', `${where}.outcome`),
        values: requireArray(outcome, 'values', `${where}.outcome`),
        text: requireTextField(outcome, 'text', `${where}.outcome`),
        ok: optionalBoolean(outcome, 'ok', `${where}.outcome`),
        terminated: requireBoolean(outcome, 'terminated', `${where}.outcome`),
        lastExitCode: optionalNumber(outcome, 'lastExitCode', `${where}.outcome`),
        errorCount: requireNumber(outcome, 'errorCount', `${where}.outcome`),
        errors: requireRecordArray(outcome, 'errors', `${where}.outcome`),
      },
    });
  }
  if (cases.size === 0) fail(`${where0}: fixture contains no cases`);
  return {
    partial: requireBoolean(doc, 'partial', where0),
    capturedAt: requireString(doc, 'capturedAt', where0),
    engine: requireRecord(doc, 'engine', where0),
    capture: requireRecord(doc, 'capture', where0),
    cases,
  };
}

const DIFFERENCE_KEYS = ['id', 'kind', 'expect', 'cases', 'reason'] as const;
const DIFFERENCE_KINDS = ['deliberate', 'known-gap'] as const;
const DIFFERENCE_EXPECTS = ['differs', 'matches', 'unimplemented'] as const;

interface KnownDifference {
  readonly id: string;
  readonly kind: string;
  readonly expect: string;
  readonly cases: readonly string[];
  readonly reason: string;
}

function loadKnownDifferences(path: string, corpusIds: ReadonlySet<string>): readonly KnownDifference[] {
  const file = relative(REPO, path);
  const parsed = parseNarrowYaml(readFileSync(path, 'utf8'), file);
  if (parsed.scalars['schemaVersion'] !== '1') fail(`${file}: schemaVersion must be 1`);

  const items = parsed.sequences['differences'];
  if (items === undefined) fail(`${file}: no 'differences:' sequence`);

  const seen = new Set<string>();
  const claimed = new Map<string, string>();
  const out: KnownDifference[] = [];

  for (const item of items as readonly Record<string, YamlScalar>[]) {
    const id = item['id'];
    if (typeof id !== 'string') fail(`${file}: an entry has no 'id'`);
    const where = `${file}: entry '${id as string}'`;
    for (const key of Object.keys(item)) {
      if (!DIFFERENCE_KEYS.includes(key as (typeof DIFFERENCE_KEYS)[number])) fail(`${where}: unknown key '${key}'`);
    }
    if (seen.has(id as string)) fail(`${where}: duplicate id`);
    seen.add(id as string);

    const kind = item['kind'];
    if (typeof kind !== 'string' || !DIFFERENCE_KINDS.includes(kind as (typeof DIFFERENCE_KINDS)[number])) {
      fail(`${where}: 'kind' must be one of ${DIFFERENCE_KINDS.join(', ')}`);
    }
    const expect = item['expect'];
    if (typeof expect !== 'string' || !DIFFERENCE_EXPECTS.includes(expect as (typeof DIFFERENCE_EXPECTS)[number])) {
      fail(`${where}: 'expect' must be one of ${DIFFERENCE_EXPECTS.join(', ')}`);
    }
    // The rule the whole file exists for: no reason, no entry.
    const reason = item['reason'];
    if (typeof reason !== 'string' || reason.trim().length < 20) {
      fail(`${where}: 'reason' is required and must actually explain something`);
    }
    const cases = item['cases'];
    if (!Array.isArray(cases) || cases.length === 0) fail(`${where}: 'cases' must be a non-empty list`);

    for (const caseId of cases as readonly string[]) {
      if (!corpusIds.has(caseId)) fail(`${where}: names case '${caseId}', which is not in the corpus`);
      const owner = claimed.get(caseId);
      if (owner !== undefined) fail(`${where}: case '${caseId}' is already explained by '${owner}'`);
      claimed.set(caseId, id as string);
    }

    out.push({ id: id as string, kind: kind as string, expect: expect as string, cases: cases as readonly string[], reason: reason as string });
  }
  return out;
}

// ---------------------------------------------------------------------------
// probes -- the project side
// ---------------------------------------------------------------------------

/**
 * Decode a corpus probe argument into a PSValue.
 *
 * Plain JSON covers most of it. The three tagged forms exist because JSON has no
 * way to say "this is a PowerShell object", "these are bytes" or "this is a
 * DateTime", and collapsing them into strings would make the type-name probes
 * test nothing.
 */
function decodeValue(raw: unknown, where: string): PSValue {
  if (raw === null) return null;
  if (typeof raw === 'boolean' || typeof raw === 'number' || typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.map((item) => decodeValue(item, where));
  if (isRecord(raw)) {
    const keys = Object.keys(raw);
    if (keys.length !== 1) fail(`${where}: a tagged value must have exactly one key, got [${keys.join(', ')}]`);
    const tag = keys[0];
    const body = raw[tag as string];
    if (tag === '$object') {
      if (!isRecord(body)) fail(`${where}: $object must hold an object`);
      const properties: Record<string, PSValue> = {};
      for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
        properties[key] = decodeValue(value, where);
      }
      return psObject(properties);
    }
    if (tag === '$bytes') {
      if (!Array.isArray(body)) fail(`${where}: $bytes must hold an array of numbers`);
      return Uint8Array.from((body as readonly unknown[]).map((n) => Number(n)));
    }
    if (tag === '$date') {
      if (typeof body !== 'string') fail(`${where}: $date must hold an ISO string`);
      return new Date(body as string);
    }
    return fail(`${where}: unknown tagged value '${tag}'`);
  }
  return fail(`${where}: cannot decode ${typeof raw}`);
}

/** Pull the ErrorCategory union out of streams.ts so the check is against the
 *  real declaration rather than a copy of it that could drift. */
function readErrorCategories(): readonly string[] {
  const path = join(REPO, 'src/pipeline/streams.ts');
  const text = readFileSync(path, 'utf8');
  const match = /export type ErrorCategory =([\s\S]*?);/.exec(text);
  const body = match?.[1];
  if (body === undefined) fail('src/pipeline/streams.ts: could not find the ErrorCategory union');
  const names = [...(body as string).matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]).filter((n): n is string => n !== undefined);
  if (names.length < 10) fail('src/pipeline/streams.ts: ErrorCategory union looks truncated');
  return names;
}

interface ManifestParameter {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly type?: string;
  readonly isSwitch?: boolean;
  readonly firstPosition?: number | null;
  readonly valueFromPipelineInAnySet?: boolean;
  readonly sets?: Record<string, unknown>;
}
interface ManifestCommand {
  readonly name: string;
  readonly fidelity: string;
  readonly parameterSource: string;
  readonly parameters: readonly ManifestParameter[];
}

function loadManifests(): readonly ManifestCommand[] {
  const doc = readJson(join(REPO, 'src/commands/manifests.json'));
  if (!isRecord(doc)) return fail('manifests.json must be an object');
  return requireArray(doc, 'commands', 'manifests') as readonly ManifestCommand[];
}

const MANIFESTS = loadManifests();
const ERROR_CATEGORIES = readErrorCategories();

function manifestParameterField(args: Record<string, unknown>): unknown {
  const commandName = String(args['command']);
  const parameterName = String(args['parameter']);
  const field = String(args['field']);
  const command = MANIFESTS.find((c) => c.name === commandName);
  if (command === undefined) fail(`manifest-parameter: no command '${commandName}' in manifests.json`);
  const parameter = (command as ManifestCommand).parameters.find((p) => p.name === parameterName);
  if (parameter === undefined) fail(`manifest-parameter: ${commandName} has no parameter '${parameterName}'`);
  const p = parameter as ManifestParameter;
  switch (field) {
    case 'type':
      return p.type;
    case 'isSwitch':
      return p.isSwitch;
    case 'firstPosition':
      return p.firstPosition;
    case 'valueFromPipelineInAnySet':
      return p.valueFromPipelineInAnySet;
    // Joined, because the reference implementation is asked for a joined string:
    // `(...).Aliases | Sort-Object) -join ','`. Comparing a list against a
    // string would fail for the wrong reason.
    case 'aliases':
      return [...(p.aliases ?? [])].sort().join(',');
    case 'setNames':
      return Object.keys(p.sets ?? {}).sort().join(',');
    default:
      return fail(`manifest-parameter: unknown field '${field}'`);
  }
}

type Probe = (args: Record<string, unknown>, where: string) => unknown;

/**
 * The registry. A corpus case naming a kind that is not here is a hard error --
 * a typo must never silently become "unimplemented", because unimplemented is a
 * claim about the project, not about the corpus.
 */
const PROBES: Record<string, Probe> = {
  'enumerate-count': (args, where) => [...enumerate(decodeValue(args['value'], where))].length,
  'enumerate-typenames': (args, where) => [...enumerate(decodeValue(args['value'], where))].map(typeNameOf),
  truthy: (args, where) => isTruthy(decodeValue(args['value'], where)),
  'type-name': (args, where) => typeNameOf(decodeValue(args['value'], where)),
  compare: (args, where) => {
    const left = decodeValue(args['left'], where);
    const right = decodeValue(args['right'], where);
    const caseSensitive = args['caseSensitive'] === true;
    const op = String(args['op']);
    if (op === 'eq') return valuesEqual(left, right, caseSensitive);
    if (op === 'ne') return !valuesEqual(left, right, caseSensitive);
    const sign = compareValues(left, right, caseSensitive);
    if (op === 'lt') return sign < 0;
    if (op === 'gt') return sign > 0;
    if (op === 'le') return sign <= 0;
    if (op === 'ge') return sign >= 0;
    return fail(`${where}: unknown comparison op '${op}'`);
  },
  sort: (args, where) => {
    const values = args['values'];
    if (!Array.isArray(values)) fail(`${where}: 'values' must be an array`);
    const caseSensitive = args['caseSensitive'] === true;
    // Array.prototype.sort is stable in every engine this targets, which is what
    // makes it comparable to Sort-Object -- Sort-Object is stable too, and the
    // mixed-case case depends on it.
    return [...(values as readonly unknown[])]
      .map((v) => decodeValue(v, where))
      .sort((a, b) => compareValues(a, b, caseSensitive));
  },
  'property-get': (args, where) => {
    const properties = requireRecord(args, 'properties', where);
    const bag: Record<string, PSValue> = {};
    for (const [k, v] of Object.entries(properties)) bag[k] = decodeValue(v, where);
    return getProperty(psObject(bag), String(args['name'])) ?? null;
  },
  'property-missing': (args, where) => {
    const properties = requireRecord(args, 'properties', where);
    const bag: Record<string, PSValue> = {};
    for (const [k, v] of Object.entries(properties)) bag[k] = decodeValue(v, where);
    // The reference implementation is asked `$null -eq (...).Properties['X']`,
    // so True means "no such member". getProperty returning undefined -- as
    // opposed to null -- is exactly that distinction.
    return getProperty(psObject(bag), String(args['name'])) === undefined;
  },
  'has-property': (args, where) => {
    const properties = requireRecord(args, 'properties', where);
    const bag: Record<string, PSValue> = {};
    for (const [k, v] of Object.entries(properties)) bag[k] = decodeValue(v, where);
    return hasProperty(psObject(bag), String(args['name']));
  },
  'property-names': (args, where) => {
    const properties = requireRecord(args, 'properties', where);
    const bag: Record<string, PSValue> = {};
    for (const [k, v] of Object.entries(properties)) bag[k] = decodeValue(v, where);
    return [...propertyNames(psObject(bag))];
  },
  'is-of-type': (args, where) => {
    const typeNames = args['typeNames'];
    if (!Array.isArray(typeNames)) fail(`${where}: 'typeNames' must be an array`);
    return isOfType(psObject({}, (typeNames as readonly unknown[]).map(String)), String(args['query']));
  },
  'error-id': (args) =>
    // Checks the composition rule in streams.ts, `<ErrorId>,<CommandName>`,
    // against the FullyQualifiedErrorId the reference implementation produced.
    errorRecord('unused message', String(args['errorId']), String(args['command'])).fullyQualifiedErrorId,
  'error-category-known': () => 'known',
  'manifest-parameter': (args) => manifestParameterField(args),
};

// ---------------------------------------------------------------------------
// comparison
// ---------------------------------------------------------------------------

const canonical = (value: unknown): string => JSON.stringify(value ?? null);

/**
 * Read the observable a case declares out of the fixture.
 *
 * Every observable is named in the corpus and validated by the capture script,
 * so an unknown one here means the two sides disagree about the vocabulary --
 * which must be an error, not a default.
 */
function observe(outcome: FixtureOutcome, name: string, where: string): unknown {
  switch (name) {
    case 'values':
      return outcome.values;
    case 'typeNames':
      return outcome.typeNames;
    case 'objectCount':
      return outcome.objectCount;
    case 'text':
      return outcome.text;
    case 'ok':
      return outcome.ok;
    case 'lastExitCode':
      return outcome.lastExitCode;
    case 'errorCount':
      return outcome.errorCount;
    case 'errorId':
      return outcome.errors[0]?.['fullyQualifiedErrorId'] ?? null;
    case 'errorCategory':
      return outcome.errors[0]?.['category'] ?? null;
    default:
      return fail(`${where}: unknown observable '${name}'`);
  }
}

/**
 * Does the project's answer match the reference implementation's?
 *
 * The one accommodation: a scalar probe result is compared against a
 * single-element observable. PowerShell emits `2`; the pipeline records it as
 * one emitted object, so `values` is `[2]`. Requiring the corpus to wrap every
 * scalar probe in an array would put a formatting concern into every case.
 * Anything else is compared structurally.
 */
function matches(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected) && expected.length === 1 && !Array.isArray(actual)) {
    return canonical(expected[0]) === canonical(actual);
  }
  if (actual instanceof Uint8Array) return canonical(expected) === canonical([...actual]);
  return canonical(expected) === canonical(actual);
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

type Outcome = 'match' | 'difference' | 'unimplemented' | 'error';

interface CaseResult {
  readonly id: string;
  readonly command: string | null;
  readonly area: string;
  readonly outcome: Outcome;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly explainedBy: string | null;
  readonly explanationKind: string | null;
  readonly detail: string | null;
}

export interface ConformanceReport {
  /**
   * Deliberately absent: a "generated at" timestamp. The report is a pure
   * function of the corpus, the fixture and this project, so a run timestamp
   * would add churn to every diff without adding truth -- and re-running it and
   * finding no change is then a real check that it is up to date. The date that
   * matters is when the REFERENCE IMPLEMENTATION was consulted, which is
   * fixtureCapturedAt.
   */
  readonly engine: Record<string, unknown>;
  readonly capture: Record<string, unknown>;
  readonly fixtureCapturedAt: string;
  readonly platformCaveat: string | null;
  readonly totals: {
    readonly cases: number;
    readonly compared: number;
    readonly matched: number;
    readonly differencesExplained: number;
    readonly differencesUnexplained: number;
    readonly unimplemented: number;
  };
  readonly coverage: {
    readonly nativeSemanticCommands: number;
    readonly commandsWithBehaviouralEvidence: number;
    readonly behaviouralCoveragePercent: number;
    readonly commandsWithMetadataEvidence: number;
    readonly metadataCoveragePercent: number;
  };
  readonly perCommand: readonly {
    readonly command: string;
    readonly behavioural: number;
    readonly metadata: number;
    readonly unimplemented: number;
    readonly differences: number;
  }[];
  readonly cultureSensitiveCases: readonly string[];
  readonly knownDifferences: readonly { readonly id: string; readonly kind: string; readonly expect: string; readonly cases: readonly string[] }[];
  readonly problems: readonly string[];
  readonly cases: readonly CaseResult[];
}

export function runConformance(): ConformanceReport {
  const corpusPath = join(REPO, 'tests/conformance/corpus.json');
  const { targetVersion, cases } = loadCorpus(corpusPath);
  const fixturePath = join(REPO, `tests/conformance/fixtures/pwsh-${targetVersion}.json`);
  const fixture = loadFixture(fixturePath);
  const knownDifferences = loadKnownDifferences(
    join(REPO, 'tests/conformance/known-differences.yml'),
    new Set(cases.map((c) => c.id)),
  );

  const problems: string[] = [];

  // The fixture must describe the engine this project claims to model, and the
  // claim must come from the release lock rather than from a constant here.
  const lock = readJson(join(REPO, 'compat/upstream/releases.lock.json'));
  if (!isRecord(lock)) return fail('releases.lock.json must be an object');
  const releases = requireArray(lock, 'releases', 'releases.lock.json');
  const ltsVersions = releases
    .filter((r): r is Record<string, unknown> => isRecord(r) && r['channel'] === 'lts')
    .map((r) => String(r['version']));
  if (!ltsVersions.includes(targetVersion)) {
    problems.push(`corpus targets ${targetVersion}, which is not an LTS release in compat/upstream/releases.lock.json (${ltsVersions.join(', ')})`);
  }
  const fixtureVersion = String(fixture.engine['psVersion']);
  if (fixtureVersion !== targetVersion) {
    problems.push(`fixture was captured from PowerShell ${fixtureVersion} but the corpus targets ${targetVersion}`);
  }
  if (fixture.partial) {
    problems.push('fixture is marked partial: it was captured with -Id and does not cover the corpus');
  }

  // The published compatibility profiles target Linux; this capture is from
  // Windows. Not a failure -- there is no Linux pwsh on this machine -- but it
  // bounds what the numbers below are evidence FOR, so it is stated rather than
  // left for a reader to notice.
  const platform = String(fixture.engine['platform']);
  const platformCaveat = platform === 'Win32NT'
    ? 'Captured on Win32NT while the published compatibility profiles target PowerShell on Linux. The corpus is deliberately platform-neutral (no filesystem or path semantics), and the capture fails on any case where a drive letter survives normalisation, but path and provider behaviour remains untested.'
    : null;

  const explanationByCase = new Map<string, KnownDifference>();
  for (const entry of knownDifferences) {
    for (const caseId of entry.cases) explanationByCase.set(caseId, entry);
  }

  const results: CaseResult[] = [];
  for (const c of cases) {
    const fixtureCase = fixture.cases.get(c.id);
    if (fixtureCase === undefined) {
      problems.push(`case '${c.id}' has no fixture: re-run tools/generate-conformance-fixtures.ps1`);
      continue;
    }
    // A corpus source edited without re-capturing would silently compare the
    // project against a recording of something else.
    const hash = `sha256:${createHash('sha256').update(c.source, 'utf8').digest('hex')}`;
    if (hash !== fixtureCase.sourceHash) {
      problems.push(`case '${c.id}': the corpus source changed since capture; re-run tools/generate-conformance-fixtures.ps1`);
      continue;
    }
    if (fixtureCase.determinism === 'UNSTABLE') {
      problems.push(`case '${c.id}': the fixture records an unstable capture and must not be compared against`);
      continue;
    }

    // A case that asks for a VALUE but whose recording is nothing but nulls
    // alongside an error is not a difference -- it is a broken corpus case that
    // never exercised the reference implementation. Comparing against it would
    // manufacture a difference out of the author's typo. Found this way:
    // meta.measure-object-inputobject-pipeline named a parameter set that
    // Measure-Object does not have, so pwsh recorded [null] and the project's
    // (correct) `true` looked like a divergence.
    if (c.observe === 'ok' && fixtureCase.outcome.terminated) {
      problems.push(`case '${c.id}': observes $? but the source terminated before $? existed; the corpus case cannot mean what it says`);
      continue;
    }
    const valueShaped = c.observe === 'values' || c.observe === 'typeNames';
    const allNull = fixtureCase.outcome.values.every((v) => v === null);
    if (valueShaped && fixtureCase.outcome.errorCount > 0 && allNull && fixtureCase.outcome.objectCount > 0) {
      problems.push(
        `case '${c.id}': the reference implementation errored and produced only nulls ` +
          `(${String(fixtureCase.outcome.errors[0]?.['fullyQualifiedErrorId'])}). ` +
          'The corpus source is wrong, not the project.',
      );
      continue;
    }

    const explanation = explanationByCase.get(c.id) ?? null;
    if (c.probeKind === 'none') {
      results.push({
        id: c.id, command: c.command, area: c.area, outcome: 'unimplemented',
        expected: observe(fixtureCase.outcome, c.observe, c.id), actual: null,
        explainedBy: explanation?.id ?? null, explanationKind: explanation?.kind ?? null,
        detail: c.pending,
      });
      continue;
    }

    const probe = PROBES[c.probeKind];
    if (probe === undefined) {
      fail(`case '${c.id}': unknown probe kind '${c.probeKind}'. A typo must not become an 'unimplemented' claim.`);
      continue;
    }

    const expected = observe(fixtureCase.outcome, c.observe, c.id);
    let actual: unknown;
    let outcome: Outcome;
    let detail: string | null = null;
    try {
      actual = probe(c.probeArgs, `case '${c.id}'`);
      // error-category-known is the one probe whose answer depends on the
      // fixture: it asks whether the category the reference implementation
      // produced is a member of the union streams.ts declares.
      if (c.probeKind === 'error-category-known') {
        const category = String(expected);
        outcome = ERROR_CATEGORIES.includes(category) ? 'match' : 'difference';
        actual = ERROR_CATEGORIES.includes(category) ? category : `not in ErrorCategory union (${ERROR_CATEGORIES.length} members)`;
      } else {
        outcome = matches(expected, actual) ? 'match' : 'difference';
      }
    } catch (error) {
      if (error instanceof ConformanceInputError) throw error;
      outcome = 'error';
      actual = null;
      detail = (error as Error).message;
    }

    results.push({
      id: c.id, command: c.command, area: c.area, outcome, expected, actual,
      explainedBy: explanation?.id ?? null, explanationKind: explanation?.kind ?? null, detail,
    });
  }

  // Check every known-difference entry in BOTH directions. A stale suppression
  // is as bad as a missing one: it says a divergence exists when it does not,
  // and the next reader trusts it.
  const byId = new Map(results.map((r) => [r.id, r]));
  for (const entry of knownDifferences) {
    for (const caseId of entry.cases) {
      const result = byId.get(caseId);
      if (result === undefined) continue; // already reported as missing/stale above
      const wanted = entry.expect;
      const actualOutcome = result.outcome;
      const holds =
        (wanted === 'differs' && actualOutcome === 'difference') ||
        (wanted === 'matches' && actualOutcome === 'match') ||
        (wanted === 'unimplemented' && actualOutcome === 'unimplemented');
      if (!holds) {
        problems.push(
          `known-differences.yml '${entry.id}' expects case '${caseId}' to be '${wanted}', but it is '${actualOutcome}'. ` +
            'Either the behaviour changed and the entry is stale, or the entry was wrong.',
        );
      }
    }
  }

  for (const result of results) {
    if (result.outcome === 'difference' && result.explainedBy === null) {
      problems.push(
        `UNEXPLAINED DIFFERENCE in '${result.id}': pwsh ${canonical(result.expected)} vs this project ${canonical(result.actual)}. ` +
          'Fix it, or record it in known-differences.yml with a reason.',
      );
    }
    if (result.outcome === 'error') {
      problems.push(`case '${result.id}' threw while probing this project: ${result.detail ?? 'no message'}`);
    }
  }

  // Coverage. A command counts only when a real probe agreed with the reference
  // implementation, and a known-gap explanation never counts.
  const nativeSemantic = MANIFESTS.filter((m) => m.fidelity === 'native-semantic').map((m) => m.name);
  const perCommand = nativeSemantic.map((command) => {
    const own = results.filter((r) => r.command === command);
    const counts = { command, behavioural: 0, metadata: 0, unimplemented: 0, differences: 0 };
    for (const r of own) {
      if (r.outcome === 'unimplemented') counts.unimplemented++;
      else if (r.outcome === 'difference') counts.differences++;
      else if (r.outcome === 'match') {
        if (r.area === 'metadata') counts.metadata++;
        else counts.behavioural++;
      }
    }
    return counts;
  });

  const withBehaviour = perCommand.filter((c) => c.behavioural > 0).length;
  const withMetadata = perCommand.filter((c) => c.metadata > 0).length;
  const round1 = (n: number): number => Math.round(n * 10) / 10;

  const compared = results.filter((r) => r.outcome === 'match' || r.outcome === 'difference').length;
  const matched = results.filter((r) => r.outcome === 'match').length;
  const explainedDiffs = results.filter((r) => r.outcome === 'difference' && r.explainedBy !== null).length;
  const unexplainedDiffs = results.filter((r) => r.outcome === 'difference' && r.explainedBy === null).length;

  const cultureSensitive: string[] = [];
  for (const [id, fixtureCase] of fixture.cases) {
    if (fixtureCase.cultureFindings.some((f) => f['differs'] === true)) cultureSensitive.push(id);
  }

  return {
    engine: fixture.engine,
    capture: fixture.capture,
    fixtureCapturedAt: fixture.capturedAt,
    platformCaveat,
    totals: {
      cases: cases.length,
      compared,
      matched,
      differencesExplained: explainedDiffs,
      differencesUnexplained: unexplainedDiffs,
      unimplemented: results.filter((r) => r.outcome === 'unimplemented').length,
    },
    coverage: {
      nativeSemanticCommands: nativeSemantic.length,
      commandsWithBehaviouralEvidence: withBehaviour,
      behaviouralCoveragePercent: round1((withBehaviour / nativeSemantic.length) * 100),
      commandsWithMetadataEvidence: withMetadata,
      metadataCoveragePercent: round1((withMetadata / nativeSemantic.length) * 100),
    },
    perCommand,
    cultureSensitiveCases: cultureSensitive.sort(),
    knownDifferences: knownDifferences.map((k) => ({ id: k.id, kind: k.kind, expect: k.expect, cases: k.cases })),
    problems,
    cases: results,
  };
}

// ---------------------------------------------------------------------------
// cli
// ---------------------------------------------------------------------------

function render(report: ConformanceReport): string {
  const lines: string[] = [];
  const engine = report.engine;
  lines.push('');
  lines.push(`  PowerShell ${String(engine['psVersion'])} on ${String(engine['framework'])} (${String(engine['platform'])})`);
  lines.push(`  fixture captured ${report.fixtureCapturedAt}`);
  lines.push(
    `  width=${String(report.capture['renderWidth'])} culture=${String(report.capture['pinnedCulture'])} ` +
      `host=${String(report.capture['hostCulture'])} rendering=${String(report.capture['outputRendering'])}`,
  );
  lines.push('');
  const t = report.totals;
  lines.push(`  corpus ${t.cases} cases: ${t.matched} matched, ${t.differencesExplained} explained differences, ${t.differencesUnexplained} unexplained, ${t.unimplemented} unimplemented`);
  const c = report.coverage;
  lines.push('');
  lines.push(`  BEHAVIOURAL COVERAGE  ${c.commandsWithBehaviouralEvidence} / ${c.nativeSemanticCommands} native-semantic commands = ${c.behaviouralCoveragePercent}%`);
  lines.push(`  metadata coverage     ${c.commandsWithMetadataEvidence} / ${c.nativeSemanticCommands} = ${c.metadataCoveragePercent}%`);
  lines.push('');
  lines.push('  per command (behavioural / metadata / unimplemented / differences)');
  for (const row of report.perCommand) {
    const marker = row.behavioural > 0 ? 'v' : row.metadata > 0 ? '~' : ' ';
    lines.push(`    ${marker} ${row.command.padEnd(20)} ${row.behavioural}  ${row.metadata}  ${row.unimplemented}  ${row.differences}`);
  }
  if (report.cultureSensitiveCases.length > 0) {
    lines.push('');
    lines.push(`  culture-sensitive in the reference implementation: ${report.cultureSensitiveCases.join(', ')}`);
  }
  if (report.platformCaveat !== null) {
    lines.push('');
    lines.push('  CAVEAT');
    lines.push(`    ${report.platformCaveat}`);
  }
  lines.push('');
  lines.push('  known differences');
  for (const k of report.knownDifferences) {
    lines.push(`    ${k.kind.padEnd(10)} ${k.expect.padEnd(14)} ${k.id} (${k.cases.length} case${k.cases.length === 1 ? '' : 's'})`);
  }
  if (report.problems.length > 0) {
    lines.push('');
    lines.push(`  FAILED -- ${report.problems.length} problem(s):`);
    for (const p of report.problems) lines.push(`    ${p}`);
  }
  lines.push('');
  return lines.join('\n');
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const report = runConformance();
    const reportPath = join(REPO, 'tests/conformance/report.json');
    // Written so the site can display the number without re-running pwsh, and
    // so a reviewer can diff what changed between runs.
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(render(report));
    process.stdout.write(`  wrote ${relative(REPO, reportPath)}\n\n`);
    process.exit(report.problems.length > 0 ? 1 : 0);
  } catch (error) {
    process.stderr.write(`\n  conformance harness could not run: ${(error as Error).message}\n\n`);
    process.exit(2);
  }
}
