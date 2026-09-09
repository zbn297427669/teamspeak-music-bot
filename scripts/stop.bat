@echo off
setlocal
chcp 65001 >nul
title TSMusicBot Stop

:: Stop TSMusicBot (scheduled task + node for this tree)
:: Optional: TSMB_TASK_NAME (default TSMusicBot)

cd /d "%~dp0.." || (
    echo [FATAL] Cannot change to project directory.
    exit /b 1
)
set "PROJECT_ROOT=%cd%"

if "%TSMB_TASK_NAME%"=="" if exist ".tsmusicbot-task-name" (
    set /p TSMB_TASK_NAME=<.tsmusicbot-task-name
)
if "%TSMB_TASK_NAME%"=="" set "TSMB_TASK_NAME=TSMusicBot"
for /f "delims=" %%a in ("%TSMB_TASK_NAME%") do set "TSMB_TASK_NAME=%%a"

echo ============================================
echo   TSMusicBot - Stop
echo   Project: %PROJECT_ROOT%
echo   Task:    %TSMB_TASK_NAME%
echo ============================================
echo/

schtasks /Query /TN "%TSMB_TASK_NAME%" >nul 2>&1
if not errorlevel 1 (
    echo Stopping scheduled task "%TSMB_TASK_NAME%"...
    schtasks /End /TN "%TSMB_TASK_NAME%" >nul 2>&1
    if errorlevel 1 (
        echo [WARN] schtasks /End failed or task was not running.
    ) else (
        echo [OK] Scheduled task end requested.
    )
) else (
    echo [INFO] Scheduled task "%TSMB_TASK_NAME%" not found - skipping.
    echo        If your task has another name: set TSMB_TASK_NAME=YourName
)

echo Stopping node process for this project (if any)...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$root = [System.IO.Path]::GetFullPath('%PROJECT_ROOT%');" ^
  "$needle = ($root.TrimEnd('\') + '\dist\index.js').ToLowerInvariant();" ^
  "$n = 0;" ^
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" -ErrorAction SilentlyContinue | ForEach-Object {" ^
  "  $cl = $_.CommandLine; if (-not $cl) { return }" ^
  "  if ($cl.ToLowerInvariant().Contains($needle)) {" ^
  "    try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $n++ } catch {}" ^
  "  }" ^
  "};" ^
  "if ($n -gt 0) { Write-Host ('[OK] Stopped ' + $n + ' node process(es).') }" ^
  "else { Write-Host '[INFO] No matching node process found.' }"

echo/
echo Done. data/ was not touched.
exit /b 0
