/**
 * rm.ts — the GNU tool, which is NOT `Remove-Item` with a different name.
 *
 * ── WHY THIS IS A SEPARATE COMMAND AT ALL ─────────────────────────────────
 *
 * In real pwsh 7.6.5 `rm` IS an alias of Remove-Item — measured:
 * `Get-Alias -Definition Remove-Item` reports del, erase, rd, ri, rm, rmdir.
 * v1 deliberately does not do that. It models a Linux box where the PowerShell
 * aliases for native tools are removed (its own seeded `profile.ps1` says so in
 * as many words: "Linux 上 ls/cat/rm 這些別名被拿掉了,原生指令會直接跑"), so
 * `rm` is `Application`, not `Alias`, and behaves like coreutils. The generated
 * `manifests.json` records that: `rm` is its own entry with
 * `parameterSource: 'none'`, and `remove-item`'s alias list is del/erase/rd/ri/
 * rmdir WITHOUT rm. Adding `rm` as an alias here would make `registry.ts` throw
 * on a name collision, which is the mechanism working.
 *
 * So the two commands answer to two different reference implementations, and
 * both were measured:
 *
 *   Remove-Item   pwsh 7.6.5 on Win32NT
 *   rm            GNU coreutils 8.32
 *
 * ── WHAT GNU rm 8.32 ACTUALLY DOES ────────────────────────────────────────
 *
 *   rm                        rm: missing operand
 *                             Try 'rm --help' for more information.      exit 1
 *   rm -f                     (silent)                                   exit 0
 *   rm nope                   rm: cannot remove 'nope': No such file …   exit 1
 *   rm -f nope                (silent)                                   exit 0
 *   rm d          (EMPTY dir) rm: cannot remove 'd': Is a directory      exit 1
 *   rm -f d       (dir)       rm: cannot remove 'd': Is a directory      exit 1
 *   rm -r d       (non-empty) (silent, gone)                             exit 0
 *   rm a missing c            one error PER missing operand, `a` is gone exit 1
 *   rm /                      rm: cannot remove '/': Is a directory      exit 1
 *   rm -rf /                  it is dangerous … / use --no-preserve-root exit 1
 *   rm -rf .                  refusing to remove '.' or '..' directory…  exit 1
 *   rm -z b                   rm: unknown option -- z / Try 'rm --help'… exit 1
 *
 * Three of those corrected an assumption:
 *
 *  1. `-f` DOES NOT help with a directory. It suppresses "no such file", not
 *     "is a directory" — `rm -f d` on a directory still fails.
 *  2. AN EMPTY DIRECTORY IS STILL "Is a directory". `rm` has no rmdir
 *     behaviour; the emptiness never enters into it. (`Remove-Item` is the
 *     opposite: it removes an empty directory happily and only balks at a
 *     non-empty one. The two tools disagree, and both are reproduced.)
 *  3. THE ORDER OF CHECKS IS OBSERVABLE. `rm /` reports "Is a directory", not
 *     the preserve-root failsafe, because the directory check runs first; only
 *     `rm -r /` reaches the failsafe. v1 has the same order.
 *
 * ── TWO DECLARED DIVERGENCES FROM v1 ──────────────────────────────────────
 *
 *   EVERY OPERAND IS REMOVED. v1's argument loop assigns `target = t` for each
 *   non-dash token, so only the LAST survives and `rm a b` silently leaves `a`.
 *   GNU removes both (measured), and that is what a person typing it means. The
 *   v1 behaviour is a parsing bug, not a specification, so it is not
 *   reproduced — and each operand gets its own error line, as GNU does.
 *
 *   AN UNRECOGNISED OPTION IS REFUSED. v1 walks the letters of a short cluster
 *   and ignores anything that is not r/R/f, so `rm -i x` deletes without asking
 *   and `rm -d x` looks like it worked. GNU rejects it (measured), and an
 *   ignored flag on a delete is the kind of silence that costs someone a file.
 *   Only the flags v1 supported are accepted — `-r`, `-R`, `-f`,
 *   `--recursive`, `--force`, plus `--` as end-of-options, which GNU honours
 *   and which is the only way to name a file whose name starts with a dash.
 *
 * ONE ADDITION FROM v1, KEPT: when the removal takes out the directory the
 * shell is standing in, the location returns to HOME. GNU leaves the shell's
 * cwd pointing at a deleted inode, which a real kernel can express and this
 * `VirtualFileSystem` cannot — measured, `remove` does not move `location`, and
 * `stat('.')` afterwards is ENOENT. v1 made the same call for the same reason.
 */

import { throwIfCancelled } from '../../pipeline/pipeline.ts';
import type { StorageError } from '../../storage/index.ts';
import { HOME, isDescendant } from '../../storage/index.ts';
import type { CommandModule, InvocationContext } from '../invocation.ts';
import type { CommandManifest } from '../manifest.ts';
import type { FileSystemPort } from '../ports.ts';
import {
  EXIT_FAILURE,
  EXIT_SUCCESS,
  argumentsOf,
  fsManageCommand,
  needFileSystem,
  removeTree,
  stripQuotes,
  strerror,
  writeError,
} from './support.ts';

/** GNU's second line, which every usage failure carries. */
const TRY_HELP = "Try 'rm --help' for more information.";

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

interface Options {
  readonly recurse: boolean;
  readonly force: boolean;
  readonly operands: readonly string[];
  /** The first unrecognised option, as GNU would name it. Null when there is none. */
  readonly unknown: string | null;
}

/**
 * GNU's argument grammar, restricted to the flags v1 supported.
 *
 * A bare `-` is an operand, not an option: GNU reports
 * `cannot remove '-': No such file or directory` for it, and a file really can
 * be called that.
 */
function parseOptions(args: readonly string[]): Options {
  let recurse = false;
  let force = false;
  let unknown: string | null = null;
  let endOfOptions = false;
  const operands: string[] = [];

  for (const raw of args) {
    const token = String(raw);

    if (endOfOptions || token === '-' || !token.startsWith('-')) {
      operands.push(stripQuotes(token));
      continue;
    }
    if (token === '--') {
      endOfOptions = true;
      continue;
    }
    if (token.startsWith('--')) {
      if (token === '--recursive') recurse = true;
      else if (token === '--force') force = true;
      else unknown ??= token;
      continue;
    }
    for (const letter of token.slice(1)) {
      if (letter === 'r' || letter === 'R') recurse = true;
      else if (letter === 'f') force = true;
      else unknown ??= `-- ${letter}`;
    }
  }

  return { recurse, force, operands, unknown };
}

/** The last component of what the USER typed, which is where `.` and `..` survive. */
function typedLeaf(operand: string): string {
  const trimmed = operand.endsWith('/') ? operand.slice(0, -1) : operand;
  const cut = trimmed.lastIndexOf('/');
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}

// ---------------------------------------------------------------------------
// errors, in GNU's words
// ---------------------------------------------------------------------------

async function cannotRemove(
  context: InvocationContext,
  manifest: CommandManifest,
  operand: string,
  reason: string,
  errorId: string,
  category: Parameters<typeof writeError>[2]['category'],
): Promise<void> {
  await writeError(context, manifest, {
    message: `rm: cannot remove '${operand}': ${reason}`,
    errorId,
    category,
    target: operand,
  });
}

async function storageFailure(
  context: InvocationContext,
  manifest: CommandManifest,
  operand: string,
  error: StorageError,
): Promise<void> {
  await cannotRemove(
    context,
    manifest,
    operand,
    strerror(error),
    error.code === 'EACCES' ? 'PermissionDenied' : 'RemoveFailed',
    error.code === 'EACCES' ? 'PermissionDenied' : 'WriteError',
  );
}

// ---------------------------------------------------------------------------
// one operand
// ---------------------------------------------------------------------------

/** Returns false when something was written to stream 2. */
async function removeOperand(
  context: InvocationContext,
  manifest: CommandManifest,
  fs: FileSystemPort,
  operand: string,
  options: Options,
): Promise<boolean> {
  const stat = await fs.stat(operand);
  if (!stat.ok) {
    // `-f` suppresses THIS and only this. Measured: it does not suppress
    // "Is a directory", and it does not suppress the preserve-root failsafe.
    if (stat.error.code === 'ENOENT' && options.force) return true;
    await storageFailure(context, manifest, operand, stat.error);
    return false;
  }

  const target = stat.value.path;
  const directory = stat.value.kind === 'directory';

  if (directory && !options.recurse) {
    // Emptiness never enters into it — measured on an empty directory too.
    await cannotRemove(context, manifest, operand, 'Is a directory', 'IsADirectory', 'InvalidArgument');
    return false;
  }
  if (directory && (typedLeaf(operand) === '.' || typedLeaf(operand) === '..')) {
    await writeError(context, manifest, {
      message: `rm: refusing to remove '.' or '..' directory: skipping '${operand}'`,
      errorId: 'RefusingToRemoveDotDirectory',
      category: 'InvalidArgument',
      target: operand,
    });
    return false;
  }
  if (directory && target === '/') {
    // GNU's --preserve-root, which protects `/` and nothing else; everything
    // below it is guarded by file permissions. Two lines, one failure, so one
    // ErrorRecord carrying both — `$Error` should not gain two entries for one
    // thing that went wrong.
    await writeError(context, manifest, {
      message:
        "rm: it is dangerous to operate recursively on '/'\n" +
        'rm: use --no-preserve-root to override this failsafe',
      errorId: 'PreserveRoot',
      category: 'InvalidArgument',
      target: operand,
    });
    return false;
  }

  const here = fs.location.path;
  const takesLocation = target === here || isDescendant(here, target);

  // The resolved path for the walk — the audit log and the cancellation message
  // must name something a person can look up — and the TYPED operand in every
  // message, which is what GNU prints.
  const outcome = await removeTree(fs, target, directory, context.signal);
  if (outcome.failure !== null) {
    await storageFailure(context, manifest, operand, outcome.failure.error);
    return false;
  }
  if (outcome.cancelledAt !== null) {
    await writeError(context, manifest, {
      message:
        `rm: stopped after removing ${String(outcome.removed)} ` +
        `item${outcome.removed === 1 ? '' : 's'} from '${operand}': ` +
        `'${outcome.cancelledAt}' and everything above it are still there.`,
      errorId: 'RemoveStopped',
      category: 'OperationStopped',
      target: operand,
    });
    return false;
  }

  // v1's rule, kept: the prompt must not be left standing in a directory that
  // no longer exists. See the header.
  if (takesLocation) await fs.setLocation(HOME);
  return true;
}

// ---------------------------------------------------------------------------
// the command
// ---------------------------------------------------------------------------

export const rm: CommandModule = fsManageCommand('rm', async (context, bound, manifest) => {
  const options = parseOptions(argumentsOf(bound));

  if (options.unknown !== null) {
    await writeError(context, manifest, {
      message: `rm: unknown option ${options.unknown}\n${TRY_HELP}`,
      errorId: 'UnknownOption',
      category: 'InvalidArgument',
      target: options.unknown,
    });
    return EXIT_FAILURE;
  }

  if (options.operands.length === 0) {
    // Measured: `rm -f` with nothing to remove is silent and succeeds.
    if (options.force) return EXIT_SUCCESS;
    await writeError(context, manifest, {
      message: `rm: missing operand\n${TRY_HELP}`,
      errorId: 'MissingOperand',
      category: 'InvalidArgument',
    });
    return EXIT_FAILURE;
  }

  const fs = await needFileSystem(context, manifest);
  if (fs === null) return EXIT_FAILURE;

  let failed = false;
  for (const operand of options.operands) {
    // The order matters. A walk that was interrupted has something to say and
    // `removeOperand` says it, on stream 2, before this ever throws; what this
    // stops is starting the NEXT operand after the user asked to stop.
    throwIfCancelled(context.signal, manifest.display);
    if (!(await removeOperand(context, manifest, fs, operand, options))) failed = true;
  }

  // GNU rm prints nothing on success; there is no -v here to make it.
  return failed ? EXIT_FAILURE : EXIT_SUCCESS;
});
