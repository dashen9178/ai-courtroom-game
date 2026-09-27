# serve-tailscale.ps1 -- game server + Tailscale Funnel (no interstitial, permanent URL).
#
# Why Tailscale instead of cloudflared/ngrok:
#   cloudflared  -> this network breaks Cloudflare edge port 7844, tunnel flaps
#   ngrok free   -> works, but shows every new visitor a browser warning page
#   Tailscale    -> goes over 443, no warning page, and the hostname is PERMANENT
#
# One-time setup (needs your account, cannot be automated):
#   1. install Tailscale, run: tailscale up      (prints a login URL)
#   2. log in with Google / GitHub / Microsoft
#   3. in the admin console, enable Funnel for this node
#        https://login.tailscale.com/admin/acls   -> add "funnel" to nodeAttrs
#   4. tailscale funnel --bg 8790
#
# Started by the GangjingCourt scheduled task. ASCII-only on purpose.
$ErrorActionPreference = 'Continue'
$Root     = $PSScriptRoot
$GameDir  = Join-Path $Root 'game'
$ToolsDir = Join-Path (Split-Path -Parent $Root) 'tools'
$NodeExe  = Join-Path $ToolsDir 'node\node-v22.14.0-win-x64\node.exe'
$TsExe    = 'C:\Program Files\Tailscale\tailscale.exe'
$CfExe    = Join-Path $ToolsDir 'cloudflared.exe'
# If setup-cloudflared.ps1 has been run, this exists and we ALSO run the
# Cloudflare tunnel, so the game is reachable on the user's own domain.
# Written by setup-cloudflared.ps1, read here. Absent = Tailscale Funnel only.
$CfConf   = Join-Path $env:USERPROFILE '.cloudflared\config.yml'
$LogDir   = Join-Path $Root 'logs'
$UrlFile  = Join-Path $Root 'public-url.txt'
$Port     = 8790

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
function Log([string]$m) {
  Add-Content -Path (Join-Path $LogDir 'supervisor.log') -Value ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -Encoding UTF8
}

$env:PUBLIC_MODE     = '1'
# No per-day game quota any more -- game count is unlimited by request.
# RATE_MAX_REQ is NOT a quota: it is only a flood guard. A normal player uses
# well under 30 model calls per minute; a runaway script gets stopped in the
# first minute instead of draining the API balance.
$env:RATE_MAX_REQ    = '30'
$env:THINK_LEVEL     = 'off'
# Behind Tailscale/ngrok every request arrives from 127.0.0.1, so without this
# the per-IP rate limit would collapse into one global bucket. TRUST_PROXY makes
# the server read X-Forwarded-For (last hop) so each visitor is counted separately.
$env:TRUST_PROXY = '1'
$env:PORT            = "$Port"
$env:BIND            = '0.0.0.0'

Log '=== tailscale supervisor starting ==='

# ---- game server -------------------------------------------------------
if (-not (Test-Path $NodeExe)) { Log "MISSING node: $NodeExe"; exit 1 }
$server = Start-Process -FilePath $NodeExe -ArgumentList 'server.mjs' `
  -WorkingDirectory $GameDir -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput (Join-Path $LogDir 'server.out.log') `
  -RedirectStandardError  (Join-Path $LogDir 'server.err.log')
Log ('server started, pid ' + $server.Id)
Start-Sleep -Seconds 4

# ---- cloudflare tunnel (optional, custom domain) -----------------------
# Started only when setup-cloudflared.ps1 has written a config. Keeping it
# guarded means an un-configured machine behaves exactly as before.
$tunnel = $null
if ((Test-Path $CfExe) -and (Test-Path $CfConf)) {
  $tunnel = Start-Process -FilePath $CfExe -ArgumentList @('tunnel', '--config', $CfConf, 'run') `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $LogDir 'cloudflared.out.log') `
    -RedirectStandardError  (Join-Path $LogDir 'cloudflared.err.log')
  Log ('cloudflared started, pid ' + $tunnel.Id)
  Start-Sleep -Seconds 3
} else {
  Log 'no cloudflare tunnel config - running Tailscale Funnel only'
}

# ---- wait until Tailscale is logged in ---------------------------------
$funnelOk = $false
for ($i = 0; $i -lt 30; $i++) {
  $st = & $TsExe status 2>&1 | Out-String
  if ($st -notmatch 'Logged out' -and $st -notmatch 'not running') { $funnelOk = $true; break }
  Start-Sleep -Seconds 5
}
if (-not $funnelOk) {
  Log 'Tailscale not logged in yet - server is up on LAN, funnel skipped'
} else {
  # ---- enable funnel (idempotent) --------------------------------------
  & $TsExe funnel --bg $Port 2>&1 | ForEach-Object { Log ('funnel: ' + $_) }

  # ---- write the permanent public URL ----------------------------------
  $st = & $TsExe status --json 2>&1 | Out-String
  try {
    $j = $st | ConvertFrom-Json
    $dns = $j.Self.DNSName            # e.g. ds.tailXXXX.ts.net.
    if ($dns) {
      $tsUrl = 'https://' + $dns.TrimEnd('.')
      # If a Cloudflare tunnel is configured, the custom domain is the one to share.
      $customHost = $null
      if (Test-Path $CfConf) {
        foreach ($l in (Get-Content $CfConf -Encoding UTF8)) {
          if ($l -match '^\s*-\s*hostname:\s*(\S+)\s*$') { $customHost = $matches[1]; break }
        }
      }
      $lines = @()
      if ($customHost) {
        $lines += 'PUBLIC URL: https://' + $customHost
        $lines += 'BACKUP:     ' + $tsUrl
      } else {
        $lines += 'PUBLIC URL: ' + $tsUrl
      }
      $lines += 'generated:  ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
      $lines += ''
      if ($customHost) {
        $lines += 'primary: Cloudflare Tunnel on your own domain'
        $lines += 'backup:  Tailscale Funnel - permanent hostname, no browser warning page'
      } else {
        $lines += 'via Tailscale Funnel - permanent hostname, no browser warning page'
      }
      Set-Content -Path $UrlFile -Value $lines -Encoding UTF8
      Log ('PUBLIC URL = ' + $(if ($customHost) { 'https://' + $customHost } else { $tsUrl }))
    }
  } catch { Log ('could not parse tailscale status: ' + $_.Exception.Message) }
}

# ---- supervise ---------------------------------------------------------
# Stop (so the scheduled task restarts us) if EITHER process dies.
while (-not $server.HasExited) {
  if ($tunnel -and $tunnel.HasExited) {
    Log 'cloudflared exited - supervisor stopping so the task can restart us'
    break
  }
  Start-Sleep -Seconds 15
}
Log '=== server exited, supervisor stopping so the task can restart us ==='
try { & taskkill /PID $server.Id /T /F 2>&1 | Out-Null } catch { }
if ($tunnel) { try { & taskkill /PID $tunnel.Id /T /F 2>&1 | Out-Null } catch { } }
