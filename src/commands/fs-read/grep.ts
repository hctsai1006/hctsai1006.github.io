/**
 * grep — print lines that match patterns.
 *
 * Its own command in `manifests.json`, and NOT a spelling of `Select-String`.
 * The two disagree on the thing users notice first:
 *
 *   GNU grep      is CASE SENSITIVE by default; -i / --ignore-case opts out
 *   Select-String is CASE INSENSITIVE by default; -CaseSensitive opts in
 *
 * both measured — `Select-String -Pattern 'gamma'` matches the line `Gamma
 * alpha` in pwsh 7.6.5, and v1's grep builds its RegExp with no `i` flag unless
 * a flag asks for one. Making one an alias of the other would silently change
 * the answer.
 *
 * v1 is the specification, and these are its rules:
 *
 *   no pattern        ->  usage, two lines
 *   pattern > 200     ->  "grep: pattern too long"
 *   invalid regex     ->  "grep: invalid regular expression"
 *   WITH a file       ->  matching lines, verbatim and untruncated
 *                         "grep: <f>: No such file or directory"
 *                         "grep: <f>: Is a directory"
 *   WITHOUT a file    ->  walks the WHOLE TREE from the root and prints
 *                         "<path>: <line>", truncating the line at 56
 *                         characters and stopping after 20 hits
 *
 * That last rule is unusual enough to be worth stating plainly: bare `grep foo`
 * greps the entire filesystem, not the working directory, and caps its output.
 * It is what v1 does, it is what the archived terminal's users saw, and it is
 * the reason this command respects `context.signal` on every directory it
 * enters — a whole-tree walk is exactly the thing Ctrl+C has to be able to stop.
 *
 * Exit codes are GNU's: 0 when something matched, 1 when nothing did, 2 on an
 * error. v1 had no exit codes at all — every command returned rows — so these
 * are new, and they are the coreutils ones rather than invented.
 */

import { throwIfCancelled } from '../../pipeline/pipeline.ts';
import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import type { FileSystemPort } from '../ports.ts';
import {
  commandError,
  emit,
  fsReadManifest,
  nativeIdentity,
  requirePort,
  sortDirectoryEntries,
  splitLines,
  stripQuotes,
} from './support.ts';

const MANIFEST = fsReadManifest('grep');
const GREP = nativeIdentity('grep');

const EXIT_MATCHED = 0;
const EXIT_NO_MATCH = 1;
const EXIT_ERROR = 2;

/** v1's caps, both of them. */
const PATTERN_LIMIT = 200;
const LINE_LIMIT = 56;
const HIT_LIMIT = 20;

export const grep: CommandModule = {
  manifest: MANIFEST,

  async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
    const operands = bound.remaining
      .filter((token) => !token.startsWith('-'))
      .map(stripQuotes);
    const pattern = operands[0];
    const fileArgument = operands[1];

    if (pattern === undefined || pattern === '') {
      await emit(
        context.streams.success,
        context.signal,
        'Usage: grep [OPTION]... PATTERNS [FILE]...',
      );
      await emit(context.streams.success, context.signal, "Try 'grep --help' for more information.");
      return EXIT_ERROR;
    }
    if (pattern.length > PATTERN_LIMIT) {
      await context.streams.error.write(
        commandError(GREP, 'grep: pattern too long', 'PatternTooLong', 'InvalidArgument'),
      );
      return EXIT_ERROR;
    }

    // v1's flag test, reproduced exactly: `--ignore-case`, or a short cluster
    // containing `i`. It deliberately does not accept `-I`.
    const ignoreCase = bound.remaining.some(
      (token) => token === '--ignore-case' || (/^-[A-Za-z]*i/u.test(token) && !token.startsWith('--')),
    );

    let regexp: RegExp;
    try {
      // No `u` flag: see select-string.ts. These are POSIX-ish patterns and `u`
      // rejects constructs that work.
      regexp = new RegExp(pattern, ignoreCase ? 'i' : '');
    } catch {
      await context.streams.error.write(
        commandError(GREP, 'grep: invalid regular expression', 'InvalidRegex', 'InvalidArgument'),
      );
      return EXIT_ERROR;
    }

    const fs = await requirePort(context, GREP);
    if (fs === null) return EXIT_ERROR;

    if (fileArgument !== undefined) {
      return grepOneFile(fs, context, regexp, fileArgument);
    }
    return grepWholeTree(fs, context, regexp);
  },
};

async function grepOneFile(
  fs: FileSystemPort,
  context: InvocationContext,
  regexp: RegExp,
  fileArgument: string,
): Promise<number> {
  const resolved = fs.resolve(fileArgument);
  if (!resolved.ok) {
    await context.streams.error.write(diagnostic(fileArgument, 'No such file or directory'));
    return EXIT_ERROR;
  }
  const stat = await fs.stat(resolved.value.full);
  if (!stat.ok) {
    await context.streams.error.write(
      diagnostic(
        fileArgument,
        stat.error.code === 'EACCES' ? 'Permission denied' : 'No such file or directory',
      ),
    );
    return EXIT_ERROR;
  }
  if (stat.value.kind === 'directory') {
    await context.streams.error.write(diagnostic(fileArgument, 'Is a directory'));
    return EXIT_ERROR;
  }
  const text = await fs.readText(resolved.value.full);
  if (!text.ok) {
    await context.streams.error.write(diagnostic(fileArgument, 'Permission denied'));
    return EXIT_ERROR;
  }

  let matched = false;
  for (const line of splitLines(text.value)) {
    throwIfCancelled(context.signal, 'grep');
    // v1 tests `if(t && re.test(t))`, so an EMPTY line never matches — not even
    // against a pattern like `^$` that a real grep would match. Reproduced
    // rather than corrected: these commands are held to v1, and a silent
    // improvement here would be an unannounced change in behaviour.
    if (line === '' || !regexp.test(line)) continue;
    matched = true;
    if (!(await emit(context.streams.success, context.signal, line))) return EXIT_MATCHED;
  }
  return matched ? EXIT_MATCHED : EXIT_NO_MATCH;
}

/**
 * The whole-tree walk. Depth-first from the root, in the listing order
 * `Get-ChildItem` uses, capped at 20 hits.
 *
 * `throwIfCancelled` on every directory AND the `emit` return value are both
 * load-bearing: this is the one command here that can touch every file in the
 * store, and it must stop when the user says so.
 */
async function grepWholeTree(
  fs: FileSystemPort,
  context: InvocationContext,
  regexp: RegExp,
): Promise<number> {
  let hits = 0;

  const walk = async (path: string): Promise<boolean> => {
    throwIfCancelled(context.signal, 'grep');
    const rows = await fs.readdir(path);
    // v1 walks its own in-memory tree and cannot be refused; here a directory
    // the user may not read contributes nothing and the walk continues, which
    // is what GNU grep -r does without -s.
    if (!rows.ok) return true;

    for (const entry of sortDirectoryEntries(rows.value)) {
      if (hits >= HIT_LIMIT) return false;
      const child = path === '/' ? `/${entry.name}` : `${path}/${entry.name}`;
      if (entry.stat.kind === 'directory') {
        if (!(await walk(child))) return false;
        continue;
      }
      const text = await fs.readText(child);
      if (!text.ok) continue;
      for (const line of splitLines(text.value)) {
        if (line === '' || !regexp.test(line)) continue;
        const shown = line.length > LINE_LIMIT ? `${line.slice(0, LINE_LIMIT)}...` : line;
        if (!(await emit(context.streams.success, context.signal, `${child}: ${shown}`))) {
          return false;
        }
        hits += 1;
        if (hits >= HIT_LIMIT) return false;
      }
    }
    return true;
  };

  await walk('/');
  return hits > 0 ? EXIT_MATCHED : EXIT_NO_MATCH;
}

function diagnostic(target: string, reason: string): ReturnType<typeof commandError> {
  return commandError(
    GREP,
    `grep: ${target}: ${reason}`,
    reason === 'Permission denied' ? 'PermissionDenied' : 'CannotOpen',
    reason === 'Permission denied' ? 'PermissionDenied' : 'ObjectNotFound',
    'System.IO.IOException',
    target,
  );
}
