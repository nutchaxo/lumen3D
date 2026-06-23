@echo off
cd /d "%~dp0"
start "" http://localhost:8080
py dev_server.py
pause
