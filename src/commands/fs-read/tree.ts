/**
 * tree — list a directory as a tree.
 *
 * v1 is the specification; there is no pwsh cmdlet to measure against, and the
 * `tree.com` that ships with Windows draws a different shape from GNU `tree`.
 * Reproduced from `legacy/terminal-v1.html`, including the parts that are not
 * GNU tree's:
 *
 *   header      the working directory, on its own first line
 *   connectors  "├── " for every entry but the last, "└── " for the last
 *   spine       "│   " under a non-last directory, four spaces under the last
 *   ordering    directories first, then files, each by LOWER-CASED name — not
 *               the culture-aware collation Get-ChildItem uses, and not the
 *               ordinal sort `ls` uses. Three commands, three orderings, all
 *               three taken from the thing each one is modelled on.
 *   hidden      SHOWN. v1 walks every key; GNU tree hides dot-entries without
 *               -a. v1's behaviour is what the archived terminal did.
 *   depth       three levels. v1 recurses only while its prefix is shorter than
 *               eight characters, and the prefix grows by four per level, so the
 *               walk descends from depth 0 and 1 and stops at 2 — entries at
 *               depth 3 are printed, their children are not.
 *
 * GNU tree's trailing "N directories, M files" summary is NOT printed, because
 * v1 does not print it and inventing a count nobody asked for would be the kind
 * of small embellishment that makes the rest less trustworthy.
 */

import { throwIfCancelled } from '../../pipeline/pipeline.ts';
import type { DirectoryEntry } from '../../storage/index.ts';
import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import { commandError, emit, fsReadManifest, nativeIdentity, requirePort, stripQuotes } from './support.ts';

const MANIFEST = fsReadManifest('tree');
const TREE = nativeIdentity('tree');

const EXIT_OK = 0;
const EXIT_ERROR = 1;

/** v1's `prefix.length < 8`, spelled as what it means. */
const MAX_PREFIX = 8;
const INDENT = 4;

function v1Order(entries: readonly DirectoryEntry[]): readonly DirectoryEntry[] {
  return [...entries].sort((a, b) => {
    const rank = (entry: DirectoryEntry): number => (entry.stat.kind === 'directory' ? 0 : 1);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    // v1's comparator, verbatim: a lower-cased less-than that never returns 0.
    return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
  });
}

export const tree: CommandModule = {
  manifest: MANIFEST,

  async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
    const fs = await requirePort(context, TREE);
    if (fs === null) return EXIT_ERROR;

    // v1's `tree` takes no operand and always lists the working directory. A
    // path is accepted here because typing one is the obvious thing to do and
    // ignoring it would be a silent surprise; with none, the behaviour is v1's.
    const operand = bound.remaining.filter((token) => !token.startsWith('-')).map(stripQuotes)[0];
    const start = fs.resolve(operand ?? '.');
    if (!start.ok) {
      await context.streams.error.write(
        commandError(
          TREE,
          `${operand ?? '.'} [error opening dir]`,
          'CannotOpen',
          'ObjectNotFound',
          'System.IO.IOException',
          operand ?? '.',
        ),
      );
      return EXIT_ERROR;
    }

    if (!(await emit(context.streams.success, context.signal, start.value.full))) return EXIT_OK;

    const walk = async (path: string, prefix: string): Promise<boolean> => {
      throwIfCancelled(context.signal, 'tree');
      const rows = await fs.readdir(path);
      if (!rows.ok) return true;

      const entries = v1Order(rows.value);
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (entry === undefined) continue;
        const last = index === entries.length - 1;
        const text = `${prefix}${last ? '└── ' : '├── '}${entry.name}`;
        if (!(await emit(context.streams.success, context.signal, text))) return false;

        if (entry.stat.kind === 'directory' && prefix.length < MAX_PREFIX) {
          const child = path === '/' ? `/${entry.name}` : `${path}/${entry.name}`;
          if (!(await walk(child, prefix + (last ? ' '.repeat(INDENT) : '│   ')))) return false;
        }
      }
      return true;
    };

    await walk(start.value.full, '');
    return EXIT_OK;
  },
};
