@echo off
rem Double-click or run: run.bat [-Secure] [-Stop] [-NoBrowser]
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" %*
if errorlevel 1 pause
