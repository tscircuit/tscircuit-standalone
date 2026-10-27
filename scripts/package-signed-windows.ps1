param(
  [string]$Dist = (Join-Path $PSScriptRoot "../dist"),
  [Parameter(Mandatory)][string]$Notices,
  [Parameter(Mandatory)][string]$ExpectedVersion,
  [Parameter(Mandatory)][string]$UninstallerReceipt
)

$ErrorActionPreference = "Stop"
$Dist = (Resolve-Path -LiteralPath $Dist).Path
$receipt = & (Join-Path $PSScriptRoot "verify-windows-signature.ps1") -Path (Join-Path $Dist "tsci.exe")
$files = @("tsci.exe", "LICENSE", "THIRD_PARTY_NOTICES", "licenses.json", "THIRD_PARTY_NOTICES.txt")
foreach ($name in $files) {
  if ((Get-Item -LiteralPath (Join-Path $Dist $name)).Length -eq 0) {
    throw "Empty Windows release input: $name"
  }
}
if ((Get-Item -LiteralPath $Notices).Length -eq 0) { throw "Empty companion notices" }
if (!$env:GITHUB_SHA -or !$env:GITHUB_RUN_ID) { throw "Missing signing run provenance" }

$output = Join-Path $Dist "release"
New-Item -ItemType Directory -Force -Path $output | Out-Null
$direct = Join-Path $output "tsci-windows-x64.exe"
Copy-Item -LiteralPath (Join-Path $Dist "tsci.exe") -Destination $direct
Copy-Item -LiteralPath $Notices -Destination (Join-Path $output "tsci-windows-x64.notices.txt")
$archive = Join-Path $output "tscircuit-standalone-windows-x64.zip"
Compress-Archive -LiteralPath @($files | ForEach-Object { Join-Path $Dist $_ }) -DestinationPath $archive -Force

$zip = [System.IO.Compression.ZipFile]::OpenRead($archive)
try {
  if ((@($zip.Entries.FullName | Sort-Object) -join "`n") -cne (($files | Sort-Object) -join "`n")) {
    throw "Unexpected Windows ZIP contents"
  }
  $stream = $zip.GetEntry("tsci.exe").Open()
  try {
    $archivedHash = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant()
  } finally { $stream.Dispose() }
  if ($archivedHash -cne $receipt.sha256) { throw "ZIP does not contain the verified signed executable" }
} finally { $zip.Dispose() }
if ((Get-FileHash -LiteralPath $direct -Algorithm SHA256).Hash.ToLowerInvariant() -cne $receipt.sha256) {
  throw "Direct download differs from the verified signed executable"
}
$receipt | Add-Member -NotePropertyMembers @{
  provider = "Azure Artifact Signing"
  version = $ExpectedVersion
  sourceCommit = $env:GITHUB_SHA
  runId = $env:GITHUB_RUN_ID
}
$receipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output "tsci-windows-x64.signing.json") -Encoding utf8
$uninstaller = Get-Content -LiteralPath $UninstallerReceipt -Raw | ConvertFrom-Json
if ($uninstaller.status -cne 'Verified' -or $uninstaller.signatureType -cne 'Authenticode' -or
    $uninstaller.publisher -cne $receipt.publisher -or $uninstaller.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
    -not $uninstaller.certificateThumbprint -or -not $uninstaller.timestampThumbprint) {
  throw 'Missing verified installed uninstaller signature'
}
$installer = Join-Path $output 'tscircuit-standalone-windows-x64-setup.exe'
$installerReceipt = & (Join-Path $PSScriptRoot 'verify-windows-signature.ps1') -Path $installer
$installerReceipt | Add-Member -NotePropertyMembers @{
  provider = 'Azure Artifact Signing'
  version = $ExpectedVersion
  sourceCommit = $env:GITHUB_SHA
  runId = $env:GITHUB_RUN_ID
  binarySha256 = $receipt.sha256
  uninstaller = $uninstaller
}
$installerReceipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$installer.signing.json" -Encoding utf8
Write-Host "Packaged verified Windows executable: $($receipt.sha256)"
Write-Host "Packaged verified Windows installer: $($installerReceipt.sha256)"
