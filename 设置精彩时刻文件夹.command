#!/bin/zsh

set -u
cd "${0:A:h}"

mkdir -p data

CHOICE="$(osascript <<'APPLESCRIPT'
button returned of (display dialog "选择精彩时刻媒体库的位置。使用外置硬盘可以节省电脑空间；硬盘断开时网站只会暂时隐藏媒体。" with title "My Game Vault" buttons {"取消", "使用项目默认文件夹", "选择外置硬盘文件夹"} default button "选择外置硬盘文件夹" cancel button "取消")
APPLESCRIPT
)" || exit 0

if [[ "$CHOICE" == "使用项目默认文件夹" ]]; then
  rm -f data/highlights-path.txt
  mkdir -p data/highlights
  echo "已恢复项目默认媒体目录：${PWD}/data/highlights"
else
  SELECTED="$(osascript <<'APPLESCRIPT'
POSIX path of (choose folder with prompt "请选择外置硬盘中用于存放游戏截图和视频的文件夹")
APPLESCRIPT
)" || exit 0
  SELECTED="${SELECTED%/}"
  printf '%s\n' "$SELECTED" > data/highlights-path.txt
  chmod 600 data/highlights-path.txt
  echo "精彩时刻媒体库已设为：$SELECTED"
fi

if curl -fsS "http://localhost:4173/api/highlights" >/dev/null 2>&1; then
  open "http://localhost:4173/#highlights"
  echo "网站已打开，刷新后即可读取新的媒体目录。"
else
  echo "下次双击“启动游戏时光库.command”时会读取这个目录。"
fi

read "?按回车键关闭…"
