# Wireless Multicam Studio — system-tray launcher (Windows).
#
# Launched HIDDEN by the installed shortcut:
#   powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File tray.ps1
# It starts the studio in the background (no console window), shows a tray icon,
# and exposes the URLs + Stop from the icon's right-click menu. multicam.exe is
# the engine; this script just drives `up` / `down` / `urls` / `certs`.
#
# Keep the default 'Continue' error action: multicam writes informational notices
# (e.g. "Multiple LAN IPs found") to stderr, and under 'Stop' PowerShell 5.1 turns
# native stderr into a TERMINATING error — which would abort startup. Native
# command stderr is also redirected to $null at each call site below.
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$AppDir = $PSScriptRoot
$Exe    = Join-Path $AppDir 'multicam.exe'
$IcoPath = Join-Path $AppDir 'multicam.ico'

$script:phoneUrl = 'https://localhost:8443/'
$script:operatorUrl = 'https://studio.localhost:8444/'
$script:running = $false

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = if (Test-Path $IcoPath) { New-Object System.Drawing.Icon($IcoPath) } else { [System.Drawing.SystemIcons]::Application }
$notify.Text = 'Wireless Multicam Studio'
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
    $notify.Text = "Wireless Multicam Studio — running`n$script:operatorUrl"
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
$miOpen = $menu.Items.Add('Open Operator Dashboard')
$miOpen.add_Click({ Start-Process $script:operatorUrl })
$miPhone = $menu.Items.Add('Open Phone Camera Page')
$miPhone.add_Click({ Start-Process $script:phoneUrl })
$miUrls = $menu.Items.Add('Show URLs')
$miUrls.add_Click({
  [System.Windows.Forms.MessageBox]::Show(
    "Operator (this PC):`n$script:operatorUrl`n`nPhones (same WiFi):`n$script:phoneUrl",
    'Wireless Multicam Studio', 'OK', 'Information') | Out-Null
})
[void]$menu.Items.Add('-')
$miCert = $menu.Items.Add('First-time HTTPS setup')
$miCert.add_Click({
  & $Exe certs 2>$null | Out-Null   # self-elevates (UAC) on the packaged exe
  Start-Stack                       # then bring the studio up
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

Start-Stack
[System.Windows.Forms.Application]::Run()
