import http from "node:http";

const publicRoutes = new Map([
  ["/key-overview", "/usage/overview"],
  ["/key-overview/comparisons", "/usage/overview/comparisons"],
  ["/key-overview/realtime", "/usage/overview/realtime"],
  ["/key-activity", "/usage/activity"],
  ["/key-analysis", "/usage/analysis"],
  ["/key-analysis/latency", "/usage/analysis/latency"]
]);
const safeFields = new Set(`usage summary series timezone total_requests success_count failure_count total_tokens rpm tpm total_cost cost_available input_tokens output_tokens cache_read_tokens cache_creation_tokens reasoning_tokens daily_average_requests daily_average_tokens daily_average_cost daily_average_range_days buckets requests tokens cost cache_read_rate window grain rows columns bucket_seconds window_start window_end total_success total_failure success_rate blocks start_time end_time success failure rate granularity range_start range_end token_usage bucket cost_usd model_usage model model_composition key label percent models cells intensity cost_breakdown uncached_input_cost_usd cache_read_cost_usd cache_write_cost_usd output_cost_usd total_cost_usd model_efficiency cost_per_request_usd output_tokens_per_request token_velocity tokens_per_minute response_level ttft_p50_ms ttft_p95_ms latency_p50_ms latency_p95_ms response_distribution ttft latency average_line avg_ms particles timestamp ms count total_particles sampled max_particles current_usage share request_level cache_level insights outcomes failures token_requests cached_requests points density total_points supported unsupported_reason p95_ttft_ms p95_latency_ms max_ttft_ms max_latency_ms ttft_ms latency_ms ttft_min_ms ttft_max_ms latency_min_ms latency_max_ms comparisons current previous delta delta_percent metrics`.split(" "));
const dateFields = new Set("bucket buckets timestamp start_time end_time window_start window_end range_start range_end".split(" "));
const textFields = new Set("timezone window grain granularity model models key label unsupported_reason".split(" "));

export function sanitizeKeeperPublic(value, field = "", depth = 0) {
  if (depth > 18) return null;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    if (dateFields.has(field)) return /^\d{4}-\d{2}-\d{2}(?:[ T][\d:.+Z-]+)?$/.test(value) ? value : "";
    if (field === "timezone") return ["Asia/Shanghai", "UTC", "Local"].includes(value) ? value : "Asia/Shanghai";
    if (!textFields.has(field)) return "";
    // Model/enum labels only. Never pass URLs, key prefixes, email, or free-form errors.
    if (value.length > 100 || !/^[A-Za-z0-9 _().-]*$/.test(value) || /(?:sk-|AIza|ghp_|secret|token=|password)/i.test(value)) return "已隐藏";
    return value;
  }
  if (Array.isArray(value)) return value.slice(0, 12_000).map((item) => sanitizeKeeperPublic(item, field, depth + 1));
  if (typeof value !== "object") return null;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (safeFields.has(key)) result[key] = sanitizeKeeperPublic(item, key, depth + 1);
  }
  // Shared KEEPER components expect these shapes, but visitors receive no identities.
  for (const key of ["api_key_composition", "auth_files_composition", "ai_provider_composition", "api_keys", "auth_files", "ai_providers"]) {
    if (Object.hasOwn(value, key)) result[key] = [];
  }
  if (Object.hasOwn(value, "heatmap")) result.heatmap = { api_keys: [], api_key_labels: {}, models: [], cells: [] };
  return result;
}

export function keeperPublicTarget(pathname, query = {}) {
  const route = publicRoutes.get(pathname);
  if (!route) return null;
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (!["range", "window", "unit", "start", "end"].includes(key) || typeof value !== "string" || value.length > 40 || !/^[A-Za-z0-9:.+ -]+$/.test(value)) return null;
    parameters.set(key, value);
  }
  return `/api/v1${route}${parameters.size ? `?${parameters}` : ""}`;
}

function upstreamRequest(origin, pathname, { method = "GET", body } = {}) {
  return new Promise((resolve, reject) => {
    if (!origin) return reject(new Error("Keeper not configured"));
    const url = new URL(pathname, origin);
    const request = http.request(url, { method, headers: { Accept: "*/*", "X-CPA-Usage-Keeper-Request": "fetch", ...(body ? { "Content-Type": "application/json" } : {}) } }, (response) => {
      const chunks = []; let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) { request.destroy(new Error("Response too large")); return; }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode, contentType: response.headers["content-type"] || "application/octet-stream", body: Buffer.concat(chunks) }));
    });
    request.setTimeout(8_000, () => request.destroy(new Error("Upstream timeout")));
    request.on("error", reject);
    request.end(body ? JSON.stringify(body) : undefined);
  });
}

export function nativeKeeperHtml(html) {
  return html
    .replace(/<script>\s*window\.__APP_BASE_PATH__\s*=[\s\S]*?<\/script>/, '<script src="/keeper-bridge.js?v=20260917-2"></script>')
    .replaceAll('src="./assets/', 'src="/ai-usage/assets/')
    .replaceAll('href="./assets/', 'href="/ai-usage/assets/')
    .replace("</head>", '<link rel="stylesheet" href="/keeper-bridge.css?v=20260917-2"></head>')
    .replace("<body>", '<body><nav id="keeperWebsiteBar" aria-label="网站导航"><a href="/">← 游戏档案</a><span id="keeperAccessLabel">只读用量</span><button id="keeperAdminButton" type="button">管理员登录</button></nav>');
}

export function registerKeeperUiRoutes(app, { origin, authorize, login, logout, sameOrigin, request = (path, options) => upstreamRequest(origin, path, options) }) {
  const cache = new Map();
  app.get("/ai-usage.html", (_req, res) => res.redirect(302, "/ai-usage/"));
  app.get(/^\/ai-usage$/, (_req, res) => res.redirect(302, "/ai-usage/"));
  app.use("/ai-usage", async (req, res) => {
    res.set({ "Cache-Control": "no-store", "CDN-Cache-Control": "no-store", "Vary": "Cookie", "X-Robots-Tag": "noindex, nofollow" });
    const pathname = req.path;
    const api = pathname.startsWith("/api/v1/") ? pathname.slice(7) : null;
    const isAdmin = authorize(req);
    try {
      if (api) {
        if (api === "/auth/session" && req.method === "GET") {
          return res.json(isAdmin ? { authenticated: true, role: "admin" } : { authenticated: true, role: "api_key_viewer", api_key: { display_key: "访客 · 汇总用量", local_ranking_enabled: false } });
        }
        if (api === "/auth/login" && req.method === "POST") return login(req, res);
        if (api === "/auth/logout" && req.method === "POST") {
          if (!sameOrigin(req)) return res.status(403).json({ error: "已拒绝跨站请求" });
          return logout(req, res);
        }
        if (api.startsWith("/auth/") && api !== "/auth/sessions") return res.status(403).json({ error: "请使用网站管理员登录" });
        if (api === "/version" && req.method === "GET") return res.json({ version: "v1.15.4", updateCheckEnabled: false });
        const target = keeperPublicTarget(api, req.query);
        if (!isAdmin) {
          if (req.method !== "GET" || !target) return res.status(403).json({ error: "访客仅可查看用量汇总" });
          const existing = cache.get(target);
          if (existing && existing.expires > Date.now()) return res.json(existing.data);
          const upstream = await request(target);
          if (upstream.status !== 200) return res.status(upstream.status === 400 ? 400 : 503).json({ error: "所选统计暂时不可用" });
          const data = sanitizeKeeperPublic(JSON.parse(upstream.body.toString()));
          if (cache.size >= 64) cache.delete(cache.keys().next().value);
          cache.set(target, { data, expires: Date.now() + 10_000 });
          return res.json(data);
        }
        // The public bridge is read-only, including in administrator mode.
        const readOnlyPost = req.method === "POST" && api === "/quota/cache" && sameOrigin(req);
        if (req.method !== "GET" && !readOnlyPost) return res.status(403).json({ error: "公网入口仅供查看；修改请使用本机 KEEPER" });
        if (!/^\/[a-zA-Z0-9/_-]+$/.test(api) || api.includes("..")) return res.status(404).end();
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(req.query)) {
          if (typeof value === "string" && value.length <= 512) query.set(key, value);
        }
        const upstream = await request(target || `/api/v1${api}${query.size ? `?${query}` : ""}`, { method: req.method, body: readOnlyPost ? req.body : undefined });
        if (upstream.status !== 200) return res.status(upstream.status >= 400 && upstream.status < 500 ? upstream.status : 503).json({ error: "此功能暂时不可用，或需在本机使用" });
        if (!upstream.contentType.includes("application/json")) return res.status(403).json({ error: "公网入口不提供文件下载" });
        return res.json(JSON.parse(upstream.body.toString()));
      }
      if (req.method !== "GET" && req.method !== "HEAD") return res.status(405).end();
      if (/^\/assets\/[A-Za-z0-9_.-]+\.(?:js|css|woff2?|png|svg)$/.test(pathname)) {
        const upstream = await request(pathname);
        if (upstream.status !== 200) return res.status(404).end();
        res.set("Content-Type", upstream.contentType);
        return res.send(upstream.body);
      }
      if (pathname.startsWith("/api/") || !/^\/[a-z-]*\/?$/.test(pathname)) return res.status(404).end();
      const upstream = await request("/");
      if (upstream.status !== 200) throw new Error("Keeper unavailable");
      res.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      return res.type("html").send(nativeKeeperHtml(upstream.body.toString()));
    } catch {
      return res.status(503).type("text").send("KEEPER 暂时不可用，请稍后重试。");
    }
  });
}
