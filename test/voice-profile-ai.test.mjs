import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { randomBytes, createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createVoiceCommunity } from "../src/voice-community.mjs";
import { createVoiceProfileDesigner, parseProfileDesignResponse } from "../src/voice-profile-ai.mjs";
import { DEFAULT_PROFILE_DESIGN, normalizeProfileDesign } from "../public/voice-design.js";

const draft = { theme: "blue", bio: "群星之下", design: { ...DEFAULT_PROFILE_DESIGN, layout: "centered", banner: "orbit", font: "mono", surface: "midnight", tagline: "保持航向" } };

test("AI designs are a finite, typed vocabulary, not arbitrary CSS or executable content", () => {
  assert.deepEqual(parseProfileDesignResponse(JSON.stringify(draft)), draft);
  assert.deepEqual(parseProfileDesignResponse('```json\n' + JSON.stringify(draft) + '\n```'), draft);
  for (const value of [{ ...draft, html: "<script>run()</script>" }, { ...draft, design: { ...draft.design, banner: "url(https://evil.test)" } },
    { ...draft, design: { ...draft.design, css: "body{display:none}" } }, { ...draft, design: { ...draft.design, tagline: {} } }, { ...draft, bio: "x".repeat(181) }]) {
    assert.throws(() => parseProfileDesignResponse(JSON.stringify(value)));
  }
  assert.deepEqual(normalizeProfileDesign({ banner: "javascript:evil" }), DEFAULT_PROFILE_DESIGN);
});

test("designer pins the server's model, bounds tokens, and sends only the requested profile material", async () => {
  let call;
  const designer = createVoiceProfileDesigner({ baseUrl: "http://local-cpa.test/v1", getApiKey: () => "private-test-credential", fetchImpl: async (url, init) => {
    call = { url, init }; return Response.json({ choices: [{ message: { content: JSON.stringify(draft) } }] });
  } });
  const result = await designer.generate({ prompt: "星空面板", current: { bio: "hello", username: "DO_NOT_SEND", avatarUrl: "PRIVATE", password: "NEVER", theme: "cyan" } });
  assert.deepEqual(result, draft);
  const body = JSON.parse(call.init.body);
  assert.equal(body.model, "grok-4.6"); assert.equal(body.max_tokens, 900); assert.equal(body.stream, false); assert.equal(call.init.redirect, "error");
  assert.doesNotMatch(call.init.body, /DO_NOT_SEND|PRIVATE|NEVER|private-test-credential/);
  assert.equal(call.init.headers.Authorization, "Bearer private-test-credential");
  for (const response of [new Response("secret URL and API key", { status: 401 }), Response.json({ choices: [{ message: { content: "<script>evil</script>" } }] }),
    new Response("x".repeat(65537))]) {
    const invalid = createVoiceProfileDesigner({ baseUrl: "http://local-cpa.test/v1", getApiKey: () => "private-test-credential", fetchImpl: async () => response });
    await assert.rejects(() => invalid.generate({ prompt: "test" }), error => error.status === 502 && !/secret|local-cpa|private-test-credential|script/.test(error.message));
  }
  const timed = createVoiceProfileDesigner({ baseUrl: "http://local-cpa.test/v1", getApiKey: () => "key", fetchImpl: async () => { throw new DOMException("private URL", "TimeoutError"); } });
  await assert.rejects(() => timed.generate({ prompt: "test" }), error => error.status === 504 && !error.message.includes("private"));
});

test("AI route requires community auth and CSRF, previews without saving, and persists bounded quotas", async t => {
  const directory = mkdtempSync(path.join(tmpdir(), "voice-ai-test-"));
  let time = Date.UTC(2026, 8, 20, 2), calls = 0, hold;
  const designer = { model: "grok-4.6", async generate() { calls++; if (hold) await hold; return draft; } };
  let community = createVoiceCommunity({ dataDirectory: directory, profileDesigner: designer, now: () => time });
  const tokens = new Map();
  for (const name of ["alice", "bob", "carol"]) {
    community.db.prepare("INSERT INTO voice_users(id,username,password_hash,display_name,created_at) VALUES(?,?,?,?,?)").run(name, name, "unused", name, time);
    const token = randomBytes(32).toString("base64url"); tokens.set(name, token);
    community.db.prepare("INSERT INTO voice_sessions VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), name, name + "-csrf", time + 7 * 86400_000);
  }
  const app = express(); app.set("trust proxy", "loopback"); app.use(express.json()); app.use("/api/voice", (req, res, next) => community.router(req, res, next));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); community.close(); rmSync(directory, { recursive: true, force: true }); });
  async function request(endpoint = "profile-ai", { user = "alice", body, method, headers = {} } = {}) {
    const r = await fetch(`${origin}/api/voice/${endpoint}`, { method: method || (body ? "POST" : "GET"), headers: { Origin: origin,
      ...(user ? { Cookie: `mgv_voice=${tokens.get(user)}`, "X-CSRF-Token": user + "-csrf" } : {}),
      "Content-Type": "application/json", ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() };
  }
  const prompt = { prompt: "深蓝色太空终端", model: "unapproved", baseUrl: "https://evil.test" };
  assert.equal((await request("profile-ai", { user: null })).status, 401);
  assert.equal((await request("profile-ai", { user: null, body: prompt })).status, 401);
  assert.equal((await request("profile-ai", { body: prompt, headers: { Origin: "https://evil.test" } })).status, 403);
  assert.equal((await request("profile-ai", { body: prompt, headers: { "X-CSRF-Token": "bad" } })).status, 403);
  assert.equal((await request("profile-ai", { body: { prompt: "x".repeat(1201) } })).status, 400);
  assert.equal(calls, 0);
  const generated = await request("profile-ai", { body: prompt });
  assert.equal(generated.status, 200); assert.deepEqual(generated.body.draft, draft); assert.equal(generated.body.remaining, 7);
  assert.equal(community.db.prepare("SELECT theme FROM voice_users WHERE id='alice'").get().theme, "yellow");
  assert.equal((await request("profile-ai", { body: prompt })).status, 429);
  const saved = await request("profile", { method: "PATCH", body: { ...draft, displayName: "Alice", userId: "bob" } });
  assert.equal(saved.status, 200); assert.deepEqual(saved.body.user.design, draft.design);
  assert.equal(community.db.prepare("SELECT theme FROM voice_users WHERE id='bob'").get().theme, "yellow");
  assert.equal((await request("profile", { method: "PATCH", body: { ...draft, displayName: "Alice", design: { ...draft.design, html: "evil" } } })).status, 400);
  community.close(); community = createVoiceCommunity({ dataDirectory: directory, profileDesigner: designer, now: () => time });
  assert.equal((await request()).body.remaining, 7);
  assert.deepEqual((await request("session")).body.user.design, draft.design);
  for (let i = 0; i < 7; i++) { time += 31_000; assert.equal((await request("profile-ai", { body: prompt })).status, 200); }
  time += 31_000; assert.equal((await request("profile-ai", { body: prompt })).status, 429);
  time += 86400_000; assert.equal((await request()).body.remaining, 8);
  let release; hold = new Promise(resolve => { release = resolve; });
  const first = request("profile-ai", { body: prompt });
  while (calls < 9) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await request("profile-ai", { body: prompt })).status, 429);
  const second = request("profile-ai", { user: "bob", body: prompt });
  while (calls < 10) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await request("profile-ai", { user: "carol", body: prompt })).status, 429);
  release(); hold = null; assert.equal((await first).status, 200); assert.equal((await second).status, 200);
  const day = new Date(time + 8 * 3600_000).toISOString().slice(0, 10);
  community.db.prepare("UPDATE voice_ai_usage SET count=100 WHERE scope='global' AND day=?").run(day);
  assert.equal((await request("profile-ai", { user: "carol", body: prompt })).status, 429);
  assert.equal((await request("profile-ai", { user: "carol" })).body.remaining, 8);
  community.close(); community = createVoiceCommunity({ dataDirectory: directory, now: () => time });
  assert.equal((await request()).body.enabled, false);
  assert.equal((await request("profile-ai", { body: prompt })).status, 503);
});

test("profile design UI does not execute arbitrary AI HTML or CSS", () => {
  const browser = readFileSync(new URL("../public/voice.js", import.meta.url), "utf8");
  assert.doesNotMatch(browser, /innerHTML|insertAdjacentHTML|eval\(|\.cssText|localStorage/);
  assert.match(browser, /aiDraft = null/); assert.match(browser, /applyDesign.*addEventListener/);
  assert.doesNotMatch(browser, /cli-proxy-api|Bearer|VOICE_AI_API_KEY|8317/);
});
