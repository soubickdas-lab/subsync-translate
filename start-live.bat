@echo off
setlocal
cd /d "%~dp0"
title SubSync Translate - LIVE (Cloudflare)

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
    echo README ka "Live mode" section dekho.
    pause
    exit /b 1
)

echo.
echo  SubSync Translate LIVE start ho raha hai...
echo    Local:  http://127.0.0.1:8756
echo    Live:   https://manwhadub.aipoint.online
echo  Dono windows band karne par site band ho jayegi.
echo.

start "SubSync Server" cmd /k "cd /d ""%~dp0"" && venv\Scripts\python.exe server.py"
timeout /t 3 >nul
start "Cloudflare Tunnel - manwhadub" "%CF%" tunnel --config "%USERPROFILE%\.cloudflared\manwhadub.yml" run manwhadub
timeout /t 3 >nul
start "" https://manwhadub.aipoint.online
exit /b 0
