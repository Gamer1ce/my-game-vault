#!/usr/bin/env bash
set -euo pipefail

sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg rsync sqlite3 debian-keyring debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  sudo chmod o+r /etc/apt/sources.list.d/caddy-stable.list
  sudo apt-get update
  sudo apt-get install -y caddy
fi

sudo mkdir -p /srv/game-vault/app /srv/game-vault/data /srv/game-vault/media /srv/game-vault/incoming
sudo chown -R azureuser:azureuser /srv/game-vault
sudo install -m 644 /srv/game-vault/app/deploy/azure/game-vault.service /etc/systemd/system/game-vault.service
sudo install -m 644 /srv/game-vault/app/deploy/azure/Caddyfile /etc/caddy/Caddyfile

cd /srv/game-vault/app
npm ci --omit=dev

sudo systemctl daemon-reload
sudo systemctl enable --now game-vault
sudo systemctl enable --now caddy
sudo systemctl restart caddy

node --version
systemctl --no-pager --full status game-vault | sed -n '1,12p'
systemctl --no-pager --full status caddy | sed -n '1,12p'
