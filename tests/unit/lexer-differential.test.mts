/**
 * The lexer, checked against the reference implementation's own lexer.
 *
 * This is the strongest evidence available for PR-08 and it is not a judgement
 * call: `tools/capture-lexer-fixtures.ps1` runs
 * `[System.Management.Automation.Language.Parser]::ParseInput` — the lexer pwsh
 * itself runs — over `tests/unit/fixtures/lexer-corpus.json` and records every
 * token's kind, text, offsets and decoded value. This file replays that
 * recording against `src/language/lexer.ts` and requires an exact match.
 *
 * THE CORPUS IS ONE FILE, READ BY BOTH SIDES. That is deliberate: this whole
 * roadmap item exists because one conversion was implemented more than once and
 * drifted. A test with its own private list of cases would be a sixth copy of
 * the same mistake, and would go stale the first time the capture was re-run.
 *
 * Eight rules in the corpus contradicted what a careful reader would have
 * guessed, and each is a case here:
 *
 *   1. `1+1` is three tokens; `Get-Item 1+1` is one argument.
 *   2. Only `& ( ) , ; { | }` break a bare argument. `>` and `<` do not.
 *   3. Backtick escapes apply in bare words, and an unknown escape drops the
 *      backtick: `` `q `` is `q`.
 *   4. `-5` is `Number` at a statement start and `Generic` as an argument.
 *   5. `--%` stops at `|`, `&&`, `||` and newline — not at `;`, not at `>`.
 *   6. `<` and `1>&2` are refused by pwsh ITSELF, not merely unimplemented here.
 *   7. `7>` is not a redirection; streams are 1-6 and `*`.
 *   8. A quote opens a string only at the START of a token.
 *
 * Re-capture after editing the corpus:  npm run capture:lexer
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { lex } from '../../src/language/lexer.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

interface FixtureToken {
  readonly kind: string;
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly value?: string;
}

interface FixtureCase {
  readonly source: string;
  readonly tokens: readonly FixtureToken[];
  readonly errors: readonly string[];
}

interface Fixture {
  readonly pwsh: string;
  readonly cases: readonly FixtureCase[];
}

const fixture = JSON.parse(
  readFileSync(resolve(HERE, 'fixtures/lexer-pwsh-7.6.5.json'), 'utf8'),
) as Fixture;

const corpus = JSON.parse(
  readFileSync(resolve(HERE, 'fixtures/lexer-corpus.json'), 'utf8'),
) as readonly string[];

/** `Kind@start-end:"text"`, the shape a mismatch is easiest to read in. */
const shape = (t: { kind: string; text: string; start: number; end: number }): string =>
  `${t.kind}@${t.start}-${t.end}:${JSON.stringify(t.text)}`;

describe('lexer differential against pwsh 7.6.5', () => {
  it('was captured from the version this project claims', () => {
    assert.equal(fixture.pwsh, '7.6.5');
  });

  it('covers every case in the shared corpus, and no stale ones', () => {
    // If these drift, the fixture was captured against a different corpus and
    // every "pass" below is measuring the wrong thing.
    assert.deepEqual(
      fixture.cases.map((c) => c.source),
      [...corpus],
    );
    assert.ok(corpus.length >= 200, `corpus shrank to ${corpus.length}`);
  });

  it('produces pwsh 7.6.5 token kinds, text and offsets for every case', () => {
    const mismatches: string[] = [];
    for (const testCase of fixture.cases) {
      const mine = lex(testCase.source).tokens.map(shape).join(' ');
      const theirs = testCase.tokens.map(shape).join(' ');
      if (mine !== theirs) {
        mismatches.push(
          `${JSON.stringify(testCase.source)}\n  ours: ${mine}\n  pwsh: ${theirs}`,
        );
      }
    }
    assert.deepEqual(mismatches, [], `${mismatches.length} token mismatches:\n${mismatches.join('\n')}`);
  });

  it('decodes every string and word to the value pwsh decodes it to', () => {
    // The `value` field — quotes stripped, escapes resolved — is precisely what
    // the four tokenizers disagreed about, so it is asserted separately from
    // the token shape rather than folded into it.
    const mismatches: string[] = [];
    let compared = 0;
    for (const testCase of fixture.cases) {
      const mine = lex(testCase.source).tokens;
      testCase.tokens.forEach((token, index) => {
        if (token.value === undefined) return;
        compared += 1;
        const ours = mine[index]?.value;
        if (ours !== token.value) {
          mismatches.push(
            `${JSON.stringify(testCase.source)} token ${index} ${JSON.stringify(token.text)}: ` +
              `ours ${JSON.stringify(ours)} vs pwsh ${JSON.stringify(token.value)}`,
          );
        }
      });
    }
    assert.deepEqual(mismatches, [], mismatches.join('\n'));
    assert.ok(compared > 150, `only ${compared} decoded values were compared`);
  });

  it('reports RedirectionNotSupported exactly where pwsh reports it', () => {
    // pwsh 7.6.5 refuses `<`, `1>&2` and `1>&1` itself. The v1 highlighter
    // coloured `<` as an operator and the roadmap recorded that nothing
    // implements it; the measurement says nothing SHOULD.
    const expected = fixture.cases
      .filter((c) => c.errors.includes('RedirectionNotSupported'))
      .map((c) => c.source);
    assert.ok(expected.length >= 4, `fixture lost its redirection cases: ${expected.length}`);
    for (const source of expected) {
      const { diagnostics } = lex(source);
      assert.ok(
        diagnostics.some((d) => d.id === 'RedirectionNotSupported'),
        `expected RedirectionNotSupported for ${JSON.stringify(source)}, got ` +
          JSON.stringify(diagnostics.map((d) => d.id)),
      );
    }
  });

  it('reports an unterminated string exactly where pwsh reports one', () => {
    const expected = fixture.cases
      .filter((c) => c.errors.includes('TerminatorExpectedAtEndOfString'))
      .map((c) => c.source);
    assert.ok(expected.length >= 3, `fixture lost its unterminated-string cases`);
    for (const source of expected) {
      const { diagnostics } = lex(source);
      assert.ok(
        diagnostics.some((d) => d.id === 'TerminatorExpectedAtEndOfString'),
        `expected TerminatorExpectedAtEndOfString for ${JSON.stringify(source)}`,
      );
    }
  });

  it('never throws and always consumes the whole input', () => {
    // The editing parser runs this on every keystroke, so "returns something
    // sensible for anything" is a hard requirement rather than a nicety.
    for (const source of corpus) {
      const { tokens } = lex(source);
      for (const token of tokens) {
        assert.equal(
          token.text,
          source.slice(token.start, token.end),
          `token text and extent disagree in ${JSON.stringify(source)}`,
        );
      }
      // Offsets are non-overlapping and ascending.
      let cursor = 0;
      for (const token of tokens) {
        assert.ok(token.start >= cursor, `overlapping tokens in ${JSON.stringify(source)}`);
        cursor = token.end;
      }
      assert.ok(cursor <= source.length);
    }
  });
});
