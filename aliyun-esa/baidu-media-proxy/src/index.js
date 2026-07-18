const BUNDLED_ENVIRONMENT = Object.freeze({
  PROXY_KEY: "__ESA_PROXY_KEY__",
  ALLOWED_ORIGIN: "__ESA_ALLOWED_ORIGIN__"
});

function decodeBase64Url(value) {
  const base64 = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function decryptPayload(token, secret) {
  const packed = decodeBase64Url(token);
  if (packed.length < 30 || packed[0] !== 1) throw new Error("invalid token");
  const keyBytes = decodeBase64Url(secret);
  if (keyBytes.length !== 32) throw new Error("invalid proxy key");
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const encrypted = new Uint8Array(packed.length - 13);
  encrypted.set(packed.subarray(29), 0);
  encrypted.set(packed.subarray(13, 29), packed.length - 29);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: packed.subarray(1, 13), tagLength: 128 }, key, encrypted);
  return JSON.parse(new TextDecoder().decode(plain));
}

function allowedUpstream(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "d.pcs.baidu.com" || url.hostname.endsWith(".baidupcs.com"));
  } catch {
    return false;
  }
}

function requestOriginAllowed(request, configuredOrigin) {
  if (!configuredOrigin) return true;
  const origin = request.headers.get("Origin");
  if (origin && origin !== configuredOrigin) return false;
  const referer = request.headers.get("Referer");
  if (referer) {
    try { if (new URL(referer).origin !== configuredOrigin) return false; } catch { return false; }
  }
  return true;
}

function responseHeaders(upstream, allowedOrigin) {
  const headers = new Headers();
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified", "content-disposition"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("Cache-Control", "private, no-store");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  headers.set("Access-Control-Allow-Origin", allowedOrigin || "*");
  headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Range, If-Range");
  headers.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Media-Edge", "aliyun-esa");
  return headers;
}

function statusPage(allowedOrigin) {
  let mainSite = "https://gamer1ce.top";
  try { if (allowedOrigin) mainSite = new URL(allowedOrigin).origin; } catch {}
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>中枢圣殿 · 媒体节点</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080a0d;color:#f4f0df;font-family:system-ui,sans-serif}main{max-width:620px;padding:42px;border:1px solid #28e7f0;border-top:5px solid #f8e800;background:#0d1117}h1{margin:0 0 18px;color:#f8e800;font-size:clamp(30px,7vw,64px);letter-spacing:.04em}p{font-size:18px;line-height:1.7;color:#b8c0cc}a{display:inline-block;margin-top:16px;padding:13px 20px;background:#f8e800;color:#080a0d;font-weight:900;text-decoration:none}code{color:#28e7f0}</style></head>
<body><main><h1>媒体节点在线</h1><p>这里是中枢圣殿的阿里云 ESA 视频中继，不是主站首页。它只处理由主站签发的短期 <code>Range</code> 播放请求。</p><a href="${mainSite}">返回中枢圣殿主站</a></main></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'`,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "X-Media-Edge": "aliyun-esa"
    }
  });
}

function runtimeEnvironment(environment, bundledEnvironment) {
  if (environment?.PROXY_KEY) return environment;
  const processEnvironment = typeof process !== "undefined" ? process.env : {};
  if (processEnvironment?.PROXY_KEY) return processEnvironment;
  if (bundledEnvironment?.PROXY_KEY && !bundledEnvironment.PROXY_KEY.startsWith("__ESA_")) {
    return bundledEnvironment;
  }
  return {};
}

export function createBaiduEsaProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
  bundledEnvironment = BUNDLED_ENVIRONMENT
} = {}) {
  return {
    async fetch(request, suppliedEnvironment) {
      const environment = runtimeEnvironment(suppliedEnvironment, bundledEnvironment);
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: responseHeaders(new Response(), environment.ALLOWED_ORIGIN) });
      }
      if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      if (!requestOriginAllowed(request, environment.ALLOWED_ORIGIN)) return new Response("Forbidden", { status: 403 });
      const parts = new URL(request.url).pathname.split("/").filter(Boolean);
      if (parts.length === 0) return statusPage(environment.ALLOWED_ORIGIN);
      if (parts[0] !== "v1" || !parts[1]) return new Response("Not Found", { status: 404 });
      let payload;
      try {
        payload = await decryptPayload(parts[1], environment.PROXY_KEY);
      } catch {
        return new Response("Invalid playback token", { status: 401 });
      }
      if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) <= now()) return new Response("Playback token expired", { status: 401 });
      if (!allowedUpstream(payload.url)) return new Response("Upstream rejected", { status: 400 });

      const headers = new Headers({ "User-Agent": "pan.baidu.com", Accept: "video/*,*/*;q=0.8" });
      for (const name of ["Range", "If-Range", "If-None-Match"]) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
      const upstream = await fetchImpl(payload.url, { method: "GET", headers, redirect: "follow" });
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders(upstream, environment.ALLOWED_ORIGIN)
      });
    }
  };
}

export default createBaiduEsaProxy();
