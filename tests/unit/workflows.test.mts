/**
 * Supply-chain and permission gates on the workflow files themselves.
 *
 * `upstream-sync.yml` runs unattended, on a schedule, from the default branch,
 * and one of its jobs holds `contents: write` and `pull-requests: write`. Every
 * action it calls executes inside that run. A tag is a mutable pointer: the same
 * `actions/checkout@v7` can be a different tree tomorrow, moved by whoever can
 * move that tag, and nothing in the repository would show a diff. A commit sha
 * cannot be moved.
 *
 * What this asserts is deliberately line-shaped rather than YAML-shaped. It is
 * not parsing the workflow — it is asserting a property of every line that names
 * an action, which is stricter than parsing and cannot be fooled by a `uses:`
 * that a parser would have skipped.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(import.meta.url), '..', '..', '..');

/**
 * Two normalisations, both of which this file got wrong first and both of which
 * would have made it pass on Linux and fail on Windows (or the reverse):
 *
 *   - globSync yields `\`-separated paths on Windows
 *   - `.gitattributes` declares `* text=auto eol=lf`, but core.autocrlf gives the
 *     working tree CRLF on Windows, so any `^…$` assertion anchored with `\n`
 *     silently stops matching
 */
const files = globSync('.github/workflows/*.yml', { cwd: REPO })
  .map((f) => f.replace(/\\/g, '/'))
  .sort();

const read = (file: string): string => readFileSync(resolve(REPO, file), 'utf8').replace(/\r\n/g, '\n');

/** Whole-line comments removed, so a property about lines that RUN is asserted over those. */
const codeOf = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

describe('workflow files', () => {
  it('finds the workflows at all', () => {
    // A glob that matches nothing passes every assertion below it. That is the
    // failure tools/run-tests.mts exists to prevent, and it is reachable here
    // too: rename the directory and this file goes green having checked nothing.
    assert.ok(files.length >= 2, `expected the workflows, found ${JSON.stringify(files)}`);
    assert.ok(files.includes('.github/workflows/upstream-sync.yml'));
    assert.ok(files.includes('.github/workflows/verify.yml'));
  });

  for (const file of files) {
    const text = read(file);
    const lines = text.split(/\r?\n/);
    const name = relative('.github/workflows', file);

    it(`${name}: pins every action to a full commit sha`, () => {
      const uses = lines
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => /^\s*(?:-\s+)?uses:\s*\S/.test(line));

      assert.ok(uses.length > 0, `${file} calls no actions at all — did the file change shape?`);

      for (const { line, n } of uses) {
        const ref = /uses:\s*(\S+)/.exec(line)?.[1] ?? '';
        assert.match(
          ref,
          /@[0-9a-f]{40}$/,
          `${file}:${n} uses "${ref}" — pin it to a full commit sha, not a tag.\n` +
            '  A tag is a mutable pointer; this workflow runs unattended with write ' +
            'permissions one job away.',
        );
        // The sha alone is unreadable. Every pin carries the human-readable tag
        // it corresponds to, so a reviewer can tell v7.0.1 from something else.
        assert.match(
          line,
          /#\s*v?\d+\.\d+\.\d+/,
          `${file}:${n} pins a sha with no "# vX.Y.Z" comment saying which release it is.`,
        );
      }
    });

    it(`${name}: declares permissions rather than inheriting the default`, () => {
      assert.match(
        text,
        /^permissions:/m,
        `${file} has no top-level permissions: block, so it inherits whatever the ` +
          'repository default happens to be.',
      );
    });
  }

  it('upstream-sync.yml grants write to one job, not to the whole workflow', () => {
    const text = read('.github/workflows/upstream-sync.yml');
    const top = /^permissions:(.*)$/m.exec(text)?.[1]?.trim();
    assert.equal(
      top,
      '{}',
      'the workflow-level permissions must be none; each job asks for exactly what it needs.',
    );
    // The write grant exists (this workflow cannot work without it) but is
    // indented under a job rather than sitting at column 0.
    assert.match(text, /^ {6}contents: write$/m);
    assert.match(text, /^ {6}pull-requests: write$/m);
    assert.doesNotMatch(text, /^contents: write$/m);
  });

  it('verify.yml stays read-only and hermetic', () => {
    const text = read('.github/workflows/verify.yml');
    assert.match(text, /^permissions:\n {2}contents: read$/m);
    // A live-network gate in required CI fails pull requests for reasons that
    // have nothing to do with the change under test — a shared-runner rate limit
    // returns 403 and the verifier correctly reports exit 2. The file explains
    // that in a comment, so the assertion is over the lines that run.
    assert.doesNotMatch(codeOf(text), /truth:check/);
  });

  it('the sync branch is a constant, not a date', () => {
    const text = read('.github/workflows/upstream-sync.yml');
    // Whole-line comments are stripped first, and the file quotes the old
    // expression in its header on purpose — the defect is worth recording where
    // someone would be tempted to reintroduce it. The property being asserted is
    // about lines that RUN, so the first version of this test, which searched
    // the whole file, failed on the documentation of the very bug it guards.
    const code = codeOf(text);

    // `upstream-sync/$(date -u +%Y-%m-%d)-${{ github.run_id }}` produced a
    // branch nothing had ever seen on every run, and therefore a second
    // near-identical pull request on every day the first was not merged.
    assert.doesNotMatch(code, /date -u \+%Y/);
    assert.doesNotMatch(code, /BRANCH=.*github\.run_id/);
    assert.match(code, /SYNC_BRANCH: automation\/upstream-release-truth/);
  });
});
