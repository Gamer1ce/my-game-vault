import express from "express";
import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";
import { isLoopbackHost, parseCookies } from "./security.mjs";

const derive = promisify(scrypt);
const COOKIE = "mgv_user", SESSION_MS = 8 * 3600_000;
const hash = value => createHash("sha256").update(value).digest("hex");
const fail = (status, message) => Object.assign(new Error(message), { status });
const normalize = value => String(value || "").normalize("NFKC").trim().toLowerCase();

export function createSiteUsers({ dataDirectory, databaseFile, now = Date.now, adminUsername = "admin", adminLogin, adminUser = () => null, clearAdmin = () => {} } = {}) {
  const filename = databaseFile || path.join(dataDirectory, "site-users.db");
  const db = new DatabaseSync(filename);
  if (filename !== ":memory:") chmodSync(filename, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS site_users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, library TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS site_sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES site_users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS site_session_user ON site_sessions(user_id);`);
  const attempts = new Map(); let hashing = 0;
  const router = express.Router();
  function mediaUser(req) {
    const token = parseCookies(req.get("cookie"))[COOKIE];
    if (!token || !/^[\w-]{43}$/.test(token)) return null;
    const row = db.prepare("SELECT u.id,u.username,u.display_name,u.library FROM site_sessions s JOIN site_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?").get(hash(token), now());
    return row ? { id: row.id, username: row.username, displayName: row.display_name, role: "media", library: row.library, home: "/my-videos.html" } : null;
  }
  function clear(req, res) {
    const token = parseCookies(req.get("cookie"))[COOKIE];
    if (token) db.prepare("DELETE FROM site_sessions WHERE token_hash=?").run(hash(token));
    res.clearCookie(COOKIE, { path: "/", httpOnly: true, secure: req.secure, sameSite: "strict" });
  }
  function guard(req) {
    let origin; try { origin = new URL(req.get("origin")); } catch {}
    if (!origin || origin.host !== req.get("host") || origin.protocol !== `${req.protocol}:` || req.get("sec-fetch-site") === "cross-site") throw fail(403, "请求来源不匹配，请从本站登录");
  }
  function throttle(key, limit) {
    const time = now();
    for (const [key, value] of attempts) if (value.until <= time) attempts.delete(key);
    if (attempts.size > 10000) throw fail(503, "登录服务繁忙，请稍后重试");
    const value = attempts.get(key) || { count: 0, until: time + 15 * 60_000 };
    if (value.count >= limit) throw fail(429, "登录尝试过多，请 15 分钟后再试");
    value.count++; attempts.set(key, value);
  }
  async function keyFor(password, salt) {
    if (hashing >= 2) throw fail(503, "正在处理其他登录，请稍后再试");
    hashing++; try { return await derive(password, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }); } finally { hashing--; }
  }
  const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (error) { if (!res.headersSent) res.status(error.status || 500).json({ error: error.status ? error.message : "用户服务暂时不可用" }); } };
  router.use((req, res, next) => {
    res.set({ "Cache-Control": "private, no-store", "CDN-Cache-Control": "no-store", Vary: "Cookie" });
    if (!req.secure && !isLoopbackHost(req.get("host"))) return res.status(426).json({ error: "请通过 HTTPS 登录" });
    next();
  });
  router.get("/session", wrap((req, res) => res.json({ user: adminUser(req) || mediaUser(req) })));
  router.post("/session", wrap(async (req, res) => {
    guard(req); throttle(`ip:${req.ip}`, 20); throttle("global", 150);
    const username = normalize(req.body?.username), password = String(req.body?.password || "");
    if (!username || username.length > 64 || password.length > 512) throw fail(400, "账号或密码格式无效");
    throttle(`account:${username}`, 12);
    if (username === normalize(adminUsername) && adminLogin) return adminLogin(req, res);
    const user = db.prepare("SELECT * FROM site_users WHERE username=?").get(username);
    const [, salt, expected] = (user?.password_hash || `scrypt-v1:${"0".repeat(32)}:${"0".repeat(64)}`).split(":");
    const actual = await keyFor(password, salt);
    const expectedBytes = Buffer.from(expected, "hex");
    if (!user || expectedBytes.length !== actual.length || !timingSafeEqual(actual, expectedBytes)) throw fail(401, "账号或密码不正确");
    clear(req, res); clearAdmin(req, res);
    const token = randomBytes(32).toString("base64url");
    db.prepare("DELETE FROM site_sessions WHERE expires_at<=?").run(now());
    db.prepare("INSERT INTO site_sessions VALUES(?,?,?)").run(hash(token), user.id, now() + SESSION_MS);
    db.prepare("DELETE FROM site_sessions WHERE user_id=? AND token_hash NOT IN (SELECT token_hash FROM site_sessions WHERE user_id=? ORDER BY expires_at DESC LIMIT 5)").run(user.id, user.id);
    res.cookie(COOKIE, token, { path: "/", httpOnly: true, secure: req.secure, sameSite: "strict", maxAge: SESSION_MS });
    res.json({ user: { username: user.username, displayName: user.display_name, role: "media", home: "/my-videos.html" }, redirect: "/my-videos.html", canManage: false });
  }));
  router.delete("/session", wrap((req, res) => { guard(req); clear(req, res); clearAdmin(req, res); res.status(204).end(); }));
  router.use((_req, res) => res.status(404).json({ error: "接口不存在" }));
  return { router, db, mediaUser, clear,
    async createUser({ username, displayName, password, library }) {
      username = normalize(username);
      if (!/^[\p{L}\p{N}_-]{3,64}$/u.test(username) || username === normalize(adminUsername) || library !== "dai" || typeof password !== "string" || password.length < 16 || password.length > 128) throw new Error("Invalid account configuration");
      if (db.prepare("SELECT 1 FROM site_users WHERE username=?").get(username)) throw new Error("Account already exists; password was not changed");
      const salt = randomBytes(16).toString("hex"), key = await keyFor(password, salt);
      const id = randomUUID();
      db.prepare("INSERT INTO site_users VALUES(?,?,?,?,?,?)").run(id, username, String(displayName || username).slice(0, 64), `scrypt-v1:${salt}:${key.toString("hex")}`, library, now());
      return { id, username };
    }, close() { db.close(); }
  };
}
