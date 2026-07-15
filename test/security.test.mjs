import test from "node:test";
import assert from "node:assert/strict";
import { isLoopbackHost, isSameOriginWrite, parseCookies, safeEqual } from "../src/security.mjs";

test("管理凭据使用固定时间比较", () => {
  assert.equal(safeEqual("admin", "admin"), true);
  assert.equal(safeEqual("admin", "guest"), false);
  assert.equal(safeEqual("short", "much-longer"), false);
});

test("解析管理会话 Cookie", () => {
  assert.deepEqual(parseCookies("theme=dark; mgv_admin=a%2Fb%3D; empty="), {
    theme: "dark",
    mgv_admin: "a/b=",
    empty: ""
  });
});

test("拒绝跨站写操作并允许同源请求", () => {
  assert.equal(isSameOriginWrite({ origin: "https://games.example.com", host: "games.example.com", protocol: "https", fetchSite: "same-origin" }), true);
  assert.equal(isSameOriginWrite({ origin: "https://evil.example", host: "games.example.com", protocol: "https", fetchSite: "cross-site" }), false);
  assert.equal(isSameOriginWrite({ origin: "http://games.example.com", host: "games.example.com", protocol: "https", fetchSite: "same-site" }), false);
  assert.equal(isSameOriginWrite({ origin: null, host: "games.example.com", protocol: "https", fetchSite: "none" }), true);
});

test("只有回环地址可通过明文 HTTP 管理", () => {
  assert.equal(isLoopbackHost("localhost:4173"), true);
  assert.equal(isLoopbackHost("127.0.0.1:4173"), true);
  assert.equal(isLoopbackHost("[::1]:4173"), true);
  assert.equal(isLoopbackHost("frp-can.com:54319"), false);
  assert.equal(isLoopbackHost("192.168.1.20:4173"), false);
});
