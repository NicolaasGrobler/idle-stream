#requires -Version 5
# Stop the studio stack by freeing its ports.
$ports = 8443, 8444, 8889, 9000
foreach ($port in $ports) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
        Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
        Write-Host "stopped PID $($_.OwningProcess) on :$port"
    }
}
Write-Host "Stack stopped."
