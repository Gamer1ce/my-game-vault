import express from "express";
import multer from "multer";
import ExcelJS from "exceljs";
import { DatabaseSync } from "node:sqlite";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CredentialStore } from "./src/credential-store.mjs";
import { normalizeRows, parseJsonRows } from "./src/importer.mjs";
import { createPlaystationConnector } from "./src/platforms/playstation.mjs";
import { createXboxConnector } from "./src/platforms/xbox.mjs";
import { createNintendoConnector } from "./src/platforms/nintendo.mjs";
import { createSteamConnector } from "./src/platforms/steam.mjs";
import { createMetacriticConnector } from "./src/metacritic.mjs";
import { providers } from "./src/providers.mjs";
import { activityDate, cumulativeDelta, groupActivityRows, groupRecentActivity, monthEnd, recentDateRange, reconciledLifetimeMinutes, shanghaiDate } from "./src/activity.mjs";
import { isLoopbackHost, isSameOriginWrite, parseCookies, safeEqual } from "./src/security.mjs";
import { listHighlights, resolveHighlightsDirectory, supportedHighlightFormats } from "./src/highlights.mjs";
import { createSyncRunner } from "./src/sync-runner.mjs";
import { createRemoteMediaService, mergeRemoteHighlights } from "./src/remote-media.mjs";
import { createBaiduStreamService } from "./src/baidu-stream.mjs";
import { configureOutboundProxy } from "./src/network.mjs";
import { birthdayTicketFor } from "./src/birthday-easter-egg.mjs";
import {
  calibratedFinalMinutes,
  matchPlaystationCalibrationRecord,
  parsePlaystationGameplayWorkbook,
  playstationCalibrationFingerprint,
  playstationTitleKey
} from "./src/playstation-calibration.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const outboundProxy = configureOutboundProxy();
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, "data");
mkdirSync(dataDir, { recursive: true });
const defaultHighlightsDir = path.join(dataDir, "highlights");
mkdirSync(defaultHighlightsDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, "games.db"));
const credentials = new CredentialStore(dataDir);
const remoteMedia = createRemoteMediaService({ dataDirectory: dataDir });
const baiduStream = createBaiduStreamService({ dataDirectory: dataDir });
const playstation = createPlaystationConnector();
const xbox = createXboxConnector();
const nintendo = createNintendoConnector();
const steam = createSteamConnector();
const metacritic = createMetacriticConnector();
const port = Number(process.env.PORT || 4173);
const publicMode = process.env.PUBLIC_MODE === "1" || existsSync(path.join(dataDir, "public-mode"));

function adminAccess() {
  if (!publicMode) return null;
  const envPassword = String(process.env.ADMIN_PASSWORD || "").trim();
  const envUsername = String(process.env.ADMIN_USERNAME || "admin").trim();
  if (envPassword) {
    if (envUsername.length < 1 || envUsername.length > 64 || envPassword.length < 16 || envPassword.length > 512) {
      throw new Error("ADMIN_USERNAME 或 ADMIN_PASSWORD 格式无效；密码至少需要 16 位");
    }
    return { username: envUsername, password: envPassword, source: "environment" };
  }
  const accessPath = path.join(dataDir, "admin-access.json");
  if (existsSync(accessPath)) {
    const saved = JSON.parse(readFileSync(accessPath, "utf8"));
    if (saved.username && saved.password) return { ...saved, source: "file" };
    throw new Error(`管理凭据文件格式无效：${accessPath}`);
  }

  const created = { username: "admin", password: randomBytes(18).toString("base64url") };
  writeFileSync(accessPath, `${JSON.stringify(created, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return created;
}

const admin = adminAccess();
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL CHECK(platform IN ('xbox', 'playstation', 'nintendo', 'steam')),
    title TEXT NOT NULL,
    minutes INTEGER NOT NULL DEFAULT 0 CHECK(minutes >= 0),
    platform_minutes INTEGER CHECK(platform_minutes >= 0),
    calibrated_minutes INTEGER CHECK(calibrated_minutes >= 0),
    calibration_platform_minutes INTEGER CHECK(calibration_platform_minutes >= 0),
    calibrated_at TEXT,
    calibrated_title TEXT,
    last_played TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    external_id TEXT,
    platform_id TEXT,
    concept_id TEXT,
    product_id TEXT,
    entitlement_id TEXT,
    library_status TEXT,
    time_status TEXT NOT NULL DEFAULT 'known' CHECK(time_status IN ('known', 'unknown')),
    cover_url TEXT,
    store_url TEXT,
    metacritic_score INTEGER,
    score_url TEXT,
    metacritic_checked_at TEXT,
    achievements_earned INTEGER,
    achievements_total INTEGER,
    achievements_updated_at TEXT,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX IF NOT EXISTS games_platform_external
    ON games(platform, external_id) WHERE external_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS games_platform_title
    ON games(platform, title COLLATE NOCASE) WHERE external_id IS NULL;
  CREATE TABLE IF NOT EXISTS daily_activity (
    date TEXT NOT NULL,
    platform TEXT NOT NULL CHECK(platform IN ('xbox', 'playstation', 'nintendo', 'steam')),
    game_key TEXT NOT NULL,
    external_id TEXT,
    title TEXT NOT NULL,
    minutes INTEGER NOT NULL DEFAULT 0 CHECK(minutes >= 0),
    precision TEXT NOT NULL DEFAULT 'detected' CHECK(precision IN ('exact', 'detected')),
    cover_url TEXT,
    store_url TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(date, platform, game_key)
  );
  CREATE TABLE IF NOT EXISTS play_events (
    date TEXT NOT NULL,
    platform TEXT NOT NULL CHECK(platform IN ('xbox', 'playstation', 'nintendo', 'steam')),
    game_key TEXT NOT NULL,
    external_id TEXT,
    title TEXT NOT NULL,
    cover_url TEXT,
    store_url TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(date, platform, game_key)
  );
  CREATE TABLE IF NOT EXISTS platform_stats (
    platform TEXT PRIMARY KEY CHECK(platform IN ('xbox', 'playstation', 'nintendo', 'steam')),
    achievements_earned INTEGER NOT NULL DEFAULT 0,
    completed_games INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS nintendo_history_state (
    title_id TEXT PRIMARY KEY,
    revision TEXT NOT NULL,
    total_played_days INTEGER NOT NULL DEFAULT 0,
    synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS playstation_title_aliases (
    alias_key TEXT PRIMARY KEY,
    alias_title TEXT NOT NULL,
    platform_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS playstation_calibration_state (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    fingerprint TEXT NOT NULL UNIQUE,
    calibrated_at TEXT NOT NULL,
    result_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS guestbook_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS feedback_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS site_counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0 CHECK(value >= 0),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  INSERT OR IGNORE INTO site_counters(name, value) VALUES ('likes', 0);
`);

const gamesTableSql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'games'").get()?.sql || "");
if (!gamesTableSql.includes("'steam'")) {
  db.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE games RENAME TO games_legacy;
    CREATE TABLE games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL CHECK(platform IN ('xbox', 'playstation', 'nintendo', 'steam')),
      title TEXT NOT NULL,
      minutes INTEGER NOT NULL DEFAULT 0 CHECK(minutes >= 0),
      last_played TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      external_id TEXT,
      cover_url TEXT,
      store_url TEXT,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO games(id, platform, title, minutes, last_played, source, external_id, notes, created_at, updated_at)
      SELECT id, platform, title, minutes, last_played, source, external_id, notes, created_at, updated_at FROM games_legacy;
    DROP TABLE games_legacy;
    CREATE UNIQUE INDEX games_platform_external ON games(platform, external_id) WHERE external_id IS NOT NULL;
    CREATE UNIQUE INDEX games_platform_title ON games(platform, title COLLATE NOCASE) WHERE external_id IS NULL;
    COMMIT;
  `);
}

const gameColumns = db.prepare("PRAGMA table_info(games)").all().map((column) => column.name);
if (!gameColumns.includes("cover_url")) db.exec("ALTER TABLE games ADD COLUMN cover_url TEXT");
if (!gameColumns.includes("store_url")) db.exec("ALTER TABLE games ADD COLUMN store_url TEXT");
if (!gameColumns.includes("metacritic_score")) db.exec("ALTER TABLE games ADD COLUMN metacritic_score INTEGER");
if (!gameColumns.includes("score_url")) db.exec("ALTER TABLE games ADD COLUMN score_url TEXT");
if (!gameColumns.includes("metacritic_checked_at")) db.exec("ALTER TABLE games ADD COLUMN metacritic_checked_at TEXT");
if (!gameColumns.includes("achievements_earned")) db.exec("ALTER TABLE games ADD COLUMN achievements_earned INTEGER");
if (!gameColumns.includes("achievements_total")) db.exec("ALTER TABLE games ADD COLUMN achievements_total INTEGER");
if (!gameColumns.includes("achievements_updated_at")) db.exec("ALTER TABLE games ADD COLUMN achievements_updated_at TEXT");
if (!gameColumns.includes("platform_minutes")) db.exec("ALTER TABLE games ADD COLUMN platform_minutes INTEGER CHECK(platform_minutes >= 0)");
if (!gameColumns.includes("calibrated_minutes")) db.exec("ALTER TABLE games ADD COLUMN calibrated_minutes INTEGER CHECK(calibrated_minutes >= 0)");
if (!gameColumns.includes("calibration_platform_minutes")) db.exec("ALTER TABLE games ADD COLUMN calibration_platform_minutes INTEGER CHECK(calibration_platform_minutes >= 0)");
if (!gameColumns.includes("calibrated_at")) db.exec("ALTER TABLE games ADD COLUMN calibrated_at TEXT");
if (!gameColumns.includes("calibrated_title")) db.exec("ALTER TABLE games ADD COLUMN calibrated_title TEXT");
if (!gameColumns.includes("platform_id")) db.exec("ALTER TABLE games ADD COLUMN platform_id TEXT");
if (!gameColumns.includes("concept_id")) db.exec("ALTER TABLE games ADD COLUMN concept_id TEXT");
if (!gameColumns.includes("product_id")) db.exec("ALTER TABLE games ADD COLUMN product_id TEXT");
if (!gameColumns.includes("entitlement_id")) db.exec("ALTER TABLE games ADD COLUMN entitlement_id TEXT");
if (!gameColumns.includes("library_status")) db.exec("ALTER TABLE games ADD COLUMN library_status TEXT");
if (!gameColumns.includes("time_status")) db.exec("ALTER TABLE games ADD COLUMN time_status TEXT NOT NULL DEFAULT 'known'");
db.exec(`
  UPDATE games SET platform_id = external_id WHERE platform_id IS NULL AND external_id IS NOT NULL;
  UPDATE games SET platform_minutes = minutes WHERE platform_minutes IS NULL AND external_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS games_platform_platform_id
    ON games(platform, platform_id) WHERE platform_id IS NOT NULL;
`);
const activityColumns = db.prepare("PRAGMA table_info(daily_activity)").all().map((column) => column.name);
if (!activityColumns.includes("store_url")) db.exec("ALTER TABLE daily_activity ADD COLUMN store_url TEXT");
if (!activityColumns.includes("precision")) {
  db.exec("ALTER TABLE daily_activity ADD COLUMN precision TEXT NOT NULL DEFAULT 'detected'");
  db.exec("UPDATE daily_activity SET precision = 'exact' WHERE platform = 'nintendo'");
}

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);
const adminSessions = new Map();
const loginAttempts = new Map();
const sessionLifetime = 8 * 60 * 60 * 1000;
const loginWindow = 15 * 60 * 1000;
const loginLimit = 8;
const visitorWriteAttempts = new Map();
const visitorWritePaths = new Set(["/api/guestbook", "/api/likes", "/api/feedback"]);

function visitorKey(req, action) {
  return `${action}:${req.ip || req.socket.remoteAddress || "unknown"}`;
}

function visitorWriteAllowed(req, action, { limit, windowMs }) {
  const key = visitorKey(req, action);
  const now = Date.now();
  const recent = (visitorWriteAttempts.get(key) || []).filter((time) => time > now - windowMs);
  if (recent.length >= limit) return false;
  recent.push(now);
  visitorWriteAttempts.set(key, recent);
  return true;
}

function cleanGuestText(value, maximum) {
  return String(value || "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function adminAuthenticated(req) {
  if (!admin) return true;
  const token = parseCookies(req.get("cookie")).mgv_admin;
  const expiresAt = token ? adminSessions.get(token) : null;
  if (!expiresAt || expiresAt <= Date.now()) {
    if (token) adminSessions.delete(token);
    return false;
  }
  return true;
}

function sameOrigin(req) {
  return isSameOriginWrite({
    origin: req.get("origin"),
    host: req.get("host"),
    protocol: req.protocol,
    fetchSite: req.get("sec-fetch-site")
  });
}

function adminTransportAllowed(req) {
  return !admin || req.secure || isLoopbackHost(req.get("host"));
}

function setSecurityHeaders(_req, res, next) {
  const remoteMediaSource = remoteMedia.allowedMediaSource();
  const baiduMediaSources = baiduStream.allowedMediaSources();
  const mediaSources = ["'self'", "blob:", remoteMediaSource, ...baiduMediaSources].filter(Boolean).join(" ");
  const connectSources = ["'self'", ...baiduMediaSources].filter(Boolean).join(" ");
  res.set({
    "Content-Security-Policy": `default-src 'self'; img-src 'self' https: data:; media-src ${mediaSources}; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src ${connectSources}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
  });
  if (_req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
  next();
}

app.use(setSecurityHeaders);
app.use(express.json({ limit: "1mb" }));
app.get("/api/security", (req, res) => res.json({
  publicMode,
  canManage: adminAuthenticated(req),
  adminAvailable: adminTransportAllowed(req)
}));

app.post("/api/admin/session", (req, res) => {
  if (!admin) return res.json({ publicMode, canManage: true, adminAvailable: true });
  if (!sameOrigin(req)) return res.status(403).json({ error: "已拒绝跨站管理请求" });
  if (!adminTransportAllowed(req)) {
    res.set("Upgrade", "TLS/1.2");
    return res.status(426).json({ error: "公网管理员登录必须使用 HTTPS；当前请从本机 http://localhost:4173 管理" });
  }
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const recent = (loginAttempts.get(key) || []).filter((time) => time > Date.now() - loginWindow);
  if (recent.length >= loginLimit) {
    res.set("Retry-After", String(Math.ceil((recent[0] + loginWindow - Date.now()) / 1000)));
    return res.status(429).json({ error: "登录尝试过多，请 15 分钟后再试" });
  }
  const username = String(req.body?.username || "");
  const password = String(req.body?.password || "");
  if (!safeEqual(username, admin.username) || !safeEqual(password, admin.password)) {
    recent.push(Date.now());
    loginAttempts.set(key, recent);
    return res.status(401).json({ error: "管理员账号或密码不正确" });
  }
  loginAttempts.delete(key);
  const token = randomBytes(32).toString("base64url");
  adminSessions.set(token, Date.now() + sessionLifetime);
  const secure = req.secure ? "; Secure" : "";
  res.set("Set-Cookie", `mgv_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionLifetime / 1000}${secure}`);
  return res.json({ publicMode, canManage: true, adminAvailable: true });
});

app.use((req, res, next) => {
  if (!admin || !req.path.startsWith("/api/") || ["GET", "HEAD", "OPTIONS"].includes(req.method) || (req.method === "POST" && (req.path === "/api/admin/session" || visitorWritePaths.has(req.path)))) return next();
  if (!sameOrigin(req)) return res.status(403).json({ error: "已拒绝跨站管理请求" });
  if (!adminAuthenticated(req)) return res.status(401).json({ error: "需要先解锁管理员模式" });
  next();
});

app.delete("/api/admin/session", (req, res) => {
  const token = parseCookies(req.get("cookie")).mgv_admin;
  if (token) adminSessions.delete(token);
  res.set("Set-Cookie", "mgv_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
  res.status(204).end();
});
app.get("/media/highlights/:filename", (req, res) => {
  const filename = String(req.params.filename || "");
  if (!filename || filename.startsWith(".") || path.basename(filename) !== filename || !supportedHighlightFormats.includes(path.extname(filename).toLowerCase())) return res.status(404).end();
  try {
    const { directory } = resolveHighlightsDirectory(dataDir);
    const realDirectory = realpathSync(directory);
    const file = path.join(realDirectory, filename);
    const stats = lstatSync(file);
    if (!stats.isFile() || stats.isSymbolicLink()) return res.status(404).end();
    res.set({
      "Content-Disposition": "inline",
      "Cross-Origin-Resource-Policy": "same-origin"
    });
    return res.sendFile(filename, { root: realDirectory, dotfiles: "deny", maxAge: "5m" }, (error) => {
      if (!error) return;
      if (error.code === "ECONNABORTED" || error.code === "EPIPE" || res.headersSent) return;
      return res.status(error.statusCode || 404).end();
    });
  } catch {
    return res.status(404).end();
  }
});
app.use(express.static(path.join(root, "public")));

const listGuestbookMessages = db.prepare(`
  SELECT id, nickname, message, created_at AS createdAt
  FROM (
    SELECT id, nickname, message, created_at
    FROM guestbook_messages
    ORDER BY id DESC
    LIMIT 36
  )
  ORDER BY id
`);
const insertGuestbookMessage = db.prepare(`
  INSERT INTO guestbook_messages(nickname, message) VALUES (?, ?)
  RETURNING id, nickname, message, created_at AS createdAt
`);
const trimGuestbookMessages = db.prepare(`
  DELETE FROM guestbook_messages
  WHERE id NOT IN (SELECT id FROM guestbook_messages ORDER BY id DESC LIMIT 500)
`);
const readLikes = db.prepare("SELECT value FROM site_counters WHERE name = 'likes'");
const incrementLikes = db.prepare(`
  UPDATE site_counters
  SET value = value + 1, updated_at = CURRENT_TIMESTAMP
  WHERE name = 'likes'
  RETURNING value
`);
const listFeedbackMessages = db.prepare(`
  SELECT id, nickname, message, created_at AS createdAt
  FROM feedback_messages
  ORDER BY id DESC
  LIMIT 200
`);
const insertFeedbackMessage = db.prepare(`
  INSERT INTO feedback_messages(nickname, message) VALUES (?, ?)
  RETURNING id, nickname, message, created_at AS createdAt
`);
const trimFeedbackMessages = db.prepare(`
  DELETE FROM feedback_messages
  WHERE id NOT IN (SELECT id FROM feedback_messages ORDER BY id DESC LIMIT 1000)
`);

app.get("/api/guestbook", (_req, res) => {
  res.json({
    messages: listGuestbookMessages.all(),
    likes: Number(readLikes.get()?.value || 0)
  });
});

app.post("/api/guestbook", (req, res) => {
  if (!sameOrigin(req)) return res.status(403).json({ error: "已拒绝跨站留言请求" });
  if (!visitorWriteAllowed(req, "guestbook", { limit: 5, windowMs: 10 * 60 * 1000 })) {
    res.set("Retry-After", "600");
    return res.status(429).json({ error: "留言发送得太快了，请稍后再试" });
  }
  if (String(req.body?.website || "").trim()) return res.status(204).end();
  const nickname = cleanGuestText(req.body?.nickname, 16) || "匿名玩家";
  const message = cleanGuestText(req.body?.message, 72);
  if (!message) return res.status(400).json({ error: "请输入留言内容" });
  if (message.length < 2) return res.status(400).json({ error: "留言至少需要 2 个字符" });
  const saved = insertGuestbookMessage.get(nickname, message);
  trimGuestbookMessages.run();
  return res.status(201).json({
    message: saved,
    birthdayTicket: birthdayTicketFor(message, saved.id)
  });
});

app.post("/api/likes", (req, res) => {
  if (!sameOrigin(req)) return res.status(403).json({ error: "已拒绝跨站点赞请求" });
  if (!visitorWriteAllowed(req, "likes", { limit: 300, windowMs: 60 * 1000 })) {
    res.set("Retry-After", "60");
    return res.status(429).json({ error: "点赞速度太快了，休息一下再继续" });
  }
  const result = incrementLikes.get();
  return res.json({ likes: Number(result?.value || 0) });
});

app.get("/api/feedback", (req, res) => {
  if (!adminAuthenticated(req)) return res.status(401).json({ error: "需要先解锁管理员模式" });
  return res.json({ feedback: listFeedbackMessages.all() });
});

app.post("/api/feedback", (req, res) => {
  if (!sameOrigin(req)) return res.status(403).json({ error: "已拒绝跨站反馈请求" });
  if (!visitorWriteAllowed(req, "feedback", { limit: 3, windowMs: 30 * 60 * 1000 })) {
    res.set("Retry-After", "1800");
    return res.status(429).json({ error: "反馈发送得太快了，请稍后再试" });
  }
  if (String(req.body?.website || "").trim()) return res.status(204).end();
  const nickname = cleanGuestText(req.body?.nickname, 16) || "匿名玩家";
  const message = cleanGuestText(req.body?.message, 600);
  if (!message) return res.status(400).json({ error: "请输入建议或反馈" });
  if (message.length < 4) return res.status(400).json({ error: "反馈至少需要 4 个字符" });
  const saved = insertFeedbackMessage.get(nickname, message);
  trimFeedbackMessages.run();
  return res.status(201).json({ feedback: saved });
});

const listGames = db.prepare(`
  SELECT id, platform, title, minutes, platform_minutes AS platformMinutes,
         calibrated_minutes AS calibratedMinutes, calibration_platform_minutes AS calibrationPlatformMinutes,
         calibrated_at AS calibratedAt, last_played AS lastPlayed,
         source, external_id AS externalId, platform_id AS platformId, concept_id AS conceptId,
         product_id AS productId, entitlement_id AS entitlementId,
         library_status AS libraryStatus, time_status AS timeStatus,
         cover_url AS coverUrl, store_url AS storeUrl,
         metacritic_score AS metacriticScore, score_url AS scoreUrl,
         achievements_earned AS achievementsEarned, achievements_total AS achievementsTotal,
         notes, updated_at AS updatedAt
  FROM games
  WHERE time_status = 'known' AND minutes > 0
  ORDER BY minutes DESC, title COLLATE NOCASE
`);

const upsertSyncedGame = db.prepare(`
  INSERT INTO games(platform, title, minutes, platform_minutes, last_played, source, external_id, platform_id, concept_id, time_status, cover_url, store_url, achievements_earned, achievements_total, achievements_updated_at, notes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'known', ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END, ?)
  ON CONFLICT DO UPDATE SET
    title = COALESCE(games.calibrated_title, excluded.title),
    platform_minutes = excluded.platform_minutes,
    minutes = CASE
      WHEN games.calibrated_minutes IS NOT NULL AND games.calibration_platform_minutes IS NOT NULL
        THEN games.calibrated_minutes + MAX(0, excluded.platform_minutes - games.calibration_platform_minutes)
      ELSE excluded.platform_minutes
    END,
    last_played = CASE
      WHEN excluded.last_played IS NULL THEN games.last_played
      WHEN games.last_played IS NULL OR excluded.last_played > games.last_played THEN excluded.last_played
      ELSE games.last_played
    END,
    external_id = COALESCE(games.external_id, excluded.external_id),
    platform_id = COALESCE(games.platform_id, excluded.platform_id),
    concept_id = COALESCE(excluded.concept_id, games.concept_id),
    time_status = 'known',
    cover_url = COALESCE(excluded.cover_url, games.cover_url),
    store_url = COALESCE(excluded.store_url, games.store_url),
    achievements_earned = COALESCE(excluded.achievements_earned, games.achievements_earned),
    achievements_total = COALESCE(excluded.achievements_total, games.achievements_total),
    achievements_updated_at = COALESCE(excluded.achievements_updated_at, games.achievements_updated_at),
    source = excluded.source,
    notes = excluded.notes,
    updated_at = CURRENT_TIMESTAMP
`);
const upsertPlaystationLibraryGame = db.prepare(`
  INSERT INTO games(platform, title, minutes, platform_minutes, source, external_id, platform_id,
                    concept_id, product_id, entitlement_id, library_status, time_status,
                    cover_url, store_url, notes)
  VALUES ('playstation', ?, 0, NULL, 'playstation-library', ?, ?, ?, ?, ?, ?, 'unknown', ?, ?, ?)
  ON CONFLICT DO UPDATE SET
    title = CASE WHEN games.time_status = 'unknown' THEN excluded.title ELSE games.title END,
    concept_id = COALESCE(excluded.concept_id, games.concept_id),
    product_id = COALESCE(excluded.product_id, games.product_id),
    entitlement_id = COALESCE(excluded.entitlement_id, games.entitlement_id),
    library_status = excluded.library_status,
    cover_url = COALESCE(excluded.cover_url, games.cover_url),
    store_url = COALESCE(excluded.store_url, games.store_url),
    source = CASE WHEN games.time_status = 'unknown' THEN excluded.source ELSE games.source END,
    notes = CASE WHEN games.time_status = 'unknown' THEN excluded.notes ELSE games.notes END,
    updated_at = CURRENT_TIMESTAMP
`);

const findGameByPlatformId = db.prepare(`
  SELECT minutes, COALESCE(platform_minutes, minutes) AS platformMinutes
  FROM games WHERE platform = ? AND (platform_id = ? OR (platform_id IS NULL AND external_id = ?))
`);
const findGameByTitle = db.prepare("SELECT minutes, COALESCE(platform_minutes, minutes) AS platformMinutes FROM games WHERE platform = ? AND platform_id IS NULL AND external_id IS NULL AND title = ? COLLATE NOCASE");
const xboxAchievementTotals = db.prepare("SELECT external_id AS externalId, achievements_total AS total FROM games WHERE platform = 'xbox' AND external_id IS NOT NULL AND achievements_total > 0");
const upsertDailyActivity = db.prepare(`
  INSERT INTO daily_activity(date, platform, game_key, external_id, title, minutes, precision, cover_url, store_url)
  VALUES (?, ?, ?, ?, ?, ?, 'detected', ?, ?)
  ON CONFLICT(date, platform, game_key) DO UPDATE SET
    title = excluded.title,
    minutes = daily_activity.minutes + excluded.minutes,
    precision = CASE WHEN daily_activity.precision = 'exact' THEN 'exact' ELSE excluded.precision END,
    cover_url = COALESCE(excluded.cover_url, daily_activity.cover_url),
    store_url = COALESCE(excluded.store_url, daily_activity.store_url),
    updated_at = CURRENT_TIMESTAMP
`);
const setDailyActivity = db.prepare(`
  INSERT INTO daily_activity(date, platform, game_key, external_id, title, minutes, precision, cover_url, store_url)
  VALUES (?, ?, ?, ?, ?, ?, 'exact', ?, ?)
  ON CONFLICT(date, platform, game_key) DO UPDATE SET
    title = excluded.title,
    minutes = excluded.minutes,
    precision = 'exact',
    cover_url = COALESCE(excluded.cover_url, daily_activity.cover_url),
    store_url = COALESCE(excluded.store_url, daily_activity.store_url),
    updated_at = CURRENT_TIMESTAMP
`);
const upsertPlayEvent = db.prepare(`
  INSERT INTO play_events(date, platform, game_key, external_id, title, cover_url, store_url)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(date, platform, game_key) DO UPDATE SET
    title = excluded.title,
    cover_url = COALESCE(excluded.cover_url, play_events.cover_url),
    store_url = COALESCE(excluded.store_url, play_events.store_url),
    updated_at = CURRENT_TIMESTAMP
`);
const gamesNeedingScores = db.prepare(`
  SELECT id, platform, title, external_id AS externalId FROM games
  WHERE minutes > 0 AND (metacritic_checked_at IS NULL OR metacritic_checked_at < datetime('now', '-30 days'))
  ORDER BY metacritic_checked_at IS NOT NULL, minutes DESC
`);
const updateMetacriticScore = db.prepare(`
  UPDATE games SET metacritic_score = ?, score_url = ?, metacritic_checked_at = CURRENT_TIMESTAMP WHERE id = ?
`);
const countMetacriticScores = db.prepare("SELECT COUNT(*) AS count FROM games WHERE minutes > 0 AND metacritic_score IS NOT NULL");
const upsertPlatformStats = db.prepare(`
  INSERT INTO platform_stats(platform, achievements_earned, completed_games, updated_at)
  VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(platform) DO UPDATE SET
    achievements_earned = excluded.achievements_earned,
    completed_games = excluded.completed_games,
    updated_at = CURRENT_TIMESTAMP
`);
const listNintendoHistoryState = db.prepare("SELECT title_id AS titleId, revision FROM nintendo_history_state");
const clearNintendoHistoryState = db.prepare("DELETE FROM nintendo_history_state");
const upsertNintendoHistoryState = db.prepare(`
  INSERT INTO nintendo_history_state(title_id, revision, total_played_days, synced_at)
  VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(title_id) DO UPDATE SET
    revision = excluded.revision,
    total_played_days = excluded.total_played_days,
    synced_at = CURRENT_TIMESTAMP
`);
const listNintendoHistoryTotals = db.prepare(`
  SELECT g.id, g.minutes, COALESCE(g.platform_minutes, g.minutes) AS platformMinutes,
         g.last_played AS lastPlayed, SUM(d.minutes) AS historyMinutes, MAX(d.date) AS historyLastPlayed
  FROM games g
  JOIN daily_activity d ON d.platform = 'nintendo' AND d.external_id = g.external_id AND d.precision = 'exact'
  WHERE g.platform = 'nintendo' AND g.external_id IS NOT NULL
  GROUP BY g.id
`);
const updateNintendoHistoryTotal = db.prepare(`
  UPDATE games
  SET minutes = ?, platform_minutes = ?, last_played = ?, updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);

function reconcileNintendoHistoryTotals() {
  const changes = listNintendoHistoryTotals.all().flatMap((row) => {
    const minutes = reconciledLifetimeMinutes(row.platformMinutes, row.historyMinutes);
    const historyLastPlayed = String(row.historyLastPlayed || "");
    const currentLastPlayed = String(row.lastPlayed || "");
    const lastPlayed = historyLastPlayed > currentLastPlayed ? historyLastPlayed : currentLastPlayed || null;
    if (minutes === Number(row.minutes || 0) && lastPlayed === (row.lastPlayed || null)) return [];
    return [{ id: row.id, minutes, lastPlayed, addedMinutes: Math.max(0, minutes - Number(row.minutes || 0)) }];
  });
  if (!changes.length) return { adjustedGames: 0, addedMinutes: 0 };

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const change of changes) updateNintendoHistoryTotal.run(change.minutes, change.minutes, change.lastPlayed, change.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return {
    adjustedGames: changes.length,
    addedMinutes: changes.reduce((sum, change) => sum + change.addedMinutes, 0)
  };
}

const startupNintendoReconciliation = reconcileNintendoHistoryTotals();
if (startupNintendoReconciliation.adjustedGames > 0) {
  console.log(`Nintendo 官方逐日历史已校正 ${startupNintendoReconciliation.adjustedGames} 款游戏，补入 ${startupNintendoReconciliation.addedMinutes} 分钟`);
}
const listPlaystationCalibrationGames = db.prepare(`
  SELECT id, title, minutes, COALESCE(platform_minutes, minutes) AS platformMinutes,
         last_played AS lastPlayed, platform_id AS platformId, external_id AS externalId,
         cover_url AS coverUrl, store_url AS storeUrl
  FROM games
  WHERE platform = 'playstation' AND COALESCE(platform_id, external_id) IS NOT NULL
`);
const listPlaystationAliases = db.prepare("SELECT alias_key AS aliasKey, platform_id AS platformId FROM playstation_title_aliases");
const upsertPlaystationAlias = db.prepare(`
  INSERT INTO playstation_title_aliases(alias_key, alias_title, platform_id, updated_at)
  VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(alias_key) DO UPDATE SET
    alias_title = excluded.alias_title,
    platform_id = excluded.platform_id,
    updated_at = CURRENT_TIMESTAMP
`);
const getPlaystationCalibrationState = db.prepare("SELECT fingerprint, calibrated_at AS calibratedAt, result_json AS resultJson FROM playstation_calibration_state WHERE id = 1");
const savePlaystationCalibrationState = db.prepare(`
  INSERT INTO playstation_calibration_state(id, fingerprint, calibrated_at, result_json)
  VALUES (1, ?, ?, ?)
`);
const calibratePlaystationGame = db.prepare(`
  UPDATE games SET
    platform_minutes = COALESCE(platform_minutes, minutes),
    calibrated_minutes = ?,
    calibration_platform_minutes = COALESCE(platform_minutes, minutes),
    calibrated_at = ?,
    calibrated_title = ?,
    title = ?,
    minutes = ?,
    last_played = CASE
      WHEN ? IS NULL THEN last_played
      WHEN last_played IS NULL OR ? > last_played THEN ?
      ELSE last_played
    END,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);
const deletePlaystationDailyActivity = db.prepare("DELETE FROM daily_activity WHERE platform = 'playstation' AND external_id = ?");
const deletePlaystationPlayEvents = db.prepare("DELETE FROM play_events WHERE platform = 'playstation' AND external_id = ?");

function dashboardStats() {
  const base = db.prepare(`
    SELECT COALESCE(SUM(minutes), 0) AS totalMinutes, COUNT(*) AS gameCount, MAX(updated_at) AS latest
    FROM games WHERE time_status = 'known' AND minutes > 0
  `).get();
  const totals = db.prepare(`SELECT platform, SUM(minutes) AS minutes FROM games WHERE minutes > 0 GROUP BY platform`).all();
  const achievementRows = db.prepare(`
    SELECT platform, COALESCE(SUM(achievements_earned), 0) AS achievementsEarned,
           SUM(CASE WHEN achievements_total > 0 AND achievements_earned >= achievements_total THEN 1 ELSE 0 END) AS completedGames
    FROM games WHERE minutes > 0 GROUP BY platform
  `).all();
  const snapshots = db.prepare(`SELECT platform, achievements_earned AS achievementsEarned, completed_games AS completedGames FROM platform_stats`).all();
  const achievements = new Map(achievementRows.map((row) => [row.platform, row]));
  for (const snapshot of snapshots) achievements.set(snapshot.platform, snapshot);
  const primary = totals.sort((a, b) => Number(b.minutes) - Number(a.minutes))[0]?.platform || null;
  return {
    totalMinutes: Number(base.totalMinutes || 0),
    gameCount: Number(base.gameCount || 0),
    achievementsEarned: [...achievements.values()].reduce((sum, row) => sum + Number(row.achievementsEarned || 0), 0),
    completedGames: [...achievements.values()].reduce((sum, row) => sum + Number(row.completedGames || 0), 0),
    primaryPlatform: primary,
    latest: base.latest ? String(base.latest).slice(0, 10) : null
  };
}

function publicConnection(provider) {
  const connection = credentials.get(provider);
  return connection && !connection.pending ? {
    provider,
    connected: true,
    connectedAt: connection.connectedAt || null,
    lastSyncAt: connection.lastSyncAt || null,
    lastError: connection.lastError || null,
    itemCount: Number(connection.itemCount || 0),
    mode: connection.mode || null
  } : { provider, connected: false, connectedAt: null, lastSyncAt: null, lastError: null, itemCount: 0 };
}

function saveSyncedGames(games, source, { recordDelta = true } = {}) {
  let addedMinutes = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const game of games) {
      const platformId = game.platformId || game.externalId || null;
      const previous = platformId
        ? findGameByPlatformId.get(game.platform, platformId, platformId)
        : findGameByTitle.get(game.platform, game.title);
      const platformMinutes = game.platform === "nintendo"
        ? reconciledLifetimeMinutes(game.minutes, previous?.platformMinutes)
        : game.minutes;
      const delta = cumulativeDelta(previous?.platformMinutes, platformMinutes);
      const gameKey = platformId || String(game.title).trim().toLocaleLowerCase("zh-CN");
      if (recordDelta && delta > 0) {
        upsertDailyActivity.run(activityDate(game.lastPlayed), game.platform, gameKey, platformId, game.title, delta, game.coverUrl || null, game.storeUrl || null);
        addedMinutes += delta;
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(game.lastPlayed || "")) {
        upsertPlayEvent.run(game.lastPlayed, game.platform, gameKey, platformId, game.title, game.coverUrl || null, game.storeUrl || null);
      }
      const achievementMarker = game.achievementsTotal === null || game.achievementsTotal === undefined ? null : Number(game.achievementsTotal);
      upsertSyncedGame.run(game.platform, game.title, platformMinutes, platformMinutes, game.lastPlayed || null, source, platformId, platformId, game.conceptId || null, game.coverUrl || null, game.storeUrl || null,
        game.achievementsEarned ?? null, game.achievementsTotal ?? null, achievementMarker, game.notes || "");
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return addedMinutes;
}

function savePlaystationLibraryGames(games) {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const game of games) {
      const platformId = game.platformId || game.externalId;
      if (!platformId) continue;
      upsertPlaystationLibraryGame.run(
        game.title,
        platformId,
        platformId,
        game.conceptId || null,
        game.productId || null,
        game.entitlementId || null,
        game.libraryStatus || "inactive",
        game.coverUrl || null,
        game.storeUrl || null,
        game.notes || "PlayStation 游戏库"
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function responseError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function calibratePlaystationFromGameplay(records, parseErrors = []) {
  const fingerprint = playstationCalibrationFingerprint(records);
  const existingState = getPlaystationCalibrationState.get();
  if (existingState) {
    if (existingState.fingerprint !== fingerprint) {
      throw responseError("PlayStation 已完成一次性 Excel 校准；不能再导入另一份校准文件", 409);
    }
    return { ...JSON.parse(existingState.resultJson), duplicate: true };
  }

  const games = listPlaystationCalibrationGames.all();
  const aliases = new Map(listPlaystationAliases.all().map((row) => [String(row.aliasKey), String(row.platformId)]));
  const assignedPlatformIds = new Set();
  const matched = [];
  const unmatched = [];
  for (const record of records) {
    const match = matchPlaystationCalibrationRecord(record, games, aliases);
    const platformId = match ? String(match.game.platformId || match.game.externalId || "") : "";
    if (!match || !platformId || assignedPlatformIds.has(platformId)) {
      unmatched.push({ title: record.title, reason: match ? "多个 Excel 标题匹配到同一个 PlayStation 游戏" : "没有找到可确认的 PlayStation titleId 匹配" });
      continue;
    }
    assignedPlatformIds.add(platformId);
    matched.push({ record, match, platformId });
  }
  if (!matched.length) throw responseError("Gameplay Online 中的游戏均未能匹配现有 PlayStation titleId，未执行校准");

  const calibratedAt = new Date().toISOString();
  const result = {
    imported: matched.length,
    skipped: unmatched.length + parseErrors.length,
    calibratedAt,
    duplicate: false,
    historyRows: matched.reduce((sum, item) => sum + item.record.history.length, 0),
    errors: [...unmatched, ...parseErrors].slice(0, 50),
    matches: matched.map(({ record, match, platformId }) => ({
      excelTitle: record.title,
      title: match.game.title,
      platformId,
      calibratedMinutes: record.minutes,
      calibrationPlatformMinutes: Number(match.game.platformMinutes || 0),
      method: match.method
    }))
  };

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const { record, match, platformId } of matched) {
      const game = match.game;
      const finalMinutes = calibratedFinalMinutes(game.platformMinutes, record.minutes, game.platformMinutes);
      calibratePlaystationGame.run(
        record.minutes,
        calibratedAt,
        record.title,
        record.title,
        finalMinutes,
        record.lastPlayed || null,
        record.lastPlayed || null,
        record.lastPlayed || null,
        game.id
      );
      upsertPlaystationAlias.run(playstationTitleKey(record.title), record.title, platformId);
      deletePlaystationDailyActivity.run(platformId);
      deletePlaystationPlayEvents.run(platformId);
      for (const history of record.history) {
        if (history.minutes > 0) {
          setDailyActivity.run(history.date, "playstation", platformId, platformId, record.title, history.minutes, game.coverUrl || null, game.storeUrl || null);
        }
        upsertPlayEvent.run(history.date, "playstation", platformId, platformId, record.title, game.coverUrl || null, game.storeUrl || null);
      }
    }
    savePlaystationCalibrationState.run(fingerprint, calibratedAt, JSON.stringify(result));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return result;
}

db.exec(`
  INSERT OR IGNORE INTO play_events(date, platform, game_key, external_id, title, cover_url, store_url)
  SELECT last_played, platform, COALESCE(external_id, lower(trim(title))), external_id, title, cover_url, store_url
  FROM games WHERE last_played GLOB '????-??-??' AND minutes > 0
`);

async function syncPlaystation() {
  let connection = credentials.get("playstation");
  if (!connection) throw new Error("PlayStation 尚未连接");
  try {
    if (!connection.accessToken || Number(connection.accessExpiresAt || 0) <= Date.now() + 5 * 60 * 1000) {
      const refreshed = await playstation.refresh(connection.refreshToken);
      connection = {
        ...connection,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken || connection.refreshToken,
        accessExpiresAt: Date.now() + Number(refreshed.expiresIn || 3600) * 1000
      };
      credentials.set("playstation", connection);
    }
    const snapshot = await playstation.fetchSnapshot(connection.accessToken);
    const games = snapshot.games;
    saveSyncedGames(games, "playstation-sync");
    savePlaystationLibraryGames(snapshot.libraryGames || []);
    if (snapshot.achievementSummary) {
      upsertPlatformStats.run("playstation", snapshot.achievementSummary.achievementsEarned, snapshot.achievementSummary.completedGames);
    }
    const itemCount = new Set([...games, ...(snapshot.libraryGames || [])].map((game) => game.externalId)).size;
    connection = { ...connection, lastSyncAt: new Date().toISOString(), lastError: snapshot.libraryError || null, itemCount };
    credentials.set("playstation", connection);
    return { synced: games.length, librarySynced: Number(snapshot.libraryGames?.length || 0), connection: publicConnection("playstation") };
  } catch (error) {
    credentials.set("playstation", { ...connection, lastError: error.message || "同步失败" });
    throw error;
  }
}

async function syncXbox() {
  let connection = credentials.get("xbox");
  if (!connection || connection.pending) throw new Error("Xbox 尚未连接");
  try {
    const knownAchievementTotals = new Map(xboxAchievementTotals.all().map((row) => [String(row.externalId), Number(row.total)]));
    const games = await xbox.fetchGames(connection, { knownAchievementTotals });
    saveSyncedGames(games, "xbox-sync");
    connection = { ...connection, lastSyncAt: new Date().toISOString(), lastError: null, itemCount: games.length };
    credentials.set("xbox", connection);
    return { synced: games.length, connection: publicConnection("xbox") };
  } catch (error) {
    credentials.set("xbox", { ...connection, lastError: error.message || "同步失败" });
    throw error;
  }
}

async function syncNintendo() {
  let connection = credentials.get("nintendo");
  if (!connection || connection.pending) throw new Error("Nintendo 尚未连接");
  try {
    const historyState = new Map(listNintendoHistoryState.all().map((row) => [String(row.titleId), String(row.revision)]));
    const result = await nintendo.fetchGames(connection.sessionToken, connection.mode || "parental", { historyState });
    saveSyncedGames(result.games, "nintendo-sync");
    if (result.activity?.length || result.historySync?.length) {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const item of result.activity) {
          setDailyActivity.run(item.date, "nintendo", item.externalId, item.externalId, item.title, item.minutes, item.coverUrl || null, item.storeUrl || null);
        }
        for (const item of result.historySync || []) {
          upsertNintendoHistoryState.run(item.titleId, item.revision, item.totalPlayedDays);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    const reconciliation = reconcileNintendoHistoryTotals();
    connection = {
      ...connection,
      nickname: result.nickname || connection.nickname || null,
      deviceCount: result.deviceCount,
      lastSyncAt: new Date().toISOString(),
      lastError: result.historyErrors?.length ? `${result.historyErrors.length} 款 Nintendo 历史记录本次未能回填，将在下次同步重试` : null,
      itemCount: result.games.length
    };
    credentials.set("nintendo", connection);
    return { synced: result.games.length, historyBackfilled: Number(result.historyBackfilled || 0), reconciledMinutes: reconciliation.addedMinutes, connection: publicConnection("nintendo") };
  } catch (error) {
    credentials.set("nintendo", { ...connection, lastError: error.message || "同步失败" });
    throw error;
  }
}

async function syncSteam() {
  let connection = credentials.get("steam");
  if (!connection) throw new Error("Steam 尚未连接");
  try {
    const games = await steam.fetchGames(connection);
    saveSyncedGames(games, "steam-sync");
    connection = { ...connection, lastSyncAt: new Date().toISOString(), lastError: null, itemCount: games.length };
    credentials.set("steam", connection);
    return { synced: games.length, connection: publicConnection("steam") };
  } catch (error) {
    credentials.set("steam", { ...connection, lastError: error.message || "同步失败" });
    throw error;
  }
}

async function syncMetacritic() {
  let connection = credentials.get("rawg");
  if (!connection) throw new Error("MC 评分数据源尚未连接");
  const games = gamesNeedingScores.all();
  let checked = 0;
  let updated = 0;
  const errors = [];
  let cursor = 0;
  async function worker() {
    while (cursor < games.length) {
      const game = games[cursor++];
      try {
        const result = await metacritic.fetchScore(connection.apiKey, game);
        updateMetacriticScore.run(result.score, result.scoreUrl, game.id);
        checked += 1;
        if (result.score !== null) updated += 1;
      } catch (error) {
        errors.push(`${game.title}: ${error.message || "查询失败"}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, games.length) }, () => worker()));
  const itemCount = Number(countMetacriticScores.get().count || 0);
  connection = {
    ...connection,
    lastSyncAt: new Date().toISOString(),
    lastError: errors.length ? `${errors.length} 款查询失败，下次同步会重试` : null,
    itemCount
  };
  credentials.set("rawg", connection);
  return { synced: updated, checked, connection: publicConnection("rawg") };
}

const automaticSyncIntervalMs = 60 * 60 * 1000;
const defaultAzureBackupCommand = path.join(homedir(), "Library", "Application Support", "GameTimeVault", "sync-azure-backup.zsh");
const azureBackupCommand = process.env.AZURE_BACKUP_SYNC_ENABLED === "0"
  ? null
  : String(process.env.AZURE_BACKUP_SYNC_COMMAND || (process.platform === "darwin" ? defaultAzureBackupCommand : "")).trim() || null;
let azureBackupProcess = null;
let nextAutomaticSyncAt = new Date(Date.now() + automaticSyncIntervalMs).toISOString();
let lastAutomaticSyncAt = null;
const gameSyncRunner = createSyncRunner([
  { id: "playstation", sync: syncPlaystation },
  { id: "xbox", sync: syncXbox },
  { id: "nintendo", sync: syncNintendo },
  { id: "steam", sync: syncSteam }
], {
  isConnected(provider) {
    const connection = credentials.get(provider);
    return Boolean(connection && !connection.pending);
  },
  onError(provider, error, trigger) {
    const label = providers.find((item) => item.id === provider)?.name || provider;
    console.error(`${label} ${trigger === "manual" ? "手动" : "自动"}同步失败：`, error?.message || error);
  }
});

app.get("/api/games", (_req, res) => res.json({ games: listGames.all(), stats: dashboardStats() }));

app.get("/api/sync/status", (_req, res) => res.json({
  intervalMinutes: automaticSyncIntervalMs / 60_000,
  running: gameSyncRunner.isRunning(),
  lastAutomaticSyncAt,
  nextAutomaticSyncAt
}));

app.post("/api/sync/all", async (_req, res, next) => {
  try {
    res.json(await gameSyncRunner.run("manual"));
  } catch (error) {
    next(error);
  }
});

app.get("/api/highlights", async (_req, res) => {
  const storage = resolveHighlightsDirectory(dataDir);
  let available = false;
  try { available = statSync(storage.directory).isDirectory(); } catch { available = false; }
  const localHighlights = available ? listHighlights(storage.directory) : [];
  let manifest = { files: {} };
  try { manifest = remoteMedia.manifest(); } catch (error) { console.error(error.message); }
  let baiduHighlights = [];
  try { baiduHighlights = await baiduStream.highlights(); } catch (error) { console.error(`百度媒体目录读取失败：${error.message || error}`); }
  const highlights = [...mergeRemoteHighlights(localHighlights, manifest, { remoteEnabled: remoteMedia.isEnabled() }), ...baiduHighlights]
    .sort((a, b) => Number(a.size || 0) - Number(b.size || 0)
      || String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || ""))
      || a.filename.localeCompare(b.filename, "zh-CN"));
  res.json({
    highlights,
    total: highlights.length,
    available,
    customDirectory: storage.custom,
    remoteEnabled: remoteMedia.isEnabled(),
    remoteCount: Object.keys(manifest.files || {}).length,
    baiduEnabled: baiduStream.isEnabled(),
    baiduCount: baiduHighlights.length
  });
});

app.get("/api/highlights/playback", async (req, res) => {
  const filename = String(req.query.filename || "");
  const storageSource = String(req.query.source || "default");
  if (!filename || filename.startsWith(".") || path.basename(filename) !== filename || !supportedHighlightFormats.includes(path.extname(filename).toLowerCase())) {
    return res.status(400).json({ error: "媒体文件名无效" });
  }

  if (storageSource === "baidu") {
    try {
      const playback = await baiduStream.playback(String(req.query.id || ""), filename);
      if (playback) return res.json(playback);
      return res.status(404).json({ error: "百度网盘视频不存在或目录清单已更新" });
    } catch (error) {
      console.error(`百度网盘播放链接生成失败：${error.message || error}`);
      return res.status(502).json({ error: "百度网盘暂时无法生成播放地址" });
    }
  }

  try {
    const remote = await remoteMedia.playback(filename);
    if (remote) return res.json(remote);
  } catch (error) {
    console.error(`远程媒体播放链接生成失败：${error.message || error}`);
  }

  const storage = resolveHighlightsDirectory(dataDir);
  const local = listHighlights(storage.directory, 5000).find((item) => item.filename === filename);
  if (local) return res.json({ url: local.url, source: "local", expiresIn: null });
  return res.status(404).json({ error: "视频不可用；请连接外置硬盘或重新同步云端媒体" });
});

app.get("/api/activity/recent", (_req, res) => {
  const dates = recentDateRange(14);
  const rows = db.prepare(`
    SELECT date, platform, precision, SUM(minutes) AS minutes
    FROM daily_activity
    WHERE date >= ? AND date <= ? AND minutes > 0
    GROUP BY date, platform, precision
    ORDER BY date, platform
  `).all(dates[0], dates.at(-1));
  const days = groupRecentActivity(dates, rows);
  res.json({
    startDate: dates[0],
    endDate: dates.at(-1),
    totalMinutes: days.reduce((sum, day) => sum + day.totalMinutes, 0),
    days
  });
});

app.get("/api/activity", (req, res) => {
  const month = String(req.query.month || shanghaiDate().slice(0, 7));
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ error: "月份格式无效" });
  const next = monthEnd(month);
  const rows = db.prepare(`
    SELECT d.date, d.platform, d.external_id AS externalId, d.title, d.minutes, d.cover_url AS coverUrl, d.store_url AS storeUrl,
           'minutes' AS eventType, d.precision,
           COALESCE((SELECT MAX(g.minutes) FROM games g WHERE g.platform = d.platform AND ((d.external_id IS NOT NULL AND g.external_id = d.external_id) OR (d.external_id IS NULL AND g.title = d.title COLLATE NOCASE))), 0) AS lifetimeMinutes
    FROM daily_activity d WHERE d.date >= ? AND d.date < ? AND d.minutes > 0
    UNION ALL
    SELECT e.date, e.platform, e.external_id AS externalId, e.title, 0 AS minutes, e.cover_url AS coverUrl, e.store_url AS storeUrl,
           'lastPlayed' AS eventType, 'history' AS precision,
           COALESCE((SELECT MAX(g.minutes) FROM games g WHERE g.platform = e.platform AND ((e.external_id IS NOT NULL AND g.external_id = e.external_id) OR (e.external_id IS NULL AND g.title = e.title COLLATE NOCASE))), 0) AS lifetimeMinutes
    FROM play_events e WHERE e.date >= ? AND e.date < ?
    ORDER BY date, minutes DESC, title COLLATE NOCASE
  `).all(`${month}-01`, next, `${month}-01`, next);
  res.json({ month, days: groupActivityRows(rows) });
});

app.get("/api/providers", (_req, res) => res.json({ providers }));

app.get("/api/connections", (req, res) => res.json({
  connections: ["playstation", "xbox", "nintendo", "steam", "rawg"].map((provider) => {
    const connection = publicConnection(provider);
    if (!adminAuthenticated(req)) connection.lastError = null;
    return connection;
  })
}));

app.post("/api/connections/playstation", async (req, res, next) => {
  try {
    const npsso = String(req.body.npsso || "").trim();
    if (npsso.length < 32 || npsso.length > 512) return res.status(400).json({ error: "NPSSO 格式无效" });
    const tokens = await playstation.connect(npsso);
    credentials.set("playstation", {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessExpiresAt: Date.now() + Number(tokens.expiresIn || 3600) * 1000,
      connectedAt: new Date().toISOString(),
      lastSyncAt: null,
      lastError: null,
      itemCount: 0
    });
    res.json(await syncPlaystation());
  } catch (error) {
    next(error);
  }
});

app.post("/api/connections/playstation/sync", async (_req, res, next) => {
  try {
    res.json(await syncPlaystation());
  } catch (error) {
    next(error);
  }
});

app.delete("/api/connections/playstation", (_req, res) => {
  credentials.delete("playstation");
  res.status(204).end();
});

app.post("/api/connections/xbox", async (req, res, next) => {
  let accountConnected = false;
  try {
    const apiKey = String(req.body.apiKey || "").trim();
    if (apiKey.length < 16 || apiKey.length > 1024) return res.status(400).json({ error: "OpenXBL API Key 格式无效" });
    const account = await xbox.connect(apiKey);
    credentials.set("xbox", {
      apiKey,
      ...account,
      connectedAt: new Date().toISOString(),
      lastSyncAt: null,
      lastError: null,
      itemCount: 0
    });
    accountConnected = true;
    res.json(await syncXbox());
  } catch (error) {
    if (!accountConnected) credentials.delete("xbox");
    next(error);
  }
});

app.post("/api/connections/xbox/sync", async (_req, res, next) => {
  try {
    res.json(await syncXbox());
  } catch (error) {
    next(error);
  }
});

app.delete("/api/connections/xbox", (_req, res) => {
  credentials.delete("xbox");
  res.status(204).end();
});

app.post("/api/connections/nintendo/start", (req, res) => {
  const mode = req.body?.mode === "parental" ? "parental" : "play-activity";
  const auth = nintendo.authorizationStart(mode);
  credentials.set("nintendo-pending", { state: auth.state, verifier: auth.verifier, clientId: auth.clientId, mode: auth.mode, createdAt: Date.now() });
  res.json({ authorizationUrl: auth.authorizationUrl, mode: auth.mode, callbackPrefix: `npf${auth.clientId}://auth` });
});

app.post("/api/connections/nintendo/complete", async (req, res, next) => {
  const pending = credentials.get("nintendo-pending");
  try {
    if (!pending || Date.now() - pending.createdAt > 15 * 60 * 1000) throw new Error("Nintendo 授权已过期，请重新开始连接");
    const sessionToken = await nintendo.complete(req.body.callbackUrl, pending);
    credentials.set("nintendo", {
      sessionToken,
      mode: pending.mode || "parental",
      connectedAt: new Date().toISOString(),
      lastSyncAt: null,
      lastError: null,
      itemCount: 0
    });
    clearNintendoHistoryState.run();
    credentials.delete("nintendo-pending");
    res.json(await syncNintendo());
  } catch (error) {
    credentials.delete("nintendo-pending");
    next(error);
  }
});

app.post("/api/connections/nintendo/sync", async (_req, res, next) => {
  try {
    res.json(await syncNintendo());
  } catch (error) {
    next(error);
  }
});

app.delete("/api/connections/nintendo", (_req, res) => {
  credentials.delete("nintendo");
  credentials.delete("nintendo-pending");
  clearNintendoHistoryState.run();
  res.status(204).end();
});

app.post("/api/connections/steam", async (req, res, next) => {
  let accountConnected = false;
  try {
    const apiKey = String(req.body.apiKey || "").trim();
    const identity = String(req.body.identity || "").trim();
    if (!/^[0-9a-f]{32}$/i.test(apiKey)) return res.status(400).json({ error: "Steam Web API Key 格式无效" });
    const account = await steam.connect(apiKey, identity);
    credentials.set("steam", {
      apiKey,
      ...account,
      connectedAt: new Date().toISOString(),
      lastSyncAt: null,
      lastError: null,
      itemCount: 0
    });
    accountConnected = true;
    res.json(await syncSteam());
  } catch (error) {
    if (!accountConnected) credentials.delete("steam");
    next(error);
  }
});

app.post("/api/connections/steam/sync", async (_req, res, next) => {
  try {
    res.json(await syncSteam());
  } catch (error) {
    next(error);
  }
});

app.delete("/api/connections/steam", (_req, res) => {
  credentials.delete("steam");
  res.status(204).end();
});

app.post("/api/connections/rawg", async (req, res, next) => {
  try {
    const apiKey = String(req.body.apiKey || "").trim();
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(apiKey)) return res.status(400).json({ error: "RAWG API Key 格式无效" });
    await metacritic.connect(apiKey);
    credentials.set("rawg", {
      apiKey,
      connectedAt: new Date().toISOString(),
      lastSyncAt: null,
      lastError: null,
      itemCount: 0
    });
    res.json(await syncMetacritic());
  } catch (error) {
    credentials.delete("rawg");
    next(error);
  }
});

app.post("/api/connections/rawg/sync", async (_req, res, next) => {
  try {
    res.json(await syncMetacritic());
  } catch (error) {
    next(error);
  }
});

app.delete("/api/connections/rawg", (_req, res) => {
  credentials.delete("rawg");
  res.status(204).end();
});

function spreadsheetRowsFromWorkbook(workbook) {
  const rows = [];
  workbook.eachSheet((sheet) => {
    const headers = [];
    sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => { headers[col] = String(cell.text || cell.value || "").trim(); });
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const item = {};
      headers.forEach((header, col) => { if (header) item[header] = row.getCell(col).value; });
      if (Object.values(item).some((value) => value !== null && value !== "")) rows.push(item);
    });
  });
  return rows;
}

async function spreadsheetRows(buffer, filename) {
  const workbook = new ExcelJS.Workbook();
  if (filename.toLowerCase().endsWith(".csv")) await workbook.csv.read(Readable.from([buffer]));
  else await workbook.xlsx.load(buffer);
  return spreadsheetRowsFromWorkbook(workbook);
}

app.post("/api/import", upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "请选择文件" });
    const filename = req.file.originalname.toLowerCase();
    let rows;
    if (filename.endsWith(".json")) rows = parseJsonRows(req.file.buffer.toString("utf8"));
    else if (filename.endsWith(".xlsx")) {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(req.file.buffer);
      const gameplay = parsePlaystationGameplayWorkbook(workbook);
      if (gameplay) {
        return res.status(422).json({
          error: "Gameplay Online 只包含部分在线会话，不能用于校准 PlayStation 总时长；请提供包含 Gameplay Detail 的 Sony 隐私数据文件"
        });
      }
      rows = spreadsheetRowsFromWorkbook(workbook);
    } else if (filename.endsWith(".csv")) rows = await spreadsheetRows(req.file.buffer, filename);
    else return res.status(400).json({ error: "仅支持 .xlsx、.csv 或 .json" });

    const { records, errors } = normalizeRows(rows, req.body.platform);
    saveSyncedGames(records.map((item) => ({ ...item, coverUrl: null, storeUrl: null, notes: "官方数据副本" })), "official-export", { recordDelta: false });
    res.json({ imported: records.length, skipped: errors.length, errors: errors.slice(0, 20) });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  if (error?.code?.startsWith("SQLITE_CONSTRAINT")) return res.status(409).json({ error: "该平台已经存在同名游戏" });
  res.status(Number(error?.status) || 500).json({ error: error.message || "服务器错误" });
});

app.listen(port, () => {
  console.log(`游戏时长记录已启动：http://localhost:${port}`);
  if (outboundProxy.enabled) console.log(`平台接口已使用${outboundProxy.source === "macos" ? " macOS 系统" : "环境变量"}代理`);
  if (admin) console.log(`公网只读保护已启用；管理凭据来源：${admin.source === "environment" ? "环境变量" : path.join(dataDir, "admin-access.json")}`);
});

async function runScheduledSync(trigger) {
  try {
    await gameSyncRunner.run(trigger);
  } catch (error) {
    console.error("全平台自动同步失败：", error?.message || error);
  } finally {
    if (trigger === "automatic") lastAutomaticSyncAt = new Date().toISOString();
  }
}

const startupSync = setTimeout(() => { runScheduledSync("startup"); }, 2_000);
startupSync.unref();
function scheduleAutomaticSync() {
  nextAutomaticSyncAt = new Date(Date.now() + automaticSyncIntervalMs).toISOString();
  const automaticSync = setTimeout(async () => {
    await runScheduledSync("automatic");
    scheduleAutomaticSync();
  }, automaticSyncIntervalMs);
  automaticSync.unref();
}
scheduleAutomaticSync();

function runAzureBackupSync(trigger) {
  if (!azureBackupCommand || !existsSync(azureBackupCommand) || azureBackupProcess) return;
  console.log(`Azure 备用站同步已启动（${trigger}）`);
  const child = spawn(azureBackupCommand, [], { stdio: "inherit" });
  azureBackupProcess = child;
  child.once("error", (error) => console.error("Azure 备用站同步启动失败：", error.message));
  child.once("close", (code, signal) => {
    azureBackupProcess = null;
    if (code === 0) console.log("Azure 备用站同步已完成");
    else console.error(`Azure 备用站同步退出：${signal || code}`);
  });
}

if (azureBackupCommand && existsSync(azureBackupCommand)) {
  const startupAzureBackup = setTimeout(() => runAzureBackupSync("startup"), 45_000);
  startupAzureBackup.unref();
  const automaticAzureBackup = setInterval(() => runAzureBackupSync("automatic"), automaticSyncIntervalMs);
  automaticAzureBackup.unref();
}
