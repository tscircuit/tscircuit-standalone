$ErrorActionPreference = 'Stop'
$setup = Join-Path $PSScriptRoot '../scripts/install-windows-signing.ps1'

# Exercise the installer without contacting PSGallery or sleeping.
function Get-Module {
    param([switch]$ListAvailable, [string]$Name)
    foreach ($version in $script:AvailableVersions) { [pscustomobject]@{ Version = [version]$version } }
}
function Install-Module {
    [CmdletBinding()]
    param([string]$Name, [string]$RequiredVersion, [string]$Scope, [switch]$Force, [string]$Repository)
    if ($Name -ne 'ArtifactSigning' -or $RequiredVersion -ne '0.1.8' -or $Scope -ne 'CurrentUser' -or !$Force -or $Repository -ne 'PSGallery') {
        throw 'Unexpected module installation parameters'
    }
    $script:InstallCalls++
    if ($script:InstallCalls -le $script:Failures) { throw "Unable to resolve package source 'https://www.powershellgallery.com/api/v2'." }
    $script:AvailableVersions = @('0.1.8')
}
function Import-Module {
    [CmdletBinding()]
    param([string]$Name, [string]$RequiredVersion)
    $script:ImportCalls++
    if ($Name -ne 'ArtifactSigning' -or $RequiredVersion -ne '0.1.8' -or $script:InvalidModule -or '0.1.8' -notin $script:AvailableVersions) {
        throw 'Cannot import the pinned signing module'
    }
}
function Start-Sleep {
    param([double]$Seconds)
    $script:Delays += $Seconds
}
function Reset-Fixture {
    param([int]$Failures = 0, [string[]]$Versions = @(), [switch]$InvalidModule)
    $script:Failures = $Failures
    $script:AvailableVersions = $Versions
    $script:InvalidModule = $InvalidModule
    $script:InstallCalls = 0
    $script:ImportCalls = 0
    $script:Delays = @()
}
function Assert-Equal($Actual, $Expected) {
    if ($Actual -cne $Expected) { throw "Expected '$Expected', got '$Actual'" }
}

Reset-Fixture -Failures 2
& $setup
Assert-Equal $script:InstallCalls 3
Assert-Equal $script:ImportCalls 1
Assert-Equal ($script:Delays -join ',') '5,10'

Reset-Fixture -Failures 10
$failure = $null
try { & $setup } catch { $failure = $_.Exception.Message }
if ($failure -notlike '*after 5 attempts*') { throw 'Persistent download failure did not stop setup' }
Assert-Equal $script:InstallCalls 5
Assert-Equal $script:ImportCalls 0
Assert-Equal ($script:Delays -join ',') '5,10,20,40'

Reset-Fixture -Versions @('0.1.8')
& $setup
Assert-Equal $script:InstallCalls 0
Assert-Equal $script:ImportCalls 1

Reset-Fixture -Versions @('0.1.7')
& $setup
Assert-Equal $script:InstallCalls 1
Assert-Equal $script:ImportCalls 1

Reset-Fixture -InvalidModule
$failure = $null
try { & $setup } catch { $failure = $_.Exception.Message }
Assert-Equal $failure 'Cannot import the pinned signing module'
Assert-Equal $script:InstallCalls 1
Assert-Equal $script:ImportCalls 1
Assert-Equal $script:Delays.Count 0
Write-Host 'Signing setup retries, exhaustion, cache reuse, version pinning and import failures passed.'
