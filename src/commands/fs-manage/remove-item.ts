/**
 * remove-item.ts — `Remove-Item`, and the five aliases pwsh gives it.
 *
 * This is the command `filesystem.delete` exists for. Deleting is the one
 * mistake that cannot be taken back, the port re-checks the grant on EVERY
 * call, and this command walks a tree one node at a time — so a grant dropped
 * half way through a recursive delete stops it half way through, which is the
 * behaviour `ports.ts` says the per-call check is for.
 *
 * ── WHAT THE PROBE CHANGED ────────────────────────────────────────────────
 *
 * Every line below was measured against pwsh 7.6.5 on Win32NT before it was
 * written. Six assumptions did not survive:
 *
 *  1. `-Force` DOES NOT SUPPRESS A MISSING PATH. `rm -f` ignores ENOENT;
 *     `Remove-Item -Force` does not. Measured: both with and without `-Force`,
 *     a path that does not exist reports
 *     `PathNotFound` / ObjectNotFound / ItemNotFoundException. So `-Force` is
 *     NOT mapped to `RemoveOptions.force`, whose documented meaning ("a missing
 *     path succeeds instead of ENOENT") is the opposite of what pwsh does. `rm`
 *     maps it; this does not. Getting that backwards would make
 *     `Remove-Item typo.txt -Force` silently succeed.
 *
 *  2. `-Force` DOES NOT IMPLY `-Recurse`. Measured: `Remove-Item <non-empty dir>
 *     -Force` fails exactly as it does without `-Force`. v1 treats the two as
 *     interchangeable (`!(argOf(a,'Recurse')||argOf(a,'Force'))`); that is a v1
 *     divergence and is not reproduced.
 *
 *  3. A NON-EMPTY DIRECTORY WITHOUT `-Recurse` IS NOT AN ERROR IN PowerShell —
 *     it is a `ShouldContinue` prompt. Under `-NonInteractive` the prompt
 *     failing becomes `InvalidOperation` / PSInvalidOperationException, and the
 *     directory survives. `storage/types.ts` recorded this; the probe confirms
 *     it, and adds that `-Confirm:$false` does NOT suppress it either —
 *     `-Confirm` governs ShouldProcess, and this is ShouldContinue.
 *
 *  4. `Remove-Item` HAS NO `-PassThru`. Measured:
 *     `(Get-Command Remove-Item).Parameters.ContainsKey('PassThru')` is False,
 *     and `-PassThru` reports NamedParameterNotFound. It emits NOTHING, ever;
 *     `@(Remove-Item $f).Count` is 0 and the result is `$null`.
 *
 *  5. A WILDCARD THAT MATCHES NOTHING IS SILENT. `Remove-Item *.nomatch`
 *     reports no error at all, with or without `-Force`. A LITERAL path that
 *     does not exist is `PathNotFound`. So "no such file" is a property of how
 *     the path was written, not of the filesystem — and `-LiteralPath '*.log'`
 *     looks for a file actually named `*.log` and reports PathNotFound.
 *
 *  6. A WILDCARD WHOSE PARENT DOES NOT EXIST reports PathNotFound naming the
 *     PARENT, not the pattern: `Remove-Item /nope/*.log` says
 *     `Cannot find path '/nope' because it does not exist.`
 *
 * Two more, which shape the error table below:
 *
 *   - removing the CURRENT directory is refused:
 *     `Cannot remove the item at '<path>' because it is in use.`,
 *     InvalidOperation, and the location does not move. v1 deletes it and
 *     bounces the prompt back to HOME; that is a v1 divergence, and pwsh's
 *     refusal is reproduced because the alternative leaves `$PWD` pointing at
 *     nothing — this project's `VirtualFileSystem` does not move the location
 *     when its directory is removed (measured: `stat('.')` then reports ENOENT).
 *   - two paths where one is missing: the good one is removed, ONE error is
 *     written, and the command continues. Errors are per item.
 *
 * ── THREE DECLARED DIVERGENCES ────────────────────────────────────────────
 *
 *   MESSAGE FOR THE UNPROMPTABLE DIRECTORY. pwsh says "PowerShell is in
 *   NonInteractive mode. Read and Prompt functionality is not available." The
 *   id and the category are reproduced exactly; the sentence is not, because
 *   this engine has no interactive mode to be outside of, and `Remove-Item`
 *   does not declare `ui.dialog` — it cannot prompt at all. Repeating pwsh's
 *   wording would describe a mode that does not exist here. The replacement
 *   says the true reason and echoes v1's guidance line.
 *
 *   `-Force` IS ACCEPTED AND DOES NOTHING. In pwsh it clears the read-only
 *   attribute. Deletion here depends on WRITE on the parent directory, which is
 *   a POSIX mode bit that no switch may change — a `-Force` that granted
 *   permission would be a privilege escalation dressed as a convenience.
 *
 *   WILDCARDS MATCH THE LAST COMPONENT ONLY, and match case-SENSITIVELY. pwsh
 *   expands one in ANY component — measured, a pattern with a star as its
 *   middle segment removed the file — and matches case-insensitively on NTFS;
 *   the emulated machine is Linux and this backend's lookup is exact
 *   (`children.get(segment)`), so case-insensitive matching would find files
 *   that the same path could not otherwise address. A wildcard anywhere but the
 *   last component is refused by name rather than silently misread.
 *
 * `-Filter`, `-Include`, `-Exclude`, `-Stream` and `-Credential` are declared
 * by the reference implementation and are NOT implemented. They are refused
 * rather than ignored: silently dropping `-Include '*.txt'` from
 * `Remove-Item .\* -Include '*.txt'` would delete every other file in the
 * directory, which is the worst possible way to be incomplete.
 */

import { throwIfCancelled } from '../../pipeline/pipeline.ts';
import type { DirectoryEntry, StorageError } from '../../storage/index.ts';
import { isDescendant, joinPath } from '../../storage/index.ts';
import type { CommandModule, InvocationContext } from '../invocation.ts';
import type { CommandManifest } from '../manifest.ts';
import type { FileSystemPort } from '../ports.ts';
import { hasWildcard, isBound, stringArray, switchValue, wildcardPattern } from '../powershell/support.ts';
import {
  EXIT_FAILURE,
  EXIT_SUCCESS,
  fsManageCommand,
  needFileSystem,
  removeTree,
  strerror,
  writeError,
} from './support.ts';

/** What pwsh raises for a path that resolved to nothing. Measured. */
const ITEM_NOT_FOUND = 'System.Management.Automation.ItemNotFoundException';
/** What pwsh raises when the prompt it needed was not available. Measured. */
const INVALID_OPERATION = 'System.Management.Automation.PSInvalidOperationException';
/** What pwsh raises for the read-only/permission refusal. Measured. */
const IO_EXCEPTION = 'System.IO.IOException';

/**
 * Parameters the reference implementation declares and this does not implement.
 * Refused, not ignored — see the header.
 */
const UNIMPLEMENTED_PARAMETERS = ['Filter', 'Include', 'Exclude', 'Stream', 'Credential'] as const;

// ---------------------------------------------------------------------------
// errors, each with the id and category read off pwsh 7.6.5
// ---------------------------------------------------------------------------

async function pathNotFound(
  context: InvocationContext,
  manifest: CommandManifest,
  path: string,
): Promise<void> {
  await writeError(context, manifest, {
    message: `Cannot find path '${path}' because it does not exist.`,
    errorId: 'PathNotFound',
    category: 'ObjectNotFound',
    exceptionType: ITEM_NOT_FOUND,
    target: path,
  });
}

/**
 * Map a `StorageError` from `remove`, `stat` or `readdir` onto the record pwsh
 * writes for the same condition.
 *
 * The mapping is this command's, not the storage layer's, exactly as
 * `storage/types.ts` argues: the same ENOENT is `PathNotFound` here and
 * `NewItemIOError` in `New-Item`, and a shared table would have to be wrong for
 * one of them.
 */
async function storageFailure(
  context: InvocationContext,
  manifest: CommandManifest,
  path: string,
  error: StorageError,
): Promise<void> {
  if (error.code === 'ENOENT') {
    await pathNotFound(context, manifest, path);
    return;
  }
  if (error.code === 'EACCES') {
    // pwsh's own sentence names Windows attributes ("hidden, system, or read
    // only") that this filesystem does not have. The id and category are its;
    // the sentence is .NET's UnauthorizedAccessException wording, which is also
    // what v1 printed for this case.
    await writeError(context, manifest, {
      message: `Access to the path '${path}' is denied.`,
      errorId: 'RemoveFileSystemItemUnAuthorizedAccess',
      category: 'PermissionDenied',
      exceptionType: IO_EXCEPTION,
      target: path,
    });
    return;
  }
  await writeError(context, manifest, {
    message: `Cannot remove the item at '${path}': ${strerror(error)}.`,
    errorId: 'RemoveItemIOError',
    category: 'WriteError',
    exceptionType: IO_EXCEPTION,
    target: path,
  });
}

// ---------------------------------------------------------------------------
// wildcard expansion
// ---------------------------------------------------------------------------

interface Expansion {
  /**
   * The items to act on.
   *
   * EMPTY IS A LEGAL, SILENT OUTCOME, and that is the whole reason expansion is
   * separated from removal: measured, a pattern that matched nothing reports no
   * error at all, while a literal path that matched nothing is PathNotFound.
   */
  readonly targets: readonly string[];
  /** Set when expansion itself failed and has already written to stream 2. */
  readonly failed: boolean;
}

const NOTHING: Expansion = { targets: [], failed: false };

/**
 * Turn one `-Path` argument into the items it names.
 *
 * `-LiteralPath` skips this entirely: measured, `-LiteralPath '*.log'` looks
 * for a file whose name is literally `*.log` and reports PathNotFound.
 */
async function expand(
  context: InvocationContext,
  manifest: CommandManifest,
  fs: FileSystemPort,
  spec: string,
): Promise<Expansion> {
  if (!hasWildcard(spec)) return { targets: [spec], failed: false };

  const cut = spec.lastIndexOf('/');
  const parent = cut === -1 ? '.' : spec.slice(0, cut) || '/';
  const leaf = cut === -1 ? spec : spec.slice(cut + 1);

  if (hasWildcard(parent)) {
    await writeError(context, manifest, {
      message:
        `Cannot expand '${spec}': a wildcard is supported in the last path component only. ` +
        'PowerShell expands one in any component; this engine does not, and refuses rather ' +
        'than quietly removing something else.',
      errorId: 'WildcardNotSupportedInPathComponent',
      category: 'NotImplemented',
      exceptionType: 'System.NotImplementedException',
      target: spec,
    });
    return { targets: [], failed: true };
  }

  const listing = await fs.readdir(parent);
  if (!listing.ok) {
    // Measured: the error names the PARENT, not the pattern.
    await storageFailure(context, manifest, listing.error.path, listing.error);
    return { targets: [], failed: true };
  }

  // Case-SENSITIVE: the emulated machine is Linux and this backend's lookup is
  // exact. See the header.
  const pattern = wildcardPattern(leaf, true);
  const matched = listing.value
    .filter((entry: DirectoryEntry) => pattern.test(entry.name))
    .map((entry: DirectoryEntry) => joinPath(cut === -1 ? '' : parent, entry.name))
    // readdir returns the backend's own order; a delete that reports its
    // failures in a different order on every run cannot be tested.
    .sort();

  if (matched.length === 0) return NOTHING;
  return { targets: matched, failed: false };
}

// ---------------------------------------------------------------------------
// the removal itself
// ---------------------------------------------------------------------------

/** Remove one already-resolved item. Returns false when something was written to stream 2. */
async function removeOne(
  context: InvocationContext,
  manifest: CommandManifest,
  fs: FileSystemPort,
  spec: string,
  recurse: boolean,
): Promise<boolean> {
  const stat = await fs.stat(spec);
  if (!stat.ok) {
    await storageFailure(context, manifest, stat.error.path, stat.error);
    return false;
  }

  const target = stat.value.path;
  const here = fs.location.path;
  if (target === here || isDescendant(here, target)) {
    // Measured verbatim from pwsh 7.6.5.
    await writeError(context, manifest, {
      message: `Cannot remove the item at '${target}' because it is in use.`,
      errorId: 'InvalidOperation',
      category: 'InvalidOperation',
      exceptionType: INVALID_OPERATION,
      target,
    });
    return false;
  }

  if (stat.value.kind === 'directory' && !recurse) {
    const listing = await fs.readdir(target);
    if (!listing.ok) {
      await storageFailure(context, manifest, listing.error.path, listing.error);
      return false;
    }
    if (listing.value.length > 0) {
      // pwsh PROMPTS here; with no prompt available it reports
      // InvalidOperation and leaves the directory alone. Same id, same
      // category, a sentence that is true of this engine. See the header.
      await writeError(context, manifest, {
        message:
          `The item at '${target}' has children and the Recurse parameter was not specified. ` +
          'Remove-Item cannot ask here, so nothing was removed. Use -Recurse to remove the ' +
          'directory and everything in it.',
        errorId: 'InvalidOperation',
        category: 'InvalidOperation',
        exceptionType: INVALID_OPERATION,
        target,
      });
      return false;
    }
  }

  // The RESOLVED path, not what was typed: every path the walk reports — into
  // the audit log, and into the cancellation message — has to be one a person
  // can look up afterwards from wherever they now are.
  const outcome = await removeTree(fs, target, stat.value.kind === 'directory', context.signal);

  if (outcome.failure !== null) {
    await storageFailure(context, manifest, outcome.failure.path, outcome.failure.error);
    return false;
  }
  if (outcome.cancelledAt !== null) {
    await writeError(context, manifest, {
      message:
        `The removal of '${target}' was stopped after ${String(outcome.removed)} ` +
        `item${outcome.removed === 1 ? '' : 's'}. '${outcome.cancelledAt}' and everything ` +
        'above it are still there; everything below it is gone.',
      errorId: 'RemoveItemStopped',
      category: 'OperationStopped',
      exceptionType: 'System.Management.Automation.PipelineStoppedException',
      target,
    });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// the command
// ---------------------------------------------------------------------------

export const removeItem: CommandModule = fsManageCommand(
  'remove-item',
  async (context, bound, manifest) => {
    const fs = await needFileSystem(context, manifest);
    if (fs === null) return EXIT_FAILURE;

    for (const name of UNIMPLEMENTED_PARAMETERS) {
      if (!isBound(bound.parameters, name)) continue;
      await writeError(context, manifest, {
        message:
          `-${name} is declared by PowerShell 7.6.5 and is not implemented here. It is ` +
          'refused rather than ignored: a filter that silently did nothing would remove ' +
          'every item the filter was there to protect.',
        errorId: 'ParameterNotImplemented',
        category: 'NotImplemented',
        exceptionType: 'System.NotImplementedException',
        target: name,
      });
      return EXIT_FAILURE;
    }

    const literal = isBound(bound.parameters, 'LiteralPath');
    const specs = literal
      ? stringArray(bound.parameters, 'LiteralPath')
      : stringArray(bound.parameters, 'Path');

    if (specs === undefined || specs.length === 0) {
      // The binder normally reports this first; the message is pwsh's own,
      // measured, and v1 printed the same sentence.
      await writeError(context, manifest, {
        message:
          'Cannot process command because of one or more missing mandatory parameters: Path.',
        errorId: 'MissingMandatoryParameter',
        category: 'InvalidArgument',
        exceptionType: 'System.Management.Automation.ParameterBindingException',
      });
      return EXIT_FAILURE;
    }

    const recurse = switchValue(bound.parameters, 'Recurse');
    // `-Force` is read so that binding it is not silently meaningless, and is
    // deliberately not passed to the storage layer. See divergence 1.
    void switchValue(bound.parameters, 'Force');

    let failed = false;
    for (const spec of specs) {
      throwIfCancelled(context.signal, manifest.display);

      const expansion = literal
        ? ({ targets: [spec], failed: false } satisfies Expansion)
        : await expand(context, manifest, fs, spec);

      if (expansion.failed) {
        failed = true;
        continue;
      }
      // Measured: a pattern that matched nothing is silent. A literal path that
      // matched nothing is PathNotFound, which `removeOne` reports from `stat`.
      for (const target of expansion.targets) {
        if (!(await removeOne(context, manifest, fs, target, recurse))) failed = true;
      }
    }

    // Measured: Remove-Item emits nothing, and has no -PassThru to make it.
    return failed ? EXIT_FAILURE : EXIT_SUCCESS;
  },
);
