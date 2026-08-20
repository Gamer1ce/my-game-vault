import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMinecraftStatusService, readMinecraftMetrics } from "../src/minecraft-status.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("合并 Minecraft 状态协议与 JVM 性能采样", async () => {
  const now = Date.parse("2026-08-20T10:00:00.000Z");
  const service = createMinecraftStatusService({
    packName: "香草纪元：食旅纪行",
    packVersion: "2.7.1",
    publicAddress: "gamer1ce.top:47060",
    now: () => now,
    ping: async () => ({ latencyMs: 28, status: {
      version: { name: "Forge 1.20.1", protocol: 763 },
      players: { online: 1, max: 20, sample: [{ name: "fallback" }] },
      description: { text: "香草纪元", extra: [{ text: "：食旅纪行" }] },
      forgeData: {}
    } }),
    readMetrics: async () => ({
      sampledAt: new Date(now).toISOString(), tps: 19.98, mspt: 23.4, uptimeSeconds: 7200,
      memoryUsedMb: 4096, memoryMaxMb: 8192, onlinePlayers: 1, maxPlayers: 20,
      players: [{ name: "Gamer1ce", latencyMs: 42 }]
    })
  });

  const result = await service.status();
  assert.equal(result.online, true);
  assert.equal(result.latencyMs, 28);
  assert.equal(result.pack.name, "香草纪元：食旅纪行");
  assert.equal(result.motd, "香草纪元：食旅纪行");
  assert.equal(result.modLoader, "Forge");
  assert.deepEqual(result.players, [{ name: "Gamer1ce", latencyMs: 42 }]);
  assert.equal(result.performance.tps, 19.98);
});

test("过期的 JVM 性能文件不会被当成实时状态", async () => {
  const result = await readMinecraftMetrics("/definitely/missing/status.json", Date.now());
  assert.equal(result, null);
});

test("Minecraft 离线时仍返回可展示的整合包档案", async () => {
  const service = createMinecraftStatusService({
    packName: "香草纪元：食旅纪行",
    ping: async () => { throw new Error("offline"); },
    readMetrics: async () => null
  });
  const result = await service.status();
  assert.equal(result.online, false);
  assert.equal(result.onlinePlayers, 0);
  assert.equal(result.performance.available, false);
});

test("完整 IPv6 连接地址不会被当作玩家名称截断", async () => {
  const address = "[240e:331:2279:c410:495:6182:febf:b47e]:47060";
  const service = createMinecraftStatusService({
    publicAddress: address,
    ping: async () => null,
    readMetrics: async () => null
  });
  assert.equal((await service.status()).address, address);
});

test("Minecraft 状态页提供明确的原网站返回按钮", () => {
  const html = readFileSync(path.join(root, "public/minecraft.html"), "utf8");
  assert.match(html, /class="ghost mc-back" href="\/" aria-label="返回原网站页面">← 返回原网站<\/a>/);
});

test("Minecraft 状态页使用会漂浮旋转的末地水晶", () => {
  const html = readFileSync(path.join(root, "public/minecraft.html"), "utf8");
  const css = readFileSync(path.join(root, "public/minecraft.css"), "utf8");
  assert.match(html, /class="mc-end-crystal"/);
  assert.match(html, /mc-crystal-cage-outer/);
  assert.match(html, /mc-crystal-cage-inner/);
  assert.match(html, /mc-crystal-core/);
  assert.doesNotMatch(html, /mc-beacon-beam|OVERWORLD BEACON/);
  assert.match(css, /@keyframes mc-crystal-float/);
  assert.match(css, /@keyframes mc-crystal-spin-outer/);
  assert.match(css, /@keyframes mc-crystal-spin-inner/);
  assert.match(css, /@keyframes mc-crystal-spin-core/);
});
