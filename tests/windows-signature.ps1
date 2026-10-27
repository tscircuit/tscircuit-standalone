param([Parameter(Mandatory)][string]$Path)

$ErrorActionPreference = "Stop"
$verify = Join-Path $PSScriptRoot "../scripts/verify-windows-signature.ps1"
& $verify -Path $Path | Out-Null
$rejected = $false
try { & $verify -Path $Path -ExpectedPublisher "Wrong publisher" | Out-Null }
catch { $rejected = $true }
if (!$rejected) { throw "Wrong publisher was accepted" }

$tampered = Join-Path $env:RUNNER_TEMP "tampered-tsci.exe"
try {
  Copy-Item -LiteralPath $Path -Destination $tampered
  $stream = [System.IO.File]::Open($tampered, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite)
  try {
    # Change a hashed DOS stub byte, leaving the PE and certificate parseable.
    $stream.Position = 0x40
    $value = $stream.ReadByte()
    $stream.Position = 0x40
    $stream.WriteByte($value -bxor 1)
  } finally { $stream.Dispose() }
  $rejected = $false
  try { & $verify -Path $tampered | Out-Null }
  catch { $rejected = $true }
  if (!$rejected) { throw "A modified signed binary was accepted" }
} finally { Remove-Item -LiteralPath $tampered -Force -ErrorAction SilentlyContinue }
Write-Host "Valid signature accepted; wrong publisher and modified executable rejected."
