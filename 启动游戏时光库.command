#!/bin/zsh

set -u
cd "${0:A:h}"

URL="http://localhost:4173"

if [[ -f data/remote-media.env ]]; then
  set -a
  source data/remote-media.env
  set +a
fi
if [[ -f data/baidu-media.env ]]; then
  set -a
  source data/baidu-media.env
  set +a
fi

if [[ -f data/highlights-path.txt ]]; then
  HIGHLIGHTS_PATH="$(head -n 1 data/highlights-path.txt)"
  if [[ -n "$HIGHLIGHTS_PATH" && ! -d "$HIGHLIGHTS_PATH" ]]; then
    echo "提示：精彩时刻外置媒体库当前未连接：$HIGHLIGHTS_PATH"
    echo "网站仍会正常启动；连接硬盘并刷新页面后即可恢复媒体。"
  fi
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "没有找到 Node.js。请先安装 Node.js 22.5 或更高版本。"
  read "?按回车键关闭…"
  exit 1
fi

if curl -fsS "$URL/api/games" >/dev/null 2>&1; then
  open "$URL"
  exit 0
fi

if [[ ! -d node_modules ]]; then
  echo "首次启动，正在安装依赖…"
  npm install || {
    echo "依赖安装失败，请检查网络后重试。"
    read "?按回车键关闭…"
    exit 1
  }
fi

echo "正在启动 My Game Vault…"
npm start &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null' EXIT INT TERM

for _ in {1..40}; do
  if curl -fsS "$URL/api/games" >/dev/null 2>&1; then
    open "$URL"
    echo "网站已打开。保持此窗口运行即可继续自动同步；关闭窗口会停止网站。"
    if [[ -n "${MEDIA_S3_BUCKET:-}" ]]; then
      echo "云端原画播放已启用；朋友播放已上传视频时不会占用本机隧道带宽。"
    fi
    wait "$SERVER_PID"
    exit $?
  fi
  sleep 0.25
done

echo "网站未能在 10 秒内启动，请检查上方错误信息。"
read "?按回车键关闭…"
exit 1
