<#
.SYNOPSIS
    Dumps pwsh's OWN tokens and AST for a corpus of command lines.

.DESCRIPTION
    PR-08 replaces four hand-rolled tokenizers with one lexer. Reasoning about
    PowerShell's quoting rules from memory is how the four drifted apart in the
    first place, so this asks the reference implementation instead.

    `[System.Management.Automation.Language.Parser]::ParseInput()` is the
    strongest evidence available: it is the very lexer and parser that pwsh runs,
    and it reports the token kind, the token flags, the extent, and — for string
    and number tokens — the decoded VALUE, which is the thing four tokenizers
    disagreed about.

    Output is a single JSON document on stdout so a Node-side gate can compare
    against it byte for byte. Read-only: it parses, it never executes.

.EXAMPLE
    pwsh -NoProfile -File tools/probe-lexer.ps1 > probe-lexer.json
#>

$ErrorActionPreference = 'Stop'

# One case per line. Kept as a literal array (not a here-string) so that the
# backticks and dollars below are exactly the characters pwsh will lex.
$cases = @(
  # --- quoting -------------------------------------------------------------
  'Write-Output ''single'''
  'Write-Output "double"'
  'Write-Output ''it''''s'''
  'Write-Output "say ""hi"""'
  'Write-Output ''$notvar'''
  'Write-Output "$var"'
  'Write-Output "a`tb"'
  'Write-Output ''a`tb'''
  'Write-Output "a`nb"'
  'Write-Output "esc `$literal"'
  'Write-Output "back``tick"'
  'Write-Output a` b'
  'Write-Output a''b'
  'Write-Output --path="a b"'
  # --- expansion -----------------------------------------------------------
  'Write-Output "$(1+1)"'
  'Write-Output $(Get-Date)'
  'Write-Output @(1,2,3)'
  'Write-Output @{a=1}'
  'Write-Output "prefix$($x.Length)suffix"'
  'Write-Output ${weird name}'
  'Write-Output $env:PATH'
  'Write-Output $global:x'
  'Write-Output $_.Name'
  # --- here-strings --------------------------------------------------------
  "Write-Output @`"`nline1`nline2`n`"@"
  "Write-Output @'`nline1`nline2`n'@"
  # --- stop-parsing --------------------------------------------------------
  'cmd --% /c "echo $x" | more'
  'Write-Output --%'
  # --- splatting -----------------------------------------------------------
  'Get-ChildItem @params'
  'Get-ChildItem @params -Force'
  # --- redirection ---------------------------------------------------------
  'Get-ChildItem > out.txt'
  'Get-ChildItem >> out.txt'
  'Get-ChildItem 2> err.txt'
  'Get-ChildItem 2>&1'
  'Get-ChildItem *> all.txt'
  'Get-ChildItem 3>&1 4>&1'
  'Get-Content < in.txt'
  'Get-ChildItem 1>&2'
  # --- operators and separators -------------------------------------------
  'a | b'
  'a && b'
  'a || b'
  'a ; b'
  'Start-Sleep 1 &'
  '$x -eq 1'
  '$x -like "a*"'
  '1..10'
  '$a,$b'
  '-5'
  '--Path'
  '-'
  '-Name:value'
  '-Force:$false'
  '[int]::MaxValue'
  '1kb'
  '0x1F'
  '1.5e3'
  '1d'
  '$x++'
  '2 -shl 3'
  # --- comments ------------------------------------------------------------
  'Get-Date # trailing comment'
  '<# block #> Get-Date'
  # --- blocks --------------------------------------------------------------
  'Where-Object { $_.Length -gt 10 }'
  'if ($true) { 1 } else { 2 }'
  'foreach ($i in 1..3) { $i }'
  'function f { param($x) $x }'
  '$x = 1'
  'try { 1 } catch { 2 }'
  'while ($true) { break }'
  'switch ($x) { 1 { "one" } }'
  '$h = @{}; $h.a = 1'
  'do { 1 } while ($false)'
  'trap { 1 }'
  'class C { }'
  'workflow W { }'
  'configuration C { }'
  'data d { 1 }'
  'InlineScript { 1 }'
  'using namespace System'
  '$x?.Length'
  '$null ?? "d"'
  '$a ? 1 : 2'
  # --- error tolerance -----------------------------------------------------
  'Write-Output "unterminated'
  'Write-Output ''unterminated'
  'Get-ChildItem -Path'
  'Where-Object { $_.Length'
  'Get-ChildItem |'
  '"a" + '
)

$results = New-Object System.Collections.ArrayList

foreach ($case in $cases) {
  $tokens = $null
  $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseInput($case, [ref]$tokens, [ref]$errors)

  $tokenList = New-Object System.Collections.ArrayList
  foreach ($t in $tokens) {
    $entry = [ordered]@{
      kind  = $t.Kind.ToString()
      flags = $t.TokenFlags.ToString()
      text  = $t.Text
      start = $t.Extent.StartOffset
      end   = $t.Extent.EndOffset
    }
    # StringToken and NumberToken carry the DECODED value. That is the fact four
    # tokenizers disagreed about, so it is captured whenever it exists.
    if ($t -is [System.Management.Automation.Language.StringToken]) {
      $entry['value'] = $t.Value
    }
    if ($t -is [System.Management.Automation.Language.NumberToken]) {
      $entry['value'] = [string] $t.Value
      $entry['valueType'] = $t.Value.GetType().FullName
    }
    if ($t -is [System.Management.Automation.Language.VariableToken]) {
      $entry['variableName'] = $t.VariablePath.UserPath
    }
    [void] $tokenList.Add($entry)
  }

  # Every distinct AST node type in the tree, so task 3 has a real vocabulary of
  # node names to refuse by rather than an invented one.
  $nodeTypes = New-Object System.Collections.Generic.List[string]
  if ($null -ne $ast) {
    $found = $ast.FindAll({ $true }, $true)
    foreach ($n in $found) { $nodeTypes.Add($n.GetType().Name) }
  }

  $errorList = New-Object System.Collections.ArrayList
  foreach ($e in $errors) {
    [void] $errorList.Add([ordered]@{
      id      = $e.ErrorId
      message = $e.Message
      start   = $e.Extent.StartOffset
    })
  }

  [void] $results.Add([ordered]@{
    source    = $case
    tokens    = $tokenList
    nodeTypes = ($nodeTypes | Select-Object -Unique)
    errors    = $errorList
  })
}

[ordered]@{
  pwsh   = $PSVersionTable.PSVersion.ToString()
  os     = [System.Runtime.InteropServices.RuntimeInformation]::OSDescription
  cases  = $results
} | ConvertTo-Json -Depth 12
