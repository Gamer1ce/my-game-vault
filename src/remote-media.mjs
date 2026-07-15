import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const manifestFilename = "remote-media.json";

function text(value) {
  return String(value || "").trim();
}

function boolean(value) {
  return ["1", "true", "yes", "on"].includes(text(value).toLowerCase());
}

function httpsOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

export function remoteMediaConfiguration(environment = process.env) {
  const endpoint = text(environment.MEDIA_S3_ENDPOINT) || null;
  const region = text(environment.MEDIA_S3_REGION) || "auto";
  const bucket = text(environment.MEDIA_S3_BUCKET) || null;
  const accessKeyId = text(environment.MEDIA_S3_ACCESS_KEY_ID) || null;
  const secretAccessKey = text(environment.MEDIA_S3_SECRET_ACCESS_KEY) || null;
  const publicBaseUrl = text(environment.MEDIA_S3_PUBLIC_BASE_URL).replace(/\/+$/, "") || null;
  const prefix = text(environment.MEDIA_S3_PREFIX).replace(/^\/+|\/+$/g, "") || "highlights";
  const requestedTtl = Number(environment.MEDIA_SIGNED_URL_TTL_SECONDS || 1800);
  const signedUrlTtlSeconds = Math.max(60, Math.min(86_400, Number.isFinite(requestedTtl) ? Math.round(requestedTtl) : 1800));
  const credentialsReady = Boolean(accessKeyId && secretAccessKey);
  const uploadEnabled = Boolean(bucket && credentialsReady);
  const playbackEnabled = Boolean(publicBaseUrl || uploadEnabled);
  const allowedOrigin = httpsOrigin(publicBaseUrl || endpoint);

  return {
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    publicBaseUrl,
    prefix,
    forcePathStyle: boolean(environment.MEDIA_S3_FORCE_PATH_STYLE),
    signedUrlTtlSeconds,
    uploadEnabled,
    playbackEnabled,
    allowedOrigin
  };
}

export function remoteObjectKey(prefix, filename) {
  const name = String(filename || "");
  if (!name || name.startsWith(".") || path.basename(name) !== name || name.includes("\0")) throw new Error("媒体文件名无效");
  const cleanPrefix = String(prefix || "").replace(/^\/+|\/+$/g, "");
  return cleanPrefix ? `${cleanPrefix}/${name}` : name;
}

export function publicObjectUrl(baseUrl, key) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!httpsOrigin(base)) throw new Error("远程媒体公开地址必须使用 HTTPS");
  return `${base}/${String(key).split("/").map(encodeURIComponent).join("/")}`;
}

export function readRemoteMediaManifest(dataDirectory) {
  const manifestPath = path.join(dataDirectory, manifestFilename);
  if (!existsSync(manifestPath)) return { version: 1, updatedAt: null, files: {} };
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (parsed?.version !== 1 || !parsed.files || typeof parsed.files !== "object" || Array.isArray(parsed.files)) throw new Error("版本不受支持");
    return parsed;
  } catch (error) {
    throw new Error(`远程媒体清单无效：${error.message}`);
  }
}

export function mergeRemoteHighlights(localHighlights, manifest, { remoteEnabled = true } = {}) {
  if (!remoteEnabled) return localHighlights.map((item) => ({ ...item, remoteAvailable: false }));
  const remoteFiles = manifest?.files && typeof manifest.files === "object" ? manifest.files : {};
  const localNames = new Set(localHighlights.map((item) => item.filename));
  const merged = localHighlights.map((item) => ({ ...item, remoteAvailable: Boolean(remoteFiles[item.filename]) }));

  for (const [filename, item] of Object.entries(remoteFiles)) {
    if (localNames.has(filename) || item?.type !== "video") continue;
    merged.push({
      filename,
      title: item.title || filename,
      type: "video",
      url: null,
      size: Number(item.size || 0),
      modifiedAt: item.modifiedAt || item.uploadedAt || null,
      remoteAvailable: true
    });
  }

  return merged.sort((a, b) => Number(a.size || 0) - Number(b.size || 0)
    || String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || ""))
    || a.filename.localeCompare(b.filename, "zh-CN"));
}

export function createRemoteMediaClient(config) {
  if (!config.uploadEnabled) throw new Error("远程媒体S3配置不完整");
  return new S3Client({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
  });
}

export function createRemoteMediaService({ dataDirectory, environment = process.env, signer = getSignedUrl } = {}) {
  const config = remoteMediaConfiguration(environment);
  const client = config.publicBaseUrl || !config.uploadEnabled ? null : createRemoteMediaClient(config);

  return {
    config,
    manifest() {
      return readRemoteMediaManifest(dataDirectory);
    },
    isEnabled() {
      return config.playbackEnabled;
    },
    allowedMediaSource() {
      if (!config.playbackEnabled) return null;
      // S3 SDK 可能把Bucket写入虚拟主机名，私有签名链接因此不一定与API端点同源。
      return config.publicBaseUrl ? config.allowedOrigin : "https:";
    },
    async playback(filename) {
      if (!config.playbackEnabled) return null;
      const item = this.manifest().files[filename];
      if (!item?.key) return null;
      if (config.publicBaseUrl) {
        return { url: publicObjectUrl(config.publicBaseUrl, item.key), source: "remote", expiresIn: null };
      }
      const command = new GetObjectCommand({
        Bucket: config.bucket,
        Key: item.key,
        ResponseContentDisposition: "inline",
        ...(item.contentType ? { ResponseContentType: item.contentType } : {})
      });
      const url = await signer(client, command, { expiresIn: config.signedUrlTtlSeconds });
      return { url, source: "remote", expiresIn: config.signedUrlTtlSeconds };
    }
  };
}

export const remoteMediaManifestFilename = manifestFilename;
