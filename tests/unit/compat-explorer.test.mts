/**
 * compat-explorer.test.mts — assertions about the GENERATED page, not the
 * generator.
 *
 * Testing the artifact rather than importing the generator is deliberate:
 * tools/generate-compat-explorer.mts calls main() at module load, so importing
 * it to reach a helper would rewrite compat/explorer.html as a side effect of
 * running the test suite. The same shape as the `--chek` typo that regenerated
 * the files it was asked to verify.
 *
 * The page had no test at all, which is how a rendering bug survived in it: the
 * quote-normalisation in `prose` ran AFTER markup insertion, so it never
 * matched a quote in the text (esc had already made them `&quot;`) and instead
 * rewrote the class attributes it had just written, 113 times.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HTML = readFileSync(
  join(import.meta.dirname, '..', '..', 'compat', 'explorer.html'),
  'utf8',
);

describe('the generated explorer page', () => {
  it('has no attribute delimited by typographic quotes', () => {
    // `class=“mono”` parses as a valueless attribute named class=“mono”, so the
    // styling silently does not apply. Silent is the problem: the page looked
    // fine to anyone not checking which spans were actually mono.
    const broken = HTML.match(/\w+=[“”][^>]*/g) ?? [];
    assert.deepEqual(broken, [], 'markup must never be rewritten by prose formatting');
  });

  it('leaves no escaped quote entity in rendered prose', () => {
    // A quote that reaches the page as `&quot;` is one the normalisation was
    // supposed to have curled and could not, because escaping ran first.
    assert.equal(HTML.includes('&quot;'), false);
  });

  it('labels every documented-but-unemulated difference as such', () => {
    // The requirement the whole truth-model change exists to satisfy: a change
    // we do not reproduce must still be visible, and visibly not emulated.
    assert.ok(
      HTML.includes('documented, not emulated'),
      'the page must say what it does not emulate',
    );
  });

  it('shows the scoped switch keys rather than one engine-wide flag', () => {
    assert.ok(HTML.includes('switchParameter.New-Guid.Empty.honourExplicitFalse'));
    assert.equal(
      HTML.includes('switchParameters.honourExplicitFalse'),
      false,
      'the retired engine-wide flag must not reappear on the page',
    );
  });
});
