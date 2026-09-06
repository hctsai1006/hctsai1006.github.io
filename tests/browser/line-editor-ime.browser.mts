/**
 * line-editor-ime.browser.mts — the platform facts src/input/ is built on,
 * re-measured in a real browser.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS SEPARATELY FROM tests/unit/line-editor-input.test.mts
 * ---------------------------------------------------------------------------
 *
 * The unit suite drives `TextareaInputAdapter` against a fifteen-line fake and
 * proves the adapter behaves correctly GIVEN a set of browser behaviours. It
 * cannot prove that browsers still behave that way, and a fake that has drifted
 * from the platform is worse than no fake: it makes a green suite mean nothing.
 *
 * This is the same relationship tests/unit/opfs-conformance.test.mts has with
 * tests/browser/opfs-backend.browser.mts, and the same rule applies — where this
 * file and the fake disagree, the browser is right and the fake is the bug.
 *
 * Every assertion here is a claim quoted from a comment in src/input/ime.ts or
 * src/input/textarea.ts. If one of them fails, that comment has become a lie and
 * the code resting on it needs re-reading, not the test relaxing.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DRIVES, AND THE ONE THING IT STILL CANNOT
 * ---------------------------------------------------------------------------
 *
 * Compositions are entered through the Chrome DevTools Protocol's
 * `Input.imeSetComposition`, which is the closest thing to an IME available
 * without an operating system one. That is also its limit, and the limit is
 * worth stating precisely because the third leg of the guard depends on it:
 *
 *   `Input.imeSetComposition` enters BELOW the keyboard layer and produces no
 *   keydown at all. So this file can prove what Chromium does WITH a keydown
 *   carrying keyCode 229 — that `isComposing` is false on it, and that a
 *   composition starting immediately afterwards starts later — but it cannot
 *   prove that Windows 注音 or GBoard sends one. That convention is old,
 *   universal in editor code, and unverified here.
 *
 * Chromium only. WebKit has no CDP, so the composition probes cannot be driven
 * there, and Firefox's Playwright build is not part of this project's install
 * step. The keyboard and field probes were additionally run by hand against
 * WebKit 26.4 on 2026-09-06 and agreed; that is a note, not a gate.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import type { Browser, CDPSession, Page } from 'playwright';

/** One row of the recorded event log, flattened so it survives `evaluate`. */
interface Recorded {
  readonly type: string;
  readonly key?: string;
  readonly keyCode?: number;
  readonly isComposing?: boolean;
  readonly inputType?: string;
  readonly data?: string | null;
  readonly value: string;
}

declare global {
  /** `var` and not `let`: only a `var` declaration adds a property to globalThis, which is what the in-page script writes to. */
  var LOG: Recorded[];
}

const PAGE = `<!doctype html><meta charset="utf-8">
<textarea id="t" rows="1"></textarea>
<script>
window.LOG = [];
const t = document.getElementById('t');
window.PREVENT = null;
function rec(e) {
  window.LOG.push({
    type: e.type,
    key: 'key' in e ? e.key : undefined,
    keyCode: 'keyCode' in e ? e.keyCode : undefined,
    isComposing: 'isComposing' in e ? e.isComposing : undefined,
    inputType: 'inputType' in e ? e.inputType : undefined,
    data: 'data' in e ? e.data : undefined,
    value: t.value,
  });
  if (window.PREVENT === e.type) e.preventDefault();
}
for (const n of ['keydown','compositionstart','compositionupdate','compositionend','beforeinput','input'])
  t.addEventListener(n, rec);
t.focus();
</script>`;

const browser: Browser = await chromium.launch();
const page: Page = await browser.newPage();
await page.setContent(PAGE);
await page.focus('#t');
const cdp: CDPSession = await page.context().newCDPSession(page);

const version = browser.version();

async function reset(): Promise<void> {
  await page.evaluate(() => {
    window.LOG = [];
    (document.getElementById('t') as HTMLTextAreaElement).value = '';
    (window as unknown as { PREVENT: string | null }).PREVENT = null;
  });
}

const log = async (): Promise<Recorded[]> => page.evaluate(() => window.LOG);

/** Compose `text` one character at a time, then commit it. */
async function compose(preEdits: readonly string[], commit: string | null): Promise<void> {
  for (const text of preEdits) {
    await cdp.send('Input.imeSetComposition', {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    });
  }
  if (commit !== null) await cdp.send('Input.insertText', { text: commit });
}

describe(`IME and textarea behaviour in Chromium ${version}`, () => {
  it('reports isComposing false on a keydown carrying the 229 sentinel', async () => {
    // The whole case for src/input/ime.ts. At this keydown the two legs the core
    // owns are both false — the flag says not composing, and compositionstart
    // has not fired — so only `keyCode === 229` is left to stop it.
    await reset();
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      windowsVirtualKeyCode: 229,
      nativeVirtualKeyCode: 229,
      key: 'Process',
    });
    await compose(['ㄘ'], null);

    const events = await log();
    const first = events[0];
    assert.equal(first?.type, 'keydown');
    assert.equal(first.keyCode, 229);
    assert.equal(first.isComposing, false, 'isComposing does not cover this keystroke');
    assert.equal(first.key, 'Process');
    assert.equal(
      events[1]?.type,
      'compositionstart',
      'the composition starts AFTER the keydown, so the sticky flag cannot cover it either',
    );
  });

  it('sets isComposing and keeps the real key code on a keydown inside a composition', async () => {
    // The case leg one covers: with the sticky flag lost, `isComposing` is the
    // only thing left, because Chromium does not rewrite the key code to 229.
    await reset();
    await compose(['ㄘ'], null);
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      windowsVirtualKeyCode: 13,
      key: 'Enter',
      code: 'Enter',
    });

    const keydowns = (await log()).filter((e) => e.type === 'keydown');
    assert.equal(keydowns.length, 1);
    assert.equal(keydowns[0]?.isComposing, true);
    assert.equal(keydowns[0]?.keyCode, 13, 'not 229 — the sentinel is not a substitute for the flag');
  });

  it('reports keyCode 0 for a KeyboardEvent constructed in script', async () => {
    // Why the sentinel is an equality test and not "a suspiciously high number".
    await reset();
    const observed = await page.evaluate(() => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true });
      return { keyCode: event.keyCode, isComposing: event.isComposing };
    });
    assert.deepEqual(observed, { keyCode: 0, isComposing: true });
  });

  it('fires input during the composition, before compositionend', async () => {
    // src/input/textarea.ts guards onInput twice for the two possible orderings.
    // This is the one that actually happens here, and the reason the first guard
    // (`event.isComposing`) is the one that fires in practice.
    await reset();
    await compose(['ㄘ', 'ㄘㄜ'], '測');
    const events = await log();

    const kinds = events.map((e) => e.type);
    assert.equal(kinds[0], 'compositionstart');
    assert.equal(kinds.at(-1), 'compositionend', 'compositionend is last');
    assert.ok(kinds.indexOf('input') < kinds.lastIndexOf('compositionend'));

    for (const event of events.filter((e) => e.type === 'input')) {
      assert.equal(event.isComposing, true, 'every input during a composition says so');
      assert.equal(event.inputType, 'insertCompositionText');
    }

    const end = events.at(-1);
    assert.equal(end?.data, '測', 'the committed string arrives on compositionend');
    assert.equal(end.value, '測', 'and the field already holds it');
  });

  it('ends a cancelled composition with an empty data string', async () => {
    // Which is why onCompositionEnd has no branch: insertText('') is a no-op.
    await reset();
    await compose(['ㄘ', ''], null);
    const end = (await log()).at(-1);
    assert.equal(end?.type, 'compositionend');
    assert.equal(end.data, '');
    assert.equal(end.value, '');
  });

  it('fires no event when value is assigned, so sync() cannot re-enter', async () => {
    await reset();
    const events = await page.evaluate(() => {
      const t = document.getElementById('t') as HTMLTextAreaElement;
      window.LOG = [];
      t.value = 'hello';
      return window.LOG;
    });
    assert.deepEqual(events, []);
  });

  it('moves the caret to the end on a changed value and leaves it on an identical one', async () => {
    // Why sync() calls setSelectionRange after writing, and why the equality
    // guard is about not touching the field rather than about the caret.
    const observed = await page.evaluate(() => {
      const t = document.getElementById('t') as HTMLTextAreaElement;
      t.value = 'abcdef';
      t.setSelectionRange(3, 3);
      t.value = t.value;
      const same = t.selectionStart;
      t.setSelectionRange(3, 3);
      t.value = 'abcXdef';
      return { same, changed: t.selectionStart };
    });
    assert.deepEqual(observed, { same: 3, changed: 7 });
  });

  it('suppresses beforeinput and input when keydown is preventDefault-ed', async () => {
    // The switch between "the core edited the line" and "the browser will, and
    // onInput reconciles the result".
    await reset();
    await page.evaluate(() => {
      (window as unknown as { PREVENT: string | null }).PREVENT = 'keydown';
    });
    await page.keyboard.press('Enter');
    assert.deepEqual((await log()).map((e) => e.type), ['keydown']);

    await reset();
    await page.keyboard.press('Enter');
    assert.deepEqual((await log()).map((e) => e.type), ['keydown', 'beforeinput', 'input']);
  });

  it('throws InvalidStateError from setSelectionRange only on a control with no selection', async () => {
    // v1 wrapped this call in try/catch and so does sync(). Measured: a textarea
    // does not throw, attached or not — the case the catch is really for is a
    // host satisfying TextareaLike with something that is not a textarea.
    const observed = await page.evaluate(() => {
      const result: Record<string, string> = {};
      const attempt = (name: string, element: HTMLTextAreaElement | HTMLInputElement): void => {
        try {
          element.setSelectionRange(2, 2);
          result[name] = 'ok';
        } catch (cause) {
          result[name] = cause instanceof Error ? cause.name : String(cause);
        }
      };
      const detached = document.createElement('textarea');
      detached.value = 'hello';
      attempt('detached', detached);

      const hidden = document.createElement('textarea');
      hidden.value = 'hello';
      hidden.style.display = 'none';
      document.body.appendChild(hidden);
      attempt('hidden', hidden);

      const email = document.createElement('input');
      email.type = 'email';
      email.value = 'a@b.c';
      document.body.appendChild(email);
      attempt('email', email);
      return result;
    });
    assert.deepEqual(observed, { detached: 'ok', hidden: 'ok', email: 'InvalidStateError' });
  });

  it('fires selectionchange asynchronously after a programmatic setSelectionRange', async () => {
    // The measurement behind the equality check in #reconcile. sync() moves the
    // caret; this event comes back a tick later; without the check it would call
    // setBuffer and close a completion menu that had just opened.
    const observed = await page.evaluate(async () => {
      const t = document.getElementById('t') as HTMLTextAreaElement;
      t.value = 'abcdef';
      t.setSelectionRange(5, 5);
      // Drain whatever that first move queued, so the counts below are only
      // about the move made after the listener is attached.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const seen: string[] = [];
      const onDocument = (): void => void seen.push('document');
      document.addEventListener('selectionchange', onDocument);
      t.setSelectionRange(1, 1);
      const immediate = seen.length;
      await new Promise((resolve) => setTimeout(resolve, 50));
      document.removeEventListener('selectionchange', onDocument);
      return { immediate, afterTick: seen.length };
    });
    assert.equal(observed.immediate, 0, 'not synchronous, so a handler cannot see it inside sync()');
    assert.ok(observed.afterTick > 0, 'but it does arrive, which is what #reconcile has to survive');
  });

  it('closes the browser it opened', async () => {
    // Not decoration: `node --test` will not exit while Chromium is alive, and a
    // browser suite that hangs looks exactly like one that is slow.
    //
    // This step is slow — tens of seconds — and an earlier version of this
    // comment blamed the CDP session and claimed detaching first fixed it. That
    // was a guess, and measuring it said otherwise: across five runs on this
    // Windows machine `browser.close()` took 3s, 25s, 39s, 43s and 73s, and the
    // 43s one had no CDP session at all. The cost is the platform's. `detach()`
    // stays as hygiene, not as a speed-up.
    await cdp.detach();
    await browser.close();
    assert.equal(browser.isConnected(), false);
  });
});
