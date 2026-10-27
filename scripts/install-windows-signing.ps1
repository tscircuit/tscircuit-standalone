$ErrorActionPreference = 'Stop'
$version = '0.1.8'

if (Get-Module -ListAvailable -Name ArtifactSigning | Where-Object Version -EQ $version) {
    Import-Module ArtifactSigning -RequiredVersion $version -ErrorAction Stop
    Write-Host "Using ArtifactSigning $version."
    return
}

for ($attempt = 1; $attempt -le 5; $attempt++) {
    try {
        Install-Module -Name ArtifactSigning -RequiredVersion $version -Scope CurrentUser -Force -Repository PSGallery -ErrorAction Stop
    } catch {
        if ($attempt -eq 5) { throw "Cannot install ArtifactSigning $version after $attempt attempts: $($_.Exception.Message)" }
        $delay = 5 * [Math]::Pow(2, $attempt - 1)
        Write-Warning "ArtifactSigning download failed (attempt $attempt/5): $($_.Exception.Message). Retrying in $delay seconds."
        Start-Sleep -Seconds $delay
        continue
    }
    Import-Module ArtifactSigning -RequiredVersion $version -ErrorAction Stop
    Write-Host "Installed ArtifactSigning $version."
    return
}
