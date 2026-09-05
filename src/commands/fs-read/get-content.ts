/**
 * Get-Content (gc, type) — read a file.
 *
 * WHAT THE PROBE CORRECTED. The default shape of this command is the single
 * most commonly mis-implemented thing in the set, and four separate assumptions
 * turned out to be wrong:
 *
 * 1. THE DEFAULT IS AN ARRAY OF LINES, and a trailing newline does NOT add an
 *    empty one:
 *
 *      pwsh: "one\ntwo\nthree\n"  ->  3 items
 *      pwsh: "one\ntwo\nthree"    ->  3 items
 *
 * 2. AN EMPTY FILE EMITS NOTHING — not one empty string:
 *
 *      pwsh: @(Get-Content empty.txt).Count       ->  0
 *      pwsh: Get-Content empty.txt -eq $null      ->  True
 *
 *    and `-Raw` on an empty file emits nothing EITHER, which is the surprise:
 *
 *      pwsh: @(Get-Content empty.txt -Raw).Count  ->  0
 *
 *    An implementation that returned '' for -Raw would be wrong in a way that
 *    only shows up on the empty case.
 *
 * 3. A LONE CARRIAGE RETURN IS A LINE SEPARATOR. `"a\rb"` is two lines. Splitting
 *    on "\n" alone silently concatenates old-Mac text.
 *
 * 4. `-TotalCount` AND `-Tail` ARE PER FILE, NOT PER COMMAND:
 *
 *      pwsh: Get-Content alpha.txt, trail.txt -TotalCount 2  ->  4 items
 *      pwsh: Get-Content alpha.txt, trail.txt -Tail 1        ->  2 items
 *
 * The three parameter conflicts are terminating and were read off pwsh verbatim:
 *
 *   -TotalCount with -Tail  ->  TailAndHeadCannotCoexist
 *                               "The parameters TotalCount and Tail cannot be
 *                                used together. Please specify only one parameter."
 *   -Raw with -TotalCount   ->  InvalidOperation
 *                               "The 'Raw' and 'TotalCount' parameters cannot be
 *                                specified in the same command."
 *   -Raw with -Tail         ->  the same sentence with 'Tail'
 *
 * And the two failure modes:
 *
 *   missing file  ->  PathNotFound, ObjectNotFound, ItemNotFoundException,
 *                     "Cannot find path '<full>' because it does not exist."
 *   a directory   ->  GetContainerContentException, InvalidOperation,
 *                     System.InvalidOperationException,
 *                     "Unable to get content because it is a directory: '<full>'.
 *                      Please use 'Get-ChildItem' instead."
 *
 * Both are NON-TERMINATING: `Get-Content nope.txt, notrail.txt` reports the
 * error and still emits the second file's line.
 */

import { throwIfCancelled } from '../../pipeline/pipeline.ts';
import { decodeFile, resolveEncodingName } from '../../pipeline/encoding.ts';
import type { EncodingId } from '../../pipeline/encoding.ts';
import type { PSValue } from '../../pipeline/psobject.ts';
import type { ErrorRecord } from '../../pipeline/streams.ts';
import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import type { FileSystemPort } from '../ports.ts';
import { isBound, numberValue, stringArray, stringValue, switchValue } from '../powershell/support.ts';
import {
  GET_CONTENT,
  commandError,
  emit,
  fsReadManifest,
  hasWildcard,
  matchesAny,
  requirePort,
  resolveTargets,
  splitLines,
  splitOnDelimiter,
  storageErrorRecord,
} from './support.ts';
import type { FsErrorIds, Target } from './support.ts';

const MANIFEST = fsReadManifest('get-content');

/**
 * pwsh: Get-Content <file with a Deny ACE>
 *       -> GetContentReaderUnauthorizedAccessError,...GetContentCommand
 *          PermissionDenied, System.UnauthorizedAccessException,
 *          "Access to the path '<full>' is denied."
 */
export const GET_CONTENT_ERROR_IDS: FsErrorIds = {
  notFound: 'PathNotFound',
  accessDenied: 'GetContentReaderUnauthorizedAccessError',
  isDirectory: 'GetContainerContentException',
};
const IDS = GET_CONTENT_ERROR_IDS;

/**
 * `-Encoding` is resolved and applied by the broker in `pipeline/encoding.ts`,
 * not here.
 *
 * THIS FILE USED TO OWN A DECODER TABLE, and it was wrong in two ways that only
 * a measurement could show. It mapped the PowerShell names `ascii`, `ansi` and
 * `oem` all onto the WHATWG label `windows-1252`. Measured on pwsh 7.6.5 over
 * the bytes 61 E9 80 7A, those three names produce three different strings:
 *
 *   -Encoding ascii   ->  U+0061 U+003F U+003F U+007A   ('?', not cp1252)
 *   -Encoding ansi    ->  U+0061 U+00E9 U+20AC U+007A   (cp1252, on Ubuntu)
 *   -Encoding oem     ->  U+0061 U+FFFD U+007A          (UTF-8, on Ubuntu)
 *
 * and `TextDecoder('windows-1252')` itself decodes 0x80 as U+0080 under Node
 * and U+20AC under Chrome, so the table was not even self-consistent between
 * the test suite and the shipped runtime.
 *
 * It also did no BOM sniffing, which pwsh does unconditionally: a UTF-16LE file
 * read with `-Encoding utf8` still comes back as text there and came back as
 * mojibake here.
 *
 * The names pwsh 7.6.5 BINDS were confirmed by round-tripping each one:
 *
 *   pwsh: ascii ansi bigendianunicode bigendianutf32 oem unicode utf7 utf8
 *         utf8BOM utf8NoBOM utf32 latin1 default  ->  all accepted
 *   pwsh: -Encoding Byte     ->  ParameterArgumentTransformationError
 *                                (removed in PowerShell 6; -AsByteStream
 *                                 replaced it)
 *   pwsh: -Encoding sausage  ->  ParameterArgumentTransformationError
 */

interface Options {
  readonly raw: boolean;
  readonly asBytes: boolean;
  readonly totalCount: number | undefined;
  readonly tail: number | undefined;
  readonly readCount: number | undefined;
  readonly delimiter: string | undefined;
  /** Already resolved: the binder-shaped failures happen before any file is opened. */
  readonly codec: EncodingId;
  readonly force: boolean;
  readonly filter: string | undefined;
  readonly include: readonly string[] | undefined;
  readonly exclude: readonly string[] | undefined;
}

/** `-TotalCount n` then `-Tail n`, applied to whatever the units are. */
function window<T>(items: readonly T[], options: Options): readonly T[] {
  if (options.totalCount !== undefined) return items.slice(0, Math.max(0, options.totalCount));
  if (options.tail !== undefined) {
    const n = Math.max(0, options.tail);
    return n === 0 ? [] : items.slice(-n);
  }
  return items;
}

/**
 * Turn the `-Encoding` argument into a codec, or into the error pwsh gives.
 *
 * The two failure modes are DIFFERENT errors and were measured separately:
 *
 *   pwsh: Get-Content -Encoding sausage
 *     -> ParameterArgumentTransformationError,…GetContentCommand, InvalidData,
 *        "Cannot process argument transformation on parameter 'Encoding'.
 *         'sausage' is not a supported encoding name. (Parameter 'name')"
 *   pwsh: Get-Content -Encoding utf7
 *     -> SUCCEEDS, with "WARNING: Encoding 'UTF-7' is obsolete, please use UTF-8."
 *
 * So an unknown name is a BINDING failure that never opens the file, and utf7
 * is a name this engine recognises and cannot perform. Reporting the second as
 * the first would claim pwsh rejects something it accepts.
 */
function codecFor(encoding: string | undefined): EncodingId | ErrorRecord {
  const resolved = resolveEncodingName(encoding);
  if (resolved.kind === 'ok') return resolved.id;
  if (resolved.kind === 'unknown') {
    return commandError(
      GET_CONTENT,
      `Cannot process argument transformation on parameter 'Encoding'. ` +
        `'${resolved.name}' is not a supported encoding name. (Parameter 'name')`,
      'ParameterArgumentTransformationError',
      'InvalidData',
      'System.Management.Automation.ParameterBindingArgumentTransformationException',
    );
  }
  return commandError(
    GET_CONTENT,
    `-Encoding ${resolved.name} is accepted by PowerShell but is not implemented by ` +
      `BrowserShell. ${resolved.why}`,
    'EncodingNotImplemented',
    'NotImplemented',
    'System.NotImplementedException',
  );
}

/** `-ReadCount n` batches lines into arrays. `-ReadCount 0` is one array. */
function batched(lines: readonly string[], readCount: number | undefined): readonly PSValue[] {
  if (readCount === undefined || readCount === 1) return [...lines];
  // pwsh: Get-Content trail.txt -ReadCount 0 -> one System.Object[] of 3
  if (readCount <= 0) return lines.length === 0 ? [] : [[...lines]];
  const out: PSValue[] = [];
  for (let index = 0; index < lines.length; index += readCount) {
    out.push(lines.slice(index, index + readCount));
  }
  return out;
}

async function readOne(
  fs: FileSystemPort,
  context: InvocationContext,
  target: Target,
  options: Options,
): Promise<boolean> {
  if (target.stat.kind === 'directory') {
    await context.streams.error.write(
      storageErrorRecord(
        GET_CONTENT,
        {
          code: 'EISDIR',
          path: target.resolved.full,
          syscall: 'read',
          message: 'is a directory',
        },
        target.resolved.full,
        IDS,
      ),
    );
    return true;
  }

  const bytes = await fs.readBytes(target.resolved.full);
  if (!bytes.ok) {
    await context.streams.error.write(
      storageErrorRecord(GET_CONTENT, bytes.error, target.resolved.full, IDS),
    );
    return true;
  }

  if (options.asBytes) {
    // pwsh: Get-Content bytes.bin -AsByteStream        -> 4 System.Byte objects
    //       Get-Content bytes.bin -AsByteStream -Raw   -> one System.Byte[]
    //       -TotalCount 2 / -Tail 2 count BYTES here, measured: 0,1 and 2,255
    const selected = window([...bytes.value], options);
    if (options.raw) {
      return selected.length === 0
        ? true
        : emit(context.streams.success, context.signal, Uint8Array.from(selected));
    }
    for (const byte of selected) {
      if (!(await emit(context.streams.success, context.signal, byte))) return false;
    }
    return true;
  }

  // decodeFile, not decodeBytes: pwsh sniffs the BOM here and the sniff
  // OVERRIDES -Encoding. Measured, `Get-Content -Raw`:
  //   FF FE 61 00     with -Encoding utf8   ->  U+0061   (utf16LE wins)
  //   EF BB BF 61     with -Encoding ascii  ->  U+0061   (the BOM is consumed)
  // Decoding with the requested codec alone returns mojibake for both.
  const text = decodeFile(bytes.value, options.codec);

  if (options.raw) {
    // Note 2: an empty file emits nothing at all, -Raw included.
    if (text.length === 0) return true;
    return emit(context.streams.success, context.signal, text);
  }

  const pieces =
    options.delimiter === undefined ? splitLines(text) : splitOnDelimiter(text, options.delimiter);
  for (const value of batched(window(pieces, options), options.readCount)) {
    if (!(await emit(context.streams.success, context.signal, value))) return false;
  }
  return true;
}

export const getContent: CommandModule = {
  manifest: MANIFEST,

  async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
    const parameters = bound.parameters;
    const fs = await requirePort(context, GET_CONTENT);
    if (fs === null) return 1;

    // -Wait tails a growing file, -Stream reads an NTFS alternate data stream
    // and -Credential authenticates to a remote provider. None of the three has
    // anything to bind to here, and silently ignoring -Wait would turn "follow
    // this log" into "print it once and exit".
    for (const unsupported of ['Wait', 'Stream', 'Credential'] as const) {
      if (isBound(parameters, unsupported)) {
        await context.streams.error.write(
          commandError(
            GET_CONTENT,
            `-${unsupported} is not implemented. This filesystem has no growing files, no ` +
              'alternate data streams and no remote providers.',
            'ParameterNotImplemented',
            'NotImplemented',
            'System.NotImplementedException',
          ),
        );
        return 1;
      }
    }

    const raw = switchValue(parameters, 'Raw');
    const totalCount = numberValue(parameters, 'TotalCount');
    const tail = numberValue(parameters, 'Tail');

    // The three conflicts, verbatim from pwsh. Terminating: nothing is read.
    if (totalCount !== undefined && tail !== undefined) {
      await context.streams.error.write(
        commandError(
          GET_CONTENT,
          'The parameters TotalCount and Tail cannot be used together. Please specify only one parameter.',
          'TailAndHeadCannotCoexist',
          'InvalidOperation',
          'System.InvalidOperationException',
        ),
      );
      return 1;
    }
    for (const [name, value] of [
      ['TotalCount', totalCount],
      ['Tail', tail],
    ] as const) {
      if (raw && value !== undefined) {
        await context.streams.error.write(
          commandError(
            GET_CONTENT,
            `The 'Raw' and '${name}' parameters cannot be specified in the same command.`,
            'InvalidOperation',
            'InvalidOperation',
            'System.InvalidOperationException',
          ),
        );
        return 1;
      }
    }
    // pwsh: -TotalCount -1 -> ValidateRange, "The -1 argument is less than the
    // minimum allowed range of 0." The binder owns that check; this is the
    // backstop for a caller that bypassed it.
    for (const [name, value] of [
      ['TotalCount', totalCount],
      ['Tail', tail],
    ] as const) {
      if (value !== undefined && value < 0) {
        await context.streams.error.write(
          commandError(
            GET_CONTENT,
            `Cannot validate argument on parameter '${name}'. The ${String(value)} argument is ` +
              'less than the minimum allowed range of 0. Supply an argument that is greater than ' +
              'or equal to 0 and then try the command again.',
            'ParameterArgumentValidationError',
            'InvalidData',
            'System.Management.Automation.ValidationMetadataException',
          ),
        );
        return 1;
      }
    }

    // Resolved BEFORE any path is touched. In pwsh an unusable -Encoding is a
    // parameter-binding failure, so it happens before the provider is reached
    // and no file is opened; emitting it per file would report it once per
    // path and only after the first read had already succeeded.
    const codec = codecFor(stringValue(parameters, 'Encoding'));
    if (typeof codec !== 'string') {
      await context.streams.error.write(codec);
      return 1;
    }

    const options: Options = {
      raw,
      asBytes: switchValue(parameters, 'AsByteStream'),
      totalCount,
      tail,
      readCount: numberValue(parameters, 'ReadCount'),
      delimiter: stringValue(parameters, 'Delimiter'),
      codec,
      force: switchValue(parameters, 'Force'),
      filter: stringValue(parameters, 'Filter'),
      include: stringArray(parameters, 'Include'),
      exclude: stringArray(parameters, 'Exclude'),
    };

    const literal = stringArray(parameters, 'LiteralPath');
    const paths = literal ?? stringArray(parameters, 'Path');
    if (paths === undefined || paths.length === 0) {
      // v1's wording, kept because the binder is what produces this in real
      // pwsh and v1 is the specification for the message this engine shows.
      await context.streams.error.write(
        commandError(
          GET_CONTENT,
          'Cannot process command because of one or more missing mandatory parameters: Path.',
          'MissingMandatoryParameter',
          'InvalidArgument',
          'System.Management.Automation.ParameterBindingException',
        ),
      );
      return 1;
    }

    for (const path of paths) {
      throwIfCancelled(context.signal, 'Get-Content');

      const targets =
        literal === undefined
          ? await resolveTargets(fs, context, GET_CONTENT, path, {
              force: options.force,
              ids: IDS,
            })
          : await literalTarget(fs, context, path);

      // pwsh: Get-Content 'zz*.txt'
      //   ItemNotFound,...GetContentCommand, ObjectNotFound,
      //   "An object at the specified path zz*.txt does not exist, or has been
      //    filtered by the -Include or -Exclude parameter."
      // Note the RAW pattern in the message, and note that Get-ChildItem stays
      // SILENT for the same non-matching wildcard. The two commands genuinely
      // differ.
      const kept = targets.filter((target) => {
        if (options.filter !== undefined && !matchesAny(target.stat.name, [options.filter])) {
          return false;
        }
        if (options.include !== undefined && !matchesAny(target.stat.name, options.include)) {
          return false;
        }
        if (options.exclude !== undefined && matchesAny(target.stat.name, options.exclude)) {
          return false;
        }
        return true;
      });

      // A literal name that does not exist already produced PathNotFound inside
      // `resolveTargets`, and pwsh reports exactly ONE error for it — so this
      // second message fires only for the two cases that produced no target
      // WITHOUT an error: a wildcard that matched nothing, and a set of matches
      // that -Include/-Exclude then emptied.
      const globbedMiss = literal === undefined && hasWildcard(path) && targets.length === 0;
      const filteredOut = targets.length > 0 && kept.length === 0;
      if (globbedMiss || filteredOut) {
        await context.streams.error.write(
          commandError(
            GET_CONTENT,
            `An object at the specified path ${path} does not exist, or has been filtered by ` +
              'the -Include or -Exclude parameter.',
            'ItemNotFound',
            'ObjectNotFound',
            'System.Exception',
            path,
          ),
        );
        continue;
      }

      for (const target of kept) {
        if (!(await readOne(fs, context, target, options))) return 0;
      }
    }
    return 0;
  },
};

async function literalTarget(
  fs: FileSystemPort,
  context: InvocationContext,
  raw: string,
): Promise<readonly Target[]> {
  const resolved = fs.resolve(raw);
  if (!resolved.ok) {
    await context.streams.error.write(storageErrorRecord(GET_CONTENT, resolved.error, raw, IDS));
    return [];
  }
  const stat = await fs.stat(resolved.value.full);
  if (!stat.ok) {
    await context.streams.error.write(
      storageErrorRecord(GET_CONTENT, stat.error, resolved.value.full, IDS),
    );
    return [];
  }
  return [{ raw, resolved: resolved.value, stat: stat.value }];
}
