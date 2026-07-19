#!/bin/zsh
set -euo pipefail

project_dir=${AZURE_BACKUP_PROJECT_DIR:-/Users/gamer1ce/Documents/游戏时长记录}
ssh_key=${AZURE_BACKUP_KEY_PATH:-/Users/gamer1ce/.ssh/game-vault-azure_key.pem}
remote_host=${AZURE_BACKUP_REMOTE:-azureuser@74.248.153.120}
remote_root=${AZURE_BACKUP_ROOT:-/srv/game-vault}
media_dir=${AZURE_BACKUP_MEDIA_DIR:-/Volumes/游戏视频}
lock_dir=/tmp/com.gamer1ce.game-time-vault.azure-backup.lock
log_prefix="$(date '+%Y-%m-%d %H:%M:%S') Azure backup"

if ! mkdir "$lock_dir" 2>/dev/null; then
  echo "$log_prefix skipped: another sync is running"
  exit 0
fi

snapshot_dir=$(mktemp -d)
cleanup() {
  [[ ! -e "$snapshot_dir/games.db" ]] || unlink "$snapshot_dir/games.db"
  rmdir "$snapshot_dir" 2>/dev/null || true
  rmdir "$lock_dir" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if [[ ! -r "$ssh_key" ]]; then
  echo "$log_prefix failed: SSH key is unavailable" >&2
  exit 1
fi

if [[ ! -f "$project_dir/data/games.db" ]]; then
  echo "$log_prefix failed: games.db is unavailable" >&2
  exit 1
fi

sqlite3 "$project_dir/data/games.db" ".backup '$snapshot_dir/games.db'"

ssh -i "$ssh_key" -o BatchMode=yes -o ConnectTimeout=20 "$remote_host" \
  "mkdir -p '$remote_root/incoming' '$remote_root/data' '$remote_root/media'"

local_lock_hash=$(shasum -a 256 "$project_dir/package-lock.json" | awk '{print $1}')
remote_lock_hash=$(ssh -i "$ssh_key" -o BatchMode=yes "$remote_host" \
  "sha256sum '$remote_root/app/package-lock.json' 2>/dev/null | awk '{print \$1}'" || true)

git -C "$project_dir" ls-files -z | rsync -az --from0 --files-from=- \
  -e "ssh -i '$ssh_key' -o BatchMode=yes" \
  "$project_dir/" "$remote_host:$remote_root/app/"

if [[ "$local_lock_hash" != "$remote_lock_hash" ]]; then
  ssh -i "$ssh_key" -o BatchMode=yes "$remote_host" \
    "cd '$remote_root/app' && npm ci --omit=dev"
fi

rsync -az -e "ssh -i '$ssh_key' -o BatchMode=yes" \
  "$snapshot_dir/games.db" "$remote_host:$remote_root/incoming/games.db.new"

ssh -i "$ssh_key" -o BatchMode=yes "$remote_host" \
  "sudo systemctl stop game-vault; install -m 600 '$remote_root/incoming/games.db.new' '$remote_root/data/games.db'; unlink '$remote_root/data/games.db-wal' 2>/dev/null || true; unlink '$remote_root/data/games.db-shm' 2>/dev/null || true; sudo systemctl start game-vault"

if [[ -d "$media_dir" ]]; then
  rsync -az --delete-delay --partial --partial-dir=.rsync-partial \
    --exclude='.DS_Store' \
    --exclude='.Spotlight-V100/' \
    --exclude='.Trashes/' \
    --exclude='.fseventsd/' \
    --exclude='.TemporaryItems/' \
    --exclude='.rsync-partial/' \
    -e "ssh -i '$ssh_key' -o BatchMode=yes" \
    "$media_dir/" "$remote_host:$remote_root/media/"
else
  echo "$log_prefix media skipped: external drive is not mounted"
fi

echo "$log_prefix complete"
