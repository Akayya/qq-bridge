@echo off
chcp 65001 >nul
rem ---------------------------------------------------------------
rem This machine has no `node` on PATH (DSH ships its own runtime),
rem so this wrapper puts the DSH runtime node on PATH for start.bat.
rem Double-click it, or run:  start-node.cmd
rem ---------------------------------------------------------------
cd /d "%~dp0"
set "PATH=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;%PATH%"
call "%~dp0start.bat"
