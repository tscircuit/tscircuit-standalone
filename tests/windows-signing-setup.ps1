$ErrorActionPreference = 'Stop'
$setup = Join-Path $PSScriptRoot '../scripts/install-windows-signing.ps1'
# Mocks execute in the setup script's child scope; share one state object.
$global:WindowsSigningSetupTestState = @{}

# Exercise the installer without contacting PSGallery or sleeping.
function Get-Module {
    param([switch]$ListAvailable, [string]$Name)
    foreach ($version in $global:WindowsSigningSetupTestState.AvailableVersions) { [pscustomobject]@{ Version = [version]$version } }
}
function Install-Module {
    [CmdletBinding()]
    param([string]$Name, [string]$RequiredVersion, [string]$Scope, [switch]$Force, [string]$Repository)
    if ($Name -ne 'ArtifactSigning' -or $RequiredVersion -ne '0.1.8' -or $Scope -ne 'CurrentUser' -or !$Force -or $Repository -ne 'PSGallery') {
        throw 'Unexpected module installation parameters'
    }
    $global:WindowsSigningSetupTestState.InstallCalls++
    if ($global:WindowsSigningSetupTestState.InstallCalls -le $global:WindowsSigningSetupTestState.Failures) { throw "Unable to resolve package source 'https://www.powershellgallery.com/api/v2'." }
    $global:WindowsSigningSetupTestState.AvailableVersions = @('0.1.8')
}
function Import-Module {
    [CmdletBinding()]
    param([string]$Name, [string]$RequiredVersion)
    $global:WindowsSigningSetupTestState.ImportCalls++
    if ($Name -ne 'ArtifactSigning' -or $RequiredVersion -ne '0.1.8' -or $global:WindowsSigningSetupTestState.InvalidModule -or '0.1.8' -notin $global:WindowsSigningSetupTestState.AvailableVersions) {
        throw 'Cannot import the pinned signing module'
    }
}
function Start-Sleep {
    param([double]$Seconds)
    $global:WindowsSigningSetupTestState.Delays += $Seconds
}
function Reset-Fixture {
    param([int]$Failures = 0, [string[]]$Versions = @(), [switch]$InvalidModule)
    $global:WindowsSigningSetupTestState.Failures = $Failures
    $global:WindowsSigningSetupTestState.AvailableVersions = $Versions
    $global:WindowsSigningSetupTestState.InvalidModule = $InvalidModule
    $global:WindowsSigningSetupTestState.InstallCalls = 0
    $global:WindowsSigningSetupTestState.ImportCalls = 0
    $global:WindowsSigningSetupTestState.Delays = @()
}
function Assert-Equal($Actual, $Expected) {
    if ($Actual -cne $Expected) { throw "Expected '$Expected', got '$Actual'" }
}

Reset-Fixture -Failures 2
& $setup
Assert-Equal $global:WindowsSigningSetupTestState.InstallCalls 3
Assert-Equal $global:WindowsSigningSetupTestState.ImportCalls 1
Assert-Equal ($global:WindowsSigningSetupTestState.Delays -join ',') '5,10'

Reset-Fixture -Failures 10
$failure = $null
try { & $setup } catch { $failure = $_.Exception.Message }
if ($failure -notlike '*after 5 attempts*') { throw 'Persistent download failure did not stop setup' }
Assert-Equal $global:WindowsSigningSetupTestState.InstallCalls 5
Assert-Equal $global:WindowsSigningSetupTestState.ImportCalls 0
Assert-Equal ($global:WindowsSigningSetupTestState.Delays -join ',') '5,10,20,40'

Reset-Fixture -Versions @('0.1.8')
& $setup
Assert-Equal $global:WindowsSigningSetupTestState.InstallCalls 0
Assert-Equal $global:WindowsSigningSetupTestState.ImportCalls 1

Reset-Fixture -Versions @('0.1.7')
& $setup
Assert-Equal $global:WindowsSigningSetupTestState.InstallCalls 1
Assert-Equal $global:WindowsSigningSetupTestState.ImportCalls 1

Reset-Fixture -InvalidModule
$failure = $null
try { & $setup } catch { $failure = $_.Exception.Message }
Assert-Equal $failure 'Cannot import the pinned signing module'
Assert-Equal $global:WindowsSigningSetupTestState.InstallCalls 1
Assert-Equal $global:WindowsSigningSetupTestState.ImportCalls 1
Assert-Equal $global:WindowsSigningSetupTestState.Delays.Count 0
Write-Host 'Signing setup retries, exhaustion, cache reuse, version pinning and import failures passed.'

Remove-Variable -Name WindowsSigningSetupTestState -Scope Global
