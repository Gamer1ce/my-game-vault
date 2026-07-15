import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createRemoteMediaService,
  mergeRemoteHighlights,
  publicObjectUrl,
  readRemoteMediaManifest,
  remoteMediaConfiguration,
  remoteObjectKey
} from "../src/remote-media.mjs";

test("远程媒体配置默认关闭且限制签名时长", () => {
  assert.equal(remoteMediaConfiguration({}).playbackEnabled, false);
  const config = remoteMediaConfiguration({
    MEDIA_S3_BUCKET: "vault",
    MEDIA_S3_ACCESS_KEY_ID: "key",
    MEDIA_S3_SECRET_ACCESS_KEY: "secret",
    MEDIA_SIGNED_URL_TTL_SECONDS: "999999"
  });
  assert.equal(config.uploadEnabled, true);
  assert.equal(config.playbackEnabled, true);
  assert.equal(config.signedUrlTtlSeconds, 86_400);
  const service = createRemoteMediaService({ dataDirectory: mkdtempSync(path.join(tmpdir(), "remote-source-")), environment: {
    MEDIA_S3_BUCKET: "vault",
    MEDIA_S3_ACCESS_KEY_ID: "key",
    MEDIA_S3_SECRET_ACCESS_KEY: "secret",
    MEDIA_S3_ENDPOINT: "https://s3.example.com"
  } });
  assert.equal(service.allowedMediaSource(), "https:");
});

test("对象键拒绝路径穿越并正确编码公开URL", () => {
  assert.equal(remoteObjectKey("highlights", "游戏 录像.webm"), "highlights/游戏 录像.webm");
  assert.throws(() => remoteObjectKey("highlights", "../secret.mp4"), /文件名无效/);
  assert.equal(publicObjectUrl("https://media.example.com/", "highlights/游戏 录像.webm"), "https://media.example.com/highlights/%E6%B8%B8%E6%88%8F%20%E5%BD%95%E5%83%8F.webm");
  assert.throws(() => publicObjectUrl("http://media.example.com", "a.mp4"), /HTTPS/);
});

test("远程清单与本地精彩时刻合并并保留云端独有视频", () => {
  const local = [{ filename: "local.mp4", title: "Local", type: "video", url: "/media/highlights/local.mp4", size: 20, modifiedAt: "2026-01-02T00:00:00Z" }];
  const manifest = { version: 1, files: {
    "local.mp4": { key: "highlights/local.mp4", type: "video", size: 20 },
    "remote.mp4": { key: "highlights/remote.mp4", type: "video", title: "Remote", size: 10, uploadedAt: "2026-01-01T00:00:00Z" }
  } };
  const merged = mergeRemoteHighlights(local, manifest);
  assert.deepEqual(merged.map((item) => [item.filename, item.remoteAvailable, item.url]), [
    ["remote.mp4", true, null],
    ["local.mp4", true, "/media/highlights/local.mp4"]
  ]);
});

test("公开媒体地址只在点击播放时生成且不需要返回密钥", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "remote-media-"));
  writeFileSync(path.join(directory, "remote-media.json"), JSON.stringify({ version: 1, files: { "clip.mp4": { key: "vault/clip.mp4", type: "video" } } }));
  const service = createRemoteMediaService({
    dataDirectory: directory,
    environment: { MEDIA_S3_PUBLIC_BASE_URL: "https://cdn.example.com" }
  });
  assert.equal(service.isEnabled(), true);
  assert.deepEqual(await service.playback("clip.mp4"), {
    url: "https://cdn.example.com/vault/clip.mp4",
    source: "remote",
    expiresIn: null
  });
  assert.equal(await service.playback("missing.mp4"), null);
  assert.equal(readRemoteMediaManifest(directory).version, 1);
});

test("私有Bucket只返回短期签名播放地址", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "signed-media-"));
  writeFileSync(path.join(directory, "remote-media.json"), JSON.stringify({ version: 1, files: { "clip.mp4": { key: "vault/clip.mp4", type: "video/mp4" } } }));
  let expiresIn = 0;
  const service = createRemoteMediaService({
    dataDirectory: directory,
    environment: {
      MEDIA_S3_ENDPOINT: "https://s3.example.com",
      MEDIA_S3_BUCKET: "vault",
      MEDIA_S3_ACCESS_KEY_ID: "private-key",
      MEDIA_S3_SECRET_ACCESS_KEY: "private-secret",
      MEDIA_SIGNED_URL_TTL_SECONDS: "600"
    },
    signer: async (_client, _command, options) => {
      expiresIn = options.expiresIn;
      return "https://vault.s3.example.com/vault/clip.mp4?X-Amz-Signature=temporary";
    }
  });
  const playback = await service.playback("clip.mp4");
  assert.equal(expiresIn, 600);
  assert.equal(playback.expiresIn, 600);
  assert.match(playback.url, /X-Amz-Signature=temporary/);
  assert.doesNotMatch(JSON.stringify(playback), /private-secret|private-key/);
});
