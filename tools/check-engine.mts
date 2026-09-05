/**
 * check-engine.mts — refuse to run on a Node the toolchain does not support.
 *
 * WHY THIS EXISTS RATHER THAN `engines` ALONE. `package.json` declares
 * `engines.node` and `.npmrc` sets `engine-strict=true`, and that pair really
 * does gate installation — MEASURED, with the floor temporarily set to
 * `>=99.0.0`:
 *
 *     $ npm install --dry-run
 *     npm error engine Unsupported engine
 *     npm error notsup Required: {"node":">=99.0.0"}
 *     npm error notsup Actual:   {"npm":"11.6.2","node":"v24.13.0"}
 *
 * It does NOT gate `npm run`. The same wrong floor let `npm run typecheck`
 * complete normally, because `engine-strict` governs installation and nothing
 * else. So a contributor who already has `node_modules` — which is everyone,
 * after the first day — can run the entire suite on a Node the tools do not
 * support, and the failure would arrive as a confusing syntax error from type
 * stripping rather than as a version message.
 *
 * A first draft of tools/node-version.md claimed `engine-strict` closed this.
 * It was written before the measurement and the measurement refuted it; this
 * file is what makes the claim true instead.
 *
 * WHAT IT REFUSES TO GUESS. It understands `>=MAJOR.MINOR.PATCH`, which is the
 * shape this project uses. Any other range shape is an ERROR rather than a
 * pass: a version check that silently accepts a range it cannot parse is the
 * check-that-never-ran failure this repository is organised against, and it
 * would be invisible exactly when someone tightened the range.
 *
 * Usage:
 *   node tools/check-engine.mts
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface PackageJson {
  readonly engines?: { readonly node?: string };
}

function fail(message: string): never {
  process.stderr.write(`\n  ${message}\n\n`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as PackageJson;
const range = pkg.engines?.node;
if (range === undefined || range.trim() === '') {
  fail('package.json declares no engines.node. Nothing here can say which Node is supported.');
}

const parsed = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
if (parsed === null) {
  fail(
    `engines.node is "${range}", which this check does not understand. It handles ` +
      '">=MAJOR.MINOR.PATCH" only.\n  Refusing to report success for a range it cannot ' +
      'evaluate — teach tools/check-engine.mts the new shape instead of loosening it.',
  );
}

const required = [Number(parsed[1]), Number(parsed[2]), Number(parsed[3])] as const;
const actual = process.versions.node.split('.').map(Number) as [number, number, number];

const older =
  actual[0] < required[0] ||
  (actual[0] === required[0] &&
    (actual[1] < required[1] || (actual[1] === required[1] && actual[2] < required[2])));

if (older) {
  fail(
    `this repository needs Node ${range}, and this is v${process.versions.node}.\n` +
      '  Every tool and test here is a .mts file run directly, with no build step, so the\n' +
      '  toolchain rests entirely on native type stripping — which only became stable in\n' +
      '  24.12.0. See tools/node-version.md. .node-version names the tested release.',
  );
}

process.stdout.write(
  `  node v${process.versions.node} satisfies ${range} (unicode ${process.versions.unicode})\n`,
);
