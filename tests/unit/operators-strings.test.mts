/**
 * Every expectation here is a measurement from pwsh 7.6.5 on this machine, and
 * the reference output is quoted beside it. Where the probe CONTRADICTED what
 * was written down beforehand, the test says so — those are the valuable ones,
 * because they are the assumptions that would otherwise have shipped.
 *
 * The predictions were recorded in the scratchpad before any probe ran. Four in
 * this file were wrong:
 *
 *   P7   "the operators do not all default the same way" — they DO all default
 *        to case-insensitive; what differs is that -join has no case forms at all
 *   P18  "[!a] negates"                     — it does not; ! is a set member
 *   P24  "the split scriptblock sees only $_" — it also gets the whole string
 *        and the index as $args[0] and $args[1]
 *   P27  "-join always goes through toPSString" — pwsh's collection form is
 *        culture-dependent .ToString(), which toPSString is not
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  analyseGroups,
  escapeWildcard,
  expandReplacement,
  joinOperator,
  likeOperator,
  matchOperator,
  matchInfo,
  parseOperator,
  PSRuntimeError,
  replaceOperator,
  splitOnWhitespace,
  splitOperator,
  SPLIT_OPTION_NAMES,
  wildcardMatches,
} from '../../src/operators/index.ts';

const SENSITIVE = { caseSensitive: true } as const;
const INSENSITIVE = { caseSensitive: false } as const;

// ---------------------------------------------------------------------------
// case sensitivity
// ---------------------------------------------------------------------------

describe('every string operator defaults to CASE-INSENSITIVE', () => {
  // A regex engine defaults the other way, so each of these was probed rather
  // than generalised from -eq.
  it("'ABC' -replace 'b','x' is AxC and -creplace leaves it alone", () => {
    // pwsh: 'ABC' -replace 'b','x'   -> AxC
    // pwsh: 'ABC' -creplace 'b','x'  -> ABC
    assert.equal(replaceOperator('ABC', 'b', 'x'), 'AxC');
    assert.equal(replaceOperator('ABC', 'b', 'x', SENSITIVE), 'ABC');
  });

  it("'ABC' -match 'b' is True and -cmatch is False", () => {
    // pwsh: 'ABC' -match 'b'   -> True
    // pwsh: 'ABC' -cmatch 'b'  -> False
    assert.equal(matchOperator('ABC', 'b').value, true);
    assert.equal(matchOperator('ABC', 'b', SENSITIVE).value, false);
  });

  it("'abc' -like 'A*' is True and -clike is False", () => {
    // pwsh: 'abc' -like 'A*'   -> True
    // pwsh: 'abc' -clike 'A*'  -> False
    assert.equal(likeOperator('abc', 'A*'), true);
    assert.equal(likeOperator('abc', 'A*', SENSITIVE), false);
  });

  it("'aXb' -split 'x' splits and -csplit does not", () => {
    // pwsh: 'aXb' -split 'x'   -> a, b        (Count 2)
    // pwsh: 'aXb' -csplit 'x'  -> aXb         (Count 1)
    assert.deepEqual(splitOperator('aXb', 'x'), ['a', 'b']);
    assert.deepEqual(splitOperator('aXb', 'x', 0, null, SENSITIVE), ['aXb']);
  });

  it('the c/i prefix goes in front of the WHOLE name, including the not- forms', () => {
    // pwsh: both -cnotlike and -cnotcontains parse; -notclike does not exist.
    assert.deepEqual(parseOperator('-cnotlike'), {
      name: 'notlike',
      caseSensitive: true,
      explicit: true,
    });
    assert.deepEqual(parseOperator('-inotmatch'), {
      name: 'notmatch',
      caseSensitive: false,
      explicit: true,
    });
  });

  it('WRONG BEFORE PROBING: -cjoin and -ijoin are not operators at all', () => {
    // Predicted that -join followed the same c/i pattern as everything else.
    // Measured by feeding every candidate spelling to [Parser]::ParseInput:
    // exactly two failed to parse, -cjoin and -ijoin.
    assert.equal(parseOperator('-cjoin'), null);
    assert.equal(parseOperator('-ijoin'), null);
    assert.deepEqual(parseOperator('-join'), {
      name: 'join',
      caseSensitive: false,
      explicit: false,
    });
  });
});

// ---------------------------------------------------------------------------
// -replace
// ---------------------------------------------------------------------------

describe('-replace substitutions follow .NET, not JavaScript', () => {
  it('substitutes numbered groups', () => {
    // pwsh: 'John Smith' -replace '(\w+) (\w+)','$2 $1'  ->  Smith John
    assert.equal(replaceOperator('John Smith', '(\\w+) (\\w+)', '$2 $1'), 'Smith John');
  });

  it('substitutes ${name}, which JavaScript spells $<name>', () => {
    // pwsh: 'John Smith' -replace '(?<first>\w+) (?<last>\w+)','${last}, ${first}'
    //         ->  Smith, John
    assert.equal(
      replaceOperator('John Smith', '(?<first>\\w+) (?<last>\\w+)', '${last}, ${first}'),
      'Smith, John',
    );
  });

  it('knows $&, $`, $\' and $$', () => {
    // pwsh: 'abc' -replace 'b','[$&]'  ->  a[b]c
    // pwsh: 'abc' -replace 'b','[$`]'  ->  a[a]c
    // pwsh: 'abc' -replace 'b',"[$']"  ->  a[c]c
    // pwsh: 'abc' -replace 'b','$$'    ->  a$c
    assert.equal(replaceOperator('abc', 'b', '[$&]'), 'a[b]c');
    assert.equal(replaceOperator('abc', 'b', '[$`]'), 'a[a]c');
    assert.equal(replaceOperator('abc', 'b', "[$']"), 'a[c]c');
    assert.equal(replaceOperator('abc', 'b', '$$'), 'a$c');
  });

  it('WRONG BEFORE PROBING: $_ is a .NET substitution meaning the whole input', () => {
    // Predicted $_ would stay literal, since in PowerShell source it is the
    // pipeline variable and a single-quoted string does not interpolate it.
    // pwsh: 'abc' -replace 'b','[$_]'  ->  a[abc]c
    assert.equal(replaceOperator('abc', 'b', '[$_]'), 'a[abc]c');
  });

  it('leaves a group reference that does not exist as literal text', () => {
    // pwsh: 'abc' -replace '(b)','[$9]'  ->  a[$9]c
    // pwsh: 'abc' -replace 'b','US$'     ->  aUS$c
    assert.equal(replaceOperator('abc', '(b)', '[$9]'), 'a[$9]c');
    assert.equal(replaceOperator('abc', 'b', 'US$'), 'aUS$c');
  });

  it('WRONG BEFORE PROBING: .NET renumbers groups so the UNNAMED ones come first', () => {
    // Predicted JavaScript's source-order numbering. In .NET the unnamed groups
    // take 1..n and only then do the named ones continue.
    // pwsh: 'ab' -replace '(?<x>a)(b)','[$1]'  ->  [b]
    // pwsh: 'ab' -replace '(?<x>a)(b)','[$2]'  ->  [a]
    assert.equal(replaceOperator('ab', '(?<x>a)(b)', '[$1]'), '[b]');
    assert.equal(replaceOperator('ab', '(?<x>a)(b)', '[$2]'), '[a]');
  });

  it('returns the original string when nothing matches', () => {
    // pwsh: 'abc' -replace 'z','x'  ->  abc
    assert.equal(replaceOperator('abc', 'z', 'x'), 'abc');
  });

  it('deletes the match when the replacement is omitted or null', () => {
    // pwsh: 'abc' -replace 'b'        ->  ac
    // pwsh: 'abc' -replace 'b',$null  ->  ac
    assert.equal(replaceOperator('abc', 'b'), 'ac');
    assert.equal(replaceOperator('abc', 'b', null), 'ac');
  });

  it('stringifies a non-string subject and a non-string replacement', () => {
    // pwsh: 1234 -replace '2','X'    ->  1X34
    // pwsh: 'abc' -replace 'b',5     ->  a5c
    // pwsh: 'abc' -replace 'b',$true ->  aTruec
    // pwsh: $null -replace 'a','b'   ->  '' (empty string, no error)
    assert.equal(replaceOperator(1234, '2', 'X'), '1X34');
    assert.equal(replaceOperator('abc', 'b', 5), 'a5c');
    assert.equal(replaceOperator('abc', 'b', true), 'aTruec');
    assert.equal(replaceOperator(null, 'a', 'b'), '');
  });

  it('takes a scriptblock replacement and stringifies its result', () => {
    // pwsh: 'abc' -replace 'b', { $_.Value.ToUpper() }  ->  aBc
    // pwsh: 'abc' -replace 'b', { 42 }                  ->  a42c
    // pwsh: 'a1b' -replace '(\d)', { "<$($_.Groups[1].Value)>" }  ->  a<1>b
    assert.equal(
      replaceOperator('abc', 'b', (m) => m.value.toUpperCase()),
      'aBc',
    );
    assert.equal(
      replaceOperator('abc', 'b', () => 42),
      'a42c',
    );
    assert.equal(
      replaceOperator('a1b', '(\\d)', (m) => `<${m.groups[1] ?? ''}>`),
      'a<1>b',
    );
  });

  it('maps over an array left operand instead of filtering', () => {
    // pwsh: @('AB','CD') -replace 'b','x'  ->  Object[] ['Ax','CD']
    // pwsh: @(1,$null,'a') -replace 'a','Z'  ->  ['1','','Z']
    assert.deepEqual(replaceOperator(['AB', 'CD'], 'b', 'x'), ['Ax', 'CD']);
    assert.deepEqual(replaceOperator([1, null, 'a'], 'a', 'Z'), ['1', '', 'Z']);
    assert.deepEqual(replaceOperator([], 'a', 'b'), []);
  });

  it('handles a zero-width pattern the way .NET does', () => {
    // pwsh: 'abc' -replace 'x*','-'  ->  -a-b-c-
    // pwsh: 'abc' -replace '','-'    ->  -a-b-c-
    // pwsh: '' -replace '','-'       ->  -
    // pwsh: 'abc' -replace '(?=b)','-'  ->  a-bc
    assert.equal(replaceOperator('abc', 'x*', '-'), '-a-b-c-');
    assert.equal(replaceOperator('abc', '', '-'), '-a-b-c-');
    assert.equal(replaceOperator('', '', '-'), '-');
    assert.equal(replaceOperator('abc', '(?=b)', '-'), 'a-bc');
  });

  it('treats an ARRAY pattern as its stringified form, which matches nothing here', () => {
    // pwsh: 'abc' -replace @('a','b'),'z'  ->  abc      (the pattern is 'a b')
    // pwsh: 'abc' -replace 'b',@('x','y')  ->  ax yc
    assert.equal(replaceOperator('abc', ['a', 'b'], 'z'), 'abc');
    assert.equal(replaceOperator('abc', 'b', ['x', 'y']), 'ax yc');
  });
});

describe('the .NET replacement grammar in isolation', () => {
  it('expands $+ to the last group that captured', () => {
    const info = matchInfo(
      /(\d)(x)?/.exec('7') as RegExpExecArray,
      '7',
      analyseGroups('(\\d)(x)?'),
    );
    assert.equal(expandReplacement('[$+]', info), '[7]');
    // pwsh: 'a1b' -replace '(a)(\d)','$+'  ->  1b
    assert.equal(replaceOperator('a1b', '(a)(\\d)', '$+'), '1b');
  });

  it('WRONG BEFORE PROBING: $+ falls back to the WHOLE MATCH with no groups', () => {
    // Predicted the empty string, which would DELETE the match instead of
    // preserving it.
    // pwsh: 'abc' -replace 'b','$+'  ->  abc
    assert.equal(replaceOperator('abc', 'b', '$+'), 'abc');
  });

  it('leaves the whole ${name} literal when the group does not exist', () => {
    // pwsh: 'abc' -replace 'b','${nosuch}'  ->  a${nosuch}c
    // pwsh: 'abc' -replace '(b)','${1}'     ->  abc
    // pwsh: 'abc' -replace 'b','$x'         ->  a$xc
    // pwsh: 'abc' -replace 'b','{x}'        ->  a{x}c
    assert.equal(replaceOperator('abc', 'b', '${nosuch}'), 'a${nosuch}c');
    assert.equal(replaceOperator('abc', '(b)', '${1}'), 'abc');
    assert.equal(replaceOperator('abc', 'b', '$x'), 'a$xc');
    assert.equal(replaceOperator('abc', 'b', '{x}'), 'a{x}c');
  });

  it('reads the LONGEST digit run that names a real group', () => {
    const source = '(a)(b)';
    const info = matchInfo(/(a)(b)/.exec('ab') as RegExpExecArray, 'ab', analyseGroups(source));
    assert.equal(expandReplacement('$1$2', info), 'ab');
    // No group 12, so it falls back to group 1 followed by the literal '2'.
    assert.equal(expandReplacement('$12', info), 'a2');
  });
});

describe('analyseGroups mirrors .NET numbering', () => {
  it('puts unnamed groups first and named ones after', () => {
    // pwsh: 'ab12cd' -match '([a-z]+)(?<num>\d+)([a-z]+)'
    //   $Matches keys: num, 2, 1, 0  with 1='ab', 2='cd', num='12'
    const map = analyseGroups('([a-z]+)(?<num>\\d+)([a-z]+)');
    assert.deepEqual(map.dotNetOrder, [1, 3, 2]);
    assert.deepEqual(map.names, { num: 2 });
  });

  it('ignores escaped parens, character classes, lookarounds and (?:...)', () => {
    const map = analyseGroups('\\((a)[(](?:b)(?=c)(?<!d)(?<e>f)');
    assert.deepEqual(map.dotNetOrder, [1, 2]);
    assert.deepEqual(map.names, { e: 2 });
  });
});

// ---------------------------------------------------------------------------
// -match and $Matches
// ---------------------------------------------------------------------------

describe('-match and what it leaves in $Matches', () => {
  it('populates $Matches with the whole match and the numbered groups', () => {
    // pwsh: 'The year 2026 ok' -match '(\d+)'  ->  True
    //       $Matches  ->  @{0=2026; 1=2026}
    const r = matchOperator('The year 2026 ok', '(\\d+)');
    assert.equal(r.value, true);
    assert.deepEqual(r.matches, { '0': '2026', '1': '2026' });
  });

  it('adds named groups under their names', () => {
    // pwsh: '2026-09-05' -match '(?<y>\d{4})-(?<m>\d{2})-(?<d>\d{2})'
    //       $Matches  ->  @{0=2026-09-05; d=05; m=09; y=2026}
    const r = matchOperator('2026-09-05', '(?<y>\\d{4})-(?<m>\\d{2})-(?<d>\\d{2})');
    assert.deepEqual(r.matches, { '0': '2026-09-05', y: '2026', m: '09', d: '05' });
  });

  it('does NOT give a named group a number', () => {
    // pwsh: 'ab12' -match '(?<letters>[a-z]+)(\d+)'
    //       $Matches keys: letters, 1, 0    with 1='12'
    const r = matchOperator('ab12', '(?<letters>[a-z]+)(\\d+)');
    assert.deepEqual(r.matches, { '0': 'ab12', '1': '12', letters: 'ab' });
  });

  it('omits a group that did not participate, rather than storing empty', () => {
    // pwsh: 'a' -match '(a)|(b)'  ->  $Matches keys: 0, 1   (never a key 2)
    const r = matchOperator('a', '(a)|(b)');
    assert.deepEqual(r.matches, { '0': 'a', '1': 'a' });
    assert.equal(Object.hasOwn(r.matches ?? {}, '2'), false);
  });

  it('leaves $Matches UNCHANGED on a failed match', () => {
    // pwsh: after a successful match, 'xyz' -match '(\d+)' is False and
    //       $Matches still holds the PREVIOUS match's table.
    const failed = matchOperator('xyz', '(\\d+)');
    assert.equal(failed.value, false);
    assert.equal(failed.matches, null, 'null means "do not touch $Matches"');
  });

  it('WRONG BEFORE PROBING: -notmatch DOES populate $Matches when the match succeeds', () => {
    // Predicted that -notmatch left $Matches alone because it answers False.
    // pwsh: $Matches = $null; 'abc' -notmatch 'b'  ->  False, $Matches = @{0=b}
    // pwsh: $Matches = $null; 'abc' -notmatch 'z'  ->  True,  $Matches = $null
    const hit = matchOperator('abc', 'b', INSENSITIVE, true);
    assert.equal(hit.value, false);
    assert.deepEqual(hit.matches, { '0': 'b' });

    const miss = matchOperator('abc', 'z', INSENSITIVE, true);
    assert.equal(miss.value, true);
    assert.equal(miss.matches, null);
  });

  it('filters an array left operand and does NOT touch $Matches', () => {
    // pwsh: @('abc','xyz','a1c') -match '\d'  ->  Object[] ['a1c'], $Matches unchanged
    // pwsh: @('abc','xyz') -match '\d'        ->  Object[] with Count 0
    const hit = matchOperator(['abc', 'xyz', 'a1c'], '\\d');
    assert.deepEqual(hit.value, ['a1c']);
    assert.equal(hit.matches, null);

    const none = matchOperator(['abc', 'xyz'], '\\d');
    assert.deepEqual(none.value, []);
  });

  it('keeps the ORIGINAL elements when filtering, not their string forms', () => {
    // pwsh: @(1,12,3) -match '1'  ->  types System.Int32, System.Int32
    const r = matchOperator([1, 12, 3], '1');
    assert.deepEqual(r.value, [1, 12]);
    assert.equal(typeof (r.value as readonly unknown[])[0], 'number');
  });

  it('matches an empty pattern against anything', () => {
    // pwsh: 'abc' -match ''      ->  True
    // pwsh: 'abc' -match $null   ->  True
    // pwsh: $null -match 'a'     ->  False
    assert.equal(matchOperator('abc', '').value, true);
    assert.equal(matchOperator('abc', null).value, true);
    assert.equal(matchOperator(null, 'a').value, false);
  });
});

// ---------------------------------------------------------------------------
// -like
// ---------------------------------------------------------------------------

describe('-like is wildcards, not regex', () => {
  it('treats every regex metacharacter as a literal', () => {
    // pwsh: 'aXc' -like 'a.c'  ->  False     'a.c' -like 'a.c'  ->  True
    // pwsh: 'aaa' -like 'a+'   ->  False     'a+'  -like 'a+'   ->  True
    // pwsh: 'aaa' -like 'a{3}' ->  False     'a\b' -like 'a\b'  ->  True
    assert.equal(likeOperator('aXc', 'a.c'), false);
    assert.equal(likeOperator('a.c', 'a.c'), true);
    assert.equal(likeOperator('aaa', 'a+'), false);
    assert.equal(likeOperator('a+', 'a+'), true);
    assert.equal(likeOperator('aaa', 'a{3}'), false);
    assert.equal(likeOperator('a\\b', 'a\\b'), true);
    for (const ch of ['.', '+', '(', ')', '{', '}', '^', '$', '|', '\\']) {
      assert.equal(likeOperator(ch, ch), true, `'${ch}' -like '${ch}'`);
    }
  });

  it('is anchored at both ends', () => {
    // pwsh: 'abc' -like 'ab'  ->  False       'abc' -like 'abc'  ->  True
    // pwsh: 'a' -like ''      ->  False       '' -like ''        ->  True
    assert.equal(likeOperator('abc', 'ab'), false);
    assert.equal(likeOperator('abc', 'abc'), true);
    assert.equal(likeOperator('a', ''), false);
    assert.equal(likeOperator('', ''), true);
  });

  it('lets * and ? cross a newline', () => {
    // pwsh: "a`nb" -like 'a*b'  ->  True      "a`nb" -like 'a?b'  ->  True
    assert.equal(likeOperator('a\nb', 'a*b'), true);
    assert.equal(likeOperator('a\nb', 'a?b'), true);
    assert.equal(likeOperator('', '?'), false);
    assert.equal(likeOperator('ab', '??'), true);
    assert.equal(likeOperator('ab', '???'), false);
  });

  it('WRONG BEFORE PROBING: [!a] does NOT negate — ! is an ordinary set member', () => {
    // Predicted [!a] meant "not a", which is what about_Wildcards' filesystem
    // examples show. WildcardPattern has NO negation. Measured, and every one
    // of these is the OPPOSITE of what negation would give:
    //   'abc' -like '[!a]bc'  ->  True     <- 'a' matched [!a]
    //   'xbc' -like '[!a]bc'  ->  False
    //   'a'   -like '[!b]'    ->  False
    //   'a'   -like '[!ab]'   ->  True
    //   '!'   -like '[!!]'    ->  True
    //   'a'   -like '[!!]'    ->  False
    assert.equal(likeOperator('abc', '[!a]bc'), true);
    assert.equal(likeOperator('xbc', '[!a]bc'), false);
    assert.equal(likeOperator('a', '[!b]'), false);
    assert.equal(likeOperator('a', '[!ab]'), true);
    assert.equal(likeOperator('!', '[!!]'), true);
    assert.equal(likeOperator('a', '[!!]'), false);
  });

  it('does not treat ^ as a negation either', () => {
    // pwsh: 'abc' -like '[^a]bc'  ->  True    '^bc' -like '[^a]bc'  ->  True
    assert.equal(likeOperator('abc', '[^a]bc'), true);
    assert.equal(likeOperator('^bc', '[^a]bc'), true);
  });

  it('supports ranges, and a ] first in the set is a literal member', () => {
    // pwsh: 'b' -like '[a-c]'      ->  True      'd' -like '[a-cx-z]'  ->  False
    // pwsh: '-' -like '[a-c-]'     ->  True      ']' -like '[]a]'      ->  True
    // pwsh: 'a' -like '[]a]'       ->  True      'a' -like '[]]'       ->  False
    assert.equal(likeOperator('b', '[a-c]'), true);
    assert.equal(likeOperator('y', '[a-cx-z]'), true);
    assert.equal(likeOperator('d', '[a-cx-z]'), false);
    assert.equal(likeOperator('-', '[a-c-]'), true);
    assert.equal(likeOperator(']', '[]a]'), true);
    assert.equal(likeOperator('a', '[]a]'), true);
    assert.equal(likeOperator('a', '[]]'), false);
    assert.equal(likeOperator(']', '[]]'), true);
  });

  it('is case-insensitive inside a set unless the operator is -clike', () => {
    // pwsh: 'B' -like '[a-c]'   ->  True
    // pwsh: 'B' -clike '[a-c]'  ->  False      'B' -clike '[A-C]'  ->  True
    assert.equal(likeOperator('B', '[a-c]'), true);
    assert.equal(likeOperator('B', '[a-c]', SENSITIVE), false);
    assert.equal(likeOperator('B', '[A-C]', SENSITIVE), true);
  });

  it('escapes with a BACKTICK, not a backslash', () => {
    // pwsh: 'a*c' -like 'a`*c'  ->  True      'abc' -like 'a`*c'  ->  False
    // pwsh: 'a?c' -like 'a`?c'  ->  True      'a[c' -like 'a`[c'  ->  True
    // pwsh: 'a`c' -like 'a``c'  ->  True      'ab'  -like 'a`b'   ->  True
    // pwsh: 'a'   -like 'a`'    ->  False     (a trailing backtick is literal)
    assert.equal(likeOperator('a*c', 'a`*c'), true);
    assert.equal(likeOperator('abc', 'a`*c'), false);
    assert.equal(likeOperator('a?c', 'a`?c'), true);
    assert.equal(likeOperator('a[c', 'a`[c'), true);
    assert.equal(likeOperator('a`c', 'a``c'), true);
    assert.equal(likeOperator('ab', 'a`b'), true);
    assert.equal(likeOperator('a', 'a`'), false);
  });

  it('raises for an unterminated bracket, an empty set, or a reversed range', () => {
    // pwsh: 'abc' -like '[abc'  ->  The specified wildcard character pattern is not valid: [abc
    // pwsh: 'a'   -like '[]'    ->  ... not valid: []
    // pwsh: 'b'   -like '[c-a]' ->  ... not valid: [c-a]
    for (const bad of ['[abc', 'a[', '[]', '[c-a]']) {
      assert.throws(
        () => likeOperator('abc', bad),
        (error: unknown) => {
          assert.ok(error instanceof PSRuntimeError);
          assert.equal(error.record.fullyQualifiedErrorId, 'RuntimeException');
          assert.equal(
            error.record.message,
            `The specified wildcard character pattern is not valid: ${bad}`,
          );
          return true;
        },
        bad,
      );
    }
  });

  it('stringifies both operands', () => {
    // pwsh: 123 -like '1*'      ->  True      $null -like '*'  ->  True
    // pwsh: $true -like 'T*'    ->  True      1.5 -like '1.5'  ->  True
    // pwsh: $null -like ''      ->  True      'abc' -like $null -> False
    assert.equal(likeOperator(123, '1*'), true);
    assert.equal(likeOperator(null, '*'), true);
    assert.equal(likeOperator(true, 'T*'), true);
    assert.equal(likeOperator(1.5, '1.5'), true);
    assert.equal(likeOperator(null, ''), true);
    assert.equal(likeOperator('abc', null), false);
  });

  it('filters an array left operand', () => {
    // pwsh: @('a','B') -like 'b'     ->  Object[] ['B']
    // pwsh: @('a','B') -notlike 'b'  ->  Object[] ['a']
    // pwsh: @('a','B') -clike 'b'    ->  Object[] with Count 0
    assert.deepEqual(likeOperator(['a', 'B'], 'b'), ['B']);
    assert.deepEqual(likeOperator(['a', 'B'], 'b', INSENSITIVE, true), ['a']);
    assert.deepEqual(likeOperator(['a', 'B'], 'b', SENSITIVE), []);
  });

  it('escapeWildcard matches [WildcardPattern]::Escape', () => {
    // pwsh: [WildcardPattern]::Escape('a*b?c[d]')  ->  a`*b`?c`[d`]
    assert.equal(escapeWildcard('a*b?c[d]'), 'a`*b`?c`[d`]');
    assert.equal(wildcardMatches('a*b?c[d]', escapeWildcard('a*b?c[d]'), false), true);
  });
});

// ---------------------------------------------------------------------------
// -split
// ---------------------------------------------------------------------------

describe('-split', () => {
  it('returns an array whose Count is observable', () => {
    // pwsh: ('a,b,c' -split ',').Count  ->  3          <- corpus strings.split-returns-array
    assert.equal(splitOperator('a,b,c', ',').length, 3);
    assert.deepEqual(splitOperator('a,b,c', ','), ['a', 'b', 'c']);
  });

  it('keeps the empty pieces at the edges', () => {
    // pwsh: ',a,' -split ','   ->  '', 'a', ''
    // pwsh: 'abc' -split ''    ->  '', a, b, c, ''
    // pwsh: ''    -split ','   ->  ''            (one piece, not zero)
    // pwsh: 'abc' -split 'z'   ->  'abc'
    // pwsh: $null -split ','   ->  ''
    assert.deepEqual(splitOperator(',a,', ','), ['', 'a', '']);
    assert.deepEqual(splitOperator('abc', ''), ['', 'a', 'b', 'c', '']);
    assert.deepEqual(splitOperator('', ','), ['']);
    assert.deepEqual(splitOperator('abc', 'z'), ['abc']);
    assert.deepEqual(splitOperator(null, ','), ['']);
  });

  it('treats the delimiter as a REGEX', () => {
    // pwsh: 'a.b' -split '.'    ->  '', '', '', ''
    // pwsh: 'a.b' -split '\.'   ->  a, b
    // pwsh: 'a1b2c' -split '\d' ->  a, b, c
    assert.deepEqual(splitOperator('a.b', '.'), ['', '', '', '']);
    assert.deepEqual(splitOperator('a.b', '\\.'), ['a', 'b']);
    assert.deepEqual(splitOperator('a1b2c', '\\d'), ['a', 'b', 'c']);
  });

  it('INCLUDES capture groups from the pattern, and omits ones that did not participate', () => {
    // pwsh: 'a1b2c' -split '(\d)'      ->  a, 1, b, 2, c
    // pwsh: 'a1b2c' -split '(\d)(\w)'  ->  a, 1, b, '', 2, c, ''
    // pwsh: 'a1b'   -split '(x)?(\d)'  ->  a, 1, b      <- the (x) group is ABSENT
    // pwsh: 'a1b'   -split '(?:\d)'    ->  a, b
    assert.deepEqual(splitOperator('a1b2c', '(\\d)'), ['a', '1', 'b', '2', 'c']);
    assert.deepEqual(splitOperator('a1b2c', '(\\d)(\\w)'), ['a', '1', 'b', '', '2', 'c', '']);
    assert.deepEqual(splitOperator('a1b', '(x)?(\\d)'), ['a', '1', 'b']);
    assert.deepEqual(splitOperator('a1b', '(?:\\d)'), ['a', 'b']);
  });

  it('applies a positive count limit by keeping the remainder in the last piece', () => {
    // pwsh: 'a,b,c,d' -split ',',2   ->  a, 'b,c,d'
    // pwsh: 'a,b,c,d' -split ',',1   ->  'a,b,c,d'
    // pwsh: 'a,b,c,d' -split ',',0   ->  a, b, c, d
    // pwsh: 'a,b,c,d' -split ',',99  ->  a, b, c, d
    assert.deepEqual(splitOperator('a,b,c,d', ',', 2), ['a', 'b,c,d']);
    assert.deepEqual(splitOperator('a,b,c,d', ',', 1), ['a,b,c,d']);
    assert.deepEqual(splitOperator('a,b,c,d', ',', 0), ['a', 'b', 'c', 'd']);
    assert.deepEqual(splitOperator('a,b,c,d', ',', 99), ['a', 'b', 'c', 'd']);
  });

  it('takes a NEGATIVE count from the end', () => {
    // pwsh: 'a,b,c,d' -split ',',-1  ->  'a,b,c,d'
    // pwsh: 'a,b,c,d' -split ',',-2  ->  'a,b,c', d
    // pwsh: 'a,b,c,d' -split ',',-3  ->  'a,b', c, d
    assert.deepEqual(splitOperator('a,b,c,d', ',', -1), ['a,b,c,d']);
    assert.deepEqual(splitOperator('a,b,c,d', ',', -2), ['a,b,c', 'd']);
    assert.deepEqual(splitOperator('a,b,c,d', ',', -3), ['a,b', 'c', 'd']);
  });

  it('keeps the captures when a limit is applied', () => {
    // pwsh: 'a1b2c' -split '(\d)',2   ->  a, 1, 'b2c'
    // pwsh: 'a1b2c' -split '(\d)',-2  ->  'a1b', 2, c
    assert.deepEqual(splitOperator('a1b2c', '(\\d)', 2), ['a', '1', 'b2c']);
    assert.deepEqual(splitOperator('a1b2c', '(\\d)', -2), ['a1b', '2', 'c']);
  });

  it('rounds a fractional count half to even', () => {
    // pwsh: 'a,b,c' -split ',',1.5  ->  a, 'b,c'      (1.5 rounds to 2)
    // pwsh: 'a,b,c' -split ',',2.5  ->  a, 'b,c'      (2.5 rounds to 2)
    // pwsh: 'a,b,c' -split ','','2' ->  a, 'b,c'
    assert.deepEqual(splitOperator('a,b,c', ',', 1.5), ['a', 'b,c']);
    assert.deepEqual(splitOperator('a,b,c', ',', 2.5), ['a', 'b,c']);
    assert.deepEqual(splitOperator('a,b,c', ',', '2'), ['a', 'b,c']);
  });

  it('takes a scriptblock delimiter, called once per character', () => {
    // pwsh: 'abcd' -split { $_ -eq 'c' }  ->  ab, d
    // pwsh: 'aXbXc' -split { $_ -eq 'X' } ->  a, b, c
    // pwsh: 'XX' -split { $_ -eq 'X' }    ->  '', '', ''   (Count 3)
    // pwsh: 'abc' -split { $true }        ->  '', '', '', ''
    // pwsh: 'abc' -split { $false }       ->  abc
    // pwsh: '' -split { $true }           ->  ''  (Count 1: never called)
    assert.deepEqual(
      splitOperator('abcd', (ch) => ch === 'c'),
      ['ab', 'd'],
    );
    assert.deepEqual(
      splitOperator('XX', (ch) => ch === 'X'),
      ['', '', ''],
    );
    assert.deepEqual(
      splitOperator('abc', () => true),
      ['', '', '', ''],
    );
    assert.deepEqual(
      splitOperator('abc', () => false),
      ['abc'],
    );
    assert.deepEqual(
      splitOperator('', () => true),
      [''],
    );
  });

  it('WRONG BEFORE PROBING: the scriptblock also receives the whole string and the index', () => {
    // Predicted the block saw only $_. Measured with a logging block:
    //   'abcd' -split { ... }  ->  i=0 _='a' s='abcd'
    //                              i=1 _='b' s='abcd'
    //                              i=2 _='c' s='abcd'
    //                              i=3 _='d' s='abcd'
    // so $args[0] is the subject and $args[1] is the index, and the LAST
    // character is visited too.
    const seen: string[] = [];
    splitOperator('abcd', (ch, whole, index) => {
      seen.push(`${String(index)}:${ch}:${whole}`);
      return false;
    });
    assert.deepEqual(seen, ['0:a:abcd', '1:b:abcd', '2:c:abcd', '3:d:abcd']);
  });

  it('accepts a truthy non-boolean from the scriptblock', () => {
    // pwsh: 'aXb' -split { $_ -eq 'X' ? 1 : 0 }  ->  a, b
    assert.deepEqual(
      splitOperator('aXb', (ch) => (ch === 'X' ? 1 : 0)),
      ['a', 'b'],
    );
  });

  it('honours SimpleMatch, and lets an explicit IgnoreCase beat the c prefix', () => {
    // pwsh: 'a.b' -split '.',0,'SimpleMatch'         ->  a, b
    // pwsh: 'a.b.c' -split '.',2,'SimpleMatch'       ->  a, 'b.c'
    // pwsh: 'aXb' -split 'x',0,'SimpleMatch'         ->  a, b
    // pwsh: 'aXb' -csplit 'x',0,'SimpleMatch'        ->  aXb
    // pwsh: 'aXb' -csplit 'x',0,'IgnoreCase'         ->  a, b
    assert.deepEqual(splitOperator('a.b', '.', 0, 'SimpleMatch'), ['a', 'b']);
    assert.deepEqual(splitOperator('a.b.c', '.', 2, 'SimpleMatch'), ['a', 'b.c']);
    assert.deepEqual(splitOperator('aXb', 'x', 0, 'SimpleMatch'), ['a', 'b']);
    assert.deepEqual(splitOperator('aXb', 'x', 0, 'SimpleMatch', SENSITIVE), ['aXb']);
    assert.deepEqual(splitOperator('aXb', 'x', 0, 'IgnoreCase', SENSITIVE), ['a', 'b']);
  });

  it('drops the captures under ExplicitCapture', () => {
    // pwsh: 'a1b' -split '(\d)',0,'ExplicitCapture'  ->  a, b
    assert.deepEqual(splitOperator('a1b', '(\\d)', 0, 'ExplicitCapture'), ['a', 'b']);
  });

  it("WRONG BEFORE PROBING: 'None' is not a SplitOptions member", () => {
    // Predicted a None member for "no options". There is not one; the enum has
    // exactly the eight names below and the reference implementation lists them
    // in its error:
    // pwsh: 'a b' -split ' ',0,'None'
    //   Cannot convert value "None" to type "System.Management.Automation.SplitOptions".
    //   ... Specify one of the following enumerator names and try again:
    //   SimpleMatch, RegexMatch, CultureInvariant, IgnorePatternWhitespace,
    //   Multiline, Singleline, IgnoreCase, ExplicitCapture
    assert.equal(SPLIT_OPTION_NAMES.includes('None' as never), false);
    assert.throws(
      () => splitOperator('a b', ' ', 0, 'None'),
      (error: unknown) => {
        assert.ok(error instanceof PSRuntimeError);
        assert.match(error.record.message, /Unable to match the identifier name None/);
        assert.match(
          error.record.message,
          /SimpleMatch, RegexMatch, CultureInvariant, IgnorePatternWhitespace, Multiline, Singleline, IgnoreCase, ExplicitCapture/,
        );
        return true;
      },
    );
  });

  it('concatenates the results over an array left operand', () => {
    // pwsh: @('a b','c d') -split ' '   ->  a, b, c, d       (Count 4)
    // pwsh: @('a,b','c,d') -split ',',2 ->  a, b, c, d       (the limit is per element)
    // pwsh: @(1,2) -split '1'           ->  '', '', '2'      (Count 3)
    assert.deepEqual(splitOperator(['a b', 'c d'], ' '), ['a', 'b', 'c', 'd']);
    assert.deepEqual(splitOperator(['a,b', 'c,d'], ',', 2), ['a', 'b', 'c', 'd']);
    assert.deepEqual(splitOperator([1, 2], '1'), ['', '', '2']);
  });

  it('raises the RAW .NET regex error, not the wrapped one -replace raises', () => {
    // pwsh: 'abc' -split '['    id=System.Text.RegularExpressions.RegexParseException
    // pwsh: 'abc' -replace '[','X'  id=InvalidRegularExpression
    assert.throws(
      () => splitOperator('abc', '['),
      (error: unknown) => {
        assert.ok(error instanceof PSRuntimeError);
        assert.equal(
          error.record.fullyQualifiedErrorId,
          'System.Text.RegularExpressions.RegexParseException',
        );
        return true;
      },
    );
  });

  it('unary -split collapses whitespace runs and trims', () => {
    // pwsh: -split '  a  b   c '  ->  a, b, c    (Count 3, no empties)
    // pwsh: -split "a`tb`nc"      ->  a, b, c
    // pwsh: -split ''             ->  ''         (Count 1)
    // pwsh: -split '   '          ->  ''         (Count 1)
    // pwsh: -split 'ab'           ->  ab
    // pwsh: -split @('a b','c d') ->  a, b, c, d
    assert.deepEqual(splitOnWhitespace('  a  b   c '), ['a', 'b', 'c']);
    assert.deepEqual(splitOnWhitespace('a\tb\nc'), ['a', 'b', 'c']);
    assert.deepEqual(splitOnWhitespace(''), ['']);
    assert.deepEqual(splitOnWhitespace('   '), ['']);
    assert.deepEqual(splitOnWhitespace('ab'), ['ab']);
    assert.deepEqual(splitOnWhitespace(['a b', 'c d']), ['a', 'b', 'c', 'd']);
  });
});

// ---------------------------------------------------------------------------
// -join
// ---------------------------------------------------------------------------

describe('-join stringifies through toPSString', () => {
  it('renders numbers the way PowerShell does, not the way JavaScript does', () => {
    // pwsh: @(0.1+0.2) -join ','  ->  0.3          (String(0.1+0.2) is 0.30000000000000004)
    // pwsh: @(1/3) -join ','      ->  0.333333333333333
    // pwsh: @(1.0) -join ','      ->  1
    // pwsh: @(1e21) -join ','     ->  1E+21
    assert.equal(joinOperator([0.1 + 0.2], ','), '0.3');
    assert.notEqual(String(0.1 + 0.2), '0.3');
    assert.equal(joinOperator([1 / 3], ','), '0.333333333333333');
    assert.equal(joinOperator([1.0], ','), '1');
    assert.equal(joinOperator([1e21], ','), '1E+21');
  });

  it('capitalises booleans and empties nulls', () => {
    // pwsh: @(1,$true) -join ','   ->  1,True
    // pwsh: @($null,1) -join ','   ->  ,1
    // pwsh: @() -join ','          ->  ''
    // pwsh: $null -join ','        ->  ''
    assert.equal(joinOperator([1, true], ','), '1,True');
    assert.equal(joinOperator([null, 1], ','), ',1');
    assert.equal(joinOperator([], ','), '');
    assert.equal(joinOperator(null, ','), '');
  });

  it('stringifies the separator too', () => {
    // pwsh: @(1,2) -join $null  ->  12
    // pwsh: @(1,2) -join 5      ->  152
    // pwsh: @(1,2) -join $true  ->  1True2
    assert.equal(joinOperator([1, 2], null), '12');
    assert.equal(joinOperator([1, 2], 5), '152');
    assert.equal(joinOperator([1, 2], true), '1True2');
  });

  it('is a plain conversion for a scalar left operand', () => {
    // pwsh: 1 -join ','     ->  1
    // pwsh: @('a') -join ',' -> a
    assert.equal(joinOperator(1, ','), '1');
    assert.equal(joinOperator(['a'], ','), 'a');
  });
});
