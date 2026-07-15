import express from "express";
import multer from "multer";
import ExcelJS from "exceljs";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
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
import { activityDate, cumulativeDelta, groupActivityRows, monthEnd, shanghaiDate } from "./src/activity.mjs";
import { isLoopbackHost, isSameOriginWrite, parseCookies, safeEqual } from "./src/security.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, "data");
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, "games.db"));
const credentials = new CredentialStore(dataDir);
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
    last_played TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    external_id TEXT,
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
  res.set({
    "Content-Security-Policy": "default-src 'self'; img-src 'self' https: data:; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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
  if (!admin || !req.path.startsWith("/api/") || ["GET", "HEAD", "OPTIONS"].includes(req.method) || (req.method === "POST" && req.path === "/api/admin/session")) return next();
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
app.use(express.static(path.join(root, "public")));

const listGames = db.prepare(`
  SELECT id, platform, title, minutes, last_played AS lastPlayed,
         source, external_id AS externalId, cover_url AS coverUrl, store_url AS storeUrl,
         metacritic_score AS metacriticScore, score_url AS scoreUrl,
         achievements_earned AS achievementsEarned, achievements_total AS achievementsTotal,
         notes, updated_at AS updatedAt
  FROM games WHERE minutes > 0 ORDER BY minutes DESC, title COLLATE NOCASE
`);

const upsertSyncedGame = db.prepare(`
  INSERT INTO games(platform, title, minutes, last_played, source, external_id, cover_url, store_url, achievements_earned, achievements_total, achievements_updated_at, notes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END, ?)
  ON CONFLICT DO UPDATE SET
    title = excluded.title,
    minutes = MAX(games.minutes, excluded.minutes),
    last_played = COALESCE(excluded.last_played, games.last_played),
    cover_url = COALESCE(excluded.cover_url, games.cover_url),
    store_url = COALESCE(excluded.store_url, games.store_url),
    achievements_earned = COALESCE(excluded.achievements_earned, games.achievements_earned),
    achievements_total = COALESCE(excluded.achievements_total, games.achievements_total),
    achievements_updated_at = COALESCE(excluded.achievements_updated_at, games.achievements_updated_at),
    source = excluded.source,
    notes = excluded.notes,
    updated_at = CURRENT_TIMESTAMP
`);

const findGameByExternalId = db.prepare("SELECT minutes FROM games WHERE platform = ? AND external_id = ?");
const findGameByTitle = db.prepare("SELECT minutes FROM games WHERE platform = ? AND external_id IS NULL AND title = ? COLLATE NOCASE");
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

function dashboardStats() {
  const base = db.prepare(`
    SELECT COALESCE(SUM(minutes), 0) AS totalMinutes, COUNT(*) AS gameCount, MAX(updated_at) AS latest
    FROM games WHERE minutes > 0
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
      const previous = game.externalId
        ? findGameByExternalId.get(game.platform, game.externalId)
        : findGameByTitle.get(game.platform, game.title);
      const delta = cumulativeDelta(previous?.minutes, game.minutes);
      const gameKey = game.externalId || String(game.title).trim().toLocaleLowerCase("zh-CN");
      if (recordDelta && delta > 0) {
        upsertDailyActivity.run(activityDate(game.lastPlayed), game.platform, gameKey, game.externalId || null, game.title, delta, game.coverUrl || null, game.storeUrl || null);
        addedMinutes += delta;
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(game.lastPlayed || "")) {
        upsertPlayEvent.run(game.lastPlayed, game.platform, gameKey, game.externalId || null, game.title, game.coverUrl || null, game.storeUrl || null);
      }
      const achievementMarker = game.achievementsTotal === null || game.achievementsTotal === undefined ? null : Number(game.achievementsTotal);
      upsertSyncedGame.run(game.platform, game.title, game.minutes, game.lastPlayed || null, source, game.externalId || null, game.coverUrl || null, game.storeUrl || null,
        game.achievementsEarned ?? null, game.achievementsTotal ?? null, achievementMarker, game.notes || "");
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return addedMinutes;
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
    if (snapshot.achievementSummary) {
      upsertPlatformStats.run("playstation", snapshot.achievementSummary.achievementsEarned, snapshot.achievementSummary.completedGames);
    }
    connection = { ...connection, lastSyncAt: new Date().toISOString(), lastError: null, itemCount: games.length };
    credentials.set("playstation", connection);
    return { synced: games.length, connection: publicConnection("playstation") };
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
    const result = await nintendo.fetchGames(connection.sessionToken, connection.mode || "parental");
    saveSyncedGames(result.games, "nintendo-sync");
    if (result.activity?.length) {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const item of result.activity) {
          setDailyActivity.run(item.date, "nintendo", item.externalId, item.externalId, item.title, item.minutes, item.coverUrl || null, item.storeUrl || null);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    connection = {
      ...connection,
      nickname: result.nickname || connection.nickname || null,
      deviceCount: result.deviceCount,
      lastSyncAt: new Date().toISOString(),
      lastError: null,
      itemCount: result.games.length
    };
    credentials.set("nintendo", connection);
    return { synced: result.games.length, connection: publicConnection("nintendo") };
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

app.get("/api/games", (_req, res) => res.json({ games: listGames.all(), stats: dashboardStats() }));

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
    res.json(await syncXbox());
  } catch (error) {
    credentials.delete("xbox");
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
  res.status(204).end();
});

app.post("/api/connections/steam", async (req, res, next) => {
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
    res.json(await syncSteam());
  } catch (error) {
    credentials.delete("steam");
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

async function spreadsheetRows(buffer, filename) {
  const workbook = new ExcelJS.Workbook();
  if (filename.toLowerCase().endsWith(".csv")) {
    await workbook.csv.read(Readable.from([buffer]));
  } else {
    await workbook.xlsx.load(buffer);
  }
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

app.post("/api/import", upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "请选择文件" });
    const filename = req.file.originalname.toLowerCase();
    let rows;
    if (filename.endsWith(".json")) rows = parseJsonRows(req.file.buffer.toString("utf8"));
    else if (filename.endsWith(".csv") || filename.endsWith(".xlsx")) rows = await spreadsheetRows(req.file.buffer, filename);
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
  res.status(500).json({ error: error.message || "服务器错误" });
});

app.listen(port, () => {
  console.log(`游戏时长记录已启动：http://localhost:${port}`);
  if (admin) console.log(`公网只读保护已启用；管理凭据来源：${admin.source === "environment" ? "环境变量" : path.join(dataDir, "admin-access.json")}`);
});

function syncConnectedPlatforms() {
  if (credentials.get("playstation")) syncPlaystation().catch((error) => console.error("PlayStation 自动同步失败：", error.message));
  if (credentials.get("xbox")) syncXbox().catch((error) => console.error("Xbox 自动同步失败：", error.message));
  if (credentials.get("nintendo")) syncNintendo().catch((error) => console.error("Nintendo 自动同步失败：", error.message));
  if (credentials.get("steam")) syncSteam().catch((error) => console.error("Steam 自动同步失败：", error.message));
  if (credentials.get("rawg")) syncMetacritic().catch((error) => console.error("MC 评分自动同步失败：", error.message));
}

const startupSync = setTimeout(syncConnectedPlatforms, 2_000);
startupSync.unref();
const automaticSync = setInterval(syncConnectedPlatforms, 6 * 60 * 60 * 1000);
automaticSync.unref();
