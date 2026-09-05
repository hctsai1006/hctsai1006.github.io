/**
 * Select-String (sls) — find text in files. The `grep` of the cmdlet world.
 *
 * WHAT THE PROBE CORRECTED:
 *
 * 1. `Matches` HOLDS ONE MATCH BY DEFAULT, even on a line with three. That is
 *    what `-AllMatches` is for:
 *
 *      pwsh: line 'alpha alpha alpha'
 *            default      ->  Matches.Count = 1
 *            -AllMatches  ->  Matches.Count = 3, at offsets 0, 6, 12
 *
 * 2. `-SimpleMatch` LEAVES `Matches` EMPTY — Count 0, not one synthetic match —
 *    and `-AllMatches` does not change that. So does `-NotMatch`.
 *
 * 3. A DIRECTORY IS SILENTLY IGNORED. No output AND no error:
 *
 *      pwsh: Select-String -Path sub -Pattern a -ErrorAction Stop  ->  0 items, no error
 *
 *    Get-Content raises GetContainerContentException for the same path. The two
 *    commands genuinely disagree, and reasoning from one to the other is wrong.
 *
 * 4. A WILDCARD THAT MATCHES NOTHING IS NOT AN ERROR, but a literal missing path
 *    is `PathNotFound,...SelectStringCommand`.
 *
 * 5. TWO PATTERNS MATCHING THE SAME LINE PRODUCE ONE MatchInfo, carrying the
 *    FIRST pattern that matched.
 *
 * 6. `-Quiet` EMITS A BOOLEAN EITHER WAY — `$false` is a value on the pipeline,
 *    not an absence — but `-List` overrides it and a MatchInfo comes out instead.
 *
 * 7. FROM THE PIPELINE, `Path` and `Filename` are the literal string
 *    `InputStream` and `LineNumber` is the index of the input OBJECT.
 *
 * 8. `-Context` DOES NOT PAD. At the first line of a file, `PreContext.Count` is
 *    0 rather than a run of empty strings.
 */

import { throwIfCancelled } from '../../pipeline/pipeline.ts';
import { psObject, toPSString } from '../../pipeline/psobject.ts';
import type { PSObject, PSValue } from '../../pipeline/psobject.ts';
import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import type { FileSystemPort } from '../ports.ts';
import { isBound, numberValue, rawValue, stringArray, switchValue } from '../powershell/support.ts';
import {
  basename,
  commandError,
  emit,
  fsReadManifest,
  matchesAny,
  readTextSniffed,
  requirePort,
  resolveTargets,
  SELECT_STRING,
  splitLines,
  storageErrorRecord,
} from './support.ts';
import type { FsErrorIds, Target } from './support.ts';

const MANIFEST = fsReadManifest('select-string');

/**
 * pwsh: Select-String -Path nope.txt -Pattern a
 *       -> PathNotFound,...SelectStringCommand, ObjectNotFound,
 *          System.Management.Automation.ItemNotFoundException
 *
 * No per-command access-denied id was measured: Select-String on a file with a
 * Deny ACE could not be reproduced, so the generic name stands and says so.
 */
export const SELECT_STRING_ERROR_IDS: FsErrorIds = {
  notFound: 'PathNotFound',
  accessDenied: 'UnauthorizedAccessError',
};

export const MATCH_INFO_TYPE_NAMES: readonly string[] = [
  'Microsoft.PowerShell.Commands.MatchInfo',
  'System.Object',
];
export const MATCH_INFO_CONTEXT_TYPE_NAMES: readonly string[] = [
  'Microsoft.PowerShell.Commands.MatchInfoContext',
  'System.Object',
];
const MATCH_TYPE_NAMES: readonly string[] = [
  'System.Text.RegularExpressions.Match',
  'System.Text.RegularExpressions.Group',
  'System.Text.RegularExpressions.Capture',
  'System.Object',
];
const GROUP_TYPE_NAMES: readonly string[] = [
  'System.Text.RegularExpressions.Group',
  'System.Text.RegularExpressions.Capture',
  'System.Object',
];

/** What pwsh puts in `Path` and `Filename` for pipeline input. Measured. */
export const INPUT_STREAM = 'InputStream';

interface Options {
  readonly patterns: readonly string[];
  readonly simpleMatch: boolean;
  readonly caseSensitive: boolean;
  readonly notMatch: boolean;
  readonly allMatches: boolean;
  readonly list: boolean;
  readonly quiet: boolean;
  readonly raw: boolean;
  readonly preContext: number;
  readonly postContext: number;
  readonly wantsContext: boolean;
  readonly include: readonly string[] | undefined;
  readonly exclude: readonly string[] | undefined;
}

interface Matcher {
  /** The pattern text, as `MatchInfo.Pattern` reports it. */
  readonly source: string;
  test(line: string): boolean;
  matches(line: string): readonly PSObject[];
}

/**
 * `System.Text.RegularExpressions.Group` as a PSObject.
 *
 * pwsh: Select-String -Pattern '(al)(pha)'
 *       -> Groups: 0=alpha, 1=al, 2=pha   (group 0 is the whole match)
 */
function groupObject(name: string, value: string | undefined, index: number): PSObject {
  return psObject(
    {
      Name: name,
      Value: value ?? '',
      Index: value === undefined ? -1 : index,
      Length: value === undefined ? 0 : value.length,
      Success: value !== undefined,
    },
    GROUP_TYPE_NAMES,
  );
}

/**
 * One `Match`.
 *
 * `Captures` and `ValueSpan` are on the real type and are NOT emitted: a
 * `ReadOnlySpan<char>` has no pipeline representation at all, and `Captures`
 * only differs from `Groups` for patterns with quantified groups, which this
 * engine's regex (JavaScript's, not .NET's) does not expose.
 */
function matchObject(match: RegExpExecArray): PSObject {
  const groups: PSValue[] = match.map((value, index) =>
    groupObject(String(index), value, match.index),
  );
  return psObject(
    {
      Value: match[0],
      Index: match.index,
      Length: match[0].length,
      Success: true,
      Name: '0',
      Groups: groups,
    },
    MATCH_TYPE_NAMES,
  );
}

function buildMatcher(pattern: string, options: Options): Matcher | Error {
  if (options.simpleMatch) {
    const needle = options.caseSensitive ? pattern : pattern.toLowerCase();
    return {
      source: pattern,
      test: (line) => (options.caseSensitive ? line : line.toLowerCase()).includes(needle),
      // Note 2: -SimpleMatch never populates Matches, with or without -AllMatches.
      matches: () => [],
    };
  }
  let regexp: RegExp;
  try {
    // Deliberately NOT the `u` flag. These are user patterns aimed at .NET's
    // engine, and `u` rejects constructs .NET accepts (a bare `{`, `\d{` and
    // several escapes), which would turn a working pattern into an error.
    regexp = new RegExp(pattern, options.caseSensitive ? 'g' : 'gi');
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  return {
    source: pattern,
    test: (line) => {
      regexp.lastIndex = 0;
      return regexp.test(line);
    },
    matches: (line) => {
      regexp.lastIndex = 0;
      const out: PSObject[] = [];
      let hit = regexp.exec(line);
      while (hit !== null) {
        out.push(matchObject(hit));
        // Note 1: without -AllMatches only the first match is carried.
        if (!options.allMatches) break;
        if (hit[0].length === 0) regexp.lastIndex += 1;
        hit = regexp.exec(line);
      }
      return out;
    },
  };
}

function contextObject(
  lines: readonly string[],
  index: number,
  options: Options,
): PSObject {
  // Note 8: no padding. `slice` naturally yields fewer lines near the edges.
  const pre = lines.slice(Math.max(0, index - options.preContext), index);
  const post = lines.slice(index + 1, index + 1 + options.postContext);
  return psObject(
    {
      PreContext: [...pre],
      PostContext: [...post],
      // Real pwsh trims a Display* list when adjacent lines are themselves
      // matches; with one match they are equal, which is what was measured.
      // Modelling the trim would need the whole result set, which Select-String
      // does not have while it is still streaming.
      DisplayPreContext: [...pre],
      DisplayPostContext: [...post],
    },
    MATCH_INFO_CONTEXT_TYPE_NAMES,
  );
}

/**
 * The MatchInfo. Property order is .NET's declaration order, which is what a
 * `Format-List` follows; `Get-Member` reports them alphabetically and that is
 * the member table's ordering, not the object's.
 */
function matchInfo(
  options: Options,
  path: string,
  fileName: string,
  lineNumber: number,
  line: string,
  pattern: string,
  matches: readonly PSObject[],
  context: PSObject | null,
): PSObject {
  return psObject(
    {
      IgnoreCase: !options.caseSensitive,
      LineNumber: lineNumber,
      Line: line,
      Filename: fileName,
      Path: path,
      Pattern: pattern,
      Context: context,
      Matches: [...matches],
    },
    MATCH_INFO_TYPE_NAMES,
  );
}

interface Scan {
  /** True when the caller should stop: the consumer left, or -Quiet answered. */
  readonly stop: boolean;
  readonly matched: boolean;
}

async function scanLines(
  context: InvocationContext,
  options: Options,
  matchers: readonly Matcher[],
  lines: readonly string[],
  path: string,
  fileName: string,
): Promise<Scan> {
  let matched = false;
  for (let index = 0; index < lines.length; index += 1) {
    throwIfCancelled(context.signal, 'Select-String');
    const line = lines[index] ?? '';

    const hit = matchers.find((matcher) => matcher.test(line));
    // Note 5: the FIRST pattern that matched is the one reported.
    const keep = options.notMatch ? hit === undefined : hit !== undefined;
    if (!keep) continue;
    matched = true;

    // Note 6: -Quiet answers True and stops, unless -List overrode it.
    if (options.quiet && !options.list) {
      await emit(context.streams.success, context.signal, true);
      return { stop: true, matched: true };
    }

    const value: PSValue = options.raw
      ? line
      : matchInfo(
          options,
          path,
          fileName,
          index + 1,
          line,
          hit?.source ?? (options.patterns[0] ?? ''),
          // Note 2: -NotMatch carries no matches either.
          options.notMatch || hit === undefined ? [] : hit.matches(line),
          options.wantsContext ? contextObject(lines, index, options) : null,
        );

    if (!(await emit(context.streams.success, context.signal, value))) {
      return { stop: true, matched: true };
    }
    // Note: -List is the FIRST match per file, so the scan of this file ends.
    if (options.list) return { stop: false, matched: true };
  }
  return { stop: false, matched };
}

export const selectString: CommandModule = {
  manifest: MANIFEST,

  async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
    const parameters = bound.parameters;

    for (const unsupported of ['Culture', 'NoEmphasis'] as const) {
      if (isBound(parameters, unsupported)) {
        await context.streams.error.write(
          commandError(
            SELECT_STRING,
            `-${unsupported} is not implemented. ` +
              (unsupported === 'Culture'
                ? 'String comparison here is pinned to the invariant "en" collation; see psobject.ts.'
                : 'Emphasis is a rendering decision and this engine emits objects, not coloured text.'),
            'ParameterNotImplemented',
            'NotImplemented',
            'System.NotImplementedException',
          ),
        );
        return 1;
      }
    }

    const patterns = stringArray(parameters, 'Pattern');
    if (patterns === undefined || patterns.length === 0) {
      await context.streams.error.write(
        commandError(
          SELECT_STRING,
          'Cannot process command because of one or more missing mandatory parameters: Pattern.',
          'MissingMandatoryParameter',
          'InvalidArgument',
          'System.Management.Automation.ParameterBindingException',
        ),
      );
      return 1;
    }
    for (const pattern of patterns) {
      if (pattern === '') {
        // pwsh: -Pattern '' -> ParameterArgumentValidationErrorEmptyStringNotAllowed
        await context.streams.error.write(
          commandError(
            SELECT_STRING,
            "Cannot validate argument on parameter 'Pattern'. The argument is null or empty. " +
              'Provide an argument that is not null or empty, and then try the command again.',
            'ParameterArgumentValidationErrorEmptyStringNotAllowed',
            'InvalidData',
            'System.Management.Automation.ParameterBindingException',
          ),
        );
        return 1;
      }
    }

    const contextSpec = contextWindow(parameters);
    const options: Options = {
      patterns,
      simpleMatch: switchValue(parameters, 'SimpleMatch'),
      caseSensitive: switchValue(parameters, 'CaseSensitive'),
      notMatch: switchValue(parameters, 'NotMatch'),
      allMatches: switchValue(parameters, 'AllMatches'),
      list: switchValue(parameters, 'List'),
      quiet: switchValue(parameters, 'Quiet'),
      raw: switchValue(parameters, 'Raw'),
      preContext: contextSpec.pre,
      postContext: contextSpec.post,
      wantsContext: contextSpec.given,
      include: stringArray(parameters, 'Include'),
      exclude: stringArray(parameters, 'Exclude'),
    };

    const matchers: Matcher[] = [];
    for (const pattern of patterns) {
      const built = buildMatcher(pattern, options);
      if (built instanceof Error) {
        // pwsh: -Pattern '[' -> InvalidRegex,...SelectStringCommand,
        //   "The string [ is not a valid regular expression: Invalid pattern '['
        //    at offset 1. Unterminated [] set."
        // The sentence after the colon is .NET's parser talking; JavaScript's
        // wording differs and is passed through rather than faked.
        await context.streams.error.write(
          commandError(
            SELECT_STRING,
            `The string ${pattern} is not a valid regular expression: ${built.message}`,
            'InvalidRegex',
            'InvalidArgument',
            'System.ArgumentException',
            pattern,
          ),
        );
        return 1;
      }
      matchers.push(built);
    }

    const literal = stringArray(parameters, 'LiteralPath');
    const paths = literal ?? stringArray(parameters, 'Path');

    if (paths === undefined || paths.length === 0) {
      return scanPipeline(context, options, matchers);
    }

    const fs = await requirePort(context, SELECT_STRING);
    if (fs === null) return 1;

    let anyMatch = false;
    for (const raw of paths) {
      throwIfCancelled(context.signal, 'Select-String');
      const targets =
        literal === undefined
          ? await resolveTargets(fs, context, SELECT_STRING, raw, { ids: SELECT_STRING_ERROR_IDS })
          : await literalTarget(fs, context, raw);

      for (const target of targets) {
        // Note 3: a directory is skipped in silence.
        if (target.stat.kind === 'directory') continue;
        if (options.include !== undefined && !matchesAny(target.stat.name, options.include)) continue;
        if (options.exclude !== undefined && matchesAny(target.stat.name, options.exclude)) continue;

        const result = await scanFile(fs, context, options, matchers, target);
        anyMatch = anyMatch || result.matched;
        if (result.stop) return 0;
      }
    }

    // Note 6: -Quiet always answers, and `$false` is an answer.
    if (options.quiet && !options.list && !anyMatch) {
      await emit(context.streams.success, context.signal, false);
    }
    return 0;
  },
};

function contextWindow(parameters: BindingResult['parameters']): {
  pre: number;
  post: number;
  given: boolean;
} {
  const raw = rawValue(parameters, 'Context');
  if (raw === undefined || raw === null) return { pre: 0, post: 0, given: false };
  if (Array.isArray(raw)) {
    const numbers = raw.map((value) => Number(toPSString(value as PSValue)));
    // pwsh: -Context 2,0 -> two lines before, none after.
    const pre = Number.isFinite(numbers[0]) ? (numbers[0] ?? 0) : 0;
    const post = numbers.length > 1 && Number.isFinite(numbers[1]) ? (numbers[1] ?? 0) : pre;
    return { pre, post, given: true };
  }
  const single = numberValue(parameters, 'Context') ?? 0;
  return { pre: single, post: single, given: true };
}

async function scanFile(
  fs: FileSystemPort,
  context: InvocationContext,
  options: Options,
  matchers: readonly Matcher[],
  target: Target,
): Promise<Scan> {
  const text = await readTextSniffed(fs, target.resolved.full);
  if (!text.ok) {
    await context.streams.error.write(
      storageErrorRecord(SELECT_STRING, text.error, target.resolved.full, SELECT_STRING_ERROR_IDS),
    );
    return { stop: false, matched: false };
  }
  return scanLines(
    context,
    options,
    matchers,
    splitLines(text.value),
    target.resolved.full,
    basename(target.resolved.path),
  );
}

/**
 * The pipeline form. Note 7: every object becomes one "line", `Path` and
 * `Filename` are `InputStream`, and `LineNumber` counts input objects.
 *
 * `-Context` is honoured over the objects seen SO FAR plus the ones that follow,
 * which means the whole stream has to be buffered before any context can be
 * reported. pwsh buffers too — it has to — so the memory shape is the same.
 */
async function scanPipeline(
  context: InvocationContext,
  options: Options,
  matchers: readonly Matcher[],
): Promise<number> {
  const lines: string[] = [];
  for await (const item of context.input) {
    throwIfCancelled(context.signal, 'Select-String');
    lines.push(toPSString(item));
  }
  const result = await scanLines(context, options, matchers, lines, INPUT_STREAM, INPUT_STREAM);
  if (options.quiet && !options.list && !result.matched) {
    await emit(context.streams.success, context.signal, false);
  }
  return 0;
}

async function literalTarget(
  fs: FileSystemPort,
  context: InvocationContext,
  raw: string,
): Promise<readonly Target[]> {
  const resolved = fs.resolve(raw);
  if (!resolved.ok) {
    await context.streams.error.write(
      storageErrorRecord(SELECT_STRING, resolved.error, raw, SELECT_STRING_ERROR_IDS),
    );
    return [];
  }
  const stat = await fs.stat(resolved.value.full);
  if (!stat.ok) {
    await context.streams.error.write(
      storageErrorRecord(SELECT_STRING, stat.error, resolved.value.full, SELECT_STRING_ERROR_IDS),
    );
    return [];
  }
  return [{ raw, resolved: resolved.value, stat: stat.value }];
}
