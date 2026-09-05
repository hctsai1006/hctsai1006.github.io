/**
 * The drift gate.
 *
 * `manifests.json` declares which commands are `native-semantic` — "implemented
 * here, measured against real PowerShell". That declaration is a CLAIM, and a
 * claim with nothing behind it is exactly what this project exists not to make.
 * So this file asserts the two directions that can rot:
 *
 *   every native-semantic command that needs no filesystem HAS an
 *   implementation, in this directory or in one of the two sibling registries
 *
 *   every implementation here IS declared native-semantic, with the same
 *   capabilities the manifest says
 *
 * Adding a command to `classification.data.mts` with `native-semantic` and no
 * module fails the first. Implementing something here and quietly declaring a
 * capability the manifest does not list fails the second.
 *
 * It also gates the determinism rule: no module in `src/commands/native/` or
 * `src/commands/portfolio/` may read `Date.now()` or `Math.random()` outside
 * `services.ts`, because a command that reads ambient state directly cannot be
 * tested and cannot be compared against a recording.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import type { CommandModule } from '../../src/commands/invocation.ts';
import type { Capability, CommandManifest } from '../../src/commands/manifest.ts';
import { NATIVE_COMMANDS, defaultCatalogue } from '../../src/commands/native/index.ts';
import { PORTFOLIO_COMMANDS } from '../../src/commands/portfolio/index.ts';
import { ALL_COMMANDS, COMMAND_INDEX, HELD_BACK } from '../../src/commands/registry.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const MANIFESTS = (
  JSON.parse(readFileSync(join(REPO, 'src/commands/manifests.json'), 'utf8')) as {
    commands: readonly CommandManifest[];
  }
).commands;

/** Commands whose fidelity claim this directory is on the hook for. */
const NATIVE_SEMANTIC = MANIFESTS.filter((m) => m.fidelity === 'native-semantic');

const NEEDS_FILESYSTEM = (m: CommandManifest): boolean =>
  m.capabilities.some((c) => c.startsWith('filesystem.'));

/**
 * Everything implemented anywhere, from the registry rather than a hand-listed
 * union of three modules. The hand-listed version did not know about the
 * formatting or simulated modules, so it reported four implemented commands as
 * missing the moment those were declared.
 */
const IMPLEMENTED: ReadonlyMap<string, CommandModule> = COMMAND_INDEX;

/**
 * Commands deliberately kept out of the session, by name.
 *
 * Read from the registry rather than listed here, so that "we chose not to
 * register this" cannot be spelled as "we forgot". The coverage check below
 * subtracts exactly this set and nothing else, which is what stops it from
 * becoming an escape hatch — a command drops out of the check only by
 * declaring a non-`implemented` status in its own manifest, where a reviewer
 * reads it next to the reason.
 */
const HELD_BACK_NAMES = new Set(HELD_BACK.map((entry) => entry.module.manifest.name));

describe('the native-semantic set cannot drift', () => {
  it('implements every native-semantic command that needs no filesystem', () => {
    const missing = NATIVE_SEMANTIC.filter(
      (m) => !NEEDS_FILESYSTEM(m) && !IMPLEMENTED.has(m.name) && !HELD_BACK_NAMES.has(m.name),
    ).map((m) => m.display);
    assert.deepEqual(
      missing,
      [],
      'manifests.json declares these native-semantic with no filesystem capability, ' +
        'but nothing implements them: ' + missing.join(', '),
    );
  });

  it('holds back exactly what it says it holds back, and no more', () => {
    // The exemption above is only safe if this list is short, named, and
    // explained. Both entries are measured decisions, not omissions.
    assert.deepEqual(
      HELD_BACK.map((e) => [e.module.manifest.name, e.reason]).sort(),
      [
        ['sl', 'shadowed-token'],
        ['where-object', 'partial-implementation'],
      ],
    );
    for (const entry of HELD_BACK) {
      assert.ok(entry.explanation.length > 0, `${entry.module.manifest.name} has no explanation`);
      // Held back, but still describable: a visitor asking about it must get
      // an answer, and `notes` is where the limit is written down.
      assert.ok(
        (entry.module.manifest.notes ?? '').length > 0,
        `${entry.module.manifest.display} is held back with no notes`,
      );
    }
  });

  it('names the whole filesystem-free native-semantic set, so it cannot grow quietly', () => {
    // Named rather than counted, so that adding a command changes this list
    // deliberately instead of nudging a number. Twenty-three entries: the
    // eighteen this work implements, `help`, and the four object cmdlets that
    // live in the sibling registry.
    const scoped = NATIVE_SEMANTIC.filter((m) => !NEEDS_FILESYSTEM(m)).map((m) => m.name).sort();
    assert.deepEqual(scoped, [
      '$psversiontable', 'clear-host', 'format-list', 'format-table', 'format-wide',
      'get-advisory', 'get-award', 'get-command', 'get-contribution', 'get-date',
      'get-help', 'get-history', 'get-location', 'get-member', 'get-project',
      'get-publication', 'get-random', 'get-source', 'get-timeline', 'group-object',
      'help', 'measure-object', 'new-guid', 'out-null', 'out-string', 'select-object',
      'sort-object', 'where-object', 'whoami', 'write-output',
    ]);
    // New-Guid used to be implemented with no manifests.json entry, because that
    // file was generated from v1's inventory alone and v1 had no New-Guid. Seven
    // commands were in that state — implemented, tested, and invisible to
    // Get-Command, Get-Help and the fidelity badge. rewrite-inventory.data.mts
    // is the second source that closed it, so the assertion is now the opposite.
    assert.ok(IMPLEMENTED.has('new-guid'));
    assert.ok(MANIFESTS.find((m) => m.name === 'new-guid') !== undefined);

    // And the count this directory is on the hook for: twelve system modules
    // plus eight portfolio ones.
    assert.equal(NATIVE_COMMANDS.length, 12);
    assert.equal(PORTFOLIO_COMMANDS.length, 8);
  });

  it('declares set-location as the only filesystem-bearing native-semantic command', () => {
    // If this list grows, something filesystem-shaped was classified
    // native-semantic and the exclusion above silently got wider.
    assert.deepEqual(
      NATIVE_SEMANTIC.filter(NEEDS_FILESYSTEM).map((m) => m.name),
      ['set-location'],
    );
  });

  it('agrees with the manifest about capabilities for everything it implements', () => {
    for (const declared of NATIVE_SEMANTIC) {
      const module = IMPLEMENTED.get(declared.name);
      if (module === undefined) continue;
      assert.deepEqual(
        [...module.manifest.capabilities].sort(),
        [...declared.capabilities].sort(),
        `${declared.display}: the module and manifests.json disagree about capabilities`,
      );
    }
  });

  it('declares every module in this directory native-semantic', () => {
    for (const module of [...NATIVE_COMMANDS, ...PORTFOLIO_COMMANDS]) {
      assert.equal(
        module.manifest.fidelity,
        'native-semantic',
        `${module.manifest.display} is in a native registry but claims ${module.manifest.fidelity}`,
      );
      assert.equal(module.manifest.runtime, 'semantic');
    }
  });

  it('gives every module a distinct name and non-colliding aliases', () => {
    const seen = new Map<string, string>();
    for (const module of [...NATIVE_COMMANDS, ...PORTFOLIO_COMMANDS]) {
      for (const name of [module.manifest.name, ...module.manifest.aliases.map((a) => a.toLowerCase())]) {
        const owner = seen.get(name);
        assert.equal(owner, undefined, `${name} is claimed by both ${owner ?? '?'} and ${module.manifest.display}`);
        seen.set(name, module.manifest.display);
      }
    }
  });

  it('gives every module a synopsis and a note explaining its limits', () => {
    for (const module of [...NATIVE_COMMANDS, ...PORTFOLIO_COMMANDS]) {
      assert.ok(module.manifest.synopsis.length > 0, `${module.manifest.display} has no synopsis`);
      assert.ok(
        (module.manifest.notes ?? '').length > 0,
        `${module.manifest.display} has no notes: a native-semantic command must say what it ` +
          'does NOT do, or the fidelity label means nothing',
      );
    }
  });

  it('lets Get-Command report every implemented command', () => {
    const catalogue = new Set(defaultCatalogue().all().map((entry) => entry.manifest.name));
    // Command NAMES, not the index keys: the registry indexes aliases too, and
    // `?`, `ft` and `gm` are not things Get-Command lists as separate commands.
    const invisible = ALL_COMMANDS.map((m) => m.manifest.name)
      .filter((name) => !catalogue.has(name))
      .sort();

    // This used to assert ['get-member', 'group-object'] — a recorded gap.
    // Those two, New-Guid and the four formatting commands were implemented and
    // absent from manifests.json, because that file was generated from v1's
    // inventory alone and v1 had none of them. So Get-Command could not report
    // them, Get-Help could not describe them, and the fidelity badge had nothing
    // to show. rewrite-inventory.data.mts is the second source that closed it,
    // and the assertion is now that nothing is invisible.
    assert.deepEqual(invisible, []);
  });
});

// ---------------------------------------------------------------------------
// determinism
// ---------------------------------------------------------------------------

/**
 * Strip comments before scanning.
 *
 * Every file here TALKS about `Math.random()` in prose — that is the point of
 * the rule — so a raw text scan flags the documentation that explains the rule.
 * Only block comments and whole-line `//` comments are removed: stripping a
 * trailing `//` would also eat the `//` in a URL inside a string literal, and a
 * scan that quietly stops seeing half of each line is worse than one that
 * occasionally reads a comment.
 */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');
}

const AMBIENT: readonly (readonly [RegExp, string])[] = [
  [/\bDate\.now\s*\(/, 'Date.now()'],
  [/\bMath\.random\s*\(/, 'Math.random()'],
  [/\bnew Date\s*\(\s*\)/, 'new Date()'],
];

function ambientReads(label: string, text: string): readonly string[] {
  const body = withoutComments(text);
  return AMBIENT.filter(([pattern]) => pattern.test(body)).map(([, name]) => `${label}: ${name}`);
}

function sourcesUnder(directory: string): readonly { path: string; text: string }[] {
  const root = join(REPO, directory);
  return readdirSync(root)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ path: join(directory, name), text: readFileSync(join(root, name), 'utf8') }));
}

describe('no command reads ambient state directly', () => {
  it('keeps Date.now() and Math.random() inside services.ts', () => {
    const offenders: string[] = [];
    for (const directory of ['src/commands/native', 'src/commands/portfolio']) {
      for (const file of sourcesUnder(directory)) {
        if (file.path.endsWith('services.ts')) continue;
        offenders.push(...ambientReads(file.path, file.text));
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'a command that reads ambient state cannot be tested against a recording: ' +
        offenders.join(', '),
    );
  });

  it('proves the scan can still see a real call, by finding the ones in services.ts', () => {
    // A scanner that found nothing anywhere would pass the test above for the
    // wrong reason. services.ts is the ONE file allowed to read ambient state,
    // so it is also the control: if the scan cannot see it there, the scan is
    // broken and the rule above is vacuous.
    const services = readFileSync(join(REPO, 'src/commands/native/services.ts'), 'utf8');
    assert.deepEqual([...ambientReads('services.ts', services)].sort(), [
      'services.ts: Date.now()',
      'services.ts: Math.random()',
      'services.ts: new Date()',
    ]);
  });

  it('keeps the test files off the wall clock too', () => {
    const testDirectory = join(REPO, 'tests/unit');
    const offenders: string[] = [];
    for (const name of readdirSync(testDirectory)) {
      if (!name.startsWith('native')) continue;
      // The scanner names the three calls it looks for, in code, so it always
      // matches itself. Excluded by name rather than by making the patterns
      // unreadable — and it is the file whose own honesty the control test
      // above checks.
      if (name === 'native-registry.test.mts') continue;
      offenders.push(...ambientReads(name, readFileSync(join(testDirectory, name), 'utf8')));
    }
    assert.deepEqual(offenders, []);
  });
});

// ---------------------------------------------------------------------------
// the capability broker
// ---------------------------------------------------------------------------

describe('declared capabilities are actually requested', () => {
  it('names every capability any of these modules declares', () => {
    const declared = new Set<Capability>();
    for (const module of [...NATIVE_COMMANDS, ...PORTFOLIO_COMMANDS]) {
      for (const capability of module.manifest.capabilities) declared.add(capability);
    }
    // Only two, and both are asked for before any effect: Clear-Host requests
    // terminal.control, and every portfolio command requests portfolio.read.
    assert.deepEqual([...declared].sort(), ['portfolio.read', 'terminal.control']);
  });
});
