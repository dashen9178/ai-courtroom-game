# setup-ngrok.ps1 -- switch public access from cloudflared to ngrok.
#
# Why: this machine's network interferes with Cloudflare edge port 7844
# ("TLS handshake with edge error: read tcp ...:7844: i/o timeout"), so quick
# tunnels flap and the URL keeps changing. ngrok tunnels over 443, which works
# fine here (measured 630-2280ms).
#
# What you need to do once, by hand (I cannot do it for you -- it needs your account):
#   1. Sign up at https://ngrok.com  (free)
#   2. Copy your authtoken from https://dashboard.ngrok.com/get-started/your-authtoken
#   3. Run this script and paste the token when asked
#
# ASCII-only on purpose: powershell.exe reads a BOM-less .ps1 as ANSI.
param(
  [string]$Token = ""
)

$ErrorActionPreference = 'Continue'
$Root     = $PSScriptRoot
$GameDir  = Join-Path $Root 'game'
$ToolsDir = Join-Path (Split-Path -Parent $Root) 'tools'
$NgrokExe = Join-Path $ToolsDir 'ngrok.exe'
$LogDir   = Join-Path $Root 'logs'
$UrlFile  = Join-Path $Root 'public-url.txt'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if (-not (Test-Path $NgrokExe)) {
  Write-Output ''
  Write-Output '  ngrok.exe not found at:'
  Write-Output "    $NgrokExe"
  Write-Output ''
  Write-Output '  Download it from https://ngrok.com/download and put ngrok.exe there,'
  Write-Output '  or unzip the windows-amd64 archive into that folder.'
  Write-Output ''
  exit 1
}

if (-not $Token) {
  Write-Output ''
  Write-Output '  Paste your ngrok authtoken (from https://dashboard.ngrok.com/get-started/your-authtoken)'
  Write-Output '  Leave empty to skip configuration if you already ran "ngrok config add-authtoken".'
  Write-Output ''
  $Token = Read-Host '  authtoken'
}

if ($Token) {
  & $NgrokExe config add-authtoken $Token 2>&1 | ForEach-Object { "  $_" }
  Write-Output '  authtoken saved.'
}

# ---- write the ngrok supervisor (single-shot; the scheduled task restarts it) ----
$serve = Join-Path $Root 'serve-ngrok.ps1'
$body = @'
# serve-ngrok.ps1 -- start the game server + an ngrok tunnel, then write the public URL.
# Started by the GangjingCourt scheduled task. Keep this file ASCII-only.
$ErrorActionPreference = 'Continue'
$Root     = $PSScriptRoot
$GameDir  = Join-Path $Root 'game'
$ToolsDir = Join-Path (Split-Path -Parent $Root) 'tools'
$NodeExe  = Join-Path $ToolsDir 'node\node-v22.14.0-win-x64\node.exe'
$NgrokExe = Join-Path $ToolsDir 'ngrok.exe'
$LogDir   = Join-Path $Root 'logs'
$UrlFile  = Join-Path $Root 'public-url.txt'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
function Log([string]$m) {
  Add-Content -Path (Join-Path $LogDir 'supervisor.log') -Value ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -Encoding UTF8
}

$env:PUBLIC_MODE     = '1'
$env:RATE_MAX_REQ    = '20'
$env:QUOTA_MAX_CALLS = '300'
$env:THINK_LEVEL     = 'off'
$env:PORT            = '8790'
$env:BIND            = '0.0.0.0'

Log '=== ngrok supervisor starting ==='
$server = Start-Process -FilePath $NodeExe -ArgumentList 'server.mjs' `
  -WorkingDirectory $GameDir -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput (Join-Path $LogDir 'server.out.log') `
  -RedirectStandardError  (Join-Path $LogDir 'server.err.log')
Log ('server started, pid ' + $server.Id)
Start-Sleep -Seconds 4

# ngrok local API (4040) reports the public URL; that is more reliable than scraping stdout.
$tunnel = Start-Process -FilePath $NgrokExe -ArgumentList 'http', '8790', '--log', 'stdout', '--log-format', 'json' `
  -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput (Join-Path $LogDir 'tunnel.out.log') `
  -RedirectStandardError  (Join-Path $LogDir 'tunnel.err.log')
Log ('ngrok started, pid ' + $tunnel.Id)

$lastUrl = ''
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 2
  try {
    $api = Invoke-RestMethod 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 4
    $u = ($api.tunnels | Where-Object { $_.public_url -like 'https://*' } | Select-Object -First 1).public_url
    if ($u -and $u -ne $lastUrl) {
      $lastUrl = $u
      $body = @()
      $body += 'PUBLIC URL: ' + $u
      $body += 'generated:  ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
      $body += ''
      $body += 'via ngrok (port 443) -- stable on this network'
      Set-Content -Path $UrlFile -Value $body -Encoding UTF8
      Log ('PUBLIC URL = ' + $u)
    }
  } catch { }
  if ($server.HasExited) { Log 'server died, exiting so the task can restart us'; break }
  if ($tunnel.HasExited) { Log 'ngrok died, exiting so the task can restart us'; break }
}

# keep alive until one of them dies; the scheduled task restarts us every 5 min
while (-not $server.HasExited -and -not $tunnel.HasExited) { Start-Sleep -Seconds 15 }

Log '=== ngrok supervisor stopping ==='
foreach ($p in @($tunnel, $server)) { try { & taskkill /PID $p.Id /T /F 2>&1 | Out-Null } catch { } }
'@

Set-Content -Path $serve -Value $body -Encoding UTF8
Write-Output ''
Write-Output '  Wrote serve-ngrok.ps1'

# ---- repoint the scheduled task ----
Write-Output '  Repointing the GangjingCourt scheduled task to the ngrok supervisor...'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $serve + '"')
$trigBoot  = New-ScheduledTaskTrigger -AtStartup
$trigBoot.Delay = 'PT30S'
$trigLogon = New-ScheduledTaskTrigger -AtLogOn
$trigRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName 'GangjingCourt' -Action $action `
  -Trigger @($trigBoot, $trigLogon, $trigRepeat) -Settings $set `
  -Description 'Court of Pedantry: game server + ngrok tunnel (stable on this network)' -Force | Out-Null

Stop-ScheduledTask  -TaskName 'GangjingCourt' -ErrorAction SilentlyContinue
Get-Process node,cloudflared,ngrok -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName 'GangjingCourt'

Write-Output '  Waiting for the public URL...'
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 2
  if (Test-Path $UrlFile) {
    $txt = Get-Content $UrlFile -Raw
    if ($txt -match 'https://[a-z0-9-]+\.ngrok') { break }
  }
}
Write-Output ''
if (Test-Path $UrlFile) { Get-Content $UrlFile } else { Write-Output '  (no URL yet -- check logs\tunnel.err.log)' }
Write-Output ''
Write-Output '  To go back to cloudflared: re-run register-service.ps1'
