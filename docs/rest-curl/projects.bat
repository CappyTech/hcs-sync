@echo off
call "%~dp0\_auth_template.bat" || exit /b 1

REM List projects
curl -s -H "Accept: application/json" -H "Authorization: Bearer %KF_TOKEN%" "%BASE%/projects"

REM Get project by number (set NUMBER)
curl -s -H "Accept: application/json" -H "Authorization: Bearer %KF_TOKEN%" "%BASE%/projects/%NUMBER%"

REM Write operations removed to restrict to GET-only.
