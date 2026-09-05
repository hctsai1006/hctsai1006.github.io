/**
 * generate-width-table.mts — regenerate the East Asian Width table in
 * `src/line-editor/cells.ts` from the Unicode Character Database.
 *
 * WHY THIS EXISTS. `src/line-editor/cells.ts` derives everything it can from
 * Unicode property escapes, which the JavaScript engine already carries: a
 * combining mark is `\p{Mn}`, an enclosing mark is `\p{Me}`, a format character
 * is `\p{Cf}`. Those need no table and cannot go stale.
 *
 * East_Asian_Width is the exception. It is NOT a supported property escape —
 * `/\p{East_Asian_Width=Wide}/u` is a SyntaxError, not a silent mismatch — so
 * the Wide and Fullwidth ranges have to be carried as data. A hand-typed table
 * is the maintenance trap this repository has already been bitten by: nobody
 * can tell a transcription slip from a deliberate entry, and nobody can bring
 * it forward to the next Unicode release. So the table is GENERATED, from a
 * verbatim extract of the UCD, and both halves are checked in.
 *
 * The same applies to Hangul_Syllable_Type. A conjoining jamo vowel (V) or
 * trailing consonant (T) occupies no cell of its own — it composes into the
 * syllable block opened by the leading consonant (L), so `L V T` is one
 * two-cell syllable and not three characters. That property is not a property
 * escape either, and the jamo are `Lo`, not marks, so nothing else catches
 * them.
 *
 * PROVENANCE. The inputs are verbatim line subsets of the UCD, checked in under
 * `tests/unit/fixtures/`, each keeping the original file's own header lines so
 * the version, date and copyright travel with the data. They are reproducible:
 *
 *     curl -O https://www.unicode.org/Public/16.0.0/ucd/EastAsianWidth.txt
 *     { sed -n '1,10p' EastAsianWidth.txt
 *       grep -E '^[0-9A-F]+(\.\.[0-9A-F]+)?\s*;\s*[WF]\s' EastAsianWidth.txt
 *     } > tests/unit/fixtures/EastAsianWidth-16.0.0.W-F.txt
 *
 *     curl -O https://www.unicode.org/Public/16.0.0/ucd/HangulSyllableType.txt
 *     { sed -n '1,10p' HangulSyllableType.txt
 *       grep -E '^[0-9A-F]+(\.\.[0-9A-F]+)?\s*;\s*[VT]\s' HangulSyllableType.txt
 *     } > tests/unit/fixtures/HangulSyllableType-16.0.0.V-T.txt
 *
 * WHY 16.0.0 AND NOT LATEST. `process.versions.unicode` on the Node this repo
 * requires is 16.0, and the property escapes above come from that same version.
 * Mixing a 17.0 width table with 16.0 escapes would mean a character could be
 * Wide by the table and unassigned by the engine, which is a disagreement with
 * no correct answer. The table version follows the engine's, deliberately.
 *
 * USAGE
 *   node tools/generate-width-table.mts --check   # fail if the table is stale
 *   node tools/generate-width-table.mts --write   # rewrite the generated block
 *
 * `tests/unit/cell-width.test.mts` re-derives the same ranges from the same fixtures
 * with its own parser and asserts the module agrees, so the gate does not
 * depend on anyone remembering to run this.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(REPO, 'src', 'line-editor', 'cells.ts');
const FIXTURES = join(REPO, 'tests', 'unit', 'fixtures');

const BEGIN = '// --- BEGIN GENERATED: tools/generate-width-table.mts ---';
const END = '// --- END GENERATED ---';

export interface Range {
  readonly lo: number;
  readonly hi: number;
}

/**
 * Read `RANGE ; VALUE # comment` lines, keeping the ones whose value is wanted.
 *
 * Every UCD data file shares this shape, so one parser reads both inputs. The
 * comment is cut before the split, because a `#` comment routinely contains a
 * semicolon and splitting first would silently mangle those lines.
 */
export function parseUCD(text: string, wanted: ReadonlySet<string>): Range[] {
  const out: Range[] = [];
  for (const raw of text.split('\n')) {
    const line = (raw.split('#')[0] ?? '').trim();
    if (line === '') continue;
    const fields = line.split(';');
    const cps = (fields[0] ?? '').trim();
    const value = (fields[1] ?? '').trim();
    if (!wanted.has(value)) continue;
    const ends = cps.split('..');
    const lo = Number.parseInt(ends[0] ?? '', 16);
    const hi = Number.parseInt(ends[1] ?? ends[0] ?? '', 16);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      throw new Error(`unparsable UCD range: ${raw}`);
    }
    out.push({ lo, hi });
  }
  if (out.length === 0) throw new Error(`no lines matched ${[...wanted].join('/')}`);
  return out;
}

/** Sort and coalesce, so `[[1,2],[3,4]]` becomes `[[1,4]]` and lookups shorten. */
export function mergeRanges(ranges: readonly Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.lo - b.lo);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && r.lo <= last.hi + 1) {
      out[out.length - 1] = { lo: last.lo, hi: Math.max(last.hi, r.hi) };
    } else {
      out.push(r);
    }
  }
  return out;
}

/** The Wide and Fullwidth ranges of Unicode 16.0.0, merged. */
export function wideRanges(): Range[] {
  const text = readFileSync(join(FIXTURES, 'EastAsianWidth-16.0.0.W-F.txt'), 'utf8');
  return mergeRanges(parseUCD(text, new Set(['W', 'F'])));
}

/** The conjoining jamo vowel and trailing ranges of Unicode 16.0.0, merged. */
export function jamoVTRanges(): Range[] {
  const text = readFileSync(join(FIXTURES, 'HangulSyllableType-16.0.0.V-T.txt'), 'utf8');
  return mergeRanges(parseUCD(text, new Set(['V', 'T'])));
}

const hex = (n: number): string => `0x${n.toString(16).padStart(4, '0')}`;

/** Flat `lo, hi, lo, hi` pairs, wrapped at a readable width. */
function emit(ranges: readonly Range[], perLine = 6): string {
  const lines: string[] = [];
  for (let i = 0; i < ranges.length; i += perLine) {
    const chunk = ranges.slice(i, i + perLine);
    lines.push('  ' + chunk.map((r) => `${hex(r.lo)}, ${hex(r.hi)},`).join(' '));
  }
  return lines.join('\n');
}

function block(): string {
  const wide = wideRanges();
  const bmp = wide.filter((r) => r.hi < 0x10000);
  const astral = wide.filter((r) => r.hi >= 0x10000);
  const jamo = jamoVTRanges();
  if (bmp.length + astral.length !== wide.length) {
    throw new Error('a Wide range straddles the BMP boundary; the split below would drop it');
  }
  return [
    BEGIN,
    '',
    '/**',
    ' * East_Asian_Width = Wide or Fullwidth, Unicode 16.0.0, as flat `lo, hi` pairs.',
    ' *',
    ' * Split at the BMP boundary because the two halves are searched differently:',
    ' * the BMP half seeds a direct lookup table, the astral half is bisected.',
    ' */',
    `const WIDE_BMP: readonly number[] = [ // ${bmp.length} ranges`,
    emit(bmp),
    '];',
    '',
    `const WIDE_ASTRAL: readonly number[] = [ // ${astral.length} ranges`,
    emit(astral),
    '];',
    '',
    '/**',
    ' * Hangul_Syllable_Type = V or T, Unicode 16.0.0: the conjoining jamo that',
    ' * compose into a preceding syllable block instead of opening one.',
    ' */',
    `const JAMO_VT: readonly number[] = [ // ${jamo.length} ranges`,
    emit(jamo),
    '];',
    '',
    END,
  ].join('\n');
}

/**
 * Compare and write in LF, whatever is on disk.
 *
 * `core.autocrlf` is true on Windows and `.gitattributes` normalises to LF in
 * the index, so the same commit is CRLF in one working tree and LF in another.
 * Without this, `--check` on a fresh Windows checkout compares a CRLF file
 * against an LF-generated block and reports the table stale when it is
 * identical — a gate that cries wolf gets switched off, which is the failure
 * this repository's test runner exists to prevent one level up.
 */
const lf = (text: string): string => text.replace(/\r\n/g, '\n');

function main(): void {
  const mode = process.argv[2] ?? '--check';
  const source = lf(readFileSync(TARGET, 'utf8'));
  const start = source.indexOf(BEGIN);
  const stop = source.indexOf(END);
  if (start === -1 || stop === -1) {
    process.stderr.write(`  ${TARGET} has no generated block; expected ${BEGIN}\n`);
    process.exit(2);
  }
  const next = source.slice(0, start) + block() + source.slice(stop + END.length);
  if (mode === '--write') {
    if (next === source) {
      process.stdout.write('  width table already current\n');
      return;
    }
    writeFileSync(TARGET, next);
    process.stdout.write('  wrote src/line-editor/cells.ts\n');
    return;
  }
  if (next !== source) {
    process.stderr.write(
      '\n  src/line-editor/cells.ts is stale against the checked-in UCD extracts.\n' +
        '  Run: node tools/generate-width-table.mts --write\n\n',
    );
    process.exit(1);
  }
  process.stdout.write('  width table matches the UCD extracts\n');
}

if (import.meta.filename === process.argv[1]) main();
