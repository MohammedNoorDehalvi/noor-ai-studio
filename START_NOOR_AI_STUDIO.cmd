@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows-bootstrap.ps1" -Mode Run
exit /b %ERRORLEVEL%
