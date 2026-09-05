<#
.SYNOPSIS
    Decodes every backtick escape and here-string edge case, as pwsh decodes it.

.DESCRIPTION
    The value a string token carries is the thing four tokenizers disagreed
    about, and backtick escapes are where a hand-written lexer goes wrong
    quietly: an unrecognised escape is NOT an error in PowerShell, it drops the
    backtick, so guessing "leave it alone" and guessing "drop it" both look
    plausible and only one is right.

    Emits code points rather than raw characters, so the comparison cannot be
    confused by console encoding.

.EXAMPLE
    pwsh -NoProfile -File tools/probe-lexer-escapes.ps1 > probe-escapes.json
#>

$ErrorActionPreference = 'Stop'

function Get-Value {
  param([string] $Source)
  $tokens = $null
  $errors = $null
  $null = [System.Management.Automation.Language.Parser]::ParseInput($Source, [ref]$tokens, [ref]$errors)
  $string = $tokens | Where-Object { $_ -is [System.Management.Automation.Language.StringToken] } | Select-Object -First 1
  $errs = @()
  foreach ($x in $errors) { $errs += $x.ErrorId }
  $points = @()
  if ($null -ne $string) {
    foreach ($c in $string.Value.ToCharArray()) { $points += [int] $c }
  }
  return [ordered]@{
    source     = $Source
    kind       = if ($null -eq $string) { 'none' } else { $string.Kind.ToString() }
    value      = if ($null -eq $string) { $null } else { $string.Value }
    codePoints = $points
    errors     = $errs
  }
}

# Every escape the language defines, plus several it does not, plus the same
# sequences inside single quotes where NONE of them should apply.
$escapes = New-Object System.Collections.ArrayList
foreach ($e in @('0', 'a', 'b', 'e', 'f', 'n', 'r', 't', 'v', '`', '"', '$',
                 'q', 'z', 'x', 'A', 'N', 'T', '''', '1', ' ', '-')) {
  [void] $escapes.Add((Get-Value ("`"pre``$e" + 'post"')))
  [void] $escapes.Add((Get-Value ("'pre``$e" + "post'")))
}
# Unicode escape, and a trailing backtick with nothing after it.
[void] $escapes.Add((Get-Value '"`u{1F600}"'))
[void] $escapes.Add((Get-Value '"`u{41}"'))
[void] $escapes.Add((Get-Value '"`u41"'))
[void] $escapes.Add((Get-Value '"abc`"'))
[void] $escapes.Add((Get-Value "'abc``'"))

# Here-string edge cases: is the opening newline dropped? the closing one? does
# a quote inside need escaping? does the terminator have to be at column zero?
$hereStrings = New-Object System.Collections.ArrayList
foreach ($h in @(
  "@`"`na`n`"@"
  "@`"`n`n`"@"
  "@`"`"@"
  "@`"`na`nb`n`"@"
  "@`"`na`"b`n`"@"
  "@`"`n`$x`n`"@"
  "@`"`n``t`n`"@"
  "@'`na`n'@"
  "@'`n`$x`n'@"
  "@'`n``t`n'@"
  "@'`na'b`n'@"
  "@`"`na`n  `"@"
  "@`"`na`nb"
)) { [void] $hereStrings.Add((Get-Value $h)) }

# Bare-word (Generic) values: the same escape rules, outside any quote.
function Get-Generic {
  param([string] $Source)
  $tokens = $null
  $errors = $null
  $null = [System.Management.Automation.Language.Parser]::ParseInput($Source, [ref]$tokens, [ref]$errors)
  $list = New-Object System.Collections.ArrayList
  foreach ($t in $tokens) {
    if ($t.Kind.ToString() -eq 'EndOfInput') { continue }
    $e = [ordered]@{ kind = $t.Kind.ToString(); text = $t.Text }
    if ($t -is [System.Management.Automation.Language.StringToken]) { $e['value'] = $t.Value }
    [void] $list.Add($e)
  }
  $errs = @()
  foreach ($x in $errors) { $errs += $x.ErrorId }
  return [ordered]@{ source = $Source; tokens = $list; errors = $errs }
}

$bare = New-Object System.Collections.ArrayList
foreach ($b in @(
  'f a`tb'
  'f a`nb'
  'f a` b'
  'f a``b'
  'f a`$b'
  'f a`qb'
  'f a"b"c'
  'f a''b''c'
  'f "a"b'
  'f a#b'
  'f a #b'
  'f -p:a'
  'f -p:"a b"'
  'f a,b'
  'f a`'
  'f `'
)) { [void] $bare.Add((Get-Generic $b)) }

[ordered]@{
  pwsh        = $PSVersionTable.PSVersion.ToString()
  escapes     = $escapes
  hereStrings = $hereStrings
  bare        = $bare
} | ConvertTo-Json -Depth 10
