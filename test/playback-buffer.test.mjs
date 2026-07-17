import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FULL_CACHE_LIMIT_BYTES, estimatedBufferWait, recommendedBufferTarget, shouldFullyCacheVideo } from "../public/playback-buffer.js";

test("线路快于视频码率时只需短缓存", () => {
  assert.equal(recommendedBufferTarget(120, 1.5), 12);
  assert.equal(recommendedBufferTarget(20, 2), 12);
});

test("线路慢于视频码率时按缺口增加缓存", () => {
  assert.equal(Math.round(recommendedBufferTarget(300, 0.4)), 204);
  assert.equal(Math.round(recommendedBufferTarget(300, 0.1)), 294);
  assert.equal(recommendedBufferTarget(60, 0), 60);
});

test("根据缓存速度估算剩余等待时间", () => {
  assert.equal(estimatedBufferWait(120, 40, 0.5), 160);
  assert.equal(estimatedBufferWait(120, 120, 0.5), 0);
  assert.equal(estimatedBufferWait(120, 0, 0), null);
});

test("只主动完整缓存体积安全的本机视频", () => {
  assert.equal(shouldFullyCacheVideo(90 * 1024 * 1024, "local"), true);
  assert.equal(shouldFullyCacheVideo(DEFAULT_FULL_CACHE_LIMIT_BYTES + 1, "local"), false);
  assert.equal(shouldFullyCacheVideo(90 * 1024 * 1024, "remote"), false);
});
