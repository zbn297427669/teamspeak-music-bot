#!/usr/bin/env bash
set -euo pipefail

# Sync WSL git working tree → Windows runtime directory.
# NEVER overwrites Windows: data/, node_modules/, dist/, bin/
#
# Config: deploy.windows.env  (see deploy.windows.env.example)
#   or env TSMB_WIN_DIR / legacy .windows-deploy
#
# Optional: TSMB_SYNC_DELETE=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/deploy-env.sh
source "$SCRIPT_DIR/lib/deploy-env.sh"
tsmb_load_deploy_config "$PROJECT_DIR"

RSYNC_EXCLUDES=(
  --exclude '.git/'
  --exclude 'node_modules/'
  --exclude 'web/node_modules/'
  --exclude 'data/'
  --exclude 'dist/'
  --exclude 'web/dist/'
  --exclude 'bin/'
  --exclude 'setup.log'
  --exclude 'update.log'
  --exclude 'deploy.windows.env'
  --exclude '.windows-deploy'
  --exclude '.superpowers/'
  --exclude '.worktrees/'
  --exclude '.claude/'
  --exclude '*.db'
)

src="$PROJECT_DIR"
dst="$(tsmb_win_dir_linux)" || {
  echo "[ERROR] TSMB_WIN_DIR not set."
  echo "        cp deploy.windows.env.example deploy.windows.env"
  echo "        then edit TSMB_WIN_DIR to your Windows runtime folder."
  exit 1
}

if [[ ! -d "$dst" ]]; then
  echo "[INFO] Creating Windows deploy dir: $dst"
  mkdir -p "$dst"
fi

src_real="$(cd "$src" && pwd -P)"
dst_real="$(cd "$dst" && pwd -P)"
if [[ "$src_real" == "$dst_real" ]]; then
  echo "[ERROR] TSMB_WIN_DIR points at the WSL repo itself — nothing to sync."
  exit 1
fi

echo "============================================"
echo "  TSMusicBot - Sync WSL → Windows"
echo "  From: $src"
echo "  To:   $dst"
echo "  Task: ${TSMB_TASK_NAME:-TSMusicBot}"
echo "============================================"
echo
echo "Preserved on Windows (not overwritten):"
echo "  data/  node_modules/  web/node_modules/  dist/  web/dist/  bin/"
echo

delete_flag=()
if [[ "${TSMB_SYNC_DELETE:-}" == "1" ]]; then
  delete_flag=(--delete)
  echo "[INFO] TSMB_SYNC_DELETE=1 — will remove orphan files under sync scope."
fi

if command -v rsync >/dev/null 2>&1; then
  rsync -a "${delete_flag[@]}" "${RSYNC_EXCLUDES[@]}" "$src"/ "$dst"/
else
  echo "[WARN] rsync not found — using tar fallback (no --delete)."
  tar -C "$src" --exclude='.git' --exclude='node_modules' --exclude='web/node_modules' \
    --exclude='data' --exclude='dist' --exclude='web/dist' --exclude='bin' \
    --exclude='setup.log' --exclude='update.log' --exclude='deploy.windows.env' \
    --exclude='.windows-deploy' \
    -cf - . | tar -C "$dst" -xf -
fi

{
  echo "syncedAt=$(date -Iseconds)"
  echo "source=$src"
  if [[ -d "$src/.git" ]]; then
    echo "head=$(git -C "$src" rev-parse --short HEAD 2>/dev/null || true)"
  fi
  echo "config=deploy.windows.env"
} >"$dst/.tsmusicbot-synced-from-wsl"

echo "[OK] Sync complete."
