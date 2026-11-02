@echo off
setlocal
chcp 65001 >nul
title TSMusicBot Deploy

:: Thin wrapper so the deploy can be double-clicked or run from cmd.
:: All flags are passed through to deploy.ps1 (e.g. -Pull, -NoRestart, -NoPause).
::   scripts\deploy.bat -NoPause
:: Config: -Target / TSMB_WIN_DIR / deploy.windows.env / .tsmusicbot-task-name.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" %*
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" (
    echo.
    echo [ERROR] Deploy failed with exit code %CODE%.
    pause
)
exit /b %CODE%
