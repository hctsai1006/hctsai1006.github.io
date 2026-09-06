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
import type { ResolvedPath } from '../../storage/vfs.ts';
import { FileSystemProvider, providerRelativePath } from '../../providers/index.ts';
import type { ProviderItem, ProviderRegistry } from '../../providers/index.ts';
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
  filterNotSupportedError,
  fsReadManifest,
  hasWildcard,
  isHidden,
  matchesAny,
  namedParameterNotFoundError,
  providerNotSupportedError,
  providerTargets,
  requirePort,
  resolveTargets,
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
 * The two things every filter here asks about an item.
 *
 * A `DirectoryEntry` used to be the parameter type, and it is one member too
 * many: `-File`, `-Directory`, `-Filter`, `-Include`, `-Exclude`, `-Hidden` and
 * `-Force` all read a NAME and a CONTAINER FLAG, which is exactly what a
 * `ProviderItem` carries and exactly what a session-state item can supply.
 * Narrowing it is what lets the flat-drive listing below reuse these predicates
 * instead of restating them.
 */
interface Filterable {
  readonly name: string;
  readonly isContainer: boolean;
}

/**
 * The same question for a target the PATH itself matched.
 *
 * `-Include`/`-Exclude` are applied here because rule 5 says they are effective
 * exactly when the path was globbed; a literal path takes the other branch and
 * never reaches this.
 */
function acceptsTarget(target: Target, options: Options): boolean {
  return accepts(
    { name: target.stat.name, isContainer: target.stat.kind === 'directory' },
    options,
  );
}

/** Does one entry survive `-Filter`, `-Include`, `-Exclude`, `-File`, `-Directory`? */
function accepts(entry: Filterable, options: Options): boolean {
  if (options.filesOnly && entry.isContainer) return false;
  if (options.directoriesOnly && !entry.isContainer) return false;
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
function visible(entry: Filterable, options: Options): boolean {
  const hidden = isHidden(entry.name);
  if (options.hiddenOnly) return hidden;
  return options.force || !hidden;
}

interface Walker {
  /**
   * The FileSystem provider, over the same brokered port the command was
   * handed.
   *
   * Constructed by the command rather than taken from `context.providers`, and
   * that is deliberate: it is the same class the registry holds, over the same
   * port, and building one costs a field write. Taking it from the registry
   * would have meant a null branch — "no registry, so read the directory the
   * old way" — and that branch is a SECOND implementation of "list one level of
   * a directory", which is the drift this PR exists to remove. There is one
   * now, in `FileSystemProvider.getChildItems`, and it is the only place the
   * directories-first ordering rule is written.
   */
  readonly provider: FileSystemProvider;
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

async function emitEntry(walker: Walker, entry: ProviderItem): Promise<boolean> {
  const value: PSValue = walker.options.nameOnly
    ? relativeName(walker.base, entry.path.path)
    : entry.value;
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

  // ONE level, already ordered directories-first-then-collated, from the
  // FileSystem provider. Note 1's ordering rule lives there and nowhere else.
  const rows = await walker.provider.getChildItems(directory);
  if (!rows.ok) {
    await walker.context.streams.error.write(
      storageErrorRecord(GET_CHILDITEM, rows.error, directory.full, IDS),
    );
    return true;
  }

  const entries = rows.value.filter((e) => visible(e, walker.options));
  const mayDescend = walker.options.recurse && depth < walker.options.maxDepth;

  if (walker.options.immediateDescent) {
    // Note 3: each child directory is entered the moment it is reached. Because
    // directories sort first, the deepest match comes out before the current
    // directory's own files — which is what produced `aa\aaa\a2.txt | aa\a1.txt`.
    for (const entry of entries) {
      if (walker.context.signal.aborted) return false;
      if (accepts(entry, walker.options)) {
        if (!(await emitEntry(walker, entry))) return false;
      }
      if (entry.isContainer && mayDescend) {
        if (!(await walk(walker, entry.path, depth + 1))) return false;
      }
    }
    return true;
  }

  // Note 2: everything at this level first...
  for (const entry of entries) {
    if (!accepts(entry, walker.options)) continue;
    if (!(await emitEntry(walker, entry))) return false;
  }
  // ...and only then down, in the same order.
  if (!mayDescend) return true;
  for (const entry of entries) {
    if (!entry.isContainer) continue;
    if (!(await walk(walker, entry.path, depth + 1))) return false;
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
    // See `Walker.provider` for why this is built here rather than read off
    // `context.providers`.
    const provider = new FileSystemProvider(fs);

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

      const registry = context.providers;
      const resolvedOnce = fs.resolve(raw);
      if (registry !== null && resolvedOnce.ok && registry.handles(resolvedOnce.value.drive)) {
        const outcome = await listProviderDrive(
          context,
          registry,
          resolvedOnce.value,
          raw,
          literal !== undefined,
          options,
          parameters,
        );
        if (!outcome.keepGoing) return outcome.exitCode;
        continue;
      }

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
        const walker: Walker = { provider, context, options, base: target.resolved.path };

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

/**
 * `Get-ChildItem` on a drive that is not the filesystem — the acceptance
 * criterion `Get-ChildItem Env:/ works`.
 *
 * IT IS NOT THE WALK ABOVE WITH A DIFFERENT READDIR, and that is the point of
 * the whole PR. MEASURED against pwsh 7.6.5 on `Env:`:
 *
 *   -Recurse        NO-OP. 107 items with it, 107 without. A flat provider has
 *                   nothing to descend into, so notes 2 and 3 above — which are
 *                   entirely about traversal order — describe nothing here.
 *   -Depth          REFUSED: NotSupported, "Provider operation stopped because
 *                   the provider does not support the 'Depth' parameter."
 *   -Filter         REFUSED: NotSupported, "Cannot call method. The provider
 *                   does not support the use of filters." FileSystem is the
 *                   only provider whose Capabilities include Filter.
 *   -File -Directory -Hidden -Attributes
 *                   REFUSED: NamedParameterNotFound. They are FileSystem
 *                   dynamic parameters and do not exist on a flat drive.
 *   -Include        binds, and is INERT with a literal path — count 0, exactly
 *                   the filesystem's rule 5.
 *   -Exclude -Force -Name -Recurse
 *                   all bind and behave.
 *   -LiteralPath Env:zzTp on a LEAF
 *                   returns the LEAF ITSELF, count 1. Not empty, not an error.
 *
 * The error message names a THIRD path form, which is why `displayPath` is a
 * parameter of `storageErrorRecord` rather than a rule inside it:
 *
 *   Get-ChildItem Env:zzNoSuch      "Cannot find path 'zzNoSuch' ..."
 *   Get-ChildItem Env:zzLeaf/more   "Cannot find path 'zzLeaf/more' ..."
 *
 * — the provider-internal path, with NO drive on it, where `Get-Item` prints
 * `Env:/zzNoSuch` and `Set-Location` prints what was typed.
 */
async function listProviderDrive(
  context: InvocationContext,
  registry: ProviderRegistry,
  resolved: ResolvedPath,
  raw: string,
  literal: boolean,
  options: Options,
  parameters: BindingResult['parameters'],
): Promise<{ keepGoing: boolean; exitCode: number }> {
  for (const absent of ['File', 'Directory', 'Hidden'] as const) {
    if (isBound(parameters, absent)) {
      await context.streams.error.write(namedParameterNotFoundError(GET_CHILDITEM, absent));
      return { keepGoing: false, exitCode: 1 };
    }
  }
  if (isBound(parameters, 'Depth')) {
    await context.streams.error.write(
      providerNotSupportedError(
        GET_CHILDITEM,
        "Provider operation stopped because the provider does not support the 'Depth' parameter.",
      ),
    );
    return { keepGoing: false, exitCode: 1 };
  }
  if (options.filter !== undefined && !registry.supports(resolved.drive, 'Filter')) {
    await context.streams.error.write(filterNotSupportedError(GET_CHILDITEM));
    return { keepGoing: false, exitCode: 1 };
  }

  const targets = await providerTargets(registry, resolved, literal);
  if (!targets.ok) {
    await context.streams.error.write(
      // The provider-internal path; see the header.
      storageErrorRecord(GET_CHILDITEM, targets.error, providerRelativePath(resolved), IDS),
    );
    return { keepGoing: true, exitCode: 0 };
  }

  // A container is listed; a leaf IS the answer. Same rule as the filesystem's
  // rule 9, minus the recursion a flat provider cannot do.
  const rows: ProviderItem[] = [];
  for (const target of targets.value) {
    if (!target.isContainer) {
      rows.push(target);
      continue;
    }
    const children = await registry.childItems(target.path);
    if (!children.ok) {
      await context.streams.error.write(
        storageErrorRecord(GET_CHILDITEM, children.error, providerRelativePath(target.path), IDS),
      );
      continue;
    }
    rows.push(...children.value);
  }

  // Rule 5, measured on `Env:` as well as on the filesystem: `-Include` with a
  // literal path matches nothing at all.
  const includeIsInert =
    options.include !== undefined && !literal && !hasWildcard(raw) && !options.recurse;
  if (includeIsInert) return { keepGoing: true, exitCode: 0 };

  for (const row of rows) {
    // `accepts`, the SAME predicate the filesystem walk uses — which is why its
    // parameter was narrowed from DirectoryEntry to a name and a container
    // flag. Re-spelling `-Filter`/`-Include`/`-Exclude` here would be a third
    // copy of one rule, and would silently ignore `-Filter` the day a provider
    // declares the Filter capability.
    //
    // NO HIDDEN RULE, though, and that is measured rather than an omission. A
    // leading dot is the FileSystem provider's hiding rule and nothing else's:
    //
    //   pwsh: Set-Item 'Env:.zzDot' 'v'
    //         Get-ChildItem Env:          ->  .zzDot IS listed
    //         Get-ChildItem Env: -Force   ->  .zzDot, same count
    //
    // The first version of this loop called `visible()` as well and would have
    // made a dot-named environment variable invisible without -Force.
    if (!accepts(row, options)) continue;
    const value: PSValue = options.nameOnly ? row.name : row.value;
    if (!(await emit(context.streams.success, context.signal, value))) {
      return { keepGoing: false, exitCode: 0 };
    }
  }
  return { keepGoing: true, exitCode: 0 };
}

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
