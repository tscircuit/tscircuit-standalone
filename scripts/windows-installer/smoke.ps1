# Run only on a disposable Windows CI account. Refuse to replace a real install.
param(
    [Parameter(Mandatory = $true)][string]$Installer,
    [Parameter(Mandatory = $true)][string]$Binary,
    [Parameter(Mandatory = $true)][string]$Version,
    [switch]$RequireSigned,
    [string]$SigningReceipt,
    [string]$DiagnosticsDirectory
)
$ErrorActionPreference = 'Stop'
$Installer = [IO.Path]::GetFullPath($Installer)
$Binary = [IO.Path]::GetFullPath($Binary)
$verifySignature = Join-Path $PSScriptRoot '../verify-windows-signature.ps1'
if ($RequireSigned) {
    if (-not $SigningReceipt) { throw 'SigningReceipt is required for signed installer checks' }
    & $verifySignature -Path $Installer | Out-Null
}
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{41A4B36D-24BE-4D42-9D59-3BCA77DECD41}_is1'
if (Test-Path $key) { throw 'Refusing to test over an existing standalone installation' }
$root = Join-Path ([IO.Path]::GetTempPath()) ('tsci installer ' + [Guid]::NewGuid())
$installed = Join-Path $root 'app with spaces'
$existing = Join-Path $root 'npm shims'
$unrelated = Join-Path $root 'added after installation'
$oldPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$oldProcessPath = $env:Path
. "$PSScriptRoot/run-smoke-process.ps1"
if (-not $DiagnosticsDirectory) {
    $DiagnosticsDirectory = Join-Path ([IO.Path]::GetTempPath()) ('tsci-installer-diagnostics-' + [Guid]::NewGuid())
}
New-Item -ItemType Directory -Path $DiagnosticsDirectory -Force | Out-Null
Start-Transcript -Path (Join-Path $DiagnosticsDirectory 'smoke.txt') -Force | Out-Null
function Assert($condition, [string]$message) { if (-not $condition) { throw $message } }
function Refresh-Path {
    $env:Path = [Environment]::ExpandEnvironmentVariables([Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User'))
}
function Run-Setup([string]$task) {
    $name = if ($task) { 'install' } else { 'upgrade' }
    $arguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', ('/DIR="' + $installed + '"'))
    $arguments += '/LOG="' + (Join-Path $DiagnosticsDirectory "$name.inno.log") + '"'
    if ($task) { $arguments += '/TASKS=' + $task }
    $process = Invoke-SmokeProcess -Name $name -FilePath $Installer -ArgumentList $arguments -LogDirectory $DiagnosticsDirectory
    Assert ($process.ExitCode -eq 0) "Installer failed with $($process.ExitCode)"
    Refresh-Path
}
function Run-Uninstall([string]$name = 'uninstall') {
    $arguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', ('/LOG="' + (Join-Path $DiagnosticsDirectory "$name.inno.log") + '"'))
    $process = Invoke-SmokeProcess -Name $name -FilePath (Join-Path $installed 'unins000.exe') -ArgumentList $arguments -LogDirectory $DiagnosticsDirectory
    Assert ($process.ExitCode -eq 0) "Uninstaller failed with $($process.ExitCode)"
    Refresh-Path
}
try {
    New-Item -ItemType Directory -Path $existing, $unrelated -Force | Out-Null
    foreach ($name in @('tsci', 'tscircuit')) {
        Set-Content -LiteralPath (Join-Path $existing "$name.cmd") -Value '@echo existing npm command' -Encoding ascii
        Set-Content -LiteralPath (Join-Path $existing "$name.ps1") -Value "Write-Output 'existing npm command'" -Encoding ascii
    }
    $before = (Get-FileHash -LiteralPath (Join-Path $existing 'tsci.ps1')).Hash
    [Environment]::SetEnvironmentVariable('Path', ($existing + ';' + $oldPath), 'User')
    # Simulate setup launched from a terminal opened before npm updated user PATH.
    # Saved PATH contains both shims, but this process (and the child installer)
    # deliberately inherits only the old machine PATH.
    $env:Path = [Environment]::ExpandEnvironmentVariables([Environment]::GetEnvironmentVariable('Path', 'Machine'))
    Assert (-not (Get-Command tsci -ErrorAction SilentlyContinue)) 'Stale PATH fixture unexpectedly resolves tsci'
    Assert (-not (Get-Command tscircuit -ErrorAction SilentlyContinue)) 'Stale PATH fixture unexpectedly resolves tscircuit'
    # Detection must refresh persisted PATH and require consent before any copies.

    $arguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', ('/DIR="' + $installed + '"'), ('/LOG="' + (Join-Path $DiagnosticsDirectory 'refuse-conflict.inno.log') + '"'))
    $refused = Invoke-SmokeProcess -Name 'refuse-conflict' -FilePath $Installer -ArgumentList $arguments -LogDirectory $DiagnosticsDirectory
    Assert ($refused.ExitCode -ne 0) 'Existing commands were replaced without consent'
    Assert (-not (Test-Path (Join-Path $installed 'tsci.exe'))) 'Unapproved installation copied an executable'
    New-Item -ItemType Directory -Path $installed -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $installed 'tsci-standalone.exe') -Value 'obsolete prototype command'
    # Explicit takeover, upgrade, then uninstall must preserve later PATH edits.
    Run-Setup 'replacecommands'
    Assert ((Get-Command tsci).Path -eq (Join-Path $installed 'tsci.exe')) 'Standalone did not become the default'
    $versionResult = Invoke-SmokeProcess -Name 'tsci-version' -FilePath (Get-Command tsci).Path -ArgumentList @('--version') -LogDirectory $DiagnosticsDirectory -TimeoutSeconds 60
    Assert ($versionResult.ExitCode -eq 0 -and $versionResult.Stdout.Trim() -eq $Version) 'Default command version mismatch'
    $aliasVersion = Invoke-SmokeProcess -Name 'tscircuit-version' -FilePath (Get-Command tscircuit).Path -ArgumentList @('--version') -LogDirectory $DiagnosticsDirectory -TimeoutSeconds 60
    Assert ($aliasVersion.ExitCode -eq 0 -and $aliasVersion.Stdout.Trim() -eq $Version) 'tscircuit version mismatch'
    Assert ((Get-Command tscircuit).Path -eq (Join-Path $installed 'tscircuit.exe')) 'tscircuit alias did not become the default'
    Assert (-not (Test-Path (Join-Path $installed 'tsci-standalone.exe'))) 'Unexpected third command'
    foreach ($name in @('tsci.exe', 'tscircuit.exe')) {
        Assert ((Get-FileHash -LiteralPath (Join-Path $installed $name)).Hash -eq (Get-FileHash -LiteralPath $Binary).Hash) "Installed executable differs: $name"
        if ($RequireSigned) { & $verifySignature -Path (Join-Path $installed $name) | Out-Null }
    }
    foreach ($name in @('LICENSE', 'THIRD_PARTY_NOTICES', 'licenses.json', 'THIRD_PARTY_NOTICES.txt')) {
        Assert ((Get-FileHash -LiteralPath (Join-Path $installed $name)).Hash -eq
            (Get-FileHash -LiteralPath (Join-Path (Split-Path $Binary) $name)).Hash) "Notice differs: $name"
    }
    Run-Setup ''
    if ($RequireSigned) {
        & $verifySignature -Path (Join-Path $installed 'unins000.exe') |
            ConvertTo-Json | Set-Content -LiteralPath $SigningReceipt -Encoding utf8
    }
    [Environment]::SetEnvironmentVariable('Path', ([Environment]::GetEnvironmentVariable('Path', 'User') + ';' + $unrelated), 'User')
    Run-Uninstall
    $paths = [Environment]::GetEnvironmentVariable('Path', 'User') -split ';'
    Assert ($paths -notcontains $installed) 'Uninstall left its PATH entry'
    Assert ($paths -contains $unrelated) 'Uninstall removed a later PATH edit'
    Assert ($paths -contains $existing) 'Uninstall removed the npm PATH entry'
    Assert ((Get-Command tsci).Path -eq (Join-Path $existing 'tsci.ps1')) 'Original tsci was not restored'
    Assert ((Get-Command tscircuit).Path -eq (Join-Path $existing 'tscircuit.ps1')) 'Original tscircuit was not restored'
    Assert (-not (Test-Path $key)) 'Uninstall registry entry remains'
    Assert ((Get-FileHash -LiteralPath (Join-Path $existing 'tsci.ps1')).Hash -eq $before) 'npm shim contents changed'
    # A helper failure after PATH mutation must restore PATH, alias and state.
    $rollback = Join-Path $root 'rollback test'
    New-Item -ItemType Directory -Path $rollback | Out-Null
    Copy-Item -LiteralPath $Binary -Destination (Join-Path $rollback 'tsci.exe')
    Copy-Item -LiteralPath $Binary -Destination (Join-Path $rollback 'tscircuit.exe')
    $pathBeforeFailure = [Environment]::GetEnvironmentVariable('Path', 'User')
    $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + "$PSScriptRoot\setup.ps1" + '"'), '-Mode', 'Install', '-InstallDir', ('"' + $rollback + '"'), '-ResultFile', ('"' + (Join-Path $rollback 'missing\result.ini') + '"'))
    $failure = Invoke-SmokeProcess -Name 'rollback' -FilePath powershell.exe -ArgumentList $arguments -LogDirectory $DiagnosticsDirectory -TimeoutSeconds 60
    Assert ($failure.ExitCode -ne 0) 'Failure fixture unexpectedly succeeded'
    Assert ([Environment]::GetEnvironmentVariable('Path', 'User') -eq $pathBeforeFailure) 'Failed setup did not restore PATH'
    Assert (-not (Test-Path (Join-Path $rollback 'installer-state.json'))) 'Failed setup left state'
    Write-Output 'Windows installer install/conflict/upgrade/uninstall/rollback checks passed'
} finally {
    try {
        if (Test-Path (Join-Path $installed 'unins000.exe')) { Run-Uninstall 'cleanup-uninstall' }
    } catch {
        Write-Warning "Installer cleanup failed: $_"
    } finally {
        [Environment]::SetEnvironmentVariable('Path', $oldPath, 'User')
        $env:Path = $oldProcessPath
        Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
        Stop-Transcript | Out-Null
    }
}
# The intentional failing helper above must not become the CI script exit code.
exit 0
