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
