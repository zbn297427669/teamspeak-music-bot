@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title TSMusicBot Update

:: ============================================================
::  One-click update for Windows (git pull + rebuild + restart)
::  - Keeps data\ in place — no file copy / zip replace
::  - Default: SMART update — reuse existing node_modules when deps
::    and Node ABI are unchanged; only npm run build
::  - Full setup.bat only when lockfiles change, modules missing,
::    or native ABI check fails
::
::  Optional env:
::    TSMB_TASK_NAME      scheduled task name (default: TSMusicBot)
::    TSMB_SKIP_PULL=1    skip git pull
::    TSMB_NO_START=1     do not Start-ScheduledTask after build
::    TSMB_FULL_SETUP=1   always run full setup.bat (slow, safest)
::    TSMB_UPDATE_NOPAUSE=1  no pause at end (used by WSL update.sh)
:: ============================================================

cd /d "%~dp0.." || (
    echo [FATAL] Cannot change to project directory.
    pause
    exit /b 1
)
set "PROJECT_ROOT=%cd%"
set "LOG_FILE=%PROJECT_ROOT%\update.log"

if "%TSMB_TASK_NAME%"=="" set "TSMB_TASK_NAME=TSMusicBot"

echo. > "%LOG_FILE%"
echo [%date% %time%] Update started >> "%LOG_FILE%"
echo [%date% %time%] Project: %PROJECT_ROOT% >> "%LOG_FILE%"

echo ============================================
echo   TSMusicBot - Update
echo   Project: %PROJECT_ROOT%
echo   Task:    %TSMB_TASK_NAME%
echo   Log:     %LOG_FILE%
echo ============================================
echo.
echo This upgrades IN PLACE. data\ is preserved.
echo Default is SMART update: reuse node_modules when possible.
echo Do NOT replace the whole folder with a zip release.
echo.

:: ---- Prechecks ----
where git >nul 2>&1
if errorlevel 1 (
    echo [ERROR] git not found in PATH.
    echo Install Git for Windows, or set TSMB_SKIP_PULL=1 and update files another way.
    pause
    exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] node not found. Run scripts\setup.bat once first.
    pause
    exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm not found.
    pause
    exit /b 1
)

if not exist ".git" (
    echo [ERROR] This directory is not a git clone (.git missing).
    echo Clone once, then keep using this folder + scripts\update.bat.
    pause
    exit /b 1
)

:: ---- Step 1: stop ----
echo ---- [1/4] Stopping bot ----
call "%~dp0stop.bat"
if errorlevel 1 (
    echo [WARN] stop.bat reported an error; continuing anyway.
)
timeout /t 2 /nobreak >nul
echo.

:: ---- Step 2: git pull ----
echo ---- [2/4] Updating source (git pull) ----
set "OLD_HEAD="
for /f "delims=" %%h in ('git rev-parse HEAD 2^>nul') do set "OLD_HEAD=%%h"

if "%TSMB_SKIP_PULL%"=="1" (
    echo [INFO] TSMB_SKIP_PULL=1 — skipped git pull.
) else (
    echo Running: git pull --ff-only
    git pull --ff-only >>"%LOG_FILE%" 2>&1
    if errorlevel 1 (
        echo [ERROR] git pull failed. Common causes:
        echo   - local edits conflict with upstream
        echo   - no network / wrong remote
        echo Check: %LOG_FILE%
        echo Tip: git status / git stash, then re-run scripts\update.bat
        pause
        exit /b 1
    )
    for /f "delims=" %%h in ('git rev-parse --short HEAD 2^>nul') do set "HEAD_SHA=%%h"
    echo [OK] Source updated. HEAD=!HEAD_SHA!
)
echo.

:: ---- Step 3: smart rebuild vs full setup ----
echo ---- [3/4] Rebuild ----
set "NEED_FULL=0"

if /i "%TSMB_FULL_SETUP%"=="1" (
    echo [INFO] TSMB_FULL_SETUP=1 — forcing full setup.bat
    set "NEED_FULL=1"
    goto :do_rebuild
)

if not exist "node_modules" set "NEED_FULL=1"
if not exist "web\node_modules" set "NEED_FULL=1"
if not exist "node_modules\.tsmusicbot-abi" set "NEED_FULL=1"

:: If pull moved HEAD, see whether dependency manifests changed
if not "%OLD_HEAD%"=="" (
    if not "%TSMB_SKIP_PULL%"=="1" (
        git diff --name-only "%OLD_HEAD%" HEAD -- package.json package-lock.json web/package.json web/package-lock.json >>"%LOG_FILE%" 2>&1
        for /f "delims=" %%f in ('git diff --name-only "%OLD_HEAD%" HEAD -- package.json package-lock.json web/package.json web/package-lock.json 2^>nul') do (
            echo [INFO] Dependency file changed: %%f
            set "NEED_FULL=1"
        )
    )
)

:: Native modules must match this Node ABI
if "!NEED_FULL!"=="0" (
    echo Checking native modules against current Node...
    node scripts\check-native.mjs >>"%LOG_FILE%" 2>&1
    if errorlevel 1 (
        echo [INFO] Native ABI check failed — full setup required.
        set "NEED_FULL=1"
    ) else (
        echo [OK] Native modules match this Node.
    )
)

:do_rebuild
if "!NEED_FULL!"=="1" (
    echo.
    echo Running FULL setup.bat (deps and/or native modules need refresh)...
    echo This may take several minutes. See also setup.log
    echo.
    set "TSMB_SETUP_NOPAUSE=1"
    call "%~dp0setup.bat"
    set "SETUP_RESULT=!errorlevel!"
    set "TSMB_SETUP_NOPAUSE="
    if not "!SETUP_RESULT!"=="0" (
        echo [ERROR] setup.bat failed with code !SETUP_RESULT!
        echo Check setup.log and update.log
        pause
        exit /b 1
    )
    echo [OK] Full setup finished.
) else (
    echo.
    echo Reusing existing node_modules — only rebuilding JS/TS + web UI.
    echo ^(Set TSMB_FULL_SETUP=1 to force a full setup.bat^)
    echo.
    echo Running: npm run build
    call npm run build >>"%LOG_FILE%" 2>&1
    if errorlevel 1 (
        echo [ERROR] npm run build failed. Check: %LOG_FILE%
        echo Tip: set TSMB_FULL_SETUP=1 and re-run scripts\update.bat
        pause
        exit /b 1
    )
    if not exist "dist\index.js" (
        echo [ERROR] dist\index.js missing after build.
        pause
        exit /b 1
    )
    if not exist "web\dist" (
        echo [ERROR] web\dist missing after build.
        pause
        exit /b 1
    )
    echo [OK] Quick build finished.
)
echo.

:: ---- Step 4: start ----
echo ---- [4/4] Starting bot ----
if "%TSMB_NO_START%"=="1" (
    echo [INFO] TSMB_NO_START=1 — skipped start. Run task or scripts\start.bat yourself.
    goto :done
)

schtasks /Query /TN "%TSMB_TASK_NAME%" >nul 2>&1
if errorlevel 1 (
    echo [WARN] Scheduled task "%TSMB_TASK_NAME%" not found.
    echo        Start manually: scripts\start.bat
    echo        Or create the task — see docs\WINDOWS_AUTOSTART.md
    goto :done
)

schtasks /Run /TN "%TSMB_TASK_NAME%" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] schtasks /Run failed. Try running as Administrator,
    echo         or start the task from Task Scheduler UI.
    pause
    exit /b 1
)
echo [OK] Scheduled task "%TSMB_TASK_NAME%" started.
echo      WebUI: http://localhost:3000

:done
echo.
echo ============================================
echo   Update complete
echo ============================================
echo data\ was kept in place (config / DB / cookies).
echo Log: %LOG_FILE%
echo.
echo [%date% %time%] Update finished OK >> "%LOG_FILE%"
if /i "%TSMB_UPDATE_NOPAUSE%"=="1" exit /b 0
pause
exit /b 0
