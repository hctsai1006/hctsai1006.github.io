/**
 * Set-Content (sc) and Add-Content (ac) — one file, because they are one
 * command with two write modes, and because the four places they DIVERGE are
 * only visible side by side.
 *
 * Measured against pwsh 7.6.5 on 2026-09-05 (`p2-content.ps1`,
 * `p7-continue.ps1`, `p10-passthru.ps1`). Every claim names its probe.
 *
 * WHERE THEY AGREE
 *
 *   a MISSING FILE is created by both. Neither is an error.
 *   a MISSING PARENT is an error for both, with the SAME id —
 *     GetContentWriterDirectoryNotFoundError / ObjectNotFound /
 *     DirectoryNotFoundException / "Could not find a part of the path '<p>'."
 *   NEITHER EMITS ANYTHING without -PassThru. Both probes reported 0 objects.
 *   both continue after a per-path failure: `Set-Content s1,nodir/s2,s3`
 *     wrote s1 and s3 and raised one error.
 *   -Value is FLATTENED ALL THE WAY: @('a', @('b','c'), 'd') is four lines.
 *   -NoNewline drops EVERY terminator, not just the last: @('a','b','c')
 *     becomes the three bytes `abc`.
 *   the default encoding is UTF-8 with NO BOM: 'abc' is 97,98,99 + terminator.
 *
 * WHERE THEY DIVERGE — the four that matter
 *
 *   1. ON A DIRECTORY they raise DIFFERENT ERRORS. Set-Content reports
 *      `System.NotSupportedException` / NotSpecified, message "Unable to clear
 *      content of '<p>' because it is a directory. Clear-Content is only
 *      supported on files." — because Set-Content CLEARS first. Add-Content
 *      reports `WriteContainerContentException` / InvalidOperation, message
 *      "Unable to write content because it is a directory: '<p>'." A single
 *      shared arm would have been wrong for one of them.
 *
 *   2. Set-Content's FQID for an arbitrary provider exception is the EXCEPTION
 *      TYPE NAME — `System.UnauthorizedAccessException,…SetContentCommand` for
 *      a read-only file. That is the rule the other arms here follow.
 *
 *   3. ADD-CONTENT NEVER INSERTS A SEPARATOR. Appending 'CD' to the two bytes
 *      `ab` gives `abCD` + terminator, not `ab\nCD`. It appends value plus
 *      terminator to whatever is already there.
 *
 *   4. -Force IS NOT WHAT IT LOOKS LIKE. `Set-Content -Path no/x.txt -Force`
 *      FAILED with the same missing-parent error — it does NOT create parents,
 *      which is what a reader coming from New-Item expects. What it does do is
 *      override a read-only file: without it the write was refused, with it the
 *      content changed. That second half CANNOT be reproduced here and the
 *      manifest says so: this filesystem models POSIX permission BITS, not a
 *      Windows read-only ATTRIBUTE, and a write to a file whose mode denies it
 *      is refused whatever a switch says.
 *
 * -PassThru EMITS THE -Value OBJECT, ONCE PER SUCCESSFUL PATH — not a FileInfo,
 * and not the rendered lines. Measured directly: two paths and `-Value @('x','y')`
 * produced two `System.Object[]`, each rendering `x y`; `-Value 42` produced one
 * `System.Int32`; and a run where one of two paths failed produced ONE object.
 * (A single path with an array looks like two strings, which is the pipeline
 * unrolling one array — that reading is what the two-path probe rules out.)
 */

import type { PSValue } from '../../pipeline/psobject.ts';
import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import { decodeBytes, encodeText, resolveEncodingName } from '../../pipeline/encoding.ts';
import type { EncodingId } from '../../pipeline/encoding.ts';
import type { CommandManifest } from '../manifest.ts';
import { isBound, rawValue, stringArray, stringValue, switchValue } from '../powershell/support.ts';
import type { StorageError } from '../../storage/index.ts';
import {
  MESSAGES,
  cancellationShape,
  cancelled,
  contentBody,
  contentLines,
  exitFor,
  fsWriteManifest,
  reportError,
  requireFileSystem,
  storageShape,
} from './support.ts';
import type { PSErrorShape, ProviderErrorIds } from './support.ts';

// ---------------------------------------------------------------------------
// encodings
// ---------------------------------------------------------------------------

/**
 * `-Encoding` NAMES are resolved by the broker in `pipeline/encoding.ts`; the
 * bytes are produced by its `encodeText`. Nothing about an encoding is decided
 * here any more.
 *
 * THIS FILE USED TO OWN THE SECOND OF TWO ENCODING TABLES. The other lived in
 * `fs-read/get-content.ts`, and they had drifted:
 *
 *   - they disagreed about `ascii`. This one substituted '?' for anything
 *     outside 7 bits, which is right; that one decoded high bytes as
 *     windows-1252, which is not what pwsh does in either direction.
 *   - they disagreed about which names existed at all: `latin1` and `utf32`
 *     were recognised here and absent there.
 *   - neither agreed with pwsh about `oem`, which is UTF-8 on Ubuntu.
 *
 * One conversion implemented twice, drifting silently, is a shape this project
 * has now found five times. The table is gone; the names come from one place.
 *
 * The byte-level behaviour was MEASURED and is unchanged by this:
 *
 *   (default)   'abc' -> 97,98,99,<term>            UTF-8, no BOM
 *   utf8BOM     'abc' -> 239,187,191,97,98,99,...   the BOM, then UTF-8
 *   ascii       'aé'  -> 97,63,<term>               '?' for anything >= 0x80
 *   unicode     'ab'  -> 255,254,97,0,98,0,...      UTF-16LE with a BOM
 *   sausage     binding failure, ParameterArgumentTransformationError /
 *               InvalidData, "'sausage' is not a supported encoding name."
 *
 * WHY THE UTF-16 AND UTF-32 FAMILIES ARE STILL REFUSED, and why the reason in
 * the message CHANGED TWICE. It used to say Get-Content could not read them
 * back; that stopped being true when Get-Content started reading bytes and
 * sniffing the BOM. It then said `cat`, `grep` and `Select-String` would see
 * mojibake; that stopped being true when those three moved to
 * `readTextSniffed` as well. Every reader in this engine can now read a UTF-16
 * file.
 *
 * The reason that remains is the WRITE side, and it is structural.
 * `Add-Content` appends through `FileSystemPort.appendText`, which takes a
 * string; there is no `appendBytes` on the port, so an append cannot carry a
 * codec. Set-Content and Add-Content share one `-Encoding` contract here and in
 * pwsh, so supporting a codec on one and not the other would be a worse lie
 * than refusing both.
 *
 * Lifting it is now a small and well-understood change rather than an open
 * question: `VirtualFileSystem.appendBytes` already exists
 * (`src/storage/vfs.ts`), so the work is to surface it on the port and give
 * Add-Content the create-versus-append split Set-Content already has. It is not
 * done here because it widens this change into `ports.ts` for a capability
 * nothing yet asks for.
 */

/** What this engine can WRITE such that every reader in it can read it back. */
const WRITABLE: ReadonlySet<EncodingId> = new Set<EncodingId>(['utf8', 'utf8bom', 'ascii']);

type Encoding =
  | { readonly kind: 'ok'; readonly id: EncodingId; readonly name: string }
  | { readonly kind: 'refused'; readonly name: string; readonly why: string }
  | { readonly kind: 'unknown'; readonly name: string };

function encodingOf(raw: string | undefined): Encoding {
  const resolved = resolveEncodingName(raw);
  if (resolved.kind === 'unknown') return { kind: 'unknown', name: resolved.name };
  if (resolved.kind === 'unsupported') {
    return { kind: 'refused', name: resolved.name, why: resolved.why };
  }
  if (!WRITABLE.has(resolved.id)) {
    return {
      kind: 'refused',
      name: resolved.name,
      why:
        'This engine can produce those bytes and every reader here could read them back, ' +
        'but Add-Content appends through a port method that takes a string and cannot ' +
        'carry a codec, and the two content cmdlets share one -Encoding contract.',
    };
  }
  return { kind: 'ok', id: resolved.id, name: resolved.name };
}

/**
 * The text an APPEND writes: the codec's substitutions applied, preamble not.
 *
 * A preamble belongs at the start of a file, so appending one would put it in
 * the middle; the port has `appendText` and no `appendBytes`, so an append is
 * expressed as text. Only utf8, utf8BOM and ascii are writable here: the first
 * two append the body unchanged, and ascii's '?' substitution produces pure
 * 7-bit text, which is its own UTF-8 encoding. Round-tripping through the codec
 * is what keeps that substitution the ENCODER's rather than a second copy of it
 * living in this file, which is how the two tables drifted in the first place.
 */
function appendableText(body: string, id: EncodingId): string {
  return id === 'ascii' ? decodeBytes(encodeText(body, 'ascii'), 'utf8') : body;
}

// ---------------------------------------------------------------------------
// the two commands
// ---------------------------------------------------------------------------

interface Mode {
  readonly manifest: CommandManifest;
  readonly ids: ProviderErrorIds;
  readonly append: boolean;
  /** MEASURED, and different between the two. See divergence 1 in the header. */
  directoryShape(path: string): PSErrorShape;
}

/**
 * MEASURED: `System.UnauthorizedAccessException,…SetContentCommand` for a
 * read-only file, so this provider names the exception type where the item
 * cmdlets name a verb. `notFound` is the missing-parent id, because a missing
 * FILE is created rather than reported.
 */
const CONTENT_IDS: ProviderErrorIds = {
  io: 'System.IO.IOException',
  access: 'System.UnauthorizedAccessException',
  notFound: 'GetContentWriterDirectoryNotFoundError',
  argument: 'System.Management.Automation.PSArgumentException',
};

const SHARED_NOTES =
  'Really writes bytes to the browser filesystem. -Path, -LiteralPath, -Value, -NoNewline, ' +
  '-PassThru and -Encoding are implemented, and the byte-level behaviour was measured against ' +
  'pwsh 7.6.5: a missing file is created, a missing parent is an error that -Force does NOT fix, ' +
  '-Value is flattened all the way down and rendered with PowerShell ToString, -NoNewline drops ' +
  'every line terminator rather than only the last, and -PassThru emits the -Value object once ' +
  'per successful path. The terminator is LF, not the CRLF the Windows capture host produced: ' +
  'the emulated machine is Ubuntu and format/out-string.ts pins the same answer. -Encoding ' +
  'implements utf8, utf8NoBOM, utf8BOM and ascii; unicode, utf32, oem, ansi, latin1 and utf7 are ' +
  'recognised and REFUSED rather than written as UTF-8, because the storage layer decodes UTF-8 ' +
  'and a wrongly encoded file would be indistinguishable from a corrupt one. -Force is accepted ' +
  'and has no effect: in pwsh it clears a Windows read-only ATTRIBUTE, and this filesystem has ' +
  'POSIX permission BITS, which a switch cannot override. -Filter, -Include, -Exclude, -Stream, ' +
  '-AsByteStream and -Credential are not implemented.';

const SET_CONTENT_MANIFEST = fsWriteManifest(
  'set-content',
  `Replaces a file's contents. ${SHARED_NOTES} On a directory it reports the measured ` +
    'NotSupportedException about clearing content, which is a different error from the one ' +
    'Add-Content gives for the same path.',
);

const ADD_CONTENT_MANIFEST = fsWriteManifest(
  'add-content',
  `Appends to a file. ${SHARED_NOTES} It never inserts a separator: appending to a file with no ` +
    'trailing newline joins the two directly, which was measured. On a directory it reports ' +
    'WriteContainerContentException, which is a different error from Set-Content\'s for the same ' +
    'path.',
);

const SET_CONTENT: Mode = {
  manifest: SET_CONTENT_MANIFEST,
  ids: CONTENT_IDS,
  append: false,
  directoryShape: (path) => ({
    // MEASURED. The id really is the bare exception type name, and the message
    // talks about Clear-Content because Set-Content clears before it writes.
    id: 'System.NotSupportedException',
    category: 'NotSpecified',
    exceptionType: 'System.NotSupportedException',
    message:
      `Unable to clear content of '${path}' because it is a directory. Clear-Content is only ` +
      'supported on files.',
  }),
};

const ADD_CONTENT: Mode = {
  manifest: ADD_CONTENT_MANIFEST,
  ids: CONTENT_IDS,
  append: true,
  directoryShape: (path) => ({
    // MEASURED, and deliberately not shared with Set-Content's.
    id: 'WriteContainerContentException',
    category: 'InvalidOperation',
    exceptionType: 'System.InvalidOperationException',
    message: `Unable to write content because it is a directory: '${path}'.`,
  }),
};

/**
 * ENOENT and EISDIR are the two codes whose measured shape differs from the
 * shared provider mapping, so they are decided here and everything else falls
 * through to `storageShape`.
 */
function shapeFor(mode: Mode, error: StorageError, path: string): PSErrorShape {
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
    // MEASURED for both cmdlets: ObjectNotFound, not WriteError, and the
    // "could not find a PART of the path" wording that names a missing parent
    // rather than a missing file.
    return {
      id: mode.ids.notFound,
      category: 'ObjectNotFound',
      exceptionType: 'System.IO.DirectoryNotFoundException',
      message: MESSAGES.couldNotFindPart(path),
    };
  }
  if (error.code === 'EISDIR') return mode.directoryShape(path);
  return storageShape(error, mode.ids);
}

/**
 * The value to write.
 *
 * `-Value` binds from the pipeline (position 1, ValueFromPipeline) but the
 * binder cannot fill it: pipeline objects arrive at `context.input` while the
 * command runs. So an unbound -Value is collected from the input, which is what
 * makes `'p1','p2' | Set-Content -Path pipe.txt` write two lines — measured.
 */
async function valueOf(
  context: InvocationContext,
  bound: BindingResult,
): Promise<PSValue | undefined> {
  if (isBound(bound.parameters, 'Value')) return rawValue(bound.parameters, 'Value');
  const collected: PSValue[] = [];
  for await (const item of context.input) {
    if (cancelled(context)) break;
    collected.push(item);
  }
  if (collected.length === 0) return undefined;
  return collected.length === 1 ? collected[0] : collected;
}

function contentCommand(mode: Mode): CommandModule {
  return {
    manifest: mode.manifest,

    async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
      const port = await requireFileSystem(context, mode.manifest);
      if (port === null) return exitFor(1);

      const encoding = encodingOf(stringValue(bound.parameters, 'Encoding'));
      if (encoding.kind === 'unknown') {
        // MEASURED wording, from the binding-time transformation failure. It is
        // raised here rather than in the binder because `-Encoding` is declared
        // `System.Text.Encoding` and the binder has no encoding table.
        await reportError(
          context,
          mode.manifest,
          {
            id: 'ParameterArgumentTransformationError',
            category: 'InvalidData',
            exceptionType:
              'System.Management.Automation.ParameterBindingArgumentTransformationException',
            message:
              `Cannot process argument transformation on parameter 'Encoding'. ` +
              `'${encoding.name}' is not a supported encoding name. (Parameter 'name')`,
          },
          null,
        );
        return exitFor(1);
      }
      if (encoding.kind === 'refused') {
        await reportError(
          context,
          mode.manifest,
          {
            id: 'NotImplemented',
            category: 'NotImplemented',
            exceptionType: 'System.NotSupportedException',
            message:
              `-Encoding ${encoding.name} is recognised but not implemented by BrowserShell. ` +
              `${encoding.why} Writing it as UTF-8 anyway would be a silent wrong answer.`,
          },
          null,
        );
        return exitFor(1);
      }

      const specs = stringArray(bound.parameters, 'LiteralPath') ?? stringArray(bound.parameters, 'Path');
      if (specs === undefined || specs.length === 0) {
        await reportError(
          context,
          mode.manifest,
          {
            id: 'MissingMandatoryParameter',
            category: 'InvalidArgument',
            exceptionType: 'System.Management.Automation.ParameterBindingException',
            message:
              'Cannot process command because of one or more missing mandatory parameters: Path.',
          },
          null,
        );
        return exitFor(1);
      }

      const value = await valueOf(context, bound);
      const noNewline = switchValue(bound.parameters, 'NoNewline');
      const passThru = switchValue(bound.parameters, 'PassThru');
      const lines = contentLines(value);
      const body = contentBody(lines, noNewline);

      let failures = 0;
      const written: string[] = [];
      for (const spec of specs) {
        if (cancelled(context)) {
          await reportError(context, mode.manifest, cancellationShape(written), null);
          return exitFor(failures + 1);
        }
        const resolved = port.resolve(spec);
        if (!resolved.ok) {
          await reportError(context, mode.manifest, shapeFor(mode, resolved.error, spec), spec);
          failures += 1;
          continue;
        }
        const path = resolved.value.full;

        // A BOM belongs at the START of a file, so appending one to an existing
        // file would put it in the middle. The port has `appendText` but no
        // `appendBytes`, so the BOM case is expressed as the one write it
        // really is: create-with-BOM when there is nothing there yet, plain
        // append when there is.
        const existing = await port.stat(path);
        const creating = !existing.ok || existing.value.size === 0;
        // No WriteOptions: `createParents` would be wrong (MEASURED — even
        // -Force does not create a parent here), `exclusive` would break the
        // measured "a missing file is created", and `mode` is the storage
        // layer's default because pwsh does not let a content cmdlet choose one.
        // The codec produces the bytes, preamble included. Measured:
        //   Set-Content -Encoding ascii 'aé'   -> 61 3F
        //   Set-Content -Encoding utf8BOM 'abc' -> EF BB BF 61 62 63
        // Appending to a file that already has content writes text instead, so
        // a second BOM cannot land in the middle of one.
        const outcome =
          mode.append && !creating
            ? await port.appendText(path, appendableText(body, encoding.id))
            : await port.writeBytes(path, encodeText(body, encoding.id));

        if (!outcome.ok) {
          await reportError(context, mode.manifest, shapeFor(mode, outcome.error, path), path);
          failures += 1;
          continue;
        }
        written.push(path);
        // MEASURED: the -Value object itself, once per successful path.
        if (passThru && value !== undefined) await context.streams.success.write(value);
      }

      return exitFor(failures);
    },
  };
}

export const setContent: CommandModule = contentCommand(SET_CONTENT);
export const addContent: CommandModule = contentCommand(ADD_CONTENT);
