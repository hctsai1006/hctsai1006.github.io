/**
 * The `git ls-files --eol` record shapes this gate has to survive.
 *
 * The gate exists because three source files shipped with a raw NUL byte and
 * nothing noticed: git calls such a file binary, GitHub renders "Binary file
 * not shown", and its lines vanish from the change count. So the gate matters.
 *
 * WHICH IS WHY IT MUST NOT DIE ON ORDINARY INPUT. It parsed each record with
 * `/^i\/(\S+)\s+w\/(\S+)\s+attr\/(.*)$/`, and `git ls-files --eol` leaves the
 * WORKING TREE field EMPTY for a file that is tracked but not currently on
 * disk. Straight from git, `cat -A` showing the tab as ^I:
 *
 *     i/lf    w/lf    attr/text=auto eol=lf ^Ipackage.json     (present)
 *     i/lf    w/      attr/text=auto eol=lf ^Ipackage.json     (deleted)
 *
 * `\S+` cannot match nothing, so the gate took its "could not parse" branch and
 * exited 3. That is an everyday state — a file deleted but not yet staged, an
 * interrupted rebase, a partial checkout — and it was reproduced by moving
 * `package.json` aside for one command. A required gate that aborts on a normal
 * repository is one that gets switched off.
 *
 * The fixtures below are built from parts rather than written as literals,
 * because the first version of this file hand-wrote them with TABS between the
 * three fields. Real records use SPACES between the fields and a tab only
 * before the path, so `indexOf('\t')` cut at the first field and four of six
 * tests failed against correct code. Naming the separators makes that mistake
 * impossible to repeat silently.
 *
 * `main()` sits behind `import.meta.main` so the parser can be imported without
 * running the check — the same reason `verify-release-truth.mts` needed it, and
 * there a top-level `main()` is why a boundary bug went untested.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseEolRecord } from '../../tools/check-source-bytes.mts';

/**
 * One record exactly as `git ls-files --eol -z` emits it: the three fields
 * separated by spaces, then a space, then a TAB, then the path.
 */
function record(index: string, working: string, attribute: string, path: string): string {
  return `i/${index}    w/${working}    attr/${attribute} \t${path}`;
}

describe('parsing a git ls-files --eol record', () => {
  it('reads an ordinary record', () => {
    const e = parseEolRecord(record('lf', 'lf', 'text=auto eol=lf', 'package.json'));
    assert.equal(e?.index, 'lf');
    assert.equal(e?.working, 'lf');
    assert.equal(e?.attribute, 'text=auto eol=lf');
    assert.equal(e?.path, 'package.json');
  });

  it('reads a record whose file is tracked but not on disk', () => {
    // The shape that used to abort the whole gate. Copied verbatim from the
    // reproduction, empty working-tree field and all.
    const e = parseEolRecord('i/lf    w/      attr/text=auto eol=lf \tpackage.json');
    assert.notEqual(e, null, 'an empty working-tree field is a normal record, not a parse failure');
    assert.equal(e?.index, 'lf', 'and the index value the gate actually checks is still there');
    assert.equal(e?.working, '');
    assert.equal(e?.path, 'package.json');
  });

  it('keeps a multi-word attribute out of the path', () => {
    // The path is what follows the TAB, never what follows the last space. A
    // `\S*` for the attribute once leaked `eol=lf` into the reported path.
    const e = parseEolRecord(record('crlf', 'crlf', '-text', 'legacy/terminal-v1.html'));
    assert.equal(e?.attribute, '-text');
    assert.equal(e?.path, 'legacy/terminal-v1.html');
  });

  it('keeps a path containing spaces intact', () => {
    const e = parseEolRecord(record('lf', 'lf', 'text=auto eol=lf', 'docs/a file with spaces.md'));
    assert.equal(e?.path, 'docs/a file with spaces.md');
  });

  it('reads the binary record the gate is actually looking for', () => {
    const e = parseEolRecord(record('-text', '-text', '', 'src/commands/select-object.ts'));
    assert.equal(e?.index, '-text');
    assert.equal(e?.attribute, '', 'nothing declared it binary, so git auto-detected a NUL');
  });

  it('returns null rather than guessing at a record it does not understand', () => {
    // Null, not a throw and not a partial Entry: the caller decides that an
    // unparseable record is fatal, and it does. Inventing fields would be the
    // failure this whole family of gates exists to prevent.
    assert.equal(parseEolRecord('no tab here at all'), null);
    assert.equal(parseEolRecord('garbage\tpath'), null);
    assert.equal(parseEolRecord(''), null);
  });
});
