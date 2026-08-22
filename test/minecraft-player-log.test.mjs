import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMinecraftPlayerLogStore, normalizeMinecraftPlayerEvent } from "../src/minecraft-player-log.mjs";

function event({ runId = "run-1", seq, type, at, uptimeMs = seq * 1_000, name = "Gamer1ce", uuid = "aa11bb22-cc33-dd44-ee55-ff6677889900" }) {
  return {
    v: 1,
    eventId: `${runId}:${seq}`,
    runId,
    seq,
    type,
    at,
    jvmUptimeMs: uptimeMs,
    ...(name ? { player: { uuid, name } } : {})
  };
}

function collectorStatus(directory, { runId, at, uptimeMs, lastSequence = 3 }) {
  writeFileSync(path.join(directory, "status.json"), JSON.stringify({
    v: 1,
    runId,
    ready: true,
    state: "live",
    sampledAt: at,
    jvmUptimeMs: uptimeMs,
    lastSequence,
    error: null
  }));
}

function journal(directory, filename, events) {
  writeFileSync(path.join(directory, filename), `${events.map((item) => JSON.stringify(item)).join("\n")}\n`);
}

test("Forge 玩家事件被幂等导入并投影为加入退出会话", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "minecraft-events-"));
  const database = new DatabaseSync(":memory:");
  try {
    journal(directory, "run-1.ndjson", [
      event({ seq: 1, type: "run-start", at: "2026-08-22T01:00:00.000Z", uptimeMs: 0, name: null }),
      event({ seq: 2, type: "join", at: "2026-08-22T01:01:00.000Z", uptimeMs: 60_000 }),
      event({ seq: 3, type: "leave", at: "2026-08-22T01:26:30.000Z", uptimeMs: 1_590_000 })
    ]);
    const log = createMinecraftPlayerLogStore({ database, eventsDirectory: directory });

    assert.deepEqual(await log.sync(), { available: true, inserted: 3 });
    assert.deepEqual(await log.sync(), { available: true, inserted: 0 });
    const result = log.recent();
    assert.equal(result.eventCount, 3);
    assert.equal(result.total, 1);
    assert.deepEqual(result.sessions[0], {
      id: "run-1:2",
      playerName: "Gamer1ce",
      joinedAt: "2026-08-22T01:01:00.000Z",
      observedAt: null,
      leftAt: "2026-08-22T01:26:30.000Z",
      endBefore: null,
      startReason: "join",
      endReason: "leave",
      online: false,
      unresolved: false,
      durationSeconds: 1530
    });
    assert.equal("playerId" in result.sessions[0], false, "公开会话不得暴露玩家 UUID");
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("热接入时只标记已在线，下一次 JVM 启动会结算未知退出", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "minecraft-events-"));
  const database = new DatabaseSync(":memory:");
  try {
    journal(directory, "run-1.ndjson", [
      event({ seq: 1, type: "run-start", at: "2026-08-22T01:00:00.000Z", name: null }),
      event({ seq: 2, type: "present", at: "2026-08-22T01:00:01.000Z" })
    ]);
    journal(directory, "run-2.ndjson", [
      event({ runId: "run-2", seq: 1, type: "run-start", at: "2026-08-22T03:00:00.000Z", name: null }),
      event({ runId: "run-2", seq: 2, type: "join", at: "2026-08-22T03:10:00.000Z" })
    ]);
    collectorStatus(directory, { runId: "run-2", at: "2026-08-22T03:11:00.000Z", uptimeMs: 62_000, lastSequence: 2 });
    const log = createMinecraftPlayerLogStore({ database, eventsDirectory: directory, now: () => Date.parse("2026-08-22T03:11:00.000Z") });
    await log.sync();
    const result = log.recent();

    assert.equal(result.sessions[0].online, true);
    assert.equal(result.sessions[0].durationSeconds, 60);
    assert.equal(result.sessions[0].joinedAt, "2026-08-22T03:10:00.000Z");
    assert.equal(result.sessions[1].joinedAt, null);
    assert.equal(result.sessions[1].observedAt, "2026-08-22T01:00:01.000Z");
    assert.equal(result.sessions[1].leftAt, null);
    assert.equal(result.sessions[1].endBefore, "2026-08-22T03:00:00.000Z");
    assert.equal(result.sessions[1].endReason, "unknown-after-crash");
    assert.equal(result.sessions[1].durationSeconds, null);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("玩家事件会清理名称并拒绝损坏或伪造记录", () => {
  assert.equal(normalizeMinecraftPlayerEvent(event({ seq: 1, type: "join", at: "invalid" })), null);
  assert.equal(normalizeMinecraftPlayerEvent(event({ seq: 1, type: "chat", at: "2026-08-22T01:00:00Z" })), null);
  const normalized = normalizeMinecraftPlayerEvent(event({ seq: 1, type: "join", at: "2026-08-22T01:00:00Z", name: "\u0000Gamer1ce" }));
  assert.equal(normalized.playerName, "Gamer1ce");
});

test("同一 JVM 的事件始终按序号重放，不受系统时间回拨影响", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "minecraft-events-"));
  const database = new DatabaseSync(":memory:");
  try {
    journal(directory, "run-clock-shift.ndjson", [
      event({ runId: "run-clock-shift", seq: 1, type: "run-start", at: "2026-08-22T02:00:00.000Z", uptimeMs: 0, name: null }),
      event({ runId: "run-clock-shift", seq: 2, type: "join", at: "2026-08-22T02:01:00.000Z", uptimeMs: 60_000 }),
      event({ runId: "run-clock-shift", seq: 3, type: "leave", at: "2026-08-22T01:59:00.000Z", uptimeMs: 120_000 })
    ]);
    const log = createMinecraftPlayerLogStore({ database, eventsDirectory: directory });
    await log.sync();
    const result = log.recent();

    assert.equal(result.total, 1);
    assert.equal(result.sessions[0].startReason, "join");
    assert.equal(result.sessions[0].endReason, "leave");
    assert.equal(result.sessions[0].durationSeconds, 60);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("事件序号出现缺口时采集状态降级且不再声称玩家在线", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "minecraft-events-"));
  const database = new DatabaseSync(":memory:");
  try {
    journal(directory, "run-gap.ndjson", [
      event({ runId: "run-gap", seq: 1, type: "run-start", at: "2026-08-22T04:00:00.000Z", name: null }),
      event({ runId: "run-gap", seq: 3, type: "join", at: "2026-08-22T04:01:00.000Z" })
    ]);
    collectorStatus(directory, { runId: "run-gap", at: "2026-08-22T04:02:00.000Z", uptimeMs: 122_000 });
    const log = createMinecraftPlayerLogStore({ database, eventsDirectory: directory, now: () => Date.parse("2026-08-22T04:02:00.000Z") });
    await log.sync();
    const result = log.recent();

    assert.equal(result.integrity, false);
    assert.equal(result.collectorLive, false);
    assert.equal(result.collectorState, "degraded");
    assert.equal(result.sessions[0].online, false);
    assert.equal(result.sessions[0].unresolved, true);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("心跳序号领先于已导入日志时不会误报采集器正常", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "minecraft-events-"));
  const database = new DatabaseSync(":memory:");
  try {
    journal(directory, "run-missing-tail.ndjson", [
      event({ runId: "run-missing-tail", seq: 1, type: "run-start", at: "2026-08-22T05:00:00.000Z", name: null })
    ]);
    collectorStatus(directory, { runId: "run-missing-tail", at: "2026-08-22T05:01:00.000Z", uptimeMs: 61_000, lastSequence: 2 });
    const log = createMinecraftPlayerLogStore({ database, eventsDirectory: directory, now: () => Date.parse("2026-08-22T05:01:00.000Z") });
    await log.sync();
    const result = log.recent();

    assert.equal(result.integrity, false);
    assert.equal(result.collectorLive, false);
    assert.equal(result.collectorState, "degraded");
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("完整的损坏日志行会让档案进入降级状态", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "minecraft-events-"));
  const database = new DatabaseSync(":memory:");
  try {
    const start = event({ runId: "run-damaged", seq: 1, type: "run-start", at: "2026-08-22T06:00:00.000Z", name: null });
    writeFileSync(path.join(directory, "run-damaged.ndjson"), `${JSON.stringify(start)}\nnot-json\n`);
    collectorStatus(directory, { runId: "run-damaged", at: "2026-08-22T06:01:00.000Z", uptimeMs: 61_000, lastSequence: 1 });
    const log = createMinecraftPlayerLogStore({ database, eventsDirectory: directory, now: () => Date.parse("2026-08-22T06:01:00.000Z") });
    await log.sync();
    const result = log.recent();

    assert.equal(result.integrity, false);
    assert.equal(result.collectorLive, false);
    assert.equal(result.collectorState, "degraded");
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
