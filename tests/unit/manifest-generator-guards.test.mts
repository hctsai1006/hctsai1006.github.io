/**
 * The manifest generator's refusals, exercised by running it.
 *
 * These run the real tool as a subprocess against an altered COPY of the
 * lockfile, because the behaviour under test is what the tool DOES on input it
 * has never been given — and the input it has never been given is the one the
 * scheduled upstream-sync job will eventually hand it.
 *
 * WHY THIS EXISTS. `manifests.json` embeds `parameterReference`, taken from
 * `channels.lts` in the release lockfile, and the parameter metadata behind it
 * is read from `compat/upstream/v<lts>/command-metadata.json`. The scheduled
 * job rewrites that lockfile whenever upstream moves, and a routine patch
 * release is enough to move it. Measured, by pointing the lockfile at a v7.6.6
 * for which no capture exists and regenerating:
 *
 *     parameterReference                    v7.6.5 -> v7.6.6
 *     commands with measured metadata           31 -> 0
 *     parameters                               341 -> 183
 *     exit code                                        0
 *
 * 158 measured parameters deleted, 31 commands quietly relabelled from
 * `reference-implementation` to `declared`, and the generator reported success.
 * Every downstream `--check` gate would then have agreed, because they compare
 * the artifact against the generator and the generator had just written it.
 *
 * That is this project's own failure mode pointed the other way: not claiming a
 * measurement never taken, but DISCARDING measurements that were, and calling
 * it a clean run. An automated sync would have shipped it unattended.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCKFILE = join(REPO, 'compat', 'upstream', 'releases.lock.json');
const MANIFESTS = join(REPO, 'src', 'commands', 'manifests.json');

const original = { lock: readFileSync(LOCKFILE, 'utf8'), manifests: readFileSync(MANIFESTS, 'utf8') };

// The tool runs on copies in a scratch directory. This test used to rewrite the
// repository's own lockfile and restore it afterwards, and the test runner runs
// files in parallel: tests/conformance read the lockfile in that window, saw an
// LTS of v7.6.6 and failed (2026-11-13). The repository's files are now never
// written, and the last test proves it.
const SCRATCH = mkdtempSync(join(tmpdir(), 'manifest-guards-'));
const ALTERED_LOCK = join(SCRATCH, 'releases.lock.json');
const OUT = join(SCRATCH, 'manifests.json');

function generate(lockfile: string): { status: number | null; output: string } {
  const r = spawnSync(
    process.execPath,
    [join(REPO, 'tools', 'generate-command-manifests.mts'), `--lock=${lockfile}`, `--out=${OUT}`],
    { cwd: REPO, encoding: 'utf8' },
  );
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

after(() => rmSync(SCRATCH, { recursive: true, force: true }));

describe('an upstream LTS bump cannot silently delete measured metadata', () => {
  it('refuses when the declared LTS has no captured metadata', () => {
    const lock = JSON.parse(original.lock) as { channels: { lts: string } };
    lock.channels.lts = 'v7.6.6';
    writeFileSync(ALTERED_LOCK, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');

    const r = generate(ALTERED_LOCK);

    assert.notEqual(r.status, 0, 'a missing capture must not be a successful run');
    assert.match(r.output, /no captured metadata for the declared LTS v7\.6\.6/);
    assert.match(r.output, /capture:metadata/, 'and it names the command that fixes it');
    assert.equal(
      existsSync(OUT),
      false,
      'and it wrote nothing — a refusal that half-writes is worse than one that does not',
    );
  });

  it('still generates normally when the capture is there', () => {
    // The counterpart: a guard that refuses everything is not a guard.
    const r = generate(LOCKFILE);
    assert.equal(r.status, 0, r.output);
    assert.equal(readFileSync(OUT, 'utf8'), original.manifests, 'the copy matches the committed manifests');

    const m = JSON.parse(readFileSync(OUT, 'utf8')) as {
      parameterReference: string;
      commands: { parameterSource: string }[];
    };
    assert.equal(m.parameterReference, 'v7.6.7');
    assert.equal(
      m.commands.filter((c) => c.parameterSource === 'reference-implementation').length,
      31,
      'the measured metadata is still there',
    );
  });

  it('leaves the lockfile and manifests in the repository untouched', () => {
    assert.equal(readFileSync(LOCKFILE, 'utf8'), original.lock);
    assert.equal(readFileSync(MANIFESTS, 'utf8'), original.manifests);
  });
});
