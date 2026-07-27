import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSyncRequestQueue } from "../src/sync-request.mjs";

test("未配置文件时远程同步队列保持关闭", () => {
  const queue = createSyncRequestQueue("");
  assert.equal(queue.enabled, false);
  assert.deepEqual(queue.status(), { enabled: false, request: null, result: null });
});

test("登记新请求时使用随机编号并清理旧结果", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "game-vault-sync-"));
  const requestFile = path.join(directory, "request.json");
  const resultFile = `${requestFile}.result.json`;
  writeFileSync(resultFile, '{"requestId":"old"}\n');

  try {
    const queue = createSyncRequestQueue(requestFile, {
      now: () => new Date("2026-07-27T08:00:00.000Z"),
      createId: () => "request-0816"
    });
    const request = queue.enqueue();

    assert.deepEqual(request, {
      id: "request-0816",
      requestedAt: "2026-07-27T08:00:00.000Z"
    });
    assert.deepEqual(JSON.parse(readFileSync(requestFile, "utf8")), request);
    assert.deepEqual(queue.status(), { enabled: true, request, result: null });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("状态接口读取 Mac 写回的同步结果", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "game-vault-sync-"));
  const requestFile = path.join(directory, "request.json");
  const resultFile = `${requestFile}.result.json`;

  try {
    const queue = createSyncRequestQueue(requestFile);
    writeFileSync(requestFile, '{"id":"request-1","requestedAt":"2026-07-27T08:00:00.000Z"}\n');
    writeFileSync(resultFile, '{"requestId":"request-1","results":[{"provider":"steam","ok":true}]}\n');

    assert.deepEqual(queue.status(), {
      enabled: true,
      request: { id: "request-1", requestedAt: "2026-07-27T08:00:00.000Z" },
      result: { requestId: "request-1", results: [{ provider: "steam", ok: true }] }
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
