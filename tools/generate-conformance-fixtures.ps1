#requires -Version 7.0
<#
.SYNOPSIS
    Run the conformance corpus against a REAL PowerShell and record what it does.

.DESCRIPTION
    tools/capture-pwsh-metadata.ps1 asks the reference implementation what its
    commands LOOK like. This asks what it DOES. Together they are the difference
    between a manifest that claims a parameter exists and a fixture that proves a
    pipeline unrolls one level.

    The corpus is data, not code: tests/conformance/corpus.json. Each case names a
    PowerShell `source`, an `observe` (which observable to extract) and a `probe`
    (what this project should be asked to compute instead). This script only
    handles the left-hand side -- the reference implementation. tools/conformance.mts
    runs the probes and compares.

    THREE THINGS HERE ARE EASY TO GET WRONG, AND ALL THREE WERE MEASURED:

    1. $? DOES NOT SURVIVE INDIRECTION.
       Evaluating a case as `$out = & $scriptblock; $ok = $?` reports True even
       when the command inside failed -- the invocation operator succeeded, and
       that is what $? then describes. Measured on pwsh 7.6.5:

           $out = Get-Item /nope   ; $?   ->  False   (correct)
           $out = & $sb            ; $?   ->  True    (the wrapper, not the case)

       So the source is COMPILED TOGETHER WITH the read of $?, and the pair is
       what gets invoked. The child scope is deliberate too: it stops one case's
       variables from being visible to the next.

    2. OUTPUT IS FULL OF MACHINE-SPECIFIC VALUES.
       Paths, the username, the hostname, the pid, GUIDs, timestamps, the
       terminal width that decides column layout, the culture that decides
       decimal separators, and the line ending. Every one of them is pinned or
       canonicalised below, each rule is named, and each case records which rules
       actually fired. What normalisation CANNOT fix is then detected instead:
       anything machine-specific still present after canonicalisation makes the
       capture FAIL rather than get papered over. A case may only get past that
       by declaring `volatile` or `platformSensitive` WITH A REASON.

    3. A FIXTURE THAT WAS ONLY PRODUCED ONCE IS NOT KNOWN TO REPRODUCE.
       Every case is evaluated twice under identical conditions and the two
       normalised results must be identical. That is what catches a normalisation
       rule that was needed and missing -- New-Guid is in the corpus precisely to
       make this machinery prove itself.

    Beyond that, every case is evaluated twice more -- once under the HOST's real
    culture and once under a stress culture with a different decimal separator --
    so "is this case culture-dependent?" is answered by measurement rather than
    by assertion. That is the evidence behind the locale entry in
    known-differences.yml.

.PARAMETER OutFile
    Where to write the fixture. Defaults to a path derived from the running
    version, so captures from different PowerShell versions never overwrite each
    other -- the same convention as capture-pwsh-metadata.ps1.

.PARAMETER Width
    The terminal width used to render text output. PINNED rather than inherited:
    column layout depends on it, and $Host.UI.RawUI.WindowSize differs between an
    interactive host, a redirected pipe and CI.

.PARAMETER Culture
    The culture the fixture is captured under. Pinned for the same reason as the
    width.

.PARAMETER StressCulture
    A second culture, chosen to differ in decimal and group separators, used only
    to measure which cases are culture-dependent.

.PARAMETER Id
    Capture only these case ids. For iterating on one case; a partial capture is
    marked as such in the fixture so it can never be mistaken for a full run.

.EXAMPLE
    pwsh -NoProfile -File tools/generate-conformance-fixtures.ps1

.NOTES
    Records $PSVersionTable, the framework, the platform and both cultures, so a
    capture can never be silently attributed to the wrong engine or the wrong
    host configuration.
#>
[CmdletBinding()]
param(
    [string]   $OutFile,
    [string]   $CorpusFile,
    [int]      $Width = 120,
    [string]   $Culture = 'en-US',
    [string]   $StressCulture = 'de-DE',
    [string[]] $Id
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
if (-not $CorpusFile) { $CorpusFile = Join-Path $repo 'tests/conformance/corpus.json' }

$psVersion = $PSVersionTable.PSVersion.ToString()
if (-not $OutFile) {
    $dir = Join-Path $repo 'tests/conformance/fixtures'
    $null = New-Item -ItemType Directory -Force -Path $dir
    $OutFile = Join-Path $dir "pwsh-$psVersion.json"
}

# ---------------------------------------------------------------------------
# pinning
# ---------------------------------------------------------------------------

# $PSStyle.OutputRendering defaults to 'Host', which injects ANSI colour into
# error rendering and into anything that asks the formatter for emphasis.
# Measured on this machine: the default produced ESC[31;1m around a Get-Item
# error. Escape sequences in a fixture are unreproducible noise, so rendering is
# pinned to PlainText -- and a residue detector below FAILS the capture if an
# escape ever appears anyway, because that would mean the pinning stopped
# working rather than that the sequence should be scrubbed.
$hadPSStyle = $null -ne (Get-Variable -Name PSStyle -ErrorAction SilentlyContinue)
if ($hadPSStyle) { $PSStyle.OutputRendering = 'PlainText' }

$hostCulture = [Globalization.CultureInfo]::CurrentCulture.Name
$hostUICulture = [Globalization.CultureInfo]::CurrentUICulture.Name

function Set-CaptureCulture {
    <#
        Both cultures are set. CurrentCulture decides number and date formatting;
        CurrentUICulture decides which resource strings an error message comes
        from. Pinning only the first would leave error text at the mercy of
        whichever language packs the host has installed.
    #>
    param([string] $Name)
    $ci = [Globalization.CultureInfo]::GetCultureInfo($Name)
    [Threading.Thread]::CurrentThread.CurrentCulture = $ci
    [Threading.Thread]::CurrentThread.CurrentUICulture = $ci
}

# ---------------------------------------------------------------------------
# normalisation
# ---------------------------------------------------------------------------

# Machine-specific values, resolved once. Path replacements are applied
# LONGEST-FIRST so that a nested path (the repo inside the home directory) is
# replaced by the most specific token rather than being half-rewritten.
$machinePaths = @(
    @{ token = '<REPO>';   value = $repo }
    @{ token = '<CWD>';    value = (Get-Location).Path }
    @{ token = '<PSHOME>'; value = $PSHOME }
    @{ token = '<TEMP>';   value = ([IO.Path]::GetTempPath().TrimEnd([IO.Path]::DirectorySeparatorChar, '/')) }
    @{ token = '<HOME>';   value = [Environment]::GetFolderPath('UserProfile') }
) | Where-Object { $_.value } | Sort-Object -Property @{ Expression = { $_.value.Length } } -Descending

$machineUser = [Environment]::UserName
$machineHost = [Environment]::MachineName
$machinePid = $PID

# Every rule states WHY it exists. A rule without a reason is a rule nobody can
# audit, and normalisation is where a differential harness quietly stops testing
# anything.
$NormalisationRules = @(
    @{
        name  = 'line-endings'
        why   = 'The capture host is Windows and emits CRLF; the compatibility profile targets Linux and the runtime is a browser. A fixture that encodes CRLF could never match either.'
        apply = { param([string] $t) $t -replace "`r`n", "`n" -replace "`r", "`n" }
    }
    @{
        name  = 'machine-paths'
        why   = 'Absolute paths differ on every machine. Replaced longest-first with <REPO>/<CWD>/<PSHOME>/<TEMP>/<HOME> so the most specific token wins.'
        apply = {
            param([string] $t)
            foreach ($p in $machinePaths) {
                # Both separator forms: PowerShell accepts / on Windows and hands
                # back whichever the caller used, so only replacing \ misses half.
                $native = $p.value
                $forward = $native.Replace('\', '/')
                $t = $t.Replace($native, $p.token)
                if ($forward -ne $native) { $t = $t.Replace($forward, $p.token) }
            }
            $t
        }
    }
    @{
        name  = 'username'
        why   = 'The account name appears in paths, in provider output and in some error messages.'
        apply = { param([string] $t) [regex]::Replace($t, [regex]::Escape($machineUser), '<USER>', 'IgnoreCase') }
    }
    @{
        name  = 'hostname'
        why   = 'The machine name appears in remoting, provider and process output.'
        apply = { param([string] $t) [regex]::Replace($t, [regex]::Escape($machineHost), '<HOST>', 'IgnoreCase') }
    }
    @{
        name  = 'process-id'
        why   = 'A pid changes on every run. Bounded by word boundaries so an unrelated number that happens to share the digits is left alone.'
        apply = { param([string] $t) [regex]::Replace($t, "\b$machinePid\b", '<PID>') }
    }
    @{
        name  = 'guid'
        why   = 'A GUID is new on every run. New-Guid is in the corpus specifically so that omitting this rule would break the determinism check rather than pass silently.'
        apply = { param([string] $t) [regex]::Replace($t, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', '<GUID>') }
    }
    @{
        name  = 'iso-timestamp'
        why   = 'Round-trip timestamps ("o" format) appear in DateTime output and in the capture metadata of nested objects.'
        apply = { param([string] $t) [regex]::Replace($t, '\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?', '<TIMESTAMP>') }
    }
    @{
        name  = 'clock-time'
        why   = 'A bare wall-clock time survives the timestamp rule when a date is formatted separately from its time.'
        apply = { param([string] $t) [regex]::Replace($t, '\b\d{1,2}:\d{2}:\d{2}(\.\d+)?\b', '<TIME>') }
    }
    @{
        name  = 'trailing-space'
        why   = 'Table rendering pads columns to the pinned width. The padding is presentational -- no semantic depends on it -- and keeping it would make every fixture diff unreadable.'
        apply = { param([string] $t) ($t -split "`n" | ForEach-Object { $_ -replace '[ \t]+$', '' }) -join "`n" }
    }
)

# Detectors, not rewriters. Each one answers "did something machine-specific
# survive?". A hit is a capture FAILURE unless the case declares it, because the
# alternative -- scrubbing whatever is left -- is how a harness stops testing.
$ResidueDetectors = @(
    @{
        name    = 'ansi-escape'
        why     = 'Rendering is pinned to PlainText. An escape sequence means the pinning stopped working, which must be fixed rather than scrubbed.'
        pattern = "`e"
    }
    @{
        name    = 'carriage-return'
        why     = 'The line-ending rule should have removed every CR. One surviving means it came from inside a string literal, where rewriting it would change the data.'
        pattern = "`r"
    }
    @{
        name    = 'windows-drive'
        why     = 'A drive letter means the case is Windows-specific. The compatibility profile this project publishes targets PowerShell on LINUX, so such a case cannot be compared and must say so.'
        pattern = '(?<![A-Za-z0-9_])[A-Za-z]:[\\/]'
    }
    @{
        name    = 'username-residue'
        why     = 'The account name survived canonicalisation, so the fixture would only reproduce for this user.'
        pattern = $null   # filled in below; needs the escaped literal
    }
    @{
        name    = 'hostname-residue'
        why     = 'The machine name survived canonicalisation.'
        pattern = $null
    }
    @{
        name    = 'bare-year'
        why     = 'A four-digit year that no timestamp rule matched is almost always the wall clock leaking in through an unexpected format.'
        pattern = '\b(19|20|21)\d{2}\b'
    }
)
foreach ($d in $ResidueDetectors) {
    if ($d.name -eq 'username-residue') { $d.pattern = "(?i)$([regex]::Escape($machineUser))" }
    if ($d.name -eq 'hostname-residue') { $d.pattern = "(?i)$([regex]::Escape($machineHost))" }
}

# Accumulated across the run. Chained access like $entry.rules.Count is ambiguous
# on an OrderedDictionary -- the adapter resolves property access as a key lookup
# first -- so counts are accumulated explicitly, never read off a nested member.
$script:RuleFireCount = [ordered]@{}
foreach ($r in $NormalisationRules) { $script:RuleFireCount[$r.name] = 0 }

function Get-NormalisedText {
    <#
        Applies every rule in order and reports which ones changed the text.
        The list of fired rules is recorded per case: a fixture should be able to
        say what was done to it, not just what it ended up as.
    #>
    param([string] $Text, [System.Collections.Generic.HashSet[string]] $Fired)

    if ($null -eq $Text) { return $null }
    foreach ($rule in $NormalisationRules) {
        $before = $Text
        $Text = & $rule.apply $Text
        if ($Text -ne $before) {
            $null = $Fired.Add($rule.name)
            $script:RuleFireCount[$rule.name] = $script:RuleFireCount[$rule.name] + 1
        }
    }
    return $Text
}

function Get-Residue {
    <# Which detectors matched. Empty is the only acceptable answer for a case
       that has not declared otherwise. #>
    param([string] $Text)
    $hits = @()
    if ($null -eq $Text) { return $hits }
    foreach ($d in $ResidueDetectors) {
        if ([regex]::IsMatch($Text, $d.pattern)) { $hits += $d.name }
    }
    return $hits
}

# ---------------------------------------------------------------------------
# value canonicalisation
# ---------------------------------------------------------------------------

$MaxValueDepth = 6

function ConvertTo-ConformanceValue {
    <#
        Turn a live PowerShell value into something JSON can hold and a
        TypeScript runner can compare, WITHOUT losing the distinctions that
        matter: a string stays a string, an array stays an array, and anything
        unrecognised is recorded by type name rather than stringified into
        ambiguity.

        Depth is bounded and exceeding it is RECORDED, not silently dropped --
        the same failure mode that ConvertTo-Json's default depth of 2 causes,
        which is why the whole document is written at depth 12.
    #>
    param(
        $Value,
        [System.Collections.Generic.HashSet[string]] $Fired,
        [int] $Depth = 0
    )

    if ($null -eq $Value) { return $null }
    if ($Depth -gt $MaxValueDepth) { return [ordered]@{ '$truncated' = 'depth' } }

    # -is already unwraps a PSObject wrapper, so the type tests below see the
    # underlying value without help. A PSCustomObject, however, is neither a
    # dictionary nor enumerable, so it needs its own branch or it would fall
    # through to the stringifying default and lose every property.
    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        $map = [ordered]@{}
        foreach ($prop in $Value.PSObject.Properties) {
            $map[$prop.Name] = ConvertTo-ConformanceValue -Value $prop.Value -Fired $Fired -Depth ($Depth + 1)
        }
        return $map
    }

    if ($Value -is [string]) { return (Get-NormalisedText -Text $Value -Fired $Fired) }
    if ($Value -is [bool])   { return $Value }
    if ($Value -is [char])   { return (Get-NormalisedText -Text ([string] $Value) -Fired $Fired) }
    if ($Value -is [datetime]) { return (Get-NormalisedText -Text $Value.ToString('o') -Fired $Fired) }
    if ($Value -is [guid])     { return (Get-NormalisedText -Text $Value.ToString() -Fired $Fired) }
    if ($Value -is [timespan]) { return (Get-NormalisedText -Text $Value.ToString() -Fired $Fired) }
    if ($Value -is [enum])     { return [string] $Value }

    # Integers are kept integral. Round-tripping them through Double would make
    # an Int64 boundary case unreadable, and that boundary is one of the things
    # the corpus is measuring.
    if ($Value -is [sbyte] -or $Value -is [byte] -or $Value -is [int16] -or $Value -is [uint16] -or
        $Value -is [int32] -or $Value -is [uint32] -or $Value -is [int64]) { return [long] $Value }
    if ($Value -is [uint64]) { return [decimal] $Value }
    if ($Value -is [single] -or $Value -is [double] -or $Value -is [decimal]) { return [double] $Value }

    if ($Value -is [System.Collections.IDictionary]) {
        $map = [ordered]@{}
        foreach ($key in $Value.Keys) {
            $map[[string] $key] = ConvertTo-ConformanceValue -Value $Value[$key] -Fired $Fired -Depth ($Depth + 1)
        }
        return $map
    }

    if ($Value -is [System.Collections.IEnumerable]) {
        $items = @()
        foreach ($item in $Value) {
            $items += , (ConvertTo-ConformanceValue -Value $item -Fired $Fired -Depth ($Depth + 1))
        }
        # The unary comma keeps a one-element result an ARRAY through the return.
        return , $items
    }

    # Anything else: record the type and a normalised rendering, so a value the
    # converter does not understand is visible as such instead of pretending to
    # be a string.
    return [ordered]@{
        '$type' = $Value.GetType().FullName
        '$text' = Get-NormalisedText -Text ([string] $Value) -Fired $Fired
    }
}

# ---------------------------------------------------------------------------
# evaluation
# ---------------------------------------------------------------------------

function Invoke-ConformanceCase {
    <#
        Evaluate one case's source and return its observable outcome.

        The source is compiled TOGETHER WITH the read of $? (see the file header)
        and invoked with & so it gets a child scope: without that, a variable one
        case assigns is visible to the next, and a case that reads a stale value
        looks like it passed.

        Every non-success stream is redirected away from the console. $Error is
        still populated by a redirected error, so nothing is lost -- only the
        display is suppressed, which keeps the capture's own output readable.
    #>
    param([string] $Source)

    $wrapper = @"
`$__conformanceOut = @(
$Source
)
`$script:__conformanceOk = `$?
`$script:__conformanceResult = `$__conformanceOut
"@

    # A SENTINEL, not $null. A terminating error aborts the whole compiled
    # wrapper, so neither the read of $? nor the result assignment runs.
    # Measured on pwsh 7.6.5: `1/0`, `$null.Foo()` and a parameter-validation
    # failure all leave both unset. Initialising them to $null instead would
    # have made [bool]$null report $? as False -- which happens to be the right
    # answer and was never measured -- and made @($null) look like one emitted
    # object. Both were fabrications, and both are now recorded as 'the source
    # did not complete'.
    $unset = [object]::new()
    $script:__conformanceOk = $unset
    $script:__conformanceResult = $unset
    $threw = $null

    # The case must run under the preference an interactive session has, NOT the
    # 'Stop' this script uses for its own operations. Measured: with 'Stop'
    # inherited, `Get-Command NoSuchCommandXyz` became TERMINATING, so the case
    # emitted nothing, $? was set by the catch rather than by PowerShell, and the
    # fixture recorded the harness's preference instead of the engine's
    # behaviour. Non-terminating has to stay non-terminating or the whole
    # error-shape half of the corpus measures nothing.
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $Error.Clear()

    $sb = [scriptblock]::Create($wrapper)
    try {
        & $sb 2>$null 3>$null 4>$null 5>$null 6>$null
    } catch {
        # A terminating error still has an outcome worth recording: the case is
        # asking what the reference implementation does, and "it threw" is an
        # answer. What it is NOT is an answer about $?.
        $threw = $_
    } finally {
        $ErrorActionPreference = $savedPreference
    }

    # $Error is snapshotted HERE, before this function runs anything else.
    # Measured: reading $LASTEXITCODE through Get-Variable first appended a
    # VariableNotFound record to $Error, which then appeared in all 89 cases --
    # the harness reporting its own error as the case's. error.no-error-on-success
    # exists in the corpus to keep catching exactly this.
    $records = @()
    if ($threw) { $records += $threw }
    foreach ($e in $Error) {
        if ($e -is [System.Management.Automation.ErrorRecord]) {
            if ($threw -and $e.Exception -eq $threw.Exception) { continue }
            $records += $e
        }
    }

    $terminated = [object]::ReferenceEquals($script:__conformanceResult, $unset)
    $emitted = if ($terminated) { @() } else { @($script:__conformanceResult) }
    $ok = if ([object]::ReferenceEquals($script:__conformanceOk, $unset)) { $null } else { [bool] $script:__conformanceOk }

    # $LASTEXITCODE does not exist until a native command has run, and reading a
    # non-existent variable is an error under Set-StrictMode -Version Latest.
    $lastExitVar = Get-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
    $lastExit = if ($lastExitVar) { $lastExitVar.Value } else { $null }

    return [ordered]@{
        emitted    = $emitted
        ok         = $ok
        terminated = $terminated
        lastExit   = $lastExit
        records    = $records
    }
}

function Get-CaseOutcome {
    <# The evaluated case, canonicalised: this is what a fixture stores and what
       the runner compares against. #>
    param([string] $Source, [int] $RenderWidth)

    $fired = [System.Collections.Generic.HashSet[string]]::new()
    $raw = Invoke-ConformanceCase -Source $Source

    $objects = @()
    $typeNames = @()
    $values = @()
    $objectCount = 0
    foreach ($item in $raw.emitted) {
        $objectCount++
        $names = @()
        $mostDerived = $null
        if ($null -ne $item) {
            # TypeNames is a hierarchy and the whole chain is part of the
            # contract -- -is and the formatter both walk it. Reached through
            # .PSObject rather than PSObject::AsPSObject, which does not surface
            # the adapted member on every value.
            $names = @($item.PSObject.TypeNames)
            if ($names.Count -gt 0) { $mostDerived = $names[0] }
        }
        $canonical = ConvertTo-ConformanceValue -Value $item -Fired $fired
        $objects += , [ordered]@{ typeNames = $names; value = $canonical }
        $typeNames += , $mostDerived
        $values += , $canonical
    }

    # Errors are recorded STRUCTURALLY and are deliberately kept out of the text
    # rendering. PowerShell's error display embeds the script path, the line
    # number and a caret diagram, none of which reproduce; the fields scripts
    # actually branch on -- the id and the category -- do.
    $errors = @()
    foreach ($r in $raw.records) {
        $errors += , [ordered]@{
            fullyQualifiedErrorId = $r.FullyQualifiedErrorId
            category              = [string] $r.CategoryInfo.Category
            reason                = $r.CategoryInfo.Reason
            activity              = $r.CategoryInfo.Activity
            targetName            = Get-NormalisedText -Text ([string] $r.CategoryInfo.TargetName) -Fired $fired
            exceptionType         = $r.Exception.GetType().FullName
            message               = Get-NormalisedText -Text ([string] $r.Exception.Message) -Fired $fired
        }
    }

    # Width is pinned rather than inherited: Out-String defaults to the host
    # window, which differs between an interactive console, a redirected pipe
    # and CI, and the column layout follows it.
    $text = ''
    if ($objectCount -gt 0) { $text = ($raw.emitted | Out-String -Width $RenderWidth) }
    $text = Get-NormalisedText -Text $text -Fired $fired

    return [ordered]@{
        objectCount  = $objectCount
        typeNames    = $typeNames
        values       = $values
        text         = $text
        # null, not false, when the source terminated before $? could be read.
        ok           = $raw.ok
        terminated   = $raw.terminated
        lastExitCode = $raw.lastExit
        errorCount   = $errors.Count
        errors       = $errors
        rulesApplied = @($fired | Sort-Object)
    }
}

function Get-OutcomeSignature {
    <# Two outcomes are "the same" iff their canonical JSON is byte-identical.
       Comparing structures field by field would eventually forget a field. #>
    param($Outcome)
    return ($Outcome | ConvertTo-Json -Depth 12 -Compress)
}

function Get-SourceHash {
    <# Binds a fixture to the exact source that produced it, so editing a corpus
       case without re-capturing is a hard error in the runner rather than a
       comparison against a stale recording. #>
    param([string] $Text)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
        return 'sha256:' + [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
}

# ---------------------------------------------------------------------------
# corpus
# ---------------------------------------------------------------------------

if (-not (Test-Path -LiteralPath $CorpusFile)) {
    throw "corpus not found: $CorpusFile"
}
$corpus = Get-Content -LiteralPath $CorpusFile -Raw -Encoding utf8 | ConvertFrom-Json

$KnownCaseKeys = @('id', 'area', 'command', 'why', 'source', 'observe', 'probe', 'pending', 'volatile', 'platformSensitive', 'passes', 'passesReason')
$KnownObservables = @('values', 'typeNames', 'objectCount', 'text', 'ok', 'lastExitCode', 'errorId', 'errorCategory', 'errorCount')

$seenIds = [System.Collections.Generic.HashSet[string]]::new()
foreach ($case in $corpus.cases) {
    $names = @($case.PSObject.Properties.Name)
    foreach ($required in @('id', 'area', 'why', 'source', 'observe', 'probe')) {
        if ($names -notcontains $required) { throw "corpus case is missing '$required': $($case | ConvertTo-Json -Depth 4 -Compress)" }
    }
    foreach ($n in $names) {
        # An unknown key is a typo or a feature nobody implemented. Either way,
        # silently ignoring it means the case does not do what it says.
        if ($KnownCaseKeys -notcontains $n) { throw "corpus case '$($case.id)' has unknown key '$n'" }
    }
    if (-not $seenIds.Add($case.id)) { throw "duplicate corpus case id: $($case.id)" }
    if ($KnownObservables -notcontains $case.observe) { throw "corpus case '$($case.id)' observes unknown '$($case.observe)'" }
    if ([string]::IsNullOrWhiteSpace($case.why)) { throw "corpus case '$($case.id)' has no 'why'" }
    if ($names -contains 'passes') {
        if ($case.passes -ne 'single') { throw "corpus case '$($case.id)': 'passes' may only be 'single'" }
        if ($names -notcontains 'passesReason' -or [string]::IsNullOrWhiteSpace($case.passesReason)) {
            throw "corpus case '$($case.id)' reduces its passes without a 'passesReason'"
        }
    }
    if ($case.probe.kind -eq 'none' -and ($names -notcontains 'pending' -or [string]::IsNullOrWhiteSpace($case.pending))) {
        throw "corpus case '$($case.id)' has probe kind 'none' without a 'pending' reason"
    }
}

$selected = @($corpus.cases)
if ($Id -and $Id.Count -gt 0) {
    $selected = @($corpus.cases | Where-Object { $Id -contains $_.id })
    $missingIds = @($Id | Where-Object { $sel = $_; -not ($selected | Where-Object { $_.id -eq $sel }) })
    if ($missingIds.Count -gt 0) { throw "no such corpus case: $($missingIds -join ', ')" }
}

# ---------------------------------------------------------------------------
# capture
# ---------------------------------------------------------------------------

$results = @()
$failures = @()
$caseCount = 0
$volatileCount = 0
$cultureSensitiveCount = 0

Write-Host ''
Write-Host "  capturing $($selected.Count) case(s) against PowerShell $psVersion"
Write-Host "  width=$Width culture=$Culture stress=$StressCulture host=$hostCulture/$hostUICulture"
Write-Host ''

foreach ($case in $selected) {
    $caseCount++
    $names = @($case.PSObject.Properties.Name)
    $declaredVolatile = if ($names -contains 'volatile') { [string] $case.volatile } else { $null }
    $declaredPlatform = if ($names -contains 'platformSensitive') { [string] $case.platformSensitive } else { $null }
    $singlePass = ($names -contains 'passes' -and $case.passes -eq 'single')

    Set-CaptureCulture -Name $Culture
    $first = Get-CaseOutcome -Source $case.source -RenderWidth $Width
    $firstSignature = Get-OutcomeSignature $first

    $determinism = 'stable'
    if (-not $singlePass) {
        # The repeat pass is the whole reason a fixture can be trusted: it is
        # what turns "this ran once" into "this reproduces".
        $second = Get-CaseOutcome -Source $case.source -RenderWidth $Width
        if ((Get-OutcomeSignature $second) -ne $firstSignature) {
            if ($declaredVolatile) {
                $determinism = 'declared-volatile'
            } else {
                $determinism = 'UNSTABLE'
                $failures += "  $($case.id): two identical runs produced different normalised output. Either a normalisation rule is missing, or the case is genuinely volatile and must declare it with a reason."
            }
        }
    } else {
        $determinism = 'single-pass'
    }

    # Culture passes. Not a pass/fail -- evidence. "Which cases depend on the
    # culture?" is a question this project answers with a locale pin, and a pin
    # is only defensible if the cost of it has been measured.
    $cultureFindings = @()
    if (-not $singlePass) {
        foreach ($other in @($hostCulture, $StressCulture)) {
            if ($other -eq $Culture) { continue }
            Set-CaptureCulture -Name $other
            $alt = Get-CaseOutcome -Source $case.source -RenderWidth $Width
            $differs = (Get-OutcomeSignature $alt) -ne $firstSignature
            if ($differs -and $determinism -eq 'declared-volatile') { $differs = $false }  # already known to vary run to run
            $cultureFindings += , [ordered]@{
                culture = $other
                differs = $differs
                values  = if ($differs) { $alt.values } else { $null }
            }
            if ($differs) { $cultureSensitiveCount++ }
        }
        Set-CaptureCulture -Name $Culture
    }

    # Residue: what normalisation could NOT fix. A hit is a failure unless the
    # case declared it, because scrubbing whatever is left over is exactly how a
    # differential harness stops differentiating.
    $residueText = @($first.text) + @($first.values | ForEach-Object { if ($_ -is [string]) { $_ } }) +
                   @($first.errors | ForEach-Object { $_.message; $_.targetName })
    $residue = @()
    foreach ($t in $residueText) {
        if ($t -is [string]) { foreach ($hit in (Get-Residue -Text $t)) { if ($residue -notcontains $hit) { $residue += $hit } } }
    }
    if ($residue.Count -gt 0) {
        if ($declaredVolatile -or $declaredPlatform) {
            $volatileCount++
        } else {
            $failures += "  $($case.id): machine-specific data survived normalisation ($($residue -join ', ')). Add a rule, change the case, or declare 'volatile'/'platformSensitive' with a reason."
        }
    }

    $record = [ordered]@{
        id                = $case.id
        area              = $case.area
        command           = $case.command
        source            = $case.source
        sourceHash        = Get-SourceHash $case.source
        observe           = $case.observe
        determinism       = $determinism
        residue           = $residue
        declaredVolatile  = $declaredVolatile
        declaredPlatform  = $declaredPlatform
        cultureFindings   = $cultureFindings
        outcome           = $first
    }
    $results += , $record
}

Set-CaptureCulture -Name $Culture

# ---------------------------------------------------------------------------
# write
# ---------------------------------------------------------------------------

$ruleSummary = [ordered]@{}
foreach ($r in $NormalisationRules) {
    $ruleSummary[$r.name] = [ordered]@{ why = $r.why; firedOnCases = $script:RuleFireCount[$r.name] }
}
$detectorSummary = [ordered]@{}
foreach ($d in $ResidueDetectors) { $detectorSummary[$d.name] = $d.why }

$document = [ordered]@{
    '$comment'    = 'Generated by tools/generate-conformance-fixtures.ps1 from a real PowerShell. Do not hand-edit: a hand-edited fixture is a claim with no engine behind it.'
    schemaVersion = 1
    capturedAt    = (Get-Date).ToUniversalTime().ToString('o')
    partial       = [bool] ($Id -and $Id.Count -gt 0)
    corpus        = [ordered]@{
        file        = 'tests/conformance/corpus.json'
        caseCount   = $caseCount
        totalInFile = @($corpus.cases).Count
    }
    engine        = [ordered]@{
        psVersion   = $psVersion
        psEdition   = $PSVersionTable.PSEdition
        gitCommitId = $PSVersionTable.GitCommitId
        os          = $PSVersionTable.OS
        platform    = $PSVersionTable.Platform
        framework   = [System.Runtime.InteropServices.RuntimeInformation]::FrameworkDescription
    }
    capture       = [ordered]@{
        # Recorded so a fixture can never be silently attributed to different
        # host conditions than the ones it was produced under.
        renderWidth       = $Width
        pinnedCulture     = $Culture
        stressCulture     = $StressCulture
        hostCulture       = $hostCulture
        hostUICulture     = $hostUICulture
        outputRendering   = if ($hadPSStyle) { [string] $PSStyle.OutputRendering } else { 'unavailable' }
        strictMode        = 'Latest'
    }
    normalisation = [ordered]@{
        rules     = $ruleSummary
        detectors = $detectorSummary
    }
    cases         = $results
}

# Depth matters: cases nest several levels and ConvertTo-Json silently truncates
# past its default depth of 2, which would produce a file that looks complete and
# is not. Same reason as capture-pwsh-metadata.ps1.
$json = $document | ConvertTo-Json -Depth 12
Set-Content -Path $OutFile -Value $json -Encoding utf8NoBOM

$fired = @($NormalisationRules | Where-Object { $script:RuleFireCount[$_.name] -gt 0 })
Write-Host "  PowerShell $psVersion on $([System.Runtime.InteropServices.RuntimeInformation]::FrameworkDescription) ($($PSVersionTable.Platform))"
Write-Host "  captured $caseCount case(s)"
Write-Host "  normalisation rules that fired: $(($fired | ForEach-Object { "$($_.name)x$($script:RuleFireCount[$_.name])" }) -join ', ')"
Write-Host "  culture-sensitive observations: $cultureSensitiveCount"
Write-Host "  cases with declared residue    : $volatileCount"
Write-Host "  wrote $OutFile"

if ($failures.Count -gt 0) {
    Write-Host ''
    Write-Host "  CAPTURE FAILED -- $($failures.Count) case(s) are not reproducible:"
    foreach ($f in $failures) { Write-Host $f }
    Write-Host ''
    Write-Host '  The fixture was still written so the failure can be inspected, but it'
    Write-Host '  must not be committed in this state.'
    Write-Host ''
    exit 1
}

Write-Host ''
exit 0
