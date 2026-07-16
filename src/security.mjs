import { timingSafeEqual } from "node:crypto";

export function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ""));
  const b = Buffer.from(String(right ?? ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseCookies(header = "") {
  return String(header).split(";").reduce((cookies, part) => {
    const separator = part.indexOf("=");
    if (separator < 1) return cookies;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try { cookies[name] = decodeURIComponent(value); } catch { cookies[name] = value; }
    return cookies;
  }, {});
}

export function isSameOriginWrite({ origin, host, protocol, fetchSite }) {
  const site = String(fetchSite || "").toLowerCase();
  if (site === "cross-site") return false;
  // Browsers set Sec-Fetch-Site themselves. Trust an explicit same-origin
  // signal so IPv6 access and trusted proxies do not fail merely because the
  // public Host/protocol differs from the backend connection.
  if (site === "same-origin") return true;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.host === host && parsed.protocol === `${protocol}:`;
  } catch {
    return false;
  }
}

export function isLoopbackHost(host = "") {
  try {
    const hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}
