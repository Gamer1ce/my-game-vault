import express from "express";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { chmodSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { parseCookies, isLoopbackHost } from "./security.mjs";

const derive = promisify(scrypt);
const SESSION_MS = 7 * 86400_000;
const COOKIE = "mgv_voice";
const THEMES = ["yellow", "cyan", "violet", "orange", "silver"];
export const VOICE_ROOMS = [
  { id: "lobby", name: "公共大厅", description: "随时进来坐坐" },
  { id: "squad", name: "组队频道", description: "集合，准备出发" },
  { id: "lounge", name: "深夜电台", description: "游戏之外，聊点别的" }
];
const fail = (status, message) => Object.assign(new Error(message), { status });
const digest = value => createHash("sha256").update(value).digest("hex");
const equal = (a, b) => { const x = Buffer.from(a || ""), y = Buffer.from(b || ""); return x.length === y.length && timingSafeEqual(x, y); };
const clean = (value, limit) => String(value || "").normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, limit);

export function validateVoiceCredentials(body = {}) {
  const username = String(body.username || "").normalize("NFKC").trim().toLowerCase();
  const password = String(body.password || "");
  if (!/^[\p{L}\p{N}_-]{3,24}$/u.test(username)) throw fail(400, "用户名需为 3–24 个文字、数字、下划线或短横线");
  if (password.length < 12 || password.length > 128 || Buffer.byteLength(password) > 512) throw fail(400, "密码需要 12–128 位，可以使用容易记住的长句");
  return { username, password };
}

export function createVoiceCommunity({ dataDirectory, databaseFile, now = Date.now } = {}) {
  const filename = databaseFile || path.join(dataDirectory, "voice.db");
  const db = new DatabaseSync(filename);
  if (filename !== ":memory:") chmodSync(filename, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS voice_users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '', theme TEXT NOT NULL DEFAULT 'yellow',
      avatar BLOB, avatar_version INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS voice_sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES voice_users(id) ON DELETE CASCADE,
      csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS voice_sessions_user ON voice_sessions(user_id);
    CREATE INDEX IF NOT EXISTS voice_sessions_expiry ON voice_sessions(expires_at);
  `);
  const router = express.Router();
  const members = new Map();
  const limits = new Map();
  let hashing = 0;
  let joinOrder = 0;
  const publicUser = user => ({ id: user.id, username: user.username, displayName: user.display_name, bio: user.bio, theme: user.theme,
    avatarUrl: user.avatar_version ? `/api/voice/avatar/${user.id}?v=${user.avatar_version}` : null });
  const userById = id => db.prepare("SELECT id, username, display_name, bio, theme, avatar_version FROM voice_users WHERE id=?").get(id);
  const serialize = member => ({ peerId: member.peerId, order: member.order, muted: member.muted, deafened: member.deafened, user: publicUser(userById(member.userId)) });
  const roomList = () => VOICE_ROOMS.map(room => ({ ...room, capacity: 6, members: [...members.values()].filter(m => m.roomId === room.id).map(serialize) }));

  function limit(key, count, windowMs) {
    const time = now();
    if (limits.size > 10000) for (const [name, value] of limits) if (value.expires <= time) limits.delete(name);
    const entry = limits.get(key);
    if (entry && entry.expires > time) {
      if (entry.count >= count) throw fail(429, "操作过于频繁，请稍后再试");
      entry.count++;
    } else {
      if (limits.size > 12000) throw fail(503, "服务繁忙，请稍后再试");
      limits.set(key, { count: 1, expires: time + windowMs });
    }
  }
  function getSession(req) {
    const token = parseCookies(req.get("cookie"))[COOKIE];
    if (!token || !/^[\w-]{43}$/.test(token)) return null;
    return db.prepare("SELECT * FROM voice_sessions WHERE token_hash=? AND expires_at>?").get(digest(token), now()) || null;
  }
  function requireSession(req) {
    const session = getSession(req);
    if (!session) throw fail(401, "请先登录你的社区账号");
    return session;
  }
  function writeGuard(req, session) {
    const origin = req.get("origin");
    let valid = false;
    try { const url = new URL(origin); valid = url.host === req.get("host") && url.protocol === `${req.protocol}:`; } catch {}
    if (!valid || req.get("sec-fetch-site") === "cross-site") throw fail(403, "请求来源不匹配，请从本站页面重试");
    if (session && !equal(req.get("x-csrf-token"), session.csrf)) throw fail(403, "登录状态已更新，请刷新页面");
  }
  const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (error) {
    if (!res.headersSent) res.status(error.status || 500).json({ error: error.status ? error.message : "社区服务暂时不可用，请稍后重试" });
  } };
  function send(member, type, payload) {
    if (member.stream && !member.stream.destroyed) {
      if (member.stream.writableLength > 256 * 1024) { remove(member.peerId); return; }
      member.stream.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
    } else {
      if (member.queue.length >= 128) { remove(member.peerId); return; }
      member.queue.push({ type, payload });
    }
  }
  function broadcast(roomId) {
    const list = roomList();
    for (const member of [...members.values()]) if (member.roomId === roomId) send(member, "members", list.find(r => r.id === roomId));
  }
  function remove(peerId) {
    const member = members.get(peerId);
    if (!member) return;
    members.delete(peerId);
    member.stream?.end();
    broadcast(member.roomId);
  }
  function ownMember(req, session) {
    const peerId = req.body?.peerId || req.query.peer;
    const member = members.get(peerId);
    if (!member || member.userId !== session.user_id || member.sessionHash !== session.token_hash) throw fail(409, "你已离开频道，请重新加入");
    return member;
  }
  function makeSession(userId, req, res) {
    const token = randomBytes(32).toString("base64url");
    const csrf = randomBytes(24).toString("base64url");
    db.prepare("DELETE FROM voice_sessions WHERE expires_at<=?").run(now());
    db.prepare("INSERT INTO voice_sessions VALUES(?,?,?,?)").run(digest(token), userId, csrf, now() + SESSION_MS);
    db.prepare("DELETE FROM voice_sessions WHERE user_id=? AND token_hash NOT IN (SELECT token_hash FROM voice_sessions WHERE user_id=? ORDER BY expires_at DESC LIMIT 5)").run(userId, userId);
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: "strict", secure: req.secure, maxAge: SESSION_MS, path: "/api/voice" });
    return { user: publicUser(userById(userId)), csrf };
  }
  async function passwordKey(password, salt) {
    if (hashing >= 2) throw fail(503, "正在处理其他登录，请稍后重试");
    hashing++;
    try { return await derive(password, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }); }
    finally { hashing--; }
  }

  router.use((req, res, next) => {
    res.set({ "Cache-Control": "no-store", "CDN-Cache-Control": "no-store" });
    if (!req.secure && !isLoopbackHost(req.get("host"))) return res.status(426).json({ error: "社区账号和语音需要使用 HTTPS" });
    next();
  });
  router.get("/session", wrap((req, res) => {
    const session = getSession(req);
    res.json(session ? { user: publicUser(userById(session.user_id)), csrf: session.csrf } : { user: null });
  }));
  router.post("/register", wrap(async (req, res) => {
    writeGuard(req);
    limit(`register:${req.ip}`, 5, 3600_000); limit("register:global", 100, 86400_000);
    const { username, password } = validateVoiceCredentials(req.body);
    if (db.prepare("SELECT COUNT(*) AS n FROM voice_users").get().n >= 5000) throw fail(503, "暂时停止新账号注册");
    if (db.prepare("SELECT 1 FROM voice_users WHERE username=?").get(username)) throw fail(409, "这个用户名已被使用");
    const salt = randomBytes(16).toString("hex");
    const hash = await passwordKey(password, salt);
    const id = randomUUID();
    try { db.prepare("INSERT INTO voice_users(id, username, password_hash, display_name, created_at) VALUES(?,?,?,?,?)").run(id, username, `scrypt-v1:${salt}:${hash.toString("hex")}`, username, now()); }
    catch (error) { if (String(error.message).includes("UNIQUE")) throw fail(409, "这个用户名已被使用"); throw error; }
    res.status(201).json(makeSession(id, req, res));
  }));
  router.post("/login", wrap(async (req, res) => {
    writeGuard(req);
    limit(`login:${req.ip}`, 20, 15 * 60_000); limit("login:global", 240, 15 * 60_000);
    const { username, password } = validateVoiceCredentials(req.body);
    limit(`account:${username}`, 15, 15 * 60_000);
    const user = db.prepare("SELECT id, password_hash FROM voice_users WHERE username=?").get(username);
    const [, salt, expected] = (user?.password_hash || `scrypt-v1:00000000000000000000000000000000:${"0".repeat(64)}`).split(":");
    const key = await passwordKey(password, salt);
    if (!user || !equal(key.toString("hex"), expected)) throw fail(401, "用户名或密码不正确");
    res.json(makeSession(user.id, req, res));
  }));
  router.post("/logout", wrap((req, res) => {
    const session = requireSession(req); writeGuard(req, session);
    for (const member of [...members.values()]) if (member.sessionHash === session.token_hash) remove(member.peerId);
    db.prepare("DELETE FROM voice_sessions WHERE token_hash=?").run(session.token_hash);
    res.clearCookie(COOKIE, { httpOnly: true, sameSite: "strict", secure: req.secure, path: "/api/voice" });
    res.status(204).end();
  }));
  router.patch("/profile", wrap(async (req, res) => {
    const session = requireSession(req); writeGuard(req, session);
    limit(`profile:${session.user_id}`, 20, 60_000);
    const displayName = clean(req.body.displayName, 32);
    const bio = clean(req.body.bio, 180);
    const theme = req.body.theme;
    if (!displayName || !THEMES.includes(theme)) throw fail(400, "请填写昵称并选择一种面板配色");
    let avatar;
    if (req.body.avatar === null) avatar = null;
    else if (req.body.avatar !== undefined) {
      const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(req.body.avatar);
      if (!match || match[2].length > 280000) throw fail(400, "头像需为不超过 200 KB 的图片");
      try {
        const image = sharp(Buffer.from(match[2], "base64"), { limitInputPixels: 1024 * 1024, animated: false });
        const metadata = await image.metadata();
        if (!["jpeg", "png", "webp"].includes(metadata.format)) throw new Error("raster images only");
        avatar = await image.rotate().resize(256, 256, { fit: "cover" }).webp({ quality: 82 }).toBuffer();
      } catch { throw fail(400, "无法读取这张头像，请选择 JPG、PNG 或 WebP 图片"); }
    }
    db.prepare("UPDATE voice_users SET display_name=?, bio=?, theme=? WHERE id=?").run(displayName, bio, theme, session.user_id);
    if (avatar !== undefined) db.prepare("UPDATE voice_users SET avatar=?, avatar_version=? WHERE id=?").run(avatar, avatar ? now() : 0, session.user_id);
    for (const member of members.values()) if (member.userId === session.user_id) broadcast(member.roomId);
    res.json({ user: publicUser(userById(session.user_id)) });
  }));
  router.get("/avatar/:id", wrap((req, res) => {
    requireSession(req);
    const user = db.prepare("SELECT avatar FROM voice_users WHERE id=?").get(req.params.id);
    if (!user?.avatar) throw fail(404, "头像不存在");
    res.type("image/webp").set("Cache-Control", "private, max-age=300").send(Buffer.from(user.avatar));
  }));
  router.get("/rooms", wrap((req, res) => { requireSession(req); res.json({ rooms: roomList() }); }));
  router.post("/join", wrap((req, res) => {
    const session = requireSession(req); writeGuard(req, session); limit(`join:${session.user_id}`, 15, 60_000);
    const roomId = req.body.roomId;
    if (!VOICE_ROOMS.some(room => room.id === roomId)) throw fail(404, "频道不存在");
    const roomMembers = [...members.values()].filter(m => m.roomId === roomId && m.userId !== session.user_id);
    if (roomMembers.length >= 6) throw fail(409, "频道已满（最多 6 人），试试其他频道");
    for (const member of [...members.values()]) if (member.userId === session.user_id) remove(member.peerId);
    const member = { peerId: randomUUID(), userId: session.user_id, sessionHash: session.token_hash, roomId, order: ++joinOrder,
      muted: false, deafened: false, lastSeen: now(), stream: null, queue: [] };
    members.set(member.peerId, member);
    broadcast(roomId);
    res.json({ peerId: member.peerId, roomId, order: member.order, peers: roomMembers.map(serialize),
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }], relayAvailable: false, iceTransportPolicy: "all" });
  }));
  router.get("/events", wrap((req, res) => {
    const session = requireSession(req); const member = ownMember(req, session);
    limit(`events:${session.user_id}`, 20, 60_000);
    const previous = member.stream;
    member.stream = res;
    previous?.end();
    member.lastSeen = now();
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    res.write(": connected\n\n");
    for (const event of member.queue.splice(0)) send(member, event.type, event.payload);
    send(member, "members", roomList().find(room => room.id === member.roomId));
    res.on("close", () => { if (member.stream === res) { member.stream = null; member.lastSeen = now() - 30_000; } });
  }));
  router.post("/signal", wrap((req, res) => {
    const session = requireSession(req); writeGuard(req, session); const member = ownMember(req, session);
    limit(`signal:${member.peerId}`, 600, 60_000);
    const target = members.get(req.body.target);
    if (!target || target.roomId !== member.roomId || target.peerId === member.peerId) throw fail(409, "对方已离开频道");
    const { description, candidate } = req.body;
    let signal;
    if (description && ["offer", "answer"].includes(description.type) && typeof description.sdp === "string" && description.sdp.length <= 40000) {
      signal = { description: { type: description.type, sdp: description.sdp } };
    } else if (candidate && typeof candidate.candidate === "string" && candidate.candidate.length <= 2048) {
      signal = { candidate: { candidate: candidate.candidate, sdpMid: String(candidate.sdpMid || "").slice(0, 32), sdpMLineIndex: Number(candidate.sdpMLineIndex) || 0,
        ...(candidate.usernameFragment ? { usernameFragment: String(candidate.usernameFragment).slice(0, 256) } : {}) } };
    } else throw fail(400, "无效的语音协商消息");
    send(target, "signal", { from: member.peerId, order: member.order, ...signal });
    res.status(204).end();
  }));
  router.post("/heartbeat", wrap((req, res) => {
    const session = requireSession(req); writeGuard(req, session); const member = ownMember(req, session);
    limit(`heartbeat:${member.peerId}`, 60, 60_000);
    member.lastSeen = now();
    const muted = Boolean(req.body.muted), deafened = Boolean(req.body.deafened);
    if (member.muted !== muted || member.deafened !== deafened) { member.muted = muted; member.deafened = deafened; broadcast(member.roomId); }
    res.json({ rooms: roomList() });
  }));
  router.post("/leave", wrap((req, res) => {
    const session = requireSession(req); writeGuard(req, session);
    const member = members.get(req.body.peerId);
    if (member && member.userId === session.user_id && member.sessionHash === session.token_hash) remove(member.peerId);
    res.status(204).end();
  }));
  function sweep() {
    for (const member of [...members.values()]) {
      if (member.lastSeen < now() - 50_000 || !db.prepare("SELECT 1 FROM voice_sessions WHERE token_hash=? AND expires_at>?").get(member.sessionHash, now())) remove(member.peerId);
      else if (member.stream) member.stream.write(": heartbeat\n\n");
    }
  }
  const interval = setInterval(sweep, 15_000); interval.unref();
  router.use((_req, res) => res.status(404).json({ error: "社区接口不存在" }));
  return { router, db, sweep, close() { clearInterval(interval); for (const member of [...members.values()]) remove(member.peerId); db.close(); } };
}
