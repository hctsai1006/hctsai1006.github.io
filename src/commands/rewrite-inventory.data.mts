/**
 * rewrite-inventory.data.mts — commands this rewrite adds that v1 never had.
 *
 * `manifests.json` is generated from `v1-inventory.json`, which is extracted
 * from the shipped terminal. That was right while the rewrite only reimplemented
 * what v1 already did. It stopped being right the moment the rewrite added a
 * command, and the consequence is not cosmetic:
 *
 *   Get-Command reads manifests.json. So does Get-Help, and so does the fidelity
 *   surface — the badge that tells a visitor whether a command is real. Seven
 *   commands (Group-Object, Get-Member, New-Guid and the four formatting
 *   commands) were implemented, tested, and completely invisible to all three.
 *   They had no declared fidelity, no declared capabilities, and no note.
 *
 * The honesty machinery has to cover the whole command set or it covers nothing,
 * so the generator takes two sources: what v1 had, and this. Every entry here
 * still needs a classification in `classification.data.mts` — the generator
 * refuses an unclassified command from either source.
 *
 * Aliases and synopses were read off a real pwsh 7.6.5 with `Get-Alias
 * -Definition` and `Get-Help`, not invented:
 *
 *   Group-Object  group     Get-Member  gm      New-Guid    (none)
 *   Format-Table  ft        Format-List fl      Format-Wide fw
 *   Out-String    (none)
 *
 * `params` is left empty on purpose. Where the reference implementation has the
 * command, the generator replaces the declaration with captured metadata and
 * marks it verified; where it does not, an empty list is the honest answer and
 * `parameterSource: 'none'` says so. Typing them by hand would produce exactly
 * the invented API this project exists to avoid.
 */

export interface RewriteCommand {
  /** Lower-case, the form the resolver looks up. */
  name: string;
  /** The canonical display form. */
  display: string;
  aliases: string[];
  /** One line, shown by Get-Help. */
  help: string;
}

export const REWRITE_COMMANDS: readonly RewriteCommand[] = [
  {
    name: 'group-object',
    display: 'Group-Object',
    aliases: ['group'],
    help: 'Group objects that contain the same value for specified properties',
  },
  {
    name: 'get-member',
    display: 'Get-Member',
    aliases: ['gm'],
    help: 'Get the properties and methods of objects',
  },
  {
    name: 'new-guid',
    display: 'New-Guid',
    aliases: [],
    help: 'Create a GUID',
  },
  {
    name: 'format-table',
    display: 'Format-Table',
    aliases: ['ft'],
    help: 'Format the output as a table',
  },
  {
    name: 'format-list',
    display: 'Format-List',
    aliases: ['fl'],
    help: 'Format the output as a list of properties, one property per line',
  },
  {
    name: 'format-wide',
    display: 'Format-Wide',
    aliases: ['fw'],
    help: 'Format objects as a wide table that displays only one property of each object',
  },
  {
    name: 'out-string',
    display: 'Out-String',
    aliases: [],
    help: 'Send objects to the host as a series of strings',
  },
];
