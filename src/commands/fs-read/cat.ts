/**
 * cat — concatenate files and print them.
 *
 * Its own command in `manifests.json`, not an alias for `Get-Content`, for the
 * reason `ls.ts` gives: PowerShell on Unix leaves these names to the native
 * executables. So the error text is coreutils' and not PowerShell's, and the
 * specification is v1:
 *
 *   no operands   ->  "Usage: cat [FILE]..."
 *   missing file  ->  "cat: <t>: No such file or directory"   and CONTINUE
 *   a directory   ->  "cat: <t>: Is a directory"              and CONTINUE
 *
 * "reads a file it cannot open, prints the error, and moves on to the next one"
 * is v1's own comment and is what GNU cat does; a `cat a b` that stopped at a
 * missing `a` would lose `b`.
 *
 * The operand rule is v1's `firstArg` family: any token starting with `-` is a
 * flag and is skipped, which means `cat -n file` prints the file and silently
 * ignores `-n`. That is v1's behaviour, kept rather than tidied, because these
 * commands are being held to v1 and a "fix" here would be an unannounced change.
 */

import { throwIfCancelled } from '../../pipeline/pipeline.ts';
import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import {
  commandError,
  emit,
  fsReadManifest,
  nativeIdentity,
  readTextSniffed,
  requirePort,
  splitLines,
  stripQuotes,
} from './support.ts';

const MANIFEST = fsReadManifest('cat');
const CAT = nativeIdentity('cat');

const EXIT_OK = 0;
const EXIT_FAILURE = 1;

export const cat: CommandModule = {
  manifest: MANIFEST,

  async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
    const files = bound.remaining.filter((token) => !token.startsWith('-')).map(stripQuotes);
    if (files.length === 0) {
      // v1 prints this as ordinary output rather than a diagnostic. Kept on
      // stream 1 for parity; the exit code says nothing was concatenated.
      await emit(context.streams.success, context.signal, 'Usage: cat [FILE]...');
      return EXIT_FAILURE;
    }

    const fs = await requirePort(context, CAT);
    if (fs === null) return EXIT_FAILURE;

    let failed = false;
    for (const file of files) {
      throwIfCancelled(context.signal, 'cat');

      const resolved = fs.resolve(file);
      if (!resolved.ok) {
        failed = true;
        await context.streams.error.write(diagnostic(file, 'No such file or directory'));
        continue;
      }
      const stat = await fs.stat(resolved.value.full);
      if (!stat.ok) {
        failed = true;
        await context.streams.error.write(
          diagnostic(file, stat.error.code === 'EACCES' ? 'Permission denied' : 'No such file or directory'),
        );
        continue;
      }
      if (stat.value.kind === 'directory') {
        failed = true;
        await context.streams.error.write(diagnostic(file, 'Is a directory'));
        continue;
      }

      const text = await readTextSniffed(fs, resolved.value.full);
      if (!text.ok) {
        failed = true;
        await context.streams.error.write(
          diagnostic(file, text.error.code === 'EACCES' ? 'Permission denied' : 'Input/output error'),
        );
        continue;
      }
      for (const line of splitLines(text.value)) {
        if (!(await emit(context.streams.success, context.signal, line))) return EXIT_OK;
      }
    }
    return failed ? EXIT_FAILURE : EXIT_OK;
  },
};

function diagnostic(target: string, reason: string): ReturnType<typeof commandError> {
  return commandError(
    CAT,
    `cat: ${target}: ${reason}`,
    reason === 'Permission denied' ? 'PermissionDenied' : 'CannotOpen',
    reason === 'Permission denied' ? 'PermissionDenied' : 'ObjectNotFound',
    'System.IO.IOException',
    target,
  );
}
