@echo off
rem  Publish to the public internet via a temporary Cloudflare tunnel.
rem  Keep this file ASCII-only: cmd.exe reads .cmd using the console codepage,
rem  and mixing GBK-encoded Chinese with "chcp 65001" garbles one side.
chcp 65001 >nul
title Court of Pedantry - public tunnel
cd /d "%~dp0game"

set "NODE="
if exist "%~dp0..\tools\node\node-v22.14.0-win-x64\node.exe" set "NODE=%~dp0..\tools\node\node-v22.14.0-win-x64\node.exe"
if not defined NODE if exist "%~dp0tools\node\node-v22.14.0-win-x64\node.exe" set "NODE=%~dp0tools\node\node-v22.14.0-win-x64\node.exe"
if not defined NODE for %%i in (node.exe) do if not "%%~$PATH:i"=="" set "NODE=%%~$PATH:i"

if not defined NODE (
  echo.
  echo   Node.js not found. Please install Node 22+ : https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo.
echo   Publishing to the public internet...
echo   A public https:// link will appear below. Send it to anyone.
echo   This PC must stay on. Press Ctrl+C to stop.
echo.

"%NODE%" tunnel.mjs
pause
