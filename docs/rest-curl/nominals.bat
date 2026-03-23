@echo off
call "%~dp0\_auth_template.bat" || exit /b 1

REM List nominals
curl -s -H "Accept: application/json" -H "Authorization: Bearer %KF_TOKEN%" "%BASE%/nominals"

REM Get nominal by code (set CODE)
curl -s -H "Accept: application/json" -H "Authorization: Bearer %KF_TOKEN%" "%BASE%/nominals/%CODE%"

REM Create nominal

REM Update nominal

REM Delete nominal
