# register-service.ps1 -- install the game as a background Windows service (scheduled task).
#
# Why this exists:
#   A process started from a chat/agent session is killed when that session ends.
#   That is exactly why the public link died earlier (Cloudflare Error 1033).
#   A scheduled task is owned by Windows and keeps running after this session ends,
#   after logoff, and (with the boot trigger) after a reboot.
#
# What it installs:
#   Task "GangjingCourt" -> serve-public.ps1 -> { game server, cloudflared tunnel }
#   Triggers: at startup, at logon, and every 5 minutes as a safety net.
#
# ASCII-only on purpose: powershell.exe reads a BOM-less .ps1 as ANSI,
# so non-ASCII literals in this file would be mangled.
#
# Run this from an elevated PowerShell:
#   powershell -NoProfile -ExecutionPolicy Bypass -File register-service.ps1

$ErrorActionPreference = 'Stop'
$taskName = 'GangjingCourt'
$root     = $PSScriptRoot
$script   = Join-Path $root 'serve-public.ps1'

if (-not (Test-Path $script)) {
  Write-Output "MISSING: $script"
  exit 1
}

$isAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  Write-Output ''
  Write-Output '  This needs Administrator rights (to register a scheduled task).'
  Write-Output '  Right-click PowerShell -> Run as administrator, then re-run this file.'
  Write-Output ''
  exit 1
}

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $script + '"')

$trigBoot  = New-ScheduledTaskTrigger -AtStartup
$trigBoot.Delay = 'PT30S'
$trigLogon = New-ScheduledTaskTrigger -AtLogOn
$trigRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5)

$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action `
  -Trigger @($trigBoot, $trigLogon, $trigRepeat) -Settings $set `
  -Description 'Court of Pedantry: local game server + Cloudflare public tunnel (auto restart)' `
  -Force | Out-Null

Write-Output ''
Write-Output "  Installed scheduled task: $taskName"
Write-Output '  Triggers: at startup, at logon, every 5 minutes'
Write-Output ''
Write-Output '  Starting it now...'
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 20

$state = (Get-ScheduledTask -TaskName $taskName).State
Write-Output "  Task state: $state"
Write-Output ''
Write-Output '  To see the public link:  node game\show-url.mjs'
Write-Output '  To stop serving:         Stop-ScheduledTask  -TaskName GangjingCourt'
Write-Output '  To uninstall:            Unregister-ScheduledTask -TaskName GangjingCourt -Confirm:$false'
Write-Output ''
