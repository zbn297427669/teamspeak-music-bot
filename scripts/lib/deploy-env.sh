#!/usr/bin/env bash
# Shared loader for WSL → Windows deploy settings.
# 【仅 WSL → Windows 桥接】迁到独立 Linux 服务器后不需要本文件 / deploy.windows.env。
# Prefer: already-exported env > deploy.windows.env > legacy .windows-deploy
#
# shellcheck shell=bash

# Load KEY=VALUE from a file. Skips blanks/comments. Does not override
# variables that are already set in the environment.
tsmb_load_env_file() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  local line key val
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      val="${BASH_REMATCH[2]}"
      if [[ "$val" =~ ^\"(.*)\"$ ]]; then val="${BASH_REMATCH[1]}"; fi
      if [[ "$val" =~ ^\'(.*)\'$ ]]; then val="${BASH_REMATCH[1]}"; fi
      if [[ ! -v "$key" ]]; then
        export "${key}=${val}"
      fi
    fi
  done <"$file"
}

tsmb_load_deploy_config() {
  local project_dir="$1"
  tsmb_load_env_file "$project_dir/deploy.windows.env"
  # Legacy one-line path file
  if [[ ! -v TSMB_WIN_DIR && -f "$project_dir/.windows-deploy" ]]; then
    local raw
    raw="$(head -n 1 "$project_dir/.windows-deploy" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    if [[ -n "$raw" ]]; then
      export TSMB_WIN_DIR="$raw"
    fi
  fi
}

# Print TSMB_WIN_DIR as a Linux path (convert D:\... via wslpath when needed).
tsmb_win_dir_linux() {
  local raw="${TSMB_WIN_DIR:-}"
  [[ -z "$raw" ]] && return 1
  if [[ "$raw" =~ ^[A-Za-z]:[\\/] ]] || [[ "$raw" =~ ^\\\\ ]]; then
    command -v wslpath >/dev/null 2>&1 || return 1
    raw="$(wslpath -u "$raw")"
  fi
  printf '%s' "$raw"
}

# Run a Windows .bat from WSL without UNC-cwd failures.
# cmd.exe cannot use \\wsl.localhost\... as cwd; cd to /mnt/<drive>/... first
# so the inherited Windows cwd is a normal drive path (D:\...).
#
# Usage: tsmb_run_win_bat "/mnt/d/bots/app" "scripts\\update.bat"
# Passes TSMB_* via WSLENV (Unicode) so Chinese task names work.
tsmb_run_win_bat() {
  local linux_dir="$1"
  local bat_rel="$2"
  local bat_fwd="${bat_rel//\\//}"

  if [[ ! -d "$linux_dir" ]]; then
    echo "[ERROR] Windows runtime dir not found: $linux_dir" >&2
    return 1
  fi
  if [[ ! -f "$linux_dir/$bat_fwd" ]]; then
    echo "[ERROR] Missing $bat_fwd under $linux_dir" >&2
    return 1
  fi

  # Always materialize task name on the Windows tree. WSLENV + non-ASCII is flaky;
  # update.bat / stop.bat read .tsmusicbot-task-name when env is empty.
  if [[ -n "${TSMB_TASK_NAME:-}" ]]; then
    printf '%s' "$TSMB_TASK_NAME" >"$linux_dir/.tsmusicbot-task-name"
  fi

  local share=()
  local k
  for k in TSMB_TASK_NAME TSMB_SKIP_PULL TSMB_NO_START TSMB_FULL_SETUP \
           TSMB_SETUP_NOPAUSE TSMB_UPDATE_NOPAUSE; do
    if [[ -v "$k" ]]; then
      share+=("$k")
    fi
  done

  local wslenv_extra=""
  if [[ ${#share[@]} -gt 0 ]]; then
    local joined
    joined="$(IFS=:; echo "${share[*]}")"
    # Append /u to each name: VAR1/u:VAR2/u
    wslenv_extra="${joined//://u:}/u"
  fi

  (
    cd "$linux_dir" || exit 1
    if [[ -n "$wslenv_extra" ]]; then
      if [[ -n "${WSLENV:-}" ]]; then
        export WSLENV="${WSLENV}:${wslenv_extra}"
      else
        export WSLENV="$wslenv_extra"
      fi
    fi
    # Relative bat path; cwd is already the Windows project root (drive letter).
    cmd.exe /c "$bat_rel"
  )
}
