import express from "express";
import { createHash, randomBytes } from "node:crypto";
import { parseCookies } from "./security.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const COOKIE = "mgv_private_playback", COOKIE_PATH = "/api/private-playback";

// A single-use ticket crosses origins in a POST body. It never enters a URL,
// browser storage, or an access log. The resulting cookie can read one file only.
export function createPrivateMediaDirect({ directOrigin, allowedOrigins, sessionActive, resolveVideo, now = Date.now }) {
  const router = express.Router(), tickets = new Map(), grants = new Map();
  const allowed = new Set(allowedOrigins);
  const prune = () => {
    for (const entries of [tickets, grants]) for (const [key, value] of entries) if (value.expires <= now() || !sessionActive(value.session)) entries.delete(key);
  };
  function issue({ origin, session, filename }) {
    if (!directOrigin || !allowed.has(origin) || !session || !sessionActive(session)) return null;
    prune();
    if (tickets.size >= 512 || grants.size >= 512) return null;
    let own = 0; for (const value of tickets.values()) if (value.session === session) own++;
    if (own >= 8) return null;
    resolveVideo(filename);
    const ticket = randomBytes(32).toString("base64url");
    tickets.set(digest(ticket), { origin, session, filename, expires: now() + 30_000 });
    return { origin: directOrigin, ticket };
  }
  router.use((req, res, next) => {
    res.set({ "Cache-Control": "private, no-store", "CDN-Cache-Control": "no-store", "Cross-Origin-Resource-Policy": "same-site", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" });
    res.vary("Origin"); res.vary("Cookie");
    if (!directOrigin || !req.secure || `${req.protocol}://${req.get("host")}` !== directOrigin) return res.sendStatus(404);
    const origin = req.get("origin");
    if (!allowed.has(origin) || req.get("sec-fetch-site") === "cross-site") return res.sendStatus(403);
    res.set({ "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges" });
    if (req.method === "OPTIONS") {
      res.set({ "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Range", "Access-Control-Max-Age": "300" });
      return res.sendStatus(204);
    }
    next();
  });
  router.post("/session", (req, res) => {
    prune();
    const ticket = String(req.body?.ticket || "");
    if (!/^[\w-]{43}$/.test(ticket)) return res.sendStatus(401);
    const key = digest(ticket), grant = tickets.get(key);
    if (!grant || grant.origin !== req.get("origin")) return res.sendStatus(401);
    tickets.delete(key);
    const token = randomBytes(32).toString("base64url");
    const previous = parseCookies(req.get("cookie"))[COOKIE];
    if (previous) grants.delete(digest(previous));
    grants.set(digest(token), { ...grant, expires: now() + 8 * 3600_000 });
    res.cookie(COOKIE, token, { path: COOKIE_PATH, secure: true, httpOnly: true, sameSite: "strict", maxAge: 8 * 3600_000 });
    res.json({ url: `${directOrigin}${COOKIE_PATH}/file/${digest(grant.filename).slice(0, 32)}` });
  });
  router.get("/file/:id", (req, res) => {
    const token = parseCookies(req.get("cookie"))[COOKIE];
    const grant = token && grants.get(digest(token));
    if (!grant || grant.expires <= now() || grant.origin !== req.get("origin") || !sessionActive(grant.session) || req.params.id !== digest(grant.filename).slice(0, 32)) return res.sendStatus(401);
    try {
      const { file } = resolveVideo(grant.filename);
      res.set("Content-Disposition", "inline");
      res.sendFile(file, { cacheControl: false, dotfiles: "deny" }, error => {
        if (error && !res.headersSent && !["ECONNABORTED", "EPIPE"].includes(error.code)) res.sendStatus(error.statusCode === 416 ? 416 : 404);
      });
    } catch { res.sendStatus(404); }
  });
  router.use((_req, res) => res.sendStatus(404));
  return { router, issue };
}
