#!/bin/zsh
set -euo pipefail

project_dir=${0:A:h:h}
source_dir="$project_dir/scripts/minecraft-metrics-agent"
install_dir=${MINECRAFT_METRICS_INSTALL_DIR:-/Users/gamer1ce/.local/share/game-vault-minecraft}
server_pid=${MINECRAFT_SERVER_PID:-$(pgrep -f 'minecraftforge/forge/1.20.1.*nogui' | head -n 1)}
classes_dir="$install_dir/classes"
agent_jar="$install_dir/minecraft-metrics-agent.jar"
events_agent_jar="$install_dir/minecraft-event-agent-v2.jar"
status_file="$install_dir/status.json"
events_dir="$install_dir/events"
server_dir=${MINECRAFT_SERVER_DIR:-$(lsof -a -p "$server_pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)}
jvm_args_file=${MINECRAFT_JVM_ARGS_FILE:-${server_dir:+$server_dir/user_jvm_args.txt}}

if [[ -z "$server_pid" ]]; then
  print -u2 '没有找到正在运行的 Forge 1.20.1 服务器'
  exit 1
fi

mkdir -p "$classes_dir"
javac --add-modules jdk.attach -d "$classes_dir" \
  "$source_dir/MinecraftMetricsAgent.java" \
  "$source_dir/MinecraftEventAgentV2.java" \
  "$source_dir/AttachAgent.java"
jar cfm "$agent_jar" "$source_dir/MANIFEST.MF" -C "$classes_dir" gamevault/minecraft/MinecraftMetricsAgent.class
jar cfm "$events_agent_jar" "$source_dir/EVENTS-MANIFEST.MF" -C "$classes_dir" gamevault/minecraft/MinecraftEventAgentV2.class
java --add-modules jdk.attach -cp "$classes_dir" gamevault.minecraft.AttachAgent \
  "$server_pid" "$agent_jar" "output=$status_file"
mkdir -p "$events_dir"
java --add-modules jdk.attach -cp "$classes_dir" gamevault.minecraft.AttachAgent \
  "$server_pid" "$events_agent_jar" "output=$events_dir"

if [[ -n "$jvm_args_file" && -f "$jvm_args_file" ]]; then
  metrics_argument="-javaagent:$agent_jar=output=$status_file"
  events_argument="-javaagent:$events_agent_jar=output=$events_dir"
  grep -Fqx -- "$metrics_argument" "$jvm_args_file" || print -r -- "$metrics_argument" >> "$jvm_args_file"
  grep -Fqx -- "$events_argument" "$jvm_args_file" || print -r -- "$events_argument" >> "$jvm_args_file"
fi
chmod 700 "$install_dir"
chmod 700 "$events_dir"
chmod 600 "$agent_jar" "$events_agent_jar" "$status_file" 2>/dev/null || true
print "Minecraft 实时性能与玩家事件采集已接入 PID $server_pid"
