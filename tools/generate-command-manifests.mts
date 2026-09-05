/**
 * generate-command-manifests.mts — merge three sources into one manifest set.
 *
 *   what v1 implements   ←  src/commands/v1-inventory.json   (extracted)
 *   how real each is     ←  src/commands/classification.data.mts (judged)
 *   what its parameters  ←  compat/upstream/v<ver>/command-metadata.json
 *   actually are            (captured from a real PowerShell)
 *
 * The point of merging rather than hand-writing is that only the middle one is
 * a judgement. v1 declares 36 parameters across 67 commands; the reference
 * implementation reports 398 across 43. Hand-authoring parameter metadata would
 * mean inventing the other 362, and inventing an API is how an emulator ends up
 * confidently wrong.
 *
 * Four invariants are enforced. The first three have each already caught
 * something; the fourth guards a silent loss that has not happened yet:
 *
 *   1. Every command in the inventory must be classified. An unclassified
 *      command has no declared fidelity, which means the UI cannot tell the
 *      visitor whether it is real.
 *   2. Every `simulated` command must carry a note saying what it does NOT do.
 *      A fiction without a disclaimer is the failure this taxonomy exists for.
 *   3. Parameter metadata is marked `verified` only when it came from the
 *      reference implementation. Anything else is labelled `declared`, so the
 *      difference is visible rather than assumed.
 *   4. A parameter v1 declares must exist in the reference implementation, as a
 *      name or an alias, whenever captured metadata is being used. Captured
 *      metadata replaces the declaration rather than merging with it, so
 *      otherwise a v1-only parameter would disappear without a word and the
 *      manifest would describe a command the terminal does not have.
 *
 * Usage:
 *   node tools/generate-command-manifests.mts            write
 *   node tools/generate-command-manifests.mts --check    verify, exit 1 on drift
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLASSIFICATION } from '../src/commands/classification.data.mts';
import { REWRITE_COMMANDS, SHADOWED_V1_TOKENS } from '../src/commands/rewrite-inventory.data.mts';
import type { Classification } from '../src/commands/classification.data.mts';
import type { CommandManifest, ParameterMetadata } from '../src/commands/manifest.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const INVENTORY = join(REPO, 'src', 'commands', 'v1-inventory.json');
const LOCKFILE = join(REPO, 'compat', 'upstream', 'releases.lock.json');
const OUT = join(REPO, 'src', 'commands', 'manifests.json');

interface Inventory {
  commands: Array<{
    name: string;
    display: string;
    kind: string;
    params: string[];
    help: string;
    aliases: string[];
    streamsOutput: boolean;
    offersPaths: boolean;
  }>;
  easterEggs: string[];
}

interface CapturedParameter {
  type: string;
  isSwitch: boolean;
  aliases: string[];
  sets: Record<
    string,
    { position: number | null; isMandatory: boolean; valueFromPipeline: boolean }
  >;
  attributes: Array<{ type: string }>;
}

interface CapturedCommand {
  name: string;
  outputType: string[];
  parameters: Record<string, CapturedParameter>;
}

interface Captured {
  engine: { psVersion: string };
  commands: Record<string, CapturedCommand>;
}

const read = <T,>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;

/** Case-insensitive lookup: v1 keys commands in lower case, pwsh in Pascal. */
function findCaptured(captured: Captured, name: string): CapturedCommand | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(captured.commands)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

function parametersFrom(command: CapturedCommand): ParameterMetadata[] {
  return Object.entries(command.parameters)
    .map(([name, p]) => {
      // Keep the per-set truth. Flattening it away made `New-Item -Path` look
      // unconditionally mandatory (it is mandatory in 1 of 2 sets) and
      // `Test-Connection -Repeat` look required, which is absurd — and both were
      // stamped verified:true, contradicting this file's own invariant that
      // only captured facts carry that flag.
      const sets = Object.fromEntries(
        Object.entries(p.sets).map(([setName, s]) => [
          setName,
          {
            position: s.position,
            mandatory: s.isMandatory,
            valueFromPipeline: s.valueFromPipeline,
          },
        ]),
      );
      const values = Object.values(sets);
      const positions = values
        .map((s) => s.position)
        .filter((x): x is number => typeof x === 'number');
      return {
        name,
        aliases: p.aliases,
        type: p.type,
        isSwitch: p.isSwitch,
        sets,
        mandatoryInAnySet: values.some((s) => s.mandatory),
        mandatoryInEverySet: values.length > 0 && values.every((s) => s.mandatory),
        firstPosition: positions.length > 0 ? Math.min(...positions) : null,
        valueFromPipelineInAnySet: values.some((s) => s.valueFromPipeline),
        validation: p.attributes.map((a) => a.type).filter((t) => t.startsWith('Validate')),
        verified: true,
      } satisfies ParameterMetadata;
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** v1's `params` is a flat list of flag names with no type behind it. */
function declaredParameters(params: readonly string[]): ParameterMetadata[] {
  return params.map((raw) => ({
    name: raw.replace(/^-+/, ''),
    aliases: [],
    type: 'System.Object',
    isSwitch: false,
    sets: {},
    mandatoryInAnySet: false,
    mandatoryInEverySet: false,
    firstPosition: null,
    valueFromPipelineInAnySet: false,
    validation: [],
    verified: false,
  }));
}

function build(): { manifests: CommandManifest[]; problems: string[]; stats: Record<string, number> } {
  const inventory = read<Inventory>(INVENTORY);
  const lock = read<{ channels: { lts: string } }>(LOCKFILE);
  const ltsVersion = lock.channels.lts.replace(/^v/, '');
  const capturedPath = join(REPO, 'compat', 'upstream', `v${ltsVersion}`, 'command-metadata.json');
  const captured = existsSync(capturedPath) ? read<Captured>(capturedPath) : null;

  const problems: string[] = [];
  const manifests: CommandManifest[] = [];

  const entries: Array<{ name: string; display: string; aliases: string[]; help: string; params: string[] }> = [
    ...inventory.commands.map((c) => ({
      name: c.name,
      display: c.display,
      aliases: c.aliases,
      help: c.help,
      params: c.params,
    })),
    // Easter eggs are commands too. Leaving them out would let the least
    // honest part of the terminal be the only undeclared part.
    ...inventory.easterEggs.map((name) => ({
      name,
      display: name,
      aliases: [],
      help: '',
      params: [],
    })),
    // Commands the rewrite adds that v1 never had. Generating only from v1's
    // inventory made every one of them invisible to Get-Command, Get-Help and
    // the fidelity badge — implemented, tested, and outside the honesty
    // machinery entirely. See rewrite-inventory.data.mts.
    ...REWRITE_COMMANDS.map((c) => ({
      name: c.name,
      display: c.display,
      aliases: c.aliases,
      help: c.help,
      params: [] as string[],
    })),
  ];

  let verifiedCount = 0;

  for (const entry of entries) {
    const cls: Classification | undefined = CLASSIFICATION[entry.name];
    if (cls === undefined) {
      problems.push(`"${entry.name}" has no classification — its fidelity is undeclared`);
      continue;
    }
    if (cls.fidelity === 'simulated' && (cls.notes === undefined || cls.notes.trim() === '')) {
      problems.push(`"${entry.name}" is simulated but has no note saying what it does not do`);
    }

    const hit = captured === null ? undefined : findCaptured(captured, entry.name);
    const parameters = hit !== undefined ? parametersFrom(hit) : declaredParameters(entry.params);
    if (hit !== undefined) {
      verifiedCount++;
      // Invariant 4. Captured metadata REPLACES what v1 declared, it does not
      // merge with it — which is right, because the reference implementation is
      // the better source. But it also means a parameter v1 accepts that real
      // pwsh has no name for would vanish from the manifest without a word, and
      // the manifest would then describe a command the terminal does not have.
      //
      // No command is in that state today (measured: 0 across the 26 commands
      // with captured metadata), so this is a guard against a future edit rather
      // than a repair. It is an error and not a warning because the failure it
      // prevents is silent: nothing downstream can tell a dropped parameter from
      // one that never existed.
      const known = new Set<string>();
      for (const [name, p] of Object.entries(hit.parameters)) {
        known.add(name.toLowerCase());
        for (const alias of p.aliases) known.add(alias.toLowerCase());
      }
      const dropped = entry.params
        .map((raw) => raw.replace(/^-+/, ''))
        .filter((name) => !known.has(name.toLowerCase()));
      if (dropped.length > 0) {
        problems.push(
          `"${entry.name}" declares ${dropped.map((d) => `-${d}`).join(', ')}, which the ` +
            'reference implementation has no parameter or alias for. Captured metadata replaces ' +
            'the declaration, so these would be dropped silently. Either the name is wrong, or ' +
            'this command diverges from pwsh on purpose and needs somewhere to say so.',
        );
      }
    }

    manifests.push({
      name: entry.name,
      display: entry.display,
      aliases: entry.aliases,
      runtime: cls.runtime,
      fidelity: cls.fidelity,
      risk: cls.risk,
      capabilities: cls.capabilities,
      parameters,
      outputTypeNames: hit?.outputType ?? [],
      synopsis: entry.help,
      ...(cls.notes !== undefined ? { notes: cls.notes } : {}),
      parameterSource:
        hit !== undefined
          ? 'reference-implementation'
          : entry.params.length > 0
            ? 'declared'
            : 'none',
      // Stamped so every consumer of manifests.json sees the same answer for a
      // token whose name belongs to another command. Before this, the registry
      // ran Set-Location for `sl` while completion, Get-Help and the fidelity
      // badge all described the easter egg.
      ...(SHADOWED_V1_TOKENS.has(entry.name)
        ? { shadowedBy: SHADOWED_V1_TOKENS.get(entry.name)?.owner ?? '' }
        : {}),
    });
  }

  // Invariant 5. A token may not be BOTH a command's own name and another
  // command's alias, unless the data says which command owns it.
  //
  // v1 records `sl` twice — an easter egg in EGGS and an alias of set-location
  // in ALIAS — and BOTH are live: the alias resolves to set-location, whose own
  // `run` then checks the raw word and prints the train for the bare form
  // (legacy/terminal-v1.html:789). An earlier version of this comment claimed
  // the dispatcher made the egg unreachable. It does not, and the correction
  // matters: the token is not a contradiction to be discarded but a behaviour
  // this rewrite has not reproduced yet.
  //
  // Nothing downstream can resolve that: the registry throws, and before the
  // registry existed the kernel's `register` was last-write-wins with no error,
  // so whichever module loaded second silently took the name. Refused here
  // instead, because the answer is a judgement about which command a visitor
  // means and belongs in the data rather than in load order.
  const claimedNames = new Set(manifests.map((m) => m.name));
  for (const manifest of manifests) {
    for (const alias of manifest.aliases) {
      const key = alias.toLowerCase();
      if (claimedNames.has(key) && key !== manifest.name && !SHADOWED_V1_TOKENS.has(key)) {
        problems.push(
          `"${key}" is the name of one command and an alias of "${manifest.name}". ` +
            'One token cannot resolve to two commands; decide which, in the data.',
        );
      }
    }
  }

  // A classification for a command that does not exist is dead weight that will
  // quietly rot, so it is reported too.
  const known = new Set(entries.map((e) => e.name));
  for (const name of Object.keys(CLASSIFICATION)) {
    // A shadowed token keeps its classification on purpose: the egg still exists
    // in v1 and in this tree, and deleting the record of what it is would hide
    // the decision rather than document it.
    if (!known.has(name) && !SHADOWED_V1_TOKENS.has(name)) {
      problems.push(`"${name}" is classified but is not in the inventory`);
    }
  }

  manifests.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const byFidelity: Record<string, number> = {};
  for (const m of manifests) byFidelity[m.fidelity] = (byFidelity[m.fidelity] ?? 0) + 1;

  return {
    manifests,
    problems,
    stats: {
      total: manifests.length,
      verified: verifiedCount,
      parameters: manifests.reduce((n, m) => n + m.parameters.length, 0),
      ...byFidelity,
    },
  };
}

const serialise = (manifests: CommandManifest[], engine: string): string =>
  JSON.stringify(
    {
      $comment:
        'Generated by tools/generate-command-manifests.mts. Do not hand-edit: classification lives in src/commands/classification.data.mts, parameters come from the reference implementation.',
      parameterReference: engine,
      commands: manifests,
    },
    null,
    2,
  ) + '\n';

const KNOWN_FLAGS = new Set(['--check']);

function main(): void {
  const argv = process.argv.slice(2);
  const unknown = argv.filter((a) => !KNOWN_FLAGS.has(a));
  if (unknown.length > 0) {
    process.stderr.write(`\n  unknown option(s): ${unknown.join(', ')}\n\n`);
    process.exitCode = 2;
    return;
  }

  const { manifests, problems, stats } = build();

  if (problems.length > 0) {
    process.stderr.write('\n  command manifests are incomplete:\n');
    for (const p of problems) process.stderr.write(`    - ${p}\n`);
    process.stderr.write('\n');
    process.exitCode = 2;
    return;
  }

  const lock = read<{ channels: { lts: string } }>(LOCKFILE);
  const text = serialise(manifests, lock.channels.lts);

  if (argv.includes('--check')) {
    if (!existsSync(OUT) || readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') !== text) {
      process.stderr.write('\n  command manifests are out of date.\n  run: npm run manifests\n\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`  command manifests are in sync (${stats['total']} commands).\n`);
    return;
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text, 'utf8');
  process.stdout.write(
    `  wrote ${stats['total']} manifests: ` +
      `${stats['native-semantic'] ?? 0} native-semantic, ${stats['browser-backed'] ?? 0} browser-backed, ` +
      `${stats['simulated'] ?? 0} simulated\n` +
      `  ${stats['parameters']} parameters, ${stats['verified']} commands with reference-implementation metadata\n`,
  );
}

main();
