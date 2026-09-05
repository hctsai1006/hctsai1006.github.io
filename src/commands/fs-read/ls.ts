/**
 * ls — list directory contents, the coreutils one.
 *
 * NOT AN ALIAS FOR Get-ChildItem, and that is not an oversight. PowerShell on
 * Linux and macOS deliberately does NOT define `ls`, `cat`, `cp`, `mv`, `rm`,
 * `man`, `mount` or `ps` as aliases, precisely so the native executables run —
 * and `src/commands/manifests.json` records `ls` as its own command with no
 * aliases, alongside `Get-ChildItem` with `dir` and `gci`. Two separate entries,
 * two separate behaviours.
 *
 * So the reference implementation for THIS command is not pwsh. It is GNU
 * coreutils as v1 modelled it, and v1's `ls` is the specification the brief
 * names. Reproduced from `legacy/terminal-v1.html`:
 *
 *   flags     -l -a -A -h -1, and the long forms --all --almost-all
 *             --human-readable. Unknown long options are ignored, exactly as v1
 *             ignores them, rather than being rejected.
 *   target    the last operand that is not a flag; the working directory if none
 *   missing   "ls: cannot access '<t>': No such file or directory"
 *   a file    prints just its name, or one long row with -l
 *   ordering  plain `.sort()` — ORDINAL, not the culture-aware collation
 *             Get-ChildItem uses. That difference is real: `ls` shows
 *             `B.txt` before `a.txt` where `Get-ChildItem` shows `a.txt` first.
 *             GNU ls sorts by LC_COLLATE and would agree with the collation
 *             under a UTF-8 locale; v1 chose ordinal, v1 is the specification
 *             here, and the divergence is recorded rather than quietly fixed.
 *   -a        prepends `.` and `..`; -A keeps hidden entries but not those two
 *   layout    names joined by TWO spaces on one line, or one per line with -1
 *   -l        "total <blocks>", then mode links owner group size time name
 *
 * ONE DELIBERATE CHANGE FROM v1: the timestamp is rendered in UTC. v1 used
 * `new Date(ms)` and the host's local time, which makes the output of a test
 * depend on the runner's timezone. `psobject.ts` pins its collator for the same
 * reason, and a listing that changes when the laptop crosses a border is not
 * something a differential test can hold still.
 */

import { throwIfCancelled } from '../../pipeline/pipeline.ts';
import { formatMode } from '../../storage/index.ts';
import type { DirectoryEntry, FileStat } from '../../storage/index.ts';
import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import type { FileSystemPort } from '../ports.ts';
import {
  basename,
  commandError,
  dirname,
  emit,
  fsReadManifest,
  isHidden,
  nativeIdentity,
  requirePort,
  stripQuotes,
} from './support.ts';

const MANIFEST = fsReadManifest('ls');
const LS = nativeIdentity('ls');

/** coreutils: 0 ok, 2 for "serious trouble" such as a path that is not there. */
const EXIT_OK = 0;
const EXIT_SERIOUS = 2;

interface Flags {
  long: boolean;
  all: boolean;
  almostAll: boolean;
  human: boolean;
  one: boolean;
  target: string;
}

/**
 * v1's parser, character by character, including its quirks: a bundled `-lah`
 * is split, `--mode`-style long options nobody implemented are skipped rather
 * than rejected, and the LAST bare operand wins.
 */
function parseFlags(operands: readonly string[]): Flags {
  const flags: Flags = {
    long: false,
    all: false,
    almostAll: false,
    human: false,
    one: false,
    target: '',
  };
  for (const token of operands) {
    const text = stripQuotes(token);
    if (text.startsWith('--')) {
      if (text === '--all') flags.all = true;
      else if (text === '--almost-all') {
        flags.all = true;
        flags.almostAll = true;
      } else if (text === '--human-readable') flags.human = true;
      continue;
    }
    if (text.startsWith('-') && text.length > 1) {
      for (const character of text.slice(1)) {
        if (character === 'l') flags.long = true;
        else if (character === 'a') flags.all = true;
        else if (character === 'A') {
          flags.all = true;
          flags.almostAll = true;
        } else if (character === 'h') flags.human = true;
        else if (character === '1') flags.one = true;
      }
      continue;
    }
    flags.target = text;
  }
  return flags;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** v1's `lsTime`, read in UTC. `Sep  5 08:26`. */
function lsTime(ms: number): string {
  const date = new Date(ms);
  const month = MONTHS[date.getUTCMonth()] ?? 'Jan';
  const day = String(date.getUTCDate()).padStart(2, ' ');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  return `${month} ${day} ${hour}:${minute}`;
}

function humanSize(size: number, human: boolean): string {
  if (!human) return String(size);
  if (size >= 1048576) return `${(size / 1048576).toFixed(1)}M`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)}K`;
  return String(size);
}

function longRow(name: string, stat: FileStat, flags: Flags): readonly string[] {
  return [
    formatMode(stat.mode, stat.kind),
    String(stat.links),
    stat.owner,
    stat.group,
    humanSize(stat.size, flags.human),
    lsTime(stat.mtime),
    name,
  ];
}

/**
 * v1 pads the numeric columns to the right and the names to the left, using a
 * display-width function that counts a CJK character as two columns. That
 * function lives in `line-editor/metrics.ts` in this rewrite and is not imported
 * here: `ls` writes plain strings and the terminal measures them. Padding by
 * code-unit length is what a POSIX `ls` piped into a file does too.
 */
function padLeft(text: string, width: number): string {
  return text.padStart(width, ' ');
}
function padRight(text: string, width: number): string {
  return text.padEnd(width, ' ');
}

export const ls: CommandModule = {
  manifest: MANIFEST,

  async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
    const fs = await requirePort(context, LS);
    if (fs === null) return EXIT_SERIOUS;

    const flags = parseFlags(bound.remaining);
    const resolved = fs.resolve(flags.target === '' ? '.' : flags.target);
    if (!resolved.ok) {
      await context.streams.error.write(cannotAccess(flags.target, resolved.error.message));
      return EXIT_SERIOUS;
    }

    const stat = await fs.stat(resolved.value.full);
    if (!stat.ok) {
      await context.streams.error.write(
        cannotAccess(flags.target === '' ? resolved.value.full : flags.target, 'No such file or directory'),
      );
      return EXIT_SERIOUS;
    }

    // "ls -l <file> must give that file's long row, not just its name" — v1's
    // own comment, and the case a naive implementation gets wrong.
    if (stat.value.kind !== 'directory') {
      const name = basename(resolved.value.path);
      const text = flags.long ? longRow(name, stat.value, flags).join(' ') : name;
      await emit(context.streams.success, context.signal, text);
      return EXIT_OK;
    }

    const rows = await fs.readdir(resolved.value.full);
    if (!rows.ok) {
      await context.streams.error.write(
        cannotAccess(flags.target === '' ? resolved.value.full : flags.target, 'Permission denied'),
      );
      return EXIT_SERIOUS;
    }

    let names = rows.value.map((entry) => entry.name).sort();
    if (!flags.all) names = names.filter((name) => !isHidden(name));
    else if (!flags.almostAll) names = ['.', '..', ...names];
    if (names.length === 0) return EXIT_OK;

    const statFor = await resolveStats(fs, resolved.value.full, rows.value, names, stat.value);

    if (!flags.long) {
      if (flags.one) {
        for (const name of names) {
          if (!(await emit(context.streams.success, context.signal, name))) return EXIT_OK;
        }
        return EXIT_OK;
      }
      await emit(context.streams.success, context.signal, names.join('  '));
      return EXIT_OK;
    }

    const table = names.map((name) => longRow(name, statFor.get(name) ?? stat.value, flags));
    const widthOf = (index: number): number =>
      table.reduce((widest, row) => Math.max(widest, (row[index] ?? '').length), 0);
    const linkWidth = widthOf(1);
    const ownerWidth = widthOf(2);
    const groupWidth = widthOf(3);
    const sizeWidth = widthOf(4);

    const blocks = names.reduce(
      (total, name) => total + Math.ceil((statFor.get(name)?.size ?? 0) / 1024),
      0,
    );
    if (!(await emit(context.streams.success, context.signal, `total ${String(blocks)}`))) {
      return EXIT_OK;
    }
    for (const row of table) {
      throwIfCancelled(context.signal, 'ls');
      const text =
        `${row[0] ?? ''} ${padLeft(row[1] ?? '', linkWidth)} ` +
        `${padRight(row[2] ?? '', ownerWidth)} ${padRight(row[3] ?? '', groupWidth)} ` +
        `${padLeft(row[4] ?? '', sizeWidth)} ${row[5] ?? ''} ${row[6] ?? ''}`;
      if (!(await emit(context.streams.success, context.signal, text))) return EXIT_OK;
    }
    return EXIT_OK;
  },
};

/** `.` is this directory and `..` is its parent — both need a real stat for -l. */
async function resolveStats(
  fs: FileSystemPort,
  full: string,
  entries: readonly DirectoryEntry[],
  names: readonly string[],
  self: FileStat,
): Promise<ReadonlyMap<string, FileStat>> {
  const map = new Map<string, FileStat>(entries.map((entry) => [entry.name, entry.stat]));
  if (names.includes('.')) map.set('.', self);
  if (names.includes('..')) {
    const parent = await fs.stat(dirname(full));
    map.set('..', parent.ok ? parent.value : self);
  }
  return map;
}

function cannotAccess(target: string, reason: string): ReturnType<typeof commandError> {
  return commandError(
    LS,
    `ls: cannot access '${target}': ${reason}`,
    'CannotAccess',
    'ObjectNotFound',
    'System.IO.IOException',
    target,
  );
}
