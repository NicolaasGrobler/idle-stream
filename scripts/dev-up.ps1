#requires -Version 5
<#
.SYNOPSIS
  Start the full studio stack: MediaMTX, the control service, and the two
  HTTPS dev-servers (phone + operator). Logs go to .\logs.
#>
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root

if (-not (Test-Path "$root\tools\mediamtx.exe")) { throw "Missing tools. Run .\setup\fetch-tools.ps1" }
if (-not (Test-Path "$root\certs\server-cert.pem")) { throw "Missing certs. Run .\setup\make-certs.ps1" }
if (-not (Test-Path "$root\control\.venv\Scripts\python.exe")) { throw "Missing control venv. Create it: python -m venv control\.venv; control\.venv\Scripts\pip install -r control\requirements.txt" }

$logs = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null

function Start-Svc($name, $file, $svcArgs, $wd) {
    Start-Process -FilePath $file -ArgumentList $svcArgs -WorkingDirectory $wd -WindowStyle Hidden `
        -RedirectStandardOutput "$logs\$name.out.log" -RedirectStandardError "$logs\$name.err.log"
    Write-Host "  started $name"
}

Write-Host "Starting studio stack..."
Start-Svc 'mediamtx' "$root\tools\mediamtx.exe" @('mediamtx\mediamtx.yml') $root
Start-Svc 'control'  "$root\control\.venv\Scripts\python.exe" @('-m','uvicorn','app.main:app','--host','127.0.0.1','--port','9000') "$root\control"
Start-Svc 'phone'    'node' @('dev-server.mjs','phone-pwa','8443') $root
Start-Svc 'operator' 'node' @('dev-server.mjs','operator-dashboard','8444') $root

Start-Sleep -Seconds 2
$ip = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -match '^(192\.168\.|10\.)' -and $_.InterfaceAlias -notmatch 'vEthernet|Loopback' } |
    Sort-Object { if ($_.IPAddress -like '192.168.*') { 0 } else { 1 } } |
    Select-Object -First 1 -ExpandProperty IPAddress)

Write-Host ""
Write-Host "Stack up." -ForegroundColor Green
Write-Host "  Phones:   https://${ip}:8443/"
Write-Host "  Operator: https://localhost:8444/   (or https://${ip}:8444/)"
Write-Host "  Logs:     .\logs\*.log"
Write-Host "  Stop:     .\scripts\dev-down.ps1"
