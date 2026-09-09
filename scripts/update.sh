#!/usr/bin/env bash
set -euo pipefail

# One-click update for Linux / WSL.
#
# 【WSL → Windows 桥接】（迁独立 Linux 服务器后可忽略）:
#   cp deploy.windows.env.example deploy.windows.env
#   edit TSMB_WIN_DIR / TSMB_TASK_NAME
#   ./scripts/update.sh
#
# 【Linux 服务器】不要配置 TSMB_WIN_DIR；本脚本走本机 git pull + 智能重建 + systemd。
#
# Modes (first match):
# 1) TSMB_WIN_DIR from deploy.windows.env → pull → sync → Windows build
# 2) Same-folder on /mnt/... → update.bat
# 3) Native Linux

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="$PROJECT_DIR/update.log"

# shellcheck source=lib/deploy-env.sh
source "$SCRIPT_DIR/lib/deploy-env.sh"
tsmb_load_deploy_config "$PROJECT_DIR"

TASK_NAME="${TSMB_TASK_NAME:-TSMusicBot}"
SERVICE_NAME="${TSMB_SERVICE_NAME:-tsmusicbot}"
export TSMB_TASK_NAME="$TASK_NAME"

cd "$PROJECT_DIR"
: >"$LOG_FILE"
{
  echo "[$(date -Iseconds)] Update started"
  echo "[$(date -Iseconds)] Project: $PROJECT_DIR"
  echo "[$(date -Iseconds)] TSMB_WIN_DIR=${TSMB_WIN_DIR:-<unset>}"
} >>"$LOG_FILE"

is_wsl() {
  grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null || [[ -n "${WSL_DISTRO_NAME:-}" ]]
}

want_windows_same_dir() {
  [[ "${TSMB_FORCE_LINUX:-}" == "1" ]] && return 1
  [[ "${TSMB_WINDOWS:-}" == "1" ]] && return 0
  is_wsl && command -v cmd.exe >/dev/null 2>&1 && command -v schtasks.exe >/dev/null 2>&1
}

has_win_deploy() {
  [[ -n "${TSMB_WIN_DIR:-}" ]]
}

run_windows_bat_in() {
  local linux_dir="$1"
  echo "Running Windows update.bat in: $(wslpath -w "$linux_dir")"
  export TSMB_SKIP_PULL=1
  export TSMB_SETUP_NOPAUSE=1
  export TSMB_UPDATE_NOPAUSE=1
  tsmb_run_win_bat "$linux_dir" "scripts\\update.bat"
}

update_via_windows_bat_same_dir() {
  local linux_dir="$PROJECT_DIR"
  # Same-folder mode only works when the repo itself is on a Windows mount (/mnt/...).
  if [[ "$linux_dir" != /mnt/* ]]; then
    echo "[ERROR] Same-folder Windows update requires the repo under /mnt/<drive>/..."
    echo "        Current path is on the Linux filesystem: $linux_dir"
    echo "        Use deploy.windows.env (TSMB_WIN_DIR) for split deploy instead."
    exit 1
  fi
  echo "============================================"
  echo "  TSMusicBot - Update (WSL same folder → Windows)"
  echo "  Project: $linux_dir"
  echo "  Windows: $(wslpath -w "$linux_dir")"
  echo "============================================"
  echo
  export TSMB_SETUP_NOPAUSE=1
  export TSMB_UPDATE_NOPAUSE=1
  tsmb_run_win_bat "$linux_dir" "scripts\\update.bat"
}

deps_changed_between() {
  local old="$1" new="$2"
  [[ -z "$old" || -z "$new" ]] && return 1
  git diff --name-only "$old" "$new" -- \
    package.json package-lock.json web/package.json web/package-lock.json \
    | grep -q .
}

update_split_deploy() {
  local win_linux
  win_linux="$(tsmb_win_dir_linux)" || {
    echo "[ERROR] Cannot resolve TSMB_WIN_DIR=${TSMB_WIN_DIR}"
    exit 1
  }
  local win_win
  win_win="$(wslpath -w "$win_linux")"

  echo "============================================"
  echo "  TSMusicBot - Update (WSL git → Windows runtime)"
  echo "  Config:        deploy.windows.env (or env)"
  echo "  Git (WSL):     $PROJECT_DIR"
  echo "  Runtime (Win): $win_linux"
  echo "                 $win_win"
  echo "  Task:          $TASK_NAME"
  echo "============================================"
  echo
  echo "Flow: git pull → sync source → Windows smart build → restart task"
  echo "Windows keeps: data/  node_modules/  dist/  bin/"
  echo

  if ! command -v git >/dev/null 2>&1; then
    echo "[ERROR] git not found in WSL PATH."
    exit 1
  fi
  if [[ ! -d .git ]]; then
    echo "[ERROR] WSL directory is not a git clone (.git missing)."
    exit 1
  fi
  if ! command -v cmd.exe >/dev/null 2>&1; then
    echo "[ERROR] cmd.exe not found — need WSL with Windows interop."
    exit 1
  fi

  local old_head
  old_head="$(git rev-parse HEAD 2>/dev/null || true)"

  echo "---- [1/4] git pull (WSL) ----"
  if [[ "${TSMB_SKIP_PULL:-}" == "1" ]]; then
    echo "[INFO] TSMB_SKIP_PULL=1 — skipped."
  else
    if ! git pull --ff-only >>"$LOG_FILE" 2>&1; then
      echo "[ERROR] git pull failed. See $LOG_FILE"
      exit 1
    fi
    echo "[OK] HEAD=$(git rev-parse --short HEAD)"
  fi
  echo

  if [[ "${TSMB_FULL_SETUP:-}" != "1" && "${TSMB_SKIP_PULL:-}" != "1" ]] \
    && deps_changed_between "$old_head" HEAD; then
    echo "[INFO] Dependency manifests changed — will force full Windows setup."
    export TSMB_FULL_SETUP=1
  fi

  echo "---- [2/4] Stop Windows bot ----"
  if [[ -f "$win_linux/scripts/stop.bat" ]]; then
    tsmb_run_win_bat "$win_linux" "scripts\\stop.bat" \
      || echo "[WARN] stop.bat warning; continuing."
  else
    # First sync may not have stop.bat yet — end task by name only.
    (
      cd "$win_linux" 2>/dev/null || cd /mnt/c/Windows/System32 || true
      schtasks.exe /End /TN "$TASK_NAME" >/dev/null 2>&1 \
        || echo "[WARN] schtasks /End failed or task not running."
    )
  fi
  sleep 2
  echo

  echo "---- [3/4] Sync WSL → Windows (preserve data/ + node_modules) ----"
  bash "$SCRIPT_DIR/sync-to-windows.sh"
  echo

  echo "---- [4/4] Windows rebuild + start (skip git pull) ----"
  if [[ ! -f "$win_linux/scripts/update.bat" ]]; then
    echo "[ERROR] After sync, scripts\\update.bat missing under Windows dir."
    exit 1
  fi
  run_windows_bat_in "$win_linux"

  echo
  echo "============================================"
  echo "  Split deploy update complete"
  echo "============================================"
  echo "Edit deploy.windows.env if the Windows folder moves or is renamed."
  echo "[$(date -Iseconds)] Update finished OK" >>"$LOG_FILE"
}

update_linux() {
  echo "============================================"
  echo "  TSMusicBot - Update (Linux, smart)"
  echo "  Project: $PROJECT_DIR"
  echo "  Service: $SERVICE_NAME"
  echo "============================================"
  echo

  if ! command -v git >/dev/null 2>&1; then
    echo "[ERROR] git not found in PATH."
    exit 1
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "[ERROR] node not found. Run scripts/setup.sh once first."
    exit 1
  fi
  if [[ ! -d .git ]]; then
    echo "[ERROR] Not a git clone (.git missing)."
    exit 1
  fi

  echo "---- [1/4] Stopping bot ----"
  bash "$SCRIPT_DIR/stop.sh" || echo "[WARN] stop.sh reported an error; continuing."
  sleep 2
  echo

  local old_head
  old_head="$(git rev-parse HEAD 2>/dev/null || true)"

  echo "---- [2/4] Updating source (git pull) ----"
  if [[ "${TSMB_SKIP_PULL:-}" == "1" ]]; then
    echo "[INFO] TSMB_SKIP_PULL=1 — skipped git pull."
  else
    if ! git pull --ff-only >>"$LOG_FILE" 2>&1; then
      echo "[ERROR] git pull failed. See $LOG_FILE"
      exit 1
    fi
    echo "[OK] Source updated. HEAD=$(git rev-parse --short HEAD)"
  fi
  echo

  echo "---- [3/4] Rebuild ----"
  local need_full=0
  [[ "${TSMB_FULL_SETUP:-}" == "1" ]] && need_full=1
  [[ ! -d node_modules || ! -d web/node_modules || ! -f node_modules/.tsmusicbot-abi ]] && need_full=1

  if [[ "$need_full" -eq 0 && "${TSMB_SKIP_PULL:-}" != "1" ]] && deps_changed_between "$old_head" HEAD; then
    need_full=1
  fi

  if [[ "$need_full" -eq 0 ]]; then
    if ! node scripts/check-native.mjs >>"$LOG_FILE" 2>&1; then
      need_full=1
    fi
  fi

  if [[ "$need_full" -eq 1 ]]; then
    bash "$SCRIPT_DIR/setup.sh"
  else
    if ! npm run build >>"$LOG_FILE" 2>&1; then
      echo "[ERROR] npm run build failed. See $LOG_FILE"
      exit 1
    fi
    [[ -f dist/index.js && -d web/dist ]] || { echo "[ERROR] build outputs missing."; exit 1; }
    echo "[OK] Quick build finished."
  fi
  echo

  echo "---- [4/4] Starting bot ----"
  if [[ "${TSMB_NO_START:-}" == "1" ]]; then
    echo "[INFO] TSMB_NO_START=1 — skipped start."
  elif command -v systemctl >/dev/null 2>&1 \
    && (systemctl list-unit-files "${SERVICE_NAME}.service" &>/dev/null \
        || systemctl status "${SERVICE_NAME}" &>/dev/null); then
    sudo -n systemctl start "${SERVICE_NAME}" 2>/dev/null \
      || systemctl --user start "${SERVICE_NAME}" 2>/dev/null \
      || sudo systemctl start "${SERVICE_NAME}"
    echo "[OK] systemctl start ${SERVICE_NAME}"
  else
    echo "[WARN] systemd unit ${SERVICE_NAME} not found."
  fi

  echo "[$(date -Iseconds)] Update finished OK" >>"$LOG_FILE"
}

if has_win_deploy; then
  update_split_deploy
elif want_windows_same_dir; then
  update_via_windows_bat_same_dir
else
  update_linux
fi
