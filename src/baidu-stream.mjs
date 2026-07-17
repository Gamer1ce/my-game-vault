import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  baiduMediaConfiguration,
  baiduVideoFiles,
  getBaiduDownloadLink,
  listBaiduDirectory,
  refreshBaiduAccessToken
} from "./baidu-media.mjs";

const tokenFilename = "baidu-media-token.json";

function text(value) {
  return String(value || "").trim();
}

function httpsOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function proxyKey(value) {
  const raw = text(value);
  if (!raw) return null;
  try {
    const key = Buffer.from(raw, "base64url");
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

function enabledFlag(value, fallback = true) {
  const normalized = text(value).toLowerCase();
  if (!normalized) return fallback;
  return !["0", "false", "off", "no", "disabled"].includes(normalized);
}

export function baiduStreamConfiguration(environment = process.env) {
  const mediaEnabled = enabledFlag(environment.BAIDU_MEDIA_ENABLED);
  const definitions = [
    {
      id: "aliyun-esa",
      label: "阿里云 ESA",
      baseUrl: environment.BAIDU_PROXY_URL_CN,
      key: environment.BAIDU_PROXY_KEY_CN || environment.BAIDU_PROXY_KEY
    },
    {
      id: "cloudflare",
      label: "Cloudflare",
      baseUrl: environment.BAIDU_PROXY_URL,
      key: environment.BAIDU_PROXY_KEY
    }
  ];
  const proxies = definitions.map((definition) => {
    const baseUrl = text(definition.baseUrl).replace(/\/+$/, "") || null;
    const origin = httpsOrigin(baseUrl);
    const key = proxyKey(definition.key);
    return { ...definition, baseUrl: origin ? baseUrl : null, origin, key };
  }).filter((proxy) => proxy.origin && proxy.key);
  const activeProxies = mediaEnabled ? proxies : [];
  const primary = activeProxies[0] || null;
  const requestedTtl = Number(environment.BAIDU_PROXY_TOKEN_TTL_SECONDS || 600);
  const tokenTtlSeconds = Math.max(60, Math.min(900, Number.isFinite(requestedTtl) ? Math.round(requestedTtl) : 600));
  return {
    proxies: activeProxies,
    proxyBaseUrl: primary?.baseUrl || null,
    proxyOrigin: primary?.origin || null,
    key: primary?.key || null,
    tokenTtlSeconds,
    cacheTtlMs: 5 * 60_000,
    enabled: activeProxies.length > 0
  };
}

export function sealBaiduPlaybackPayload(payload, key, { iv = randomBytes(12) } = {}) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("百度代理密钥必须是32字节");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}

export function openBaiduPlaybackPayload(token, key) {
  const packed = Buffer.from(String(token || ""), "base64url");
  if (packed.length < 30 || packed[0] !== 1) throw new Error("百度播放令牌无效");
  const decipher = createDecipheriv("aes-256-gcm", key, packed.subarray(1, 13));
  decipher.setAuthTag(packed.subarray(13, 29));
  return JSON.parse(Buffer.concat([decipher.update(packed.subarray(29)), decipher.final()]).toString("utf8"));
}

function readSavedToken(dataDirectory) {
  const file = path.join(dataDirectory, tokenFilename);
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8"));
}

function saveToken(dataDirectory, token) {
  const target = path.join(dataDirectory, tokenFilename);
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
  chmodSync(target, 0o600);
}

function tokenExpiresSoon(token, now = Date.now()) {
  const saved = Date.parse(token?.saved_at || "");
  const lifetime = Number(token?.expires_in || 0) * 1000;
  return !Number.isFinite(saved) || !lifetime || saved + lifetime - 24 * 60 * 60_000 <= now;
}

function highlightTitle(filename) {
  return path.posix.basename(filename, path.posix.extname(filename)).replace(/_+/g, " ").trim() || "未命名精彩时刻";
}

export function createBaiduStreamService({ dataDirectory, environment = process.env, fetchImpl = fetch, now = () => Date.now() } = {}) {
  const stream = baiduStreamConfiguration(environment);
  let cache = { expiresAt: 0, items: [] };

  async function authorizedConfig() {
    let saved = readSavedToken(dataDirectory);
    let config = baiduMediaConfiguration(environment, saved);
    if (!config.accessToken) throw new Error("尚未完成百度网盘授权");
    if (tokenExpiresSoon(saved, now()) && saved.refresh_token) {
      const refreshed = await refreshBaiduAccessToken(config, saved.refresh_token, fetchImpl);
      saved = { ...refreshed, saved_at: new Date(now()).toISOString() };
      saveToken(dataDirectory, saved);
      config = baiduMediaConfiguration(environment, saved);
    }
    return config;
  }

  async function rawItems({ force = false } = {}) {
    if (!stream.enabled) return [];
    if (!force && cache.expiresAt > now()) return cache.items;
    const config = await authorizedConfig();
    const items = baiduVideoFiles(await listBaiduDirectory(config, fetchImpl));
    cache = { items, expiresAt: now() + stream.cacheTtlMs };
    return items;
  }

  return {
    config: stream,
    isEnabled() {
      return stream.enabled;
    },
    allowedMediaSources() {
      return stream.proxies.map((proxy) => proxy.origin);
    },
    async highlights() {
      const items = await rawItems();
      return items.map((item) => ({
        filename: item.server_filename,
        title: highlightTitle(item.server_filename),
        type: "video",
        url: null,
        size: Number(item.size || 0),
        modifiedAt: Number(item.server_mtime || 0) > 0 ? new Date(Number(item.server_mtime) * 1000).toISOString() : null,
        remoteAvailable: true,
        storageSource: "baidu",
        playbackId: String(item.fs_id)
      })).sort((a, b) => a.size - b.size || String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || "")));
    },
    async playback(playbackId, filename) {
      if (!stream.enabled) return null;
      const items = await rawItems();
      const item = items.find((candidate) => String(candidate.fs_id) === String(playbackId)
        && candidate.server_filename === filename);
      if (!item) return null;
      const config = await authorizedConfig();
      const download = await getBaiduDownloadLink(config, item.fs_id, fetchImpl);
      const expiresAt = now() + stream.tokenTtlSeconds * 1000;
      const candidates = stream.proxies.map((proxy) => {
        const token = sealBaiduPlaybackPayload({ url: download.url, exp: expiresAt, name: filename }, proxy.key);
        return {
          id: proxy.id,
          label: proxy.label,
          url: `${proxy.baseUrl}/v1/${token}/${encodeURIComponent(filename)}`
        };
      });
      return {
        url: candidates[0].url,
        candidates,
        source: "baidu",
        expiresIn: stream.tokenTtlSeconds
      };
    }
  };
}

export const baiduTokenFilename = tokenFilename;
