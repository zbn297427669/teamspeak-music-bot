#!/usr/bin/env bash
set -euo pipefail

# Stop TSMusicBot.
# - Native Linux: systemd unit (default tsmusicbot) + matching node process
# - WSL + Windows Task Scheduler: delegates to stop.bat via cmd.exe
#   （【仅 WSL 桥接】迁独立 Linux 服务器后不会走这条路径）
# - Split deploy: use TSMB_WIN_DIR / deploy.windows.env
#
# Env:
#   TSMB_TASK_NAME / TSMB_WIN_DIR / deploy.windows.env
#   TSMB_WINDOWS=1 | TSMB_FORCE_LINUX=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=lib/deploy-env.sh
source "$SCRIPT_DIR/lib/deploy-env.sh"
tsmb_load_deploy_config "$PROJECT_DIR"

TASK_NAME="${TSMB_TASK_NAME:-TSMusicBot}"
SERVICE_NAME="${TSMB_SERVICE_NAME:-tsmusicbot}"
export TSMB_TASK_NAME="$TASK_NAME"

is_wsl() {
  grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null || [[ -n "${WSL_DISTRO_NAME:-}" ]]
}

want_windows() {
  [[ "${TSMB_FORCE_LINUX:-}" == "1" ]] && return 1
  [[ "${TSMB_WINDOWS:-}" == "1" ]] && return 0
  [[ -n "${TSMB_WIN_DIR:-}" ]] && return 0
  is_wsl && command -v cmd.exe >/dev/null 2>&1 && command -v schtasks.exe >/dev/null 2>&1
}

stop_linux() {
  echo "============================================"
  echo "  TSMusicBot - Stop (Linux)"
  echo "  Project: $PROJECT_DIR"
  echo "  Service: $SERVICE_NAME"
  echo "============================================"
  echo

  if command -v systemctl >/dev/null 2>&1; then
    if systemctl list-unit-files "${SERVICE_NAME}.service" &>/dev/null \
      || systemctl status "${SERVICE_NAME}" &>/dev/null; then
      echo "Stopping systemd unit ${SERVICE_NAME}..."
      if sudo -n systemctl stop "${SERVICE_NAME}" 2>/dev/null \
        || systemctl --user stop "${SERVICE_NAME}" 2>/dev/null \
        || sudo systemctl stop "${SERVICE_NAME}"; then
        echo "[OK] systemctl stop ${SERVICE_NAME}"
      else
        echo "[WARN] systemctl stop failed or unit not running."
      fi
    else
      echo "[INFO] systemd unit ${SERVICE_NAME} not found — skipping."
    fi
  fi

  echo "Stopping node process for this project (if any)..."
  local needle="${PROJECT_DIR}/dist/index.js"
  local n=0
  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    if kill -TERM "$pid" 2>/dev/null; then
      n=$((n + 1))
    fi
  done < <(pgrep -f "node .*${needle}" 2>/dev/null || true)
  if [[ "$n" -gt 0 ]]; then
    sleep 1
    pgrep -f "node .*${needle}" >/dev/null 2>&1 && pkill -9 -f "node .*${needle}" 2>/dev/null || true
    echo "[OK] Stopped ${n} node process(es)."
  else
    echo "[INFO] No matching node process found."
  fi

  echo
  echo "Done. data/ was not touched."
}

stop_windows_via_cmd() {
  local linux_dir=""
  if [[ -n "${TSMB_WIN_DIR:-}" ]]; then
    linux_dir="$(tsmb_win_dir_linux)" || true
  fi
  if [[ -z "$linux_dir" ]]; then
    linux_dir="$PROJECT_DIR"
  fi
  if [[ "$linux_dir" != /mnt/* ]]; then
    echo "[ERROR] Cannot run Windows stop.bat from a Linux-only path: $linux_dir"
    echo "        Set TSMB_WIN_DIR in deploy.windows.env to a /mnt/<drive>/... path."
    exit 1
  fi

  echo "============================================"
  echo "  TSMusicBot - Stop (WSL → Windows)"
  echo "  Runtime: $linux_dir"
  echo "  Windows: $(wslpath -w "$linux_dir")"
  echo "  Task:    $TASK_NAME"
  echo "============================================"
  echo

  if [[ -f "$linux_dir/scripts/stop.bat" ]]; then
    tsmb_run_win_bat "$linux_dir" "scripts\\stop.bat"
  else
    echo "[WARN] stop.bat not found yet; ending scheduled task only."
    (
      cd "$linux_dir" || exit 1
      schtasks.exe /End /TN "$TASK_NAME" || true
    )
  fi
}

cd "$PROJECT_DIR"

if want_windows; then
  stop_windows_via_cmd
else
  stop_linux
fi
