/**
 * Replay every committed v1 transcript against a real browser and diff it.
 *
 * This is the third acceptance criterion of PR-01 — "a test can replay a
 * transcript and diff it" — and it is the only gate here that can tell whether
 * the fixtures still describe v1. tests/unit/v1-transcripts.test.mts proves the
 * committed files are coherent and unedited; a digest cannot notice that v1
 * itself changed, only re-execution can.
 *
 * IT IS DELIBERATELY NOT NAMED *.test.mts. `tools/run-tests.mts` globs
 * `tests/**\/*.test.mts` and `npm run verify` is asserted hermetic by
 * tests/unit/workflows.test.mts. Launching Chromium in that gate would make a
 * required, network-free check depend on a 130MB browser download, which is the
 * kind of unrelated failure that gets a gate muted. It runs under
 * `npm run test:browser` instead, on its own CI job, in the Playwright image
 * that already carries the browser.
 *
 * The comparison here is its own, not the tool's. tools/capture-v1.mts has a
 * `--check` path that does the same job, and reusing it would mean a bug in
 * that comparison could hide a real difference from this test as well.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { runCapture } from '../../tools/capture-v1.mts';
import {
  ARCHIVE,
  FIXTURES,
  lf,
  readManifest,
  sha256,
} from '../../tools/v1-fixtures.mts';

const committed = readManifest();

// One capture, at import time, reused by every assertion below. Sensitivity
// probing is off: it multiplies the run by six and the answers it produces are
// already recorded and asserted hermetically. What this file needs is the
// baseline transcript, and a second identical run per case to prove the
// baseline is reproducible — runCapture does that unconditionally.
const report = await runCapture({ probeSensitivity: false });

describe('v1 transcripts replayed in a real browser', () => {
  it('loaded the archive, and nothing else', () => {
    // A capture that quietly 404'd would produce an empty page and 128 empty
    // transcripts. The server serves exactly one path and records every
    // request, so this is checkable rather than assumed.
    const unexpected = [...new Set(report.requestedPaths)].filter(
      (p) => p !== '/legacy/terminal-v1.html',
    );
    assert.deepEqual(unexpected, [], 'the page asked for something other than the archive');
    assert.ok(report.requestedPaths.length >= report.manifest.cases.length);
  });

  it('agrees with the archive and the checked-in inventory about what v1 has', () => {
    // Three readings: the running page, the archive's literals, and
    // src/commands/v1-inventory.json. Any disagreement is reported by name.
    assert.deepEqual(report.inventoryProblems, [], `\n  ${report.inventoryProblems.join('\n  ')}\n`);
  });

  it('actually replayed something', () => {
    // The guard against the failure mode this repository is organised against.
    // Every diff assertion below passes vacuously over an empty case list.
    assert.equal(report.manifest.cases.length, committed.cases.length);
    assert.ok(report.manifest.cases.length >= 120, `only ${String(report.manifest.cases.length)} cases`);
    assert.equal(report.transcripts.size, report.manifest.cases.length);
    const rows = report.manifest.cases.reduce((n, c) => n + c.rows, 0);
    assert.ok(rows >= 1000, `only ${String(rows)} rows were printed across the whole capture`);
    // And the fixtures on disk are the ones being compared against, rather than
    // a set that happens to be empty.
    const onDisk = readdirSync(FIXTURES).filter((f) => f.endsWith('.txt'));
    assert.equal(onDisk.length, committed.cases.length);
  });

  it('reproduces every committed transcript byte for byte', () => {
    const problems: string[] = [];
    const bySlug = new Map(committed.cases.map((c) => [c.slug, c]));

    for (const record of report.manifest.cases) {
      const recorded = bySlug.get(record.slug);
      if (recorded === undefined) {
        problems.push(`${record.slug}: replayed now, absent from the committed manifest`);
        continue;
      }
      bySlug.delete(record.slug);

      const captured = report.transcripts.get(record.slug)?.text ?? null;
      assert.ok(captured !== null, `${record.slug} produced no transcript at all`);
      const committedText = lf(readFileSync(join(FIXTURES, recorded.file), 'utf8'));

      if (captured !== committedText) {
        const a = committedText.split('\n');
        const b = captured.split('\n');
        const at = a.findIndex((line, i) => line !== b[i]);
        problems.push(
          `${recorded.file}: line ${String(at + 1)}: committed ${JSON.stringify(a[at])} ` +
            `but v1 printed ${JSON.stringify(b[at])}`,
        );
        continue;
      }
      if (sha256(captured) !== recorded.sha256) {
        problems.push(`${recorded.file}: content matches but the recorded digest does not`);
      }
      if (JSON.stringify(record.styles) !== JSON.stringify(recorded.styles)) {
        problems.push(`${recorded.file}: the row styles changed`);
      }
      if (record.bootPrefixIntact !== recorded.bootPrefixIntact) {
        problems.push(`${recorded.file}: it no longer agrees about clearing the screen`);
      }
      if (record.editorOpen !== recorded.editorOpen || record.editorApp !== recorded.editorApp) {
        problems.push(`${recorded.file}: the editor overlay state changed`);
      }
      if (record.cwd !== recorded.cwd) {
        problems.push(`${recorded.file}: it left the shell in ${record.cwd}, not ${recorded.cwd}`);
      }
    }

    for (const orphan of bySlug.keys()) {
      problems.push(`${orphan}: committed, but the replay produced no such case`);
    }
    assert.deepEqual(problems, [], `\n  ${problems.join('\n  ')}\n`);
  });

  it('records nothing unstable, having run every case twice', () => {
    // runCapture runs each case twice under an identical pinned environment and
    // refuses to write a fixture for one whose two runs disagree. An entry here
    // means a transcript that was reproducible when captured no longer is.
    assert.deepEqual(
      report.manifest.unstable.map((u) => `${u.slug}: ${u.reason} — ${u.detail}`),
      [],
    );
  });

  it('threw no page error while running any command', () => {
    // A command that throws inside the page still returns rows — execOne
    // catches and prints `err` — so a broken archive would produce plausible
    // transcripts. Page-level errors escape that catch, and are collected.
    const failed = report.manifest.unstable.filter((u) => u.reason === 'page-error');
    assert.deepEqual(failed, []);
  });

  it('replayed the same archive the fixtures name', () => {
    const bytes = readFileSync(ARCHIVE);
    assert.equal(report.manifest.archive.sha256Normalised, committed.archive.sha256Normalised);
    assert.equal(report.manifest.archive.bytes, bytes.byteLength);
  });
});
