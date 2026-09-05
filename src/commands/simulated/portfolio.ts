/**
 * portfolio.ts — `git`, which is a joke about the portfolio and not a git.
 *
 * No repository is opened, no object database is read, no ref is resolved and
 * nothing is executed. There is no git here to run and no working tree to run
 * it against: the virtual filesystem elsewhere in this project is a directory
 * tree in browser storage, not a checkout, and it has no `.git`.
 *
 * Three subcommands, and they are three different kinds of answer:
 *
 *   git status   fixed text. Always "working tree clean", because there is no
 *                tree and therefore nothing dirty. It is a punchline, not a
 *                report, and it would say the same thing after you edited a
 *                file with `nano`.
 *   git remote   fixed text. A real URL that this command did not contact.
 *   git log      the ONLY one that reads anything: the portfolio timeline,
 *                rendered as if it were a commit log. That is why this command
 *                declares `portfolio.read` — real data, formatted as a lie
 *                about its provenance. Those are not commits, they are years.
 *
 * The capability is asked for in the `log` branch alone, not on every
 * invocation. `git status` reads nothing, so it should not produce an audit
 * record saying it read the portfolio; a capability requested where it is used
 * makes the log describe what happened rather than what might have.
 */

import timelineJson from '../../data/projects.json' with { type: 'json' };

import type { CommandModule } from '../invocation.ts';
import {
  EXIT_SUCCESS,
  argumentsOf,
  simulatedCommand,
  subcommandOf,
  writeLines,
} from './support.ts';

/**
 * The year timeline, from the extracted portfolio data rather than from a copy.
 *
 * v1 held this array in the same file as the renderer, which is how the numbers
 * elsewhere on the site drifted from it. `tools/extract-portfolio-data.mts`
 * produces `src/data/projects.json` from the page, and the parity test asserts
 * that what this reads still equals what the archived v1 printed — so a future
 * timeline edit shows up as a deliberate change rather than as silent drift.
 */
interface TimelineEntry {
  readonly year: string;
  readonly highlights: string;
}

const TIMELINE: readonly TimelineEntry[] = (
  timelineJson as unknown as { readonly timeline: readonly TimelineEntry[] }
).timeline;

function git(): CommandModule {
  return simulatedCommand('git', async (context, bound) => {
    const sub = subcommandOf(argumentsOf(bound));

    if (sub === 'status') {
      await writeLines(context, [
        'On branch main',
        "Your branch is up to date with 'origin/main'.",
        '',
        'nothing to commit, working tree clean',
      ]);
      return EXIT_SUCCESS;
    }

    if (sub === 'log') {
      // The one branch that reads anything. Asked for here rather than at the
      // top of the command so the audit record matches what was actually read.
      context.requireCapability('portfolio.read');
      await writeLines(
        context,
        // Newest first, as `git log` orders it. v1 reverses the array, which is
        // stored oldest-first.
        [...TIMELINE].reverse().map((entry) => `* ${entry.year}  ${entry.highlights}`),
      );
      return EXIT_SUCCESS;
    }

    if (sub === 'remote') {
      await writeLines(context, [
        'origin  https://github.com/thc1006 (fetch)',
        'origin  https://github.com/thc1006 (push)',
      ]);
      return EXIT_SUCCESS;
    }

    await writeLines(context, ['usage: git <status|log|remote>']);
    return EXIT_SUCCESS;
  });
}

export function portfolioCommands(): readonly CommandModule[] {
  return [git()];
}

/** Exported for the parity test, which checks it against the archive's copy. */
export { TIMELINE };
