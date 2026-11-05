@echo off
cd /d "%~dp0"
echo Starting the local web server (dev_server.py)...
echo Press Ctrl+C in this window to stop it.
echo.

:: Same safe server as start_dev.bat: static files + the admin API behind the CSP
:: and the folder guards (api/, secrets/, uploads/ are never served).
:: A bare "python -m http.server" would serve the credential store.
set "PYCMD="
where py >nul 2>nul && set "PYCMD=py"
if not defined PYCMD where python >nul 2>nul && set "PYCMD=python"
if not defined PYCMD (
    echo.
    echo Python 3 was not found. Install it from https://www.python.org/downloads/
    echo ^(tick "Add python.exe to PATH"^) and run this file again.
    pause
    exit /b 1
)

start "" http://localhost:8080
%PYCMD% dev_server.py
pause
