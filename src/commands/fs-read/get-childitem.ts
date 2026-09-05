/**
 * Get-ChildItem (dir, gci) — list a directory.
 *
 * WHAT THE PROBE CORRECTED, in the order the surprises arrived. Every one of
 * these would have been implemented wrongly from first principles:
 *
 * 1. THE ORDER IS DIRECTORIES FIRST, THEN FILES, EACH COLLATED — not one
 *    alphabetical run. In a directory holding the dirs `a`, `M` and the files
 *    `_u.txt 1.txt a-b.txt a.txt ab.txt B.txt C.txt Z.txt`:
 *
 *      pwsh: a | M | _u.txt | 1.txt | a-b.txt | a.txt | ab.txt | B.txt | C.txt | Z.txt
 *
 *    The file run is neither ordinal nor natural; see `compareNames`.
 *
 * 2. `-Recurse` DOES NOT WALK DEPTH-FIRST. It emits ALL of a directory's
 *    children, and only then descends into each child directory in turn:
 *
 *      pwsh: aa | bb | root.txt | aa\aaa | aa\a1.txt | aa\aaa\a2.txt | bb\b1.txt
 *
 *    A textbook pre-order DFS would have produced `aa | aa\aaa | ...` — which is
 *    what `-Include`/`-Exclude` produce, see 3.
 *
 * 3. `-Include` AND `-Exclude` CHANGE THE TRAVERSAL, not just the filter. With
 *    either present, the walk descends into a child directory the moment it
 *    reaches it, before emitting its own sibling files. Same tree:
 *
 *      pwsh: Get-ChildItem -Include *.txt -Recurse
 *            ->  aa\aaa\a2.txt | aa\a1.txt | bb\b1.txt | root.txt
 *      pwsh: Get-ChildItem -Exclude *.txt -Recurse
 *            ->  aa | aa\aaa | bb
 *
 *    Both fall out of one rule — immediate descent — and `-Filter` does NOT
 *    trigger it (`-Filter *.txt -Recurse` keeps the order in 2). A wildcard in
 *    `-Path` reaches the same walk by a different route; see note 9.
 *
 * 4. `-Name` IGNORES ALL OF THAT and always uses the order in 2, even with
 *    `-Include`. Measured twice.
 *
 * 5. `-Include` WITHOUT A WILDCARD IN `-Path` MATCHES NOTHING AT ALL:
 *
 *      pwsh: Get-ChildItem -Include *.txt        ->  nothing
 *      pwsh: Get-ChildItem * -Include *.txt      ->  the four .txt files
 *      pwsh: Get-ChildItem -Include *.txt -Recurse -> six files
 *
 *    `-Exclude` has no such rule, which makes the pair look broken and is
 *    exactly what pwsh does.
 *
 * 6. `-Depth` IMPLIES `-Recurse`. `-Depth 1` with no `-Recurse` recursed one
 *    level; `-Depth 0` listed only the immediate children.
 *
 * 7. A WILDCARD THAT MATCHES NOTHING IS NOT AN ERROR (`zz*` -> no output, no
 *    error), while a literal name that does not exist is `PathNotFound`.
 *
 * 8. `-File -Directory` together emits NOTHING rather than everything.
 *
 * 9. A WILDCARD PATH NAMES ITEMS; A LITERAL PATH NAMES A DIRECTORY TO LIST. The
 *    same directory comes out two different ways:
 *
 *      pwsh: Get-ChildItem 'sub'   ->  sub\deeper | sub\inner.txt
 *      pwsh: Get-ChildItem 's*'    ->  sub
 *      pwsh: Get-ChildItem 'em*'   ->  emptydir | empty.txt
 *      pwsh: Get-ChildItem 'sub/*' ->  sub\deeper | sub\inner.txt
 *
 *    with ONE exception, which is the reason rule 5 exists at all: a last
 *    segment that is exactly `*` means the PARENT DIRECTORY. `Get-ChildItem '*'`
 *    and `Get-ChildItem` produce byte-identical output, and so do their
 *    `-Recurse` forms — including the `-Include` ordering quirk:
 *
 *      pwsh: Get-ChildItem '*' -Recurse
 *            ->  emptydir | sub | alpha.txt | ... | sub\deeper | sub\inner.txt
 *                | sub\deeper\deep.txt          (the breadth order of rule 2)
 *      pwsh: Get-ChildItem 's*' -Recurse
 *            ->  sub\deeper | sub\deeper\deep.txt | sub\inner.txt
 *                                               (immediate descent, and `sub`
 *                                                itself is NOT emitted)
 *
 *    Those two look contradictory until `*` is read as "the parent". Then both
 *    fall out: `'*'` is a directory listing, `'s*'` is a matched container whose
 *    contents -Recurse expands with immediate descent.
 */

import { throwIfCancelled } from '../../pipeline/pipeline.ts';
import type { PSValue } from '../../pipeline/psobject.ts';
import type { DirectoryEntry } from '../../storage/index.ts';
import type { ResolvedPath } from '../../storage/vfs.ts';
import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import type { FileSystemPort } from '../ports.ts';
import {
  isBound,
  numberValue,
  stringArray,
  stringValue,
  switchValue,
} from '../powershell/support.ts';
import {
  GET_CHILDITEM,
  commandError,
  emit,
  fileSystemInfo,
  fsReadManifest,
  hasWildcard,
  isHidden,
  matchesAny,
  requirePort,
  resolveTargets,
  sortDirectoryEntries,
  storageErrorRecord,
} from './support.ts';
import type { FsErrorIds, Target } from './support.ts';

const MANIFEST = fsReadManifest('get-childitem');

/**
 * pwsh gives the same condition a different id here than Get-Content does:
 *
 *   pwsh: Get-ChildItem <directory with a Deny ACE>
 *         -> DirUnauthorizedAccessError,...GetChildItemCommand, PermissionDenied
 */
export const GET_CHILDITEM_ERROR_IDS: FsErrorIds = {
  notFound: 'PathNotFound',
  accessDenied: 'DirUnauthorizedAccessError',
};
const IDS = GET_CHILDITEM_ERROR_IDS;

interface Options {
  readonly filter: string | undefined;
  readonly include: readonly string[] | undefined;
  readonly exclude: readonly string[] | undefined;
  readonly force: boolean;
  readonly hiddenOnly: boolean;
  readonly filesOnly: boolean;
  readonly directoriesOnly: boolean;
  readonly recurse: boolean;
  readonly maxDepth: number;
  readonly nameOnly: boolean;
  /** Descend into a child directory as soon as it is reached. See note 3. */
  readonly immediateDescent: boolean;
}

/**
 * The same question for a target the PATH itself matched.
 *
 * `-Include`/`-Exclude` are applied here because rule 5 says they are effective
 * exactly when the path was globbed; a literal path takes the other branch and
 * never reaches this.
 */
function acceptsTarget(target: Target, options: Options): boolean {
  return accepts({ name: target.stat.name, stat: target.stat }, options);
}

/** Does one entry survive `-Filter`, `-Include`, `-Exclude`, `-File`, `-Directory`? */
function accepts(entry: DirectoryEntry, options: Options): boolean {
  const isDirectory = entry.stat.kind === 'directory';
  if (options.filesOnly && isDirectory) return false;
  if (options.directoriesOnly && !isDirectory) return false;
  if (options.filter !== undefined && !matchesAny(entry.name, [options.filter])) return false;
  if (options.include !== undefined && !matchesAny(entry.name, options.include)) return false;
  if (options.exclude !== undefined && matchesAny(entry.name, options.exclude)) return false;
  return true;
}

/**
 * Is this entry visible without `-Force`?
 *
 * `-Hidden` inverts the question rather than widening it — measured:
 *
 *   pwsh: Get-ChildItem -Hidden          ->  .hidden, and nothing else
 *   pwsh: Get-ChildItem -Hidden -Force   ->  .hidden, and nothing else
 */
function visible(entry: DirectoryEntry, options: Options): boolean {
  const hidden = isHidden(entry.name);
  if (options.hiddenOnly) return hidden;
  return options.force || !hidden;
}

interface Walker {
  readonly fs: FileSystemPort;
  readonly context: InvocationContext;
  readonly options: Options;
  /** The path the `-Name` output is relative to. */
  readonly base: string;
}

/** `sub/deeper/deep.txt`, relative to the directory the listing started at. */
function relativeName(base: string, path: string): string {
  if (path.startsWith(`${base}/`)) return path.slice(base.length + 1);
  if (base === '/' && path.startsWith('/')) return path.slice(1);
  return path;
}

function childPath(parent: ResolvedPath, name: string): ResolvedPath {
  const path = parent.path === '/' ? `/${name}` : `${parent.path}/${name}`;
  const full = parent.full.endsWith('/') ? `${parent.full}${name}` : `${parent.full}/${name}`;
  return { drive: parent.drive, path, full, clampedAtRoot: false };
}

async function emitEntry(
  walker: Walker,
  parent: ResolvedPath,
  entry: DirectoryEntry,
): Promise<boolean> {
  const resolved = childPath(parent, entry.name);
  const value: PSValue = walker.options.nameOnly
    ? relativeName(walker.base, resolved.path)
    : fileSystemInfo(entry.stat, resolved);
  return emit(walker.context.streams.success, walker.context.signal, value);
}

/**
 * List one directory, recursing as `-Recurse`/`-Depth` allow.
 *
 * Returns false once the consumer has walked away or the user cancelled, so a
 * ten-thousand-entry recursive listing stops at the first Ctrl+C rather than
 * finishing into a dead channel.
 */
async function walk(walker: Walker, directory: ResolvedPath, depth: number): Promise<boolean> {
  throwIfCancelled(walker.context.signal, 'Get-ChildItem');

  const rows = await walker.fs.readdir(directory.full);
  if (!rows.ok) {
    await walker.context.streams.error.write(
      storageErrorRecord(GET_CHILDITEM, rows.error, directory.full, IDS),
    );
    return true;
  }

  const entries = sortDirectoryEntries(rows.value).filter((e) => visible(e, walker.options));
  const mayDescend = walker.options.recurse && depth < walker.options.maxDepth;

  if (walker.options.immediateDescent) {
    // Note 3: each child directory is entered the moment it is reached. Because
    // directories sort first, the deepest match comes out before the current
    // directory's own files — which is what produced `aa\aaa\a2.txt | aa\a1.txt`.
    for (const entry of entries) {
      if (walker.context.signal.aborted) return false;
      const isDirectory = entry.stat.kind === 'directory';
      if (accepts(entry, walker.options)) {
        if (!(await emitEntry(walker, directory, entry))) return false;
      }
      if (isDirectory && mayDescend) {
        if (!(await walk(walker, childPath(directory, entry.name), depth + 1))) return false;
      }
    }
    return true;
  }

  // Note 2: everything at this level first...
  for (const entry of entries) {
    if (!accepts(entry, walker.options)) continue;
    if (!(await emitEntry(walker, directory, entry))) return false;
  }
  // ...and only then down, in the same order.
  if (!mayDescend) return true;
  for (const entry of entries) {
    if (entry.stat.kind !== 'directory') continue;
    if (!(await walk(walker, childPath(directory, entry.name), depth + 1))) return false;
  }
  return true;
}

/** A path argument that names a FILE emits that file. Measured. */
async function emitTarget(walker: Walker, target: Target): Promise<boolean> {
  const value: PSValue = walker.options.nameOnly
    ? target.stat.name
    : fileSystemInfo(target.stat, target.resolved);
  return emit(walker.context.streams.success, walker.context.signal, value);
}

/**
 * Rule 9: a last segment of exactly `*` means the PARENT DIRECTORY.
 *
 * Returns the path to treat as a literal directory, or null when the argument
 * is an ordinary wildcard whose matches are the answer.
 */
function trailingStarParent(raw: string): string | null {
  const cut = raw.lastIndexOf('/');
  if (cut === -1) return raw === '*' ? '.' : null;
  if (raw.slice(cut + 1) !== '*') return null;
  const parent = raw.slice(0, cut);
  return parent === '' ? '/' : parent;
}

export const getChildItem: CommandModule = {
  manifest: MANIFEST,

  async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
    const parameters = bound.parameters;
    const fs = await requirePort(context, GET_CHILDITEM);
    if (fs === null) return 1;

    // Attributes/-ReadOnly/-System/-FollowSymlink describe things this storage
    // does not have: a Windows flags enum, two Windows-only attribute bits and
    // symbolic links, which `storage/types.ts` says do not exist here. Saying so
    // is better than accepting the switch and ignoring it, which would make a
    // filtered listing silently wrong.
    for (const unsupported of ['Attributes', 'ReadOnly', 'System', 'FollowSymlink'] as const) {
      if (isBound(parameters, unsupported)) {
        await context.streams.error.write(
          commandError(
            GET_CHILDITEM,
            `-${unsupported} is not implemented: this filesystem stores POSIX mode bits and has ` +
              'no Windows file attributes and no symbolic links. Use -Force, -File, -Directory ' +
              'or -Hidden instead.',
            'ParameterNotImplemented',
            'NotImplemented',
            'System.NotImplementedException',
          ),
        );
        return 1;
      }
    }

    const literal = stringArray(parameters, 'LiteralPath');
    const given = literal ?? stringArray(parameters, 'Path');
    const paths = given === undefined || given.length === 0 ? ['.'] : given;

    const include = stringArray(parameters, 'Include');
    const exclude = stringArray(parameters, 'Exclude');
    const depthGiven = numberValue(parameters, 'Depth');
    const anyPathIsWildcard = literal === undefined && paths.some(hasWildcard);

    const options: Options = {
      filter: stringValue(parameters, 'Filter'),
      include,
      exclude,
      force: switchValue(parameters, 'Force') || switchValue(parameters, 'Hidden'),
      hiddenOnly: switchValue(parameters, 'Hidden'),
      filesOnly: switchValue(parameters, 'File'),
      directoriesOnly: switchValue(parameters, 'Directory'),
      // Note 6: -Depth implies -Recurse.
      recurse: switchValue(parameters, 'Recurse') || depthGiven !== undefined,
      maxDepth: depthGiven ?? Number.POSITIVE_INFINITY,
      nameOnly: switchValue(parameters, 'Name'),
      // Note 3 and note 4. A globbed path ALSO descends immediately, but that
      // case is handled where the glob is resolved (note 9) rather than here,
      // because a trailing `*` is the exception that does not.
      immediateDescent:
        !switchValue(parameters, 'Name') && (include !== undefined || exclude !== undefined),
    };

    // Note 5: -Include with a literal -Path matches nothing. Not an error, and
    // not a filter that happens to reject everything either — pwsh simply
    // produces no output, and reproducing it as "no output" keeps the reason
    // visible instead of burying it in the matcher.
    const includeIsInert =
      include !== undefined && !anyPathIsWildcard && !options.recurse && literal === undefined;

    for (const raw of paths) {
      throwIfCancelled(context.signal, 'Get-ChildItem');

      // Rule 9. `*` collapses to its parent, which turns the argument back into
      // an ordinary directory listing; anything else with a wildcard names
      // ITEMS, and the items are the answer.
      const parentOfStar = literal === undefined ? trailingStarParent(raw) : null;
      const effective = parentOfStar ?? raw;
      const namesItems = literal === undefined && parentOfStar === null && hasWildcard(raw);

      const targets =
        literal === undefined
          ? await resolveTargets(fs, context, GET_CHILDITEM, effective, {
              force: options.force,
              ids: IDS,
            })
          : await literalTarget(fs, context, effective);

      for (const target of targets) {
        if (includeIsInert) continue;
        const walker: Walker = { fs, context, options, base: target.resolved.path };

        if (target.stat.kind !== 'directory') {
          // A matched file is the answer whichever way the path was written.
          if (namesItems && !acceptsTarget(target, options)) continue;
          if (!(await emitTarget(walker, target))) return 0;
          continue;
        }

        if (namesItems) {
          // A container the wildcard matched. Without -Recurse it IS the answer;
          // with -Recurse its contents are, expanded by immediate descent, and
          // the container itself is not emitted.
          if (!options.recurse) {
            if (!acceptsTarget(target, options)) continue;
            if (!(await emitTarget(walker, target))) return 0;
            continue;
          }
          const descending: Walker = { ...walker, options: { ...options, immediateDescent: true } };
          if (!(await walk(descending, target.resolved, 0))) return 0;
          continue;
        }

        if (!(await walk(walker, target.resolved, 0))) return 0;
      }
    }
    return 0;
  },
};

/** `-LiteralPath` skips globbing entirely; a `*` in the name is a `*` in the name. */
async function literalTarget(
  fs: FileSystemPort,
  context: InvocationContext,
  raw: string,
): Promise<readonly Target[]> {
  const resolved = fs.resolve(raw);
  if (!resolved.ok) {
    await context.streams.error.write(
      storageErrorRecord(GET_CHILDITEM, resolved.error, raw, IDS),
    );
    return [];
  }
  const stat = await fs.stat(resolved.value.full);
  if (!stat.ok) {
    await context.streams.error.write(
      storageErrorRecord(GET_CHILDITEM, stat.error, resolved.value.full, IDS),
    );
    return [];
  }
  return [{ raw, resolved: resolved.value, stat: stat.value }];
}
