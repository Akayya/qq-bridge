@echo off
rem Called by Task Scheduler: export memory snapshot and push to the private repo.
setlocal
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
set "NODE=%QQ_BRIDGE_NODE%"
if not defined NODE set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
set "LOG=%ROOT%\logs\memory-backup.log"
if not exist "%NODE%" (
  echo [%date% %time%] node not found: %NODE% >> "%LOG%"
  exit /b 1
)
if not exist "%ROOT%\logs" mkdir "%ROOT%\logs"
for %%A in ("%LOG%") do if %%~zA GTR 2097152 move /y "%LOG%" "%LOG%.1" >nul 2>&1
pushd "%ROOT%"
echo [%date% %time%] backup start >> "%LOG%"
"%NODE%" "scripts\backup-memory.mjs" >> "%LOG%" 2>&1
set "CODE=%ERRORLEVEL%"
echo [%date% %time%] backup done, exit=%CODE% >> "%LOG%"
popd
exit /b %CODE%
