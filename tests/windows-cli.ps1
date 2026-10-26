param(
  [Parameter(Mandatory)][string]$Path,
  [Parameter(Mandatory)][string]$ExpectedVersion
)

$ErrorActionPreference = "Stop"
$binary = (Resolve-Path -LiteralPath $Path).Path
$version = & $binary --version
if ($LASTEXITCODE -ne 0 -or "$version".Trim() -cne $ExpectedVersion) { throw "Executable version mismatch" }
& $binary --help
if ($LASTEXITCODE -ne 0) { throw "Executable could not start" }
$output = "dist/examples/led-resistor"
if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Recurse -Force }
& $binary build examples/led-resistor.circuit.tsx --ignore-errors --concurrency 2 --pcb-png
if ($LASTEXITCODE -ne 0) { throw "Executable worker/WASM check failed" }
$circuit = Get-Content -LiteralPath "$output/circuit.json" -Raw | ConvertFrom-Json
if (@($circuit).Count -eq 0) { throw "No circuit build output" }
$png = [System.IO.File]::ReadAllBytes((Join-Path (Get-Location) "$output/pcb.png"))
if ($png.Length -lt 8 -or [BitConverter]::ToString($png, 0, 8) -cne "89-50-4E-47-0D-0A-1A-0A") {
  throw "WASM renderer did not generate a PNG"
}
