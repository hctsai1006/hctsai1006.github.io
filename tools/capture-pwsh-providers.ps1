<#
.SYNOPSIS
    Captures pwsh's own provider behaviour — drives, item shapes, child order,
    Clear-Item semantics, content and error records — so the provider tests can
    run with no pwsh and no network.

.DESCRIPTION
    Writes tests/unit/fixtures/providers-pwsh-7.6.5.json.

    EVERY NAME THIS TOUCHES IS SYNTHETIC AND PREFIXED `zz`. The fixture is
    committed and read by a hermetic test, so it must not contain one byte of
    this machine: no real environment variables, no user name, no paths. The
    only unsynthesised things recorded are the provider list and the drive
    roots, which are properties of pwsh rather than of the host.

    ONE FIELD IS PLATFORM-DEPENDENT, and it is recorded rather than hidden.
    MEASURED, pwsh 7.6.5, inside `Env:`:

        Windows  (Get-Location).Path  Env:\   Provider.ItemSeparator  \
        Linux    (Get-Location).Path  Env:/   Provider.ItemSeparator  /

    so `platform` and `itemSeparator` are both in the document, and the test
    asserts the RULE (`location == drive + ':' + itemSeparator`) rather than the
    literal string. The engine emulates Ubuntu, so its own answer is `Env:/`.
    Verified by running this same script in the pwsh-linux:7.6.5 container.

    The other Windows/Linux difference is the provider LIST: Windows has a
    Registry provider and Linux does not. The test therefore requires the five
    it models to be present, not that the lists are equal.

    Re-run after changing what the tests assert:
        npm run capture:providers

.NOTES
    Session state is scoped, and that bit us: wrapping `Clear-Item Variable:x`
    in a helper FUNCTION changed the answer, because the provider acted on the
    function's scope rather than the script's. Everything that touches
    Variable:, Function: and Alias: therefore runs at SCRIPT scope here, and the
    helpers below only read or format.

    Helper names avoid PowerShell's alias namespace on purpose: aliases resolve
    BEFORE functions, so a helper called `H` silently becomes `Get-History`.
#>

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$outPath = Join-Path $root 'tests/unit/fixtures/providers-pwsh-7.6.5.json'

# The four drives this engine models, plus FileSystem. Ordered so the fixture
# diffs cleanly.
$sessionDrives = @('Env', 'Variable', 'Function', 'Alias')

function Read-ErrorShape {
    param([scriptblock] $Body)
    try {
        & $Body | Out-Null
        return $null
    } catch {
        return [ordered]@{
            errorId       = $_.FullyQualifiedErrorId
            exceptionType = $_.Exception.GetType().FullName
            category      = $_.CategoryInfo.Category.ToString()
            message       = $_.Exception.Message
        }
    }
}

function Read-ItemShape {
    param([string] $Path)
    $item = Get-Item -LiteralPath $Path
    return [ordered]@{
        path          = $Path
        typeName      = $item.GetType().FullName
        psTypeNames   = @($item.PSObject.TypeNames)
        properties    = @($item.PSObject.Properties | ForEach-Object Name)
        psPath        = [string] $item.PSPath
        psDrive       = [string] $item.PSDrive
        psProvider    = [string] $item.PSProvider
        psIsContainer = [bool] $item.PSIsContainer
        name          = [string] $item.Name
    }
}

# ---------------------------------------------------------------------------
# providers and drives
# ---------------------------------------------------------------------------

$providers = New-Object System.Collections.ArrayList
foreach ($p in Get-PSProvider) {
    [void] $providers.Add([ordered]@{
        name          = $p.Name
        moduleName    = $p.ModuleName
        fullName      = "$($p.ModuleName)\$($p.Name)"
        # @(...) because ConvertTo-Json serialises a ONE-element pipeline result
        # as a bare string, and the test would then compare a string to an array.
        capabilities  = @(($p.Capabilities.ToString() -split ',\s*') | Where-Object { $_ -ne 'None' })
        itemSeparator = [string] $p.ItemSeparator
    })
}

$drives = New-Object System.Collections.ArrayList
foreach ($name in $sessionDrives) {
    $d = Get-PSDrive -Name $name
    [void] $drives.Add([ordered]@{
        name     = $d.Name
        root     = [string] $d.Root
        provider = [string] $d.Provider
    })
}

# ---------------------------------------------------------------------------
# item shapes
# ---------------------------------------------------------------------------

$env:zzItem = 'iv'
$zzItemV = 'vv'
function zzItemF { 'fb' }
Set-Alias zzItemA Get-Process

$items = New-Object System.Collections.ArrayList
foreach ($path in 'Env:zzItem', 'Variable:zzItemV', 'Function:zzItemF', 'Alias:zzItemA') {
    [void] $items.Add((Read-ItemShape $path))
}

# ---------------------------------------------------------------------------
# child order
# ---------------------------------------------------------------------------
#
# Inserted deliberately out of order, and with punctuation, because an ordinal
# sort survives an alphabetic-only probe and fails this one.

$orderNames = @('zzM', 'zzA', 'zzZ', 'zzB', 'zz_u', 'zz1', 'zz.d', 'zz-h', 'zz@a', 'zz#c')
foreach ($n in $orderNames) { Set-Item -Path "Env:$n" -Value 'x' }
foreach ($n in $orderNames) { Set-Item -Path "Variable:$n" -Value 'x' }
foreach ($n in $orderNames) { Set-Item -Path "Alias:$n" -Value 'Get-Process' }
foreach ($n in $orderNames) { Set-Item -Path "Function:$n" -Value 'x' }

$childOrder = [ordered]@{
    inserted = $orderNames
    Env      = @((Get-ChildItem Env: | Where-Object { $_.Name -like 'zz?' -or $_.Name -like 'zz[_.@#-]?' }).Name)
    Variable = @((Get-ChildItem Variable: | Where-Object { $_.Name -like 'zz?' -or $_.Name -like 'zz[_.@#-]?' }).Name)
    Alias    = @((Get-ChildItem Alias: | Where-Object { $_.Name -like 'zz?' -or $_.Name -like 'zz[_.@#-]?' }).Name)
    Function = @((Get-ChildItem Function: | Where-Object { $_.Name -like 'zz?' -or $_.Name -like 'zz[_.@#-]?' }).Name)
}

# ---------------------------------------------------------------------------
# Clear-Item / Set-Item null / Set-Item empty
# ---------------------------------------------------------------------------
#
# THE MEASUREMENT THAT LOOKS SELF-CONTRADICTORY UNTIL ALL FOUR ARE TAKEN:
# clearing an environment variable DELETES it, while setting it to the empty
# string does not. Both directions are recorded, for all four drives, because
# the rule underneath is "Clear-Item writes null" and only the answer to "what
# does null mean in this table" differs.

$env:zzClearE = 'x'
Clear-Item Env:zzClearE
$zzClearV = 'x'
Clear-Item Variable:zzClearV
function zzClearF { 'b' }
Clear-Item Function:zzClearF
Set-Alias zzClearA Get-Process
Clear-Item Alias:zzClearA

$env:zzEmptyE = 'x'
Set-Item Env:zzEmptyE -Value ''
$zzEmptyV = 'x'
Set-Item Variable:zzEmptyV -Value ''
function zzEmptyF { 'b' }
Set-Item Function:zzEmptyF -Value ''
Set-Alias zzEmptyA Get-Process
$zzEmptyAliasError = Read-ErrorShape { Set-Item Alias:zzEmptyA -Value '' }

$env:zzNullE = 'x'
$zzNullEError = Read-ErrorShape { Set-Item Env:zzNullE -Value $null }
$zzNullV = 'x'
Set-Item Variable:zzNullV -Value $null

$clearSemantics = [ordered]@{
    clearItem = [ordered]@{
        Env      = [ordered]@{ survives = (Test-Path Env:zzClearE); valueIsNull = $null }
        Variable = [ordered]@{ survives = (Test-Path Variable:zzClearV); valueIsNull = $null }
        Function = [ordered]@{ survives = (Test-Path Function:zzClearF); valueIsNull = $null }
        Alias    = [ordered]@{ survives = (Test-Path Alias:zzClearA); valueIsNull = $null }
    }
    setEmpty  = [ordered]@{
        Env      = [ordered]@{ survives = (Test-Path Env:zzEmptyE); error = $null }
        Variable = [ordered]@{ survives = (Test-Path Variable:zzEmptyV); error = $null }
        Function = [ordered]@{ survives = (Test-Path Function:zzEmptyF); error = $null }
        Alias    = [ordered]@{ survives = (Test-Path Alias:zzEmptyA); error = $zzEmptyAliasError }
    }
    setNull   = [ordered]@{
        Env      = [ordered]@{ survives = (Test-Path Env:zzNullE); error = $zzNullEError }
        Variable = [ordered]@{ survives = (Test-Path Variable:zzNullV); error = $null }
    }
}
if (Test-Path Variable:zzClearV) {
    $clearSemantics.clearItem.Variable.valueIsNull = ($null -eq (Get-Item Variable:zzClearV).Value)
}
if (Test-Path Env:zzEmptyE) {
    $clearSemantics.setEmpty.Env['valueLength'] = (Get-Item Env:zzEmptyE).Value.Length
}

# ---------------------------------------------------------------------------
# content
# ---------------------------------------------------------------------------
#
# All four support Get-Content, which is the opposite of the natural
# assumption; and content is NOT split into lines the way a file's is.

$env:zzContent = 'abc'
$zzContentV = 'defg'
function zzContentF { 'fb' }
Set-Alias zzContentA Get-Process
$env:zzMultiline = "a`nb"

$content = New-Object System.Collections.ArrayList
foreach ($path in 'Env:zzContent', 'Variable:zzContentV', 'Function:zzContentF', 'Alias:zzContentA', 'Env:zzMultiline') {
    $value = Get-Content -LiteralPath $path
    [void] $content.Add([ordered]@{
        path     = $path
        typeName = $(if ($null -eq $value) { $null } else { $value.GetType().FullName })
        count    = @($value).Count
        asString = [string] $value
    })
}
$contentOnRoot = Read-ErrorShape { Get-Content -LiteralPath 'Env:\' }

# ---------------------------------------------------------------------------
# errors
# ---------------------------------------------------------------------------
#
# THE PATH IN THE MESSAGE IS NOT THE SAME PATH IN EVERY COMMAND. Get-ChildItem
# echoes the PROVIDER-INTERNAL path with no drive at all; Get-Item and
# Get-Content echo the drive-qualified one; Set-Location echoes what was TYPED.
# One shared "which path do we print" answer would be wrong for two of them.

$env:zzLeaf = 'lv'
$errors = [ordered]@{
    getChildItemMissing   = Read-ErrorShape { Get-ChildItem Env:zzNoSuch -ErrorAction Stop }
    getItemMissing        = Read-ErrorShape { Get-Item Env:zzNoSuch -ErrorAction Stop }
    getContentMissing     = Read-ErrorShape { Get-Content Env:zzNoSuch -ErrorAction Stop }
    getItemUnknownDrive   = Read-ErrorShape { Get-Item zzNoDrive:\x -ErrorAction Stop }
    setLocationUnknown    = Read-ErrorShape { Set-Location zzNoDrive: -ErrorAction Stop }
    setLocationLeafTyped  = Read-ErrorShape { Set-Location Env:zzLeaf -ErrorAction Stop }
    getChildItemBelowLeaf = Read-ErrorShape { Get-ChildItem Env:zzLeaf/more -ErrorAction Stop }
    getItemMissingVar     = Read-ErrorShape { Get-Item Variable:zzNoSuch -ErrorAction Stop }
    getItemMissingFn      = Read-ErrorShape { Get-Item Function:zzNoSuch -ErrorAction Stop }
    getItemMissingAlias   = Read-ErrorShape { Get-Item Alias:zzNoSuch -ErrorAction Stop }
    filterOnFlatProvider  = Read-ErrorShape { Get-ChildItem Env: -Filter 'zz*' -ErrorAction Stop }
}

# ---------------------------------------------------------------------------
# Test-Path
# ---------------------------------------------------------------------------

$env:zzTp = 'tv'
$testPath = New-Object System.Collections.ArrayList
foreach ($case in @(
        @{ path = 'Env:'; type = 'Any' }
        @{ path = 'Env:\'; type = 'Any' }
        @{ path = 'Env:/'; type = 'Any' }
        @{ path = 'Env:zzTp'; type = 'Any' }
        @{ path = 'Env:\zzTp'; type = 'Any' }
        @{ path = 'Env:/zzTp'; type = 'Any' }
        @{ path = 'Env:ZZTP'; type = 'Any' }
        @{ path = 'env:zzTp'; type = 'Any' }
        @{ path = 'Env:zzNoSuch'; type = 'Any' }
        @{ path = 'Env:zzTp/more'; type = 'Any' }
        @{ path = 'zzNoDrive:\x'; type = 'Any' }
        @{ path = 'Env:'; type = 'Container' }
        @{ path = 'Env:zzTp'; type = 'Container' }
        @{ path = 'Env:zzTp'; type = 'Leaf' }
        @{ path = 'Env:'; type = 'Leaf' }
    )) {
    $result = if ($case.type -eq 'Any') {
        Test-Path -Path $case.path
    } else {
        Test-Path -Path $case.path -PathType $case.type
    }
    [void] $testPath.Add([ordered]@{ path = $case.path; pathType = $case.type; result = [bool] $result })
}

# ---------------------------------------------------------------------------
# location, and what a flat drive does with -Recurse / wildcards
# ---------------------------------------------------------------------------

$before = (Get-Location).Path
Set-Location Env:
$here = Get-Location
$location = [ordered]@{
    path            = $here.Path
    driveName       = $here.Drive.Name
    driveRoot       = [string] $here.Drive.Root
    providerName    = $here.Provider.Name
    providerPath    = [string] $here.ProviderPath
    itemSeparator   = [string] $here.Provider.ItemSeparator
    providerHome    = [string] $here.Provider.Home
    parentListingOk = $null -ne (Get-ChildItem .. -ErrorAction SilentlyContinue)
}
# The two counts themselves are the host's environment and must not reach the
# fixture; only whether they AGREE is a fact about the provider.
$plainCount = @(Get-ChildItem).Count
$recurseCount = @(Get-ChildItem -Recurse).Count
Set-Location $before

$flat = [ordered]@{
    recurseIsNoOp     = ($plainCount -eq $recurseCount)
    literalLeafCount  = @(Get-ChildItem -LiteralPath Env:zzTp).Count
    wildcardItemCount = @(Get-Item 'Env:zzTp*').Count
    literalWildcard   = Read-ErrorShape { Get-Item -LiteralPath 'Env:zzTp*' -ErrorAction Stop }
    includeIsInert    = @(Get-ChildItem Env: -Include 'zzTp*').Count
    nameOnlyIsString  = (Get-ChildItem Env: -Name | Select-Object -First 1).GetType().FullName
}

# ---------------------------------------------------------------------------
# dynamic parameters
# ---------------------------------------------------------------------------
#
# Half of what `Get-Content` and `Get-ChildItem` accept is supplied by the
# FILESYSTEM provider, not by the cmdlet, so on a flat drive those parameters do
# not exist. This binder is static and binds them anyway, so each refusal has to
# be reproduced in the command — and there are THREE different refusals, not
# one: NamedParameterNotFound for a parameter that is not there at all,
# NotSupported for a capability the provider lacks, and TailNotSupported, which
# is its own id.

$env:zzDyn = 'abc'
$dynamic = [ordered]@{ getContent = [ordered]@{}; getChildItem = [ordered]@{} }

foreach ($case in @(
        @{ name = 'Raw'; splat = @{ Raw = $true } }
        @{ name = 'AsByteStream'; splat = @{ AsByteStream = $true } }
        @{ name = 'Delimiter'; splat = @{ Delimiter = ',' } }
        @{ name = 'Encoding'; splat = @{ Encoding = 'utf8' } }
        @{ name = 'Wait'; splat = @{ Wait = $true } }
        @{ name = 'ReadCount'; splat = @{ ReadCount = 1 } }
        @{ name = 'TotalCount'; splat = @{ TotalCount = 1 } }
        @{ name = 'Tail'; splat = @{ Tail = 1 } }
        @{ name = 'Filter'; splat = @{ Filter = 'zz*' } }
        @{ name = 'Include'; splat = @{ Include = 'zz*' } }
        @{ name = 'Exclude'; splat = @{ Exclude = 'nope*' } }
        @{ name = 'Force'; splat = @{ Force = $true } }
    )) {
    $splat = $case.splat.Clone()
    $splat['LiteralPath'] = 'Env:zzDyn'
    $splat['ErrorAction'] = 'Stop'
    $dynamic.getContent[$case.name] = Read-ErrorShape { Get-Content @splat }
}

foreach ($case in @(
        @{ name = 'Filter'; splat = @{ Filter = 'zz*' } }
        @{ name = 'Include'; splat = @{ Include = 'zz*' } }
        @{ name = 'Exclude'; splat = @{ Exclude = 'nope*' } }
        @{ name = 'Force'; splat = @{ Force = $true } }
        @{ name = 'Recurse'; splat = @{ Recurse = $true } }
        @{ name = 'Depth'; splat = @{ Depth = 1 } }
        @{ name = 'File'; splat = @{ File = $true } }
        @{ name = 'Directory'; splat = @{ Directory = $true } }
        @{ name = 'Hidden'; splat = @{ Hidden = $true } }
        @{ name = 'Name'; splat = @{ Name = $true } }
        @{ name = 'Attributes'; splat = @{ Attributes = 'Archive' } }
    )) {
    $splat = $case.splat.Clone()
    $splat['Path'] = 'Env:'
    $splat['ErrorAction'] = 'Stop'
    $dynamic.getChildItem[$case.name] = Read-ErrorShape { Get-ChildItem @splat }
}

$dynamic['testPath'] = [ordered]@{}
foreach ($case in @(
        @{ name = 'Filter'; splat = @{ Filter = 'zz*' } }
        @{ name = 'Include'; splat = @{ Include = 'zz*' } }
        @{ name = 'Exclude'; splat = @{ Exclude = 'nope*' } }
        @{ name = 'Force'; splat = @{ Force = $true } }
        @{ name = 'IsValid'; splat = @{ IsValid = $true } }
        @{ name = 'NewerThan'; splat = @{ NewerThan = ([datetime]'2000-01-01') } }
        @{ name = 'OlderThan'; splat = @{ OlderThan = ([datetime]'2100-01-01') } }
    )) {
    $splat = $case.splat.Clone()
    $splat['Path'] = 'Env:zzDyn'
    $splat['ErrorAction'] = 'Stop'
    $dynamic.testPath[$case.name] = Read-ErrorShape { Test-Path @splat }
}

# ---------------------------------------------------------------------------
# a dot-named item is NOT hidden on a flat provider
# ---------------------------------------------------------------------------
#
# The leading-dot rule is the FILESYSTEM provider's and nothing else's. Applying
# it to `Env:` would make a dot-named environment variable invisible without
# -Force, which is not what pwsh does — and is exactly the bug an adversarial
# pass found in the first version of the flat listing.

Set-Item -Path 'Env:.zzDot' -Value 'v'
$hiddenRule = [ordered]@{
    plainCount = @(Get-ChildItem Env: | Where-Object { $_.Name -like '.zz*' }).Count
    forceCount = @(Get-ChildItem Env: -Force | Where-Object { $_.Name -like '.zz*' }).Count
}

# ---------------------------------------------------------------------------
# the path seam
# ---------------------------------------------------------------------------
#
# `Split-Path 'Env:\PATH' -Parent` is the EMPTY STRING, not 'Env:\'. Reasoning
# would have produced the drive root; a flat provider has no parent path at all,
# which is the same fact that leaves `PSParentPath` off a Get-ChildItem Env: row.

$pathSeam = [ordered]@{
    splitParentLeaf   = [string] (Split-Path 'Env:\zzTp' -Parent)
    splitParentRoot   = [string] (Split-Path 'Env:\' -Parent)
    splitLeafOfLeaf   = [string] (Split-Path 'Env:\zzTp' -Leaf)
    joinDriveAndChild = [string] (Join-Path 'Env:' 'zzTp')
    joinRootAndChild  = [string] (Join-Path 'Env:\' 'zzTp')
    resolveBare       = [string] ((Resolve-Path 'Env:zzTp').Path)
    resolveSlash      = [string] ((Resolve-Path 'Env:/zzTp').Path)
}

# ---------------------------------------------------------------------------
# refusing a capability the provider does not implement
# ---------------------------------------------------------------------------
#
# The shape a provider layer must be ABLE to produce, even when nothing in this
# engine produces it yet: an unimplemented interface is `NotSupported` NAMING
# the interface, never PathNotFound. Only the Registry provider can demonstrate
# it, and only Windows has one, so this is null on Linux rather than faked.

$capabilityRefusal = $null
if ($null -ne (Get-PSProvider -PSProvider Registry -ErrorAction SilentlyContinue)) {
    $capabilityRefusal = [ordered]@{
        probe = 'Get-Content HKCU:\Software'
        shape = Read-ErrorShape { Get-Content 'HKCU:\Software' -ErrorAction Stop }
    }
}

# ---------------------------------------------------------------------------
# New-Item
# ---------------------------------------------------------------------------

$newItem = New-Object System.Collections.ArrayList
foreach ($case in @(
        @{ path = 'Env:zzNewE'; value = 'nv' }
        @{ path = 'Variable:zzNewV'; value = 'nv' }
        @{ path = 'Alias:zzNewA'; value = 'Get-Process' }
        @{ path = 'Function:zzNewF'; value = 'Write-Output hi' }
    )) {
    $made = New-Item -Path $case.path -Value $case.value
    [void] $newItem.Add([ordered]@{
        path     = $case.path
        typeName = $made.GetType().FullName
        exists   = (Test-Path $case.path)
    })
}
$newItemExisting = Read-ErrorShape { New-Item -Path 'Env:zzNewE' -Value 'again' -ErrorAction Stop }

# ---------------------------------------------------------------------------
# write it out
# ---------------------------------------------------------------------------

$document = [ordered]@{
    pwsh            = $PSVersionTable.PSVersion.ToString()
    platform        = $PSVersionTable.Platform
    capturedBy      = 'tools/capture-pwsh-providers.ps1'
    providers       = $providers
    drives          = $drives
    items           = $items
    childOrder      = $childOrder
    clearSemantics  = $clearSemantics
    content         = $content
    contentOnRoot   = $contentOnRoot
    errors          = $errors
    testPath        = $testPath
    location        = $location
    flat            = $flat
    dynamic         = $dynamic
    hiddenRule      = $hiddenRule
    pathSeam        = $pathSeam
    capabilityRefusal = $capabilityRefusal
    newItem         = $newItem
    newItemExisting = $newItemExisting
}

# -Depth 12 covers providers/items/properties. ConvertTo-Json silently TRUNCATES
# past the default of 2, which would make the fixture look empty rather than fail.
$json = $document | ConvertTo-Json -Depth 12

# LF, EXPLICITLY, and not Set-Content's platform default. .gitattributes pins
# every text file in this repository to `eol=lf` because generated files are
# compared byte for byte; Set-Content on Windows writes CRLF, so re-running this
# on Windows would leave the fixture permanently "modified" against a tree that
# checks out LF. -NoNewline plus an appended "`n" is what makes a re-run a no-op
# on both platforms.
$json = $json.Replace("`r`n", "`n")
Set-Content -LiteralPath $outPath -Value ($json + "`n") -Encoding utf8NoBOM -NoNewline
"wrote $outPath (pwsh $($PSVersionTable.PSVersion) on $($PSVersionTable.Platform))"
