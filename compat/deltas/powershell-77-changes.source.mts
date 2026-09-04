/**
 * powershell-77-changes.source.mts — what changed in PowerShell 7.7, as data.
 *
 * This is the ONLY hand-authored file in the compatibility pipeline. Everything
 * else (profiles, deltas, the release lockfile, command metadata) is generated
 * or captured. It is hand-authored because a changelog is prose written by
 * humans, and turning prose into semantics is a judgement call that must be
 * recorded, reviewed, and cited — not inferred.
 *
 * Rules for entries here, enforced by tools/generate-compatibility-profile.mts:
 *
 *   - Every entry cites its upstream PR number. "The changelog said so" is not a
 *     citation; the PR is where the actual behaviour lives.
 *
 *   - `implemented` starts false and only becomes true when a conformance
 *     fixture proves BrowserShell reproduces the difference. Until then the UI
 *     must say "documented, not emulated" rather than imply fidelity. Claiming
 *     compatibility you have not demonstrated is the failure this whole project
 *     is organised against.
 *
 *   - A `behaviorKey` means the engine can branch on it. An entry without one is
 *     recorded for the difference explorer but changes no code path yet.
 *
 * Source: MicrosoftDocs/PowerShell-Docs What-s-New-in-PowerShell-77.md, read
 * 2026-09-04, describing 7.7.0-preview.4. Cross-checked against the 7.6.5
 * command metadata captured from the local reference implementation, which
 * independently confirms that -ExcludeProperty and Join-Path -Extension do not
 * exist in 7.6.5 and that Format-Table -Property carries no validation
 * attributes there.
 */

export type Impact = 'none' | 'cosmetic' | 'observable' | 'script-breaking';
export type Kind = 'breaking' | 'added' | 'changed' | 'removed' | 'fixed';
export type SubjectKind = 'command' | 'behavior' | 'variable' | 'engine' | 'module' | 'formatter';

export interface Change {
  kind: Kind;
  subject: string;
  subjectKind: SubjectKind;
  title: string;
  detail?: string;
  impact: Impact;
  /** Profile behavior flag the engine branches on, when there is one. */
  behaviorKey?: string;
  /** Value the flag takes in 7.7. The 7.6.5 baseline is the opposite. */
  behaviorValue?: boolean | number | string;
  upstreamPr: number;
  /** Required when impact is script-breaking. */
  migration?: string;
  /** True only once a conformance fixture proves we reproduce it. */
  implemented: boolean;
}

export const POWERSHELL_77_CHANGES = [
  // ----------------------------------------------------------- breaking
  {
    kind: 'breaking',
    subject: 'New-Guid',
    subjectKind: 'command',
    title: '`New-Guid` emits a time-sortable UUID v7 by default instead of a random UUID v4',
    detail:
      'The output type and format are unchanged, which is what makes this dangerous: a script keeps working, but its identifiers become predictable. Time-ordered UUIDs leak creation time and are guessable in sequence, so anything using `New-Guid` as a secret or a nonce becomes weaker without any visible change.',
    impact: 'script-breaking',
    behaviorKey: 'newGuid.defaultVersion',
    behaviorValue: 7,
    upstreamPr: 27033,
    migration:
      'A script that needs a fully random GUID must call `[guid]::NewGuid()` directly rather than `New-Guid`. Never use either as a security token: use a CSPRNG.',
    implemented: false,
  },
  {
    kind: 'breaking',
    subject: 'Format-Table, Format-List, Format-Custom',
    subjectKind: 'command',
    title: '`ValidateNotNullOrEmpty` added to `-Property`',
    detail:
      'Confirmed against the reference implementation: `Format-Table` `-Property` carries no validation attributes in 7.6.5, so passing an empty string succeeds there and throws in 7.7.',
    impact: 'script-breaking',
    behaviorKey: 'format.property.rejectNullOrEmpty',
    behaviorValue: true,
    upstreamPr: 26552,
    migration: 'Filter empty values out of a `-Property` list before passing it.',
    implemented: false,
  },
  {
    kind: 'breaking',
    subject: 'argument validation',
    subjectKind: 'engine',
    title: 'Not-null-not-empty validation now throws ArgumentException instead of PSArgumentNullException',
    detail:
      'The exception type changes from `System.Management.Automation.PSArgumentNullException` to `System.ArgumentException`, so a catch block filtering on the old type stops matching.',
    impact: 'script-breaking',
    behaviorKey: 'validation.throwsArgumentException',
    behaviorValue: true,
    upstreamPr: 26668,
    migration:
      'Catch `System.ArgumentException`, or catch both types during a migration window.',
    implemented: false,
  },
  {
    kind: 'breaking',
    subject: 'Where-Object',
    subjectKind: 'command',
    title: 'Explicit -<Operator>:$false is now honoured rather than treated as present',
    detail:
      'A switch parameter written as `-Not:$false` was previously indistinguishable from -Not. This is the general shape of a whole family of 7.7 fixes and is why the binder must model switch semantics rather than mere presence.',
    impact: 'observable',
    behaviorKey: 'switchParameters.honourExplicitFalse',
    behaviorValue: true,
    upstreamPr: 26485,
    implemented: false,
  },

  // -------------------------------------------------------------- added
  {
    kind: 'added',
    subject: 'New-TemporaryDirectory',
    subjectKind: 'command',
    title: '`New-TemporaryDirectory` cmdlet added',
    detail:
      'Makes a temp directory a first-class concept, which means the virtual filesystem needs a real `/tmp` provider rather than an ordinary directory that happens to be named tmp.',
    impact: 'none',
    behaviorKey: 'temporaryDirectory.cmdlet',
    behaviorValue: true,
    upstreamPr: 27549,
    implemented: false,
  },
  {
    kind: 'added',
    subject: 'Format-Table, Format-List, Format-Custom',
    subjectKind: 'command',
    title: '`-ExcludeProperty` parameter added to Format-* cmdlets',
    detail:
      'Confirmed absent in 7.6.5 by the captured command metadata. Belongs to the formatter, which is why formatting has to be separable from the command.',
    impact: 'none',
    behaviorKey: 'format.excludeProperty',
    behaviorValue: true,
    upstreamPr: 26514,
    implemented: false,
  },
  {
    kind: 'added',
    subject: 'Join-Path',
    subjectKind: 'command',
    title: '`-Extension` parameter added',
    detail: 'Confirmed absent in 7.6.5 by the captured command metadata.',
    impact: 'none',
    behaviorKey: 'joinPath.extension',
    behaviorValue: true,
    upstreamPr: 26482,
    implemented: false,
  },
  {
    kind: 'added',
    subject: '$PSApplicationOutputEncoding',
    subjectKind: 'variable',
    title: 'Automatic variable controlling how native command output is decoded',
    detail:
      'Requires an encoding broker between the object pipeline and the native byte pipeline: without one, native output is decoded once, wrongly, and cannot be recovered.',
    impact: 'observable',
    behaviorKey: 'application.outputEncodingVariable',
    behaviorValue: true,
    upstreamPr: 21219,
    implemented: false,
  },
  {
    kind: 'added',
    subject: 'WildcardPattern',
    subjectKind: 'engine',
    title: '`ToRegex` method added to `WildcardPattern`',
    impact: 'none',
    upstreamPr: 26515,
    implemented: false,
  },

  // ------------------------------------------------------------ changed
  {
    kind: 'changed',
    subject: 'Export-Csv',
    subjectKind: 'command',
    title: '`-Append` and `-NoHeader` are now mutually exclusive',
    impact: 'script-breaking',
    behaviorKey: 'exportCsv.appendNoHeaderExclusive',
    behaviorValue: true,
    upstreamPr: 26472,
    migration: 'Pick one. A script passing both now fails parameter binding.',
    implemented: false,
  },
  {
    kind: 'changed',
    subject: 'Csv cmdlets',
    subjectKind: 'command',
    title: '`-NoTypeInformation` is an obsolete no-op; `-IncludeTypeInformation` is evaluated by value',
    impact: 'observable',
    behaviorKey: 'csv.noTypeInformationObsolete',
    behaviorValue: true,
    upstreamPr: 26719,
    implemented: false,
  },
  {
    kind: 'changed',
    subject:
      'ConvertFrom-Csv, ConvertTo-Csv, `Export-Csv`, Import-Csv, Get-Random, Get-SecureRandom, Get-TimeZone, Get-Uptime, `New-Guid`, New-PSSession, Split-Path, Test-Connection, `Where-Object`',
    subjectKind: 'command',
    title: 'Explicit -<SwitchParameter>:$false corrected across thirteen cmdlets',
    detail:
      'Thirteen separate upstream PRs fixing one design mistake. This is the strongest argument for a single version-aware binder: fixing it per command would mean thirteen forks.',
    impact: 'observable',
    behaviorKey: 'switchParameters.honourExplicitFalse',
    behaviorValue: true,
    upstreamPr: 26719,
    implemented: false,
  },

  // -------------------------------------------------------------- fixed
  {
    kind: 'fixed',
    subject: 'Unix formatting',
    subjectKind: 'formatter',
    title: 'LastWriteTime column width is computed dynamically on Unix',
    impact: 'cosmetic',
    behaviorKey: 'unix.lastWriteTime.dynamicWidth',
    behaviorValue: true,
    upstreamPr: 24624,
    implemented: false,
  },
  {
    kind: 'fixed',
    subject: 'formatting',
    subjectKind: 'formatter',
    title: 'VT Reset sequences appearing mid-string are handled correctly',
    detail:
      'Only meaningful with a real ANSI parser. A formatter that treats escape sequences as ordinary characters cannot reproduce either the bug or the fix.',
    impact: 'cosmetic',
    behaviorKey: 'ansi.resetMidStringHandled',
    behaviorValue: true,
    upstreamPr: 26424,
    implemented: false,
  },
  {
    kind: 'fixed',
    subject: 'progress rendering',
    subjectKind: 'engine',
    title: 'Progress bar renders correctly with double-width Unicode characters',
    detail:
      'The archived v1 terminal already computes East Asian width correctly via its `dw()` helper; that behaviour must survive the rewrite rather than being reintroduced later.',
    impact: 'cosmetic',
    behaviorKey: 'progress.doubleWidthAware',
    behaviorValue: true,
    upstreamPr: 26185,
    implemented: false,
  },
] as const satisfies readonly Change[];

/**
 * Modules shipped in the box, per line. Recorded rather than assumed because
 * "which PSReadLine does this ship" is exactly the kind of fact that gets stated
 * from memory and is wrong.
 *
 * Verified from src/Modules/PSGalleryModules.csproj at each tag.
 */
export const BUNDLED_MODULES = {
  '7.6.5': {
    PowerShellGet: '2.2.5',
    PackageManagement: '1.4.8.1',
    'Microsoft.PowerShell.PSResourceGet': '1.2.0',
    'Microsoft.PowerShell.Archive': '1.2.6',
    PSReadLine: '2.4.5',
    'Microsoft.PowerShell.ThreadJob': '2.2.0',
  },
  '7.7.0-preview.4': {
    PowerShellGet: '2.2.5',
    PackageManagement: '1.4.8.1',
    // The only module that differs between the two lines. Everything else is
    // pinned identically, which is itself worth recording: it means a behaviour
    // difference between the profiles cannot be blamed on a module version
    // unless it is this one.
    'Microsoft.PowerShell.PSResourceGet': '1.3.0-preview1',
    'Microsoft.PowerShell.Archive': '1.2.6',
    PSReadLine: '2.4.5',
    'Microsoft.PowerShell.ThreadJob': '2.2.0',
  },
} as const satisfies Record<string, Record<string, string>>;
