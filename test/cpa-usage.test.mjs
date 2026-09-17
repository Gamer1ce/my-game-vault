import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { createCpaUsageService, publicUsageTotals, registerCpaUsageRoutes } from "../src/cpa-usage.mjs";

test("公开汇总仅包含白名单数字，绝不转发密钥、URL 或日志", () => {
  const result = publicUsageTotals({ requests: 12, totalTokens: 100, api_key: "secret", endpoint: "https://private", inputTokens: "not-number", failures: -1 });
  assert.deepEqual(result, { requests: 12, successes: 0, failures: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 100 });
});

test("只读用量数据按北京时间聚合，密钥仅在独立方法读取", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "cpa-usage-"));
  const filename = path.join(directory, "test.db");
  const db = new DatabaseSync(filename);
  const secret = "test-secret-".repeat(5);
  try {
    for (const table of ["usage_overview_daily_stats", "usage_overview_hourly_stats"]) {
      db.exec(`CREATE TABLE ${table} (bucket_start TEXT, request_count INTEGER, success_count INTEGER, failure_count INTEGER, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, total_tokens INTEGER, api_group_key TEXT);`);
      db.prepare(`INSERT INTO ${table} VALUES (?, 3, 2, 1, 100, 20, 40, 120, ?)`).run("2026-09-16T23:00:00Z", secret);
    }
    db.exec("CREATE TABLE cpa_api_keys (id INTEGER, api_key TEXT, is_deleted INTEGER)");
    db.prepare("INSERT INTO cpa_api_keys VALUES (1, ?, 0), (2, ?, 1)").run(secret, "deleted-".repeat(8));
    const service = createCpaUsageService({ databasePath: filename, baseUrl: "https://private.invalid/v1", now: () => new Date("2026-09-17T10:00:00Z") });
    const result = service.summary();
    assert.equal(result.totals.requests, 3);
    assert.equal(result.today.requests, 3);
    assert.equal(result.today.day, "2026-09-17");
    assert.equal(result.days.length, 30);
    assert.equal(result.days[0].requests, 0);
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.ok(!JSON.stringify(result).includes("private.invalid"));
    assert.deepEqual(service.connection(), { baseUrl: "https://private.invalid/v1", apiKeys: [secret] });
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("访客不能直接调用连接接口，错误响应不泄露内部细节", async () => {
  const app = express();
  let reads = 0;
  registerCpaUsageRoutes(app, {
    authorize: (req) => req.get("cookie") === "test-admin-session",
    service: { summary: () => ({ totals: { requests: 2 } }), connection: () => { reads++; return { apiKeys: ["test-only-secret"], baseUrl: "https://private.invalid" }; } }
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const options of [{}, { headers: { cookie: "forged" } }, { headers: { authorization: "Bearer fake" } }]) {
      const response = await fetch(`${base}/api/ai-usage/connection`, options);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.ok(!(await response.text()).includes("test-only-secret"));
    }
    assert.equal(reads, 0);
    assert.equal((await fetch(`${base}/api/ai-usage/config`)).status, 404);
    const admin = await fetch(`${base}/api/ai-usage/connection`, { headers: { cookie: "test-admin-session" } });
    assert.equal(admin.status, 200);
    assert.equal(admin.headers.get("cdn-cache-control"), "no-store");
    assert.equal(reads, 1);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test("未配置用量库时不暴露服务器路径，管理员校验失败关闭", async () => {
  const source = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(source, /authorize: \(req\) => Boolean\(admin\) && adminAuthenticated\(req\) && adminTransportAllowed\(req\) && sameOrigin\(req\)/);
  const frontend = readFileSync(new URL("../public/keeper-bridge.js", import.meta.url), "utf8");
  assert.ok(!frontend.includes("localStorage"));
  assert.ok(!frontend.includes("innerHTML"));
  assert.match(frontend, /pagehide/);
  assert.match(frontend, /visibilitychange/);
  assert.throws(() => createCpaUsageService().summary());
});
