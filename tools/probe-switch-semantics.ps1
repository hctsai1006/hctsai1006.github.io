<#
.SYNOPSIS
    Measures how a real PowerShell handles an explicit -<Switch>:$false, per cmdlet.

.DESCRIPTION
    The compatibility layer used to model this as ONE engine-wide flag,
    switchParameters.honourExplicitFalse, on the stated grounds that "thirteen
    upstream PRs fixed one design mistake". This script is why that model was
    replaced. Every claim it prints is a measurement, not a reading of the
    changelog, and the two disagree in ways that matter:

      * The BINDER already honours an explicit :$false in 7.6.5 — for an
        advanced function, -Force:$false binds with ContainsKey true, IsPresent
        False and ToBool False. So the default for a command/parameter pair
        nobody fixed is "honour the value", in BOTH lines, and the global flag
        was making the 7.6 profile diverge from the reference implementation on
        every switch it touched. Section 8 shows that directly on Get-ChildItem.

      * The defect is in the COMMAND BODIES, one cmdlet at a time. PowerShell
        7.7 cites a separate PR per cmdlet (#26140 New-Guid -Empty, #26457
        Get-Random -Shuffle, #26463 Get-TimeZone -ListAvailable, #26474
        Split-Path -Qualifier/-NoQualifier/-Leaf/-IsAbsolute, #26485
        Where-Object's operator switches, and so on), so 7.7 still has the old
        behaviour for every switch none of them touched.

    Sections 6 and 7 measure two further curated claims that were stated without
    being checked: Format-Table -Property '' does NOT succeed in 7.6.5, and
    Export-Csv -Append -NoHeader together IS accepted there.

    Run against pwsh 7.6.5 to reproduce the numbers recorded in
    compat/deltas/powershell-77-changes.source.mts. Read-only apart from two
    files it creates and removes under the system temp directory.

.EXAMPLE
    pwsh -NoProfile -File tools/probe-switch-semantics.ps1
#>

$ErrorActionPreference = 'Stop'
"pwsh = " + $PSVersionTable.PSVersion.ToString()
"OS   = " + [System.Runtime.InteropServices.RuntimeInformation]::OSDescription

# --- 1. the binder itself ----------------------------------------------------
# If this section shows Force.ToBool=False for -Force:$false, then the binder is
# NOT where the version difference lives, and a binder-wide flag is the wrong
# shape for it.
function Test-Diff {
  [CmdletBinding()]
  param([switch] $Force)
  $keys = ($PSBoundParameters.Keys | Sort-Object) -join ','
  "    bound=[$keys] IsPresent=$($Force.IsPresent) ToBool=$($Force.ToBool())"
}
""
"--- 1. advanced-function binder ---"
"  -Force";        Test-Diff -Force
"  -Force:`$false"; Test-Diff -Force:$false
"  -Force:`$true";  Test-Diff -Force:$true
"  (none)";        Test-Diff

# --- 2. Where-Object, PR 26485 ----------------------------------------------
""
"--- 2. Where-Object operator switches (PR 26485) ---"
$data = @(
  [pscustomobject]@{ A = 1; B = $true;  N = 'one' }
  [pscustomobject]@{ A = 2; B = $false; N = 'two' }
  [pscustomobject]@{ A = 3; B = $true;  N = 'three' }
)
"  -GT 1         -> " + (($data | Where-Object -Property A -GT -Value 1).N -join ',')
"  -GT:`$false 1  -> " + (($data | Where-Object -Property A -GT:$false -Value 1).N -join ',')
"  -Not          -> " + (($data | Where-Object -Property B -Not).N -join ',')
"  -Not:`$false   -> " + (($data | Where-Object -Property B -Not:$false).N -join ',')

# --- 3. the per-cmdlet family ------------------------------------------------
""
"--- 3. one cmdlet at a time ---"
"  New-Guid -Empty            (PR 26140) -> " + (New-Guid -Empty)
"  New-Guid -Empty:`$false                -> " + (New-Guid -Empty:$false)
"  Split-Path -Leaf           (PR 26474) -> " + (Split-Path '/a/b/c.txt' -Leaf)
"  Split-Path -Leaf:`$false               -> " + (Split-Path '/a/b/c.txt' -Leaf:$false)
"  Get-Uptime -Since          (PR 26141) -> " + (Get-Uptime -Since)
"  Get-Uptime -Since:`$false              -> " + (Get-Uptime -Since:$false)
# Only meaningful where the host has a full time-zone database. A container
# with no tzdata reports 1 for both, which proves nothing either way -- so the
# count is printed alongside the total rather than on its own.
$tzAll = (Get-TimeZone -ListAvailable).Count
"  Get-TimeZone -ListAvailable       (PR 26463) count -> $tzAll"
"  Get-TimeZone -ListAvailable:`$false          count -> " + (Get-TimeZone -ListAvailable:$false).Count +
  $(if ($tzAll -le 1) { "   (INCONCLUSIVE: this host knows $tzAll zone(s))" } else { '' })

""
"--- 4. Get-Random -Shuffle (PR 26457): a single draw would mean :`$false was honoured ---"
foreach ($seed in 1, 2, 7, 42) {
  $on  = (Get-Random -InputObject (1..6) -Shuffle -SetSeed $seed) -join ','
  $off = (Get-Random -InputObject (1..6) -Shuffle:$false -SetSeed $seed) -join ','
  "  seed=$seed  -Shuffle -> $on   -Shuffle:`$false -> $off   identical=$($on -eq $off)"
}

# --- 5. the CSV cmdlets, PR 26719 -------------------------------------------
""
"--- 5. CSV type information (PR 26719) ---"
$o = [pscustomobject]@{ X = 1 }
"  ConvertTo-Csv -IncludeTypeInformation        -> " + (($o | ConvertTo-Csv -IncludeTypeInformation) -join ' | ')
"  ConvertTo-Csv -IncludeTypeInformation:`$false -> " + (($o | ConvertTo-Csv -IncludeTypeInformation:$false) -join ' | ')
"  ConvertTo-Csv -NoTypeInformation:`$false      -> " + (($o | ConvertTo-Csv -NoTypeInformation:$false) -join ' | ')
try {
  $r = $o | ConvertTo-Csv -NoTypeInformation:$false -IncludeTypeInformation:$false
  "  both as :`$false                              -> " + ($r -join ' | ')
} catch {
  "  both as :`$false                              -> THROWS " + $_.FullyQualifiedErrorId
}
"  Import-Csv switches      -> " + (((Get-Command Import-Csv).Parameters.Values |
  Where-Object { $_.ParameterType -eq [switch] } | ForEach-Object Name | Sort-Object) -join ',')
"  ConvertFrom-Csv switches -> " + (((Get-Command ConvertFrom-Csv).Parameters.Values |
  Where-Object { $_.ParameterType -eq [switch] } | ForEach-Object Name | Sort-Object) -join ',')
"  (neither declares a type-information switch, so the changelog's claim that"
"   #26719 fixed theirs cannot be true. The PR diff touches neither.)"

# --- 6. Format-* -Property '', PR 26552 --------------------------------------
""
"--- 6. Format-Table -Property '' (PR 26552) ---"
"  declared attributes on -Property: " +
  (((Get-Command Format-Table).Parameters['Property'].Attributes | ForEach-Object { $_.GetType().Name }) -join ',')
try {
  $null = $o | Format-Table -Property '' | Out-String
  "  -Property '' -> rendered without error"
} catch {
  "  -Property '' -> THROWS " + $_.Exception.GetType().FullName + " id=" + $_.FullyQualifiedErrorId
  "     is a ParameterBindingException? " + ($_.Exception -is [System.Management.Automation.ParameterBindingException])
  "     (binds, then fails inside the FORMATTER, so 7.7 changes where it fails, not whether)"
}

# --- 7. Export-Csv -Append -NoHeader, PR 26472 -------------------------------
""
"--- 7. Export-Csv -Append -NoHeader together (PR 26472) ---"
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("csv-" + [guid]::NewGuid().ToString('N') + ".csv")
try {
  $o | Export-Csv -Path $tmp -NoTypeInformation
  $o | Export-Csv -Path $tmp -Append -NoHeader
  "  accepted in this version; file is:"
  Get-Content $tmp | ForEach-Object { "    $_" }
} catch {
  "  THROWS " + $_.FullyQualifiedErrorId
} finally { Remove-Item $tmp -ErrorAction Ignore }

# --- 8. a switch upstream NEVER fixed ---------------------------------------
# The control, and the section that condemned the old model outright.
# Get-ChildItem -Force appears in NONE of the ten PRs, so both lines must honour
# the value. The engine-wide flag overrode it, which made BrowserShell's 7.6
# profile list hidden files where the reference implementation lists none.
#
# "Hidden" is spelled differently per platform: an attribute on Windows, a
# leading dot on Unix. Getting that wrong makes the section silently vacuous --
# a file called hidden.txt is not hidden on Linux, so every row would match and
# the control would prove nothing while looking like it passed.
""
"--- 8. Get-ChildItem -Force:`$false, which no 7.7 PR touches ---"
$root = Join-Path ([System.IO.Path]::GetTempPath()) ("gci-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
try {
  Set-Content -Path (Join-Path $root 'visible.txt') -Value 'v'
  if ($IsWindows) {
    $hidden = Join-Path $root 'hidden.txt'
    Set-Content -Path $hidden -Value 'h'
    (Get-Item $hidden).Attributes = 'Hidden'
  } else {
    Set-Content -Path (Join-Path $root '.hidden.txt') -Value 'h'
  }
  $plain = ((Get-ChildItem -Path $root).Name | Sort-Object) -join ','
  $forced = ((Get-ChildItem -Path $root -Force).Name | Sort-Object) -join ','
  $off = ((Get-ChildItem -Path $root -Force:$false).Name | Sort-Object) -join ','
  "  (no switch)     -> $plain"
  "  -Force          -> $forced"
  "  -Force:`$false   -> $off"
  if ($plain -eq $forced) {
    "  INCONCLUSIVE on this host: -Force changed nothing, so the control cannot discriminate."
  } elseif ($off -eq $plain) {
    "  => the value IS honoured, in a version where no upstream PR fixed this pair."
  } else {
    "  => the value is IGNORED here."
  }
} finally { Remove-Item $root -Recurse -Force -ErrorAction Ignore }

# --- 9. things 7.7 adds, which must be ABSENT here --------------------------
""
"--- 9. absent in this version (7.7 additions) ---"
"  New-TemporaryDirectory        -> " + $(if (Get-Command New-TemporaryDirectory -ErrorAction Ignore) { 'PRESENT' } else { 'absent' })
"  Join-Path -Extension          -> " + $(if ((Get-Command Join-Path).Parameters.ContainsKey('Extension')) { 'PRESENT' } else { 'absent' })
"  Format-Table -ExcludeProperty -> " + $(if ((Get-Command Format-Table).Parameters.ContainsKey('ExcludeProperty')) { 'PRESENT' } else { 'absent' })
"  `$PSApplicationOutputEncoding  -> " + $(if (Get-Variable PSApplicationOutputEncoding -ErrorAction Ignore) { 'PRESENT' } else { 'absent' })
"  [WildcardPattern]::ToRegex    -> " + $(if ([System.Management.Automation.WildcardPattern].GetMethod('ToRegex')) { 'PRESENT' } else { 'absent' })

# --- 10. the validation exception type, PR 26668 -----------------------------
""
"--- 10. not-null-not-empty validation exception (PR 26668) ---"
function Test-Val { [CmdletBinding()] param([ValidateNotNullOrEmpty()][string] $S) $S }
try { Test-Val -S '' } catch {
  "  outer   -> " + $_.Exception.GetType().FullName
  "  inner   -> " + $(if ($_.Exception.InnerException) { $_.Exception.InnerException.GetType().FullName } else { '(none)' })
  "  errorId -> " + $_.FullyQualifiedErrorId
}
