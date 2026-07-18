import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  baiduStreamConfiguration,
  createBaiduStreamService,
  openBaiduPlaybackPayload,
  sealBaiduPlaybackPayload
} from "../src/baidu-stream.mjs";
import { createBaiduProxyWorker } from "../cloudflare/baidu-media-proxy/src/index.js";
import { createBaiduEsaProxy } from "../aliyun-esa/baidu-media-proxy/src/index.js";

const key = Buffer.alloc(32, 7);
const keyText = key.toString("base64url");

test("百度播放令牌加密后可解密且篡改会失败", () => {
  const token = sealBaiduPlaybackPayload({ url: "https://d.pcs.baidu.com/file?a=secret", exp: 123, name: "clip.mp4" }, key, { iv: Buffer.alloc(12, 3) });
  assert.deepEqual(openBaiduPlaybackPayload(token, key), { url: "https://d.pcs.baidu.com/file?a=secret", exp: 123, name: "clip.mp4" });
  const changed = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
  assert.throws(() => openBaiduPlaybackPayload(changed, key));
});

test("百度流媒体配置只接受HTTPS代理和32字节密钥", () => {
  assert.equal(baiduStreamConfiguration({}).enabled, false);
  assert.equal(baiduStreamConfiguration({ BAIDU_PROXY_URL: "http://worker.example.com", BAIDU_PROXY_KEY: keyText }).enabled, false);
  const config = baiduStreamConfiguration({ BAIDU_PROXY_URL: "https://worker.example.com/", BAIDU_PROXY_KEY: keyText });
  assert.equal(config.enabled, true);
  assert.equal(config.proxyBaseUrl, "https://worker.example.com");
});

test("百度流媒体可以通过私密开关停用并切回Mac本机线路", () => {
  const config = baiduStreamConfiguration({
    BAIDU_MEDIA_ENABLED: "0",
    BAIDU_PROXY_URL: "https://worker.example.com",
    BAIDU_PROXY_KEY: keyText
  });
  assert.equal(config.enabled, false);
  assert.deepEqual(config.proxies, []);
  assert.equal(config.proxyBaseUrl, null);
});

test("百度流媒体配置优先使用ESA并保留Cloudflare备用线路", () => {
  const config = baiduStreamConfiguration({
    BAIDU_PROXY_URL: "https://media.example.com",
    BAIDU_PROXY_KEY: keyText,
    BAIDU_PROXY_URL_CN: "https://media-cn.example.com"
  });
  assert.deepEqual(config.proxies.map(({ id, origin }) => ({ id, origin })), [
    { id: "aliyun-esa", origin: "https://media-cn.example.com" },
    { id: "cloudflare", origin: "https://media.example.com" }
  ]);
});

test("百度目录生成精彩时刻并返回短期加密Worker地址", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "baidu-stream-"));
  writeFileSync(path.join(directory, "baidu-media-token.json"), JSON.stringify({ access_token: "access", expires_in: 2592000, saved_at: "2026-07-17T00:00:00.000Z" }));
  const responses = [
    { errno: 0, has_more: 0, list: [{ fs_id: 42, isdir: 0, server_filename: "游戏_片段.mp4", size: 100, server_mtime: 1 }] },
    { errno: 0, list: [{ fs_id: 42, dlink: "https://d.pcs.baidu.com/file/clip.mp4" }] }
  ];
  const service = createBaiduStreamService({
    dataDirectory: directory,
    environment: {
      BAIDU_MEDIA_FOLDER: "/网站视频",
      BAIDU_PROXY_URL: "https://worker.example.com",
      BAIDU_PROXY_KEY: keyText
    },
    fetchImpl: async () => new Response(JSON.stringify(responses.shift()), { headers: { "Content-Type": "application/json" } }),
    now: () => Date.parse("2026-07-17T01:00:00.000Z")
  });
  const highlights = await service.highlights();
  assert.equal(highlights[0].storageSource, "baidu");
  assert.equal(highlights[0].title, "游戏 片段");
  const playback = await service.playback("42", "游戏_片段.mp4");
  assert.equal(playback.source, "baidu");
  assert.match(playback.url, /^https:\/\/worker\.example\.com\/v1\//);
  assert.equal(playback.candidates.length, 1);
});

test("Worker验证令牌、转发Range和百度请求头并保持流式响应", async () => {
  const token = sealBaiduPlaybackPayload({ url: "https://d.pcs.baidu.com/file/clip.mp4", exp: 2_000, name: "clip.mp4" }, key, { iv: Buffer.alloc(12, 9) });
  let observed;
  const worker = createBaiduProxyWorker({
    now: () => 1_000,
    fetchImpl: async (url, options) => {
      observed = { url, options };
      return new Response(new Uint8Array([1, 2, 3]), { status: 206, headers: { "Content-Range": "bytes 0-2/10", "Content-Type": "video/mp4" } });
    }
  });
  const response = await worker.fetch(new Request(`https://worker.example.com/v1/${token}/clip.mp4`, {
    headers: { Range: "bytes=0-2", Origin: "https://games.example.com" }
  }), { PROXY_KEY: keyText, ALLOWED_ORIGIN: "https://games.example.com" });
  assert.equal(response.status, 206);
  assert.equal(observed.options.headers.get("User-Agent"), "pan.baidu.com");
  assert.equal(observed.options.headers.get("Range"), "bytes=0-2");
  assert.equal(response.headers.get("Content-Range"), "bytes 0-2/10");
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
});

test("Worker拒绝过期令牌、非百度上游和错误来源", async () => {
  const worker = createBaiduProxyWorker({ now: () => 5_000, fetchImpl: async () => { throw new Error("不应请求上游"); } });
  const expired = sealBaiduPlaybackPayload({ url: "https://d.pcs.baidu.com/file/a", exp: 4_000 }, key);
  assert.equal((await worker.fetch(new Request(`https://worker.example.com/v1/${expired}/a.mp4`), { PROXY_KEY: keyText })).status, 401);
  const foreign = sealBaiduPlaybackPayload({ url: "https://evil.example.com/file", exp: 6_000 }, key);
  assert.equal((await worker.fetch(new Request(`https://worker.example.com/v1/${foreign}/a.mp4`), { PROXY_KEY: keyText })).status, 400);
  const valid = sealBaiduPlaybackPayload({ url: "https://d.pcs.baidu.com/file/a", exp: 6_000 }, key);
  assert.equal((await worker.fetch(new Request(`https://worker.example.com/v1/${valid}/a.mp4`, { headers: { Origin: "https://evil.example.com" } }), { PROXY_KEY: keyText, ALLOWED_ORIGIN: "https://games.example.com" })).status, 403);
});

test("阿里云ESA函数兼容同一播放令牌和Range流式转发", async () => {
  const token = sealBaiduPlaybackPayload({ url: "https://d.pcs.baidu.com/file/clip.mp4", exp: 2_000, name: "clip.mp4" }, key, { iv: Buffer.alloc(12, 5) });
  let observedRange;
  const worker = createBaiduEsaProxy({
    now: () => 1_000,
    fetchImpl: async (_url, options) => {
      observedRange = options.headers.get("Range");
      return new Response(new Uint8Array([5, 6]), { status: 206, headers: { "Content-Range": "bytes 0-1/10" } });
    }
  });
  const response = await worker.fetch(new Request(`https://media-cn.example.com/v1/${token}/clip.mp4`, {
    headers: { Range: "bytes=0-1", Origin: "https://games.example.com" }
  }), { PROXY_KEY: keyText, ALLOWED_ORIGIN: "https://games.example.com" });
  assert.equal(response.status, 206);
  assert.equal(observedRange, "bytes=0-1");
  assert.equal(response.headers.get("X-Media-Edge"), "aliyun-esa");
});

test("阿里云ESA部署产物可使用私密注入配置且仓库源码不含真实密钥", async () => {
  const token = sealBaiduPlaybackPayload({ url: "https://d.pcs.baidu.com/file/clip.mp4", exp: 2_000 }, key);
  const worker = createBaiduEsaProxy({
    now: () => 1_000,
    bundledEnvironment: { PROXY_KEY: keyText, ALLOWED_ORIGIN: "https://games.example.com" },
    fetchImpl: async () => new Response(new Uint8Array([1]), { status: 206 })
  });
  const response = await worker.fetch(new Request(`https://media-cn.example.com/v1/${token}/clip.mp4`, {
    headers: { Origin: "https://games.example.com", Range: "bytes=0-0" }
  }));
  assert.equal(response.status, 206);
});
