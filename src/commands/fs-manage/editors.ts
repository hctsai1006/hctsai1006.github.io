/**
 * editors.ts — `nano`, `vi` and `vim`: the reason `DialogPort` exists.
 *
 * These are not filesystem commands with extra steps. Every other command in
 * this directory decides what to do and does it; these three read a file, hand
 * the buffer to a PERSON, and wait. The engine is headless — it cannot open an
 * editor, it can only ask the host for one and be told what came back — and
 * that asymmetry is the whole shape of the code below:
 *
 *     read  →  dialog.editText(…)  →  write
 *
 * ── THE ONE THING THAT MUST NOT BE AN ERROR ───────────────────────────────
 *
 * `editText` resolving to NULL means the visitor quit without saving. That is a
 * normal outcome. Nothing is written, nothing goes to stream 2, and the exit
 * code is 0 — quitting nano with ^X N is not a failure, and a command that
 * reported one would make `nano notes.txt; if ($?) { … }` wrong for the most
 * ordinary thing a person does in an editor.
 *
 * ── v1 IS THE SPECIFICATION, AND IT WAS READ RATHER THAN REMEMBERED ───────
 *
 * `vi` and `vim` are ONE implementation in v1: both call `edStart('vim', …)`,
 * so `vi nosuch/x` reports `vim: nosuch/x: No such file or directory` with
 * vim's name, not the typed one. That looks like a bug and is reproduced,
 * because it is what the archived terminal does and this file is held to it.
 * The `editor` field of the request keeps the TYPED name, because `ports.ts`
 * says it is "which editor was typed, so the host can match its chrome and key
 * map" — the host, not the message, is what that field is for.
 *
 * Opening a path that does not exist gives an EMPTY BUFFER, in v1 (`ED.isNew`)
 * and in real nano and real vim. It is only a failure when the PARENT does not
 * exist or is not a directory, which v1 checks explicitly and so does this.
 *
 * v1's messages, transcribed:
 *
 *   target is a directory     nano  Error reading <rel>: Is a directory
 *                             vim   "<rel>" is a directory
 *   parent missing            both  <app>: <rel>: No such file or directory
 *   write, no permission      nano  Error writing <rel>: Permission denied
 *                             vim   E212: Can't open file for writing
 *   write, target is a dir    nano  Error writing <rel>: Is a directory
 *                             vim   E212: Can't open file for writing
 *   write, parent missing     nano  Error writing <rel>: No such file or directory
 *                             vim   E212: Can't open file for writing
 *   write, no buffer name     vim   E32: No file name
 *
 * ── THREE DECLARED DIVERGENCES ────────────────────────────────────────────
 *
 *   NO FILENAME PROMPT. v1's nano `^O` and vim's `:w <name>` ask for a name
 *   through an in-editor input. `DialogPort` has `editText` and `confirm` and
 *   nothing that asks for a string, so an unnamed buffer that comes back with
 *   text cannot be saved. It is REPORTED — v1's own `E32: No file name` — and
 *   not silently discarded, which is the one outcome that would lose work.
 *
 *   THE STATUS LINE GOES TO STREAM 4. v1 prints `[ Wrote 3 lines ]` and
 *   `"f" 3L, 42B written` inside the editor's own status bar, which is the
 *   host's surface here, not the terminal's. The same sentences are written to
 *   Verbose, where a diagnostic belongs: putting them on stream 1 would make
 *   `nano f | Measure-Object` count a status message as an object.
 *
 *   THE BYTE COUNT IS THE REAL ONE. v1's `edBytes()` sums UTF-16 code units
 *   plus one per line; this reports `WriteReceipt.size`, the UTF-8 length of
 *   what was actually stored. For anything outside ASCII v1's number was not a
 *   byte count, and a byte count that is not one is worse than none.
 *
 * NOT MODELLED, and said rather than left to be discovered: v1 marks a buffer
 * read-only when the file is owned by someone else and vim then needs `:w!`.
 * There is no read-only field in the request, so the buffer opens normally and
 * the WRITE fails with the permission message. The visitor learns at the same
 * moment either way; only the wording differs.
 */

import type { StorageError } from '../../storage/index.ts';
import { dirname } from '../../storage/index.ts';
import type { CommandModule, InvocationContext } from '../invocation.ts';
import type { CommandManifest } from '../manifest.ts';
import type { DialogPort, FileSystemPort } from '../ports.ts';
import { readTextSniffed } from '../fs-read/support.ts';
import {
  EXIT_FAILURE,
  EXIT_SUCCESS,
  argumentsOf,
  firstArgument,
  fsManageCommand,
  needDialog,
  needFileSystem,
  strerror,
  writeError,
} from './support.ts';

/** Which of v1's two editors this is. `vi` and `vim` are the same one. */
type Flavour = 'nano' | 'vim';

const IO_EXCEPTION = 'System.IO.IOException';
const INVALID_OPERATION = 'System.Management.Automation.PSInvalidOperationException';

// ---------------------------------------------------------------------------
// opening
// ---------------------------------------------------------------------------

interface Buffer {
  /** What the visitor typed. Every message uses this form, as v1 does. */
  readonly typed: string;
  /** Resolved and absolute. Empty when there is no name at all. */
  readonly path: string;
  readonly contents: string;
}

/** Read the file, or explain why the editor will not open. Null means an error was written. */
async function open(
  context: InvocationContext,
  manifest: CommandManifest,
  flavour: Flavour,
  fs: FileSystemPort,
  typed: string,
): Promise<Buffer | null> {
  if (typed === '') return { typed: '', path: '', contents: '' };

  const resolved = fs.resolve(typed);
  if (!resolved.ok) {
    await writeError(context, manifest, {
      message: `${flavour}: ${typed}: ${strerror(resolved.error)}`,
      errorId: 'InvalidPath',
      category: 'InvalidArgument',
      exceptionType: IO_EXCEPTION,
      target: typed,
    });
    return null;
  }
  const path = resolved.value.path;

  const stat = await fs.stat(typed);
  if (stat.ok) {
    if (stat.value.kind === 'directory') {
      await writeError(context, manifest, {
        message:
          flavour === 'nano'
            ? `Error reading ${typed}: Is a directory`
            : `"${typed}" is a directory`,
        errorId: 'IsADirectory',
        category: 'InvalidArgument',
        exceptionType: IO_EXCEPTION,
        target: typed,
      });
      return null;
    }
    // Through the broker, like every other reader: an editor that opened a
    // UTF-16 file as mojibake would then SAVE the mojibake.
    const text = await readTextSniffed(fs, typed);
    if (!text.ok) {
      await writeError(context, manifest, {
        message:
          flavour === 'nano'
            ? `Error reading ${typed}: ${strerror(text.error)}`
            : `"${typed}" ${strerror(text.error)}`,
        errorId: 'ReadFailed',
        category: text.error.code === 'EACCES' ? 'PermissionDenied' : 'ReadError',
        exceptionType: IO_EXCEPTION,
        target: typed,
      });
      return null;
    }
    return { typed, path, contents: text.value };
  }

  // A missing file is a NEW BUFFER, not a failure — unless there is nowhere to
  // put it. v1 checks the parent explicitly; so does this.
  const parent = await fs.stat(dirname(path));
  if (!parent.ok || parent.value.kind !== 'directory') {
    await writeError(context, manifest, {
      message: `${flavour}: ${typed}: No such file or directory`,
      errorId: 'PathNotFound',
      category: 'ObjectNotFound',
      exceptionType: 'System.Management.Automation.ItemNotFoundException',
      target: typed,
    });
    return null;
  }
  return { typed, path, contents: '' };
}

// ---------------------------------------------------------------------------
// saving
// ---------------------------------------------------------------------------

function writeFailureMessage(flavour: Flavour, typed: string, error: StorageError): string {
  // vim collapses every write failure into one message; nano names the reason.
  // Both are v1's, and both are what the real editors do.
  return flavour === 'nano'
    ? `Error writing ${typed}: ${strerror(error)}`
    : "E212: Can't open file for writing";
}

/** Returns false when something was written to stream 2. */
async function save(
  context: InvocationContext,
  manifest: CommandManifest,
  flavour: Flavour,
  fs: FileSystemPort,
  buffer: Buffer,
  text: string,
): Promise<boolean> {
  if (buffer.path === '') {
    await writeError(context, manifest, {
      message:
        flavour === 'nano'
          ? 'Error writing: No file name. The buffer was never given one, and this host has ' +
            'no way to ask for one, so nothing was written.'
          : 'E32: No file name. The buffer was never given one, and this host has no way to ' +
            'ask for one, so nothing was written.',
      errorId: 'NoFileName',
      category: 'InvalidArgument',
      exceptionType: INVALID_OPERATION,
    });
    return false;
  }

  const receipt = await fs.writeText(buffer.path, text);
  if (!receipt.ok) {
    await writeError(context, manifest, {
      message: writeFailureMessage(flavour, buffer.typed, receipt.error),
      errorId: 'WriteFailed',
      category: receipt.error.code === 'EACCES' ? 'PermissionDenied' : 'WriteError',
      exceptionType: IO_EXCEPTION,
      target: buffer.typed,
    });
    return false;
  }

  // v1's status line, on the stream a diagnostic belongs on. See the header.
  const lines = text.split('\n').length;
  await context.streams.verbose.write(
    flavour === 'nano'
      ? `[ Wrote ${String(lines)} line${lines === 1 ? '' : 's'} ]`
      : `"${buffer.typed}" ${String(lines)}L, ${String(receipt.value.size)}B written`,
  );
  return true;
}

// ---------------------------------------------------------------------------
// the command
// ---------------------------------------------------------------------------

function editorCommand(name: 'nano' | 'vi' | 'vim'): CommandModule {
  // v1 collapses vi onto vim: `'vi': run: edStart('vim', …)`. See the header.
  const flavour: Flavour = name === 'nano' ? 'nano' : 'vim';

  return fsManageCommand(name, async (context, bound, manifest) => {
    // Declared in the manifest, and not brokered by the port — `DialogPort` is
    // handed over whole — so the command has to ask. A denial arrives as an
    // ErrorRecord through `fsManageCommand`.
    context.requireCapability('ui.dialog');

    const fs = await needFileSystem(context, manifest);
    if (fs === null) return EXIT_FAILURE;
    const dialog: DialogPort | null = await needDialog(context, manifest, 'open an editor');
    if (dialog === null) return EXIT_FAILURE;

    const buffer = await open(context, manifest, flavour, fs, firstArgument(argumentsOf(bound)));
    if (buffer === null) return EXIT_FAILURE;

    let edited: string | null;
    try {
      edited = await dialog.editText({
        // The resolved path: a host cannot reconstruct one from `../notes.txt`,
        // and every message the visitor sees keeps the form they typed.
        path: buffer.path,
        contents: buffer.contents,
        editor: name,
      });
    } catch (reason) {
      await writeError(context, manifest, {
        message:
          `${name}: the editor host failed: ${reason instanceof Error ? reason.message : String(reason)}. ` +
          'Nothing was written.',
        errorId: 'EditorHostFailed',
        category: 'InvalidOperation',
        exceptionType: INVALID_OPERATION,
        target: buffer.typed,
      });
      return EXIT_FAILURE;
    }

    // THE CANCEL PATH. Quitting without saving is not a failure. See the header.
    if (edited === null) return EXIT_SUCCESS;

    return (await save(context, manifest, flavour, fs, buffer, edited))
      ? EXIT_SUCCESS
      : EXIT_FAILURE;
  });
}

export const nano: CommandModule = editorCommand('nano');
export const vi: CommandModule = editorCommand('vi');
export const vim: CommandModule = editorCommand('vim');
