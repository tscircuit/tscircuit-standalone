function Invoke-SmokeProcess {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [Parameter(Mandatory = $true)][string]$LogDirectory,
        [ValidateRange(1, 600)][int]$TimeoutSeconds = 180
    )
    New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
    $stdout = Join-Path $LogDirectory "$Name.stdout.txt"
    $stderr = Join-Path $LogDirectory "$Name.stderr.txt"
    Write-Host "[$([DateTime]::UtcNow.ToString('o'))] Starting $Name (limit ${TimeoutSeconds}s)"
    $process = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -PassThru `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    try {
        # Start-Process -Wait waits for descendants as well. An unrelated
        # background child must not keep a completed installer check alive.
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            Write-Host "$Name timed out; terminating process tree $($process.Id)"
            $kill = Start-Process -FilePath "$env:SystemRoot\System32\taskkill.exe" `
                -ArgumentList @('/PID', [string]$process.Id, '/T', '/F') -PassThru -NoNewWindow
            try {
                if (-not $kill.WaitForExit(10000)) {
                    Stop-Process -Id $kill.Id -Force -ErrorAction SilentlyContinue
                }
            } finally { $kill.Dispose() }
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            throw "$Name timed out after ${TimeoutSeconds}s. Diagnostics: $LogDirectory"
        }
        $process.Refresh()
        Write-Host "[$([DateTime]::UtcNow.ToString('o'))] Finished $Name (exit $($process.ExitCode))"
        return [pscustomobject]@{
            ExitCode = $process.ExitCode
            Stdout = [IO.File]::ReadAllText($stdout)
        }
    } finally {
        foreach ($log in @($stdout, $stderr)) {
            if (Test-Path -LiteralPath $log) {
                Get-Content -LiteralPath $log -Tail 40 | ForEach-Object { Write-Host $_ }
            }
        }
        $process.Dispose()
    }
}
