@echo off
setlocal
cd /d "%~dp0"
title SubSync Translate - LIVE (manwhadub.aipoint.online)

echo ============================================
echo  SubSync Translate - LIVE start ho raha hai
echo ============================================
echo.

if not exist venv\.setup-ok (
    echo Pehli baar chala rahe ho - setup ho raha hai...
    call setup.bat auto
    if errorlevel 1 exit /b 1
)

set "CF="
for /f "delims=" %%i in ('where cloudflared 2^>nul') do set "CF=%%i"
if not defined CF if exist "%ProgramFiles(x86)%\cloudflared\cloudflared.exe" set "CF=%ProgramFiles(x86)%\cloudflared\cloudflared.exe"
if not defined CF if exist "%ProgramFiles%\cloudflared\cloudflared.exe" set "CF=%ProgramFiles%\cloudflared\cloudflared.exe"
if not defined CF (
    echo ERROR: cloudflared nahi mila. Install karo:
    echo   winget install Cloudflare.cloudflared
    pause
    exit /b 1
)

if not exist "%USERPROFILE%\.cloudflared\manwhadub.yml" (
    echo ERROR: tunnel config nahi mila: %USERPROFILE%\.cloudflared\manwhadub.yml
    pause
    exit /b 1
)

echo [1/4] Purane SubSync instances band ho rahe hain (dusre projects safe)...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='cloudflared.exe'\" | Where-Object { $_.CommandLine -like '*manwhadub*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>nul
for /f "tokens=5" %%p in ('netstat -aon ^| findstr ":8756 " ^| findstr LISTENING') do taskkill /f /pid %%p >nul 2>nul
timeout /t 2 /nobreak >nul

echo [2/4] Server start ho raha hai (GPU/Whisper)...
start "SubSync Server" cmd /k venv\Scripts\python.exe server.py

echo [3/4] Server ke ready hone ka wait...
set /a TRIES=0
:waitloop
curl -s -m 2 http://127.0.0.1:8756/api/info >nul 2>nul
if not errorlevel 1 goto serverup
set /a TRIES+=1
if %TRIES% geq 45 (
    echo WARNING: server 90 sec me ready nahi hua - "SubSync Server" window me error dekho.
    goto serverup
)
timeout /t 2 /nobreak >nul
goto waitloop

:serverup
echo        Server ready: http://127.0.0.1:8756

echo [4/4] Live site khul rahi hai + tunnel connect ho raha hai...
start "" https://manwhadub.aipoint.online
echo.
echo ============================================
echo  Local:  http://127.0.0.1:8756
echo  Live:   https://manwhadub.aipoint.online
echo  Ye window aur "SubSync Server" window khuli
echo  rakhni hain - band karne se site off ho jayegi.
echo ============================================
echo.
"%CF%" tunnel --config "%USERPROFILE%\.cloudflared\manwhadub.yml" run manwhadub
pause
