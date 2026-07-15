#!/bin/zsh

set -u
cd "${0:A:h}"

CONFIG="data/remote-media.env"
if [[ ! -f "$CONFIG" ]]; then
  echo "尚未配置云端视频。请先双击“配置云端视频.command”。"
  read "?按回车键关闭…"
  exit 1
fi

set -a
source "$CONFIG"
set +a

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "没有找到 Node.js。请先安装 Node.js 22.5 或更高版本。"
  read "?按回车键关闭…"
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "首次运行，正在安装依赖…"
  npm install || exit 1
fi

echo "开始把外置硬盘中的原始视频同步到远程媒体存储。"
echo "已经存在且大小相同的文件会自动跳过。"
npm run media:sync
STATUS=$?

if [[ $STATUS -eq 0 ]]; then
  echo "同步完成。请重新启动网站，使云端播放配置生效。"
else
  echo "同步失败，请检查上方错误和云端配置。"
fi
read "?按回车键关闭…"
exit $STATUS
