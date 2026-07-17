#!/bin/zsh

set -eu
umask 077

PROJECT_DIR="/Users/gamer1ce/Documents/游戏时长记录"
cd "$PROJECT_DIR"

if [[ -f data/remote-media.env ]]; then
  set -a
  source data/remote-media.env
  set +a
fi
RUNTIME_BAIDU_ENV="$HOME/Library/Application Support/GameTimeVault/baidu-media.env"
if [[ -f "$RUNTIME_BAIDU_ENV" ]]; then
  set -a
  source "$RUNTIME_BAIDU_ENV"
  set +a
elif [[ -f data/baidu-media.env ]]; then
  set -a
  source data/baidu-media.env
  set +a
fi

exec /opt/homebrew/bin/node server.mjs
