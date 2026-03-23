@echo off
call "%~dp0\_auth_template.bat" || exit /b 1

REM List purchases
curl -s -H "Accept: application/json" -H "Authorization: Bearer %KF_TOKEN%" "%BASE%/purchases"

REM Get purchase by number (set NUMBER)
curl -s -H "Accept: application/json" -H "Authorization: Bearer %KF_TOKEN%" "%BASE%/purchases/%NUMBER%"

REM Write operations removed to restrict to GET-only.
