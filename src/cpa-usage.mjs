import { DatabaseSync } from "node:sqlite";

const number = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const fields = ["requests", "successes", "failures", "inputTokens", "outputTokens", "cachedTokens", "totalTokens"];
const totalsSql = `COALESCE(SUM(request_count), 0) AS requests,
  COALESCE(SUM(success_count), 0) AS successes, COALESCE(SUM(failure_count), 0) AS failures,
  COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cachedTokens, COALESCE(SUM(total_tokens), 0) AS totalTokens`;

export function publicUsageTotals(row = {}) {
  // Explicit numeric allowlist: never forward upstream records or arbitrary strings.
  return Object.fromEntries(fields.map((key) => [key, number(row[key])]));
}

export function createCpaUsageService({ databasePath = "", baseUrl = "", now = () => new Date() } = {}) {
  let cache;
  function read(operation) {
    if (!databasePath) throw new Error("Usage source not configured");
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 1500;");
      return operation(db);
    } finally { db.close(); }
  }
  return {
    summary() {
      if (cache && now().getTime() - cache.time < 30_000) return cache.value;
      const value = read((db) => {
        const current = now();
        const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(current);
        const first = new Date(`${today}T00:00:00+08:00`);
        first.setUTCDate(first.getUTCDate() - 29);
        const start = first.toISOString();
        const total = publicUsageTotals(db.prepare(`SELECT ${totalsSql} FROM usage_overview_daily_stats`).get());
        const rows = db.prepare(`SELECT date(bucket_start, '+8 hours') AS day, ${totalsSql}
          FROM usage_overview_hourly_stats WHERE julianday(bucket_start) >= julianday(?)
          GROUP BY day ORDER BY day`).all(start);
        const byDay = new Map(rows.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.day)).map((r) => [r.day, publicUsageTotals(r)]));
        const days = Array.from({ length: 30 }, (_, i) => {
          const date = new Date(`${today}T12:00:00Z`);
          date.setUTCDate(date.getUTCDate() - 29 + i);
          const day = date.toISOString().slice(0, 10);
          return { day, ...publicUsageTotals(byDay.get(day)) };
        });
        return { totals: total, days, today: days.at(-1), updatedAt: current.toISOString(), timezone: "Asia/Shanghai" };
      });
      cache = { time: now().getTime(), value };
      return value;
    },
    connection() {
      // Called only after explicit website administrator authentication.
      return read((db) => ({ baseUrl, apiKeys: db.prepare("SELECT api_key FROM cpa_api_keys WHERE is_deleted = 0 ORDER BY id LIMIT 20").all()
        .map((row) => row.api_key).filter((key) => typeof key === "string" && key.length >= 32 && key.length <= 512) }));
    }
  };
}

export function registerCpaUsageRoutes(app, { service, authorize }) {
  app.use("/api/ai-usage", (_req, res, next) => {
    res.set({ "Cache-Control": "no-store", "CDN-Cache-Control": "no-store", "Vary": "Cookie", "X-Robots-Tag": "noindex, nofollow" });
    next();
  });
  app.get("/api/ai-usage", (_req, res) => {
    try { return res.json(service.summary()); }
    catch { return res.status(503).json({ error: "用量服务暂时不可用，请稍后重试" }); }
  });
  app.get("/api/ai-usage/connection", (req, res) => {
    if (!authorize(req)) return res.status(401).json({ error: "请先登录网站管理员" });
    try { return res.json(service.connection()); }
    catch { return res.status(503).json({ error: "连接信息暂时不可用" }); }
  });
  app.use("/api/ai-usage", (_req, res) => res.status(404).json({ error: "接口不存在" }));
}
