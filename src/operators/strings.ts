/**
 * strings.ts — `-replace -match -like -split -join` and their case variants.
 *
 * CASE SENSITIVITY: THE DEFAULT IS INSENSITIVE, FOR ALL OF THEM
 *
 * Every string operator was probed rather than assumed, because a regex engine
 * defaults the other way and copying that default would be wrong on every one:
 *
 *   'ABC' -replace 'b','x'  ->  AxC      'ABC' -creplace 'b','x'  ->  ABC
 *   'ABC' -match 'b'        ->  True     'ABC' -cmatch 'b'        ->  False
 *   'abc' -like 'A*'        ->  True     'abc' -clike 'A*'        ->  False
 *   'aXb' -split 'x'        ->  a, b     'aXb' -csplit 'x'        ->  aXb
 *   @('a') -contains 'A'    ->  True     @('a') -ccontains 'A'    ->  False
 *   'A' -in @('a')          ->  True     'A' -cin @('a')          ->  False
 *
 * `-join` is the exception, and of a different kind: it has NO case variants at
 * all. `-cjoin` and `-ijoin` are not operators — every `c`/`i` spelling was fed
 * to `[Parser]::ParseInput` and those two, alone, failed to parse.
 *
 * WHAT AN ARRAY LEFT OPERAND DOES — AND IT IS NOT ONE ANSWER
 *
 *   -match -notmatch -like -notlike     FILTER. Object[] of the ORIGINAL
 *                                       elements, not of strings:
 *                                       @(1,12,3) -match '1' -> Int32 1, Int32 12
 *   -replace                            MAPS. Object[] of replaced strings.
 *   -split                              CONCATENATES each element's split into
 *                                       one String[].
 *   -contains -notcontains -in -notin   BOOLEAN. These never filter.
 *   -join                               one String.
 *
 * A filtering result is ALWAYS `System.Object[]`, even with one hit and even
 * with none — `$null -eq (@(1,2,3) -eq 9)` is False, it is an empty array. Same
 * shape as `-eq` on an array, which comparison.ts implements.
 *
 * WHICH STRING CONVERSION THESE USE
 *
 * `-replace`, `-like`, `-match` and `-split` are culture-INVARIANT, so they use
 * `toPSString`. Measured under en-US, de-DE and zh-TW, where a culture-following
 * conversion would show:
 *
 *   1.5 -replace '\.','#'   ->  1#5    in all three  (not 1,5 under de-DE)
 *   $d -replace '2','#'     ->  03/04/#0#0 05:06:07  in all three
 *
 * `-join` DOES NOT. See `joinOperator`, which is where that gets ugly.
 */

import { toPSString } from '../formatting/to-string.ts';
import type { PSValue } from '../pipeline/psobject.ts';
import { invalidRegularExpressionError, raise, regexParseError } from './errors.ts';
import { roundHalfToEven } from './numeric.ts';
import {
  analyseGroups,
  expandReplacement,
  matchInfo,
  type GroupMap,
  type RegexMatchInfo,
} from './regex.ts';
import { wildcardMatches } from './wildcard.ts';

/** How an operator was spelled: bare and `i`-prefixed are insensitive, `c` is not. */
export interface CaseFlag {
  readonly caseSensitive: boolean;
}

const INSENSITIVE: CaseFlag = { caseSensitive: false };

/**
 * A `$Matches` table.
 *
 * KNOWN FIDELITY GAP, stated rather than hidden: pwsh keys NUMBERED groups with
 * Int32 and NAMED groups with String — measured, the key type of `$Matches` for
 * `'x1' -match '(\d)'` is Int32. A property bag keyed by string cannot express
 * that, so `$Matches['0']` here is what `$Matches[0]` is there. Nothing in the
 * corpus depends on the key's runtime type, and the alternative — a Map with
 * mixed key types — would infect every consumer for one unobservable detail.
 */
export type MatchesTable = Readonly<Record<string, string>>;

/**
 * The result of `-match`/`-notmatch`, separating the value from the side effect.
 *
 * `matches` is `null` for "do not touch `$Matches`", which is a real state and
 * not the same as "set it to empty". Measured:
 *
 *   'xyz' -match '(\d+)'   ->  False, and $Matches KEEPS its previous value
 *   @('abc') -match 'b'    ->  filters, and does NOT set $Matches at all
 *   'abc' -notmatch 'b'    ->  False, and DOES set $Matches to @{0=b}
 *
 * The last one is the one nobody expects: `-notmatch` populates `$Matches`
 * whenever the underlying match succeeded, even though the operator said False.
 * `$Matches` is also SCOPED like an ordinary variable — a match inside a
 * function does not change the caller's `$Matches`, measured — which is why this
 * returns the table instead of writing to a module-level global.
 */
export interface MatchResult {
  readonly value: PSValue;
  readonly matches: MatchesTable | null;
}

// ---------------------------------------------------------------------------
// shared plumbing
// ---------------------------------------------------------------------------

const asArray = (value: PSValue): readonly PSValue[] | null => (Array.isArray(value) ? value : null);

/** The invariant string form the string operators compare and rewrite. */
const text = (value: PSValue): string => toPSString(value);

/**
 * Compile a pattern, raising whichever error the calling operator raises.
 *
 * The two ids differ and it is not a typo. Measured, same malformed pattern:
 *
 *   'abc' -replace '[','X'   id=InvalidRegularExpression
 *                            msg=The regular expression pattern [ is not valid.
 *   'abc' -match '['         id=System.Text.RegularExpressions.RegexParseException
 *                            msg=Invalid pattern '[' at offset 1. Unterminated [] set.
 *   'abc' -split '['         id=System.Text.RegularExpressions.RegexParseException
 *
 * `-replace` wraps the failure in a PowerShell RuntimeException; `-match`,
 * `-notmatch` and `-split` let the raw .NET exception escape. A script catching
 * one will not catch the other, so the asymmetry is part of the contract.
 */
function compile(pattern: string, flags: string, wrapped: boolean): RegExp {
  try {
    return new RegExp(pattern, flags);
  } catch {
    if (wrapped) raise(invalidRegularExpressionError(pattern));
    // JavaScript's diagnostic wording differs from .NET's, so the offset and
    // detail are a faithful paraphrase while the id, the category and the
    // exception type — the parts a script can branch on — are exact.
    raise(regexParseError(pattern, pattern.length, 'Unterminated [] set.'));
  }
}

const regexFlags = (caseSensitive: boolean, global: boolean): string =>
  `${global ? 'g' : ''}${caseSensitive ? '' : 'i'}`;

/**
 * Walk every match, advancing past a zero-width one the way .NET does.
 *
 * Without the manual bump a zero-width pattern loops forever; with it, the
 * measured shapes fall out:
 *   'abc' -replace 'x*','-'  ->  -a-b-c-
 *   'abc' -split   'x*'      ->  '', a, b, c, ''
 */
function* eachMatch(re: RegExp, subject: string): Generator<RegExpExecArray> {
  re.lastIndex = 0;
  for (let m = re.exec(subject); m !== null; m = re.exec(subject)) {
    yield m;
    if (m[0].length === 0) {
      re.lastIndex++;
      if (re.lastIndex > subject.length) return;
    }
  }
}

// ---------------------------------------------------------------------------
// -replace
// ---------------------------------------------------------------------------

/** A scriptblock replacement — PowerShell 6+ — receives the .NET Match. */
export type ReplacementScriptBlock = (match: RegexMatchInfo) => PSValue;

function replaceOne(
  subject: string,
  pattern: string,
  replacement: PSValue | ReplacementScriptBlock,
  caseSensitive: boolean,
): string {
  const re = compile(pattern, regexFlags(caseSensitive, true), true);
  const map: GroupMap = analyseGroups(pattern);
  let out = '';
  let last = 0;
  for (const m of eachMatch(re, subject)) {
    const info = matchInfo(m, subject, map);
    out += subject.slice(last, m.index);
    out +=
      typeof replacement === 'function'
        ? toPSString(replacement(info))
        : expandReplacement(text(replacement), info);
    last = m.index + m[0].length;
  }
  return out + subject.slice(last);
}

/**
 * `-replace` / `-creplace` / `-ireplace`.
 *
 * Measured behaviours a shortcut gets wrong:
 *
 *   'abc' -replace 'z','x'     ->  abc         no match returns the ORIGINAL
 *   'abc' -replace 'b'         ->  ac          one argument DELETES
 *   'abc' -replace 'b',$null   ->  ac          so does a null replacement
 *   'abc' -replace 'b',5       ->  a5c         the replacement is stringified
 *   1234  -replace '2','X'     ->  1X34        so is the SUBJECT
 *   $null -replace 'a','b'     ->  ''          a null subject is the empty string
 *   @('AB','CD') -replace 'b','x' -> Object[] ['Ax','CD']
 *   'abc' -replace @('a','b'),'z' -> abc       an array pattern stringifies to
 *                                              'a b', which matches nothing
 *
 * A scriptblock replacement gets the Match, and its RESULT is stringified:
 *   'abc' -replace 'b', { $_.Value.ToUpper() }  ->  aBc
 *   'abc' -replace 'b', { 42 }                  ->  a42c
 */
export function replaceOperator(
  left: PSValue,
  pattern: PSValue,
  replacement: PSValue | ReplacementScriptBlock = '',
  { caseSensitive }: CaseFlag = INSENSITIVE,
): PSValue {
  const patternText = text(pattern);
  const items = asArray(left);
  if (items !== null) {
    return items.map((item) => replaceOne(text(item), patternText, replacement, caseSensitive));
  }
  return replaceOne(text(left), patternText, replacement, caseSensitive);
}

// ---------------------------------------------------------------------------
// -match / -notmatch
// ---------------------------------------------------------------------------

/**
 * Build `$Matches` in .NET's numbering.
 *
 * Two measured rules that a direct copy of the JavaScript match would break:
 *  - a group that did not participate is ABSENT, not empty:
 *      'a' -match '(a)|(b)'  ->  keys 0, 1        (never a key 2)
 *  - a NAMED group appears under its name only, and does not consume a number:
 *      'ab12cd' -match '([a-z]+)(?<num>\d+)([a-z]+)'
 *        ->  keys num, 2, 1, 0   with 1='ab', 2='cd', num='12'
 */
function buildMatches(m: RegExpExecArray, map: GroupMap): MatchesTable {
  const table: Record<string, string> = { '0': m[0] };
  const namedIndices = new Set(Object.values(map.names));
  let number = 0;
  for (const jsIndex of map.dotNetOrder) {
    if (namedIndices.has(jsIndex)) continue;
    number++;
    const value = m[jsIndex];
    if (value !== undefined) table[String(number)] = value;
  }
  for (const [name, jsIndex] of Object.entries(map.names)) {
    const value = m[jsIndex];
    if (value !== undefined) table[name] = value;
  }
  return table;
}

/**
 * `-match` / `-cmatch` / `-imatch`, and `-notmatch` / `-cnotmatch` /
 * `-inotmatch` via `negated`.
 *
 * With a SCALAR left operand the answer is a Boolean and `$Matches` is set on a
 * successful underlying match. With an ARRAY left operand the answer is the
 * filtered elements and `$Matches` is NOT touched — measured, it keeps whatever
 * it held.
 */
export function matchOperator(
  left: PSValue,
  pattern: PSValue,
  { caseSensitive }: CaseFlag = INSENSITIVE,
  negated = false,
): MatchResult {
  const patternText = text(pattern);
  const re = compile(patternText, regexFlags(caseSensitive, false), false);
  const items = asArray(left);
  if (items !== null) {
    return { value: items.filter((item) => re.test(text(item)) !== negated), matches: null };
  }
  const subject = text(left);
  const m = re.exec(subject);
  return {
    value: (m !== null) !== negated,
    matches: m === null ? null : buildMatches(m, analyseGroups(patternText)),
  };
}

// ---------------------------------------------------------------------------
// -like / -notlike
// ---------------------------------------------------------------------------

/**
 * `-like` / `-clike` / `-ilike`, and the `not` forms via `negated`.
 *
 * The pattern is a WILDCARD, not a regex — see wildcard.ts, including the
 * finding that `[!a]` does NOT negate. Both operands are stringified first, so
 * `123 -like '1*'` is True and `$null -like '*'` is True. Note the asymmetry
 * with `-match` on a null pattern: `'abc' -match $null` is True (an empty regex
 * matches anywhere) while `'abc' -like $null` is False (an empty wildcard is
 * anchored, so it only matches the empty string).
 */
export function likeOperator(
  left: PSValue,
  pattern: PSValue,
  { caseSensitive }: CaseFlag = INSENSITIVE,
  negated = false,
): PSValue {
  const patternText = text(pattern);
  const items = asArray(left);
  if (items !== null) {
    return items.filter(
      (item) => wildcardMatches(text(item), patternText, caseSensitive) !== negated,
    );
  }
  return wildcardMatches(text(left), patternText, caseSensitive) !== negated;
}

// ---------------------------------------------------------------------------
// -split
// ---------------------------------------------------------------------------

/**
 * `-split`'s option names, exactly as the reference implementation lists them.
 *
 * Measured by asking for an invalid one, which prints the whole legal set:
 *
 *   'a b' -split ' ',0,'None'
 *     Cannot convert value "None" to type "System.Management.Automation.SplitOptions".
 *     ... Specify one of the following enumerator names and try again:
 *     SimpleMatch, RegexMatch, CultureInvariant, IgnorePatternWhitespace,
 *     Multiline, Singleline, IgnoreCase, ExplicitCapture
 *
 * `None` is NOT among them, which was predicted wrong: there is no nameable zero
 * member, so "no options" is spelled by omitting the argument.
 */
export const SPLIT_OPTION_NAMES = [
  'SimpleMatch',
  'RegexMatch',
  'CultureInvariant',
  'IgnorePatternWhitespace',
  'Multiline',
  'Singleline',
  'IgnoreCase',
  'ExplicitCapture',
] as const;

export type SplitOptionName = (typeof SPLIT_OPTION_NAMES)[number];

/** A scriptblock delimiter: a truthy answer means "split here". */
export type SplitScriptBlock = (char: string, whole: string, index: number) => PSValue;

interface SplitSettings {
  readonly simpleMatch: boolean;
  readonly caseSensitive: boolean;
  readonly multiline: boolean;
  readonly singleline: boolean;
  readonly explicitCapture: boolean;
}

/**
 * Parse the options argument.
 *
 * Its interaction with the `c` prefix is measured and is not guessable from
 * either half alone:
 *
 *   'aXb' -split  'x',0,'SimpleMatch'  ->  a, b     (insensitive: the default)
 *   'aXb' -csplit 'x',0,'SimpleMatch'  ->  aXb      (sensitive)
 *   'aXb' -csplit 'x',0,'IgnoreCase'   ->  a, b     (the OPTION beats the prefix)
 *
 * So the prefix chooses the starting point and an explicit `IgnoreCase` puts
 * insensitivity back.
 */
export function parseSplitOptions(options: PSValue, caseSensitive: boolean): SplitSettings {
  const names =
    options === null
      ? []
      : (Array.isArray(options) ? options.map(text) : text(options).split(','))
          .map((n) => n.trim())
          .filter((n) => n !== '');

  let settings: SplitSettings = {
    simpleMatch: false,
    caseSensitive,
    multiline: false,
    singleline: false,
    explicitCapture: false,
  };
  for (const name of names) {
    const canonical = SPLIT_OPTION_NAMES.find((n) => n.toLowerCase() === name.toLowerCase());
    if (canonical === undefined) {
      raise({
        message:
          `Cannot convert value "${name}" to type "System.Management.Automation.SplitOptions". ` +
          `Error: "Unable to match the identifier name ${name} to a valid enumerator name. ` +
          'Specify one of the following enumerator names and try again: ' +
          `${SPLIT_OPTION_NAMES.join(', ')}"`,
        fullyQualifiedErrorId: 'RuntimeException',
        category: 'InvalidOperation',
        exceptionType: 'System.Management.Automation.RuntimeException',
        targetObject: name,
      });
    }
    if (canonical === 'SimpleMatch') settings = { ...settings, simpleMatch: true };
    if (canonical === 'IgnoreCase') settings = { ...settings, caseSensitive: false };
    if (canonical === 'Multiline') settings = { ...settings, multiline: true };
    if (canonical === 'Singleline') settings = { ...settings, singleline: true };
    if (canonical === 'ExplicitCapture') settings = { ...settings, explicitCapture: true };
    // CultureInvariant and IgnorePatternWhitespace are accepted and are no-ops:
    // JavaScript's RegExp has no `x` flag and its casing is already ordinal.
    // Recorded rather than silently dropped.
  }
  return settings;
}

/** One separator found in the subject, with whatever it captured. */
interface Separator {
  readonly at: number;
  readonly length: number;
  /** Participating capture groups, in .NET numbering. Non-participants are gone. */
  readonly captures: readonly string[];
}

/**
 * Assemble the output from the pieces the separators cut, applying the count
 * limit and re-inserting the captured groups.
 *
 * The limit, measured on 'a,b,c,d' -split ',':
 *   ,2   ->  a | b,c,d          the last element keeps the rest
 *   ,1   ->  a,b,c,d            one piece: the whole string
 *   ,0   ->  a | b | c | d      zero means unlimited
 *   ,-1  ->  a,b,c,d
 *   ,-2  ->  a,b,c | d          a negative count takes from the END
 *   ,-3  ->  a,b | c | d
 *   ,99  ->  a | b | c | d      more than the pieces is harmless
 *   ,1.5 ->  a | b,c            a fractional count rounds (half to even)
 *
 * Captures survive the limit. Measured: 'a1b2c' -split '(\d)',2 is a | 1 | b2c
 * and -split '(\d)',-2 is a1b | 2 | c.
 */
function assemble(subject: string, separators: readonly Separator[], limit: number): string[] {
  const keep =
    limit === 0 || Math.abs(limit) - 1 >= separators.length
      ? separators
      : limit > 0
        ? separators.slice(0, limit - 1)
        : separators.slice(separators.length - (-limit - 1));

  const out: string[] = [];
  let last = 0;
  for (const sep of keep) {
    out.push(subject.slice(last, sep.at));
    out.push(...sep.captures);
    last = sep.at + sep.length;
  }
  out.push(subject.slice(last));
  return out;
}

function regexSeparators(subject: string, settings: SplitSettings, pattern: string): Separator[] {
  if (settings.simpleMatch) {
    if (pattern === '') return [];
    const haystack = settings.caseSensitive ? subject : subject.toLowerCase();
    const needle = settings.caseSensitive ? pattern : pattern.toLowerCase();
    const found: Separator[] = [];
    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
      found.push({ at, length: pattern.length, captures: [] });
    }
    return found;
  }

  const flags = `g${settings.caseSensitive ? '' : 'i'}${settings.multiline ? 'm' : ''}${
    settings.singleline ? 's' : ''
  }`;
  const re = compile(pattern, flags, false);
  const map = analyseGroups(pattern);
  const found: Separator[] = [];
  for (const m of eachMatch(re, subject)) {
    // Capture groups in the pattern are INCLUDED in the output, and a group that
    // did not participate is omitted rather than emitted empty. Measured:
    //   'a1b2c' -split '(\d)'    ->  a, 1, b, 2, c
    //   'a1b'   -split '(x)?(\d)' ->  a, 1, b    (the (x) group is simply absent)
    const captures: string[] = [];
    if (!settings.explicitCapture) {
      for (const jsIndex of map.dotNetOrder) {
        const value = m[jsIndex];
        if (value !== undefined) captures.push(value);
      }
    }
    found.push({ at: m.index, length: m[0].length, captures });
  }
  return found;
}

function scriptBlockSeparators(subject: string, block: SplitScriptBlock): Separator[] {
  const found: Separator[] = [];
  // Measured: the block is called once per CHARACTER, with $_ = that character,
  // $args[0] = the whole string and $args[1] = the index. 'abcd' produces calls
  // for i = 0..3, so the last character is visited too.
  for (let i = 0; i < subject.length; i++) {
    if (truthyForSplit(block(subject[i] as string, subject, i))) {
      found.push({ at: i, length: 1, captures: [] });
    }
  }
  return found;
}

/**
 * The truthiness a split scriptblock's answer is judged by.
 *
 * Local and minimal on purpose: psobject's `isTruthy` is right for a general
 * expression, but all this ever sees is a scriptblock's single return value, and
 * the measured case that matters is that a number counts —
 * `'aXb' -split { $_ -eq 'X' ? 1 : 0 }` splits.
 */
function truthyForSplit(value: PSValue): boolean {
  if (value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'bigint') return value !== 0n;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * `-split` / `-csplit` / `-isplit`, binary form.
 *
 * Always returns `System.String[]` — NOT the `Object[]` the filtering operators
 * return. Measured, and observable:
 *   ('a,b' -split ',').GetType().FullName   ->  System.String[]
 *   (@(1,2,3) -eq 2).GetType().FullName     ->  System.Object[]
 *
 * The edges, all measured:
 *   ',a,' -split ','    ->  '', 'a', ''      empty strings at both ends
 *   'abc' -split ''     ->  '', a, b, c, ''  an empty pattern splits everywhere
 *   'abc' -split 'z'    ->  'abc'            no match yields one piece
 *   ''    -split ','    ->  ''               one empty piece, not zero pieces
 *   $null -split ','    ->  ''
 *   'a.b' -split '.'    ->  '', '', '', ''   the dot is a REGEX dot
 *
 * With an array left operand each element is split and the results are
 * concatenated: @('a b','c d') -split ' ' has four elements.
 */
export function splitOperator(
  left: PSValue,
  delimiter: PSValue | SplitScriptBlock,
  limit: PSValue = 0,
  options: PSValue = null,
  { caseSensitive }: CaseFlag = INSENSITIVE,
): readonly string[] {
  const raw = limit === null ? 0 : Number(text(limit));
  const count = Number.isFinite(raw) ? roundHalfToEven(raw) : 0;
  const settings = parseSplitOptions(options, caseSensitive);
  const run = (subject: string): string[] =>
    assemble(
      subject,
      typeof delimiter === 'function'
        ? scriptBlockSeparators(subject, delimiter)
        : regexSeparators(subject, settings, text(delimiter)),
      count,
    );

  const items = asArray(left);
  if (items !== null) return items.flatMap((item) => run(text(item)));
  return run(text(left));
}

/**
 * Unary `-split`: split on runs of whitespace, with no leading or trailing empty
 * piece.
 *
 * Measured: `-split '  a  b   c '` is exactly a, b, c — three elements, no
 * empties — while `-split ''`, `-split '   '` and `-split "\n"` are each a
 * single empty string. That trimming is why it is NOT the same as
 * `-split '\s+'`, which would produce a leading empty piece for that input.
 */
export function splitOnWhitespace(left: PSValue): readonly string[] {
  const one = (subject: string): string[] => {
    const trimmed = subject.trim();
    return trimmed === '' ? [''] : trimmed.split(/\s+/);
  };
  const items = asArray(left);
  if (items !== null) return items.flatMap((item) => one(text(item)));
  return one(text(left));
}

// ---------------------------------------------------------------------------
// -join
// ---------------------------------------------------------------------------

/**
 * `-join`.
 *
 * Non-string elements go through `toPSString`, which is what makes the numbers
 * come out right:
 *
 *   @(1,$true) -join ','    ->  1,True        not '1,true'
 *   @(0.1+0.2) -join ','    ->  0.3           not 0.30000000000000004
 *   @(1/3) -join ','        ->  0.333333333333333
 *   @(1.0) -join ','        ->  1
 *   @($null,1) -join ','    ->  ,1            a null element is an empty string
 *   @(1,2) -join $null      ->  12            a null separator joins with nothing
 *   @(1,2) -join 5          ->  152           the separator is stringified too
 *   @() -join ','           ->  ''
 *   $OFS = '-'              does NOT affect -join; the separator is explicit
 *
 * A DELIBERATE, MEASURED DIVERGENCE — the most interesting thing in this file.
 * pwsh's `-join` branches on whether the left operand is a collection, and the
 * two branches use DIFFERENT string conversions:
 *
 *                     scalar left                collection left
 *   1.5               '1.5' in every culture     '1,5' under de-DE
 *   a DateTime        '03/04/2020 05:06:07'      '3/4/2020 5:06:07 AM' under en-US
 *   a PSCustomObject  '@{a=1}'                   ''
 *
 * The scalar branch is culture-invariant — exactly what `toPSString` models. The
 * collection branch is `.ToString()` per element, which follows the culture AND
 * differs in kind for a DateTime or a PSCustomObject even under en-US. This
 * implementation uses `toPSString` for both, because to-string.ts states as a
 * design rule that a culture-following `.ToString()` must not reuse it and this
 * project has no such conversion to call. The consequence is exact and bounded:
 * the collection form over DateTime or PSCustomObject elements disagrees with
 * pwsh. Numbers, booleans, strings and nulls — everything the corpus and the
 * pipeline actually carry — agree.
 */
export function joinOperator(left: PSValue, separator: PSValue = ''): string {
  const sep = separator === null ? '' : text(separator);
  const items = asArray(left);
  if (items !== null) return items.map((item) => text(item)).join(sep);
  return text(left);
}

/** Unary `-join`: concatenate with no separator. */
export function joinAll(left: PSValue): string {
  return joinOperator(left, '');
}
