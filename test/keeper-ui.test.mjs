import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { nativeKeeperHtml, keeperPublicTarget, sanitizeKeeperPublic, registerKeeperUiRoutes } from "../src/keeper-ui.mjs";

test("原版 KEEPER 资源直接复用，仅调整部署路径与网站登录入口", () => {
  const result = nativeKeeperHtml('<html><head><script>window.__APP_BASE_PATH__ = "";</script><script src="./assets/index-123.js"></script><link href="./assets/index-123.css"></head><body><div id="root"></div></body></html>');
  assert.match(result, /src="\/ai-usage\/assets\/index-123.js"/);
  assert.match(result, /keeper-bridge.js/);
  assert.match(result, /id="root"/);
  assert.doesNotMatch(result, /<script>/);
});

test("访客统计白名单去掉密钥、URL、账号与自由文本", () => {
  const safe = sanitizeKeeperPublic({
    usage: { total_requests: 5, total_tokens: 120, api_key: "private-value" },
    timezone: "Asia/Shanghai",
    model_composition: [{ key: "gpt-5", label: "gpt-5", total_tokens: 120 }],
    api_key_composition: [{ key: "secret-key", label: "private-value" }],
    auth_files_composition: [{ label: "user@example.test" }],
    ai_provider_composition: [{ key: "https://secret.test" }],
    current_usage: { models: [], api_keys: [{ key: "private-value" }], auth_files: [{ label: "my-account" }] },
    heatmap: { api_keys: ["private-value"], api_key_labels: { "private-value": "account" }, cells: [] },
    model: "sk-cpa-test-secret", label: "https://private.test", error: "raw secret", endpoint: "http://127.0.0.1:8317"
  });
  assert.equal(safe.usage.total_requests, 5);
  assert.equal(safe.model_composition[0].key, "gpt-5");
  const text = JSON.stringify(safe);
  for (const secret of ["private-value", "secret-key", "my-account", "secret.test", "user@example", "127.0.0.1", "sk-cpa", "private.test"]) assert.ok(!text.includes(secret));
});

test("访客不能选择其他 API、任意地址、身份或日志查询", () => {
  assert.equal(keeperPublicTarget("/key-overview", { range: "7d" }), "/api/v1/usage/overview?range=7d");
  for (const pathname of ["/status", "/usage/events", "/usage/api-keys", "/auth/sessions", "/../status", "//evil.test"]) assert.equal(keeperPublicTarget(pathname), null);
  assert.equal(keeperPublicTarget("/key-overview", { api_key_id: "1" }), null);
  assert.equal(keeperPublicTarget("/key-overview", { url: "https://evil.test" }), null);
  assert.equal(keeperPublicTarget("/key-overview", { range: ["7d", "all"] }), null);
});

test("原版页面的全部敏感请求经过后端认证，访客仅获取清洗后的统计", async () => {
  const app = express(); app.use(express.json());
  const requests = [];
  registerKeeperUiRoutes(app, {
    authorize: (req) => req.get("cookie") === "test-authenticated",
    sameOrigin: (req) => req.get("origin") !== "https://evil.test",
    login: (_req, res) => res.json({ loggedIn: true }), logout: (_req, res) => res.status(204).end(),
    request: async (pathname) => {
      requests.push(pathname);
      return { status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify({ usage: { total_requests: 5 }, api_key: "test-only-secret", endpoint: "https://private.test" })) };
    }
  });
  const server = app.listen(0, "127.0.0.1"); await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/ai-usage/api/v1`;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/ai-usage/`)).status, 200);
    requests.length = 0;
    for (const pathname of ["/status", "/usage/api-keys/settings", "/auth/sessions", "/usage/events", "/quota/cache"]) {
      const result = await fetch(base + pathname); assert.equal(result.status, 403);
    }
    assert.equal(requests.length, 0);
    const session = await (await fetch(`${base}/auth/session`)).json(); assert.equal(session.role, "api_key_viewer");
    const guest = await fetch(`${base}/key-overview?range=7d`); const data = await guest.json();
    assert.deepEqual(data, { usage: { total_requests: 5 } }); assert.equal(guest.headers.get("cdn-cache-control"), "no-store");
    assert.equal((await fetch(`${base}/key-overview?api_key_id=2`)).status, 403);
    const admin = await fetch(`${base}/status`, { headers: { cookie: "test-authenticated" } });
    assert.equal((await admin.json()).api_key, "test-only-secret");
    assert.equal((await fetch(`${base}/pricing`, { method: "POST", headers: { cookie: "test-authenticated" } })).status, 403);
    assert.equal((await fetch(`${base}/auth/logout`, { method: "POST", headers: { origin: "https://evil.test" } })).status, 403);
    assert.equal((await fetch(`${base}/auth/api-key-login`, { method: "POST" })).status, 403);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
