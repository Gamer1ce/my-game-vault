#!/bin/zsh
set -euo pipefail

project_dir=${AZURE_BACKUP_PROJECT_DIR:-/Users/gamer1ce/Documents/游戏时长记录}
ssh_key=${AZURE_BACKUP_KEY_PATH:-/Users/gamer1ce/.ssh/game-vault-azure_key.pem}
remote_host=${AZURE_BACKUP_REMOTE:-azureuser@74.248.153.120}
remote_request_file=${AZURE_SYNC_REQUEST_FILE:-/srv/game-vault/data/sync-request.json}
remote_result_file=${AZURE_SYNC_RESULT_FILE:-${remote_request_file}.result.json}
local_origin=${GAME_VAULT_LOCAL_ORIGIN:-http://127.0.0.1:4173}
admin_file=${GAME_VAULT_ADMIN_FILE:-$project_dir/data/admin-access.json}
backup_command=${AZURE_BACKUP_SYNC_COMMAND:-/Users/gamer1ce/Library/Application Support/GameTimeVault/sync-azure-backup.zsh}
state_dir=${AZURE_SYNC_REQUEST_STATE_DIR:-/Users/gamer1ce/Library/Application Support/GameTimeVault}
pending_file=$state_dir/azure-sync-request-pending.json
lock_dir=/tmp/com.gamer1ce.game-time-vault.azure-request-poll.lock
cookie_file=$(mktemp)
response_file=$(mktemp)

cleanup() {
  rm -f "$cookie_file" "$response_file"
  rmdir "$lock_dir" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if ! mkdir "$lock_dir" 2>/dev/null; then
  exit 0
fi

for value in "$remote_request_file" "$remote_result_file"; do
  if [[ ! "$value" =~ '^/[A-Za-z0-9._/-]+$' ]]; then
    echo "Azure 同步请求路径格式无效" >&2
    exit 1
  fi
done

if [[ ! -r "$ssh_key" || ! -x "$backup_command" || ! -r "$admin_file" ]]; then
  echo "Azure 同步请求轮询缺少 SSH 密钥、备份脚本或管理员配置" >&2
  exit 1
fi

mkdir -p "$state_dir"
chmod 700 "$state_dir" 2>/dev/null || true

request_id=$(ssh -i "$ssh_key" -o BatchMode=yes -o ConnectTimeout=15 "$remote_host" \
  "if [ -f '$remote_request_file' ]; then node -e 'const fs=require(\"fs\");const value=JSON.parse(fs.readFileSync(process.argv[1],\"utf8\"));process.stdout.write(String(value.id||\"\"))' '$remote_request_file'; fi")

if [[ -z "$request_id" ]]; then
  exit 0
fi
if [[ ! "$request_id" =~ '^[A-Za-z0-9-]{8,80}$' ]]; then
  echo "Azure 返回了无效的同步请求编号" >&2
  exit 1
fi

completed_request_id=$(ssh -i "$ssh_key" -o BatchMode=yes "$remote_host" \
  "if [ -f '$remote_result_file' ]; then node -e 'const fs=require(\"fs\");const value=JSON.parse(fs.readFileSync(process.argv[1],\"utf8\"));process.stdout.write(String(value.requestId||\"\"))' '$remote_result_file'; fi")
if [[ "$completed_request_id" == "$request_id" ]]; then
  ssh -i "$ssh_key" -o BatchMode=yes "$remote_host" \
    "node -e 'const fs=require(\"fs\");const file=process.argv[1];const expected=process.argv[2];if(fs.existsSync(file)){const value=JSON.parse(fs.readFileSync(file,\"utf8\"));if(String(value.id||\"\")===expected)fs.unlinkSync(file)}' '$remote_request_file' '$request_id'"
  exit 0
fi

pending_id=""
if [[ -r "$pending_file" ]]; then
  pending_id=$(jq -r '.requestId // ""' "$pending_file" 2>/dev/null || true)
fi

if [[ "$pending_id" != "$request_id" ]]; then
  username=$(jq -r '.username // ""' "$admin_file")
  password=$(jq -r '.password // ""' "$admin_file")
  if [[ -z "$username" || -z "$password" ]]; then
    echo "本机管理员配置无效" >&2
    exit 1
  fi

  login_body=$(jq -nc --arg username "$username" --arg password "$password" '{username:$username,password:$password}')
  curl -fsS -c "$cookie_file" -H "Content-Type: application/json" \
    --data "$login_body" "$local_origin/api/admin/session" >/dev/null
  curl -fsS -b "$cookie_file" -X POST "$local_origin/api/sync/all" >"$response_file"

  jq -e '.results | type == "array"' "$response_file" >/dev/null
  jq --arg requestId "$request_id" --arg completedAt "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    '{requestId:$requestId,completedAt:$completedAt,results:(.results // [])}' \
    "$response_file" >"${pending_file}.tmp"
  chmod 600 "${pending_file}.tmp"
  mv "${pending_file}.tmp" "$pending_file"
fi

set +e
AZURE_BACKUP_SKIP_MEDIA=1 AZURE_BACKUP_LOCK_BUSY_EXIT=75 "$backup_command"
backup_status=$?
set -e
if [[ $backup_status -ne 0 ]]; then
  if [[ $backup_status -eq 75 ]]; then
    echo "Azure 数据镜像正在运行；同步结果将在下一轮请求轮询时推送"
    exit 0
  fi
  exit $backup_status
fi

if [[ ! -r "$pending_file" ]]; then
  echo "Azure 同步请求 $request_id 已由另一轮任务完成"
  exit 0
fi

scp -q -i "$ssh_key" -o BatchMode=yes "$pending_file" "$remote_host:${remote_result_file}.new"
ssh -i "$ssh_key" -o BatchMode=yes "$remote_host" \
  "install -m 600 '${remote_result_file}.new' '$remote_result_file' && rm -f '${remote_result_file}.new' && node -e 'const fs=require(\"fs\");const file=process.argv[1];const expected=process.argv[2];if(fs.existsSync(file)){const value=JSON.parse(fs.readFileSync(file,\"utf8\"));if(String(value.id||\"\")===expected)fs.unlinkSync(file)}' '$remote_request_file' '$request_id'"

rm -f "$pending_file"
echo "Azure 同步请求 $request_id 已完成并推送"
