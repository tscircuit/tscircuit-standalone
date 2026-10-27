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
}
function Invoke-RestMethod([string]$Uri) {
    $global:TsciFixturerequests += $Uri
    return $global:TsciFixturerelease
}
function Invoke-WebRequest([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing) {
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
$oldPath = $env:Path
try {
    Reset-Fixture
    & $bootstrap | Out-Null
    Assert ($global:TsciFixturelaunched -contains '/NORESTART') 'GUI installer was not launched'
    Assert ($global:TsciFixturelaunched -notcontains '/TASKS=replacecommands') 'GUI flow silently opted into takeover'
    Assert ($global:TsciFixturerequests[0].Contains('/releases?')) 'Latest did not search prereleases'
    Reset-Fixture
    & $bootstrap -Release 'daily-2026-10-27' -Silent -ReplaceExisting | Out-Null
    Assert ($global:TsciFixturelaunched -contains '/VERYSILENT') 'Silent flag was lost'
    Assert ($global:TsciFixturelaunched -contains '/TASKS=replacecommands') 'Explicit takeover consent was lost'
    Assert ($global:TsciFixturerequests[0].EndsWith('/releases/tags/daily-2026-10-27')) 'Exact release tag was ignored'
    Reset-Fixture
    $global:TsciFixturetamper = $true
    Expect-Failure 'checksum mismatch' { & $bootstrap | Out-Null }
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
    Write-Output 'Windows bootstrap offline download/checksum/consent tests passed'
} finally { $env:Path = $oldPath }
