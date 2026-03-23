@echo off
REM Wrapper for PowerShell interactive script
@echo off
REM Wrapper now relies on integrated auth inside interactive.ps1
set "SCRIPT=%~dp0interactive.ps1"
if not exist "%SCRIPT%" (
  echo interactive.ps1 missing. >&2
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Base "%BASE%" %*
exit /b %ERRORLEVEL%
