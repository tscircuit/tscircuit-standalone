# Exercise the real process lifecycle under both Windows PowerShell and pwsh.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../scripts/windows-installer/run-smoke-process.ps1"
function Assert($condition, [string]$message) { if (-not $condition) { throw $message } }
$root = Join-Path ([IO.Path]::GetTempPath()) ('installer process tests ' + [Guid]::NewGuid())
$hostExecutable = (Get-Process -Id $PID).Path
New-Item -ItemType Directory -Path $root | Out-Null
$fixture = Join-Path $root 'child process.ps1'
@'
param([string]$Mode, [string]$Root)
if ($Mode -eq 'child') { Start-Sleep -Seconds 60; exit 0 }
if ($Mode -eq 'quick') { Write-Output 'captured output'; exit 7 }
if ($Mode -eq 'console') {
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class TsciConsoleFixture { [DllImport("kernel32.dll", SetLastError = true)] public static extern uint GetConsoleProcessList([Out] uint[] processList, uint processCount); }'
    $consoleMembers = New-Object uint32[] 64
    $count = [TsciConsoleFixture]::GetConsoleProcessList($consoleMembers, $consoleMembers.Length)
    @{ processId = $PID; members = @($consoleMembers | Select-Object -First ([Math]::Min([int]$count, $consoleMembers.Length))) } | ConvertTo-Json -Compress
    exit 0
}
$hostExecutable = (Get-Process -Id $PID).Path
Set-Content -LiteralPath (Join-Path $Root "$Mode.parent.pid") -Value $PID
$child = Start-Process -FilePath $hostExecutable -ArgumentList @('-NoProfile', '-NonInteractive', '-File', ('"' + $PSCommandPath + '"'), '-Mode', 'child') -PassThru
Set-Content -LiteralPath (Join-Path $Root "$Mode.child.pid") -Value $child.Id
if ($Mode -eq 'hang') { Start-Sleep -Seconds 60 }
Write-Output 'parent completed while child stays alive'
exit 0
'@ | Set-Content -LiteralPath $fixture -Encoding utf8
function Run-Fixture([string]$mode, [int]$timeout = 15) {
    Invoke-SmokeProcess -Name $mode -FilePath $hostExecutable -LogDirectory $root -TimeoutSeconds $timeout `
        -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $fixture + '"'), '-Mode', $mode, '-Root', ('"' + $root + '"'))
}
try {
    $quick = Run-Fixture 'quick'
    Assert ($quick.ExitCode -eq 7) 'The child exit code was lost'
    Assert ($quick.Stdout.Trim() -eq 'captured output') 'The child output was lost'

    $console = Run-Fixture 'console'
    Assert ($console.ExitCode -eq 0) 'The console fixture did not finish'
    $consoleState = $console.Stdout | ConvertFrom-Json
    Assert ($consoleState.members -contains $consoleState.processId) 'The child did not receive its own console'
    Assert ($consoleState.members -notcontains $PID) 'The child shares the CI host console'

    $detached = Run-Fixture 'detached'
    Assert ($detached.ExitCode -eq 0) 'The parent did not finish'
    Assert ($detached.Stdout.Trim() -eq 'parent completed while child stays alive') 'Detached child output was not captured'
    $childId = [int](Get-Content -LiteralPath (Join-Path $root 'detached.child.pid'))
    Assert ([bool](Get-Process -Id $childId -ErrorAction SilentlyContinue)) 'The fixture did not leave a live descendant'
    Stop-Process -Id $childId -Force

    $timer = [Diagnostics.Stopwatch]::StartNew()
    $failure = ''
    try { Run-Fixture 'hang' 3 | Out-Null } catch { $failure = $_.Exception.Message }
    Assert ($failure.Contains('hang timed out')) "The timeout was not reported: $failure"
    Assert ($timer.Elapsed.TotalSeconds -lt 20) 'Timeout cleanup exceeded its bound'
    foreach ($kind in @('parent', 'child')) {
        $processId = [int](Get-Content -LiteralPath (Join-Path $root "hang.$kind.pid"))
        Assert (-not (Get-Process -Id $processId -ErrorAction SilentlyContinue)) "The timed-out $kind process is still running"
    }
    Write-Output 'Installer process exit, detached-child and timeout checks passed'
} finally {
    Get-ChildItem -LiteralPath $root -Filter '*.pid' | ForEach-Object {
        Stop-Process -Id ([int](Get-Content -LiteralPath $_.FullName)) -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
exit 0
