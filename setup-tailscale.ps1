# setup-tailscale.ps1 -- switch public access to Tailscale Funnel.
#
# Why: cloudflared's edge port 7844 is broken on this network, and ngrok's free
# tier shows every new visitor a browser warning page. Tailscale Funnel goes over
# 443, has no warning page, and gives a permanent hostname.
#
# Prerequisites (one-time, needs your account):
#   1. Tailscale installed  (this script installs it if missing)
#   2. Logged in:  tailscale up      -> open the printed URL, sign in
#   3. Funnel enabled for this node in the admin console:
#        https://login.tailscale.com/admin/acls
#      add under nodeAttrs:
#        { "target": ["*"], "attr": ["funnel"] }
#      (or use the "Funnel" toggle on the machine's page in the admin console)
#
# Then run this script. ASCII-only on purpose.
$ErrorActionPreference = 'Continue'
$Root    = $PSScriptRoot
$TsExe   = 'C:\Program Files\Tailscale\tailscale.exe'
$LogDir  = Join-Path $Root 'logs'
$UrlFile = Join-Path $Root 'public-url.txt'
$Port    = 8790

if (-not (Test-Path $TsExe)) {
  Write-Output ''
  Write-Output '  Tailscale is not installed at:'
  Write-Output "    $TsExe"
  Write-Output '  Run:  winget install tailscale.tailscale'
  Write-Output '  or download: https://pkgs.tailscale.com/stable/#windows'
  Write-Output ''
  exit 1
}

$st = & $TsExe status 2>&1 | Out-String
if ($st -match 'Logged out') {
  Write-Output ''
  Write-Output '  Tailscale is not logged in yet.'
  Write-Output '  Run this, then open the URL it prints and sign in:'
  Write-Output ''
  Write-Output '    & "C:\Program Files\Tailscale\tailscale.exe" up'
  Write-Output ''
  exit 1
}

Write-Output ''
Write-Output '  Tailscale is logged in. Enabling Funnel...'
& $TsExe funnel --bg $Port 2>&1 | ForEach-Object { "  $_" }

# ---- repoint the scheduled task to the tailscale supervisor ----
$serve = Join-Path $Root 'serve-tailscale.ps1'
if (-not (Test-Path $serve)) {
  Write-Output '  MISSING serve-tailscale.ps1 next to this script.'
  exit 1
}

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
  -Description 'Court of Pedantry: game server + Tailscale Funnel (permanent URL, no interstitial)' -Force | Out-Null
Write-Output '  Scheduled task repointed to Tailscale.'

Stop-ScheduledTask -TaskName 'GangjingCourt' -ErrorAction SilentlyContinue
Get-Process node,cloudflared,ngrok -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName 'GangjingCourt'

Write-Output '  Waiting for the public URL...'
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 2
  if (Test-Path $UrlFile) {
    $txt = Get-Content $UrlFile -Raw
    if ($txt -match 'ts\.net') { break }
  }
}
Write-Output ''
if (Test-Path $UrlFile) { Get-Content $UrlFile } else { Write-Output '  (no URL yet -- check logs\supervisor.log)' }

# ---- verify it actually works from the outside ----
$url = $null
if (Test-Path $UrlFile) {
  $m = [regex]::Match((Get-Content $UrlFile -Raw), 'https://[a-z0-9.-]+\.ts\.net')
  if ($m.Success) { $url = $m.Value }
}
if ($url) {
  Write-Output ''
  Write-Output "  Probing $url/api/health ..."
  try {
    $r = Invoke-WebRequest "$url/api/health" -UseBasicParsing -TimeoutSec 25
    Write-Output ('  OK  HTTP ' + $r.StatusCode + '  ' + $r.Content)
  } catch {
    Write-Output ('  FAILED: ' + $_.Exception.Message.Split([char]10)[0])
    Write-Output '  If it says 502, Funnel is probably not enabled in the admin console yet:'
    Write-Output '    https://login.tailscale.com/admin/machines'
  }
}
Write-Output ''
Write-Output '  To go back to ngrok:   run setup-ngrok.ps1'
Write-Output '  To go back to cloudflared: run register-service.ps1'
