#!/bin/zsh

set -eu
cd "${0:A:h}"

SERVICE="com.gamer1ce.game-time-vault.cloudflare-workers"
ACCOUNT="gamer1ce.top"

echo "请粘贴只授予 Workers Scripts: Edit 权限的 Cloudflare API Token。"
echo "输入内容不会显示，也不会写入项目或终端历史。"
read -s "TOKEN?Workers Token: "
echo

if [[ -z "$TOKEN" ]]; then
  echo "未输入 Token，没有修改钥匙串。"
  read "?按回车键关闭…"
  exit 1
fi

/usr/bin/security add-generic-password -U \
  -a "$ACCOUNT" \
  -s "$SERVICE" \
  -w "$TOKEN" >/dev/null

unset TOKEN
echo "Workers Token 已安全保存到 macOS 钥匙串。"
echo "现在可以回到 Codex 继续部署。"
read "?按回车键关闭…"
