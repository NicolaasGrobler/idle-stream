#requires -Version 5
<#
.SYNOPSIS
  Generate a locally-trusted TLS cert (via mkcert) for the studio server,
  bound to the laptop's LAN IP so phones can reach getUserMedia over HTTPS.

.DESCRIPTION
  1. Verifies mkcert is installed.
  2. Installs the mkcert local CA into this machine's trust store.
  3. Issues a leaf cert for the LAN IP (auto-detected or passed via -Ip).
  4. Copies rootCA.pem next to the leaf cert for distribution to phones.

.EXAMPLE
  .\make-certs.ps1
  .\make-certs.ps1 -Ip 192.168.8.10
#>
[CmdletBinding()]
param(
    [string]$Ip,
    [string]$OutDir = (Join-Path $PSScriptRoot '..\certs')
)

$ErrorActionPreference = 'Stop'

# 1. Locate mkcert: prefer the local .\tools copy, fall back to PATH.
$localMkcert = Join-Path $PSScriptRoot '..\tools\mkcert.exe'
if (Test-Path $localMkcert) {
    $mkcert = (Resolve-Path $localMkcert).Path
} elseif (Get-Command mkcert -ErrorAction SilentlyContinue) {
    $mkcert = 'mkcert'
} else {
    Write-Host "mkcert not found. Fetch it first:" -ForegroundColor Yellow
    Write-Host "  .\setup\fetch-tools.ps1" -ForegroundColor Yellow
    exit 1
}

# 2. Resolve the LAN IP (shared with dev-up.ps1 so the two never drift).
. (Join-Path $PSScriptRoot 'lan-ip.ps1')
$Ip = Get-LanIP -Ip $Ip

Write-Host "Binding certificate to LAN IP: $Ip" -ForegroundColor Cyan

# 3. Install the local CA (modifies this machine's trust store; may prompt)
& $mkcert -install

# 4. Issue the leaf cert
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
Push-Location $OutDir
try {
    & $mkcert -cert-file 'server-cert.pem' -key-file 'server-key.pem' $Ip 'localhost' '127.0.0.1'
} finally {
    Pop-Location
}

# 5. Copy the root CA for phone distribution
$caRoot = (& $mkcert -CAROOT).Trim()
Copy-Item -Path (Join-Path $caRoot 'rootCA.pem') -Destination (Join-Path $OutDir 'rootCA.pem') -Force

# 6. Record which IP this cert was issued for so dev-up.ps1 can detect a
#    network change and re-issue the leaf automatically.
Set-Content -Path (Join-Path $OutDir '.lan-ip') -Value $Ip -Encoding ascii -NoNewline

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "  Cert:    $OutDir\server-cert.pem"
Write-Host "  Key:     $OutDir\server-key.pem"
Write-Host "  Root CA: $OutDir\rootCA.pem   (install this on each phone)"
Write-Host ""
Write-Host "Phone setup (one-time):"
Write-Host "  iOS:     transfer rootCA.pem (AirDrop/email) -> install profile,"
Write-Host "           then Settings > General > About > Certificate Trust Settings -> enable full trust"
Write-Host "  Android: Settings > Security > Encryption & credentials > Install a certificate > CA certificate"
Write-Host ""
Write-Host "Then start the stack:  .\scripts\dev-up.ps1"
Write-Host "On phone:  https://$Ip`:8443/"
