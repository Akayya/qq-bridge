@echo off
rem Scheduled-task entry point: runs the bridge daemon with output captured to logs\daemon.log
cd /d "%~dp0"
if not exist "logs" mkdir "logs"
call "%~dp0start-node.cmd" >> "%~dp0logs\daemon.log" 2>&1
