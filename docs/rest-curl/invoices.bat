@echo off
call "%~dp0\_auth_template.bat" || exit /b 1

REM List invoices
curl -s -H "Accept: application/json" -H "Authorization: Bearer %KF_TOKEN%" "%BASE%/invoices"

REM Get invoice by number (set NUMBER)
curl -s -H "Accept: application/json" -H "Authorization: Bearer %KF_TOKEN%" "%BASE%/invoices/%NUMBER%"

REM Create invoice (minimal example)
REM Create invoice (example minimal payload)
REM This line is removed to restrict to GET-only

REM Update invoice
REM Update invoice
REM This line is removed to restrict to GET-only

REM Delete invoice
REM Delete invoice
REM This line is removed to restrict to GET-only
