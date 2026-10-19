@echo off
setlocal
set "TO_POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if defined PROCESSOR_ARCHITEW6432 set "TO_POWERSHELL=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
"%TO_POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start.ps1"
set "TO_EXIT=%ERRORLEVEL%"
pause
exit /b %TO_EXIT%
