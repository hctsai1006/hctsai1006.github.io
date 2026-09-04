/**
 * extract-command-inventory.mts — the authoritative list of what the v1
 * terminal actually implements.
 *
 * Every plan for this rewrite has been written against a list of commands, and
 * a list written by hand is a list that is already wrong. This reads the real
 * `CMDLETS`, `ALIAS`, `DISP`, `APPS` and `EGGS` objects out of index.html so the
 * migration can prove it has covered everything, rather than believing it has.
 *
 * How the evaluation is made safe
 * -------------------------------
 * These objects contain function values (`run`, `pipe`) whose bodies reference
 * outer-scope helpers — `line`, `table`, `fsGet`, `D`. Function BODIES are not
 * executed when an object literal is defined, so the literal evaluates fine in a
 * context with no globals at all. See evaluateLiteral below for why an earlier
 * attempt to be more accommodating than that was a complete VM escape.
 *
 * The functions themselves are then discarded: only the declarative metadata is
 * extracted. Nothing from index.html is ever invoked.
 *
 * Usage:
 *   node tools/extract-command-inventory.mts            write the inventory
 *   node tools/extract-command-inventory.mts --check    verify, exit 1 on drift
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

import { readNamedLiteral } from './js-literal.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const SOURCE = join(REPO, 'index.html');
const OUT = join(REPO, 'src', 'commands', 'v1-inventory.json');

interface RawCommand {
  params?: string[];
  help?: string;
  type?: string;
  disp?: string;
  paths?: boolean;
  asyncOut?: boolean;
  hidden?: boolean;
}

/**
 * Pull one top-level `const NAME={...}` or `[...]` literal out of the page and
 * evaluate it in isolation.
 *
 * SECURITY. An earlier version of this passed the VM a Proxy whose `get` trap
 * returned a host-realm no-op function for every identifier, so that any
 * definition-time reference would resolve harmlessly. It did not resolve
 * harmlessly: handing VM code a host function hands it `Function` via
 * `.constructor`, which is a complete escape. An adversarial review demonstrated
 * reading `process.env` — including the GitHub token this repo's `verify` script
 * runs with — and writing a file to disk, from a plain object-literal property
 * value in index.html.
 *
 * The Proxy was also unnecessary. Function BODIES are not executed when an
 * object literal is defined, and none of the five literals here evaluates a
 * bare identifier at definition time, so a context with no globals at all runs
 * every one of them. `Object.create(null)` gives VM code nothing to reach
 * through: no `require`, no `process`, and no host object to borrow a
 * constructor from.
 *
 * The extracted functions are then discarded. Nothing from index.html is ever
 * called.
 */
function evaluateLiteral<T>(html: string, name: string): T {
  const literal = readNamedLiteral(html, name).text;
  const context = createContext(Object.create(null) as Record<string, never>);
  try {
    return runInContext(`(${literal})`, context, { timeout: 2000 }) as T;
  } catch (cause) {
    // The offset in a raw VM error points into a stripped string and names no
    // file, which is useless for finding the actual line in a 2113-line page.
    throw new Error(
      `could not evaluate the ${name} literal from index.html: ${(cause as Error).message}`,
      { cause },
    );
  }
}



function build(): {
  $comment: string;
  source: string;
  counts: Record<string, number>;
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
  applications: string[];
} {
  const html = readFileSync(SOURCE, 'utf8');

  const cmdlets = evaluateLiteral<Record<string, RawCommand>>(html, 'CMDLETS');
  const alias = evaluateLiteral<Record<string, string>>(html, 'ALIAS');
  const disp = evaluateLiteral<Record<string, string>>(html, 'DISP');
  const eggs = evaluateLiteral<Record<string, unknown>>(html, 'EGGS');
  const apps = evaluateLiteral<string[]>(html, 'APPS');

  // index.html back-fills `disp` and `type` in a normalisation loop after the
  // literal, so reproduce that here rather than reporting the raw literal.
  //
  // Copied verbatim from index.html:1334, INCLUDING the hyphen guard at :1348.
  // A reimplementation that always title-cased produced "Ls", "Cat", "Vim" and
  // "Lsb_release" — 30 of 67 names wrong, and shipped into manifests.json.
  // Native commands keep their real lower-case names; only Verb-Noun cmdlets
  // are title-cased.
  const toTitle = (n: string): string =>
    n
      .split('-')
      .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
      .join('-');

  const aliasesFor = (name: string): string[] =>
    Object.entries(alias)
      .filter(([, target]) => target === name)
      .map(([from]) => from)
      .sort();

  const commands = Object.keys(cmdlets)
    .sort()
    .map((name) => {
      const c = cmdlets[name] ?? {};
      return {
        name,
        display: c.disp ?? disp[name] ?? (name.indexOf('-') > 0 ? toTitle(name) : name),
        kind: c.type ?? (apps.includes(name) ? 'Application' : 'Cmdlet'),
        params: c.params ?? [],
        help: c.help ?? '',
        aliases: aliasesFor(name),
        streamsOutput: c.asyncOut === true,
        offersPaths: c.paths === true,
      };
    });

  return {
    $comment:
      'The v1 terminal inventory, extracted from index.html by tools/extract-command-inventory.mts. ' +
      'This is the coverage target for the rewrite: every entry needs a manifest before v1 can be retired.',
    source: 'index.html',
    counts: {
      commands: commands.length,
      aliases: Object.keys(alias).length,
      easterEggs: Object.keys(eggs).length,
      parameters: commands.reduce((n, c) => n + c.params.length, 0),
    },
    commands,
    easterEggs: Object.keys(eggs).sort(),
    applications: [...apps].sort(),
  };
}

const serialise = (v: unknown): string => JSON.stringify(v, null, 2) + '\n';
const KNOWN_FLAGS = new Set(['--check']);

function main(): void {
  const argv = process.argv.slice(2);
  const unknown = argv.filter((a) => !KNOWN_FLAGS.has(a));
  if (unknown.length > 0) {
    process.stderr.write(`\n  unknown option(s): ${unknown.join(', ')}\n\n`);
    process.exitCode = 2;
    return;
  }

  const inventory = build();
  const text = serialise(inventory);

  if (argv.includes('--check')) {
    if (!existsSync(OUT) || readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') !== text) {
      process.stderr.write('\n  the command inventory is out of date.\n  run: npm run inventory\n\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write('  command inventory is in sync.\n');
    return;
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text, 'utf8');
  const c = inventory.counts;
  process.stdout.write(
    `  wrote ${OUT}\n  ${c['commands']} commands, ${c['aliases']} aliases, ` +
      `${c['easterEggs']} easter eggs, ${c['parameters']} declared parameters\n`,
  );
}

main();
