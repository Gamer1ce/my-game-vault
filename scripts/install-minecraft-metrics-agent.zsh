#!/bin/zsh
set -euo pipefail

project_dir=${0:A:h:h}
source_dir="$project_dir/scripts/minecraft-metrics-agent"
install_dir=${MINECRAFT_METRICS_INSTALL_DIR:-/Users/gamer1ce/.local/share/game-vault-minecraft}
server_pid=${MINECRAFT_SERVER_PID:-$(pgrep -f 'minecraftforge/forge/1.20.1.*nogui' | head -n 1)}
classes_dir="$install_dir/classes"
agent_jar="$install_dir/minecraft-metrics-agent.jar"
status_file="$install_dir/status.json"

if [[ -z "$server_pid" ]]; then
  print -u2 '没有找到正在运行的 Forge 1.20.1 服务器'
  exit 1
fi

mkdir -p "$classes_dir"
javac --add-modules jdk.attach -d "$classes_dir" \
  "$source_dir/MinecraftMetricsAgent.java" \
  "$source_dir/AttachAgent.java"
jar cfm "$agent_jar" "$source_dir/MANIFEST.MF" -C "$classes_dir" gamevault/minecraft/MinecraftMetricsAgent.class
java --add-modules jdk.attach -cp "$classes_dir" gamevault.minecraft.AttachAgent \
  "$server_pid" "$agent_jar" "output=$status_file"
chmod 700 "$install_dir"
chmod 600 "$agent_jar" "$status_file" 2>/dev/null || true
print "Minecraft 实时性能采集已接入 PID $server_pid"
