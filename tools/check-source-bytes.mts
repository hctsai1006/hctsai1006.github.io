/**
 * check-source-bytes.mts — refuse a source file that git has decided is binary.
 *
 * This exists because it happened three times from one cause, and nothing
 * noticed any of them.
 *
 * `src/commands/powershell/select-object.ts` shipped with a single raw NUL byte
 * at offset 7562, written as a join separator instead of an escape sequence.
 * Git treats any file containing a NUL as binary, and every consequence is
 * silent:
 *
 *   - GitHub renders "Binary file not shown", so 304 lines of a command
 *     implementation could not be reviewed in the pull request that added them
 *   - `git diff --numstat` reports `-`/`-`, so those lines were missing from
 *     that PR's own line count
 *   - `.gitattributes`'s `* text=auto eol=lf` does not apply to a binary file,
 *     so the LF determinism every `--check` here rests on had a hole exactly
 *     there
 *
 * An adversarial review found the first. A second appeared in
 * `src/commands/native/get-command.ts`, inside a template literal. The third
 * was in the first draft of THIS file, in the sentence describing the problem.
 * Three from one cause is a gate, not a fix.
 *
 * WHAT IT ASKS, and why not the obvious thing:
 *
 * The first draft read working-tree bytes and rejected any control character.
 * That was wrong: `core.autocrlf` is true on Windows, so every text file is
 * legitimately CRLF in the working tree, and the check fired on all 39 of them.
 * A CR on disk is not a defect — what matters is the blob git stores and shows
 * in a diff.
 *
 * So it asks git directly. `git ls-files --eol` reports, per file, the index
 * line ending and the `text` attribute. A file whose INDEX form is `-text` is
 * one git will treat as binary. Some of those are meant to be — images, and
 * `legacy/terminal-v1.html`, which `.gitattributes` declares `-text` on purpose
 * so the archive keeps its original CRLF. Those declare themselves, and show up
 * with `attr/-text`.
 *
 * The defect is the remaining case: a file git AUTO-DETECTED as binary, which
 * for a text-shaped path means it contains a NUL that nobody intended.
 *
 * Usage:
 *   node tools/check-source-bytes.mts
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Extensions whose contents a human is expected to read in a diff. */
const TEXT_EXTENSIONS = new Set([
  '.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json', '.md', '.html', '.css',
  '.yml', '.yaml', '.ps1', '.psm1', '.psd1', '.txt', '.sh', '.toml', '.xml', '.svg',
]);

interface Entry {
  path: string;
  /** The line ending of the blob in the index: `lf`, `crlf`, `mixed` or `-text`. */
  index: string;
  /** The `text` attribute git resolved, e.g. `text=auto`, `-text`, or empty. */
  attribute: string;
}

function listing(): readonly Entry[] {
  // -z: NUL-separated and unquoted. Without it git octal-escapes any non-ASCII
  // path and wraps it in quotes — this repository has several — so the paths
  // come back in a form that does not exist on disk.
  const listed = spawnSync('git', ['ls-files', '--eol', '-z'], { cwd: REPO, encoding: 'utf8' });
  if (listed.status !== 0) {
    process.stderr.write('\n  could not run `git ls-files --eol -z`\n\n');
    process.exit(2);
  }

  const entries: Entry[] = [];
  for (const record of (listed.stdout ?? '').split('\0')) {
    if (record.trim().length === 0) continue;
    // The attribute field can itself contain spaces — `attr/text=auto eol=lf` —
    // so the path is what follows the TAB, not what follows the last space. A
    // `\S*` for the attribute silently leaked `eol=lf` into the reported path.
    const tab = record.indexOf('\t');
    if (tab === -1) {
      process.stderr.write(`\n  could not parse a git ls-files record: ${JSON.stringify(record)}\n\n`);
      process.exit(3);
    }
    const head = record.slice(0, tab);
    const match = /^i\/(\S+)\s+w\/\S+\s+attr\/(.*)$/.exec(head.trim());
    if (match === null) {
      process.stderr.write(`\n  could not parse a git ls-files record: ${JSON.stringify(record)}\n\n`);
      process.exit(3);
    }
    entries.push({
      index: match[1] ?? '',
      attribute: (match[2] ?? '').trim(),
      path: record.slice(tab + 1),
    });
  }
  return entries;
}

const extensionOf = (path: string): string => {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  return dot > slash ? path.slice(dot).toLowerCase() : '';
};

function main(): void {
  if (process.argv.length > 2) {
    process.stderr.write(`\n  unexpected argument(s): ${process.argv.slice(2).join(', ')}\n\n`);
    process.exit(2);
  }

  const entries = listing();
  const offences = entries.filter(
    (e) =>
      e.index === '-text' &&
      // Not one that declares itself binary in .gitattributes.
      !e.attribute.includes('-text') &&
      TEXT_EXTENSIONS.has(extensionOf(e.path)),
  );

  if (offences.length > 0) {
    process.stderr.write('\n  git has decided these source files are binary:\n');
    for (const o of offences) process.stderr.write(`    ${o.path}\n`);
    process.stderr.write(
      '\n  That means a NUL byte, and it is not visible in review: the file shows as\n' +
        '  "Binary file not shown", its lines vanish from the change count, and\n' +
        '  .gitattributes stops normalising it. Write an escape, not the byte.\n' +
        '  Find it with:  grep -c . <file>   or   git ls-files --eol -- <file>\n\n',
    );
    process.exit(1);
  }

  const checked = entries.filter((e) => TEXT_EXTENSIONS.has(extensionOf(e.path))).length;
  process.stdout.write(`  ${checked} source files, none binary to git.\n`);
}

main();
