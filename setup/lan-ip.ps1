#requires -Version 5
<#
.SYNOPSIS
  Shared LAN IP detection. Dot-source this file, then call Get-LanIP.

  Dot-source:  . "$PSScriptRoot\..\setup\lan-ip.ps1"
  Use:         $ip = Get-LanIP            # auto-detect
               $ip = Get-LanIP -Ip 10.0.0.5   # explicit override

  Both make-certs.ps1 (cert SAN) and dev-up.ps1 (WebRTC host + URLs) use this so
  the detected address never drifts between them.
#>

function Get-LanIP {
    [CmdletBinding()]
    param([string]$Ip)

    if ($Ip) { return $Ip }

    # Private IPv4 ranges, ignoring virtual/loopback adapters (Hyper-V, WSL, etc.)
    $candidates = @(
        Get-NetIPAddress -AddressFamily IPv4 |
            Where-Object {
                $_.IPAddress -match '^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)' -and
                $_.InterfaceAlias -notmatch 'vEthernet|Loopback|WSL'
            } |
            Select-Object -ExpandProperty IPAddress
    )
    # Prefer 192.168.x, then 10.x, then 172.16-31.x
    $candidates = @($candidates | Sort-Object {
        if ($_ -like '192.168.*') { 0 } elseif ($_ -like '10.*') { 1 } else { 2 }
    })

    if ($candidates.Count -eq 0) { throw "Could not auto-detect a LAN IP. Re-run with -Ip <addr>." }
    if ($candidates.Count -gt 1) {
        Write-Host "Multiple LAN IPs found: $($candidates -join ', ')." -ForegroundColor Yellow
        Write-Host "Using $($candidates[0]). Re-run with -Ip <addr> to pick another." -ForegroundColor Yellow
    }
    return $candidates[0]
}
