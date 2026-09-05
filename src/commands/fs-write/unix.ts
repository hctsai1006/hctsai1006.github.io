/**
 * mkdir, touch, chmod, chown — the four coreutils in this set.
 *
 * NONE OF THESE IS A POWERSHELL CMDLET on the emulated machine, and that is a
 * deliberate fact rather than an omission. v1 states it at the site where it
 * groups them:
 *
 *     PowerShell 在 Linux/macOS 上「刻意移除」ls/cp/mv/rm/cat/man/mount/ps
 *     這幾個別名,好讓原生執行檔直接跑。
 *
 * `mkdir` is the sharpest case: on Windows it IS a PowerShell function wrapping
 * `New-Item -ItemType Directory`, and v1's own alias table has a comment saying
 * it deliberately stopped aliasing it for exactly this reason. So there is no
 * pwsh behaviour to measure for any of the four, and v1's implementation is the
 * specification. Every claim below cites the v1 line it came from.
 *
 * The one thing they do NOT inherit from v1 is its single output channel. v1
 * returned rendered rows classed `err`, so `mkdir: File exists` could not be
 * caught, counted or redirected. Here each is an ErrorRecord on stream 2 and
 * `$LASTEXITCODE` is 1 — the same correction `simulated/support.ts` documents
 * for its own family.
 *
 * WHERE THEY GO BEYOND v1, and why each is safe:
 *
 *   mkdir  unchanged: v1 already takes many operands and both flags.
 *   touch  takes MANY operands and `-c`. v1 takes one operand and no flags,
 *          because v1 only ever read `firstArg`. GNU takes many, and refusing
 *          the second one would be inventing a limit rather than reproducing a
 *          behaviour.
 *   chmod  takes MANY files, for the same reason. `-R` is REFUSED rather than
 *          ignored, so a recursive chmod cannot look like it worked.
 *   chown  gains ONE thing v1 does not have: it stats the target first, so a
 *          typo says "cannot access" instead of "Operation not permitted". See
 *          the note on that command for why that is the honest version.
 */

import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import type { StorageError } from '../../storage/index.ts';
import {
  argumentsOf,
  cancellationShape,
  cancelled,
  exitFor,
  fsWriteManifest,
  reportError,
  requireFileSystem,
  stripQuotes,
} from './support.ts';
import type { PSErrorShape } from './support.ts';

/**
 * A coreutil failure. The id is ours — a real coreutil is an external binary
 * and produces no ErrorRecord at all — and it is named after the tool so a
 * script can still branch on `FullyQualifiedErrorId`.
 */
function coreutil(
  tool: string,
  message: string,
  category: PSErrorShape['category'] = 'InvalidOperation',
): PSErrorShape {
  return {
    id: `${tool}Error`,
    category,
    exceptionType: 'System.IO.IOException',
    message,
  };
}

/**
 * GNU's word for a storage failure.
 *
 * Every `StorageErrorCode` reaches this, so the mapping is total, and the
 * wording is `strerror`'s because that is what a coreutil prints. The three
 * that matter are ENOENT, EACCES and ENOSPC; the rest are here so that no code
 * can arrive and produce a blank.
 */
function strerror(error: StorageError): string {
  switch (error.code) {
    case 'ENOENT':
      return 'No such file or directory';
    case 'EEXIST':
      return 'File exists';
    case 'ENOTDIR':
      return 'Not a directory';
    case 'EISDIR':
      return 'Is a directory';
    case 'ENOTEMPTY':
      return 'Directory not empty';
    case 'EACCES':
      return 'Permission denied';
    case 'ENOSPC':
      // The storage layer reports quota exhaustion and the visitor has to be
      // told rather than silently truncated, so the numbers go in the message.
      return (
        'No space left on device' +
        (error.usage.quota === null
          ? ''
          : ` (${String(error.usage.used)} of ${String(error.usage.quota)} bytes used)`)
      );
    case 'EINVAL':
      return `Invalid argument (${error.reason})`;
    case 'ENAMETOOLONG':
      return 'File name too long';
    case 'EXDEV':
      return 'Invalid cross-device link';
    case 'EROFS':
      return 'Read-only file system';
    case 'EIO':
      return `Input/output error (${error.cause})`;
  }
}

function categoryFor(error: StorageError): PSErrorShape['category'] {
  if (error.code === 'ENOENT') return 'ObjectNotFound';
  if (error.code === 'EACCES' || error.code === 'EROFS') return 'PermissionDenied';
  if (error.code === 'ENOSPC') return 'QuotaExceeded';
  if (error.code === 'EEXIST') return 'ResourceExists';
  return 'InvalidOperation';
}

// ---------------------------------------------------------------------------
// mkdir
// ---------------------------------------------------------------------------

const MKDIR_MANIFEST = fsWriteManifest(
  'mkdir',
  'GNU coreutils mkdir, not New-Item: PowerShell on Linux is where this terminal lives, and v1 ' +
    'deliberately stopped aliasing mkdir to New-Item so the coreutil semantics survive. -p/' +
    '--parents and -v/--verbose are implemented and follow v1 exactly, including the precise GNU ' +
    'rule that -p is silent only for an EXISTING DIRECTORY and still reports "File exists" for an ' +
    'existing file. Permission on a -p chain is checked at the deepest existing ancestor, so a ' +
    'chain cannot be built into a directory the user cannot write to. -m/--mode and every other ' +
    'long option are IGNORED rather than rejected, which is what v1 does. Unlike v1 each failure ' +
    'is an ErrorRecord on stream 2 and sets a non-zero exit code.',
);

interface MkdirFlags {
  readonly parents: boolean;
  readonly verbose: boolean;
  readonly targets: readonly string[];
}

/** v1's parser, character for character: clusters, two long options, the rest ignored. */
function parseMkdir(args: readonly string[]): MkdirFlags {
  let parents = false;
  let verbose = false;
  const targets: string[] = [];
  for (const raw of args) {
    const token = stripQuotes(raw);
    if (token === '--parents') {
      parents = true;
      continue;
    }
    if (token === '--verbose') {
      verbose = true;
      continue;
    }
    if (token.startsWith('--')) continue;
    if (token.startsWith('-') && token.length > 1) {
      for (const character of token.slice(1)) {
        if (character === 'p') parents = true;
        else if (character === 'v') verbose = true;
      }
      continue;
    }
    targets.push(token);
  }
  return { parents, verbose, targets };
}

export const mkdir: CommandModule = {
  manifest: MKDIR_MANIFEST,

  async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
    const port = await requireFileSystem(context, MKDIR_MANIFEST);
    if (port === null) return exitFor(1);

    const flags = parseMkdir(argumentsOf(bound));
    if (flags.targets.length === 0) {
      // v1 prints the operand error and the hint as two lines. One ErrorRecord
      // carries both, because splitting them would put half an error on a
      // stream that is not for errors.
      await reportError(
        context,
        MKDIR_MANIFEST,
        coreutil(
          'Mkdir',
          "mkdir: missing operand\nTry 'mkdir --help' for more information.",
          'InvalidArgument',
        ),
        null,
      );
      return exitFor(1);
    }

    let failures = 0;
    const made: string[] = [];
    for (const spec of flags.targets) {
      if (cancelled(context)) {
        await reportError(context, MKDIR_MANIFEST, cancellationShape(made), null);
        return exitFor(failures + 1);
      }
      const resolved = port.resolve(spec);
      if (!resolved.ok) {
        await reportError(
          context,
          MKDIR_MANIFEST,
          coreutil(
            'Mkdir',
            `mkdir: cannot create directory '${spec}': ${strerror(resolved.error)}`,
            categoryFor(resolved.error),
          ),
          spec,
        );
        failures += 1;
        continue;
      }
      const path = resolved.value.full;

      // v1: `-p` is silent only for an EXISTING DIRECTORY; an existing FILE
      // still reports File exists. That is GNU's exact rule and the reason the
      // check is here rather than left to `mkdir -p`, which succeeds silently
      // on an existing directory and would hide the file case.
      const existing = await port.stat(path);
      if (existing.ok) {
        if (flags.parents && existing.value.kind === 'directory') continue;
        await reportError(
          context,
          MKDIR_MANIFEST,
          coreutil('Mkdir', `mkdir: cannot create directory '${spec}': File exists`, 'ResourceExists'),
          path,
        );
        failures += 1;
        continue;
      }

      const created = await port.mkdir(path, { recursive: flags.parents });
      if (!created.ok) {
        await reportError(
          context,
          MKDIR_MANIFEST,
          coreutil(
            'Mkdir',
            `mkdir: cannot create directory '${spec}': ${strerror(created.error)}`,
            categoryFor(created.error),
          ),
          path,
        );
        failures += 1;
        continue;
      }
      made.push(path);
      // v1's verbose line, verbatim.
      if (flags.verbose) await context.streams.success.write(`mkdir: created directory '${spec}'`);
    }

    return exitFor(failures);
  },
};

// ---------------------------------------------------------------------------
// touch
// ---------------------------------------------------------------------------

const TOUCH_MANIFEST = fsWriteManifest(
  'touch',
  'GNU coreutils touch. It really changes an mtime: an existing file or DIRECTORY has its ' +
    "modification time set to now, and a missing file is created empty — v1's comment says the " +
    'same and calls out that a real touch updates rather than doing nothing. -c/--no-create is ' +
    'implemented and, as GNU does, succeeds silently on a missing file. Several operands are ' +
    'accepted; v1 read only the first, which was a limit of its argument reader rather than a ' +
    'behaviour. -d, -t, -r, -a and -m are NOT implemented: there is no way to name an instant ' +
    'here without a date parser, and inventing one would let the time be wrong quietly. The ' +
    'clock is the storage backend\'s injected one, never Date.now(), so a test can pin it.',
);

export const touch: CommandModule = {
  manifest: TOUCH_MANIFEST,

  async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
    const port = await requireFileSystem(context, TOUCH_MANIFEST);
    if (port === null) return exitFor(1);

    const args = argumentsOf(bound);
    const noCreate = args.some(
      (token) => token === '--no-create' || /^-[a-zA-Z]*c/u.test(token),
    );
    const targets = args.filter((token) => !token.startsWith('-')).map(stripQuotes);

    if (targets.length === 0) {
      await reportError(
        context,
        TOUCH_MANIFEST,
        coreutil('Touch', 'touch: missing file operand', 'InvalidArgument'),
        null,
      );
      return exitFor(1);
    }

    let failures = 0;
    const touched: string[] = [];
    for (const spec of targets) {
      if (cancelled(context)) {
        await reportError(context, TOUCH_MANIFEST, cancellationShape(touched), null);
        return exitFor(failures + 1);
      }
      const resolved = port.resolve(spec);
      if (!resolved.ok) {
        await reportError(
          context,
          TOUCH_MANIFEST,
          coreutil(
            'Touch',
            `touch: cannot touch '${spec}': ${strerror(resolved.error)}`,
            categoryFor(resolved.error),
          ),
          spec,
        );
        failures += 1;
        continue;
      }

      // One call. `utimes` creates the file when it is absent unless `create`
      // is false, and it goes through the ordinary write path so the parent's
      // permissions and the quota are checked the same way — which is why this
      // does not stat first and then decide.
      const done = await port.utimes(resolved.value.full, {}, !noCreate);
      if (!done.ok) {
        // GNU `touch -c` on a missing file is silent success, and that is the
        // entire purpose of the flag.
        if (noCreate && done.error.code === 'ENOENT') continue;
        await reportError(
          context,
          TOUCH_MANIFEST,
          coreutil(
            'Touch',
            `touch: cannot touch '${spec}': ${strerror(done.error)}`,
            categoryFor(done.error),
          ),
          resolved.value.full,
        );
        failures += 1;
        continue;
      }
      touched.push(resolved.value.full);
    }

    return exitFor(failures);
  },
};

// ---------------------------------------------------------------------------
// chmod
// ---------------------------------------------------------------------------

const CHMOD_MANIFEST = fsWriteManifest(
  'chmod',
  'GNU coreutils chmod, and the permission bits it sets are REAL: the storage layer enforces ' +
    'them, so a directory you chmod 000 is a directory you can no longer write to. v1 is the ' +
    'specification and both of its mode forms are implemented — octal with three or four digits ' +
    '(the fourth carrying setuid/setgid/sticky, and a three-digit form CLEARING them), and the ' +
    'symbolic [ugoa]*[+-][rwxst]+ form, including v1\'s rule that adding or removing execute must ' +
    'not wash out a setuid bit. The `=` form is NOT implemented, and neither is v1. -R is REFUSED rather ' +
    'than ignored: a recursive chmod that quietly changed only the named path would look ' +
    'like it had worked. Ownership is what governs: chmod on a file you do not own is refused even when the ' +
    'file is world-writable, which is POSIX and is where the storage layer deliberately differs ' +
    'from v1. Several files are accepted; v1 read only the first.',
);

const OCTAL = /^[0-7]{3,4}$/u;
const SYMBOLIC = /^[ugoa]*[+-][rwxst]+$/u;

/**
 * v1's two mode forms, computed on the NUMBER rather than on v1's nine-character
 * string.
 *
 * The numeric form reproduces v1 exactly, including the case its comment calls
 * out — 別把 setuid 位洗掉 — because setuid and execute are separate bits here
 * and `+x` cannot touch `0o4000` by construction. v1 needed the special case
 * only because its representation put both in one character.
 *
 * Returns null for a mode v1 would reject.
 */
export function applyMode(current: number, spec: string): number | null {
  if (OCTAL.test(spec)) {
    // A three-digit spec CLEARS the special bits, which is what v1 does by
    // rebuilding the whole string from a leading '0'.
    return Number.parseInt(spec, 8);
  }
  if (!SYMBOLIC.test(spec)) return null;

  const add = spec.includes('+');
  const [whoPart = '', letters = ''] = spec.split(/[+-]/u);
  const who = whoPart === '' || whoPart.includes('a') ? 'ugo' : whoPart;
  const shifts: number[] = [];
  if (who.includes('u')) shifts.push(6);
  if (who.includes('g')) shifts.push(3);
  if (who.includes('o')) shifts.push(0);

  let mode = current;
  const set = (bits: number): void => {
    mode = add ? mode | bits : mode & ~bits;
  };
  for (const letter of letters) {
    if (letter === 's') {
      // v1 applies `s` to owner and group only; `o+s` is a no-op there and here.
      if (shifts.includes(6)) set(0o4000);
      if (shifts.includes(3)) set(0o2000);
      continue;
    }
    if (letter === 't') {
      // v1 applies `t` to the other triplet's execute slot only.
      set(0o1000);
      continue;
    }
    const bit = letter === 'r' ? 0o4 : letter === 'w' ? 0o2 : 0o1;
    for (const shift of shifts) set(bit << shift);
  }
  return mode;
}

export const chmod: CommandModule = {
  manifest: CHMOD_MANIFEST,

  async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
    const port = await requireFileSystem(context, CHMOD_MANIFEST);
    if (port === null) return exitFor(1);

    const args = argumentsOf(bound);
    // REFUSED, not ignored. `chmod -R 755 dir` that silently changed only `dir`
    // is the shape of wrong answer this project keeps finding: it looks like it
    // worked, and nothing downstream can tell that the subtree was skipped.
    const recursive = args.some(
      (token) => token === '--recursive' || (token.startsWith('-') && /^-[a-zA-Z]*R/u.test(token)),
    );
    if (recursive) {
      await reportError(
        context,
        CHMOD_MANIFEST,
        coreutil(
          'Chmod',
          'chmod: -R is recognised but not implemented by BrowserShell. Applying it to the ' +
            'named path alone would look like it had worked.',
          'NotImplemented',
        ),
        null,
      );
      return exitFor(1);
    }

    const operands = args
      .filter((token) => !token.startsWith('-') || SYMBOLIC.test(stripQuotes(token)))
      .map(stripQuotes);
    const spec = operands[0];
    const targets = operands.slice(1);

    if (spec === undefined || targets.length === 0) {
      await reportError(
        context,
        CHMOD_MANIFEST,
        coreutil(
          'Chmod',
          "chmod: missing operand\nTry 'chmod --help' for more information.",
          'InvalidArgument',
        ),
        null,
      );
      return exitFor(1);
    }
    if (!OCTAL.test(spec) && !SYMBOLIC.test(spec)) {
      await reportError(
        context,
        CHMOD_MANIFEST,
        coreutil('Chmod', `chmod: invalid mode: '${spec}'`, 'InvalidArgument'),
        spec,
      );
      return exitFor(1);
    }

    let failures = 0;
    const changed: string[] = [];
    for (const target of targets) {
      if (cancelled(context)) {
        await reportError(context, CHMOD_MANIFEST, cancellationShape(changed), null);
        return exitFor(failures + 1);
      }
      const resolved = port.resolve(target);
      if (!resolved.ok) {
        await reportError(
          context,
          CHMOD_MANIFEST,
          coreutil(
            'Chmod',
            `chmod: cannot access '${target}': ${strerror(resolved.error)}`,
            categoryFor(resolved.error),
          ),
          target,
        );
        failures += 1;
        continue;
      }
      const path = resolved.value.full;

      // The current bits are needed for the symbolic form, and reading them is
      // also how a missing file gets v1's "cannot access" wording rather than
      // the storage layer's chmod wording.
      const stat = await port.stat(path);
      if (!stat.ok) {
        await reportError(
          context,
          CHMOD_MANIFEST,
          coreutil(
            'Chmod',
            `chmod: cannot access '${target}': ${strerror(stat.error)}`,
            categoryFor(stat.error),
          ),
          path,
        );
        failures += 1;
        continue;
      }

      const wanted = applyMode(stat.value.mode, spec);
      if (wanted === null) {
        await reportError(
          context,
          CHMOD_MANIFEST,
          coreutil('Chmod', `chmod: invalid mode: '${spec}'`, 'InvalidArgument'),
          path,
        );
        failures += 1;
        continue;
      }

      const done = await port.chmod(path, wanted);
      if (!done.ok) {
        // v1's wording for the ownership refusal. The storage layer reports
        // EACCES for it because POSIX chmod requires ownership rather than the
        // write bit — which is the case v1's own comment says it got wrong.
        const message =
          done.error.code === 'EACCES'
            ? `chmod: changing permissions of '${target}': Operation not permitted`
            : `chmod: changing permissions of '${target}': ${strerror(done.error)}`;
        await reportError(context, CHMOD_MANIFEST, coreutil('Chmod', message, categoryFor(done.error)), path);
        failures += 1;
        continue;
      }
      changed.push(path);
    }

    return exitFor(failures);
  },
};

// ---------------------------------------------------------------------------
// chown
// ---------------------------------------------------------------------------

/**
 * chown — the one command here that cannot do the thing it is named after, and
 * says so every time.
 *
 * THE DECISION, since the brief asked for one: it changes nothing, ever, and it
 * reports why. That is not a placeholder standing in for missing work. There is
 * no owner-changing operation anywhere beneath it to call — `FileSystemPort`
 * has no `chown`, `VirtualFileSystem` has none, and `StorageBackend` has none —
 * because there is one user in this filesystem and ownership is assigned by the
 * backend at write time. A `chown` that appeared to work would have to fabricate
 * a second user, and every `ls -l` afterwards would report a person who does not
 * exist.
 *
 * v1 makes the same call and it is the specification here: the refusal, plus a
 * sentence naming the single user. What this adds is ONE probe v1 does not do —
 * it stats the target first, so `chown me typo.txt` says "cannot access" rather
 * than claiming a permission problem with a file that is not there. That also
 * makes the declared `filesystem.read` capability real: it is asked for on every
 * invocation and the broker records it.
 *
 * `filesystem.write` is declared by the generated classification and is never
 * exercised, because nothing is written. The note says so rather than leaving a
 * reader to assume the grant is used.
 */
const CHOWN_MANIFEST = fsWriteManifest(
  'chown',
  'Changes nothing, and says so. This filesystem has ONE user and ownership is assigned by the ' +
    'storage backend at write time; there is no owner-changing operation in FileSystemPort, in ' +
    'VirtualFileSystem or in StorageBackend to call, so a chown that appeared to succeed would ' +
    'have to invent a second user that every later ls -l would report as real. v1 makes the same ' +
    'refusal and is the specification. What this adds over v1 is one real read: the target is ' +
    'stat-ed first, so a typo reports "cannot access" instead of a permission story about a file ' +
    'that does not exist — which is also what makes the declared filesystem.read capability ' +
    'something the broker actually records. The declared filesystem.write capability is NEVER ' +
    'exercised, because nothing is written. -R, --reference and the user:group form are parsed ' +
    'no further than finding the target, since the answer does not depend on them.',
);

export const chown: CommandModule = {
  manifest: CHOWN_MANIFEST,

  async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
    const port = await requireFileSystem(context, CHOWN_MANIFEST);
    if (port === null) return exitFor(1);

    // v1 reads `raw.slice(2)`: the first operand is the owner spec, the second
    // is the file. Anything dash-led is skipped.
    const operands = argumentsOf(bound)
      .filter((token) => !token.startsWith('-'))
      .map(stripQuotes);
    const target = operands[1];

    if (target === undefined) {
      await reportError(
        context,
        CHOWN_MANIFEST,
        coreutil('Chown', 'chown: missing operand', 'InvalidArgument'),
        null,
      );
      return exitFor(1);
    }

    const resolved = port.resolve(target);
    if (resolved.ok) {
      const stat = await port.stat(resolved.value.full);
      if (!stat.ok) {
        await reportError(
          context,
          CHOWN_MANIFEST,
          coreutil(
            'Chown',
            `chown: cannot access '${target}': ${strerror(stat.error)}`,
            categoryFor(stat.error),
          ),
          target,
        );
        return exitFor(1);
      }
    }

    await reportError(
      context,
      CHOWN_MANIFEST,
      coreutil(
        'Chown',
        `chown: changing ownership of '${target}': Operation not permitted\n` +
          'This filesystem has a single user and no owner-changing operation exists beneath ' +
          'this command; nothing was changed.',
        'PermissionDenied',
      ),
      target,
    );
    return exitFor(1);
  },
};
