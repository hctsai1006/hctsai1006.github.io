/**
 * Tests for the authoritative-source half of check-numbers.mts.
 *
 * The bug these exist to keep closed
 * ----------------------------------
 * `--authoritative` defaulted to
 *
 *     C:/Users/thc1006/Desktop/MAY/personal-homepage/open-source/index.html
 *
 * a local Windows path that CI can never resolve. So checks (5) and (6) — the
 * two that compare this repo's numbers against the authority that publishes
 * them — skipped on every CI run, and the script then printed
 *
 *     跑了 5/7 項檢查，略過 2 項
 *     OK 全部通過
 *
 * and exited 0. Two of seven checks never ran and the gate reported that
 * everything passed. That is the same failure the rest of this repository is
 * built to prevent, inside the tool meant to prevent it.
 *
 * The tests drive the real CLI rather than an extracted function on purpose:
 * the finding is about the exit code and the closing sentence, and those are
 * properties of the program, not of any function inside it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const SCRIPT = join(REPO, 'tools', 'check-numbers.mts');
const SNAPSHOT = join(REPO, 'snapshots', 'authoritative-open-source.json');

/** A path that cannot exist, written so Git Bash's path mangling cannot rescue it. */
const NO_SUCH = join(tmpdir(), 'check-numbers-does-not-exist', 'nothing.json');

interface Run {
  status: number | null;
  out: string;
}

function run(args: readonly string[]): Run {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    // The live authoritative page exists on the maintainer's machine and not in
    // CI. Every test here pins it explicitly so the two environments run the
    // same code path; leaving it to the default is what made this bug invisible.
    env: { ...process.env, AUTHORITATIVE_OPEN_SOURCE: NO_SUCH },
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('check-numbers: the committed authoritative snapshot', () => {
  it('runs (5) and (6) against the committed snapshot when the live page is unreachable', () => {
    const r = run(['--require-authoritative']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /⑤ 與 NYCU CS 權威來源一致/);
    assert.match(r.out, /⑥ contribTop \d+ 列的 CNCF 旗標全部與權威分桶一致/);
    assert.match(r.out, /跑了 7\/7 項檢查/);
    assert.doesNotMatch(r.out, /略過/);
  });

  it('says which source it compared against, rather than implying it saw the live page', () => {
    const r = run(['--require-authoritative']);
    assert.match(r.out, /快照本身這一輪未與 live 核對/);
  });

  it('never claims 全部通過 when a check was skipped', () => {
    const r = run([`--snapshot=${NO_SUCH}`]);
    // Skipping is not failing: without --require-authoritative this still exits 0.
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /⑤ 沒有可用的權威來源/);
    assert.match(r.out, /跑了 5\/7 項檢查，略過 2 項/);
    assert.doesNotMatch(r.out, /OK 全部通過/);
    assert.match(r.out, /OK 但不是全部通過/);
  });

  it('fails, and names the missing file, under --require-authoritative', () => {
    const r = run([`--snapshot=${NO_SUCH}`, '--require-authoritative']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /權威快照不可用/);
    assert.ok(r.out.includes(NO_SUCH), `expected the missing path in:\n${r.out}`);
    assert.match(r.out, /FAIL 1 項/);
  });

  it('fails when the snapshot disagrees with src/data instead of trusting the snapshot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-numbers-'));
    const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as {
      metrics: { merged: number };
    };
    snap.metrics.merged += 1;
    const path = join(dir, 'snapshot.json');
    writeFileSync(path, JSON.stringify(snap, null, 2) + '\n', 'utf8');

    const r = run([`--snapshot=${path}`, '--require-authoritative']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /⑤ 與權威來源不一致/);
  });

  it('rejects a snapshot whose shape is wrong rather than reading undefined off it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-numbers-'));
    const path = join(dir, 'snapshot.json');
    writeFileSync(path, JSON.stringify({ metrics: { merged: '276' } }) + '\n', 'utf8');

    const r = run([`--snapshot=${path}`, '--require-authoritative']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /欄位形狀不對/);
  });

  it('rejects an unknown option instead of silently ignoring it', () => {
    const r = run(['--require-authoritatve']);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /unknown option/);
  });
});
