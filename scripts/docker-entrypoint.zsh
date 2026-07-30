#!/bin/zsh
set -euo pipefail
umask 077

for environment_file in /data/remote-media.env /data/baidu-media.env; do
  if [[ -r "$environment_file" ]]; then
    set -a
    source "$environment_file"
    set +a
  fi
done

exec node server.mjs
