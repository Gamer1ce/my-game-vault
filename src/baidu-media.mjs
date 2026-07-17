import path from "node:path";

const AUTHORIZE_ENDPOINT = "https://openapi.baidu.com/oauth/2.0/authorize";
const TOKEN_ENDPOINT = "https://openapi.baidu.com/oauth/2.0/token";
const FILE_ENDPOINT = "https://pan.baidu.com/rest/2.0/xpan/file";
const MULTIMEDIA_ENDPOINT = "https://pan.baidu.com/rest/2.0/xpan/multimedia";

const videoExtensions = new Set([".mp4", ".webm", ".mov", ".m4v", ".mkv"]);

function clean(value) {
  return String(value || "").trim();
}

export function baiduMediaConfiguration(environment = process.env, savedToken = {}) {
  const folder = clean(environment.BAIDU_MEDIA_FOLDER) || "/";
  if (!folder.startsWith("/") || folder.includes("\0")) throw new Error("百度网盘目录必须是以 / 开头的绝对路径");
  return {
    clientId: clean(environment.BAIDU_CLIENT_ID) || null,
    clientSecret: clean(environment.BAIDU_CLIENT_SECRET) || null,
    redirectUri: clean(environment.BAIDU_REDIRECT_URI) || "http://127.0.0.1:4174/callback",
    accessToken: clean(environment.BAIDU_ACCESS_TOKEN) || clean(savedToken.access_token) || null,
    refreshToken: clean(savedToken.refresh_token) || null,
    folder: path.posix.normalize(folder),
    testFilename: clean(environment.BAIDU_TEST_FILENAME) || null,
    playbackOrigin: clean(environment.BAIDU_PLAYBACK_ORIGIN) || null
  };
}

export function createAuthorizationUrl(config, state) {
  if (!config.clientId) throw new Error("缺少 BAIDU_CLIENT_ID");
  if (!config.redirectUri) throw new Error("缺少 BAIDU_REDIRECT_URI");
  const url = new URL(AUTHORIZE_ENDPOINT);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", "basic,netdisk");
  url.searchParams.set("display", "popup");
  if (state) url.searchParams.set("state", state);
  return url.href;
}

async function readJson(response, label) {
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${label}返回了无法解析的响应（HTTP ${response.status}）`);
  }
  if (!response.ok || body.error || Number(body.errno || 0) !== 0) {
    const code = body.error || body.errno || response.status;
    const message = body.error_description || body.errmsg || body.request_id || "未知错误";
    throw new Error(`${label}失败（${code}）：${message}`);
  }
  return body;
}

export async function exchangeAuthorizationCode(config, code, fetchImpl = fetch) {
  if (!config.clientId || !config.clientSecret) throw new Error("缺少 BAIDU_CLIENT_ID 或 BAIDU_CLIENT_SECRET");
  if (!clean(code)) throw new Error("百度授权没有返回 code");
  const url = new URL(TOKEN_ENDPOINT);
  url.searchParams.set("grant_type", "authorization_code");
  url.searchParams.set("code", clean(code));
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("client_secret", config.clientSecret);
  url.searchParams.set("redirect_uri", config.redirectUri);
  const response = await fetchImpl(url, { method: "POST", headers: { Accept: "application/json" } });
  return readJson(response, "交换百度授权令牌");
}

export async function refreshBaiduAccessToken(config, refreshToken, fetchImpl = fetch) {
  if (!config.clientId || !config.clientSecret) throw new Error("缺少 BAIDU_CLIENT_ID 或 BAIDU_CLIENT_SECRET");
  if (!clean(refreshToken)) throw new Error("缺少百度 refresh_token");
  const url = new URL(TOKEN_ENDPOINT);
  url.searchParams.set("grant_type", "refresh_token");
  url.searchParams.set("refresh_token", clean(refreshToken));
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("client_secret", config.clientSecret);
  const response = await fetchImpl(url, { method: "POST", headers: { Accept: "application/json" } });
  return readJson(response, "刷新百度授权令牌");
}

export async function listBaiduDirectory(config, fetchImpl = fetch) {
  if (!config.accessToken) throw new Error("缺少百度 access_token，请先完成授权");
  const files = [];
  const pageSize = 1000;
  for (let start = 0; start < 20_000; start += pageSize) {
    const url = new URL(FILE_ENDPOINT);
    url.searchParams.set("method", "list");
    url.searchParams.set("access_token", config.accessToken);
    url.searchParams.set("dir", config.folder);
    url.searchParams.set("start", String(start));
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("web", "1");
    url.searchParams.set("order", "time");
    url.searchParams.set("desc", "1");
    const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
    const result = await readJson(response, "读取百度网盘目录");
    const page = Array.isArray(result.list) ? result.list : [];
    files.push(...page);
    if (page.length < pageSize || result.has_more === 0) break;
  }
  return files;
}

export function baiduVideoFiles(files) {
  return (Array.isArray(files) ? files : []).filter((item) => {
    if (Number(item?.isdir || 0) !== 0) return false;
    return videoExtensions.has(path.posix.extname(String(item.server_filename || item.path || "")).toLowerCase());
  });
}

export async function getBaiduDownloadLink(config, fsId, fetchImpl = fetch) {
  if (!config.accessToken) throw new Error("缺少百度 access_token，请先完成授权");
  if (!String(fsId || "").trim()) throw new Error("视频缺少 fs_id");
  const url = new URL(MULTIMEDIA_ENDPOINT);
  url.searchParams.set("method", "filemetas");
  url.searchParams.set("access_token", config.accessToken);
  url.searchParams.set("fsids", JSON.stringify([Number(fsId)]));
  url.searchParams.set("dlink", "1");
  const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
  const result = await readJson(response, "获取百度网盘播放地址");
  const item = result.list?.[0];
  if (!item?.dlink) throw new Error("百度接口没有返回 dlink；应用可能没有下载权限");
  const dlink = new URL(item.dlink);
  if (!dlink.searchParams.has("access_token")) dlink.searchParams.set("access_token", config.accessToken);
  return { url: dlink.href, metadata: item };
}

function safeHeader(response, name) {
  return response.headers.get(name) || null;
}

export async function probeBaiduPlayback(url, {
  fetchImpl = fetch,
  origin = null,
  userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1",
  timeoutMs = 20_000
} = {}) {
  const headers = { Range: "bytes=0-65535", "User-Agent": userAgent, Accept: "video/*,*/*;q=0.8" };
  if (origin) headers.Origin = origin;
  let response;
  try {
    response = await fetchImpl(url, { headers, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    const result = {
      status: response.status,
      ok: response.ok,
      rangeSupported: response.status === 206 && /^bytes\s+0-/i.test(safeHeader(response, "content-range") || ""),
      acceptRanges: safeHeader(response, "accept-ranges"),
      contentRange: safeHeader(response, "content-range"),
      contentLength: Number(safeHeader(response, "content-length") || 0) || null,
      contentType: safeHeader(response, "content-type"),
      cors: safeHeader(response, "access-control-allow-origin"),
      finalHost: (() => { try { return new URL(response.url).host; } catch { return null; } })()
    };
    await response.body?.cancel();
    return result;
  } catch (error) {
    try { await response?.body?.cancel(); } catch { /* 忽略流取消错误 */ }
    return { status: 0, ok: false, rangeSupported: false, error: error?.message || String(error) };
  }
}

export const baiduMediaEndpoints = Object.freeze({
  authorize: AUTHORIZE_ENDPOINT,
  token: TOKEN_ENDPOINT,
  file: FILE_ENDPOINT,
  multimedia: MULTIMEDIA_ENDPOINT
});
