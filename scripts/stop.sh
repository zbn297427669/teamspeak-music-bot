#!/usr/bin/env bash
set -euo pipefail

# Stop TSMusicBot.
# - Native Linux: systemd unit (default tsmusicbot) + matching node process
# - WSL + Windows Task Scheduler: delegates to stop.bat via cmd.exe
#
# Env:
#   TSMB_TASK_NAME     Windows task / hint (default: TSMusicBot)
#   TSMB_SERVICE_NAME  systemd unit without .service (default: tsmusicbot)
#   TSMB_WINDOWS=1     force Windows stop.bat path (WSL)
#   TSMB_FORCE_LINUX=1 force Linux path even under WSL

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TASK_NAME="${TSMB_TASK_NAME:-TSMusicBot}"
SERVICE_NAME="${TSMB_SERVICE_NAME:-tsmusicbot}"

is_wsl() {
  grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null || [[ -n "${WSL_DISTRO_NAME:-}" ]]
}

want_windows() {
  [[ "${TSMB_FORCE_LINUX:-}" == "1" ]] && return 1
  [[ "${TSMB_WINDOWS:-}" == "1" ]] && return 0
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
  # Match this tree only (avoid killing unrelated node apps).
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
  local win_dir
  if command -v wslpath >/dev/null 2>&1; then
    win_dir="$(wslpath -w "$PROJECT_DIR")"
  else
    echo "[ERROR] wslpath not found; cannot map project path to Windows."
    exit 1
  fi
  echo "============================================"
  echo "  TSMusicBot - Stop (WSL → Windows)"
  echo "  Project: $PROJECT_DIR"
  echo "  Windows: $win_dir"
  echo "  Task:    $TASK_NAME"
  echo "============================================"
  echo
  # Call Windows stop.bat so schtasks + node.exe matching use Win paths.
  cmd.exe /c "set TSMB_TASK_NAME=${TASK_NAME}&& cd /d \"${win_dir}\" && scripts\\stop.bat"
}

cd "$PROJECT_DIR"

if want_windows; then
  stop_windows_via_cmd
else
  stop_linux
fi
