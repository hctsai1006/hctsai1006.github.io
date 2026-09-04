/**
 * regex.ts — .NET regex behaviour that JavaScript's RegExp does not give free.
 *
 * Three things live here, each because the obvious JavaScript call produces a
 * subtly different answer.
 *
 * 1. .NET RENUMBERS CAPTURE GROUPS. Unnamed groups take 1..n in source order,
 *    and only then do the named ones take n+1... JavaScript numbers them all in
 *    source order. Measured, and it changes what `$1` means:
 *
 *      'ab' -replace '(?<x>a)(b)','[$1]'   ->  [b]     <- the UNNAMED group is 1
 *      'ab' -replace '(?<x>a)(b)','[$2]'   ->  [a]     <- the named one is 2
 *
 *    In JavaScript those are the other way round. An implementation that handed
 *    the pattern straight to RegExp would swap every substitution in any pattern
 *    mixing named and unnamed groups — silently, and only in that case.
 *
 * 2. THE REPLACEMENT GRAMMAR. `String.prototype.replace` understands `$1`, `$&`
 *    and `$<name>`; .NET understands `$1`, `$&`, `${name}`, `$+` and `$_`, and
 *    `${name}` is the form PowerShell users type. Measured:
 *
 *      'John Smith' -replace '(?<first>\w+) (?<last>\w+)','${last}, ${first}'
 *        ->  Smith, John
 *
 * 3. WHICH GROUPS EXIST. .NET omits a group that did not participate, so
 *    `'a' -match '(a)|(b)'` populates keys 0 and 1 only — never a key 2 holding
 *    an empty string. Measured. Filling every declared group would make
 *    `$Matches.ContainsKey(2)` answer True where pwsh answers False.
 *
 * The substitutions, each measured against pwsh 7.6.5:
 *
 *   $$        a literal dollar                'abc' -replace 'b','$$'   -> a$c
 *   $&, $0    the whole match                 'abc' -replace 'b','[$&]' -> a[b]c
 *   $`        the text before the match        'abc' -replace 'b','[$`]' -> a[a]c
 *   $'        the text after the match         'abc' -replace 'b',"[$']" -> a[c]c
 *   $+        the last captured group
 *   $_        THE ENTIRE INPUT STRING         'abc' -replace 'b','[$_]' -> a[abc]c
 *   $1        group 1, in .NET's numbering
 *   ${name}   a named group
 *   $9        a group that does not exist stays LITERAL:
 *             'abc' -replace '(b)','[$9]'  ->  a[$9]c
 *
 * `$_` was the surprise. In PowerShell source `$_` is the pipeline variable, so
 * a reader assumes it is inert inside a replacement string — it is not, it is a
 * .NET substitution meaning the whole input, and leaving it literal would print
 * `$_` where pwsh prints the subject.
 */

/**
 * The capture groups a pattern declares, in .NET's numbering.
 *
 * `dotNetOrder[k]` is the JavaScript group index that .NET calls group k+1.
 * `names` maps each named group to its JavaScript index.
 */
export interface GroupMap {
  readonly dotNetOrder: readonly number[];
  readonly names: Readonly<Record<string, number>>;
}

/**
 * Walk a regex source and work out its capture groups.
 *
 * Deliberately a scanner rather than a regex-over-a-regex: the things that must
 * NOT be counted — `\(`, a `(` inside a character class, `(?:`, `(?=`, `(?<=`,
 * `(?<!` — are exactly the cases a pattern-matching approach gets wrong, and
 * `(?<` is ambiguous between a named group and a lookbehind until the next
 * character is read.
 */
export function analyseGroups(source: string): GroupMap {
  const unnamed: number[] = [];
  const namedOrder: { name: string; index: number }[] = [];
  let jsIndex = 0;
  let inClass = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i] as string;
    if (ch === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch !== '(') continue;

    if (source[i + 1] !== '?') {
      jsIndex++;
      unnamed.push(jsIndex);
      continue;
    }
    // (?<name>  is a named group; (?<=  and (?<!  are lookbehinds.
    const isNamed =
      source[i + 2] === '<' && source[i + 3] !== '=' && source[i + 3] !== '!';
    if (!isNamed) continue;
    const close = source.indexOf('>', i + 3);
    if (close === -1) continue;
    jsIndex++;
    namedOrder.push({ name: source.slice(i + 3, close), index: jsIndex });
  }

  const names: Record<string, number> = {};
  for (const entry of namedOrder) names[entry.name] = entry.index;
  return { dotNetOrder: [...unnamed, ...namedOrder.map((n) => n.index)], names };
}

/** What a scriptblock replacement or a caller inspecting `$Matches` receives. */
export interface RegexMatchInfo {
  /** The matched text — .NET's `Match.Value`. */
  readonly value: string;
  readonly index: number;
  readonly length: number;
  /**
   * Numbered groups in .NET's numbering, index 0 being the whole match. `null`
   * marks a group that did not participate, which is NOT the same as one that
   * matched empty.
   */
  readonly groups: readonly (string | null)[];
  /** Named groups that participated, by name. */
  readonly named: Readonly<Record<string, string>>;
  /** The whole subject string — what `$_` expands to in a replacement. */
  readonly input: string;
}

/** Turn a JavaScript match into .NET's view of it. */
export function matchInfo(match: RegExpExecArray, input: string, map: GroupMap): RegexMatchInfo {
  const groups: (string | null)[] = [match[0]];
  for (const jsIndex of map.dotNetOrder) groups.push(match[jsIndex] ?? null);

  const named: Record<string, string> = {};
  for (const [name, jsIndex] of Object.entries(map.names)) {
    const value = match[jsIndex];
    if (value !== undefined) named[name] = value;
  }

  return { value: match[0], index: match.index, length: match[0].length, groups, named, input };
}

/**
 * The last group that actually captured — .NET's `$+`.
 *
 * Falls back to the WHOLE MATCH when the pattern declares no groups, which is
 * measured and is not what "last captured group" reads like:
 *
 *   'abc' -replace 'b','$+'            ->  abc     <- 'b' replaced by 'b'
 *   'a1b' -replace '(a)(\d)','$+'      ->  1b      <- the last real group
 *
 * An implementation returning the empty string for the first case would delete
 * the match instead of preserving it.
 */
function lastCapture(info: RegexMatchInfo): string {
  for (let i = info.groups.length - 1; i >= 1; i--) {
    const g = info.groups[i];
    if (g !== undefined && g !== null) return g;
  }
  return info.value;
}

/**
 * Expand a .NET replacement template.
 *
 * The digit rule is .NET's and is not obvious: a `$` followed by digits takes
 * the LONGEST run that names an existing group, and if no prefix names one the
 * whole thing stays literal. That is what makes `$9` survive as text when the
 * pattern has one group, while `$1` in the same pattern substitutes.
 */
export function expandReplacement(template: string, info: RegexMatchInfo): string {
  let out = '';
  let i = 0;
  while (i < template.length) {
    const ch = template[i] as string;
    if (ch !== '$') {
      out += ch;
      i++;
      continue;
    }
    const next = template[i + 1];
    // A trailing lone $ is literal. Measured: 'abc' -replace 'b','US$' -> aUS$c
    if (next === undefined) {
      out += '$';
      i++;
      continue;
    }
    if (next === '$') {
      out += '$';
      i += 2;
      continue;
    }
    if (next === '&') {
      out += info.value;
      i += 2;
      continue;
    }
    if (next === '`') {
      out += info.input.slice(0, info.index);
      i += 2;
      continue;
    }
    if (next === "'") {
      out += info.input.slice(info.index + info.length);
      i += 2;
      continue;
    }
    if (next === '+') {
      out += lastCapture(info);
      i += 2;
      continue;
    }
    if (next === '_') {
      out += info.input;
      i += 2;
      continue;
    }
    if (next === '{') {
      const close = template.indexOf('}', i + 2);
      const name = close === -1 ? null : template.slice(i + 2, close);
      if (name !== null && Object.hasOwn(info.named, name)) {
        out += info.named[name] ?? '';
        i = close + 1;
        continue;
      }
      if (name !== null && /^\d+$/.test(name) && Number(name) < info.groups.length) {
        out += info.groups[Number(name)] ?? '';
        i = close + 1;
        continue;
      }
      out += '$';
      i++;
      continue;
    }
    if (next >= '0' && next <= '9') {
      let end = i + 1;
      while (end < template.length) {
        const d = template[end] as string;
        if (d < '0' || d > '9') break;
        end++;
      }
      let taken = -1;
      for (let stop = end; stop > i + 1; stop--) {
        const n = Number(template.slice(i + 1, stop));
        if (n < info.groups.length) {
          taken = stop;
          out += info.groups[n] ?? '';
          break;
        }
      }
      if (taken === -1) {
        // No prefix names a real group, so the `$` is literal text.
        out += '$';
        i++;
        continue;
      }
      i = taken;
      continue;
    }
    out += '$';
    i++;
  }
  return out;
}
