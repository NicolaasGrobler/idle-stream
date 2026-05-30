# Wireless Multicam Studio - system-tray launcher (Windows).
#
# Launched HIDDEN by the installed shortcut:
#   powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File tray.ps1
# It starts the studio in the background (no console window), shows a tray icon,
# and exposes the URLs + Stop from the icon's right-click menu. multicam.exe is
# the engine; this script just drives `up` / `down` / `urls` / `certs`.
#
# Keep the default 'Continue' error action: multicam writes informational notices
# (e.g. "Multiple LAN IPs found") to stderr, and under 'Stop' PowerShell 5.1 turns
# native stderr into a TERMINATING error - which would abort startup. Native
# command stderr is also redirected to $null at each call site below.
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$AppDir = $PSScriptRoot
$Exe    = Join-Path $AppDir 'multicam.exe'
$IcoPath = Join-Path $AppDir 'multicam.ico'

# Version stamped into the exe (single source of truth = package.json), shown in
# the tray menu + tooltip so the running build is visible in the app itself.
$script:appVer = ''
try { if (Test-Path $Exe) { $script:appVer = (Get-Item $Exe).VersionInfo.ProductVersion } } catch {}

$script:phoneUrl = 'https://localhost:8443/'
$script:operatorUrl = 'https://studio.localhost:8444/'
$script:running = $false

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = if (Test-Path $IcoPath) { New-Object System.Drawing.Icon($IcoPath) } else { [System.Drawing.SystemIcons]::Application }
$notify.Text = if ($script:appVer) { "Wireless Multicam Studio v$script:appVer" } else { 'Wireless Multicam Studio' }
$notify.Visible = $true

function Balloon($title, $msg, $level = 'Info') {
  $notify.BalloonTipTitle = $title
  $notify.BalloonTipText = $msg
  $notify.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::$level
  $notify.ShowBalloonTip(4000)
}

function Refresh-Urls {
  try {
    $out = & $Exe urls 2>$null
    foreach ($line in $out) {
      if ($line -like 'phone=*')    { $script:phoneUrl = $line.Substring(6) }
      if ($line -like 'operator=*') { $script:operatorUrl = $line.Substring(9) }
    }
  } catch {}
}

function Start-Stack {
  Refresh-Urls
  & $Exe up 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) {
    $script:running = $true
    $notify.Text = 'Wireless Multicam Studio - running'   # NotifyIcon.Text caps at 64 chars; URL lives in the balloon + menu
    Balloon 'Wireless Multicam Studio' "Running.`nOperator: $script:operatorUrl`nRight-click the tray icon for options."
  } else {
    $script:running = $false
    Balloon 'First-time setup needed' 'Click the tray icon and choose "First-time HTTPS setup" once.' 'Warning'
  }
}

function Stop-Stack {
  & $Exe down 2>$null | Out-Null
  $script:running = $false
}

# ---- tray menu ----
$menu = New-Object System.Windows.Forms.ContextMenuStrip
if ($script:appVer) {
  $miVer = $menu.Items.Add("Wireless Multicam Studio  v$script:appVer")
  $miVer.Enabled = $false
  [void]$menu.Items.Add('-')
}
$miOpen = $menu.Items.Add('Open Operator Dashboard')
$miOpen.add_Click({ Start-Process $script:operatorUrl })
$miPhone = $menu.Items.Add('Open Device Page')
$miPhone.add_Click({ Start-Process $script:phoneUrl })
$miQr = $menu.Items.Add('Show Device QR (scan to connect)')
$miQr.add_Click({ Start-Process ($script:phoneUrl.TrimEnd('/') + '/connect.html') })
$miUrls = $menu.Items.Add('Show URLs')
$miUrls.add_Click({
  [System.Windows.Forms.MessageBox]::Show(
    "Operator (this PC):`n$script:operatorUrl`n`nDevices (same WiFi):`n$script:phoneUrl",
    'Wireless Multicam Studio', 'OK', 'Information') | Out-Null
})
[void]$menu.Items.Add('-')
$miCert = $menu.Items.Add('First-time HTTPS setup')
$miCert.add_Click({
  # NOTE: this still blocks the UI thread while certs (UAC elevation + mkcert)
  # runs — the tray will show busy until it returns. The try/catch only stops a
  # failure from killing the message loop; the real fix is to run this off-thread.
  try {
    & $Exe certs 2>$null | Out-Null   # self-elevates (UAC) on the packaged exe
    Start-Stack                       # then bring the studio up
  } catch {
    Balloon 'Setup failed' "First-time HTTPS setup couldn't finish. See $AppDir\logs." 'Error'
  }
})
[void]$menu.Items.Add('-')
$miQuit = $menu.Items.Add('Stop && Quit')
$miQuit.add_Click({
  Stop-Stack
  $notify.Visible = $false
  $notify.Dispose()
  [System.Windows.Forms.Application]::Exit()
})
$notify.ContextMenuStrip = $menu
# Left double-click opens the dashboard.
$notify.add_MouseDoubleClick({ Start-Process $script:operatorUrl })

# Make sure the stack goes down whenever the tray exits - Application.Exit, an
# unhandled exception, the PowerShell host shutting down. (Task Manager force-kill
# can't run handlers; the start-up check below catches that case on next launch.)
[System.Windows.Forms.Application]::add_ApplicationExit({ Stop-Stack })
Register-EngineEvent PowerShell.Exiting -Action { Stop-Stack } | Out-Null

# If a previous tray left orphaned services running (e.g. it was force-killed),
# stop them before starting fresh so the new tray owns a clean stack.
$busy = $false
foreach ($p in 8443,8444,8889,9000) {
  if (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) { $busy = $true; break }
}
if ($busy) { & $Exe down 2>$null | Out-Null }

try { Start-Stack } catch { Balloon 'Startup error' "The studio failed to start. See $AppDir\logs." 'Error' }
try { [System.Windows.Forms.Application]::Run() }
finally { Stop-Stack }
