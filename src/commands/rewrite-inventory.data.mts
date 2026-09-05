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

/**
 * v1 tokens that are NOT commands here, and why.
 *
 * The extraction is faithful, which means it can capture a contradiction v1
 * contained. `sl` is the one that exists: v1 lists it as an easter egg in
 * `EGGS` — a steam locomotive, the traditional joke for a mistyped `ls` — and
 * ALSO maps it to `set-location` in `ALIAS`. v1's dispatcher resolves the alias
 * first, so the egg could never fire. It has been dead since it was written.
 *
 * One token cannot resolve to two commands. The generator refuses the
 * contradiction rather than letting load order decide it, and this is where the
 * decision lives:
 *
 *   `sl` is Set-Location. Real PowerShell says so — `Get-Alias sl` is
 *   `Set-Location` — and so did v1, in behaviour if not in intent. A visitor who
 *   types `sl` at a PowerShell prompt means the cmdlet, and `set-location` is
 *   declared `native-semantic`, which is a claim about matching the reference
 *   implementation; dropping one of its real aliases to make room for a joke
 *   would weaken exactly the claim the fidelity taxonomy exists to protect.
 *
 * The locomotive is not lost — `src/commands/simulated/` still implements it,
 * and it keeps its tests. It simply has no name to be reached by, which is the
 * state v1 shipped it in. Giving it one would be a change to v1's behaviour
 * dressed up as fidelity to it.
 */
export const SHADOWED_V1_TOKENS: ReadonlyMap<string, string> = new Map([
  [
    'sl',
    'An alias of Set-Location in real PowerShell and in v1. v1 also lists it as an ' +
      'easter egg, which its own dispatcher made unreachable.',
  ],
]);
