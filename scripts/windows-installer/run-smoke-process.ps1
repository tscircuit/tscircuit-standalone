function Wait-SmokeProcessExit {
    param(
        [Parameter(Mandatory = $true)][Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
        [Parameter(Mandatory = $true)][string]$Name
    )
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $lastProgress = 0
    while ($true) {
        $Process.Refresh()
        if ($Process.HasExited) { return $true }
        if ($timer.Elapsed.TotalSeconds -ge $TimeoutSeconds) { return $false }
        if ($timer.Elapsed.TotalSeconds -ge ($lastProgress + 10)) {
            $lastProgress = [int]$timer.Elapsed.TotalSeconds
            Write-Host "[$([DateTime]::UtcNow.ToString('o'))] Waiting for $Name (PID $($Process.Id), ${lastProgress}s elapsed)"
        }
        # Yield to PowerShell so cancellation can interrupt a stalled installer.
        # A synchronous native WaitForExit can prevent the host from responding.
        Start-Sleep -Milliseconds 100
    }
}

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
    $process = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -PassThru -NoNewWindow `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    Write-Host "[$([DateTime]::UtcNow.ToString('o'))] Launched $Name (PID $($process.Id))"
    try {
        # Windows PowerShell 5.1 otherwise loses the exit code after the child exits.
        $null = $process.Handle
        # Start-Process -Wait waits for descendants as well. An unrelated
        # background child must not keep a completed installer check alive.
        if (-not (Wait-SmokeProcessExit -Process $process -TimeoutSeconds $TimeoutSeconds -Name $Name)) {
            Write-Host "$Name timed out; terminating process tree $($process.Id)"
            $kill = Start-Process -FilePath "$env:SystemRoot\System32\taskkill.exe" `
                -ArgumentList @('/PID', [string]$process.Id, '/T', '/F') -PassThru -NoNewWindow
            try {
                if (-not (Wait-SmokeProcessExit -Process $kill -TimeoutSeconds 10 -Name "$Name process-tree termination")) {
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
