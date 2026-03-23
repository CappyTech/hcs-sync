@echo off
call "%~dp0\_auth_template.bat" || exit /b 1

REM Notes endpoints require OBJECT_TYPE and OBJECT_NUMBER
REM OBJECT_TYPE: customers|suppliers|invoices|quotes|purchases|purchaseorders

REM List notes for an entity
curl -s -H "Accept: application/json" -H "Authorization: Bearer %KF_TOKEN%" "%BASE%/%OBJECT_TYPE%/%OBJECT_NUMBER%/notes"

REM Get note by number (set NUMBER)
curl -s -H "Accept: application/json" -H "Authorization: Bearer %KF_TOKEN%" "%BASE%/%OBJECT_TYPE%/%OBJECT_NUMBER%/notes/%NUMBER%"

REM Create note

REM Update note

REM Delete note
