param([Parameter(Mandatory = $true)][string]$Destination)
$ErrorActionPreference = 'Stop'
$version = '7.1.0'
$checksum = '0362a383ed217d4c4239b5933866dd96d3eb2102737da92f80f6057a4b40df2f'
$download = Join-Path ([IO.Path]::GetTempPath()) ('innosetup-' + [Guid]::NewGuid() + '.exe')
try {
    Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/jrsoftware/issrc/releases/download/is-7_1_0/innosetup-$version-x64.exe" -OutFile $download
    if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant() -ne $checksum) {
        throw 'Inno Setup download checksum mismatch'
    }
    $process = Start-Process -FilePath $download -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER', ('/DIR="' + $Destination + '"')) -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Inno Setup installation failed: $($process.ExitCode)" }
    $compiler = Join-Path $Destination 'ISCC.exe'
    if (-not (Test-Path -LiteralPath $compiler)) { throw 'ISCC.exe is missing' }
    if ($env:GITHUB_ENV) { "ISCC=$compiler" | Out-File -LiteralPath $env:GITHUB_ENV -Append -Encoding utf8 }
    Write-Output $compiler
} finally {
    Remove-Item -LiteralPath $download -ErrorAction SilentlyContinue
}
