#requires -Version 5
<#
.SYNOPSIS
  Download the binary tools the studio needs (mkcert, MediaMTX) into .\tools.
  These are gitignored (large binaries), so run this once after cloning.
#>
[CmdletBinding()]
param(
    [string]$MediaMtxVersion = "v1.18.2",
    [string]$MkcertVersion = "v1.4.4"
)
$ErrorActionPreference = 'Stop'
$tools = Join-Path $PSScriptRoot '..\tools'
New-Item -ItemType Directory -Force -Path $tools | Out-Null

# mkcert (single exe)
$mkcert = Join-Path $tools 'mkcert.exe'
if (-not (Test-Path $mkcert)) {
    Write-Host "Downloading mkcert $MkcertVersion..."
    Invoke-WebRequest -Uri "https://github.com/FiloSottile/mkcert/releases/download/$MkcertVersion/mkcert-$MkcertVersion-windows-amd64.exe" -OutFile $mkcert
}

# MediaMTX (zip with exe + default config)
$mtx = Join-Path $tools 'mediamtx.exe'
if (-not (Test-Path $mtx)) {
    Write-Host "Downloading MediaMTX $MediaMtxVersion..."
    $zip = Join-Path $tools 'mediamtx.zip'
    Invoke-WebRequest -Uri "https://github.com/bluenviron/mediamtx/releases/download/$MediaMtxVersion/mediamtx_${MediaMtxVersion}_windows_amd64.zip" -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $tools -Force
    Remove-Item $zip
    # We ship our own config in mediamtx\mediamtx.yml; drop the bundled default.
    Remove-Item (Join-Path $tools 'mediamtx.yml') -ErrorAction SilentlyContinue
}

Write-Host "Tools ready in $tools" -ForegroundColor Green
Get-ChildItem $tools | Select-Object Name, Length | Format-Table -AutoSize
