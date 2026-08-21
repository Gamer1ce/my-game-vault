import assert from "node:assert/strict";
import test from "node:test";
import { apiCacheControl, staticCacheControl } from "../src/http-cache.mjs";

test("公开只读接口允许浏览器使用 ETag 重新验证", () => {
  assert.equal(apiCacheControl("GET", "/api/games"), "private, no-cache");
  assert.equal(apiCacheControl("HEAD", "/api/highlights"), "private, no-cache");
  assert.equal(apiCacheControl("GET", "/api/security"), "no-store");
  assert.equal(apiCacheControl("POST", "/api/guestbook"), "no-store");
});

test("带版本号的静态资源长期缓存，页面入口保持可更新", () => {
  assert.equal(staticCacheControl("/app.js", { versioned: true }), "public, max-age=31536000, immutable");
  assert.equal(staticCacheControl("/icons/app-icon-192-v3.png"), "public, max-age=31536000, immutable");
  assert.equal(staticCacheControl("/styles.css"), "public, max-age=3600, stale-while-revalidate=86400");
  assert.equal(staticCacheControl("/minecraft.html"), "no-cache");
  assert.equal(staticCacheControl("/"), "no-cache");
});
