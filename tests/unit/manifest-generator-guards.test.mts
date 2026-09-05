/**
 * The manifest generator's refusals, exercised by running it.
 *
 * These run the real tool as a subprocess against a temporarily altered
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

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCKFILE = join(REPO, 'compat', 'upstream', 'releases.lock.json');
const MANIFESTS = join(REPO, 'src', 'commands', 'manifests.json');

const original = { lock: readFileSync(LOCKFILE, 'utf8'), manifests: readFileSync(MANIFESTS, 'utf8') };

function generate(): { status: number | null; output: string } {
  const r = spawnSync(
    process.execPath,
    [join(REPO, 'tools', 'generate-command-manifests.mts')],
    { cwd: REPO, encoding: 'utf8' },
  );
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

afterEach(() => {
  // Restore both, always. A failed assertion mid-test must not leave the
  // repository holding a lockfile pointing at a release that does not exist.
  writeFileSync(LOCKFILE, original.lock, 'utf8');
  writeFileSync(MANIFESTS, original.manifests, 'utf8');
});

describe('an upstream LTS bump cannot silently delete measured metadata', () => {
  it('refuses when the declared LTS has no captured metadata', () => {
    const lock = JSON.parse(original.lock) as { channels: { lts: string } };
    lock.channels.lts = 'v7.6.6';
    writeFileSync(LOCKFILE, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');

    const r = generate();

    assert.notEqual(r.status, 0, 'a missing capture must not be a successful run');
    assert.match(r.output, /no captured metadata for the declared LTS v7\.6\.6/);
    assert.match(r.output, /capture:metadata/, 'and it names the command that fixes it');
    assert.equal(
      readFileSync(MANIFESTS, 'utf8'),
      original.manifests,
      'and it wrote nothing — a refusal that half-writes is worse than one that does not',
    );
  });

  it('still generates normally when the capture is there', () => {
    // The counterpart: a guard that refuses everything is not a guard.
    const r = generate();
    assert.equal(r.status, 0, r.output);

    const m = JSON.parse(readFileSync(MANIFESTS, 'utf8')) as {
      parameterReference: string;
      commands: { parameterSource: string }[];
    };
    assert.equal(m.parameterReference, 'v7.6.5');
    assert.equal(
      m.commands.filter((c) => c.parameterSource === 'reference-implementation').length,
      31,
      'the measured metadata is still there',
    );
  });
});
