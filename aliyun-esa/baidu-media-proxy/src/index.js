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
