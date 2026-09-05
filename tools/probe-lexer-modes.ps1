<#
.SYNOPSIS
    Measures pwsh's command-mode vs expression-mode lexing, `--%` scope, and the
    real AST node vocabulary.

.DESCRIPTION
    probe-lexer.ps1 showed that the same characters lex DIFFERENTLY depending on
    position: `--path="a b"` is one Generic argument after a command name, while
    `--Path` at the start of a statement is MinusMinus + Identifier with two
    errors. A single-mode lexer cannot reproduce that, and every one of the four
    tokenizers this replaces was single-mode.

    Section 3 enumerates every concrete Ast subclass in the parser's assembly.
    Task 3 must refuse recognised-but-unimplemented syntax by NAME, and inventing
    names would mean the error text does not match anything a user could look up.

.EXAMPLE
    pwsh -NoProfile -File tools/probe-lexer-modes.ps1 > probe-modes.json
#>

$ErrorActionPreference = 'Stop'

function Get-Lex {
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

# --- 1. the SAME text in command position and in expression position --------
# Each pair is (bare statement, same text as an argument to a command).
$modePairs = @(
  '--Path',            'Get-Item --Path'
  '-Path',             'Get-Item -Path'
  'a.b',               'Get-Item a.b'
  '1+1',               'Get-Item 1+1'
  'a-b',               'Get-Item a-b'
  '3',                 'Get-Item 3'
  'a*b',               'Get-Item a*b'
  '{1}',               'Get-Item {1}'
  'a=b',               'Get-Item a=b'
  'C:\path\to',        'Get-Item C:\path\to'
  '/usr/bin',          'Get-Item /usr/bin'
  'a;b',               'Get-Item a;b'
  '@x',                'Get-Item @x'
  'a:b',               'Get-Item a:b'
  '!x',                'Get-Item !x'
  '2+2',               'Write-Output 2+2'
)
$modes = New-Object System.Collections.ArrayList
foreach ($m in $modePairs) { [void] $modes.Add((Get-Lex $m)) }

# --- 2. how far does --% actually reach? ------------------------------------
$stopParsing = New-Object System.Collections.ArrayList
foreach ($s in @(
  'cmd --% a b c'
  'cmd --% a | b'
  'cmd --% a ; b'
  'cmd --% a && b'
  "cmd --% a`nb"
  'cmd --% "quoted $x"'
  'cmd --% a > out.txt'
  'echo --% $x'
  'cmd arg --% rest here'
  '--% leading'
)) { [void] $stopParsing.Add((Get-Lex $s)) }

# --- 3. every concrete Ast subclass the real parser can produce -------------
$astBase = [System.Management.Automation.Language.Ast]
$astTypes = $astBase.Assembly.GetTypes() |
  Where-Object { $_.IsSubclassOf($astBase) -and -not $_.IsAbstract -and $_.IsPublic } |
  ForEach-Object { $_.Name } |
  Sort-Object

# --- 4. every TokenKind the real lexer can emit -----------------------------
$tokenKinds = [enum]::GetNames([System.Management.Automation.Language.TokenKind]) | Sort-Object

# --- 5. redirection: which forms does 7.6.5 actually accept? ----------------
$redir = New-Object System.Collections.ArrayList
foreach ($s in @(
  'x > f'; 'x >> f'; 'x 1> f'; 'x 2> f'; 'x 3> f'; 'x 4> f'; 'x 5> f'; 'x 6> f'
  'x *> f'; 'x 2>&1'; 'x 3>&1'; 'x 4>&1'; 'x 5>&1'; 'x 6>&1'; 'x *>&1'
  'x 1>&2'; 'x 2>&3'; 'x 1>&1'; 'x < f'; 'x 7> f'; 'x 2>> f'
)) { [void] $redir.Add((Get-Lex $s)) }

# --- 6. splatting vs array literal vs here-string opener --------------------
$at = New-Object System.Collections.ArrayList
foreach ($s in @(
  'f @a'; 'f @a.b'; 'f @(1)'; 'f @{}'; '$x = @a'; 'f a@b'; 'f @'
)) { [void] $at.Add((Get-Lex $s)) }

[ordered]@{
  pwsh        = $PSVersionTable.PSVersion.ToString()
  modes       = $modes
  stopParsing = $stopParsing
  astTypes    = $astTypes
  tokenKinds  = $tokenKinds
  redirection = $redir
  atSign      = $at
} | ConvertTo-Json -Depth 12
