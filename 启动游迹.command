#!/bin/zsh

set -u
cd "${0:A:h}"

URL="http://localhost:4173"

if [[ -f data/highlights-path.txt ]]; then
  HIGHLIGHTS_PATH="$(head -n 1 data/highlights-path.txt)"
  if [[ -n "$HIGHLIGHTS_PATH" && ! -d "$HIGHLIGHTS_PATH" ]]; then
    echo "提示：精彩时刻外置媒体库当前未连接：$HIGHLIGHTS_PATH"
    echo "网站仍会正常启动；连接硬盘并刷新页面后即可恢复媒体。"
  fi
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "没有找到 Docker。请先安装并启动 Docker Desktop。"
  read "?按回车键关闭…"
  exit 1
fi

if curl -fsS "$URL/api/games" >/dev/null 2>&1; then
  open "$URL"
  exit 0
fi

if ! docker info >/dev/null 2>&1; then
  echo "正在启动 Docker Desktop…"
  open -a Docker
  for _ in {1..120}; do
    docker info >/dev/null 2>&1 && break
    sleep 1
  done
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker Desktop 未能在两分钟内就绪，请打开 Docker Desktop 后重试。"
  read "?按回车键关闭…"
  exit 1
fi

echo "正在启动 Gamer1ce // 中枢圣殿 Docker 服务…"
docker compose up -d --build || {
  echo "容器启动失败，请检查上方错误信息。"
  read "?按回车键关闭…"
  exit 1
}

for _ in {1..60}; do
  if curl -fsS "$URL/api/games" >/dev/null 2>&1; then
    open "$URL"
    echo "网站已打开。容器会在后台继续运行，关闭此窗口不会停止网站。"
    echo "需要停止时，在项目目录执行：docker compose down"
    exit 0
  fi
  sleep 1
done

echo "网站未能在 60 秒内启动，请执行 docker compose logs --tail=100 game-vault 查看原因。"
read "?按回车键关闭…"
exit 1
