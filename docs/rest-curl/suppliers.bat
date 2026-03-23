@echo off
call "%~dp0\_auth_template.bat" || exit /b 1

REM List suppliers (JSON)
curl -s -H "Accept: application/json" -H "Authorization: Bearer %KF_TOKEN%" "%BASE%/suppliers"

REM Get supplier by code (set CODE) (JSON)
curl -s -H "Accept: application/json" -H "Authorization: Bearer %KF_TOKEN%" "%BASE%/suppliers/%CODE%"
