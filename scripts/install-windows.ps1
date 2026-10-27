# Download the standard Windows installer with curl.exe or Invoke-WebRequest,
# then run this script with Windows PowerShell 5.1 or newer.
param(
    [string]$Release = 'latest',
    [switch]$Silent,
    [switch]$ReplaceExisting
)
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This installer is for Windows.' }
if ($Release -ne 'latest' -and $Release -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw 'Invalid release tag' }
$repository = 'https://api.github.com/repos/tscircuit/tscircuit-standalone'
if ($Release -eq 'latest') {
    # Development releases are prereleases and absent from GitHub's /latest endpoint.
    $releases = Invoke-RestMethod -Uri "$repository/releases?per_page=1" -TimeoutSec 60
    $selected = @($releases)[0]
} else {
    $selected = Invoke-RestMethod -Uri "$repository/releases/tags/$Release" -TimeoutSec 60
}
if (-not $selected -or $selected.draft) { throw 'No published release with a Windows installer was found' }
if ($selected.tag_name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw 'Invalid published release tag' }
$name = 'tscircuit-standalone-windows-x64-setup.exe'
$asset = @($selected.assets | Where-Object name -eq $name)
$sums = @($selected.assets | Where-Object name -eq 'SHA256SUMS')
if ($asset.Count -ne 1 -or $sums.Count -ne 1) { throw 'Release is missing its installer or checksums' }
# Download only official release URLs, not an arbitrary URL supplied through metadata.
$base = 'https://github.com/tscircuit/tscircuit-standalone/releases/download/' + $selected.tag_name
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('tsci-download-' + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
    $manifestFile = Join-Path $temporary 'SHA256SUMS'
    Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $manifestFile -TimeoutSec 300
    $manifest = Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8
    $checksumMatches = @([regex]::Matches($manifest, '(?m)^([a-fA-F0-9]{64})\s+\*?' + [regex]::Escape($name) + '\r?$'))
    if ($checksumMatches.Count -ne 1) { throw 'Installer checksum is missing or ambiguous' }
    $installer = Join-Path $temporary $name
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$name" -OutFile $installer -TimeoutSec 300
    if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne $checksumMatches[0].Groups[1].Value) { throw 'Installer checksum mismatch' }
    $signature = Get-AuthenticodeSignature -LiteralPath $installer
    if ($signature.Status -ne 'Valid' -or $signature.SignatureType -ne 'Authenticode' -or -not $signature.SignerCertificate -or -not $signature.TimeStamperCertificate) {
        throw 'Installer must have a valid timestamped Authenticode signature'
    }
    if ($signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -cne 'tscircuit Inc') {
        throw 'Unexpected installer signing identity'
    }
    $arguments = @('/NORESTART')
    if ($Silent) { $arguments += @('/VERYSILENT', '/SUPPRESSMSGBOXES') }
    if ($ReplaceExisting) { $arguments += '/TASKS=replacecommands' }
    $process = Start-Process -FilePath $installer -ArgumentList $arguments -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Installer exited with code $($process.ExitCode)" }
    $env:Path = [Environment]::ExpandEnvironmentVariables([Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User'))
    Write-Output 'Installed tscircuit standalone. Open a new terminal and run tsci --version or tscircuit --version.'
} finally {
    Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
