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
  if (fetchSite === "cross-site") return false;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.host === host && parsed.protocol === `${protocol}:`;
  } catch {
    return false;
  }
}
