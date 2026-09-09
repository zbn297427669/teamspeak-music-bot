#!/usr/bin/env bash
# Shared loader for WSL → Windows deploy settings.
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
