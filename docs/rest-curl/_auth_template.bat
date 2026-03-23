@echo off
REM KashFlow Session Token bootstrap
REM Requires: curl, PowerShell (v5+), BASE, KF_USER, KF_PASS, KF_MEMCHAR1/2/3

set "BASE=%BASE%"
if "%BASE%"=="" set "BASE=https://api.kashflow.com/v2"

if "%KF_USER%"=="" (
  echo KF_USER not set.
  set /p KF_USER=Enter KF_USER (username): 
)
if "%KF_PASS%"=="" (
  echo KF_PASS not set.
  echo (Input will be visible)
  set /p KF_PASS=Enter KF_PASS (password): 
)

REM Step 1: POST username+password to get tempToken and requiredChars positions
for /f "usebackq tokens=*" %%A in (`curl -s -X POST -H "Content-Type: application/json" -d "{^^\"username^^\":^^\"%KF_USER%^^\",^^\"password^^\":^^\"%KF_PASS%^^\"}" "%BASE%/sessiontoken"`) do set "AUTH_RESP=%%A"

for /f "usebackq tokens=*" %%A in (`powershell -NoProfile -Command "$r='%AUTH_RESP%'; ($r | ConvertFrom-Json).tempToken"`) do set "TEMPTOKEN=%%A"
for /f "usebackq tokens=*" %%A in (`powershell -NoProfile -Command "$r='%AUTH_RESP%'; ($r | ConvertFrom-Json).requiredChars -join ','"`) do set "REQPOS=%%A"

for /f "tokens=1,2,3 delims=," %%a in ("%REQPOS%") do (
  if "%KF_MEMPOS1%"=="" set "KF_MEMPOS1=%%a"
  if "%KF_MEMPOS2%"=="" set "KF_MEMPOS2=%%b"
  if "%KF_MEMPOS3%"=="" set "KF_MEMPOS3=%%c"
)

echo Required memory positions: %KF_MEMPOS1%, %KF_MEMPOS2%, %KF_MEMPOS3%
if "%KF_MEMCHAR1%"=="" (
  set /p KF_MEMCHAR1=Enter char at position %KF_MEMPOS1%: 
)
if "%KF_MEMCHAR2%"=="" (
  set /p KF_MEMCHAR2=Enter char at position %KF_MEMPOS2%: 
)
if "%KF_MEMCHAR3%"=="" (
  set /p KF_MEMCHAR3=Enter char at position %KF_MEMPOS3%: 
)
if "%KF_MEMCHAR1%"=="" (
  echo Provide KF_MEMCHAR1/2/3 and re-run.
  exit /b 1
)
if "%KF_MEMCHAR2%"=="" (
  echo Provide KF_MEMCHAR1/2/3 and re-run.
  exit /b 1
)
if "%KF_MEMCHAR3%"=="" (
  echo Provide KF_MEMCHAR1/2/3 and re-run.
  exit /b 1
)

REM Step 2: PUT tempToken + chars to get sessionToken
for /f "usebackq tokens=*" %%A in (`curl -s -X PUT -H "Content-Type: application/json" -d "{^^\"tempToken^^\":^^\"%TEMPTOKEN%^^\",^^\"chars^^\":{^^\"%KF_MEMPOS1%^^\":^^\"%KF_MEMCHAR1%^^\",^^\"%KF_MEMPOS2%^^\":^^\"%KF_MEMCHAR2%^^\",^^\"%KF_MEMPOS3%^^\":^^\"%KF_MEMCHAR3%^^\"}}" "%BASE%/sessiontoken"`) do set "PUT_RESP=%%A"
for /f "usebackq tokens=*" %%A in (`powershell -NoProfile -Command "$r='%PUT_RESP%'; ($r | ConvertFrom-Json).sessionToken"`) do set "KF_TOKEN=%%A"

echo KF_TOKEN acquired.
exit /b 0
