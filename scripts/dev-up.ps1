#requires -Version 5
<#
.SYNOPSIS
  Start the full studio stack: MediaMTX, the control service, and the two
  HTTPS dev-servers (phone + operator). Logs go to .\logs.

.DESCRIPTION
  Detects the LAN IP, keeps the TLS cert and MediaMTX's advertised WebRTC host
  in sync with it (re-issuing the leaf cert automatically if the network
  changed), then launches everything. No per-network hand-editing required.

.EXAMPLE
  .\dev-up.ps1
  .\dev-up.ps1 -Ip 10.0.0.5      # force a specific LAN IP
#>
[CmdletBinding()]
param([string]$Ip)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root
. (Join-Path $root 'setup\lan-ip.ps1')

if (-not (Test-Path "$root\tools\mediamtx.exe")) { throw "Missing tools. Run .\setup\fetch-tools.ps1" }
if (-not (Test-Path "$root\certs\server-cert.pem")) { throw "Missing certs. Run .\setup\make-certs.ps1" }

$logs = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null

# --- Resolve the LAN IP up front; everything below keys off it -------------
$ip = Get-LanIP -Ip $Ip

# --- Keep the TLS cert bound to the current LAN IP -------------------------
# The cert's IP is baked into a SAN; if the network changed since make-certs ran,
# iOS silently blocks the camera. Re-issue the leaf (the mkcert CA is unchanged,
# so phones stay trusted — no re-install needed).
$ipFile = Join-Path $root 'certs\.lan-ip'
$certIp = if (Test-Path $ipFile) { (Get-Content $ipFile -Raw).Trim() } else { '' }
if ($certIp -ne $ip) {
    $mkcert = if (Test-Path "$root\tools\mkcert.exe") { "$root\tools\mkcert.exe" }
              elseif (Get-Command mkcert -ErrorAction SilentlyContinue) { 'mkcert' } else { $null }
    if ($mkcert) {
        Write-Host "LAN IP changed ($certIp -> $ip); re-issuing TLS cert..." -ForegroundColor Yellow
        Push-Location "$root\certs"
        try { & $mkcert -cert-file 'server-cert.pem' -key-file 'server-key.pem' $ip 'localhost' '127.0.0.1' }
        finally { Pop-Location }
        Set-Content -Path $ipFile -Value $ip -Encoding ascii -NoNewline
    } else {
        Write-Host "WARNING: cert was issued for '$certIp' but the LAN IP is '$ip', and mkcert is missing." -ForegroundColor Red
        Write-Host "         iOS may block the camera. Run .\setup\fetch-tools.ps1 then .\setup\make-certs.ps1." -ForegroundColor Red
    }
}

# --- Render MediaMTX config with the detected IP ---------------------------
# The committed mediamtx.yml is network-agnostic (webrtcAdditionalHosts: []);
# inject the LAN IP here so it's explicitly advertised as a WebRTC host.
$mtxGen = Join-Path $root 'mediamtx\mediamtx.gen.yml'
$cfg = Get-Content (Join-Path $root 'mediamtx\mediamtx.yml') -Raw
$cfg = $cfg -replace '(?m)^webrtcAdditionalHosts:.*$', "webrtcAdditionalHosts: [$ip]"
[System.IO.File]::WriteAllText($mtxGen, $cfg, (New-Object System.Text.UTF8Encoding $false))

function Start-Svc($name, $file, $svcArgs, $wd) {
    Start-Process -FilePath $file -ArgumentList $svcArgs -WorkingDirectory $wd -WindowStyle Hidden `
        -RedirectStandardOutput "$logs\$name.out.log" -RedirectStandardError "$logs\$name.err.log"
    Write-Host "  started $name"
}

Write-Host "Starting studio stack (LAN IP $ip)..."
Start-Svc 'mediamtx' "$root\tools\mediamtx.exe" @('mediamtx\mediamtx.gen.yml') $root
Start-Svc 'control'  'node' @('control\index.mjs') $root
Start-Svc 'phone'    'node' @('dev-server.mjs','phone-pwa','8443') $root
Start-Svc 'operator' 'node' @('dev-server.mjs','operator-dashboard','8444') $root

Start-Sleep -Seconds 2

Write-Host ""
Write-Host "Stack up." -ForegroundColor Green
Write-Host "  Phones:   https://${ip}:8443/"
Write-Host "  Operator: https://localhost:8444/   (or https://${ip}:8444/)"
Write-Host "  Logs:     .\logs\*.log"
Write-Host "  Stop:     .\scripts\dev-down.ps1"
