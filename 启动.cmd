@echo off
rem  Keep this file ASCII-only on purpose.
rem  A .cmd is read by cmd.exe using the console codepage; mixing GBK-encoded
rem  Chinese with "chcp 65001" garbles one side or the other. Node prints
rem  UTF-8, so we switch the console to UTF-8 and keep this launcher plain.
chcp 65001 >nul
title Court of Pedantry
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
echo   Starting "Court of Pedantry" ...
echo   Browser will open http://127.0.0.1:8790
echo   Close this window to stop the server.
echo.
echo   Tip: http://127.0.0.1:8790/?demo=1  shows the UI with sample data, no AI calls.
echo.

start "" http://127.0.0.1:8790
"%NODE%" server.mjs
pause
