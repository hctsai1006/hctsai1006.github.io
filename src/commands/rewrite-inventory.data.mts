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
 * v1 tokens that resolve to a DIFFERENT command here than the name suggests.
 *
 * ── A CORRECTION, FIRST, BECAUSE THIS FILE ASSERTED THE OPPOSITE ──────────
 *
 * This entry previously read: "v1's dispatcher resolves the alias first, so the
 * egg could never fire. It has been dead since it was written." THAT IS FALSE,
 * and the v1 source says so in one line. `legacy/terminal-v1.html:789`, inside
 * `set-location`'s own `run(a, raw)`:
 *
 *     if(String(raw[0]).toLowerCase()==='sl' && raw.length===1) return EGGS.sl();
 *
 * The alias DOES resolve to `set-location` (line 1319) — and `set-location`
 * then looks at the raw word it was invoked by. So v1 has one coherent
 * behaviour, not a contradiction:
 *
 *     sl          the steam locomotive
 *     sl /tmp     Set-Location /tmp
 *     cd          home, because bare `cd` falls through to the empty-target arm
 *
 * The egg fires, and always did. The extraction captured `sl` twice because v1
 * really does record it twice, not because v1 disagreed with itself.
 *
 * ── WHAT IS ACTUALLY TRUE HERE ────────────────────────────────────────────
 *
 * `sl` is Set-Location. Real PowerShell says so (`Get-Alias sl`), v1 says so,
 * and `set-location` is declared `native-semantic` — a claim about matching the
 * reference implementation, which cannot survive one of its real aliases being
 * taken by something else. That much of the original decision stands.
 *
 * What does NOT stand is the conclusion that the locomotive was therefore
 * nothing. It is a v1 behaviour this rewrite does not yet reproduce, and the
 * reason is a gap in our own contract rather than a judgement about the joke:
 *
 *   `InvocationContext` CARRIES NO INVOCATION NAME. A command cannot ask which
 *   of its names it was typed as, so `set-location` has no way to distinguish
 *   bare `sl` from bare `Set-Location` — and in v1 those differ, one printing a
 *   train and the other going home. Until the context carries it, the branch
 *   cannot be written where v1 puts it.
 *
 * So the train stays implemented and tested in `src/commands/simulated/` —
 * including against the captured v1 archive, which is the evidence of what it
 * should print — but it does not own the token, and every surface says so
 * rather than three of them disagreeing. `shadowedBy` is stamped into the
 * generated manifest for exactly that reason: before it existed, `Get-Command`
 * and completion described the joke (badge `SIMULATED`, empty synopsis) while
 * `Set-Location` was what ran.
 */
export interface ShadowedToken {
  /** The command a visitor typing this token actually reaches. */
  owner: string;
  /** What is shadowed, and what therefore has no name to be reached by. */
  reason: string;
}

export const SHADOWED_V1_TOKENS: ReadonlyMap<string, ShadowedToken> = new Map([
  [
    'sl',
    {
      owner: 'set-location',
      reason:
        'An alias of Set-Location in real PowerShell and in v1. v1 ALSO prints a steam ' +
        'locomotive for the bare word, from a branch inside set-location itself ' +
        '(legacy/terminal-v1.html:789) — a behaviour this rewrite does not yet reproduce ' +
        'because InvocationContext carries no invocation name, so a command cannot tell ' +
        'which of its names it was typed as.',
    },
  ],
]);
