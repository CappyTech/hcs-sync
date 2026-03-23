@echo off
call "%~dp0\_auth_template.bat" || exit /b 1

REM List quotes
curl -s -H "Accept: application/json" -H "Authorization: Bearer %KF_TOKEN%" "%BASE%/quotes"

REM Get quote by number (set NUMBER)
curl -s -H "Accept: application/json" -H "Authorization: Bearer %KF_TOKEN%" "%BASE%/quotes/%NUMBER%"

REM Write operations removed to restrict to GET-only.
