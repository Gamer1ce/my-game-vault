import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMediaPowerStore } from "../src/media-power.mjs";

test("媒体服务默认运行并跨重启保存休眠状态", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "game-vault-media-power-"));
  const store = createMediaPowerStore({ dataDirectory: directory });
  assert.deepEqual(store.status(), { mode: "running", updatedAt: null, sleeping: false });
  assert.equal(store.set("sleeping").sleeping, true);
  const restored = createMediaPowerStore({ dataDirectory: directory });
  assert.equal(restored.status().mode, "sleeping");
  assert.equal(JSON.parse(readFileSync(path.join(directory, "runtime/media-power.json"), "utf8")).mode, "sleeping");
});

test("媒体服务拒绝非法状态", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "game-vault-media-power-invalid-"));
  const store = createMediaPowerStore({ dataDirectory: directory });
  assert.throws(() => store.set("offline"), /状态无效/);
});

test("损坏的持久化状态会安全进入休眠", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "game-vault-media-power-corrupt-"));
  const runtime = path.join(directory, "runtime");
  mkdirSync(runtime, { recursive: true });
  writeFileSync(path.join(runtime, "media-power.json"), "not-json");
  const warnings = [];
  const store = createMediaPowerStore({ dataDirectory: directory, logger: { warn: (message) => warnings.push(message) } });
  assert.equal(store.status().sleeping, true);
  assert.equal(warnings.length, 1);
});
