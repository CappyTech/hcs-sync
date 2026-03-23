@echo off
call "%~dp0\_auth_template.bat" || exit /b 1

REM List customers (JSON)
curl -s -H "Accept: application/json" -H "Authorization: Bearer %KF_TOKEN%" "%BASE%/customers"

REM Get customer by code (set CODE) (JSON)
curl -s -H "Accept: application/json" -H "Authorization: Bearer %KF_TOKEN%" "%BASE%/customers/%CODE%"
