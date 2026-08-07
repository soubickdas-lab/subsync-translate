@echo off
cd /d "%~dp0"
title SubSync Translate - Update

echo GitHub se latest version la rahe hain...
git pull --ff-only origin main
if errorlevel 1 (
    echo.
    echo Update fail hua. Agar local changes hain to pehle:  git stash
    pause
    exit /b 1
)

if exist venv\.setup-ok (
    echo Dependencies refresh ho rahi hain...
    venv\Scripts\python.exe -m pip install -r requirements.txt --quiet
)

echo.
echo Update complete! venv aur downloaded models safe hain.
pause
