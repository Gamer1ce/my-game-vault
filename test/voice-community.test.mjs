import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { createVoiceCommunity, validateVoiceCredentials } from "../src/voice-community.mjs";

test("voice credentials use normalized usernames without trimming passwords", () => {
  assert.equal(validateVoiceCredentials({ username: " Ｇamer_1 ", password: " a long phrase " }).username, "gamer_1");
  assert.equal(validateVoiceCredentials({ username: "玩家甲", password: " a long phrase " }).password, " a long phrase ");
  assert.throws(() => validateVoiceCredentials({ username: "../admin", password: "valid-long-password" }), /用户名/);
  assert.throws(() => validateVoiceCredentials({ username: "valid", password: "short" }), /密码/);
});

test("voice community auth, profile, signaling and lifecycle are isolated and bounded", async t => {
  const directory = mkdtempSync(path.join(tmpdir(), "voice-community-test-"));
  let clock = Date.now();
  let community = createVoiceCommunity({ dataDirectory: directory, now: () => clock });
  const app = express(); app.set("trust proxy", "loopback"); app.use(express.json({ limit: "1mb" }));
  app.use("/api/voice", (req, res, next) => community.router(req, res, next));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const controllers = [];
  async function request(endpoint, { user, body, method, headers = {}, ip = "192.0.2.1" } = {}) {
    const response = await fetch(`${origin}/api/voice/${endpoint}`, {
      method: method || (body === undefined ? "GET" : "POST"),
      headers: { Origin: origin, "X-Forwarded-For": ip, ...(user ? { Cookie: user.cookie, "X-CSRF-Token": user.csrf } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, headers: response.headers, body: response.status === 204 ? null : await response.json() };
  }
  async function register(n) {
    const result = await request("register", { ip: `192.0.2.${n}`, body: { username: `player${n}`, password: "test-only-long-password" } });
    assert.equal(result.status, 201);
    const cookie = result.headers.get("set-cookie").split(";")[0];
    assert.match(result.headers.get("set-cookie"), /HttpOnly/); assert.match(result.headers.get("set-cookie"), /SameSite=Strict/);
    return { ...result.body, cookie };
  }
  t.after(async () => { controllers.forEach(controller => controller.abort()); community.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  await t.test("anonymous and cross-origin requests cannot access channels or create accounts", async () => {
    assert.equal((await request("rooms")).status, 401);
    const body = { username: "intruder", password: "test-only-long-password" };
    assert.equal((await request("register", { body, headers: { Origin: "https://evil.example" } })).status, 403);
    assert.equal((await request("register", { body, headers: { Origin: "null" } })).status, 403);
    assert.equal((await request("register", { body, headers: { Origin: "" } })).status, 403);
    const insecureStatus = await new Promise(resolve => {
      const req = http.request(`${origin}/api/voice/session`, { headers: { Host: "example.com" } }, res => { res.resume(); resolve(res.statusCode); }); req.end();
    });
    assert.equal(insecureStatus, 426);
  });
  const users = [];
  for (let n = 1; n <= 7; n++) users.push(await register(n));
  await t.test("passwords and session tokens are hashed, profile JSON contains no credentials", async () => {
    const row = community.db.prepare("SELECT * FROM voice_users WHERE id=?").get(users[0].user.id);
    assert.match(row.password_hash, /^scrypt-v1:/); assert.ok(!row.password_hash.includes("test-only-long-password"));
    const session = await request("session", { user: users[0] });
    assert.equal(session.body.user.username, "player1");
    assert.ok(!JSON.stringify(session.body).includes("password_hash"));
    const token = users[0].cookie.split("=")[1];
    assert.ok(community.db.prepare("SELECT 1 FROM voice_sessions WHERE token_hash=?").get(createHash("sha256").update(token).digest("hex")));
    assert.ok(!community.db.prepare("SELECT 1 FROM voice_sessions WHERE token_hash=?").get(token));
    assert.equal((await request("login", { body: { username: "player1", password: "a wrong long password" } })).status, 401);
  });
  await t.test("profile changes belong to the authenticated user; avatar uploads are re-encoded", async () => {
    const body = { displayName: "玩家一", bio: "<script>alert(1)</script>", theme: "cyan", userId: users[1].user.id };
    assert.equal((await request("profile", { user: users[0], body, method: "PATCH", headers: { "X-CSRF-Token": "wrong" } })).status, 403);
    const result = await request("profile", { user: users[0], body, method: "PATCH" });
    assert.equal(result.status, 200); assert.equal(result.body.user.id, users[0].user.id);
    assert.equal((await request("session", { user: users[1] })).body.user.displayName, "player2");
    assert.equal((await request("profile", { user: users[0], body: { ...body, theme: "url(evil)" }, method: "PATCH" })).status, 400);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>').toString("base64");
    assert.equal((await request("profile", { user: users[0], body: { ...body, avatar: `data:image/png;base64,${svg}` }, method: "PATCH" })).status, 400);
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: "red" } }).png().toBuffer();
    const saved = await request("profile", { user: users[0], body: { ...body, avatar: `data:image/png;base64,${png.toString("base64")}` }, method: "PATCH" });
    assert.match(saved.body.user.avatarUrl, /^\/api\/voice\/avatar\//);
    assert.equal((await fetch(`${origin}${saved.body.user.avatarUrl}`)).status, 401);
    const image = await fetch(`${origin}${saved.body.user.avatarUrl}`, { headers: { Cookie: users[0].cookie } });
    assert.equal(image.headers.get("content-type"), "image/webp");
    const metadata = await sharp(Buffer.from(await image.arrayBuffer())).metadata(); assert.equal(metadata.width, 256);
  });
  const joined = [];
  for (let index = 0; index < 6; index++) {
    const result = await request("join", { user: users[index], body: { roomId: "lobby" } });
    assert.equal(result.status, 200); assert.equal(result.body.relayAvailable, false); joined.push(result.body);
  }
  await t.test("six member cap, same-room signaling, ownership and stale peer rejection", async () => {
    assert.equal((await request("join", { user: users[6], body: { roomId: "lobby" } })).status, 409);
    const other = await request("join", { user: users[6], body: { roomId: "squad" } });
    const body = { peerId: joined[0].peerId, target: joined[1].peerId, description: { type: "offer", sdp: "test-offer" } };
    assert.equal((await request("signal", { user: users[2], body })).status, 409);
    assert.equal((await request("signal", { user: users[0], body: { ...body, target: other.body.peerId } })).status, 409);
    assert.equal((await request("signal", { user: users[0], body: { ...body, description: { type: "offer", sdp: "x".repeat(40001) } } })).status, 400);
    assert.equal((await request("signal", { user: users[0], body })).status, 204);
    const controller = new AbortController(); controllers.push(controller);
    const events = await fetch(`${origin}/api/voice/events?peer=${joined[1].peerId}`, { headers: { Cookie: users[1].cookie }, signal: controller.signal });
    assert.match(events.headers.get("content-type"), /text\/event-stream/);
    const reader = events.body.getReader(); let received = "";
    while (!received.includes("test-offer")) { const part = await reader.read(); if (part.done) break; received += new TextDecoder().decode(part.value); }
    assert.match(received, /event: signal/); assert.match(received, /test-offer/);
    await reader.cancel();
    const switched = await request("join", { user: users[0], body: { roomId: "squad" } });
    assert.equal(switched.status, 200);
    assert.equal((await request("signal", { user: users[0], body })).status, 409);
  });
  await t.test("persistent sessions survive restart, logout and expiry revoke access", async () => {
    community.close(); community = createVoiceCommunity({ dataDirectory: directory, now: () => clock });
    assert.equal((await request("session", { user: users[0] })).body.user.displayName, "玩家一");
    assert.equal((await request("logout", { user: users[0], body: {} })).status, 204);
    assert.equal((await request("rooms", { user: users[0] })).status, 401);
    const rejoined = await request("join", { user: users[1], body: { roomId: "lobby" } });
    clock += 60_000; community.sweep();
    assert.equal((await request("heartbeat", { user: users[1], body: { peerId: rejoined.body.peerId } })).status, 409);
    clock += 8 * 86400_000; community.sweep();
    assert.equal((await request("session", { user: users[1] })).body.user, null);
  });
});

test("voice integration preserves administrator gate and only enables mic on voice pages", () => {
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const browser = readFileSync(new URL("../public/voice.js", import.meta.url), "utf8");
  assert.ok(server.indexOf('app.use("/api/voice", voiceCommunity.router)') < server.indexOf('if (!admin || !req.path.startsWith("/api/")'));
  assert.match(server, /\["\/voice", "\/voice.html"\].includes\(_req.path\)/);
  assert.match(browser, /getUserMedia\(\{ audio:[\s\S]*video: false/);
  assert.doesNotMatch(browser, /innerHTML|localStorage|MediaRecorder/);
  assert.match(browser, /getTracks\(\).forEach\(track => track.stop\(\)\)/);
});
