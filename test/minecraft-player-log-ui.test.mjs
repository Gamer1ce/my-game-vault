import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(root, "public/minecraft.html"), "utf8");
const css = readFileSync(path.join(root, "public/minecraft.css"), "utf8");
const script = readFileSync(path.join(root, "public/minecraft.js"), "utf8");
const server = readFileSync(path.join(root, "server.mjs"), "utf8");
const agent = readFileSync(path.join(root, "scripts/minecraft-metrics-agent/MinecraftEventAgentV2.java"), "utf8");
const installer = readFileSync(path.join(root, "scripts/install-minecraft-metrics-agent.zsh"), "utf8");

test("Minecraft 页面提供持久玩家出入日志面板", () => {
  assert.match(html, /class="mc-panel mc-session-panel"[^>]*aria-labelledby="sessionLogTitle"/);
  assert.match(html, /id="playerSessionLog"[^>]*tabindex="0"/);
  assert.match(html, /加入 \/ 退出/);
  assert.match(css, /\.mc-session-panel \{ grid-column: 1 \/ -1;/);
  assert.match(css, /\.mc-session-row\.is-online/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*\.mc-session-row/);
});

test("玩家日志前端只公开名称和会话时间并安全写入名称", () => {
  assert.match(script, /fetch\("\/api\/minecraft\/player-log\?limit=40"/);
  assert.match(script, /querySelector\("\.mc-session-player strong"\)\.textContent/);
  assert.match(script, /times\[0\]\.textContent = session\.joinedAt \? sessionTime/);
  assert.match(script, /if \(sessionRefreshInFlight\) return/);
  assert.match(script, /if \(statusRefreshInFlight\) return/);
  assert.match(script, /if \(document\.visibilityState === "visible"\) refresh\(\)/);
  assert.match(script, /document\.addEventListener\("visibilitychange"/);
  assert.match(script, /已加入并退出服务器/);
  assert.match(script, /FORGE EVENTS \/\/ DEGRADED/);
  assert.match(script, /等待采集器恢复/);
  assert.doesNotMatch(script, /playerId|uuid|ipAddress/);
});

test("服务端后台导入 Forge 事件且公开接口保持只读", () => {
  assert.match(server, /createMinecraftPlayerLogStore\(\{ database: db, eventsDirectory: minecraftEventsDirectory \}\)/);
  assert.match(server, /app\.get\("\/api\/minecraft\/player-log"/);
  assert.match(server, /setInterval\(sampleMinecraftPlayerLog, 5_000\)/);
  assert.doesNotMatch(server, /app\.(?:post|put|delete)\("\/api\/minecraft\/player-log"/);
});

test("Minecraft V2 Agent 使用 Forge 登录退出事件并持久安装", () => {
  assert.match(agent, /PlayerEvent\$PlayerLoggedInEvent/);
  assert.match(agent, /PlayerEvent\$PlayerLoggedOutEvent/);
  assert.match(agent, /getMethod\("addListener", priorityClass, boolean\.class, Class\.class, Consumer\.class\)/);
  assert.match(agent, /findMethod\(server\.getClass\(\), "execute", Runnable\.class\)/);
  assert.match(agent, /append\(outputDirectory, "run-start", null, null\);[\s\S]*installListeners\(instrumentation, outputDirectory\);[\s\S]*appendPresentPlayers\(outputDirectory, server\);/);
  assert.match(agent, /unregister\.invoke\(eventBus, candidates\.get\(index\)\)/);
  assert.match(agent, /game-vault-minecraft-event-heartbeat/);
  assert.match(agent, /\"status\.json\"/);
  assert.match(agent, /channel\.force\(false\)/);
  assert.match(installer, /minecraft-event-agent-v2\.jar/);
  assert.match(installer, /events_argument=.*-javaagent:/);
  assert.match(installer, /grep -Fqx -- "\$events_argument" "\$jvm_args_file"/);
});
