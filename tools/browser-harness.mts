/**
 * browser-harness.mts — run the archived v1 terminal in a real browser.
 *
 * WHY A BROWSER AT ALL. `legacy/terminal-v1.html` is 2113 lines of DOM-coupled
 * JavaScript: commands write rows into `#out` through `print()`, the filesystem
 * persists to `localStorage`, and the async commands schedule themselves with
 * `setTimeout`. None of that runs under Node. Until this file existed there was
 * no evidence anywhere in the repository of what v1 actually PRINTS for any
 * command, so "parity with v1" was an opinion.
 *
 * WHY http:// AND NOT file://. Chromium denies `localStorage` to `file://`
 * origins. v1 wraps every access in try/catch, so it would have degraded
 * quietly and the capture would have recorded a terminal with no persistence —
 * a plausible-looking transcript of a machine that does not exist. MEASURED
 * over http://: the `localStorage.setItem` probe succeeds, so the page takes
 * the same code paths the deployed site takes. tools/capture-v1.mts asserts
 * that probe rather than trusting this paragraph.
 *
 * WHAT IS PINNED, AND WHY EACH ONE
 *
 *   clock         `Date.now()` and `new Date()` are frozen. v1 reads them in
 *                 `Get-Date`, `uptime`, and every filesystem mutation (`stamp`,
 *                 `setChild`, `rmChild` write `mt`, which `ls -la` renders).
 *   seed          `Math.random` becomes a seeded PRNG. v1 reads it in
 *                 `Get-Random` and in `ping`/`Test-Connection` round-trip times.
 *   timezone      v1 renders times with `getHours()`/`getMonth()`, which are
 *                 LOCAL. MEASURED: `Get-ChildItem` prints `7/19/2026 12:00`
 *                 under UTC and `7/19/2026 20:00` under Asia/Taipei from the
 *                 same stored mtime.
 *   locale        MEASURED not to be inert, which was the opposite of the
 *                 expectation: V8 localises the zone name inside
 *                 `Date.prototype.toString()`.
 *   reduced motion  `asyncPrint` streams one row per `setTimeout` UNLESS
 *                 `prefers-reduced-motion: reduce`, in which case v1's own code
 *                 prints the whole batch at once. This is not a trick played on
 *                 the page: it is a branch the page already has, and taking it
 *                 makes ping/traceroute observable in one synchronous turn.
 *
 * The pinning is not hidden. Every knob is a parameter, and tools/capture-v1.mts
 * varies each one to find out which commands actually depend on it instead of
 * guessing. A transcript that is only true for one clock is recorded as such.
 *
 * WHAT IS NOT PINNED, said out loud: the browser build. Chromium's text layout,
 * `Intl` data and DOM behaviour are whatever the pinned Playwright ships. A
 * different build that prints something different fails the replay rather than
 * passing quietly.
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';

import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';

import { ARCHIVE, ARCHIVE_PATH, determinismScript } from './v1-fixtures.mts';
import type { Environment } from './v1-fixtures.mts';

/**
 * Serve exactly one file.
 *
 * Not a static file server over the repository. The capture must be able to say
 * that the page loaded the archive and nothing else, and the cheapest way to be
 * able to say it is to have nothing else to serve. Requests to any other path
 * are answered 404 and RECORDED, so a v1 that grew a fetch shows up as a missing
 * asset rather than as silence.
 */
export interface ArchiveServer {
  readonly url: string;
  /** Every path requested, in order. The capture asserts over this. */
  readonly requested: readonly string[];
  close(): Promise<void>;
}

export async function serveArchive(archive: string = ARCHIVE): Promise<ArchiveServer> {
  // Read once, up front: a capture that silently served a half-written file
  // would produce transcripts nobody could reproduce.
  const body = readFileSync(archive);
  const requested: string[] = [];

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    requested.push(path);
    if (path === ARCHIVE_PATH) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(body.byteLength),
        'cache-control': 'no-store',
      });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not served by the v1 harness');
  });

  await new Promise<void>((ok, bad) => {
    server.once('error', bad);
    server.listen(0, '127.0.0.1', ok);
  });

  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(address.port)}${ARCHIVE_PATH}`,
    requested,
    close: () =>
      new Promise<void>((ok, bad) => {
        server.close((err) => (err ? bad(err) : ok()));
      }),
  };
}

/** headless: the gate has to run with no display, on a runner and in a container. */
export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true });
}

export interface V1Page {
  readonly page: Page;
  readonly context: BrowserContext;
  readonly pageErrors: readonly string[];
  close(): Promise<void>;
}

/**
 * A page with the archive loaded and the environment pinned.
 *
 * A fresh CONTEXT per call, never a fresh page in a shared one: `localStorage`
 * is per-context, and v1 persists its whole filesystem there. Sharing a context
 * would let `New-Item` in one case change what `Get-ChildItem` prints in the
 * next, and the transcripts would depend on the order they were captured in.
 *
 * `reducedMotion` is a context option rather than an injected `setTimeout` stub
 * because v1 reads `matchMedia('(prefers-reduced-motion: reduce)')` itself and
 * already has a synchronous branch behind it. Faking timers instead would have
 * tested a code path the deployed site never takes.
 */
export async function openV1(
  browser: Browser,
  server: ArchiveServer,
  env: Environment,
): Promise<V1Page> {
  // ONE retry, counted and reported, never swallowed.
  //
  // A full capture opens about 1300 pages and a check about 260. Across roughly
  // 2800 opens while building this, exactly one failed inside openV1 — a
  // transient launch or navigation error on Windows, not reproducible in three
  // further attempts. At that rate a single-shot open makes an otherwise
  // deterministic gate fail for infrastructure reasons a few percent of the
  // time, and a gate that fails for reasons unrelated to the change under test
  // is a gate that gets muted.
  //
  // It hides nothing. `openRetries()` is read back by tools/capture-v1.mts and
  // printed, so a machine where this fires constantly says so instead of
  // quietly taking twice as long. And it cannot hide a WRONG page: every case
  // is captured twice and the two runs compared.
  try {
    return await openOnce(browser, server, env);
  } catch (first) {
    retries += 1;
    lastRetryReason = first instanceof Error ? first.message : String(first);
    return openOnce(browser, server, env);
  }
}

let retries = 0;
let lastRetryReason: string | null = null;

/** How many opens had to be retried, and why the last one did. */
export function openRetries(): { count: number; lastReason: string | null } {
  return { count: retries, lastReason: lastRetryReason };
}

async function openOnce(
  browser: Browser,
  server: ArchiveServer,
  env: Environment,
): Promise<V1Page> {
  const context = await browser.newContext({
    reducedMotion: 'reduce',
    locale: env.locale,
    timezoneId: env.timezoneId,
    // Fixed. `availCols()` divides the console width by a measured character
    // width; nothing on the transcript path uses it today, but a floating
    // viewport is a nondeterminism waiting to be introduced.
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
  });
  await context.addInitScript(determinismScript(env));

  const pageErrors: string[] = [];
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));

  const response = await page.goto(server.url, { waitUntil: 'load' });
  if (response === null || !response.ok()) {
    throw new Error(`the harness server did not serve the archive: ${String(response?.status())}`);
  }

  return { page, context, pageErrors, close: () => context.close() };
}
