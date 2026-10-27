param([Parameter(Mandatory)][string]$Path)

$ErrorActionPreference = 'Stop'
# Shared by CLI, installer and uninstaller signing.
Import-Module ArtifactSigning -RequiredVersion 0.1.8
$parameters = @{
    Endpoint = $env:AZURE_SIGNING_ENDPOINT
    CodeSigningAccountName = $env:AZURE_SIGNING_ACCOUNT
    CertificateProfileName = $env:AZURE_SIGNING_PROFILE
    Files = (Resolve-Path -LiteralPath $Path).Path
    FileDigest = 'SHA256'
    TimestampRfc3161 = 'http://timestamp.acs.microsoft.com'
    TimestampDigest = 'SHA256'
    ExcludeEnvironmentCredential = $true
    ExcludeWorkloadIdentityCredential = $true
    ExcludeManagedIdentityCredential = $true
    ExcludeSharedTokenCacheCredential = $true
    ExcludeVisualStudioCredential = $true
    ExcludeVisualStudioCodeCredential = $true
    ExcludeAzureCliCredential = $false
    ExcludeAzurePowerShellCredential = $true
    ExcludeAzureDeveloperCliCredential = $true
    ExcludeInteractiveBrowserCredential = $true
}
Invoke-ArtifactSigning @parameters
& "$PSScriptRoot/../verify-windows-signature.ps1" -Path $Path | Out-Null
