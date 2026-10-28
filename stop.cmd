@echo off
rem Stop the QQ bot: qq-bridge first, then SnowLuma.
rem Flags: --bridge-only  --snowluma-only
title qq-bridge stop
setlocal
set "NODE=C:\Users\Vonke\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" (
  echo [stop] node not found: %NODE%
  pause
  exit /b 1
)
cd /d "%~dp0"
"%NODE%" "scripts\shutdown.mjs" %*
echo.
ping -n 5 127.0.0.1 >nul
