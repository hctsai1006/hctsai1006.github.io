#requires -Version 7.0
<#
.SYNOPSIS
    Capture real parameter metadata from an installed PowerShell, as ground truth
    for BrowserShell's command manifests.

.DESCRIPTION
    The single-file terminal this project replaces declared parameters as a flat
    array of strings:

        params: ['-Path','-Value']

    That is a guess about a real API. It carries no types, no positions, no
    parameter sets, no validation attributes, and no pipeline binding — so the
    emulator cannot be checked against anything, and every divergence from real
    PowerShell is invisible until a user hits it.

    This script asks the reference implementation instead. It reflects over
    Get-Command and writes the actual metadata: parameter types, aliases,
    positions, mandatory-ness, parameter sets, pipeline binding, and validation
    attributes. Manifests are then derived from this rather than written by hand,
    and a conformance test can prove the derivation is faithful.

    Two things are deliberately preserved that a naive capture loses:

      * Parameter SETS. Whether -Path and -LiteralPath are mutually exclusive is
        a fact about the command, and the binder cannot be correct without it.

      * Validation ATTRIBUTES. A whole class of PowerShell 7.7 breaking changes
        is precisely "a ValidateNotNullOrEmpty was added here", which is
        invisible unless attributes are captured per version.

    Common parameters (Verbose, Debug, ErrorAction, ...) are captured but flagged,
    because they are contributed by the engine rather than declared by the command
    and should not be duplicated into every manifest.

.PARAMETER OutFile
    Where to write the JSON. Defaults to a path derived from the running version,
    so captures from different PowerShell versions never overwrite each other.

.PARAMETER Name
    Command names to capture. Defaults to the set the site implements.

.EXAMPLE
    pwsh -NoProfile -File tools/capture-pwsh-metadata.ps1

.NOTES
    Run this with the PowerShell version you want to describe. It records
    $PSVersionTable so a capture can never be silently attributed to the wrong
    version — the file states which engine produced it.
#>
[CmdletBinding()]
param(
    [string] $OutFile,
    [string[]] $Name
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# The PowerShell cmdlets the browser terminal implements or intends to. Native
# Unix commands (ls, grep, chmod...) are deliberately absent: they have no
# PowerShell metadata to reflect over, and their conformance story is different.
$DefaultCommands = @(
    'Add-Content'
    'ConvertTo-Json'
    'Copy-Item'
    'Get-ChildItem'
    'Get-Command'
    'Get-Content'
    'Get-Date'
    'Get-Help'
    'Get-History'
    'Get-Item'
    'Get-Location'
    'Get-Member'
    'Get-Process'
    'Get-Random'
    'Group-Object'
    'Join-Path'
    'Measure-Object'
    'Move-Item'
    'New-Guid'
    'New-Item'
    'Out-Null'
    'Remove-Item'
    'Rename-Item'
    'Select-Object'
    'Select-String'
    'Set-Content'
    'Set-Location'
    'Sort-Object'
    'Split-Path'
    'Test-Connection'
    'Test-Path'
    'Where-Object'
    'Write-Output'
    'Format-Table'
    'Format-List'
    'Format-Custom'
    'ConvertFrom-Csv'
    'ConvertTo-Csv'
    'Export-Csv'
    'Import-Csv'
    'Get-Uptime'
    'Get-SecureRandom'
    'Get-TimeZone'
)

if (-not $Name -or $Name.Count -eq 0) { $Name = $DefaultCommands }

$psVersion = $PSVersionTable.PSVersion.ToString()

if (-not $OutFile) {
    $repo = Split-Path -Parent $PSScriptRoot
    $dir = Join-Path $repo 'compat/upstream' | Join-Path -ChildPath "v$psVersion"
    $null = New-Item -ItemType Directory -Force -Path $dir
    $OutFile = Join-Path $dir 'command-metadata.json'
}

# Contributed by the engine to every advanced cmdlet, not declared by the command.
$commonParameters = [System.Management.Automation.PSCmdlet]::CommonParameters +
                    [System.Management.Automation.PSCmdlet]::OptionalCommonParameters

function Get-AttributeDetail {
    <#
        Validation attributes are the point of this capture, so record their
        arguments too: "ValidateSet" alone is useless, "ValidateSet(a,b,c)" is
        checkable. Anything without a known shape is recorded by type name so a
        newly-introduced attribute is visible rather than dropped.
    #>
    param([System.Attribute] $Attribute)

    $detail = [ordered]@{ type = $Attribute.GetType().Name }

    switch ($Attribute) {
        { $_ -is [System.Management.Automation.ValidateSetAttribute] } {
            $detail['values'] = @($_.ValidValues)
        }
        { $_ -is [System.Management.Automation.ValidateRangeAttribute] } {
            # MinRange/MaxRange are null when the attribute uses a RangeKind.
            if ($null -ne $_.MinRange) { $detail['min'] = [string] $_.MinRange }
            if ($null -ne $_.MaxRange) { $detail['max'] = [string] $_.MaxRange }
        }
        { $_ -is [System.Management.Automation.ValidateLengthAttribute] } {
            $detail['minLength'] = $_.MinLength
            $detail['maxLength'] = $_.MaxLength
        }
        { $_ -is [System.Management.Automation.ValidateCountAttribute] } {
            $detail['minCount'] = $_.MinLength
            $detail['maxCount'] = $_.MaxLength
        }
        { $_ -is [System.Management.Automation.ValidatePatternAttribute] } {
            $detail['pattern'] = $_.RegexPattern
        }
        { $_ -is [System.Management.Automation.ValidateScriptAttribute] } {
            $detail['script'] = $_.ScriptBlock.ToString()
        }
        { $_ -is [System.Management.Automation.AliasAttribute] } {
            $detail['aliases'] = @($_.AliasNames)
        }
    }

    return $detail
}

$commands = [ordered]@{}
$commonParameterDetail = [ordered]@{}
$commonParameterNames = [System.Collections.Generic.HashSet[string]]::new()
$missing = @()
# Accumulated in the loop. Chained access like $entry.parameters.Count is
# ambiguous on OrderedDictionary: the adapter resolves property access as a key
# lookup first, so it does not reliably yield the element count.
$parameterCount = 0

foreach ($commandName in ($Name | Sort-Object -Unique)) {
    $cmd = Get-Command -Name $commandName -ErrorAction SilentlyContinue
    if (-not $cmd) {
        # Recorded, never silently skipped: a command absent from this engine is
        # a fact about the version, and the manifest must not claim it exists.
        $missing += $commandName
        continue
    }

    # Resolve aliases to the real command so metadata is never captured twice
    # under two names.
    while ($cmd.CommandType -eq 'Alias' -and $cmd.ResolvedCommand) {
        $cmd = $cmd.ResolvedCommand
    }

    $parameters = [ordered]@{}
    foreach ($key in ($cmd.Parameters.Keys | Sort-Object)) {
        $p = $cmd.Parameters[$key]

        # Common parameters are contributed by the engine to every advanced
        # cmdlet, so repeating them per command is 43 identical copies of the
        # same fact. Recorded once at the top level instead; a command's
        # `hasCommonParameters` says whether they apply to it.
        $isCommon = $commonParameters -contains $p.Name
        if ($isCommon -and $commonParameterNames.Contains($p.Name)) { continue }

        $sets = [ordered]@{}
        foreach ($setName in ($p.ParameterSets.Keys | Sort-Object)) {
            $set = $p.ParameterSets[$setName]
            # PowerShell uses Int32.MinValue as the "not positional" sentinel.
            # Leaking that into the data would make every consumer reimplement
            # the same magic-number check, and one of them would forget.
            $position = if ($set.Position -eq [int]::MinValue) { $null } else { $set.Position }

            $sets[$setName] = [ordered]@{
                position                        = $position
                isMandatory                     = $set.IsMandatory
                valueFromPipeline               = $set.ValueFromPipeline
                valueFromPipelineByPropertyName = $set.ValueFromPipelineByPropertyName
                valueFromRemainingArguments     = $set.ValueFromRemainingArguments
            }
        }

        $attributes = @(
            foreach ($a in $p.Attributes) {
                # ParameterAttribute is already represented by the parameter-set
                # detail above; repeating it adds noise without information.
                if ($a -is [System.Management.Automation.ParameterAttribute]) { continue }
                Get-AttributeDetail -Attribute $a
            }
        )

        $entry = [ordered]@{
            type      = $p.ParameterType.FullName
            # A switch is not a boolean: -Switch and -Switch:$false differ, and
            # a class of 7.7 fixes is exactly that distinction.
            isSwitch  = $p.SwitchParameter
            aliases   = @($p.Aliases)
            sets      = $sets
            attributes = $attributes
        }

        if ($isCommon) {
            $null = $commonParameterNames.Add($p.Name)
            $commonParameterDetail[$p.Name] = $entry
        } else {
            $parameters[$p.Name] = $entry
        }
    }

    $parameterCount += @($parameters.Keys).Count

    $parameterSets = @(
        foreach ($set in $cmd.ParameterSets) {
            [ordered]@{
                name      = $set.Name
                isDefault = $set.IsDefault
            }
        }
    )

    $commands[$cmd.Name] = [ordered]@{
        name                 = $cmd.Name
        hasCommonParameters  = ($cmd.Parameters.Keys | Where-Object { $commonParameters -contains $_ }).Count -gt 0
        commandType          = [string] $cmd.CommandType
        module               = if ($cmd.ModuleName) { $cmd.ModuleName } else { $null }
        defaultParameterSet  = $cmd.DefaultParameterSet
        supportsShouldProcess = [bool] ($cmd.Parameters.ContainsKey('WhatIf'))
        outputType           = @($cmd.OutputType | ForEach-Object { $_.Name })
        parameterSets        = $parameterSets
        parameters           = $parameters
    }
}

$document = [ordered]@{
    '$comment'  = 'Generated by tools/capture-pwsh-metadata.ps1 from a real PowerShell. Do not hand-edit.'
    schemaVersion = 1
    capturedAt  = (Get-Date).ToUniversalTime().ToString('o')
    engine      = [ordered]@{
        psVersion   = $psVersion
        psEdition   = $PSVersionTable.PSEdition
        gitCommitId = $PSVersionTable.GitCommitId
        os          = $PSVersionTable.OS
        platform    = $PSVersionTable.Platform
        framework   = [System.Runtime.InteropServices.RuntimeInformation]::FrameworkDescription
    }
    commonParameters = $commonParameterDetail
    requested   = @($Name | Sort-Object -Unique)
    missing     = @($missing)
    commands    = $commands
}

# Depth matters: parameter sets nest several levels and ConvertTo-Json silently
# truncates past its default depth of 2, which would produce a file that looks
# complete and is not.
$json = $document | ConvertTo-Json -Depth 12
Set-Content -Path $OutFile -Value $json -Encoding utf8NoBOM

Write-Host ''
Write-Host "  PowerShell $psVersion on $([System.Runtime.InteropServices.RuntimeInformation]::FrameworkDescription)"
Write-Host "  captured $($commands.Count) commands, $parameterCount parameters"
if ($missing.Count -gt 0) {
    Write-Host "  not present in this engine: $($missing -join ', ')"
}
Write-Host "  wrote $OutFile"
Write-Host ''
