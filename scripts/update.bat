@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title TSMusicBot Update

:: One-click update for Windows (smart rebuild + restart).
:: Split-deploy from WSL: set TSMB_SKIP_PULL=1 (no .git required here).
::
:: Env: TSMB_TASK_NAME TSMB_SKIP_PULL TSMB_NO_START TSMB_FULL_SETUP TSMB_UPDATE_NOPAUSE

cd /d "%~dp0.." || (
    echo [FATAL] Cannot change to project directory.
    pause
    exit /b 1
)
set "PROJECT_ROOT=%cd%"
set "LOG_FILE=%PROJECT_ROOT%\update.log"

if "%TSMB_TASK_NAME%"=="" if exist ".tsmusicbot-task-name" (
    set /p TSMB_TASK_NAME=<.tsmusicbot-task-name
)
if "%TSMB_TASK_NAME%"=="" set "TSMB_TASK_NAME=TSMusicBot"
:: trim trailing whitespace/CR from set /p
for /f "delims=" %%a in ("%TSMB_TASK_NAME%") do set "TSMB_TASK_NAME=%%a"

type nul > "%LOG_FILE%"
echo Update started>> "%LOG_FILE%"
echo Project: %PROJECT_ROOT%>> "%LOG_FILE%"

echo ============================================
echo   TSMusicBot - Update
echo   Project: %PROJECT_ROOT%
echo   Task:    %TSMB_TASK_NAME%
echo   Log:     %LOG_FILE%
echo ============================================
echo/
echo This upgrades IN PLACE. data/ is preserved.
echo Default is SMART update: reuse node_modules when possible.
echo Do NOT replace the whole folder with a zip release.
echo/

:: ---- Prechecks ----
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

:: Git is optional when WSL already pulled + synced (TSMB_SKIP_PULL=1).
set "DO_PULL=1"
if /i "%TSMB_SKIP_PULL%"=="1" set "DO_PULL=0"
if not exist ".git" set "DO_PULL=0"

if "%DO_PULL%"=="1" (
    where git >nul 2>&1
    if errorlevel 1 (
        echo [ERROR] git not found in PATH.
        pause
        exit /b 1
    )
)

:: ---- Step 1: stop ----
echo ---- [1/4] Stopping bot ----
call "%~dp0stop.bat"
timeout /t 2 /nobreak >nul
echo/

:: ---- Step 2: git pull (same-folder installs only) ----
echo ---- [2/4] Updating source ----
set "OLD_HEAD="
set "NEED_FULL=0"

if "%DO_PULL%"=="0" (
    echo [INFO] Skip git pull on Windows (WSL sync or no .git^).
) else (
    for /f "delims=" %%h in ('git rev-parse HEAD 2^>nul') do set "OLD_HEAD=%%h"
    echo Running: git pull --ff-only
    git pull --ff-only >>"%LOG_FILE%" 2>&1
    if errorlevel 1 (
        echo [ERROR] git pull failed. Check: %LOG_FILE%
        pause
        exit /b 1
    )
    for /f "delims=" %%h in ('git rev-parse --short HEAD 2^>nul') do set "HEAD_SHA=%%h"
    echo [OK] Source updated. HEAD=!HEAD_SHA!

    if not "!OLD_HEAD!"=="" (
        for /f "delims=" %%f in ('git diff --name-only "!OLD_HEAD!" HEAD -- package.json package-lock.json web/package.json web/package-lock.json 2^>nul') do (
            echo [INFO] Dependency file changed: %%f
            set "NEED_FULL=1"
        )
    )
)
echo/

:: ---- Step 3: smart rebuild vs full setup ----
echo ---- [3/4] Rebuild ----

if /i "%TSMB_FULL_SETUP%"=="1" (
    echo [INFO] TSMB_FULL_SETUP=1 - forcing full setup.bat
    set "NEED_FULL=1"
)

if not exist "node_modules" set "NEED_FULL=1"
if not exist "web\node_modules" set "NEED_FULL=1"
if not exist "node_modules\.tsmusicbot-abi" set "NEED_FULL=1"

if "!NEED_FULL!"=="0" (
    echo Checking native modules against current Node...
    node scripts\check-native.mjs >>"%LOG_FILE%" 2>&1
    if errorlevel 1 (
        echo [INFO] Native ABI check failed - full setup required.
        set "NEED_FULL=1"
    ) else (
        echo [OK] Native modules match this Node.
    )
)

if "!NEED_FULL!"=="1" (
    echo/
    echo Running FULL setup.bat ...
    echo This may take several minutes. See also setup.log
    echo/
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
    echo/
    echo Reusing existing node_modules - only npm run build.
    echo Set TSMB_FULL_SETUP=1 to force a full setup.bat
    echo/
    echo Running: npm run build
    call npm run build >>"%LOG_FILE%" 2>&1
    if errorlevel 1 (
        echo [ERROR] npm run build failed. Check: %LOG_FILE%
        echo Tip: set TSMB_FULL_SETUP=1 and re-run
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
echo/

:: ---- Step 4: start ----
echo ---- [4/4] Starting bot ----
if /i "%TSMB_NO_START%"=="1" (
    echo [INFO] TSMB_NO_START=1 - skipped start.
    goto :done
)

schtasks /Query /TN "%TSMB_TASK_NAME%" >nul 2>&1
if errorlevel 1 (
    echo [WARN] Scheduled task "%TSMB_TASK_NAME%" not found.
    echo        Start manually: scripts\start.bat
    goto :done
)

schtasks /Run /TN "%TSMB_TASK_NAME%" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] schtasks /Run failed. Try Task Scheduler UI or Admin.
    pause
    exit /b 1
)
echo [OK] Scheduled task "%TSMB_TASK_NAME%" started.
echo      WebUI: http://localhost:3000

:done
echo/
echo ============================================
echo   Update complete
echo ============================================
echo data/ was kept in place (config / DB / cookies).
echo Log: %LOG_FILE%
echo/
echo Update finished OK>> "%LOG_FILE%"
if /i "%TSMB_UPDATE_NOPAUSE%"=="1" exit /b 0
pause
exit /b 0
