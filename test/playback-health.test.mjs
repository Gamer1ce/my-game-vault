import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as health from "../public/playback-health.js";
import { playbackStartupState, STARTUP_WAIT_MS } from "../public/playback-startup.js";

test("only contiguous, playable TimeRanges count, not a future range across a seek gap", () => {
  const video = { currentTime: 5, buffered: { length: 2, start: i => [0, 40][i], end: i => [10, 60][i] } };
  assert.equal(health.playableBuffer(video), 5);
  video.currentTime = 20;
  assert.equal(health.playableBuffer(video), 0);
  video.currentTime = 50;
  assert.equal(health.playableBuffer(video), 10);
});

test("high bitrate source is reported honestly, recovery grows and respects the end", () => {
  assert.equal(Math.round(health.averageMediaBitrate(3413552131, 300.28475) / 1e6), 91);
  assert.equal(health.averageMediaBitrate(100, Infinity), 0);
  assert.equal(health.recoveryBufferTarget({ duration: 300, stalls: 1 }), 12);
  assert.equal(health.recoveryBufferTarget({ duration: 300, stalls: 2 }), 16);
  assert.equal(health.recoveryBufferTarget({ duration: 300, stalls: 10 }), 30);
  assert.equal(health.recoveryBufferTarget({ duration: 300, currentTime: 297 }), 3);
});

test("browser preload suspension is distinct from a network timeout", () => {
  const state = { ahead: 3, target: 12, now: 13_000, lastProgressAt: 0, networkState: 1 };
  assert.equal(health.recoveryState(state), "capped");
  assert.equal(health.recoveryState({ ...state, networkState: 2 }), "capped");
  assert.equal(health.recoveryState({ ...state, ahead: 0, networkState: 2, now: 31_000 }), "stalled");
  assert.equal(health.recoveryState({ ...state, ahead: 12 }), "ready");
});

function player() {
  let now = 0;
  let tick;
  class Element {
    constructor() { this.listeners = {}; this.nodes = {}; this.style = { setProperty() {} }; this.classList = { add() {}, remove() {} }; }
    querySelector(selector) { return this.nodes[selector] ||= new Element(); }
    addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
    emit(name) { for (const callback of this.listeners[name] || []) callback(); }
  }
  const video = new Element();
  Object.assign(video, {
    currentTime: 0, duration: 300, end: 5, readyState: 4, networkState: 2, isConnected: true, dataset: {},
    paused: true, seeking: false, ended: false, playCalls: 0, loadCalls: 0,
    buffered: { length: 1, start: () => 0, end: () => video.end },
    load() { this.loadCalls++; },
    pause() { this.paused = true; this.emit("pause"); },
    async play() { this.playCalls++; this.paused = false; this.emit("play"); this.emit("playing"); }
  });
  const viewer = { replaceChildren(...children) { this.children = children; } };
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const code = app.slice(app.indexOf("let highlightPlaybackRequest = 0;"), app.indexOf("async function openHighlight(index)"));
  const context = vm.createContext({
    ...health, playbackStartupState, STARTUP_WAIT_MS, segmentedUrl: () => null,
    document: { createElement: () => new Element() }, performance: { now: () => now },
    setInterval: callback => { tick = callback; return 1; }, clearInterval() {},
    video, viewer
  });
  vm.runInContext(code + '\nmountBufferedVideo(viewer, video, {size: 3413552131}, {source: "local"}, "https://example.org/video.mp4", 0);', context);
  // Exercise the controlled buffer path; native-only playback has its own test.
  video.dataset.managedStream = "true";
  const panel = viewer.children[2];
  return {
    video, panel,
    button: panel.querySelector(".highlight-buffer-play"),
    status: panel.querySelector(".highlight-buffer-copy span"),
    advance(ms) { now += ms; tick(); }
  };
}

test("actual mounted player holds an underrun, resumes only after valid buffer, and does not reload", async () => {
  const p = player();
  p.button.emit("click");
  assert.equal(p.video.playCalls, 1);
  p.video.currentTime = 5;
  p.video.emit("waiting");
  assert.equal(p.video.paused, true);
  assert.match(p.status.textContent, /积累有效缓存/);
  p.video.end = 9;
  p.video.emit("progress");
  assert.equal(p.video.playCalls, 1);
  p.video.end = 17;
  p.video.emit("progress");
  assert.equal(p.video.playCalls, 2);
  assert.equal(p.video.currentTime, 5);
  assert.equal(p.video.loadCalls, 1);
  assert.match(p.status.textContent, /实际可播放缓存/);
});

test("a four-second mobile buffer cap resumes instead of waiting forever for twelve seconds", () => {
  const p = player();
  p.button.emit("click");
  p.video.currentTime = 5;
  p.video.emit("waiting");
  p.video.end = 9;
  p.video.emit("progress");
  p.video.networkState = 2; // Some mobile engines still report LOADING at the cap.
  p.advance(2000);
  assert.equal(p.video.playCalls, 1);
  p.advance(1500);
  assert.equal(p.video.playCalls, 2);
  assert.equal(p.video.loadCalls, 1);
});

test("ordinary MP4 native playback is never paused by our buffer target", () => {
  const p = player();
  delete p.video.dataset.managedStream;
  p.button.emit("click");
  p.video.currentTime = 5;
  p.video.emit("waiting");
  assert.equal(p.video.paused, false);
  p.video.end = 9;
  p.advance(15_000);
  assert.equal(p.video.playCalls, 1);
});

test("canceling recovery cannot trigger automatic resume later", () => {
  const p = player();
  p.button.emit("click");
  p.video.currentTime = 5;
  p.video.emit("waiting");
  p.panel.querySelector(".highlight-play-now").emit("click");
  p.video.end = 25;
  p.video.emit("progress");
  assert.equal(p.video.playCalls, 1);
  assert.equal(p.video.paused, true);
});

test("manual seeking does not get trapped by underrun recovery", () => {
  const p = player();
  p.button.emit("click");
  p.video.currentTime = 50;
  p.video.seeking = true;
  p.video.emit("seeking");
  p.video.emit("waiting");
  assert.equal(p.video.paused, false);
});

test("waiting with a full buffer is not treated as a network underrun", () => {
  const p = player();
  p.button.emit("click");
  p.video.end = 30;
  p.video.emit("waiting");
  assert.equal(p.video.paused, false);
  assert.equal(p.video.playCalls, 1);
});

test("a disconnected video cannot restart background playback on late events", () => {
  const p = player();
  p.button.emit("click");
  p.video.currentTime = 5;
  p.video.isConnected = false;
  p.video.emit("waiting");
  p.video.end = 30;
  p.video.emit("progress");
  assert.equal(p.video.playCalls, 1);
});

test("playback never counts speculative fetches as playable cache", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /prefetchPlaybackRange|prefetchedThrough|effectiveAhead/);
  assert.match(app, /video\.preload = "auto"/);
});
