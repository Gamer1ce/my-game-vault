import test from "node:test";
import assert from "node:assert/strict";
import {
  bufferProgressTimedOut,
  estimatedBufferWait,
  recommendedBufferTarget,
  resumeBufferedPlayback
} from "../public/playback-buffer.js";

test("所有视频只需八至十五秒缓存即可开始播放", () => {
  assert.equal(recommendedBufferTarget(5, 0.1), 5);
  assert.equal(recommendedBufferTarget(120), 12);
  assert.equal(recommendedBufferTarget(120, 1.5), 8);
  assert.equal(recommendedBufferTarget(120, 1), 10);
  assert.equal(recommendedBufferTarget(120, 0.75), 12);
  assert.equal(recommendedBufferTarget(120, 0.4), 15);
});

test("根据缓存速度估算剩余等待时间", () => {
  assert.equal(estimatedBufferWait(12, 5, 0.5), 14);
  assert.equal(estimatedBufferWait(12, 12, 0.5), 0);
  assert.equal(estimatedBufferWait(12, 0, 0), null);
});

test("后台预缓存停止十二秒后允许沿用现有缓存", () => {
  assert.equal(bufferProgressTimedOut({ now: 12_000, lastProgressAt: 0 }), true);
  assert.equal(bufferProgressTimedOut({ now: 11_999, lastProgressAt: 0 }), false);
  assert.equal(bufferProgressTimedOut({ now: 20_000, lastProgressAt: 0, playing: true }), false);
  assert.equal(bufferProgressTimedOut({ now: 20_000, lastProgressAt: 0, ready: true }), false);
  assert.equal(bufferProgressTimedOut({ now: 20_000, lastProgressAt: 15_000 }), false);
});

test("立即播放复用已有媒体地址且不会重新加载缓存", async () => {
  const buffered = { marker: "preserved" };
  const video = {
    src: "https://media.example/video.mp4",
    currentTime: 9,
    buffered,
    loadCalls: 0,
    playCalls: 0,
    load() { this.loadCalls += 1; },
    async play() { this.playCalls += 1; }
  };
  await resumeBufferedPlayback(video);
  assert.equal(video.src, "https://media.example/video.mp4");
  assert.equal(video.currentTime, 9);
  assert.equal(video.buffered, buffered);
  assert.equal(video.loadCalls, 0);
  assert.equal(video.playCalls, 1);
});
