#!/bin/zsh
set -euo pipefail

project_dir=${AZURE_BACKUP_PROJECT_DIR:-/Users/gamer1ce/Documents/游戏时长记录}
database_file=${GAME_VAULT_DATABASE_FILE:-${DATA_DIR:-$project_dir/data}/games.db}
ssh_key=${AZURE_BACKUP_KEY_PATH:-/Users/gamer1ce/.ssh/game-vault-azure_key.pem}
remote_host=${AZURE_BACKUP_REMOTE:-azureuser@74.248.153.120}
remote_root=${AZURE_BACKUP_ROOT:-/srv/game-vault}
remote_deployment_mode=${AZURE_BACKUP_DEPLOYMENT_MODE:-systemd}
media_dir=${AZURE_BACKUP_MEDIA_DIR:-/Volumes/游戏视频}
minimum_visible_games=${AZURE_BACKUP_MIN_VISIBLE_GAMES:-1}
lock_dir=${AZURE_BACKUP_LOCK_DIR:-/tmp/com.gamer1ce.game-time-vault.azure-backup.lock}
log_prefix="$(date '+%Y-%m-%d %H:%M:%S') Azure backup"

if ! mkdir "$lock_dir" 2>/dev/null; then
  echo "$log_prefix skipped: another sync is running"
  exit "${AZURE_BACKUP_LOCK_BUSY_EXIT:-0}"
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

if [[ ! -f "$database_file" ]]; then
  echo "$log_prefix failed: games.db is unavailable" >&2
  exit 1
fi

if [[ ! "$minimum_visible_games" =~ '^[0-9]+$' ]]; then
  echo "$log_prefix failed: AZURE_BACKUP_MIN_VISIBLE_GAMES must be a non-negative integer" >&2
  exit 1
fi

if (( minimum_visible_games > 0 )); then
  visible_game_count=$(sqlite3 "$database_file" "SELECT COUNT(*) FROM games WHERE time_status = 'known' AND minutes > 0;" 2>/dev/null || true)
  if [[ ! "$visible_game_count" =~ '^[0-9]+$' ]]; then
    echo "$log_prefix failed: games.db does not contain a readable games table" >&2
    exit 1
  fi
  if (( visible_game_count < minimum_visible_games )); then
    echo "$log_prefix blocked: refusing to replace Azure with only $visible_game_count visible games (minimum $minimum_visible_games)" >&2
    exit 1
  fi
fi

sqlite3 "$database_file" ".backup '$snapshot_dir/games.db'"

remote_free_kb=$(ssh -i "$ssh_key" -o BatchMode=yes -o ConnectTimeout=20 "$remote_host" "df -Pk '$remote_root' | tail -1 | awk '{print \$4}'")
if [[ ! "$remote_free_kb" =~ '^[0-9]+$' ]] || (( remote_free_kb < 2097152 )); then
  echo "$log_prefix blocked: Azure has less than 2 GiB free; preserving the existing database and media" >&2
  exit 1
fi

ssh -i "$ssh_key" -o BatchMode=yes -o ConnectTimeout=20 "$remote_host" \
  "mkdir -p '$remote_root/incoming' '$remote_root/data' '$remote_root/media'"

if [[ "$remote_deployment_mode" != "docker" ]]; then
  local_lock_hash=$(shasum -a 256 "$project_dir/package-lock.json" | awk '{print $1}')
  remote_lock_hash=$(ssh -i "$ssh_key" -o BatchMode=yes "$remote_host" \
    "sha256sum '$remote_root/app/package-lock.json' 2>/dev/null | awk '{print \$1}'" || true)

  if command -v git >/dev/null 2>&1 && git -C "$project_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$project_dir" ls-files -z | rsync -az --from0 --files-from=- \
      -e "ssh -i '$ssh_key' -o BatchMode=yes" \
      "$project_dir/" "$remote_host:$remote_root/app/"
  else
    rsync -az --delete \
      --exclude='.git/' \
      --exclude='node_modules/' \
      --exclude='data/' \
      --exclude='.DS_Store' \
      -e "ssh -i '$ssh_key' -o BatchMode=yes" \
      "$project_dir/" "$remote_host:$remote_root/app/"
  fi

  if [[ "$local_lock_hash" != "$remote_lock_hash" ]]; then
    ssh -i "$ssh_key" -o BatchMode=yes "$remote_host" \
      "cd '$remote_root/app' && npm ci --omit=dev"
  fi
fi

rsync -az -e "ssh -i '$ssh_key' -o BatchMode=yes" \
  "$snapshot_dir/games.db" "$remote_host:$remote_root/incoming/games.db.new"

if [[ "$remote_deployment_mode" == "docker" ]]; then
  ssh -i "$ssh_key" -o BatchMode=yes "$remote_host" \
    "cd '$remote_root/app' && sudo docker compose -f compose.azure.yaml stop game-vault; install -m 600 '$remote_root/incoming/games.db.new' '$remote_root/data/games.db'; unlink '$remote_root/data/games.db-wal' 2>/dev/null || true; unlink '$remote_root/data/games.db-shm' 2>/dev/null || true; cd '$remote_root/app' && sudo docker compose -f compose.azure.yaml up -d --no-build game-vault cloudflared"
else
  ssh -i "$ssh_key" -o BatchMode=yes "$remote_host" \
    "sudo systemctl stop game-vault; install -m 600 '$remote_root/incoming/games.db.new' '$remote_root/data/games.db'; unlink '$remote_root/data/games.db-wal' 2>/dev/null || true; unlink '$remote_root/data/games.db-shm' 2>/dev/null || true; sudo systemctl start game-vault"
fi

if [[ "${AZURE_BACKUP_SKIP_MEDIA:-0}" == "1" ]]; then
  echo "$log_prefix media skipped: data-only request"
elif [[ -d "$media_dir" ]]; then
  # Refuse a mirror that cannot fit, retaining 2 GiB for the website/database.
  # Do not delete existing remote media to make room automatically.
  source_media_bytes=$(node --input-type=module -e 'import {pathToFileURL} from "node:url"; const {listHighlights}=await import(pathToFileURL(process.argv[1])); console.log(listHighlights(process.argv[2], Infinity).reduce((n,f)=>n+f.size,0));' "$project_dir/src/highlights.mjs" "$media_dir")
  remote_capacity=$(ssh -i "$ssh_key" -o BatchMode=yes "$remote_host" "df -Pk '$remote_root/media' | tail -1 | awk '{print \$4}'; du -sk '$remote_root/media' | awk '{print \$1}'")
  remote_free_kb=$(print -r -- "$remote_capacity" | head -1)
  remote_media_kb=$(print -r -- "$remote_capacity" | tail -1)
  if [[ ! "$source_media_bytes" =~ '^[0-9]+$' || ! "$remote_free_kb" =~ '^[0-9]+$' || ! "$remote_media_kb" =~ '^[0-9]+$' ]]; then
    echo "$log_prefix media blocked: cannot verify mirror capacity" >&2
    exit 1
  fi
  if (( remote_free_kb < 2097152 || source_media_bytes > (remote_free_kb + remote_media_kb - 2097152) * 1024 )); then
    echo "$log_prefix media blocked: insufficient Azure disk space; database synchronized, media left unchanged" >&2
    exit 1
  fi
  rsync -az --delete-delay --partial --partial-dir=.rsync-partial \
    --exclude='.*' \
    --exclude='System Volume Information/' \
    --exclude='$RECYCLE.BIN/' \
    --exclude='.DS_Store' \
    --exclude='._*' \
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
