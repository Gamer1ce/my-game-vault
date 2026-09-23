import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import { createHash } from "node:crypto";
import { createSiteUsers } from "../src/site-users.mjs";
import { createPrivateMedia } from "../src/private-media.mjs";
import { memoryBufferEligible, PRIVATE_MEMORY_LIMIT, playableAhead } from "../public/private-playback.js";

test("private direct tickets bind origin, file and live login, including Range and logout", async t => {
  const dir = mkdtempSync(path.join(tmpdir(), "private-direct-")); let now = Date.now();
  writeFileSync(path.join(dir, "one.mp4"), "private-one"); writeFileSync(path.join(dir, "two.mp4"), "private-two");
  const users = createSiteUsers({ dataDirectory: dir, now: () => now });
  await users.createUser({ username: "test-user", password: "strong-test-password", library: "dai" });
  const primary = "https://site.example.test", direct = "https://media.example.test:8443";
  const fileUrl = "/api/private-playback/file/" + createHash("sha256").update("one.mp4").digest("hex").slice(0, 32);
  const media = createPrivateMedia({ dataDirectory: dir, directory: dir, mediaUser: users.mediaUser, directOrigin: direct, allowedOrigins: [primary], playbackSession: users.playbackSession, sessionActive: users.playbackSessionActive, now: () => now });
  const app = express(); app.set("trust proxy", 1); app.use(express.json());
  app.use("/api/user", users.router); app.use("/api/my-media", media.router); app.use("/api/private-playback", media.directRouter);
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); users.close(); rmSync(dir, { recursive: true, force: true }); });
  async function call(url, { directHost = false, method = "GET", body, cookie, origin = primary, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = httpRequest(`http://127.0.0.1:${server.address().port}${url}`, { method, headers: { Host: new URL(directHost ? direct : primary).host, "X-Forwarded-Proto": "https", Origin: origin, ...headers, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}) } }, res => {
        const chunks = []; res.on("data", c => chunks.push(c)); res.on("end", () => {
          const text = Buffer.concat(chunks).toString(); let value; try { value = JSON.parse(text); } catch { value = text; }
          const responseHeaders = new Headers(); for (let i = 0; i < res.rawHeaders.length; i += 2) responseHeaders.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
          resolve({ status: res.statusCode, headers: responseHeaders, value });
        });
      }); req.on("error", reject); req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  const login = await call("/api/user/session", { method: "POST", body: { username: "test-user", password: "strong-test-password" } });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().filter(s => s.startsWith("mgv_user=")).at(-1).split(";")[0];
  const grant = () => call("/api/my-media/playback", { method: "POST", cookie, body: { filename: "one.mp4" } });
  assert.equal((await call("/api/my-media/playback", { method: "POST", body: { filename: "one.mp4" } })).status, 401);
  assert.equal((await call("/api/my-media/playback", { method: "POST", cookie, body: { filename: "../one.mp4" } })).status, 404);
  assert.equal((await call("/api/my-media/playback", { method: "POST", cookie, origin: "https://evil.test", body: { filename: "one.mp4" } })).status, 403);
  for (const method of ["GET", "HEAD"]) assert.equal((await call(fileUrl, { directHost: true, method })).status, 401);
  assert.equal((await call(fileUrl, { directHost: true, origin: "https://evil.test" })).status, 403);
  const ticket = (await grant()).value.direct.ticket;
  assert.equal((await call("/api/private-playback/session", { method: "POST", body: { ticket } })).status, 404);
  const session = await call("/api/private-playback/session", { directHost: true, method: "POST", body: { ticket } });
  assert.equal(session.status, 200); assert.equal(session.value.url, direct + fileUrl);
  assert.equal((await call("/api/private-playback/session", { directHost: true, method: "POST", body: { ticket } })).status, 401);
  const setCookie = session.headers.getSetCookie()[0], playbackCookie = setCookie.split(";")[0];
  for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/api/private-playback"]) assert.ok(setCookie.includes(flag));
  assert.ok(!setCookie.includes("Domain="));
  const range = await call(fileUrl, { directHost: true, cookie: playbackCookie, headers: { Range: "bytes=0-6" } });
  assert.equal(range.status, 206); assert.equal(range.value, "private"); assert.equal(range.headers.get("content-range"), "bytes 0-6/11");
  assert.equal(range.headers.get("access-control-allow-origin"), primary); assert.equal(range.headers.get("access-control-allow-credentials"), "true"); assert.match(range.headers.get("cache-control"), /no-store/);
  assert.equal((await call("/api/private-playback/file/two.mp4", { directHost: true, cookie: playbackCookie })).status, 401);
  assert.equal((await call(fileUrl, { directHost: true, cookie: playbackCookie, origin: "https://evil.test" })).status, 403);
  const expired = (await grant()).value.direct.ticket; now += 31_000;
  assert.equal((await call("/api/private-playback/session", { directHost: true, method: "POST", body: { ticket: expired } })).status, 401);
  await call("/api/user/session", { method: "DELETE", cookie });
  assert.equal((await call(fileUrl, { directHost: true, cookie: playbackCookie })).status, 401);
});

test("private memory buffering is bounded and counts only playable timeline", () => {
  assert.equal(memoryBufferEligible(40 * 1024 * 1024), true);
  for (const size of [0, -1, NaN, Infinity, PRIVATE_MEMORY_LIMIT + 1]) assert.equal(memoryBufferEligible(size), false);
  assert.equal(playableAhead({ currentTime: 5, buffered: { length: 2, start: i => [0, 20][i], end: i => [10, 30][i] } }), 5);
  assert.equal(playableAhead({ currentTime: 15, buffered: { length: 1, start: () => 20, end: () => 30 } }), 0);
});
