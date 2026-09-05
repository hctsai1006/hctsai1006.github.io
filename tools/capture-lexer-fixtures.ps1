<#
.SYNOPSIS
    Captures the reference implementation's own tokens for the shared lexer
    corpus, so the differential test can run with no pwsh and no network.

.DESCRIPTION
    Reads tests/unit/fixtures/lexer-corpus.json — the SAME file the test reads,
    so the corpus cannot drift between what was measured and what is checked —
    and writes tests/unit/fixtures/lexer-pwsh-7.6.5.json.

    The tokens come from [System.Management.Automation.Language.Parser]::ParseInput,
    which is the lexer pwsh itself runs. Nothing here is executed: the corpus
    contains redirections and commands that would touch the filesystem, and
    parsing them is safe precisely because parsing is all that happens.

    Re-run after changing the corpus:
        npm run capture:lexer

.NOTES
    Windows and Linux pwsh 7.6.5 produce identical output for this corpus;
    verified by running the same script in the pwsh-linux:7.6.5 container and
    diffing. The fixture therefore records no platform.
#>

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$corpusPath = Join-Path $root 'tests/unit/fixtures/lexer-corpus.json'
$outPath = Join-Path $root 'tests/unit/fixtures/lexer-pwsh-7.6.5.json'

$corpus = Get-Content -LiteralPath $corpusPath -Raw | ConvertFrom-Json

$cases = New-Object System.Collections.ArrayList
foreach ($source in $corpus) {
  $tokens = $null
  $errors = $null
  $null = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)

  $tokenList = New-Object System.Collections.ArrayList
  foreach ($t in $tokens) {
    if ($t.Kind.ToString() -eq 'EndOfInput') { continue }
    $entry = [ordered]@{
      kind  = $t.Kind.ToString()
      text  = $t.Text
      start = $t.Extent.StartOffset
      end   = $t.Extent.EndOffset
    }
    if ($t -is [System.Management.Automation.Language.StringToken]) { $entry['value'] = $t.Value }
    [void] $tokenList.Add($entry)
  }

  $errorList = New-Object System.Collections.ArrayList
  foreach ($e in $errors) { [void] $errorList.Add($e.ErrorId) }

  [void] $cases.Add([ordered]@{
    source = $source
    tokens = $tokenList
    errors = $errorList
  })
}

$document = [ordered]@{
  pwsh      = $PSVersionTable.PSVersion.ToString()
  capturedBy = 'tools/capture-lexer-fixtures.ps1'
  cases     = $cases
}

# -Depth 12 covers source/tokens/entry; ConvertTo-Json silently TRUNCATES past
# the default of 2, which would have made the fixture look empty rather than fail.
$json = $document | ConvertTo-Json -Depth 12
Set-Content -LiteralPath $outPath -Value $json -Encoding utf8NoBOM
"wrote $outPath ($($cases.Count) cases, pwsh $($PSVersionTable.PSVersion))"
