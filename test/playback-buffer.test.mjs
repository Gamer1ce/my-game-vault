import test from "node:test";
import assert from "node:assert/strict";
import {
  bufferProgressTimedOut,
  estimatedBufferWait,
  MAX_READ_AHEAD_RANGE_BYTES,
  planPlaybackReadAheadRange,
  recommendedBufferTarget,
  recommendedPlaybackReadAhead,
  resumeBufferedPlayback
} from "../public/playback-buffer.js";

test("快线路迅速起播，低于原画码率时扩大起播缓存", () => {
  assert.equal(recommendedBufferTarget(5, 0.1), 5);
  assert.equal(recommendedBufferTarget(120), 12);
  assert.equal(recommendedBufferTarget(120, 1.5), 8);
  assert.equal(recommendedBufferTarget(120, 1.15), 10);
  assert.equal(recommendedBufferTarget(120, 1), 15);
  assert.equal(recommendedBufferTarget(120, 0.75), 45);
  assert.equal(recommendedBufferTarget(120, 0.4), 87);
  assert.equal(recommendedBufferTarget(600, 0.4), 120);
});

test("根据缓存速度估算剩余等待时间", () => {
  assert.equal(estimatedBufferWait(12, 5, 0.5), 14);
  assert.equal(estimatedBufferWait(12, 12, 0.5), 0);
  assert.equal(estimatedBufferWait(12, 0, 0), null);
});

test("起播后按线路速度持续预读六十至一百二十秒", () => {
  assert.equal(recommendedPlaybackReadAhead(30, 0, 0.4), 30);
  assert.equal(recommendedPlaybackReadAhead(300, 0), 90);
  assert.equal(recommendedPlaybackReadAhead(300, 0, 1.5), 60);
  assert.equal(recommendedPlaybackReadAhead(300, 0, 1), 90);
  assert.equal(recommendedPlaybackReadAhead(300, 0, 0.4), 120);
  assert.equal(recommendedPlaybackReadAhead(300, 250, 0.4), 50);
});

test("持续预读只请求当前缓存之后的有限 Range", () => {
  const megabyte = 1024 * 1024;
  const range = planPlaybackReadAheadRange({
    size: 120 * megabyte,
    duration: 120,
    currentTime: 0,
    bufferedEnd: 20,
    readAheadSeconds: 60
  });
  assert.deepEqual(range, {
    startByte: 20 * megabyte - 256 * 1024,
    endByte: 28 * megabyte - 256 * 1024 - 1,
    throughTime: 27.75
  });
  assert.equal(planPlaybackReadAheadRange({
    size: 120 * megabyte,
    duration: 120,
    currentTime: 0,
    bufferedEnd: 20,
    prefetchedThrough: 60,
    readAheadSeconds: 60
  }), null);
});

test("超高码率视频使用八 MiB 小块预读，避免抢占播放带宽", () => {
  const range = planPlaybackReadAheadRange({
    size: 1024 * 1024 * 1024,
    duration: 100,
    currentTime: 0,
    bufferedEnd: 0,
    readAheadSeconds: 100
  });
  assert.equal(range.startByte, 0);
  assert.equal(range.endByte - range.startByte + 1, MAX_READ_AHEAD_RANGE_BYTES);
  assert.equal(range.throughTime, 0.78125);
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
