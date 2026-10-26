param(
  [Parameter(Mandatory)][string]$Path,
  [string]$ExpectedPublisher = "tscircuit Inc"
)

$ErrorActionPreference = "Stop"
$binary = (Resolve-Path -LiteralPath $Path).Path
$signature = Get-AuthenticodeSignature -LiteralPath $binary
if ($signature.Status -ne "Valid" -or $signature.SignatureType -ne "Authenticode") {
  throw "Invalid embedded Authenticode signature: $($signature.Status)"
}
$publisher = $signature.SignerCertificate.GetNameInfo(
  [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false
)
if ($publisher -cne $ExpectedPublisher) {
  throw "Unexpected signing publisher: $publisher"
}
if ($null -eq $signature.TimeStamperCertificate) {
  throw "The signature has no trusted timestamp"
}
$usage = $signature.SignerCertificate.Extensions |
  Where-Object { $_.Oid.Value -eq "2.5.29.37" }
if ("1.3.6.1.5.5.7.3.3" -notin @($usage.EnhancedKeyUsages | ForEach-Object { $_.Value })) {
  throw "The certificate does not permit code signing"
}

[pscustomobject]@{
  status = "Verified"
  signatureType = "Authenticode"
  publisher = $publisher
  sha256 = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
  certificateSubject = $signature.SignerCertificate.Subject
  certificateThumbprint = $signature.SignerCertificate.Thumbprint
  timestampSubject = $signature.TimeStamperCertificate.Subject
  timestampThumbprint = $signature.TimeStamperCertificate.Thumbprint
}
