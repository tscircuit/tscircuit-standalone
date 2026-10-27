param(
    [Parameter(Mandatory = $true)][ValidateSet('Detect', 'Install', 'Uninstall')][string]$Mode,
    [string]$InstallDir,
    [string]$ResultFile
)
$ErrorActionPreference = 'Stop'

function Same-Path([string]$Left, [string]$Right) {
    return [string]::Equals([Environment]::ExpandEnvironmentVariables($Left).Trim().Trim('"').TrimEnd('\'),
        $Right.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
}
function Set-Result([string]$Command, [string]$Warning = '') {
    $Warning = $Warning -replace '[\r\n]', ' '
    "[Result]`r`nCommand=$Command`r`nWarning=$Warning`r`n" | Set-Content -LiteralPath $ResultFile -Encoding Unicode
}
function Broadcast-Environment {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class TsciEnvironment {
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r);
}
'@
    $result = [UIntPtr]::Zero
    [void][TsciEnvironment]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
}

$pathChanged = $false
$stateChanged = $false
try {
    if ($Mode -eq 'Detect') {
        # Setup may inherit a stale terminal environment. Resolve conflicts using
        # the current persisted PATH, not the launcher's old process PATH.
        $env:Path = [Environment]::ExpandEnvironmentVariables(
            [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
            [Environment]::GetEnvironmentVariable('Path', 'User'))
        $commands = @(foreach ($name in @('tsci', 'tscircuit')) {
            Get-Command $name -All -ErrorAction SilentlyContinue | ForEach-Object {
                if ($_.Path) { $_.Path } else { $_.Definition }
            }
        }) | Select-Object -Unique
        if ($null -eq $commands) { $commands = @() } else { $commands = @($commands) }
        $external = 0
        foreach ($name in @('tsci', 'tscircuit')) {
            $current = Get-Command $name -ErrorAction SilentlyContinue
            if ($current -and (-not $InstallDir -or -not (Same-Path $current.Path (Join-Path $InstallDir "$name.exe")))) { $external = 1 }
        }
        $paths = ($commands -join '  |  ') -replace '[\r\n]', ' '
        "[Detection]`r`nCount=$($commands.Count)`r`nExternal=$external`r`nPaths=$paths`r`n" | Set-Content -LiteralPath $ResultFile -Encoding Unicode
        exit 0
    }
    if (-not $InstallDir) { throw 'InstallDir is required' }
    $InstallDir = [IO.Path]::GetFullPath($InstallDir)
    $stateFile = Join-Path $InstallDir 'installer-state.json'
    $oldPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = @(([string]$oldPath) -split ';')
    $present = @($entries | Where-Object { Same-Path $_ $InstallDir }).Count -gt 0
    $oldState = $null
    if (Test-Path -LiteralPath $stateFile) { $oldState = [IO.File]::ReadAllText($stateFile) }
    $added = -not $present
    if ($null -ne $oldState) { $added = $added -or [bool]($oldState | ConvertFrom-Json).pathAdded }
    if ($Mode -eq 'Uninstall') {
        if ($null -ne $oldState -and ($oldState | ConvertFrom-Json).pathAdded) {
            $remaining = @($entries | Where-Object { -not (Same-Path $_ $InstallDir) })
            [Environment]::SetEnvironmentVariable('Path', ($remaining -join ';'), 'User')
            Broadcast-Environment
        }
        exit 0
    }
    if (-not $ResultFile) { throw 'ResultFile is required' }
    $newEntries = @($entries | Where-Object { -not (Same-Path $_ $InstallDir) })
    $newPath = (@($InstallDir) + $newEntries) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    $pathChanged = $true
    @{pathAdded = $added} | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
    $stateChanged = $true
    $env:Path = [Environment]::ExpandEnvironmentVariables(
        [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + $newPath)
    foreach ($name in @('tsci', 'tscircuit')) {
        $resolved = Get-Command $name -ErrorAction SilentlyContinue
        if (-not $resolved -or -not (Same-Path $resolved.Path (Join-Path $InstallDir "$name.exe"))) {
            throw "An existing $name command takes priority over user PATH. Adjust that PATH entry before using standalone as $name."
        }
    }
    Set-Result 'tsci, tscircuit'
    Broadcast-Environment
    exit 0
} catch {
    $message = $_.Exception.Message
    # Roll back only this attempt's changes. Do not overwrite concurrent PATH edits.
    if ($pathChanged -and [Environment]::GetEnvironmentVariable('Path', 'User') -eq $newPath) {
        [Environment]::SetEnvironmentVariable('Path', $oldPath, 'User')
    }
    if ($stateChanged) {
        if ($null -ne $oldState) { [IO.File]::WriteAllText($stateFile, $oldState) }
        else { Remove-Item -LiteralPath $stateFile -ErrorAction SilentlyContinue }
    }
    if ($ResultFile) {
        try { Set-Result '' $message } catch { }
    }
    [Console]::Error.WriteLine($message)
    exit 1
}
