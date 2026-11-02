#Requires -Version 5.1
<#
.SYNOPSIS
  Deploy this working tree to a separate Windows runtime directory.

.DESCRIPTION
  Windows-side replacement for scripts/sync-to-windows.sh + update.bat when the
  git checkout is NOT the directory the bot runs from:

    1. copy source over (data/, node_modules/, dist/, web/dist/ and bin/ are
       preserved; .git and deploy-only files are not copied)
    2. npm run build in the runtime directory
    3. refresh .tsmusicbot-version.json so /api/health and the WebUI show the
       commit that is actually deployed
    4. restart the scheduled task and wait for /api/health

  Target and task resolve, in order, from:
    -Target / -TaskName parameters
    TSMB_WIN_DIR / TSMB_TASK_NAME environment variables
    deploy.windows.env next to this repo (same file the WSL script uses)
    .windows-deploy (legacy one-line path file)
    the runtime's .tsmusicbot-task-name

.PARAMETER Source
  Checkout to deploy. Defaults to the parent of this script's directory.

.PARAMETER Target
  Runtime directory (where package.json/data/ live).

.PARAMETER TaskName
  Windows scheduled task to restart. "none" skips the restart.

.PARAMETER Pull
  Run `git pull --ff-only` in the source checkout first.

.PARAMETER Mirror
  Pass /MIR to robocopy (delete files in the runtime that no longer exist in the
  source). Off by default: removing a file by accident is worse than a stale one.

.PARAMETER SkipBuild
  Copy + version stamp only.

.PARAMETER NoRestart
  Do not stop/start the scheduled task.

.PARAMETER AllowDirty
  Silence the "uncommitted changes" notice (the deploy still goes ahead either
  way; the notice is there so a debug build does not reach the runtime silently).

.PARAMETER NoPause
  Do not wait for Enter at the end (for terminal / CI use).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy.ps1 -NoPause

.EXAMPLE
  .\scripts\deploy.ps1 -Target D:\bots\tsmusicbot -Pull
#>
[CmdletBinding()]
param(
  [string]$Source = "",
  [string]$Target = "",
  [string]$TaskName = "",
  [switch]$Pull,
  [switch]$Mirror,
  [switch]$SkipBuild,
  [switch]$NoRestart,
  [switch]$AllowDirty,
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"

# --- Output helpers ---------------------------------------------------------

function Write-Step([string]$text) {
  Write-Host ""
  Write-Host "---- $text" -ForegroundColor Cyan
}
function Write-Ok([string]$text) {
  Write-Host "[OK] $text" -ForegroundColor Green
}
function Write-Note([string]$text) {
  Write-Host "[INFO] $text" -ForegroundColor Gray
}
function Write-Problem([string]$text) {
  Write-Host "[WARN] $text" -ForegroundColor Yellow
}
function Fail([string]$text) {
  Write-Host "[ERROR] $text" -ForegroundColor Red
  if (-not $NoPause -and $env:TSMB_DEPLOY_NOPAUSE -ne "1") {
    Read-Host "Press Enter to close" | Out-Null
  }
  exit 1
}

# Windows PowerShell 5.1 turns native stderr into a terminating error while
# $ErrorActionPreference is Stop (a missing task in `schtasks /Query`, a git
# warning, ...). Native calls therefore run with Continue and report through
# $LASTEXITCODE instead.
function Invoke-NativeQuiet([string]$File, [string[]]$Arguments) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $File @Arguments 2>&1 | Out-Null
  } finally {
    $ErrorActionPreference = $old
  }
  return $LASTEXITCODE
}

function Invoke-Git([string[]]$GitArgs, [switch]$Quiet) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    if ($Quiet) {
      return (& git @GitArgs 2>$null)
    }
    & git @GitArgs | Out-Host
    return $null
  } finally {
    $ErrorActionPreference = $old
  }
}

# --- Config ----------------------------------------------------------------

function Read-EnvFile([string]$path) {
  $map = @{}
  if (-not (Test-Path -LiteralPath $path)) { return $map }
  foreach ($line in Get-Content -LiteralPath $path -Encoding UTF8) {
    $line = $line.Trim()
    if (-not $line -or $line.StartsWith("#")) { continue }
    $m = [regex]::Match($line, '^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$')
    if (-not $m.Success) { continue }
    $val = $m.Groups[2].Value.Trim()
    if ($val.Length -ge 2) {
      $first = $val.Substring(0, 1)
      $last = $val.Substring($val.Length - 1, 1)
      if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
        $val = $val.Substring(1, $val.Length - 2)
      }
    }
    $map[$m.Groups[1].Value] = $val
  }
  return $map
}

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $Source) { $Source = $repoRoot }

if (-not (Test-Path -LiteralPath $Source)) { Fail "source directory not found: $Source" }
$Source = (Resolve-Path -LiteralPath $Source).Path
if (-not (Test-Path -LiteralPath (Join-Path $Source "package.json"))) {
  Fail "source does not look like the project (no package.json): $Source"
}

$envFile = Read-EnvFile (Join-Path $Source "deploy.windows.env")
function Get-DeploySetting([string]$name) {
  $fromProcess = [Environment]::GetEnvironmentVariable($name)
  if ($fromProcess) { return $fromProcess }
  if ($envFile.ContainsKey($name) -and $envFile[$name]) { return $envFile[$name] }
  return $null
}

if (-not $Target) {
  $Target = Get-DeploySetting "TSMB_WIN_DIR"
  if (-not $Target) {
    $legacy = Join-Path $Source ".windows-deploy"
    if (Test-Path -LiteralPath $legacy) {
      $Target = (Get-Content -LiteralPath $legacy -TotalCount 1).Trim()
    }
  }
}
if (-not $Target) {
  Fail @"
runtime directory not configured. Do one of:
  - pass -Target D:\path\to\runtime
  - set TSMB_WIN_DIR
  - copy deploy.windows.env.example to deploy.windows.env and edit TSMB_WIN_DIR
"@
}
if (-not (Test-Path -LiteralPath $Target)) { Fail "runtime directory not found: $Target" }
$Target = (Resolve-Path -LiteralPath $Target).Path

$srcCmp = $Source.TrimEnd('\')
$dstCmp = $Target.TrimEnd('\')
if ($srcCmp -ieq $dstCmp) { Fail "source and target are the same directory - nothing to deploy" }

if (-not $TaskName) {
  $TaskName = Get-DeploySetting "TSMB_TASK_NAME"
  if (-not $TaskName) {
    $taskFile = Join-Path $Target ".tsmusicbot-task-name"
    if (Test-Path -LiteralPath $taskFile) {
      $TaskName = (Get-Content -LiteralPath $taskFile -Raw -Encoding UTF8).Trim()
    }
  }
  if (-not $TaskName) { $TaskName = "TSMusicBot" }
}
$restart = -not $NoRestart -and $TaskName -ne "none"
$port = 3000
$cfgPath = Join-Path $Target "data\config.json"
if (Test-Path -LiteralPath $cfgPath) {
  try {
    $cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($cfg.webPort) { $port = [int]$cfg.webPort }
  } catch { }
}

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  TSMusicBot - Deploy (Windows)" -ForegroundColor Cyan
Write-Host "  From: $Source"
Write-Host "  To:   $Target"
Write-Host "  Task: $(if ($restart) { $TaskName } else { '(no restart)' })"
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "Preserved on the runtime: data/ node_modules/ dist/ web/dist/ bin/"
Write-Host ""

# --- Git -------------------------------------------------------------------

$hasGit = Test-Path -LiteralPath (Join-Path $Source ".git")

if ($Pull) {
  if (-not $hasGit) { Fail "-Pull needs a git checkout in $Source" }
  Write-Step "git pull --ff-only"
  Invoke-Git -GitArgs @("-C", $Source, "pull", "--ff-only") | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "git pull failed" }
  Write-Ok "source updated"
}

if ($hasGit) {
  $dirty = @(Invoke-Git -GitArgs @("-C", $Source, "status", "--porcelain") -Quiet)
  if ($LASTEXITCODE -ne 0) { $dirty = @() }
  if ($dirty.Count -gt 0) {
    if ($AllowDirty) {
      Write-Note "source has $($dirty.Count) uncommitted change(s) - deploying them (AllowDirty)"
    } else {
      Write-Problem "source has $($dirty.Count) uncommitted change(s); the runtime will get them."
      Write-Note "commit first, or re-run with -AllowDirty to silence this notice."
    }
  }
}

# --- Sync ------------------------------------------------------------------

# robocopy excludes need absolute source paths for the directories: a bare
# "data" would also drop src/data/ (the WSL script had exactly that bug).
$excludeDirs = @(
  (Join-Path $Source ".git"),
  (Join-Path $Source "node_modules"),
  (Join-Path $Source "web\node_modules"),
  (Join-Path $Source "data"),
  (Join-Path $Source "dist"),
  (Join-Path $Source "web\dist"),
  (Join-Path $Source "bin"),
  (Join-Path $Source ".windows-deploy"),
  (Join-Path $Source ".superpowers"),
  (Join-Path $Source ".worktrees"),
  (Join-Path $Source ".claude")
)
$excludeFiles = @(
  ".tsmusicbot-version.json",
  ".tsmusicbot-synced-from-wsl",
  ".tsmusicbot-task-name",
  "deploy.windows.env",
  "setup.log",
  "update.log",
  "*.db"
)

$roboArgs = @($Source, $Target, "/R:1", "/W:1", "/NFL", "/NDL", "/NP")
if ($Mirror) {
  $roboArgs += "/MIR"
  Write-Problem "Mirror mode: files missing from the source WILL be deleted under $Target"
} else {
  $roboArgs += "/E"
}
$roboArgs += @("/XD") + $excludeDirs + @("/XF") + $excludeFiles

Write-Step "Syncing source -> runtime"
& robocopy @roboArgs | Out-Host
$roboExit = $LASTEXITCODE
if ($roboExit -ge 8) { Fail "robocopy failed (exit $roboExit)" }
Write-Ok "source synced (robocopy exit $roboExit)"

# --- Version stamp ---------------------------------------------------------

$pkgVersion = "0.0.0"
try {
  $pkgVersion = (Get-Content -LiteralPath (Join-Path $Source "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
} catch { }

$commit = $null
$describe = $null
if ($hasGit) {
  $commit = Invoke-Git -GitArgs @("-C", $Source, "rev-parse", "--short", "HEAD") -Quiet
  if ($LASTEXITCODE -ne 0 -or -not $commit) { $commit = $null } else { $commit = ([string]$commit).Trim() }
  $describe = Invoke-Git -GitArgs @("-C", $Source, "describe", "--tags", "--always", "--dirty") -Quiet
  if ($LASTEXITCODE -ne 0 -or -not $describe) { $describe = $null } else { $describe = ([string]$describe).Trim() }
}
if (-not $describe) { $describe = $pkgVersion }

$stamp = [ordered]@{
  packageVersion = $pkgVersion
  commit         = $commit
  describe       = $describe
  syncedAt       = (Get-Date).ToString("yyyy-MM-ddTHH:mm:sszzz")
}
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$stampJson = (($stamp | ConvertTo-Json) -replace "`r`n", "`n") + "`n"
[System.IO.File]::WriteAllText((Join-Path $Target ".tsmusicbot-version.json"), $stampJson, $utf8NoBom)

# update.bat / stop.bat read this when TSMB_TASK_NAME is unset.
[System.IO.File]::WriteAllText((Join-Path $Target ".tsmusicbot-task-name"), $TaskName, $utf8NoBom)
Write-Ok "version stamp: $describe (commit $(if ($commit) { $commit } else { 'unknown' }))"

# --- Build -----------------------------------------------------------------

if ($SkipBuild) {
  Write-Note "skipping build (-SkipBuild)"
} else {
  Write-Step "Building in the runtime directory"
  if (-not (Test-Path -LiteralPath (Join-Path $Target "node_modules"))) {
    Fail "runtime has no node_modules - run scripts\setup.bat there once"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $Target "web\node_modules"))) {
    Fail "runtime has no web\node_modules - run scripts\setup.bat there once"
  }

  $npm = "npm"
  $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($npmCmd) { $npm = $npmCmd.Source }

  Push-Location $Target
  $oldEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $npm run build
    $buildExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldEap
    Pop-Location
  }
  if ($buildExit -ne 0) { Fail "npm run build failed (exit $buildExit)" }
  Write-Ok "build finished"
}

# --- Restart ---------------------------------------------------------------

function Test-PortListening([int]$Port) {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  return [bool]$conn
}

function Wait-Port([int]$Port, [bool]$Open, [int]$TimeoutSec) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if ((Test-PortListening $Port) -eq $Open) { return $true }
    Start-Sleep -Milliseconds 400
  }
  return ((Test-PortListening $Port) -eq $Open)
}

if (-not $restart) {
  Write-Note "skipping restart"
} else {
  $taskExists = (Invoke-NativeQuiet "schtasks" @("/Query", "/TN", $TaskName)) -eq 0
  if (-not $taskExists) {
    Write-Problem "scheduled task '$TaskName' not found - start the bot manually (scripts\start.bat)"
  } else {
    Write-Step "Restarting task '$TaskName'"
    Invoke-NativeQuiet "schtasks" @("/End", "/TN", $TaskName) | Out-Null
    if (-not (Wait-Port -Port $port -Open $false -TimeoutSec 20)) {
      Write-Problem "port $port is still busy after stopping the task; the new process may fail to bind"
    }

    $runExit = Invoke-NativeQuiet "schtasks" @("/Run", "/TN", $TaskName)
    if ($runExit -ne 0) { Fail "schtasks /Run failed - run this from an elevated shell" }

    if (-not (Wait-Port -Port $port -Open $true -TimeoutSec 40)) {
      Fail "web server did not start listening on port $port"
    }

    $health = $null
    for ($i = 0; $i -lt 20; $i++) {
      try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 3
        break
      } catch {
        Start-Sleep -Milliseconds 500
      }
    }
    if ($health) {
      Write-Ok "health: status=$($health.status) version=$($health.version) commit=$($health.commit)"
    } else {
      Write-Problem "/api/health did not answer yet - check data\logs\bot.log"
    }
  }
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "  Deploy complete - http://localhost:$port" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host "data/ was left untouched."
Write-Host ""

if (-not $NoPause -and $env:TSMB_DEPLOY_NOPAUSE -ne "1") {
  Read-Host "Press Enter to close" | Out-Null
}
exit 0
