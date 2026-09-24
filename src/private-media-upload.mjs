import express from "express";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, statfs, unlink, readdir } from "node:fs/promises";
import path from "node:path";

export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
export const UPLOAD_MAX_BYTES = 8 * 1024 ** 3;
const RESERVE = 1024 ** 3, TTL = 24 * 3600_000;
const error = (status, message) => Object.assign(new Error(message), { status });
export function uploadFilename(value) {
  const name = String(value || "").normalize("NFKC");
  if (!name || Buffer.byteLength(name) > 180 || /[\/\\\x00-\x1f\x7f]/.test(name) || name.startsWith(".") || !/\.(mp4|m4v|mov|webm)$/i.test(name)) throw error(400, "请选择 MP4、MOV、M4V 或 WebM 视频，文件名不能包含路径");
  return name;
}
export function supportedVideoHeader(buffer, filename) {
  return /\.webm$/i.test(filename) ? buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) : buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp";
}

export function createPrivateMediaUpload({ directory, mediaUser, onComplete = () => {}, now = Date.now, reserveBytes = RESERVE }) {
  const router = express.Router(), uploads = new Map(); let writing = false, sweeping = false;
  const wrap = fn => async (req, res) => {
    try { await fn(req, res); } catch (e) {
      if (!res.headersSent) res.status(e.status || (e.code === "ENOSPC" ? 507 : 503)).json({ error: e.status ? e.message : e.code === "ENOSPC" ? "硬盘空间不足" : "上传暂时不可用，请确认私人硬盘已连接并可写" });
    }
  };
  async function directories() {
    if (!directory) throw error(503, "私人硬盘未连接");
    const root = await realpath(directory);
    const resolve = async name => {
      const dir = path.join(root, name); await mkdir(dir, { recursive: true });
      const stats = await lstat(dir);
      if (!stats.isDirectory() || stats.isSymbolicLink() || await realpath(dir) !== dir) throw error(503, "上传目录不可用");
      return dir;
    };
    return { temp: await resolve(".website-uploads"), final: await resolve("网站上传") };
  }
  const owns = req => {
    const user = mediaUser(req);
    return user?.library === "dai" && user.username === "戴卓然" ? user : null;
  };
  router.use((req, res, next) => {
    if (!owns(req)) return res.status(403).json({ error: "仅戴卓然账号可以上传视频" });
    const sameOrigin = req.get("origin") === `${req.protocol}://${req.get("host")}` || (req.method === "GET" && req.get("sec-fetch-site") === "same-origin");
    if (!sameOrigin || req.get("sec-fetch-site") === "cross-site") return res.status(403).json({ error: "已拒绝跨站上传请求" });
    next();
  });
  async function discard(item) { await unlink(item.temp).catch(e => { if (e.code !== "ENOENT") throw e; }); uploads.delete(item.id); }
  async function sweep() {
    if (sweeping || writing) return; sweeping = true;
    try {
      for (const item of uploads.values()) if (!item.busy && item.updated + TTL <= now()) await discard(item);
      const { temp } = await directories();
      for (const name of await readdir(temp)) {
        if (!/^[a-f0-9-]{36}\.part$/.test(name) || uploads.has(name.slice(0, -5))) continue;
        const file = path.join(temp, name), stats = await lstat(file);
        if (stats.isFile() && !stats.isSymbolicLink() && stats.mtimeMs + TTL <= now()) await unlink(file);
      }
    } catch { /* An offline drive must not affect playback or other site APIs. */ }
    finally { sweeping = false; }
  }
  const cleanup = setInterval(sweep, 3600_000); cleanup.unref();
  function itemFor(req) {
    const item = uploads.get(req.params.id);
    if (!item || item.user !== owns(req)?.id || item.updated + TTL <= now()) throw error(404, "上传任务已过期，请重新选择文件");
    return item;
  }
  const state = item => ({ id: item.id, offset: item.offset, size: item.size, chunkBytes: UPLOAD_CHUNK_BYTES });
  router.post("/", wrap(async (req, res) => {
    const filename = uploadFilename(req.body?.filename), size = req.body?.size;
    if (!Number.isSafeInteger(size) || size < 12 || size > UPLOAD_MAX_BYTES) throw error(400, "单个视频最大为 8 GiB");
    if (writing) throw error(409, "正在接收视频分块，请稍后再试");
    writing = true;
    try {
      for (const item of uploads.values()) if (!item.busy && item.updated + TTL <= now()) await discard(item);
      if (uploads.size >= 2) throw error(429, "最多保留两个上传任务，请先完成或取消已有任务");
      const dirs = await directories(), space = await statfs(dirs.temp);
      const reserved = [...uploads.values()].reduce((sum, v) => sum + v.size - v.offset, 0);
      if (space.bavail * space.bsize - reserved < size + reserveBytes) throw error(507, "硬盘可用空间不足，需额外保留 1 GiB 空间");
      const id = randomUUID(), temp = path.join(dirs.temp, `${id}.part`);
      const handle = await open(temp, "wx", 0o600); await handle.close();
      const item = { id, user: owns(req).id, filename, size, offset: 0, temp, final: dirs.final, updated: now(), busy: false };
      uploads.set(id, item); res.status(201).json(state(item));
    } finally { writing = false; }
  }));
  router.get("/:id", wrap(async (req, res) => res.json(state(itemFor(req)))));
  const raw = express.raw({ type: "application/octet-stream", limit: UPLOAD_CHUNK_BYTES });
  router.put("/:id", (req, res) => {
    try {
      const item = itemFor(req);
      if (writing || item.busy) throw error(409, "正在写入上一分块，请稍后再试");
      const offset = Number(req.get("x-upload-offset"));
      if (!req.is("application/octet-stream")) throw error(415, "分块类型无效");
      if (!Number.isSafeInteger(offset) || offset !== item.offset) throw error(409, "上传进度已变化，请继续上传");
      writing = true; item.busy = true;
      const release = () => { writing = false; item.busy = false; };
      raw(req, res, async e => {
        let handle;
        try {
          if (e) throw error(e.status === 413 ? 413 : 400, "上传分块不完整或过大，请继续上传");
          if (!owns(req)) throw error(401, "登录已过期");
          if (!Buffer.isBuffer(req.body) || !req.body.length || item.offset + req.body.length > item.size) throw error(400, "上传分块大小无效");
          handle = await open(item.temp, constants.O_RDWR | constants.O_NOFOLLOW);
          let written = 0;
          while (written < req.body.length) {
            const result = await handle.write(req.body, written, req.body.length - written, offset + written);
            if (!result.bytesWritten) throw new Error("Short write");
            written += result.bytesWritten;
          }
          await handle.sync(); await handle.close(); handle = null;
          item.offset += written; item.updated = now();
          res.json(state(item));
        } catch (err) {
          await handle?.truncate(offset).catch(() => {});
          if (!res.headersSent) res.status(err.status || 503).json({ error: err.status ? err.message : "硬盘写入失败，请重试" });
        } finally { if (handle) await handle.close().catch(() => {}); release(); }
      });
    } catch (e) { res.status(e.status || 503).json({ error: e.message }); }
  });
  router.post("/:id/complete", wrap(async (req, res) => {
    const item = itemFor(req);
    if (writing || item.busy) throw error(409, "视频仍在上传");
    if (item.offset !== item.size) throw error(409, "视频尚未完整上传");
    writing = true; item.busy = true;
    try {
      const dirs = await directories(); if (dirs.final !== item.final || path.dirname(item.temp) !== dirs.temp) throw error(409, "硬盘路径已变化");
      const handle = await open(item.temp, constants.O_RDONLY | constants.O_NOFOLLOW);
      const header = Buffer.alloc(16); const { bytesRead } = await handle.read(header, 0, 16, 0); const stats = await handle.stat(); await handle.close();
      if (stats.size !== item.size || !supportedVideoHeader(header.subarray(0, bytesRead), item.filename)) { await discard(item); throw error(400, "文件内容不是支持的视频格式"); }
      const filename = `${item.id.slice(0, 8)}-${item.filename}`, destination = path.join(item.final, filename);
      try { await lstat(destination); throw error(409, "目标文件已存在"); } catch (e) { if (e.code !== "ENOENT") throw e; }
      if (!owns(req)) throw error(401, "登录已过期");
      await rename(item.temp, destination); uploads.delete(item.id); onComplete();
      res.json({ saved: true, filename: `网站上传/${filename}` });
    } finally { writing = false; item.busy = false; }
  }));
  router.delete("/:id", wrap(async (req, res) => { const item = itemFor(req); if (writing || item.busy) throw error(409, "正在写入，请稍后取消"); await discard(item); res.sendStatus(204); }));
  void sweep();
  return { router, close() { clearInterval(cleanup); } };
}
