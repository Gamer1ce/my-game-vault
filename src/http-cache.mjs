const revalidatingApiPaths = new Set([
  "/api/games",
  "/api/highlights",
  "/api/activity/recent",
  "/api/activity",
  "/api/providers",
  "/api/guestbook"
]);

export function apiCacheControl(method, pathname) {
  if (!String(pathname || "").startsWith("/api/")) return null;
  const readOnly = method === "GET" || method === "HEAD";
  return readOnly && revalidatingApiPaths.has(pathname)
    ? "private, no-cache"
    : "no-store";
}

export function staticCacheControl(pathname, { versioned = false } = {}) {
  const value = String(pathname || "/");
  const hasExtension = /\.[a-z0-9]+$/i.test(value);
  if (value === "/" || value.endsWith(".html") || !hasExtension) return "no-cache";
  if (versioned || /-v\d+(?=\.|$)/i.test(value)) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=3600, stale-while-revalidate=86400";
}
