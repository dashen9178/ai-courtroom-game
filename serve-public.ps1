<#
  serve-public.ps1  --  supervisor for the public tunnel.

  Why a scheduled task instead of a chat session:
  a process started from a chat/agent session dies with that session, which is
  exactly why the public link died earlier. A scheduled task is owned by
  Windows, survives logoff, and can restart on failure.

  ASCII-only on purpose: powershell.exe reads .ps1 as ANSI when there is no
  BOM, so non-ASCII text in this file would be garbled.
#>

$ErrorActionPreference = 'Continue'

# IMPORTANT: derive every path from $PSScriptRoot instead of hardcoding it.
# powershell.exe reads a BOM-less UTF-8 .ps1 as ANSI, so any non-ASCII literal
# path inside this file gets mangled (this bit us: "cannot find the directory").
# $PSScriptRoot arrives already decoded, so it is safe.
$Root    = $PSScriptRoot
$GameDir = Join-Path $Root 'game'
$LogDir  = Join-Path $Root 'logs'
$UrlFile = Join-Path $Root 'public-url.txt'

# Tools live one level up from the project, under a Chinese-named folder,
# so locate them by walking up rather than by literal path.
$ToolsDir = Join-Path (Split-Path -Parent $Root) 'tools'
$NodeExe  = Join-Path $ToolsDir 'node\node-v22.14.0-win-x64\node.exe'
$CfExe    = Join-Path $ToolsDir 'cloudflared.exe'

foreach ($p in @($NodeExe, $CfExe)) {
  if (-not (Test-Path $p)) {
    Write-Output "MISSING TOOL: $p"
    exit 1
  }
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Log([string]$msg) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path (Join-Path $LogDir 'supervisor.log') -Value $line -Encoding UTF8
}

function Kill-Tree($proc) {
  if ($null -eq $proc) { return }
  try {
    if (-not $proc.HasExited) {
      # kill children first (node may have spawned nothing, cloudflared neither,
      # but be safe), then the process itself
      & taskkill /PID $proc.Id /T /F 2>&1 | Out-Null
    }
  } catch { }
}

Log '=== supervisor starting ==='
# ---- environment for the game server -------------------------------
$env:PUBLIC_MODE     = '1'     # enable rate limit + daily quota
$env:RATE_MAX_REQ    = '20'
$env:QUOTA_MAX_CALLS = '300'
$env:THINK_LEVEL     = 'off'   # 'off' = fast+cheap (3-4s), 'full' = better but 11-17s
# Behind Tailscale/ngrok every request arrives from 127.0.0.1, so without this
# the per-IP rate limit would collapse into one global bucket. TRUST_PROXY makes
# the server read X-Forwarded-For (last hop) so each visitor is counted separately.
$env:TRUST_PROXY = '1'
$env:PORT            = '8790'

$server = $null
$tunnel = $null

try {
  while ($true) {

    # ---- (re)start the game server ----------------------------------
    if ($null -eq $server -or $server.HasExited) {
      if ($server -ne $null) { Log ('server exited with code ' + $server.ExitCode + ' - restarting') }
      $server = Start-Process -FilePath $NodeExe -ArgumentList 'server.mjs' `
        -WorkingDirectory $GameDir -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $LogDir 'server.out.log') `
        -RedirectStandardError  (Join-Path $LogDir 'server.err.log')
      Log ('server started, pid ' + $server.Id)
      Start-Sleep -Seconds 4
    }

    # ---- (re)start the tunnel ---------------------------------------
    if ($null -eq $tunnel -or $tunnel.HasExited) {
      if ($tunnel -ne $null) { Log ('tunnel exited with code ' + $tunnel.ExitCode + ' - restarting (URL WILL CHANGE)') }
      # IMPORTANT: this network interferes with Cloudflare edge port 7844
      # ("TLS handshake with edge error: read tcp ...:7844: i/o timeout"),
      # which makes quick tunnels flap and visitors see Error 1033 / 530.
      # Mitigations:
      #   --protocol http2    TCP instead of UDP (UDP is dropped here)
      #   --ha-connections 1  fewer concurrent edge handshakes to lose
      #   --retries 999       keep retrying instead of giving up
      # The LAN URL (http://<lan-ip>:8790) remains the reliable path on this network.
      $tunnel = Start-Process -FilePath $CfExe `
        -ArgumentList 'tunnel', '--url', 'http://127.0.0.1:8790', '--no-autoupdate',
                      '--protocol', 'http2', '--ha-connections', '1', '--retries', '999' `
        -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $LogDir 'tunnel.out.log') `
        -RedirectStandardError  (Join-Path $LogDir 'tunnel.err.log')
      Log ('tunnel started (http2/TCP, ha=1), pid ' + $tunnel.Id)
    }

    # ---- scrape the public URL out of cloudflared's log -------------
    $tl = Join-Path $LogDir 'tunnel.err.log'
    if (Test-Path $tl) {
      try {
        $txt = Get-Content $tl -Raw -ErrorAction SilentlyContinue
        if ($txt) {
          $m = [regex]::Match($txt, 'https://[a-z0-9-]+\.trycloudflare\.com')
          if ($m.Success) {
            $url = $m.Value
            $prev = ''
            if (Test-Path $UrlFile) { $prev = (Get-Content $UrlFile -Raw -ErrorAction SilentlyContinue) }
            if ($prev -notmatch [regex]::Escape($url)) {
              $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
              $body = @()
              $body += 'PUBLIC URL: ' + $url
              $body += 'generated:  ' + $stamp
              $body += ''
              $body += 'Open it on any phone. The PC must stay on.'
              $body += 'If the URL changes, this file is rewritten and the old link stops working.'
              Set-Content -Path $UrlFile -Value $body -Encoding UTF8
              Log ('PUBLIC URL = ' + $url)
            }
          }
        }
      } catch { }
    }

    Start-Sleep -Seconds 10
  }
}
finally {
  Log '=== supervisor stopping, killing children ==='
  Kill-Tree $tunnel
  Kill-Tree $server
}
