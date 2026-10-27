# Offline tests: all remote requests and installer launches are mocked.
$ErrorActionPreference = 'Stop'
$global:TsciFixtureassetName = 'tscircuit-standalone-windows-x64-setup.exe'
$global:TsciFixturebytes = [Text.Encoding]::UTF8.GetBytes('fixture installer')
$sha = [Security.Cryptography.SHA256]::Create()
$global:TsciFixturehash = ([BitConverter]::ToString($sha.ComputeHash($global:TsciFixturebytes))).Replace('-', '').ToLowerInvariant()
$sha.Dispose()
function Reset-Fixture {
    $global:TsciFixturerelease = [pscustomobject]@{tag_name = 'daily-2026-10-27'; draft = $false; assets = @(
        [pscustomobject]@{name = $global:TsciFixtureassetName}, [pscustomobject]@{name = 'SHA256SUMS'})}
    $global:TsciFixturemanifest = "$global:TsciFixturehash  $global:TsciFixtureassetName`n"
    $global:TsciFixturelaunched = @()
    $global:TsciFixturerequests = @()
    $global:TsciFixturetamper = $false
    $global:TsciFixturesignatureStatus = 'Valid'
    $global:TsciFixturepublisher = 'tscircuit Inc'
    $global:TsciFixturetimestamp = [pscustomobject]@{}
}
function Get-AuthenticodeSignature([string]$LiteralPath) {
    $certificate = [pscustomobject]@{}
    $certificate | Add-Member -MemberType ScriptMethod -Name GetNameInfo -Value { return $global:TsciFixturepublisher }
    return [pscustomobject]@{Status=$global:TsciFixturesignatureStatus; SignatureType='Authenticode'; SignerCertificate=$certificate; TimeStamperCertificate=$global:TsciFixturetimestamp}
}
function curl.exe {
    [CmdletBinding()]
    param([switch]$fsSL, [Parameter(Position=0)][string]$Uri)
    if (-not $fsSL) { throw 'Expected curl failure/redirect flags' }
    if ($Uri -ne 'https://raw.githubusercontent.com/tscircuit/tscircuit-standalone/main/scripts/install-windows.ps1') { throw 'Unexpected bootstrap URL' }
    Get-Content -LiteralPath $global:TsciFixturebootstrapPath
}
function Invoke-RestMethod([string]$Uri, [int]$TimeoutSec) {
    if ($TimeoutSec -ne 60) { throw 'Metadata requests must have a timeout' }
    $global:TsciFixturerequests += $Uri
    if ($Uri.Contains('/releases?')) { Write-Output -NoEnumerate @($global:TsciFixturerelease) }
    else { return $global:TsciFixturerelease }
}
function Invoke-WebRequest([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing, [int]$TimeoutSec) {
    if ($TimeoutSec -ne 300) { throw 'Asset downloads must have a timeout' }
    $global:TsciFixturerequests += $Uri
    if ($Uri.EndsWith('/SHA256SUMS')) { [IO.File]::WriteAllText($OutFile, $global:TsciFixturemanifest) }
    elseif ($global:TsciFixturetamper) { [IO.File]::WriteAllText($OutFile, 'tampered installer') }
    else { [IO.File]::WriteAllBytes($OutFile, $global:TsciFixturebytes) }
}
function Start-Process([string]$FilePath, [string[]]$ArgumentList, [switch]$Wait, [switch]$PassThru) {
    $global:TsciFixturelaunched = $ArgumentList
    return [pscustomobject]@{ExitCode = 0}
}
function Assert($condition, [string]$message) { if (-not $condition) { throw $message } }
function Expect-Failure([string]$message, [scriptblock]$action) {
    $failed = $false
    try { & $action } catch { $failed = $_.Exception.Message.Contains($message) }
    Assert $failed "Expected failure containing: $message"
    Assert ($global:TsciFixturelaunched.Count -eq 0) 'A rejected download launched an installer'
}
$bootstrap = Join-Path $PSScriptRoot '../scripts/install-windows.ps1'
$global:TsciFixturebootstrapPath = $bootstrap
$oldPath = $env:Path
try {
    Reset-Fixture
    & $bootstrap | Out-Null
    Assert ($global:TsciFixturelaunched -contains '/NORESTART') 'GUI installer was not launched'
    Assert ($global:TsciFixturelaunched -notcontains '/TASKS=replacecommands') 'GUI flow silently opted into takeover'
    Assert ($global:TsciFixturerequests[0].Contains('/releases?')) 'Latest did not search prereleases'
    Reset-Fixture
    $readme = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../README.md') -Raw
    $command = [regex]::Match($readme, '(?m)^curl\.exe .* \| Out-String \| iex\r?$').Value
    Assert ($command.Length -gt 0) 'The Windows terminal command is missing'
    Invoke-Expression $command | Out-Null
    Assert ($global:TsciFixturelaunched -contains '/NORESTART') 'The documented curl pipeline did not install'
    Reset-Fixture
    & $bootstrap -Release 'daily-2026-10-27' -Silent -ReplaceExisting | Out-Null
    Assert ($global:TsciFixturelaunched -contains '/VERYSILENT') 'Silent flag was lost'
    Assert ($global:TsciFixturelaunched -contains '/TASKS=replacecommands') 'Explicit takeover consent was lost'
    Assert ($global:TsciFixturerequests[0].EndsWith('/releases/tags/daily-2026-10-27')) 'Exact release tag was ignored'
    Reset-Fixture
    $global:TsciFixturetamper = $true
    Expect-Failure 'checksum mismatch' { & $bootstrap | Out-Null }
    Reset-Fixture
    $global:TsciFixturesignatureStatus = 'NotSigned'
    Expect-Failure 'Authenticode' { & $bootstrap | Out-Null }
    Reset-Fixture
    $global:TsciFixturepublisher = 'Another publisher'
    Expect-Failure 'signing identity' { & $bootstrap | Out-Null }
    Reset-Fixture
    $global:TsciFixturetimestamp = $null
    Expect-Failure 'Authenticode' { & $bootstrap | Out-Null }
    Reset-Fixture
    $global:TsciFixturemanifest += $global:TsciFixturemanifest
    Expect-Failure 'ambiguous' { & $bootstrap | Out-Null }
    Reset-Fixture
    $global:TsciFixturerelease.assets = @([pscustomobject]@{name = $global:TsciFixtureassetName})
    Expect-Failure 'missing' { & $bootstrap -Release 'daily-2026-10-27' | Out-Null }
    Reset-Fixture
    $global:TsciFixturerelease.draft = $true
    Expect-Failure 'No published release' { & $bootstrap | Out-Null }
    Reset-Fixture
    Expect-Failure 'Invalid release tag' { & $bootstrap -Release '../other' | Out-Null }
    Write-Output 'Windows bootstrap curl, download, signature and consent tests passed'
} finally { $env:Path = $oldPath }
