/**
 * powershell-77-changes.source.mts — what changed in PowerShell 7.7, as data.
 *
 * This is the ONLY hand-authored file in the compatibility pipeline. Everything
 * else (profiles, deltas, the release lockfile, command metadata) is generated
 * or captured. It is hand-authored because a changelog is prose written by
 * humans, and turning prose into semantics is a judgement call that must be
 * recorded, reviewed, and cited — not inferred.
 *
 * ── THE TRUTH MODEL, AND WHY IT HAD TO CHANGE ─────────────────────────────
 *
 * The previous version of this file stated the right rule in its header and the
 * generator ignored it. It said `implemented` starts false and the UI must say
 * "documented, not emulated" until a fixture proves otherwise. But
 * `buildBehaviorTables` filtered only on `behaviorKey === undefined`, never on
 * `implemented`, so every documented-but-unemulated change was written into the
 * RUNTIME profile and served to commands through `CompatibilityView.behavior()`
 * as live execution semantics. Measured at that commit: fourteen change records
 * carried a behaviour key, they collapsed to thirteen distinct keys, all
 * thirteen were emitted, and all thirteen were `implemented: false`. The entire
 * behaviour table was claims the engine did not implement.
 *
 * So the two facts are now separate fields and cannot be conflated:
 *
 *   - `upstreamValue` is what PowerShell 7.7 DOES. It is always recorded and
 *     always shown in the explorer, whatever we emulate.
 *
 *   - `implementation` is what BROWSERSHELL does about it. Only `implemented`
 *     and `verified` put a key into the runtime `behaviors` table. Everything
 *     else lands in `documentedBehaviors`, which no command can read.
 *
 * `implementation` is a four-state status rather than a boolean because
 * "documented" and "partially emulated" are different admissions and collapsing
 * them loses the one that matters:
 *
 *   documented   recorded and cited; the engine does not model it at all
 *   partial      the engine models part of it, named in `partialityNote`
 *   implemented  the engine models it and a unit test proves it
 *   verified     as above, AND the value was measured against a real pwsh
 *
 * Rules enforced by tools/generate-compatibility-profile.mts, each of which is
 * a hard error rather than a warning:
 *
 *   - Every entry cites at least one upstream PR, exactly one of them `primary`.
 *     "The changelog said so" is not a citation; the PR is where the actual
 *     behaviour lives. `covers` records what that PR was READ to contain, so a
 *     later reader can tell a citation from a guess.
 *
 *   - `implemented`/`verified` requires non-empty `evidence`, and every
 *     evidence path must exist on disk. A status that outruns its proof is the
 *     failure this whole project is organised against, so the proof is checked
 *     mechanically rather than promised in a comment.
 *
 *   - Two change records citing one PR under different behaviour keys is a hard
 *     error unless `sharedPrRationale` says in writing why one citation supports
 *     both claims. This was a warning that exited 0; a gate nobody fails is not
 *     a gate.
 *
 *   - Behaviour keys are command- and parameter-scoped. An engine-wide key is
 *     allowed only when the upstream change really is engine-wide, and then
 *     `scope.command` must be null deliberately.
 *
 * ── WHAT THE PR READ CHANGED ──────────────────────────────────────────────
 *
 * The previous version carried one record claiming "Explicit -<SwitchParameter>
 * :$false corrected across thirteen cmdlets", citing PR #26719 for all of them,
 * and a second record also citing #26719 for the CSV type-information change.
 * Reading #26719 on github.com refutes that: it changes exactly
 * `src/Microsoft.PowerShell.Commands.Utility/commands/utility/CsvCommands.cs`,
 * `CsvCommandStrings.resx`, and the ConvertTo-Csv/Export-Csv test files. It
 * cannot support a claim about Get-Random or Split-Path, and it was never a
 * second change — it IS the CSV type-information change.
 *
 * The upstream What's-New document cites a SEPARATE PR per cmdlet for this
 * family (#26140 New-Guid, #26141 Get-Uptime, #26457 Get-Random, #26460
 * Get-SecureRandom, #26463 Get-TimeZone, #26469 New-PSSession, #26474
 * Split-Path, #26479 Test-Connection, #26485 Where-Object, #26719 the CSV
 * cmdlets). Ten PRs, not one, and each one fixes NAMED PARAMETERS on ONE
 * cmdlet — #26140 is `-Empty` on New-Guid alone; #26474 is `-Qualifier`,
 * `-NoQualifier`, `-Leaf` and `-IsAbsolute` on Split-Path alone. A single
 * engine-wide `switchParameters.honourExplicitFalse` boolean could not be
 * right, because 7.7 still has the old behaviour for every switch upstream did
 * not touch.
 *
 * ── WHAT WAS MEASURED ─────────────────────────────────────────────────────
 *
 * Against the installed pwsh 7.6.5 (tools/probe scripts, 2026-09-05):
 *
 *   - The 7.6.5 BINDER already honours an explicit `:$false`. For an advanced
 *     function, `-Force:$false` binds with ContainsKey true, IsPresent False
 *     and ToBool False — identical to 7.7. The defect is in the COMMAND
 *     BODIES, which asked "was it supplied?" instead of "what is it?". So the
 *     behaviour is scoped to the cmdlets that had the bug, and a cmdlet with no
 *     declared key honours the value under BOTH profiles, which is what the
 *     reference implementation does.
 *
 *   - The bug reproduces per cmdlet, exactly as the PRs describe:
 *     `New-Guid -Empty:$false` returns the empty GUID; `Get-Random -Shuffle:$false`
 *     still shuffles; `Get-Uptime -Since:$false` still returns the boot time;
 *     `Get-TimeZone -ListAvailable:$false` still lists all 141;
 *     `Split-Path /a/b/c.txt -Leaf:$false` still returns the leaf;
 *     `Where-Object -Property A -GT:$false -Value 1` still applies -GT.
 *
 *   - `ConvertTo-Csv -IncludeTypeInformation:$false` ALREADY honours its value
 *     in 7.6.5. What #26719 changes is that `-NoTypeInformation` becomes an
 *     obsolete no-op and the mutual-exclusion error disappears: in 7.6.5
 *     passing both as `:$false` throws
 *     CannotSpecifyIncludeTypeInformationAndNoTypeInformation.
 *
 *   - `Export-Csv -Append -NoHeader` together is ACCEPTED in 7.6.5, which is
 *     what #26472 makes exclusive.
 *
 *   - `Format-Table -Property ''` does NOT succeed in 7.6.5. The previous
 *     version of this file said it did. It binds (the parameter carries only
 *     ParameterAttribute — no validation attributes, which is the part that was
 *     right) and then throws System.NotSupportedException with error id
 *     ExpressionEmptyString2 from the FORMATTER. The 7.7 difference is
 *     therefore where and as what it fails, not whether it fails.
 *
 * Source for the change list: MicrosoftDocs/PowerShell-Docs
 * What-s-New-in-PowerShell-77.md, read 2026-09-04 and re-read 2026-09-05,
 * describing 7.7.0-preview.4. Cross-checked against the 7.6.5 command metadata
 * captured from the local reference implementation.
 */

export type Impact = 'none' | 'cosmetic' | 'observable' | 'script-breaking';
export type Kind = 'breaking' | 'added' | 'changed' | 'removed' | 'fixed';
export type SubjectKind = 'command' | 'behavior' | 'variable' | 'engine' | 'module' | 'formatter';

/**
 * How much of this difference BrowserShell actually reproduces.
 *
 * Only `implemented` and `verified` reach the runtime behaviour table. The
 * generator refuses either without evidence that exists on disk.
 */
export type ImplementationStatus = 'documented' | 'partial' | 'implemented' | 'verified';

/**
 * Why a citation is here.
 *
 * `primary` is the PR that made the change; there is exactly one. `supporting`
 * is another PR that is part of the same upstream story. `docs` is prose — the
 * lowest rank, recorded so a docs claim we could not confirm in a diff is
 * visible as a docs claim rather than laundered into a PR citation.
 */
export type SourceRole = 'primary' | 'supporting' | 'docs';

export interface UpstreamSource {
  readonly pr: number;
  readonly role: SourceRole;
  /** What the PR was READ to contain. Not a restatement of the changelog. */
  readonly covers: string;
}

/**
 * Where the behaviour applies.
 *
 * `command: null` means genuinely engine-wide and has to be argued for, because
 * an engine-wide flag standing in for a command-specific fix is how one boolean
 * came to change every switch parameter in the binder.
 */
export interface BehaviorScope {
  readonly command: string | null;
  /** Parameters the change touches. Empty means the whole command. */
  readonly parameters?: readonly string[];
}

/**
 * A family of changes whose behaviour keys are DERIVED rather than typed.
 *
 * `switch-explicit-false` covers the ten per-cmdlet PRs above. Its key for a
 * given parameter is `switchParameter.<Command>.<Parameter>.honourExplicitFalse`,
 * computed identically by tools/generate-compatibility-profile.mts and by
 * src/binding/binder.ts. Deriving it in both places means a record can never
 * declare a key the binder will not look up, which is what a hand-typed
 * `switchParameter.Where-Object.<operator>.honourExplicitFalse` would have been:
 * a key no code path can ever compute, sitting in the table looking authoritative.
 */
export type Mechanism = 'switch-explicit-false';

export interface Change {
  readonly kind: Kind;
  readonly subject: string;
  readonly subjectKind: SubjectKind;
  readonly title: string;
  readonly detail?: string;
  readonly impact: Impact;
  /**
   * Profile behaviour flag, when there is one and it is a single key. Command-
   * and parameter-scoped. An entry with neither this nor `mechanism` is
   * recorded for the difference explorer only.
   */
  readonly behaviorKey?: string;
  /** Set instead of `behaviorKey` when the keys are derived from `scope`. */
  readonly mechanism?: Mechanism;
  /** What 7.7 does. The 7.6.5 baseline is derived from it, never restated. */
  readonly upstreamValue?: boolean | number | string;
  readonly scope?: BehaviorScope;
  readonly sources: readonly UpstreamSource[];
  /** Required when impact is script-breaking. */
  readonly migration?: string;
  readonly implementation: ImplementationStatus;
  /**
   * The id of the conformance corpus case that proves this, or absent.
   *
   * A CASE ID rather than a file path, because a path is only a string that
   * exists. A case id is checkable end to end by tools/conformance.mts: the
   * case is in the corpus, its source hash matches the recording, a real pwsh
   * produced the recorded answer, and this project agreed with it. Naming a
   * case that is missing, or that did not agree, is a build failure — so a
   * proof cannot be deleted quietly, and cannot be faked by pointing at a
   * case that fails.
   *
   * Absent on every entry today, and the reason is worth stating rather than
   * leaving as an omission: the corpus has no case exercising any of the six
   * emulated behaviour keys, and adding one means re-capturing the whole
   * fixture from a real pwsh. The only capture host available runs Windows and
   * has updatable help installed, which is known to turn three passing help.*
   * cases into unexplained differences — so a re-capture here would trade a
   * clean Linux recording for a worse Windows one. See ROADMAP 3.5.
   */
  readonly conformanceFixture?: string;
  /** Repo-relative paths proving the emulation. Checked to exist. */
  readonly evidence?: readonly string[];
  /** Required when implementation is `partial`: what is missing. */
  readonly partialityNote?: string;
  /** Required when this PR is also cited by another record's behaviour key. */
  readonly sharedPrRationale?: string;
}

/** The one PR that made a change. Exactly one per record; the gate checks it. */
const primary = (pr: number, covers: string): UpstreamSource => ({ pr, role: 'primary', covers });

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
    upstreamValue: 7,
    scope: { command: 'New-Guid' },
    sources: [
      primary(27033, 'NewGuidCommand.cs swaps Guid.NewGuid() for Guid.CreateVersion7(); the test asserts the version nibble is 7.'),
    ],
    migration:
      'A script that needs a fully random GUID must call `[guid]::NewGuid()` directly rather than `New-Guid`. Never use either as a security token: use a CSPRNG.',
    implementation: 'implemented',
    evidence: ['tests/unit/native-commands.test.mts', 'src/commands/native/new-guid.ts'],
  },
  {
    kind: 'breaking',
    subject: 'Format-Table, Format-List, Format-Custom',
    subjectKind: 'command',
    title: '`ValidateNotNullOrEmpty` added to `-Property`',
    detail:
      'Measured in 7.6.5: `-Property` carries only ParameterAttribute — no validation attributes — so an empty string BINDS there and then throws System.NotSupportedException (error id ExpressionEmptyString2) from the formatter. In 7.7 it is rejected during parameter binding instead. What changes is where and as what it fails, not whether it fails; an earlier revision of this file claimed it succeeded in 7.6.5, which the probe refutes.',
    impact: 'script-breaking',
    behaviorKey: 'format.property.rejectNullOrEmpty',
    upstreamValue: true,
    scope: { command: 'Format-Table, Format-List, Format-Custom', parameters: ['Property'] },
    sources: [primary(26552, 'Adds ValidateNotNullOrEmpty to the -Property parameter of the Format-* cmdlets.')],
    migration: 'Filter empty values out of a `-Property` list before passing it.',
    implementation: 'implemented',
    evidence: ['tests/unit/binder-validation.test.mts', 'src/binding/validation.ts'],
  },
  {
    kind: 'breaking',
    subject: 'argument validation',
    subjectKind: 'engine',
    title: 'Not-null-not-empty validation now throws ArgumentException instead of PSArgumentNullException',
    detail:
      'Genuinely engine-wide: it is the validation machinery, not one cmdlet. Measured in 7.6.5, `[ValidateNotNullOrEmpty()]` on an advanced function raises ParameterBindingValidationException wrapping ValidationMetadataException, error id ParameterArgumentValidationError. The 7.7 exception type is taken from the changelog and could NOT be measured here, because only 7.6.5 is installed.',
    impact: 'script-breaking',
    behaviorKey: 'validation.throwsArgumentException',
    upstreamValue: true,
    scope: { command: null },
    sources: [primary(26668, 'Changes the exception raised by not-null/not-empty validation from PSArgumentNullException to ArgumentException.')],
    migration: 'Catch `System.ArgumentException`, or catch both types during a migration window.',
    implementation: 'implemented',
    evidence: ['tests/unit/binder-validation.test.mts', 'src/binding/validation.ts'],
  },

  // ------------------------------- the explicit -Switch:$false family ----
  //
  // Ten upstream PRs, one per cmdlet, each naming its own parameters. Recorded
  // as ten records rather than one because they are ten changes: 7.7 still has
  // the old behaviour for every switch none of them touched, which a single
  // engine-wide flag could not express.
  {
    kind: 'breaking',
    subject: 'Where-Object',
    subjectKind: 'command',
    title: 'Explicit `-<Operator>:$false` is honoured rather than treated as present',
    detail:
      'Measured in 7.6.5: `Where-Object -Property A -GT:$false -Value 1` still applies -GT, and `-Not:$false` still filters like `-Not`. BrowserShell selects the operator by parameter PRESENCE (`resolveOperator` in src/commands/powershell/where-object.ts), so it reproduces the 7.6 behaviour under both profiles and does not emulate the fix.',
    impact: 'observable',
    mechanism: 'switch-explicit-false',
    upstreamValue: true,
    scope: {
      command: 'Where-Object',
      parameters: [
        'EQ', 'NE', 'GT', 'LT', 'GE', 'LE', 'Like', 'NotLike', 'Match', 'NotMatch',
        'Contains', 'NotContains', 'In', 'NotIn', 'Is', 'IsNot', 'Not',
      ],
    },
    sources: [
      primary(26485, 'InternalCommands.cs: the operator switches fall back to default boolean property evaluation when set to $false. Covers the comparison operators and their case-sensitive twins.'),
    ],
    implementation: 'documented',
  },
  {
    kind: 'changed',
    subject: 'New-Guid',
    subjectKind: 'command',
    title: 'Explicit `-Empty:$false` is honoured rather than treated as present',
    detail:
      'Measured in 7.6.5: `New-Guid -Empty:$false` returns 00000000-0000-0000-0000-000000000000. Emulated in the binder, which is the one place version-awareness lives, so `-Empty:$false` binds TRUE under the 7.6 profile and FALSE under 7.7.',
    impact: 'observable',
    mechanism: 'switch-explicit-false',
    upstreamValue: true,
    scope: { command: 'New-Guid', parameters: ['Empty'] },
    sources: [primary(26140, 'NewGuidCommand.cs uses Empty.ToBool() instead of testing presence. -Empty is the only switch it touches.')],
    // Was `verified`. Demoted, because `verified` is defined in
    // src/commands/manifest.ts as "implemented AND compared against a CAPTURED
    // reference-implementation run", and nothing was captured: the 7.6.5
    // measurement quoted above was transcribed by hand out of a pwsh session
    // into the header of binder-switch-scope.test.mts, where it cannot be
    // re-checked by anything. The emulation is real and the unit test is real;
    // the top rung of the ladder is not what either of them earns.
    implementation: 'implemented',
    evidence: ['tests/unit/binder-switch-scope.test.mts', 'src/binding/binder.ts'],
  },
  {
    kind: 'changed',
    subject: 'Get-Random',
    subjectKind: 'command',
    title: 'Explicit `-Shuffle:$false` is honoured rather than treated as present',
    detail:
      'Measured in 7.6.5 across four seeds: `Get-Random -InputObject (1..6) -Shuffle:$false -SetSeed N` returns the same shuffled sequence as `-Shuffle`, never the single draw that no shuffle produces.',
    impact: 'observable',
    mechanism: 'switch-explicit-false',
    upstreamValue: true,
    scope: { command: 'Get-Random', parameters: ['Shuffle'] },
    sources: [primary(26457, 'Corrects handling of an explicit -Shuffle:$false in Get-Random.')],
    // Demoted from `verified` for the same reason as New-Guid -Empty above: the
    // four-seed measurement lives in a test comment, not in a capture.
    implementation: 'implemented',
    evidence: ['tests/unit/binder-switch-scope.test.mts', 'src/binding/binder.ts'],
  },
  {
    kind: 'changed',
    subject: 'Get-SecureRandom',
    subjectKind: 'command',
    title: 'Explicit `-Shuffle:$false` is honoured rather than treated as present',
    impact: 'observable',
    mechanism: 'switch-explicit-false',
    upstreamValue: true,
    scope: { command: 'Get-SecureRandom', parameters: ['Shuffle'] },
    sources: [primary(26460, 'Corrects handling of an explicit -Shuffle:$false in Get-SecureRandom.')],
    detail: 'BrowserShell has no Get-SecureRandom, so there is nothing to emulate the fix in.',
    implementation: 'documented',
  },
  {
    kind: 'changed',
    subject: 'Get-TimeZone',
    subjectKind: 'command',
    title: 'Explicit `-ListAvailable:$false` is honoured rather than treated as present',
    detail:
      'Measured in 7.6.5: `-ListAvailable:$false` still emits all 141 zones instead of the current one. BrowserShell has no Get-TimeZone.',
    impact: 'observable',
    mechanism: 'switch-explicit-false',
    upstreamValue: true,
    scope: { command: 'Get-TimeZone', parameters: ['ListAvailable'] },
    sources: [primary(26463, 'Corrects handling of an explicit -ListAvailable:$false in Get-TimeZone.')],
    implementation: 'documented',
  },
  {
    kind: 'changed',
    subject: 'Get-Uptime',
    subjectKind: 'command',
    title: 'Explicit `-Since:$false` is honoured rather than treated as present',
    detail:
      'Measured in 7.6.5: `-Since:$false` still returns the boot timestamp rather than the elapsed TimeSpan. BrowserShell has no Get-Uptime.',
    impact: 'observable',
    mechanism: 'switch-explicit-false',
    upstreamValue: true,
    scope: { command: 'Get-Uptime', parameters: ['Since'] },
    sources: [primary(26141, 'Corrects handling of an explicit -Since:$false in Get-Uptime.')],
    implementation: 'documented',
  },
  {
    kind: 'changed',
    subject: 'New-PSSession',
    subjectKind: 'command',
    title: 'Explicit `-<Switch>:$false` is honoured rather than treated as present',
    detail: 'BrowserShell has no remoting and no New-PSSession.',
    impact: 'observable',
    mechanism: 'switch-explicit-false',
    upstreamValue: true,
    scope: {
      command: 'New-PSSession',
      parameters: ['AllowRedirection', 'EnableNetworkAccess', 'RunAsAdministrator', 'SSHTransport', 'UseSSL', 'UseWindowsPowerShell'],
    },
    sources: [primary(26469, 'Corrects handling of explicit switch :$false values in New-PSSession.')],
    implementation: 'documented',
  },
  {
    kind: 'changed',
    subject: 'Split-Path',
    subjectKind: 'command',
    title: 'Explicit `-Qualifier`/`-NoQualifier`/`-Leaf`/`-IsAbsolute:$false` is honoured',
    detail:
      'Measured in 7.6.5: `Split-Path /a/b/c.txt -Leaf:$false` still returns `c.txt`. The PR names exactly these four switches, which is why the record does too. BrowserShell has no Split-Path.',
    impact: 'observable',
    mechanism: 'switch-explicit-false',
    upstreamValue: true,
    scope: { command: 'Split-Path', parameters: ['Qualifier', 'NoQualifier', 'Leaf', 'IsAbsolute'] },
    sources: [
      primary(26474, 'ParsePathCommand.cs: ProcessRecord stops switching on ParameterSetName and evaluates the four switch values directly.'),
    ],
    implementation: 'documented',
  },
  {
    kind: 'changed',
    subject: 'Test-Connection',
    subjectKind: 'command',
    title: 'Explicit `-<Switch>:$false` is honoured rather than treated as present',
    detail: 'BrowserShell has no network stack and no Test-Connection.',
    impact: 'observable',
    mechanism: 'switch-explicit-false',
    upstreamValue: true,
    scope: {
      command: 'Test-Connection',
      parameters: ['Detailed', 'DontFragment', 'IPv4', 'IPv6', 'MtuSize', 'Ping', 'Quiet', 'Repeat', 'ResolveDestination', 'Traceroute'],
    },
    sources: [primary(26479, 'Corrects handling of explicit switch :$false values in Test-Connection.')],
    implementation: 'documented',
  },

  // -------------------------------------------------------------- added
  {
    kind: 'added',
    subject: 'New-TemporaryDirectory',
    subjectKind: 'command',
    title: '`New-TemporaryDirectory` cmdlet added',
    detail:
      'Confirmed absent in 7.6.5 by probe. Makes a temp directory a first-class concept, which means the virtual filesystem needs a real `/tmp` provider rather than an ordinary directory that happens to be named tmp.',
    impact: 'none',
    behaviorKey: 'temporaryDirectory.cmdlet',
    upstreamValue: true,
    scope: { command: 'New-TemporaryDirectory' },
    sources: [primary(27549, 'Adds the New-TemporaryDirectory cmdlet.')],
    implementation: 'documented',
  },
  {
    kind: 'added',
    subject: 'Format-Table, Format-List, Format-Custom',
    subjectKind: 'command',
    title: '`-ExcludeProperty` parameter added to Format-* cmdlets',
    detail:
      'Confirmed absent in 7.6.5 by probe and by the captured command metadata. Belongs to the formatter, which is why formatting has to be separable from the command.',
    impact: 'none',
    behaviorKey: 'format.excludeProperty',
    upstreamValue: true,
    scope: { command: 'Format-Table, Format-List, Format-Custom', parameters: ['ExcludeProperty'] },
    sources: [primary(26514, 'Adds -ExcludeProperty to the Format-* cmdlets.')],
    implementation: 'documented',
  },
  {
    kind: 'added',
    subject: 'Join-Path',
    subjectKind: 'command',
    title: '`-Extension` parameter added',
    detail: 'Confirmed absent in 7.6.5 by probe and by the captured command metadata.',
    impact: 'none',
    behaviorKey: 'joinPath.extension',
    upstreamValue: true,
    scope: { command: 'Join-Path', parameters: ['Extension'] },
    sources: [primary(26482, 'Adds -Extension to Join-Path.')],
    implementation: 'documented',
  },
  {
    kind: 'added',
    subject: '$PSApplicationOutputEncoding',
    subjectKind: 'variable',
    title: 'Automatic variable controlling how native command output is decoded',
    detail:
      'Confirmed absent in 7.6.5 by probe on BOTH platforms: `Get-Variable PSApplicationOutputEncoding` returns nothing, and `Get-Variable | Where-Object Name -like "*Encoding*"` lists exactly one variable, OutputEncoding. The reason a new variable was needed is measurable in 7.6.5: `$OutputEncoding` does NOT decode native command output. Capturing a native command that emits the bytes 61 E9 80 7A, setting `$OutputEncoding` to Latin1 changed nothing on either platform, while setting `[Console]::OutputEncoding` to Latin1 changed the result on both (U+0061 U+00E9 U+0080 U+007A). `$OutputEncoding` is the encoder for text piped INTO a native command; the only 7.6.5 knob for the decode is a global console property. That is what the new variable separates. The two really do diverge in practice: on the Windows host probed, `$OutputEncoding` is utf-8 while `[Console]::OutputEncoding` is big5 and ReferenceEquals is False; on Ubuntu they are the same object.',
    impact: 'observable',
    behaviorKey: 'application.outputEncodingVariable',
    upstreamValue: true,
    scope: { command: null },
    sources: [primary(21219, 'Adds the $PSApplicationOutputEncoding automatic variable.')],
    implementation: 'implemented',
    // src/pipeline/encoding.ts routes the decision through the profile rather
    // than a version comparison, so the 7.6.5 branch is unreachable under a
    // 7.6.5 profile by construction. The test drives both profiles and asserts
    // the key's literal spelling, which is the contract the generator writes.
    //
    // WHAT IS AND IS NOT PROVEN. The 7.6.5 half is MEASURED: the variable is
    // absent, and the decode follows [Console]::OutputEncoding. The 7.7 half
    // rests on PR #21219, because no 7.7 build was available to probe -- the
    // same footing as the New-Guid and ValidateNotNullOrEmpty records above,
    // and the conformance corpus cannot improve on it, since it captures 7.6.5
    // and 7.6.5 is precisely the version that lacks the variable.
    evidence: ['tests/unit/encoding.test.mts', 'src/pipeline/encoding.ts'],
  },
  {
    kind: 'added',
    subject: 'WildcardPattern',
    subjectKind: 'engine',
    title: '`ToRegex` method added to `WildcardPattern`',
    detail: 'Confirmed absent in 7.6.5 by probe: the type has no ToRegex method there.',
    impact: 'none',
    sources: [primary(26515, 'Adds WildcardPattern.ToRegex().')],
    implementation: 'documented',
  },

  // ------------------------------------------------------------ changed
  {
    kind: 'changed',
    subject: 'Export-Csv',
    subjectKind: 'command',
    title: '`-Append` and `-NoHeader` are now mutually exclusive',
    detail:
      'Measured in 7.6.5: both switches exist and passing them together is ACCEPTED, appending a second row with no header. 7.7 makes that a parameter-binding failure.',
    impact: 'script-breaking',
    behaviorKey: 'exportCsv.appendNoHeaderExclusive',
    upstreamValue: true,
    scope: { command: 'Export-Csv', parameters: ['Append', 'NoHeader'] },
    sources: [primary(26472, 'Makes -Append and -NoHeader mutually exclusive on Export-Csv.')],
    migration: 'Pick one. A script passing both now fails parameter binding.',
    implementation: 'documented',
  },
  {
    kind: 'changed',
    subject: 'ConvertTo-Csv, Export-Csv',
    subjectKind: 'command',
    title: '`-NoTypeInformation` is an obsolete no-op; `-IncludeTypeInformation` is evaluated by value',
    detail:
      'This IS the CSV entry in the explicit-:$false family, not a second change, which is why it is one record rather than two citing the same PR. Measured in 7.6.5: `-IncludeTypeInformation:$false` is ALREADY honoured; `-NoTypeInformation:$false` still emits the #TYPE line; and passing both as `:$false` throws CannotSpecifyIncludeTypeInformationAndNoTypeInformation. 7.7 removes that error and reduces -NoTypeInformation to a deprecation warning.',
    impact: 'observable',
    behaviorKey: 'csv.noTypeInformationObsolete',
    upstreamValue: true,
    scope: {
      command: 'ConvertTo-Csv, Export-Csv',
      parameters: ['NoTypeInformation', 'IncludeTypeInformation'],
    },
    sources: [
      primary(26719, 'Changes exactly CsvCommands.cs, CsvCommandStrings.resx and the ConvertTo-Csv/Export-Csv tests. CsvCommands.cs holds BaseCsvWritingCommand, ConvertToCsvCommand and ExportCsvCommand.'),
      {
        pr: 26719,
        role: 'docs',
        covers:
          "The What's-New document lists ConvertFrom-Csv and Import-Csv under this PR as well. NOT SUPPORTED by the diff, which touches neither, and refuted by probe: in 7.6.5 the only switches Import-Csv and ConvertFrom-Csv declare are UseCulture, Verbose and Debug — there is no type-information switch on either to fix. The claim is narrowed here to the two cmdlets the PR changes.",
      },
    ],
    implementation: 'documented',
  },

  // -------------------------------------------------------------- fixed
  {
    kind: 'fixed',
    subject: 'Unix formatting',
    subjectKind: 'formatter',
    title: 'LastWriteTime column width is computed dynamically on Unix',
    impact: 'cosmetic',
    behaviorKey: 'unix.lastWriteTime.dynamicWidth',
    upstreamValue: true,
    scope: { command: null },
    sources: [primary(24624, 'Computes the LastWriteTime column width dynamically in the Unix file-system format data.')],
    implementation: 'documented',
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
    upstreamValue: true,
    scope: { command: null },
    sources: [primary(26424, 'Handles a VT Reset sequence occurring mid-string when truncating for display.')],
    implementation: 'documented',
  },
  {
    kind: 'fixed',
    subject: 'progress rendering',
    subjectKind: 'engine',
    title: 'Progress bar renders correctly with double-width Unicode characters',
    detail:
      'The archived v1 terminal already computes East Asian width correctly via its `dw()` helper; that behaviour must survive the rewrite rather than being reintroduced later. The width table exists, but nothing renders a progress bar yet, so there is nothing for a flag to switch.',
    impact: 'cosmetic',
    behaviorKey: 'progress.doubleWidthAware',
    upstreamValue: true,
    scope: { command: null },
    sources: [primary(26185, 'Corrects progress-bar rendering when the message contains double-width characters.')],
    implementation: 'documented',
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
