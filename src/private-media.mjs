import express from "express";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isLoopbackHost } from "./security.mjs";
import { listHighlights, resolveHighlightFile, supportedHighlightVideoFormats } from "./highlights.mjs";
import { streamUrlFor, resolveStreamAsset } from "./highlight-streams.mjs";
import { createHighlightPosterService } from "./highlight-posters.mjs";
import { createPrivateMediaDirect } from "./private-media-direct.mjs";
import { createPrivateMediaUpload } from "./private-media-upload.mjs";

export function privateMediaDirectory(dataDirectory, environment = process.env) {
  const file = path.join(dataDirectory, "private-highlights-path.txt");
  const value = String(environment.PRIVATE_HIGHLIGHTS_DIR || (existsSync(file) ? readFileSync(file, "utf8") : "")).trim();
  return value && path.isAbsolute(value) && !value.includes("\0") ? path.resolve(value) : null;
}

export function createPrivateMedia({ dataDirectory, directory, mediaUser, posterService, now = Date.now, directOrigin = null, allowedOrigins = [], playbackSession = () => null, sessionActive = () => false }) {
  const router = express.Router();
  const posters = posterService || createHighlightPosterService({ cacheDirectory: path.join(dataDirectory, "private-media-posters", "dai") });
  let cache;
  router.use((req, res, next) => {
    res.set({ "Cache-Control": "private, no-store", "CDN-Cache-Control": "no-store", Vary: "Cookie", "Cross-Origin-Resource-Policy": "same-origin", "X-Robots-Tag": "noindex, nofollow" });
    if (!req.secure && !isLoopbackHost(req.get("host"))) return res.status(426).json({ error: "请通过 HTTPS 访问个人视频" });
    const user = mediaUser(req);
    if (!user || user.library !== "dai") return res.status(401).json({ error: "请先使用视频账号登录" });
    req.mediaUser = user; next();
  });
  const uploader = createPrivateMediaUpload({ directory, mediaUser, onComplete: () => { cache = null; }, now });
  router.use("/uploads", uploader.router);
  router.get("/", (req, res) => {
    let available = false;
    try { available = Boolean(directory && statSync(directory).isDirectory()); } catch {}
    if (!available) { cache = null; return res.json({ owner: req.mediaUser.displayName, available: false, videos: [] }); }
    if (!cache || now() - cache.at > 10_000) {
      const videos = listHighlights(directory, 10000).filter(item => item.type === "video").map(item => {
        const stream = streamUrlFor(directory, item);
        return { filename: item.filename, title: item.title, folder: item.folder, size: item.size, modifiedAt: item.modifiedAt,
          url: `/api/my-media/files/${encodeURIComponent(item.filename)}?v=${Date.parse(item.modifiedAt)}`,
          posterUrl: `/api/my-media/posters/${encodeURIComponent(item.filename)}?v=${Date.parse(item.modifiedAt)}`,
          streamUrl: stream ? stream.replace("/media/highlight-streams/", "/api/my-media/streams/") : null };
      });
      cache = { at: now(), videos };
    }
    res.json({ owner: req.mediaUser.displayName, available, canUpload: req.mediaUser.username === "戴卓然", videos: cache.videos });
  });
  const sendError = (res, error) => { if (error && !res.headersSent && !["ECONNABORTED", "EPIPE"].includes(error.code)) res.status(error.statusCode === 416 ? 416 : 404).end(); };
  const resolveVideo = filename => {
    if (!directory || !supportedHighlightVideoFormats.includes(path.extname(filename).toLowerCase())) throw new Error("Unavailable");
    return resolveHighlightFile(directory, filename);
  };
  const direct = createPrivateMediaDirect({ directOrigin, allowedOrigins, sessionActive, resolveVideo, now });
  router.post("/playback", (req, res) => {
    const origin = `${req.protocol}://${req.get("host")}`;
    if (req.get("origin") !== origin || req.get("sec-fetch-site") === "cross-site") return res.sendStatus(403);
    try {
      const filename = String(req.body?.filename || "");
      resolveVideo(filename);
      res.json({ direct: direct.issue({ origin, session: playbackSession(req), filename }) });
    } catch { res.sendStatus(404); }
  });
  router.get("/files/:filename", (req, res) => {
    try {
      const { file } = resolveVideo(req.params.filename);
      res.set("Content-Disposition", "inline");
      res.sendFile(file, { cacheControl: false, dotfiles: "deny" }, error => sendError(res, error));
    } catch { res.status(404).end(); }
  });
  router.get("/posters/:filename", async (req, res) => {
    try {
      const { file, stats } = resolveVideo(req.params.filename);
      const poster = await posters.posterFor(file, req.params.filename, stats);
      if (!mediaUser(req)) return res.status(401).end();
      res.type("image/jpeg").sendFile(poster, { cacheControl: false }, error => sendError(res, error));
    } catch { if (!res.headersSent) res.status(404).end(); }
  });
  router.get("/streams/:id/:asset", (req, res) => {
    try {
      const { file, type } = resolveStreamAsset(directory, req.params.id, req.params.asset);
      res.type(type).sendFile(file, { cacheControl: false, dotfiles: "allow" }, error => sendError(res, error));
    } catch { res.status(404).end(); }
  });
  router.use((_req, res) => res.status(404).json({ error: "媒体不存在" }));
  return { router, directRouter: direct.router, close: uploader.close };
}
