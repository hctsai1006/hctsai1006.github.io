#requires -Version 7.0
<#
.SYNOPSIS
    Capture real CultureInfo number and date data from an installed PowerShell,
    as ground truth for src/formatting/culture.ts.

.DESCRIPTION
    src/formatting/culture.ts used to be four hand-transcribed tables, justified
    by a claim that .NET and `Intl` disagree about zh-TW's NumberDecimalDigits
    (2 versus 3). They do not — both say 3 — and the transcription had at least
    nine values wrong, including every zh-TW date pattern. Nine wrong values is
    not a typo count, it is what transcription costs.

    So the data is captured instead. The difference that matters is not accuracy
    on the day it is written: it is that a capture can be RE-RUN and diffed,
    while a transcription can only be re-read by the person who already believed
    it.

    Three kinds of thing are recorded per culture:

      * numberFormat — every NumberFormatInfo field the formatter reads, plus
        the ones it does not yet read, because a field that is absent from the
        capture is a field the next question cannot be answered from.

      * dateTimeFormat — the name arrays and the pattern properties, AND the
        standard-specifier table as `GetAllDateTimePatterns(<letter>)[0]`. That
        table is the answer to "what does `'{0:d}' -f $date` do", which is not
        the day number: it is the culture's short date pattern.

      * samples — the reference implementation's own output for a corpus of
        values and formats. These exist so a test can assert against a
        MEASUREMENT rather than against a belief about one, and so the engine
        can be checked end to end instead of field by field.

    CultureInfo is constructed with useUserOverride = $false. With the default
    ($true) the machine's regional settings leak into the capture, which would
    make the file describe the capture host rather than the culture.

    TWO files are written, and the split is deliberate. `culture-metadata` holds
    the CultureInfo fields and is imported by src/formatting/culture.ts, so it
    ships in the bundle; `culture-samples` holds the reference outputs and is
    imported only by the tests. Putting the corpus in the shipped file would put
    a few hundred kilobytes of test data in the browser, and would make every
    `tsc` widen a literal type over three thousand strings nothing in src reads.

.PARAMETER OutFile
    Where to write the CultureInfo JSON. Defaults to a path naming both the
    PowerShell version and the OS platform, because the two do not always agree
    — see the divergence note in the generated file's $comment. The samples file
    is written beside it under the matching name.

.PARAMETER CultureName
    Cultures to capture. Defaults to the three the conformance capture uses.

.EXAMPLE
    pwsh -NoProfile -File tools/capture-pwsh-culture.ps1

.EXAMPLE
    docker run --rm -v "$PWD:/repo" pwsh-linux:7.6.5 -File /repo/tools/capture-pwsh-culture.ps1

.NOTES
    The compatibility profiles this project publishes target
    powershell-7.6.5-LINUX, so the Linux capture is the one culture.ts reads.
    Run it on Windows too and diff: where the two platforms disagree, the file
    that ships must be the Linux one.
#>
[CmdletBinding()]
param(
    [string] $OutFile,
    [string[]] $CultureName
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# en-US is the pinned culture of the conformance capture, de-DE the stress
# culture (it swaps BOTH separators), zh-TW the host culture of the machine the
# fixtures were taken on. The invariant culture is added unconditionally below:
# it is not a locale and must not be requested by name.
$DefaultCultures = @('en-US', 'de-DE', 'zh-TW')
if (-not $CultureName -or $CultureName.Count -eq 0) { $CultureName = $DefaultCultures }

$psVersion = $PSVersionTable.PSVersion.ToString()

$platform =
    if ([System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Linux)) { 'linux' }
    elseif ([System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows)) { 'windows' }
    elseif ([System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::OSX)) { 'macos' }
    else { 'unknown' }

if (-not $OutFile) {
    $repo = Split-Path -Parent $PSScriptRoot
    $dir = Join-Path $repo 'compat/upstream' | Join-Path -ChildPath "v$psVersion"
    $null = New-Item -ItemType Directory -Force -Path $dir
    $OutFile = Join-Path $dir "culture-metadata-$platform.json"
}
$SamplesFile = Join-Path (Split-Path -Parent $OutFile) "culture-samples-$platform.json"

# ---------------------------------------------------------------------------
# the corpus
# ---------------------------------------------------------------------------

# Doubles chosen for what they discriminate, not for coverage: the exact ties
# (0.125, 2.5), the near-ties that only look exact (0.135, 1.005, 2.675), the
# four thresholds where .NET's `G` switches to exponential (1e-4/1e-5 and
# 1e16/1e17), the two the shortest-round-trip form is famous for (0.1+0.2, 1/3),
# and negative zero, which is `-0` in pwsh and `0` in every naive port.
$NumberCorpus = [ordered]@{
    '1234.5'      = 1234.5
    '-1234.5'     = -1234.5
    '0.125'       = 0.125
    '0.135'       = 0.135
    '2.5'         = 2.5
    '3.5'         = 3.5
    '1.005'       = 1.005
    '2.675'       = 2.675
    '-0.001'      = -0.001
    '0'           = [double] 0
    'negzero'     = [double]::NegativeZero
    '0.0001'      = 0.0001
    '0.00001'     = 0.00001
    '0.000001'    = 0.000001
    '1e15'        = 1e15
    '1e16'        = 1e16
    '1e17'        = 1e17
    '1e21'        = 1e21
    'onethird'    = 1 / 3
    'pointthree'  = 0.1 + 0.2
    '1.5'         = 1.5
    '0.5'         = 0.5
    '0.1234'      = 0.1234
    '1234567.891' = 1234567.891
    'nan'         = [double]::NaN
    'inf'         = [double]::PositiveInfinity
    'neginf'      = [double]::NegativeInfinity
}

# Every specifier src/formatting/numeric.ts implements, plus the custom shapes
# its docstring claims. A specifier that throws is recorded as an error rather
# than skipped: "this throws" is as much a measurement as "this prints 1.50".
$NumberFormats = @(
    ''
    'N'; 'N0'; 'N2'
    'F'; 'F2'; 'F3'
    'C'; 'C0'; 'C2'
    'P'; 'P1'; 'P2'
    'G'; 'G15'; 'G17'
    'E'; 'E2'; 'e2'
    'R'
    '#,##0.00'; '0.##'; '000.0'; '#,#'; '0000'; '#.###'; '#.00'
    '0.0;(0.0)'; '0.0%'; '#.##%'; '0 units'; 'ZZZ'
)

# Integers, for the specifiers that refuse a fractional value.
$IntegerCorpus = [ordered]@{
    '42'      = 42
    '-42'     = -42
    '255'     = 255
    '-1'      = -1
    '1234567' = 1234567
    'int64-1' = [int64] -1
}
$IntegerFormats = @('D'; 'D5'; 'X'; 'X4'; 'x4'; 'N'; 'N0'; '')

# Four instants, each carrying something the others cannot show:
#   afternoon  a PM value, so `tt`, `h` and `H` disagree
#   morning    sub-millisecond ticks (0.0089), so `FFF` and `fffffff` differ
#   sunday     midnight on a Sunday: `h` is 12, and %u/%w disagree there
#   endofyear  the maximum fraction, 0.9999999
$DateCorpus = [ordered]@{
    afternoon = [datetime]::new(2020, 3, 4, 15, 6, 7, 89)
    morning   = [datetime]::new(2026, 3, 4, 5, 6, 7).AddTicks(89000)
    sunday    = [datetime]::new(2020, 1, 5, 0, 0, 0)
    endofyear = [datetime]::new(2020, 12, 31, 23, 59, 59).AddTicks(9999999)
}

# The nineteen standard specifiers .NET defines, then the custom patterns the
# engine has to expand. The single letters are the point: .NET reads a
# ONE-CHARACTER format string as a standard specifier, so 'd' is the culture's
# short date and not the day number.
$DateFormats = @(
    'd'; 'D'; 'f'; 'F'; 'g'; 'G'; 'm'; 'M'; 'o'; 'O'; 'r'; 'R'; 's'; 't'; 'T'; 'u'; 'U'; 'y'; 'Y'
    '%d'; '%h'; '%H'; '%f'; '%F'; '%t'; '%y'; '%M'; '%m'; '%s'
    'yyyy-MM-dd'; 'HH:mm:ss'; 'yyyy/M/d'; 'M/d/yyyy h:mm:ss tt'; 'dd.MM.yyyy HH:mm:ss'
    'tt'; 'ddd'; 'dddd'; 'MMM'; 'MMMM'; 'h:mm:ss tt'; 'hh'; 'HH'; 'mm'; 'ss'
    'yy'; 'yyy'; 'yyyy'; 'yyyyy'
    'f'; 'ff'; 'fff'; 'ffff'; 'fffff'; 'ffffff'; 'fffffff'
    'FF'; 'FFF'; 'FFFF'; 'FFFFFFF'
    "yyyy'年'M'月'd'日'"
    'yyyy\-MM'
    'yyyyMMdd'
    "yyyy-MM-dd'T'HH:mm:ss"
    'dddd, MMMM d, yyyy h:mm:ss tt'
    'gg'
) | Select-Object -Unique

# ---------------------------------------------------------------------------
# reading one culture
# ---------------------------------------------------------------------------

function Get-NumberFormatDetail {
    param([System.Globalization.NumberFormatInfo] $Info)

    return [ordered]@{
        numberDecimalDigits      = $Info.NumberDecimalDigits
        numberDecimalSeparator   = $Info.NumberDecimalSeparator
        numberGroupSeparator     = $Info.NumberGroupSeparator
        numberGroupSizes         = @($Info.NumberGroupSizes)
        numberNegativePattern    = $Info.NumberNegativePattern
        percentDecimalDigits     = $Info.PercentDecimalDigits
        percentDecimalSeparator  = $Info.PercentDecimalSeparator
        percentGroupSeparator    = $Info.PercentGroupSeparator
        percentGroupSizes        = @($Info.PercentGroupSizes)
        percentSymbol            = $Info.PercentSymbol
        percentPositivePattern   = $Info.PercentPositivePattern
        percentNegativePattern   = $Info.PercentNegativePattern
        perMilleSymbol           = $Info.PerMilleSymbol
        currencyDecimalDigits    = $Info.CurrencyDecimalDigits
        currencyDecimalSeparator = $Info.CurrencyDecimalSeparator
        currencyGroupSeparator   = $Info.CurrencyGroupSeparator
        currencyGroupSizes       = @($Info.CurrencyGroupSizes)
        currencySymbol           = $Info.CurrencySymbol
        currencyPositivePattern  = $Info.CurrencyPositivePattern
        currencyNegativePattern  = $Info.CurrencyNegativePattern
        negativeSign             = $Info.NegativeSign
        positiveSign             = $Info.PositiveSign
        positiveInfinitySymbol   = $Info.PositiveInfinitySymbol
        negativeInfinitySymbol   = $Info.NegativeInfinitySymbol
        nanSymbol                = $Info.NaNSymbol
        digitSubstitution        = [string] $Info.DigitSubstitution
        nativeDigits             = @($Info.NativeDigits)
    }
}

function Get-DateTimeFormatDetail {
    param([System.Globalization.DateTimeFormatInfo] $Info)

    # GetAllDateTimePatterns(char) returns every pattern that specifier ACCEPTS
    # when parsing; the first is the one it PRODUCES when formatting. That first
    # element is the whole reason this capture exists — it is the standard
    # specifier table, per culture, which the hand-written engine did not have.
    #
    # ORDINAL comparer, not the default. `[ordered]@{}` is a case-INSENSITIVE
    # OrderedDictionary, so 'd' and 'D' are one key in it — and .NET's standard
    # specifiers are case-sensitive ('d' is the short date, 'D' the long one).
    # The first run of this capture silently collapsed nineteen specifiers into
    # ten, with each lowercase entry holding its uppercase sibling's pattern.
    $standard = [System.Collections.Specialized.OrderedDictionary]::new([System.StringComparer]::Ordinal)
    foreach ($letter in @('d', 'D', 'f', 'F', 'g', 'G', 'm', 'M', 'o', 'O', 'r', 'R', 's', 't', 'T', 'u', 'U', 'y', 'Y')) {
        $all = $Info.GetAllDateTimePatterns([char] $letter)
        $standard[$letter] = $all[0]
    }

    # The era name `g`/`gg`/`ggg` produces. Culture-dependent — en-US says AD,
    # de-DE `n. Chr.`, zh-TW 西元 — which is why the engine used to refuse `g`
    # rather than print the `AD` it had hard-coded for every culture.
    $eras = @(foreach ($era in $Info.Calendar.Eras) {
        [ordered]@{
            era         = $era
            name        = $Info.GetEraName($era)
            abbreviated = $Info.GetAbbreviatedEraName($era)
        }
    })

    # MonthNames carries thirteen entries; the thirteenth is the leap month of a
    # lunisolar calendar and is empty for every Gregorian culture. Kept as it
    # comes rather than trimmed, so nothing downstream has to guess whether an
    # index was shifted.
    return [ordered]@{
        eras                           = $eras
        amDesignator                   = $Info.AMDesignator
        pmDesignator                   = $Info.PMDesignator
        dateSeparator                  = $Info.DateSeparator
        timeSeparator                  = $Info.TimeSeparator
        firstDayOfWeek                 = [string] $Info.FirstDayOfWeek
        calendarName                   = $Info.Calendar.GetType().Name
        shortDatePattern               = $Info.ShortDatePattern
        longDatePattern                = $Info.LongDatePattern
        shortTimePattern               = $Info.ShortTimePattern
        longTimePattern                = $Info.LongTimePattern
        fullDateTimePattern            = $Info.FullDateTimePattern
        monthDayPattern                = $Info.MonthDayPattern
        yearMonthPattern               = $Info.YearMonthPattern
        rfc1123Pattern                 = $Info.RFC1123Pattern
        sortableDateTimePattern        = $Info.SortableDateTimePattern
        universalSortableDateTimePattern = $Info.UniversalSortableDateTimePattern
        standardPatterns               = $standard
        dayNames                       = @($Info.DayNames)
        abbreviatedDayNames            = @($Info.AbbreviatedDayNames)
        shortestDayNames               = @($Info.ShortestDayNames)
        monthNames                     = @($Info.MonthNames)
        abbreviatedMonthNames          = @($Info.AbbreviatedMonthNames)
        # .NET picks the genitive names for a pattern where the month follows a
        # day number. For the three cultures here they equal the nominative
        # ones, and recording both is what lets a test say so out loud instead
        # of the engine quietly assuming it.
        monthGenitiveNames             = @($Info.MonthGenitiveNames)
        abbreviatedMonthGenitiveNames  = @($Info.AbbreviatedMonthGenitiveNames)
    }
}

function Get-FormatSample {
    <#
        One `value.ToString(format, culture)`, which is exactly what
        `'{0:<format>}' -f $value` does — the operator resolves to
        String.Format, and String.Format calls IFormattable.ToString.

        A format the runtime rejects is recorded as `{ error = ... }`. That is
        deliberate: `'{0:D}' -f 1.5` throwing is part of the contract, and a
        capture that dropped it would let an implementation invent an answer.
    #>
    param($Value, [string] $Format, [System.Globalization.CultureInfo] $Culture)

    try {
        if ($Format -eq '') {
            return [ordered]@{ format = $Format; text = [string]::Format($Culture, '{0}', $Value) }
        }
        return [ordered]@{ format = $Format; text = $Value.ToString($Format, $Culture) }
    } catch {
        return [ordered]@{ format = $Format; error = $_.Exception.InnerException ? $_.Exception.InnerException.GetType().Name : $_.Exception.GetType().Name }
    }
}

function Get-PatternForms {
    <#
        The SHAPES .NET's five pattern enumerations stand for.

        `CurrencyNegativePattern = 0` means `($n)` — the sign is a pair of
        parentheses and there is no minus at all. That is documented in a table
        a reader has to copy by hand, and copying tables by hand is what this
        whole capture exists to stop. So the shapes are asked for instead: a
        writable NumberFormatInfo whose symbol is the literal `SYM` and whose
        negative sign is `NEG`, formatting 1 with no fraction digits, renders
        each pattern index as its own template.

        The result is culture-independent — it describes the enumeration, not a
        locale — so it is recorded once at the top level.
    #>
    $forms = [ordered]@{}

    $currencyPositive = [ordered]@{}
    $currencyNegative = [ordered]@{}
    foreach ($i in 0..3) {
        $nfi = [System.Globalization.CultureInfo]::InvariantCulture.NumberFormat.Clone()
        $nfi.CurrencySymbol = 'SYM'; $nfi.NegativeSign = 'NEG'; $nfi.CurrencyDecimalDigits = 0
        $nfi.CurrencyPositivePattern = $i
        $currencyPositive["$i"] = (1).ToString('C', $nfi)
    }
    foreach ($i in 0..16) {
        $nfi = [System.Globalization.CultureInfo]::InvariantCulture.NumberFormat.Clone()
        $nfi.CurrencySymbol = 'SYM'; $nfi.NegativeSign = 'NEG'; $nfi.CurrencyDecimalDigits = 0
        $nfi.CurrencyNegativePattern = $i
        $currencyNegative["$i"] = (-1).ToString('C', $nfi)
    }

    $percentPositive = [ordered]@{}
    $percentNegative = [ordered]@{}
    foreach ($i in 0..3) {
        $nfi = [System.Globalization.CultureInfo]::InvariantCulture.NumberFormat.Clone()
        $nfi.PercentSymbol = 'SYM'; $nfi.NegativeSign = 'NEG'; $nfi.PercentDecimalDigits = 0
        $nfi.PercentPositivePattern = $i
        $percentPositive["$i"] = (0.01).ToString('P', $nfi)
    }
    foreach ($i in 0..11) {
        $nfi = [System.Globalization.CultureInfo]::InvariantCulture.NumberFormat.Clone()
        $nfi.PercentSymbol = 'SYM'; $nfi.NegativeSign = 'NEG'; $nfi.PercentDecimalDigits = 0
        $nfi.PercentNegativePattern = $i
        $percentNegative["$i"] = (-0.01).ToString('P', $nfi)
    }

    $numberNegative = [ordered]@{}
    foreach ($i in 0..4) {
        $nfi = [System.Globalization.CultureInfo]::InvariantCulture.NumberFormat.Clone()
        $nfi.NegativeSign = 'NEG'; $nfi.NumberDecimalDigits = 0
        $nfi.NumberNegativePattern = $i
        $numberNegative["$i"] = (-1).ToString('N', $nfi)
    }

    $forms['$comment'] = 'Rendered templates for .NET''s pattern enumerations. SYM is the currency or percent symbol, NEG the negative sign, 1 the formatted magnitude.'
    $forms['currencyPositive'] = $currencyPositive
    $forms['currencyNegative'] = $currencyNegative
    $forms['percentPositive'] = $percentPositive
    $forms['percentNegative'] = $percentNegative
    $forms['numberNegative'] = $numberNegative
    return $forms
}

function Get-CultureDetail {
    param([System.Globalization.CultureInfo] $Culture)

    return [ordered]@{
        name           = $Culture.Name
        displayName    = $Culture.EnglishName
        isInvariant    = $Culture.Equals([System.Globalization.CultureInfo]::InvariantCulture)
        numberFormat   = Get-NumberFormatDetail -Info $Culture.NumberFormat
        dateTimeFormat = Get-DateTimeFormatDetail -Info $Culture.DateTimeFormat
    }
}

function Get-CultureSamples {
    param([System.Globalization.CultureInfo] $Culture)

    $numbers = [ordered]@{}
    foreach ($key in $NumberCorpus.Keys) {
        $numbers[$key] = @(foreach ($f in $NumberFormats) { Get-FormatSample -Value $NumberCorpus[$key] -Format $f -Culture $Culture })
    }

    $integers = [ordered]@{}
    foreach ($key in $IntegerCorpus.Keys) {
        $integers[$key] = @(foreach ($f in $IntegerFormats) { Get-FormatSample -Value $IntegerCorpus[$key] -Format $f -Culture $Culture })
    }

    $dates = [ordered]@{}
    foreach ($key in $DateCorpus.Keys) {
        $dates[$key] = @(foreach ($f in $DateFormats) { Get-FormatSample -Value $DateCorpus[$key] -Format $f -Culture $Culture })
    }

    return [ordered]@{
        numbers  = $numbers
        integers = $integers
        dates    = $dates
    }
}

# ---------------------------------------------------------------------------
# the document
# ---------------------------------------------------------------------------

$cultures = [ordered]@{}
$samples = [ordered]@{}

# useUserOverride = $false. With the default the host's regional settings are
# folded in, and the capture would describe this machine rather than the culture.
$resolved = [ordered]@{}
foreach ($name in ($CultureName | Sort-Object -Unique)) {
    $resolved[$name] = [System.Globalization.CultureInfo]::new($name, $false)
}
$resolved['Invariant'] = [System.Globalization.CultureInfo]::InvariantCulture

foreach ($name in $resolved.Keys) {
    $cultures[$name] = Get-CultureDetail -Culture $resolved[$name]
    $samples[$name] = Get-CultureSamples -Culture $resolved[$name]
}

# PowerShell's own `"$x"` conversion, which is NOT String.Format and NOT the
# culture's ToString: it is G15 against the invariant culture. Captured next to
# the culture data because src/pipeline/psobject.ts had a second, disagreeing
# implementation of it — exponential below 1e-5 where .NET switches at 1e-5, and
# `0` for negative zero where pwsh says `-0`.
$interpolation = [ordered]@{}
foreach ($key in $NumberCorpus.Keys) {
    $v = $NumberCorpus[$key]
    $interpolation[$key] = [ordered]@{
        interpolated = "$v"
        g15Invariant = $v.ToString('G15', [System.Globalization.CultureInfo]::InvariantCulture)
    }
}
foreach ($key in $IntegerCorpus.Keys) {
    $v = $IntegerCorpus[$key]
    $interpolation[$key] = [ordered]@{
        interpolated = "$v"
        g15Invariant = $v.ToString('G15', [System.Globalization.CultureInfo]::InvariantCulture)
    }
}
$dateInterpolation = [ordered]@{}
foreach ($key in $DateCorpus.Keys) {
    $dateInterpolation[$key] = "$($DateCorpus[$key])"
}

$corpus = [ordered]@{
    numbers  = [ordered]@{}
    integers = [ordered]@{}
    dates    = [ordered]@{}
}
foreach ($key in $NumberCorpus.Keys) {
    # Round-trip ("R") so the JSON names the exact double, not a rounded view of
    # it. 0.135 and 1.005 are in the corpus precisely because their decimal
    # spelling is not their value.
    $corpus.numbers[$key] = [ordered]@{
        roundTrip = $NumberCorpus[$key].ToString('R', [System.Globalization.CultureInfo]::InvariantCulture)
    }
}
foreach ($key in $IntegerCorpus.Keys) {
    $corpus.integers[$key] = [ordered]@{
        roundTrip = $IntegerCorpus[$key].ToString([System.Globalization.CultureInfo]::InvariantCulture)
        type      = $IntegerCorpus[$key].GetType().FullName
    }
}
foreach ($key in $DateCorpus.Keys) {
    $d = $DateCorpus[$key]
    $corpus.dates[$key] = [ordered]@{
        # The civil components, so a consumer never has to parse a formatted
        # string to rebuild the value it was formatted from.
        year        = $d.Year
        month       = $d.Month
        day         = $d.Day
        hour        = $d.Hour
        minute      = $d.Minute
        second      = $d.Second
        millisecond = $d.Millisecond
        subMillisecondTicks = [int] ($d.Ticks % 10000)
        kind        = [string] $d.Kind
        roundTrip   = $d.ToString('o', [System.Globalization.CultureInfo]::InvariantCulture)
    }
}

$engine = [ordered]@{
        psVersion   = $psVersion
        psEdition   = $PSVersionTable.PSEdition
        gitCommitId = $PSVersionTable.GitCommitId
        os          = $PSVersionTable.OS
        platform    = $PSVersionTable.Platform
        osPlatform  = $platform
        framework   = [System.Runtime.InteropServices.RuntimeInformation]::FrameworkDescription
        osDescription = [System.Runtime.InteropServices.RuntimeInformation]::OSDescription
        # Invariant globalization mode would make every culture below identical
        # to the invariant one. Detected rather than assumed, because a capture
        # taken in that mode looks plausible and describes nothing.
        globalizationInvariantMode = [System.Globalization.CultureInfo]::new('en-US', $false).NumberFormat.CurrencySymbol -eq '¤'
        # The one behavioural ICU fingerprint that matters here. CLDR 42 replaced
        # the space before en-US's AM/PM designator with U+202F NARROW NO-BREAK
        # SPACE, and the two hosts this project is measured on do not agree:
        # a current Linux ICU says U+202F, the Windows host says U+0020.
        narrowNoBreakSpaceInEnUsTimePattern =
            [System.Globalization.CultureInfo]::new('en-US', $false).DateTimeFormat.LongTimePattern.Contains([char] 0x202F)
        # The `U` and `u` specifiers are defined in UTC terms, so their samples
        # encode the capture host's zone as well as its culture. Recorded so a
        # consumer can tell a culture difference from a timezone one instead of
        # discovering it as a mysterious eight-hour shift.
        localUtcOffsetMinutes = [int] [System.TimeZoneInfo]::Local.GetUtcOffset([datetime]::new(2020, 3, 4, 15, 6, 7)).TotalMinutes
        timeZoneId  = [System.TimeZoneInfo]::Local.Id
}

$metadata = [ordered]@{
    '$comment'    = 'Generated by tools/capture-pwsh-culture.ps1 from a real PowerShell. Do not hand-edit; re-run the capture. Read by src/formatting/culture.ts.'
    schemaVersion = 1
    capturedAt    = (Get-Date).ToUniversalTime().ToString('o')
    engine        = $engine
    patternForms  = Get-PatternForms
    cultures      = $cultures
}

$sampleDocument = [ordered]@{
    '$comment'    = 'Generated by tools/capture-pwsh-culture.ps1 from a real PowerShell. Do not hand-edit; re-run the capture. Read by the tests, never by src/.'
    schemaVersion = 1
    capturedAt    = $metadata.capturedAt
    engine        = $engine
    corpus        = $corpus
    interpolation = [ordered]@{
        '$comment' = 'PowerShell "$x", and .NET ToString("G15", InvariantCulture) beside it.'
        numbers    = $interpolation
        dates      = $dateInterpolation
    }
    cultures      = $samples
}

Set-Content -Path $OutFile -Value ($metadata | ConvertTo-Json -Depth 12) -Encoding utf8NoBOM
Set-Content -Path $SamplesFile -Value ($sampleDocument | ConvertTo-Json -Depth 12) -Encoding utf8NoBOM

Write-Host ''
Write-Host "  PowerShell $psVersion on $([System.Runtime.InteropServices.RuntimeInformation]::FrameworkDescription) / $platform"
Write-Host "  captured $($cultures.Count) cultures"
foreach ($key in $cultures.Keys) {
    $c = $cultures[$key]
    Write-Host ("    {0,-10} NumberDecimalDigits={1} currency='{2}' nan='{3}' G='{4}'" -f `
        $key, $c.numberFormat.numberDecimalDigits, $c.numberFormat.currencySymbol, `
        $c.numberFormat.nanSymbol, $c.dateTimeFormat.standardPatterns['G'])
}
Write-Host "  wrote $OutFile"
Write-Host "  wrote $SamplesFile"
Write-Host ''
