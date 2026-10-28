@echo off
rem Called by Task Scheduler: export memory snapshot and push to the private repo.
setlocal
set "NODE=C:\Users\Vonke\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
set "LOG=D:\DSH_QQ_BOT\logs\memory-backup.log"
if not exist "%NODE%" (
  echo [%date% %time%] node not found: %NODE% >> "%LOG%"
  exit /b 1
)
if not exist "D:\DSH_QQ_BOT\logs" mkdir "D:\DSH_QQ_BOT\logs"
for %%A in ("%LOG%") do if %%~zA GTR 2097152 move /y "%LOG%" "%LOG%.1" >nul 2>&1
pushd "D:\DSH_QQ_BOT"
echo [%date% %time%] backup start >> "%LOG%"
"%NODE%" "scripts\backup-memory.mjs" >> "%LOG%" 2>&1
set "CODE=%ERRORLEVEL%"
echo [%date% %time%] backup done, exit=%CODE% >> "%LOG%"
popd
exit /b %CODE%
