@echo off
REM Thin wrapper - delegates to PowerShell for proper UTF-8 / Unicode support
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0start.ps1"
