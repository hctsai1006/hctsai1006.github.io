/**
 * support.ts — the plumbing shared by the twenty-six simulated commands.
 *
 * Three jobs, each of which exists to stop a specific dishonesty:
 *
 *   1. MANIFESTS ARE READ, NOT WRITTEN.  `simulatedManifest` looks the command
 *      up in `src/commands/manifests.json`, which is generated from
 *      `classification.data.mts`. Nothing in this directory may state its own
 *      fidelity, risk or capabilities. A command that declared them locally
 *      could quietly disagree with the classification a reviewer read, and
 *      `Get-Command -Detailed` would then print one thing while the code did
 *      another. The lookup also REFUSES a manifest that is not `simulated` and
 *      one that carries no `notes`, because a fiction without a note is the
 *      exact failure the taxonomy exists to prevent.
 *
 *   2. STREAM 2 IS A REAL STREAM.  v1 had one output channel, so
 *      `ifconfig: SIOCGIFCONF: Function not implemented` arrived on the same
 *      wire as a directory listing and could not be caught, counted or
 *      redirected. Here it is an ErrorRecord on stream 2.
 *
 *      Which lines those are is a JUDGEMENT PER COMMAND and not a mechanical
 *      translation of v1's CSS classes, because the classes do not mean what
 *      they look like they mean. `err` is the red one. `rocket` paints its
 *      exhaust flames with it — three rows of ASCII art classed `err` — and a
 *      rule that routed every `err` row to stream 2 would put a rocket's fire
 *      in `$Error`. (That rule was written first, and the parity test caught
 *      it, which is the whole reason the tests replay the archive instead of
 *      trusting a transcription.) Of everything v1 printed in this family,
 *      exactly three lines are errors here: `sudo: command not found` and
 *      `ifconfig`'s two failures. The rewrite adds a few of its own — a
 *      parameter set it does not implement, a process property that does not
 *      exist — and those are errors because they say a limit, not because a
 *      stylesheet painted something red.
 *
 *   3. NO COMMAND TOUCHES A BROWSER API.  There is deliberately no helper here
 *      for fetching, storing, or reading anything. The only capability call any
 *      command in this directory makes goes through
 *      `context.requireCapability`, which is the broker.
 */

import manifestsJson from '../manifests.json' with { type: 'json' };

import type { PSValue } from '../../pipeline/psobject.ts';
import type { ErrorCategory } from '../../pipeline/streams.ts';
import { errorRecord } from '../../pipeline/streams.ts';
import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import type { CommandManifest } from '../manifest.ts';

// ---------------------------------------------------------------------------
// manifests
// ---------------------------------------------------------------------------

/**
 * The slice of the generated file this module reads back.
 *
 * Declared locally, as `line-editor/inventory.ts` does, so that widening
 * `CommandManifest` cannot silently widen what a runtime cast is claiming. The
 * fields are checked below rather than trusted.
 */
interface ManifestsFile {
  readonly commands: readonly CommandManifest[];
}

const ALL_MANIFESTS: readonly CommandManifest[] = (manifestsJson as unknown as ManifestsFile)
  .commands;

/** Every command the generated manifests classify `simulated`, by name. */
export const SIMULATED_MANIFEST_NAMES: readonly string[] = ALL_MANIFESTS.filter(
  (m) => m.fidelity === 'simulated',
)
  .map((m) => m.name)
  .sort();

/**
 * Fetch one manifest and refuse anything that is not what this directory is for.
 *
 * Throwing at module load is deliberate. The alternative — returning a
 * placeholder — would produce a command that runs, prints, and misdeclares
 * itself, which is worse than a build that does not start.
 */
export function simulatedManifest(name: string): CommandManifest {
  const found = ALL_MANIFESTS.find((m) => m.name === name);
  if (found === undefined) {
    throw new Error(
      `No manifest named '${name}' in src/commands/manifests.json. Manifests are generated ` +
        'from classification.data.mts; add the classification rather than declaring one here.',
    );
  }
  if (found.fidelity !== 'simulated') {
    throw new Error(
      `'${name}' is classified ${found.fidelity}, not simulated. It does not belong in ` +
        'src/commands/simulated/.',
    );
  }
  if (found.notes === undefined || found.notes.trim() === '') {
    throw new Error(
      `'${name}' is simulated but carries no notes. A fiction with no note is the thing the ` +
        'fidelity taxonomy exists to prevent; the note belongs in classification.data.mts.',
    );
  }
  return found;
}

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

/**
 * The tokens after the command name.
 *
 * Every Linux-facade command here declares no parameters, which the binder
 * treats as "everything is `remaining`" — see the note in `binder.ts`. That is
 * correct rather than lazy: `uname -a`, `ps aux` and `git status` are not
 * PowerShell parameter syntax, and binding them as if they were would invent
 * metadata the reference implementation never reported for them.
 */
export function argumentsOf(bound: BindingResult): readonly string[] {
  return bound.remaining;
}

/** v1's `stripQ`: one leading and one trailing quote, nothing cleverer. */
function stripQuotes(text: string): string {
  return text.replace(/^["']|["']$/gu, '');
}

/**
 * v1's `firstArg`: the first token that does not start with a dash.
 *
 * The test is `/^-/` and NOT the binder's `/^-{1,2}[A-Za-z]/`, which is a real
 * difference — v1's `firstArg` skips `-5` where the binder would bind it as a
 * negative number. Reproduced rather than tidied, because these commands are
 * being held to v1's behaviour and a "fix" here would be an unannounced change.
 */
export function firstArgument(args: readonly string[]): string {
  for (const token of args) {
    if (!token.startsWith('-')) return stripQuotes(token);
  }
  return '';
}

/** v1 reads its subcommand from the first token, dash or not: `ip addr`, `git log`. */
export function subcommandOf(args: readonly string[]): string {
  return (args[0] ?? '').toLowerCase();
}

// ---------------------------------------------------------------------------
// emitting
// ---------------------------------------------------------------------------

/**
 * Write text lines to stream 1, stopping if the consumer walks away.
 *
 * Strings, not pre-rendered rows. v1's commands returned `{cls, txt}` objects
 * carrying a CSS class, which is how its pipeline came to carry formatting: by
 * the time `Sort-Object` saw a row it was already a rendered line. Colour is
 * the renderer's decision and is not represented here at all.
 */
export async function writeLines(
  context: InvocationContext,
  lines: readonly string[],
): Promise<void> {
  const sink = context.streams.success;
  for (const text of lines) {
    if (sink.closed || context.signal.aborted) return;
    await sink.write(text);
  }
}

export async function writeValues(
  context: InvocationContext,
  values: readonly PSValue[],
): Promise<void> {
  const sink = context.streams.success;
  for (const value of values) {
    if (sink.closed || context.signal.aborted) return;
    await sink.write(value);
  }
}

/** One ErrorRecord on stream 2 — where v1 wrote a line classed `err`. */
export async function writeError(
  context: InvocationContext,
  manifest: CommandManifest,
  message: string,
  errorId: string,
  category: ErrorCategory = 'NotSpecified',
): Promise<void> {
  await context.streams.error.write(
    errorRecord(message, errorId, manifest.display, category),
  );
}

// ---------------------------------------------------------------------------
// exit codes
// ---------------------------------------------------------------------------

/**
 * POSIX's "command not found". v1 had no exit codes at all — every command
 * returned rows — so `$LASTEXITCODE` could not exist. Where a real tool's code
 * is unambiguous it is used; where it is not, a command that wrote to stream 2
 * exits 1 and one that did not exits 0.
 */
export const EXIT_COMMAND_NOT_FOUND = 127;
export const EXIT_FAILURE = 1;
export const EXIT_SUCCESS = 0;

// ---------------------------------------------------------------------------
// defining a command
// ---------------------------------------------------------------------------

export type SimulatedBody = (
  context: InvocationContext,
  bound: BindingResult,
) => Promise<number>;

/**
 * A `CommandModule` whose manifest comes from the generated file and whose body
 * is the only thing this directory writes.
 */
export function simulatedCommand(name: string, body: SimulatedBody): CommandModule {
  const manifest = simulatedManifest(name);
  return {
    manifest,
    invoke: (context: InvocationContext, bound: BindingResult): Promise<number> =>
      body(context, bound),
  };
}

/** The overwhelmingly common case: fixed text, stream 1, exit 0. */
export function fixedTextCommand(
  name: string,
  lines: (context: InvocationContext, bound: BindingResult) => readonly string[],
): CommandModule {
  return simulatedCommand(name, async (context, bound) => {
    await writeLines(context, lines(context, bound));
    return EXIT_SUCCESS;
  });
}
