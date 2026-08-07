@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title SubSync Translate - Setup

echo ============================================
echo  SubSync Translate - Local Setup
echo ============================================
echo.

call :find_python
if not defined PYEXE (
    echo Python nahi mila - winget se install kar rahe hain...
    winget install -e --id Python.Python.3.11 --silent --accept-package-agreements --accept-source-agreements
    call :find_python
)
if not defined PYEXE (
    echo.
    echo ERROR: Python install nahi ho paya.
    echo Manually install karo: https://www.python.org/downloads/  ^(3.10+, "Add to PATH" tick karna^)
    echo Phir setup.bat dobara chalao.
    pause
    exit /b 1
)
echo Python mila: !PYEXE!
echo.

if not exist venv (
    echo Virtual environment bana rahe hain...
    "!PYEXE!" -m venv venv
    if errorlevel 1 ( echo ERROR: venv create fail. & pause & exit /b 1 )
)

echo Dependencies install ho rahi hain ^(pehli baar 5-10 min lag sakte hain^)...
venv\Scripts\python.exe -m pip install --upgrade pip --quiet
venv\Scripts\python.exe -m pip install -r requirements.txt
if errorlevel 1 ( echo ERROR: pip install fail. Internet check karo. & pause & exit /b 1 )

where nvidia-smi >nul 2>nul
if not errorlevel 1 (
    echo NVIDIA GPU mila - CUDA libraries install ho rahi hain...
    venv\Scripts\python.exe -m pip install nvidia-cublas-cu12 "nvidia-cudnn-cu12>=9"
)

echo ok > venv\.setup-ok
echo.
echo ============================================
echo  Setup complete! Ab start-local.bat chalao.
echo  Note: pehli baar chalane par Whisper (~3 GB) aur
echo  NLLB translation model (~2.4 GB) download honge.
echo ============================================
if /i not "%1"=="auto" pause
exit /b 0

:find_python
set "PYEXE="
for /f "delims=" %%i in ('py -3 -c "import sys;print(sys.executable)" 2^>nul') do set "PYEXE=%%i"
if defined PYEXE exit /b 0
for /f "delims=" %%i in ('where python 2^>nul') do (
    echo %%i | find /i "WindowsApps" >nul
    if errorlevel 1 (
        set "PYEXE=%%i"
        exit /b 0
    )
)
for /d %%d in ("%LocalAppData%\Programs\Python\Python3*") do (
    if exist "%%d\python.exe" set "PYEXE=%%d\python.exe"
)
exit /b 0
