@echo off
rem Logon autostart: SnowLuma -> DSH -> qq-bridge.
rem Invoked hidden by qq-bridge-autostart.vbs in the Startup folder.
setlocal
set "NODE=%QQ_BRIDGE_NODE%"
if not defined NODE set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" (
  echo [autostart] node not found: %NODE%
  exit /b 1
)
cd /d "%~dp0"
"%NODE%" "scripts\autostart.mjs" %*