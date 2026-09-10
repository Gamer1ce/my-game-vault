import test from "node:test";
import assert from "node:assert/strict";
import { playbackStartupState } from "../public/playback-startup.js";

test("mobile preload refusal still exposes an enabled play button immediately", () => {
  const state = playbackStartupState({ readyState: 0 });
  assert.equal(state.disabled, false);
  assert.equal(state.label, "播放原画");
});

test("pending play without metadata expires even when the browser fired play", () => {
  assert.equal(playbackStartupState({ readyState: 0, requestedAt: 100, now: 500 }).disabled, true);
  const state = playbackStartupState({ readyState: 0, requestedAt: 100, now: 20_101 });
  assert.equal(state.disabled, false);
  assert.equal(state.label, "重试播放");
});

test("metadata is not equivalent to a decoded first frame", () => {
  const state = playbackStartupState({ readyState: 1, requestedAt: 10, now: 100 });
  assert.match(state.message, /第一段画面/);
});

test("media errors remain visible and retryable", () => {
  assert.deepEqual(playbackStartupState({ error: "连接中断", requestedAt: 0, now: 100 }), {
    message: "连接中断", label: "重试播放", disabled: false
  });
});
