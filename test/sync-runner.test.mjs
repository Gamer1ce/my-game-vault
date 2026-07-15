import test from "node:test";
import assert from "node:assert/strict";
import { createSyncRunner } from "../src/sync-runner.mjs";

test("全平台同步按顺序执行并跳过未连接平台", async () => {
  const order = [];
  const runner = createSyncRunner([
    { id: "playstation", sync: async () => { order.push("playstation"); return { synced: 12 }; } },
    { id: "xbox", sync: async () => { order.push("xbox"); return { synced: 8 }; } },
    { id: "nintendo", sync: async () => { order.push("nintendo"); return { synced: 4, historyBackfilled: 2 }; } }
  ], { isConnected: (id) => id !== "xbox" });

  const result = await runner.run("manual");
  assert.deepEqual(order, ["playstation", "nintendo"]);
  assert.deepEqual(result.results, [
    { provider: "playstation", ok: true, synced: 12, historyBackfilled: 0 },
    { provider: "nintendo", ok: true, synced: 4, historyBackfilled: 2 }
  ]);
});

test("单个平台失败不会阻断后续同步", async () => {
  const errors = [];
  const runner = createSyncRunner([
    { id: "playstation", sync: async () => { throw new Error("令牌过期"); } },
    { id: "steam", sync: async () => ({ synced: 20 }) }
  ], {
    isConnected: () => true,
    onError: (provider, error, trigger) => errors.push([provider, error.message, trigger])
  });

  const result = await runner.run("automatic");
  assert.equal(result.results[0].ok, false);
  assert.equal(result.results[0].error, "令牌过期");
  assert.equal(result.results[1].ok, true);
  assert.deepEqual(errors, [["playstation", "令牌过期", "automatic"]]);
});

test("同步进行中时复用同一轮任务，避免重复请求", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const runner = createSyncRunner([
    { id: "steam", sync: async () => { calls += 1; await gate; return { synced: 3 }; } }
  ], { isConnected: () => true });

  const first = runner.run("manual");
  const second = runner.run("automatic");
  assert.equal(first, second);
  assert.equal(runner.isRunning(), true);
  release();
  await first;
  assert.equal(calls, 1);
  assert.equal(runner.isRunning(), false);
});
