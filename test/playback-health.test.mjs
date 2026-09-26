import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as health from "../public/playback-health.js";
import { createAdaptiveBuffering } from "../public/adaptive-buffer.js";
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

function player({ admin = false, fallback = false } = {}) {
  let now = 0;
  const timers = new Set();
  class Element {
    constructor() { this.listeners = {}; this.nodes = {}; this.style = { setProperty() {} }; this.classList = { add() {}, remove() {} }; }
    querySelector(selector) { return this.nodes[selector] ||= new Element(); }
    addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
    removeEventListener(name, callback) { this.listeners[name] = (this.listeners[name] || []).filter(fn => fn !== callback); }
    emit(name) { for (const callback of this.listeners[name] || []) callback(); }
    append(...children) { this.children = children; }
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
    ...health, createAdaptiveBuffering: (video, options) => createAdaptiveBuffering(video, {...options, now: () => now}), playbackStartupState, STARTUP_WAIT_MS, segmentedUrl: () => null, state: { security: { canManage: admin } },
    document: { createElement: () => new Element() }, performance: { now: () => now },
    setInterval: callback => { timers.add(callback); return callback; }, clearInterval(callback) { timers.delete(callback); },
    video, viewer, fallback
  });
  vm.runInContext(code + '\nmountBufferedVideo(viewer, video, {size: 3413552131}, {source: "local", fallbackCandidates: fallback ? [{url:"https://fallback.example/video.mp4"}] : []}, "https://example.org/video.mp4", 0);', context);
  // Exercise the controlled buffer path; native-only playback has its own test.
  video.dataset.managedStream = "true";
  const panel = viewer.children[1];
  return {
    video, panel,
    button: panel.querySelector(".highlight-buffer-play"),
    status: panel.querySelector(".highlight-buffer-copy span"),
    advance(ms) { now += ms; for (const fn of timers) fn(); }
  };
}

test("managed and native playback do not turn brief underruns into forced pauses", () => {
  for (const managed of [true, false]) {
    const p = player();
    if (!managed) delete p.video.dataset.managedStream;
    p.button.emit("click");
    p.video.currentTime = 5;
    p.video.emit("waiting");
    assert.equal(p.video.paused, false);
    assert.match(p.panel.querySelector(".highlight-player-status").textContent, /缓冲/);
    p.video.end = 9;
    p.video.emit("progress");
    p.advance(3500);
    assert.equal(p.video.playCalls, 1);
    assert.equal(p.video.loadCalls, 1);
    p.video.emit("playing");
    assert.equal(p.panel.querySelector(".highlight-player-status").textContent, "");
  }
});

test("normal playback hides duplicated controls and technical details from guests", () => {
  const p = player();
  const details = p.panel.querySelector(".highlight-player-details");
  assert.equal(details.hidden, true);
  assert.equal(details.open, false);
  assert.equal(p.button.hidden, false);
  p.button.emit("click");
  assert.equal(p.button.hidden, true);
  assert.equal(p.panel.querySelector(".highlight-player-status").textContent, "");
});

test("administrator diagnostics stay in a separate, collapsed disclosure", () => {
  const p = player({ admin: true });
  assert.equal(p.panel.querySelector(".highlight-player-details").hidden, false);
  assert.notEqual(p.panel.querySelector(".highlight-player-details").open, true);
});

test("manual pause remains paused as more video data arrives", () => {
  const p = player();
  p.button.emit("click");
  p.video.pause();
  p.video.end = 25;
  p.video.emit("progress");
  p.advance(15000);
  assert.equal(p.video.playCalls, 1);
  assert.equal(p.video.paused, true);
  assert.equal(p.panel.querySelector(".highlight-player-status").textContent, "已暂停");
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

test("真正无进展的播放自动换线且恢复原播放位置", async () => {
  const p = player({ fallback: true });
  p.button.emit("click"); p.video.currentTime = 5; p.video.emit("waiting");
  p.advance(29000);
  assert.equal(p.video.loadCalls, 1);
  p.advance(1000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.video.src, "https://fallback.example/video.mp4");
  p.video.currentTime = 0; p.video.emit("loadedmetadata");
  assert.equal(p.video.currentTime, 5);
  assert.equal(p.video.playCalls, 2);
});

test("暂停、跳转或可播放缓存充足时不会因等待而换线", () => {
  for (const mode of ["paused", "seeking", "buffered"]) {
    const p = player({ fallback: true });
    p.button.emit("click"); p.video.currentTime = 5; p.video.emit("waiting");
    if (mode === "paused") p.video.pause();
    if (mode === "seeking") p.video.seeking = true;
    if (mode === "buffered") { p.video.end = 20; p.video.emit("progress"); }
    p.advance(40000);
    assert.equal(p.video.loadCalls, 1, mode);
  }
});

test("反复卡顿时展示原画预缓冲，并保留立即播放选择", async () => {
  const p = player({fallback:true});
  p.button.emit("click"); p.video.currentTime=5; p.video.emit("waiting");
  p.video.emit("playing"); p.video.emit("waiting");
  assert.equal(p.video.paused,true);
  assert.match(p.panel.querySelector(".highlight-player-status").textContent,/先缓存原画/);
  assert.equal(p.button.textContent,"立即播放");
  p.advance(31000);assert.equal(p.video.loadCalls,1);
  p.video.end=21;p.advance(1000);await Promise.resolve();
  assert.equal(p.video.paused,false);assert.equal(p.video.playCalls,2);
  assert.equal(p.panel.querySelector(".highlight-player-status").textContent,"");
});
