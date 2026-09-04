/**
 * wildcard.ts — `-like`'s pattern language, which is NOT a regular expression.
 *
 * Treating a wildcard as a regex is the classic way to get `-like` wrong, and it
 * fails in both directions: `'aXc' -like 'a.c'` is False because `.` is a
 * literal dot, and `'aaa' -like 'a+'` is False because `+` is a literal plus.
 * Every regex metacharacter measured — `. + ( ) { } ^ $ | \` — matches only
 * itself. The escape character is a BACKTICK, not a backslash: `'a\b' -like
 * 'a\b'` is True, so a backslash is data.
 *
 * THE ONE THAT WAS PREDICTED WRONG, AND IT IS NOT A SMALL ONE
 *
 * `[!a]` does NOT negate. PowerShell's wildcards have no negation at all; `!`
 * inside a bracket is an ordinary member of the set. Measured:
 *
 *   'abc' -like '[!a]bc'   ->  True     <- 'a' MATCHED [!a]
 *   'xbc' -like '[!a]bc'   ->  False    <- 'x' did NOT
 *   'a'   -like '[!b]'     ->  False
 *   'a'   -like '[!ab]'    ->  True
 *   '!'   -like '[!!]'     ->  True
 *
 * Under negation every one of those five would be the opposite. `[!...]` IS
 * negation in the filesystem provider's globbing and in `about_Wildcards`'
 * examples for it, which is where the belief comes from — but `-like` is
 * WildcardPattern, and WildcardPattern has no such rule. `[^a]` is likewise just
 * the set {^, a}: `'^bc' -like '[^a]bc'` and `'abc' -like '[^a]bc'` are BOTH
 * True.
 *
 * The rest of the grammar, all measured:
 *
 *   *              any run, including none, and it crosses newlines
 *   ?              exactly one character, newline included
 *   [abc]          a set
 *   [a-c]          a range; [c-a] is an ERROR, not an empty set
 *   [a-c-]         a trailing - is a literal member
 *   []a]           a ] FIRST in the set is a literal member
 *   []             an ERROR: "The specified wildcard character pattern is not valid: []"
 *   [abc           an ERROR: unterminated, and so is a bare trailing [
 *   `*  `?  `[  `` an escaped literal
 *   a`             a trailing backtick is a literal backtick ('a' -like 'a`' is False)
 *   ''             matches ONLY the empty string
 *
 * The whole pattern is anchored at both ends — `'abc' -like 'ab'` is False —
 * which is the other half of why it is not a regex.
 */

import { invalidWildcardPatternError, raise } from './errors.ts';

/** Characters that mean something to JavaScript's RegExp and nothing here. */
const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

const escapeLiteral = (text: string): string => text.replace(REGEX_SPECIALS, '\\$&');

/** Inside a character class only these three need escaping. */
const escapeClassMember = (ch: string): string => (/[\]\\^-]/.test(ch) ? `\\${ch}` : ch);

/**
 * Translate one bracket group, starting at the `[`.
 *
 * Returns the regex fragment and the index just past the closing `]`. Raises the
 * pattern-not-valid error for an unterminated group, an empty group, or a
 * reversed range — pwsh treats all three as invalid rather than as an empty
 * match.
 */
function readBracket(pattern: string, open: number): { fragment: string; next: number } {
  let i = open + 1;
  const members: string[] = [];

  // A ] in first position is a member, not the terminator. Measured:
  // ']' -like '[]]' is True while 'a' -like '[]' is an error.
  if (pattern[i] === ']') {
    members.push('\\]');
    i++;
  }

  while (i < pattern.length && pattern[i] !== ']') {
    let ch = pattern[i] as string;
    if (ch === '`') {
      i++;
      if (i >= pattern.length) break;
      ch = pattern[i] as string;
      members.push(escapeClassMember(ch));
      i++;
      continue;
    }
    // A range needs a '-' with a member on each side; a '-' at either edge of
    // the group is a literal. Measured: '-' -like '[a-c-]' is True.
    const isRange =
      pattern[i + 1] === '-' && i + 2 < pattern.length && pattern[i + 2] !== ']';
    if (isRange) {
      const to = pattern[i + 2] as string;
      // A reversed range is an ERROR, not an empty set. Measured:
      // 'b' -like '[c-a]' raises rather than answering False.
      if ((to.codePointAt(0) ?? 0) < (ch.codePointAt(0) ?? 0)) {
        raise(invalidWildcardPatternError(pattern));
      }
      members.push(`${escapeClassMember(ch)}-${escapeClassMember(to)}`);
      i += 3;
      continue;
    }
    members.push(escapeClassMember(ch));
    i++;
  }

  if (i >= pattern.length) raise(invalidWildcardPatternError(pattern));
  if (members.length === 0) raise(invalidWildcardPatternError(pattern));
  return { fragment: `[${members.join('')}]`, next: i + 1 };
}

/**
 * Compile a PowerShell wildcard into an anchored RegExp.
 *
 * `[\s\S]` rather than `.` because `*` and `?` cross newlines — measured:
 * `"a\nb" -like 'a?b'` is True. Using `.` with the `s` flag would work too, but
 * spelling it out keeps the intent local to the fragment that needs it.
 *
 * @throws PSRuntimeError carrying the wildcard-not-valid record.
 */
export function wildcardToRegExp(pattern: string, caseSensitive: boolean): RegExp {
  let source = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i] as string;
    if (ch === '*') {
      source += '[\\s\\S]*';
      i++;
    } else if (ch === '?') {
      source += '[\\s\\S]';
      i++;
    } else if (ch === '[') {
      const group = readBracket(pattern, i);
      source += group.fragment;
      i = group.next;
    } else if (ch === '`') {
      // A trailing backtick escapes nothing and stands for itself. Measured:
      // 'a' -like 'a`' is False, so the backtick did not vanish.
      const escaped = i + 1 < pattern.length ? (pattern[i + 1] as string) : '`';
      source += escapeLiteral(escaped);
      i += i + 1 < pattern.length ? 2 : 1;
    } else {
      source += escapeLiteral(ch);
      i++;
    }
  }
  return new RegExp(`^${source}$`, caseSensitive ? '' : 'i');
}

/** Does `text` match the wildcard `pattern`? */
export function wildcardMatches(text: string, pattern: string, caseSensitive: boolean): boolean {
  return wildcardToRegExp(pattern, caseSensitive).test(text);
}

/**
 * Escape a string so `-like` treats every character literally — the same job as
 * `[WildcardPattern]::Escape`, whose output was measured:
 *
 *   [WildcardPattern]::Escape('a*b?c[d]')  ->  a`*b`?c`[d`]
 *
 * Note that `]` IS escaped even though an unpaired `]` is already literal, and
 * that a backtick is NOT escaped by the reference implementation's Escape.
 */
export function escapeWildcard(text: string): string {
  return text.replace(/[*?[\]]/g, '`$&');
}
