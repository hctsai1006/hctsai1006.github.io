/**
 * check-roadmap-evidence.mts — the CLI over tools/roadmap-evidence.mts.
 *
 * Runs the whole evidence check against this checkout and reports what it did,
 * not just whether it liked the result. The counts on stdout are the point: a
 * gate that prints "ok" without saying how much it looked at is indistinguishable
 * from a gate that looked at nothing, which is the failure mode every other tool
 * in this directory is written against.
 *
 * Exit codes, matching tools/verify-release-truth.mts:
 *   0  every claim resolved
 *   1  a claim did not hold
 *   2  the check could not be performed (bad flag, unreadable data, a test run
 *      that produced nothing) — never reported as success
 *
 * Usage:
 *   node tools/check-roadmap-evidence.mts
 *   node tools/check-roadmap-evidence.mts --verbose
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WORK } from '../roadmap/roadmap.data.mts';
import type { WorkItem } from '../roadmap/roadmap.data.mts';
import { checkEvidence, fsRepo, nodeTestRunner } from './roadmap-evidence.mts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// A closed set. `generate-roadmap.mts` carries the same guard because a mistyped
// flag there silently rewrote the file it was meant to be verifying.
const KNOWN_FLAGS = new Set(['--verbose']);

const argv = process.argv.slice(2);
const unknown = argv.filter((a) => !KNOWN_FLAGS.has(a));
if (unknown.length > 0) {
  process.stderr.write(
    `\n  unknown option(s): ${unknown.join(', ')}\n  known: ${[...KNOWN_FLAGS].join(', ')}\n\n`,
  );
  process.exit(2);
}
const verbose = argv.includes('--verbose');

const report = checkEvidence({
  repo: fsRepo(REPO),
  runner: nodeTestRunner(REPO),
  items: WORK as readonly WorkItem[],
});

if (report.fatal.length > 0) {
  process.stderr.write('\n  the evidence check could not be performed:\n');
  for (const f of report.fatal) process.stderr.write(`    - ${f}\n`);
  process.stderr.write('\n');
  process.exit(2);
}

if (report.findings.length > 0) {
  process.stderr.write('\n  the roadmap claims things the repository does not support:\n\n');
  for (const f of report.findings) process.stderr.write(`    ${f.where}: ${f.message}\n`);
  process.stderr.write(
    `\n  ${String(report.findings.length)} unsupported claim(s) across ` +
      `${String(report.evidenceChecked)} evidence item(s).\n` +
      '  Either the work is not done, or the citation is wrong. Fix the data, not this check.\n\n',
  );
  process.exit(1);
}

const lines = [
  `  roadmap evidence holds: ${String(report.evidenceChecked)} item(s) resolved for ` +
    `${String(report.tasksChecked)} task(s) claiming done or partial.`,
  `  ${String(report.citedTestsRun)} cited test(s) were run and passed.`,
  `  absence ratchet: ${String(report.ratcheted)} of ` +
    `${String(report.ratcheted + report.unratcheted.length)} open task(s) carry a check that ` +
    'goes red when the work lands.',
];
if (report.unratcheted.length > 0) {
  lines.push(
    `  not ratcheted (a build here would not be noticed): ${report.unratcheted.join(', ')}`,
  );
}
process.stdout.write(`${lines.join('\n')}\n`);

if (verbose) {
  process.stdout.write(
    `\n  tasks requiring evidence: ${String(report.tasksRequiringEvidence)}\n` +
      `  evidence items evaluated: ${String(report.evidenceChecked)}\n`,
  );
}
