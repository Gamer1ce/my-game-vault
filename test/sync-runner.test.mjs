import test from "node:test";
import assert from "node:assert/strict";
import { createGameSyncTargets, gameSyncProviderOrder } from "../src/game-sync-plan.mjs";
import { createSyncRunner } from "../src/sync-runner.mjs";

test("服务器每轮同步都在游戏平台之后补全 MC 评分", async () => {
  assert.deepEqual(gameSyncProviderOrder, ["playstation", "xbox", "nintendo", "steam", "rawg"]);
  for (const trigger of ["manual", "automatic"]) {
    const order = [];
    let newGameAvailable = false;
    const syncs = Object.fromEntries(gameSyncProviderOrder.map((id) => [id, async () => {
      order.push(id);
      if (id === "nintendo") newGameAvailable = true;
      if (id === "rawg") assert.equal(newGameAvailable, true, "评分同步必须看见同轮新增的游戏");
      return { synced: 1 };
    }]));
    const runner = createSyncRunner(createGameSyncTargets(syncs), { isConnected: () => true });

    const result = await runner.run(trigger);
    assert.deepEqual(order, gameSyncProviderOrder);
    assert.deepEqual(result.results.map((item) => item.provider), gameSyncProviderOrder);
  }
});

test("未连接 MC 数据源时仍完成游戏平台同步", async () => {
  for (const trigger of ["manual", "automatic"]) {
    const order = [];
    const syncs = Object.fromEntries(gameSyncProviderOrder.map((id) => [id, async () => {
      if (id === "rawg") assert.fail("未连接评分源时不应调用 RAWG");
      order.push(id);
      return { synced: 1 };
    }]));
    const runner = createSyncRunner(createGameSyncTargets(syncs), { isConnected: (id) => id !== "rawg" });

    const result = await runner.run(trigger);
    assert.deepEqual(order, ["playstation", "xbox", "nintendo", "steam"]);
    assert.deepEqual(result.results.map((item) => item.provider), ["playstation", "xbox", "nintendo", "steam"]);
  }
});

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
