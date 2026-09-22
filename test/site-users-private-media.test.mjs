import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSiteUsers } from "../src/site-users.mjs";
import { createPrivateMedia } from "../src/private-media.mjs";
import { listHighlights } from "../src/highlights.mjs";
import { streamId } from "../src/highlight-streams.mjs";

test("personal media enforces sessions on index, originals, posters and segments, independently of public media", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "media-users-"));
  const publicRoot = path.join(root, "public"), privateRoot = path.join(root, "private");
  mkdirSync(publicRoot); mkdirSync(privateRoot);
  writeFileSync(path.join(publicRoot, "han.mp4"), "public-only"); writeFileSync(path.join(privateRoot, "dai.mp4"), "private-content-1234");
  writeFileSync(path.join(root, "poster.jpg"), "test-poster");
  symlinkSync(publicRoot, path.join(privateRoot, "escape"));
  const stats = statSync(path.join(privateRoot, "dai.mp4"));
  const id = streamId("dai.mp4", stats.size, stats.mtimeMs), stream = path.join(privateRoot, ".playback-cache", id);
  mkdirSync(stream, { recursive: true });
  writeFileSync(path.join(stream, "metadata.json"), JSON.stringify({ filename: "dai.mp4" }));
  writeFileSync(path.join(stream, "index.m3u8"), "#EXTM3U\nsegment-00000.m4s\n"); writeFileSync(path.join(stream, "segment-00000.m4s"), "segment-private");
  let time = Date.now(), adminCalls = 0, adminCleared = 0;
  let users = createSiteUsers({ dataDirectory: root, now: () => time,
    adminLogin: (_req, res) => { adminCalls++; res.json({ canManage: true }); }, clearAdmin: () => { adminCleared++; } });
  await users.createUser({ username: "戴卓然", password: "unique-private-password", library: "dai" });
  await users.createUser({ username: "someone", password: "different-private-password", library: "dai" });
  users.db.prepare("UPDATE site_users SET library='not-dai' WHERE username='someone'").run();
  await assert.rejects(() => users.createUser({ username: "戴卓然", password: "replacement-password", library: "dai" }), /already exists/);
  const app = express(); app.use(express.json());
  app.use("/api/user", (req, res, next) => users.router(req, res, next));
  const media = createPrivateMedia({ dataDirectory: root, directory: privateRoot, mediaUser: req => users.mediaUser(req), posterService: { posterFor: async () => path.join(root, "poster.jpg") } });
  app.use("/api/my-media", media.router);
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); users.close(); rmSync(root, { recursive: true, force: true }); });
  async function request(endpoint, { body, cookie, method, headers = {} } = {}) {
    const r = await fetch(origin + endpoint, { method: method || (body ? "POST" : "GET"), headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text(); let value; try { value = JSON.parse(text); } catch { value = text; }
    return { status: r.status, headers: r.headers, body: value };
  }
  const protectedPaths = ["/api/my-media", "/api/my-media/files/dai.mp4", "/api/my-media/posters/dai.mp4", `/api/my-media/streams/${id}/index.m3u8`, `/api/my-media/streams/${id}/segment-00000.m4s`];
  for (const target of protectedPaths) {
    const denied = await request(target); assert.equal(denied.status, 401); assert.match(denied.headers.get("cache-control"), /no-store/);
    assert.equal((await request(target, { method: "HEAD" })).status, 401);
  }
  const body = { username: "戴卓然", password: "unique-private-password" };
  assert.equal((await request("/api/user/session", { body, headers: { Origin: "https://evil.test" } })).status, 403);
  assert.equal((await request("/api/user/session", { body: { ...body, password: "wrong" } })).status, 401);
  const login = await request("/api/user/session", { body });
  assert.equal(login.status, 200); assert.equal(login.body.canManage, false); assert.equal(login.body.redirect, "/my-videos.html"); assert.equal(adminCleared, 1);
  const cookie = login.headers.getSetCookie().find(value => value.startsWith("mgv_user=") && !value.startsWith("mgv_user=;")).split(";")[0];
  assert.match(login.headers.getSetCookie().at(-1), /HttpOnly/); assert.match(login.headers.getSetCookie().at(-1), /SameSite=Strict/);
  assert.ok(!users.db.prepare("SELECT password_hash FROM site_users WHERE username=?").get("戴卓然").password_hash.includes(body.password));
  assert.ok(!JSON.stringify(login.body).includes(body.password));
  const index = await request("/api/my-media", { cookie });
  assert.equal(index.body.videos.length, 1); assert.equal(index.body.videos[0].filename, "dai.mp4");
  assert.doesNotMatch(JSON.stringify(index.body), /han\.mp4|password|token|\/tmp\//);
  assert.equal(listHighlights(publicRoot).length, 1); assert.equal(listHighlights(publicRoot)[0].filename, "han.mp4");
  const range = await request(index.body.videos[0].url, { cookie, headers: { Range: "bytes=0-6" } });
  assert.equal(range.status, 206); assert.equal(range.body, "private"); assert.equal(range.headers.get("content-range"), "bytes 0-6/20");
  assert.match(range.headers.get("cache-control"), /private, no-store/); assert.equal(range.headers.get("access-control-allow-origin"), null);
  for (const target of protectedPaths) assert.equal((await request(target, { cookie })).status, 200);
  assert.equal((await request("/api/my-media/files/escape%2Fhan.mp4", { cookie })).status, 404);
  assert.equal((await request("/api/my-media/files/..%2Fpublic%2Fhan.mp4", { cookie })).status, 404);
  const other = await request("/api/user/session", { body: { username: "someone", password: "different-private-password" } });
  const otherCookie = other.headers.getSetCookie().at(-1).split(";")[0];
  assert.equal((await request("/api/my-media", { cookie: otherCookie })).status, 401);
  users.close(); users = createSiteUsers({ dataDirectory: root, now: () => time, adminLogin: (_req, res) => { adminCalls++; res.json({ canManage: true }); } });
  assert.equal((await request("/api/my-media", { cookie })).status, 200);
  assert.equal((await request("/api/user/session", { body: { username: "admin", password: "admin-test-password" } })).status, 200); assert.equal(adminCalls, 1);
  assert.equal((await request("/api/user/session", { method: "DELETE", cookie, headers: { Origin: "null" } })).status, 403);
  assert.equal((await request("/api/user/session", { method: "DELETE", cookie })).status, 204);
  for (const target of protectedPaths) assert.equal((await request(target, { cookie })).status, 401);
  time += 9 * 3600_000; assert.equal((await request("/api/user/session", { cookie: otherCookie })).body.user, null);
  for (let n = 0; n < 12; n++) assert.equal((await request("/api/user/session", { body: { username: "missing", password: "wrong" } })).status, 401);
  assert.equal((await request("/api/user/session", { body: { username: "missing", password: "wrong" } })).status, 429);
});

test("homepage sign-in and media deployment preserve admin separation and retire Azure", () => {
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const privateClient = readFileSync(new URL("../public/my-videos.js", import.meta.url), "utf8");
  assert.match(html, /id="adminButton">用户登录/); assert.doesNotMatch(html, /azure\.gamer1ce\.top/);
  assert.match(client, /api\("\/api\/user\/session"/);
  assert.ok(server.indexOf('app.use("/api/my-media", privateMedia.router)') < server.indexOf('app.use(express.static'));
  assert.match(server, /azureRetired \|\| process.env.AZURE_BACKUP_SYNC_ENABLED/);
  assert.match(server, /publicMediaLocalOnly \? null : await remoteMedia.playback/);
  assert.doesNotMatch(privateClient, /innerHTML|localStorage|\.password|media\/highlights/);
});
