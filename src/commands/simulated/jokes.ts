/**
 * jokes.ts — ten commands that do nothing and say so.
 *
 *   bash  classic  coffee  fortune  konami  matrix  rocket  secret  sl  thc1006
 *
 * These are the least important commands in the project to get functionally
 * right and among the most important to keep honest, which is why they carry
 * the same SIMULATED badge and the same required note as `sudo` and `ping`.
 * A taxonomy that quietly exempted the jokes would be a taxonomy with a hole in
 * it, and the hole would be exactly where someone would later put something
 * that was not a joke.
 *
 * Two of them make a claim worth stating plainly:
 *
 *   konami   says "所有主題已解鎖" — all themes unlocked. Nothing is unlocked,
 *            because nothing was locked: `Set-Theme campbell|pi|blue` accepts
 *            all three before and after. It is a joke about a cheat code, and
 *            it changes no state at all. That is v1's behaviour and it is kept;
 *            what is added is that the manifest says the command changes
 *            nothing, so the claim in the text has a correction next to it.
 *
 *   bash     acknowledges the request and stays in PowerShell. There is no
 *   classic  second shell to start. `classic` points at `classic.html`, the
 *            archived bash-style terminal, as text — the link is the renderer's
 *            business. v1 carried a `{parts: […]}` row with a plain-text `txt`
 *            fallback beside the anchor; that fallback is what this emits, and
 *            a formatter is free to linkify it.
 *
 * Everything below is byte-identical to `legacy/terminal-v1.html`, down to the
 * spacing of the ASCII art. The tests do not trust that sentence: they
 * re-extract the `EGGS` object from the archive at run time and compare.
 */

import type { CommandModule } from '../invocation.ts';
import {
  EXIT_FAILURE,
  EXIT_SUCCESS,
  argumentsOf,
  fixedTextCommand,
  simulatedCommand,
  simulatedManifest,
  writeError,
  writeLines,
} from './support.ts';

// ---------------------------------------------------------------------------
// bash / classic
// ---------------------------------------------------------------------------

const CLASSIC_LINE = '舊版 bash CLI(user@hctsai1006)還在 -> classic.html';

/** v1's `bash` is literally `EGGS.classic()`, so the two share one line. */
function classic(): CommandModule {
  return fixedTextCommand('classic', () => [CLASSIC_LINE]);
}

function bash(): CommandModule {
  return fixedTextCommand('bash', () => [CLASSIC_LINE]);
}

// ---------------------------------------------------------------------------
// coffee
// ---------------------------------------------------------------------------

function coffee(): CommandModule {
  return fixedTextCommand('coffee', () => [
    '     )  (',
    '     (  )',
    '     )  (',
    '    ______',
    '   |      |]',
    '   |      |',
    '    \\____/',
    '',
    '   brewing... done. 給認真的你。',
  ]);
}

// ---------------------------------------------------------------------------
// rocket
// ---------------------------------------------------------------------------

/**
 * The three flame rows are classed `err` in v1 — which is the RED class, not an
 * error. They are output, and they stay on stream 1. See the note in
 * `support.ts`: this is the case that proved the CSS class cannot be read as a
 * stream selector.
 */
function rocket(): CommandModule {
  return fixedTextCommand('rocket', () => [
    '       /\\',
    '      /  \\',
    '     /    \\',
    '    /      \\',
    '   |        |',
    '   |  thc   |',
    '   |  1006  |',
    '   |        |',
    '  /|        |\\',
    ' / |        | \\',
    '/  |________|  \\',
    '     \\    /',
    '      \\  /',
    '       \\/',
    '',
    '   3... 2... 1... liftoff  (COSCUP 火箭導控 workshop, 2026)',
  ]);
}

// ---------------------------------------------------------------------------
// sl
// ---------------------------------------------------------------------------

const SL_MANIFEST = simulatedManifest('sl');

/**
 * A DISPATCH CONTRACT, not just a joke.
 *
 * In v1 `sl` is Set-Location's alias, and Set-Location itself contains the
 * branch that produces this train: `if (raw[0] === 'sl' && raw.length === 1)`.
 * So `sl` alone prints the train and `sl /tmp` changes directory. The generated
 * manifests keep both facts — `sl` is a command in its own right AND
 * `Set-Location` lists `sl` among its aliases — and `line-editor/inventory.ts`
 * already records the resolution: the command shadows the alias.
 *
 * That leaves the argument case, which this module deliberately does NOT
 * absorb. Printing the train for `sl /tmp` would silently swallow a directory
 * change the user asked for, which is worse than any joke is funny. So it fails
 * loudly and names the command that should have run. The coordinator's
 * dispatcher is what has to route `sl <path>` to `Set-Location`; if a visitor
 * ever sees this error, the routing is wrong and the message says where.
 */
function sl(): CommandModule {
  return simulatedCommand('sl', async (context, bound) => {
    if (argumentsOf(bound).length > 0) {
      await writeError(
        context,
        SL_MANIFEST,
        "sl with an argument is Set-Location's alias, not the train. This command implements " +
          'only the bare word; run Set-Location (or cd) to change directory.',
        'AliasShouldHaveResolvedToSetLocation',
        'InvalidArgument',
      );
      return EXIT_FAILURE;
    }
    await writeLines(context, [
      '         _',
      '        | |',
      '       _|_|__________',
      '      |   thc1006    |',
      '      |______________|',
      '        (O)      (O)',
      '   choo choo!  (你打對指令了)',
    ]);
    return EXIT_SUCCESS;
  });
}

// ---------------------------------------------------------------------------
// matrix
// ---------------------------------------------------------------------------

/**
 * Six rows of forty characters picked from a fixed alphabet by index, so the
 * "rain" is the same every time. Not random, and not animated: v1 computed
 * `cs[(r * 7 + i * 3) % cs.length]` once and printed it.
 *
 * Reproduced as the same arithmetic rather than as six baked strings, because
 * the arithmetic is what the archive states and the strings are a consequence
 * of it. The test checks the consequence against the archive.
 */
const MATRIX_ALPHABET = '01THC1006<>/{}[]|=+*01';

function matrixRows(): readonly string[] {
  const rows: string[] = [];
  for (let row = 0; row < 6; row += 1) {
    let text = '';
    for (let column = 0; column < 40; column += 1) {
      text += MATRIX_ALPHABET[(row * 7 + column * 3) % MATRIX_ALPHABET.length] ?? '';
    }
    rows.push(text);
  }
  return rows;
}

function matrix(): CommandModule {
  return fixedTextCommand('matrix', () => [
    'Wake up… follow the merged PRs.',
    '',
    ...matrixRows(),
  ]);
}

// ---------------------------------------------------------------------------
// fortune / thc1006 / konami / secret
// ---------------------------------------------------------------------------

/**
 * Not a fortune cookie: one fixed quotation, the same every run. v1 has no
 * fortune database and draws nothing at random, so this needs no generator and
 * takes no seed.
 */
function fortune(): CommandModule {
  return fixedTextCommand('fortune', () => [
    '「流淚撒種的,必歡呼收割。」',
    '                    — 詩篇 126:5',
  ]);
}

function thc1006(): CommandModule {
  return fixedTextCommand('thc1006', () => [
    'That is me. 打 whoami 看更多,或 Get-Contribution。',
  ]);
}

/** Unlocks nothing. See the note at the top of this file. */
function konami(): CommandModule {
  return fixedTextCommand('konami', () => [
    'Up Up Down Down Left Right Left Right B A — 你找到了。所有主題已解鎖:Set-Theme campbell|pi|blue',
  ]);
}

function secret(): CommandModule {
  return fixedTextCommand('secret', () => [
    '這個終端機藏了不少彩蛋:',
    '  coffee · rocket · matrix · fortune · konami · thc1006',
    '  sudo rm -rf /   ·   sudo apt install net-tools   後再打 ifconfig',
    '  sl (不帶參數)  ·  vim / nano  ·  chmod',
    '  classic — 回到舊版 bash 終端機 (user@hctsai1006)',
  ]);
}

// ---------------------------------------------------------------------------

export function jokeCommands(): readonly CommandModule[] {
  return [
    bash(),
    classic(),
    coffee(),
    fortune(),
    konami(),
    matrix(),
    rocket(),
    secret(),
    sl(),
    thc1006(),
  ];
}

/** Exported so the parity test can name the characters that make the slicer hard. */
export { MATRIX_ALPHABET };
