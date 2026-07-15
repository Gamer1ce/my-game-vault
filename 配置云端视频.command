#!/bin/zsh

set -u
cd "${0:A:h}"

CONFIG="data/remote-media.env"
if [[ ! -f "$CONFIG" ]]; then
  cp "remote-media.env.example" "$CONFIG"
  chmod 600 "$CONFIG"
fi

open -e "$CONFIG"
echo "已在文本编辑器中打开云端视频配置。"
echo "填写后保存，然后双击“同步云端视频.command”上传原始视频。"
read "?按回车键关闭…"
