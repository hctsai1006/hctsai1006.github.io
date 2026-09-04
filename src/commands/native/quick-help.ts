/**
 * help — v1's quick-start guide, kept because the manifest declares it.
 *
 * This is NOT PowerShell's `help` function. In pwsh, `help` is a wrapper that
 * pipes `Get-Help` through `more`; here it is a separate command with its own
 * manifest entry (`help`, display `help`, synopsis "Quick start guide"), and it
 * exists because the archived v1 terminal had one and the drift test insists
 * every declared native-semantic command without a filesystem capability has an
 * implementation.
 *
 * It emits OBJECTS, not lines, which is the difference from v1: a group with a
 * name and its entries, so `help | Where-Object Group -eq Portfolio` works and
 * the layout is the formatter's problem rather than this file's.
 */

import { psObject } from '../../pipeline/psobject.ts';
import type { PSObject } from '../../pipeline/psobject.ts';
import { throwIfCancelled } from '../../pipeline/pipeline.ts';
import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import { manifest } from '../powershell/support.ts';

export const HELP_TOPIC_TYPE_NAMES: readonly string[] = [
  'BrowserShell.QuickStartEntry',
  'System.Object',
];

const QUICK_HELP_MANIFEST = manifest({
  display: 'help',
  synopsis: 'Quick start guide.',
  notes:
    'Not PowerShell\'s `help` function, which pages Get-Help through `more`. This is v1\'s ' +
    'quick-start guide, re-expressed as objects so it can be filtered: each row carries a ' +
    'Group, a Command and a Description. Run Get-Help <command> for one command, or ' +
    'Get-Command -Detailed to see how real any of them are.',
  parameters: [],
  outputTypeNames: ['BrowserShell.QuickStartEntry'],
});

/**
 * The guide, as data. Taken from v1's `help` cmdlet, minus the entries whose
 * commands the catalogue does not have — naming a command `Get-Command` denies
 * would be the same drift the generated inventory exists to prevent, and
 * `native-commands.test.mts` checks every row against the catalogue.
 *
 * TWO REAL COMMANDS ARE MISSING FROM THIS LIST FOR THAT REASON.
 * `Group-Object` and `Get-Member` are implemented in
 * `src/commands/powershell/`, but neither has an entry in the generated
 * `src/commands/manifests.json` — v1 had no such commands, and that file is
 * generated from v1's inventory plus the captured reference metadata. So
 * `Get-Command` cannot report them either, and the terminal is at least
 * CONSISTENTLY unaware rather than advertising a command its own catalogue
 * denies. The fix belongs in the generator, not here; until then the catalogue
 * is injectable, so a coordinator that composes the sibling registries can pass
 * their manifests in and both this list and Get-Command would pick them up.
 */
const GUIDE: readonly (readonly [string, readonly (readonly [string, string])[]])[] = [
  ['Portfolio', [
    ['whoami', 'identity summary'],
    ['Get-Contribution', 'upstream work (-Foundation CNCF)'],
    ['Get-Advisory', 'published security advisories that credit me'],
    ['Get-Publication', 'publications (-Full for every entry)'],
    ['Get-Award', 'awards (-Year 2023)'],
    ['Get-Project', 'representative projects'],
    ['Get-Timeline', 'year-by-year timeline'],
    ['Get-Source', 'links to every authoritative source'],
  ]],
  ['Objects', [
    ['Where-Object', 'filter the pipeline'],
    ['Select-Object', 'project and window'],
    ['Sort-Object', 'order'],
    ['Measure-Object', 'count, sum, min, max'],
  ]],
  ['System', [
    ['Get-Date', 'the clock, with -Format and -UFormat'],
    ['Get-Random', 'a bounded number, or a pick from a list'],
    ['New-Guid', 'a GUID, whose version follows the compatibility profile'],
    ['Get-Location', 'the working directory, as a PathInfo'],
    ['Get-History', 'this session, as objects'],
    ['$PSVersionTable', 'which PowerShell this session claims to be'],
  ]],
  ['Honesty', [
    ['Get-Command -Detailed', 'how real each command is, and why'],
    ['Get-Help <command>', 'synopsis, syntax, parameters and the fidelity note'],
  ]],
];

export function quickStartRows(): readonly PSObject[] {
  const rows: PSObject[] = [];
  for (const [group, entries] of GUIDE) {
    for (const [command, description] of entries) {
      rows.push(psObject({ Group: group, Command: command, Description: description }, HELP_TOPIC_TYPE_NAMES));
    }
  }
  return rows;
}

export const quickHelp: CommandModule = {
  manifest: QUICK_HELP_MANIFEST,

  async invoke(context: InvocationContext, _bound: BindingResult): Promise<number> {
    throwIfCancelled(context.signal, 'help');
    for (const row of quickStartRows()) {
      if (context.streams.success.closed) break;
      await context.streams.success.write(row);
    }
    return 0;
  },
};
