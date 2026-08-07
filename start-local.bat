@echo off
cd /d "%~dp0"
title SubSync Translate - Local Server

if not exist venv\.setup-ok (
    echo Pehli baar chala rahe ho - setup ho raha hai...
    call setup.bat auto
    if errorlevel 1 exit /b 1
)

echo.
echo  SubSync Translate local server start ho raha hai...
echo  Browser khud khul jayega: http://127.0.0.1:8756
echo  Band karne ke liye: is window ko close karo ya Ctrl+C
echo.

set OPEN_BROWSER=1
venv\Scripts\python.exe server.py
pause
