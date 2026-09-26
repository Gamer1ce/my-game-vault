import test from "node:test";
import assert from "node:assert/strict";
import { attachSegmentedPlayback, SEGMENT_BUFFER_CONFIG } from "../public/segmented-playback.js";

test("MMS browser streaming suspension is observable and its listeners are removed on close", async () => {
  let hls; const callbacks = new Map(), listeners = new Map();
  class Hls {
    static Events = { ERROR: "error", MEDIA_ATTACHED: "attached" }; static isSupported() { return true; }
    constructor(config) { hls = this; assert.equal(config.preferManagedMediaSource, false); }
    on(event, fn) { callbacks.set(event, fn); } loadSource() {} attachMedia() {} destroy() {}
  }
  const source = { streaming: true, addEventListener: (n, f) => listeners.set(n, f), removeEventListener: n => listeners.delete(n) };
  const video = {dataset:{}};
  const controller = await attachSegmentedPlayback(video, "/sample.m3u8", { loadLibrary: async () => ({default:Hls}) });
  callbacks.get("attached")("attached", {mediaSource:source}); assert.equal(video.dataset.bufferSuspended, "false");
  listeners.get("endstreaming")(); assert.equal(video.dataset.bufferSuspended, "true");
  listeners.get("startstreaming")(); assert.equal(video.dataset.bufferSuspended, "false");
  controller.destroy(); assert.equal(listeners.size, 0); assert.equal(video.dataset.bufferSuspended, undefined);
});

test("large fragment byte progress prevents treating an in-flight segment as a dead route", async () => {
  let instance, listener, active = true; const received = [];
  class Hls {
    static Events = { ERROR: "error" }; static isSupported() { return true; }
    constructor(config) { this.config = config; instance = this; }
    on() {} loadSource() {} attachMedia() {} destroy() {}
  }
  const controller = await attachSegmentedPlayback({ dataset: {} }, "/sample.m3u8", {
    loadLibrary: async () => ({ default: Hls }), active: () => active, onProgress: bytes => received.push(bytes)
  });
  instance.config.xhrSetup({ addEventListener: (event, callback) => { assert.equal(event, "progress"); listener = callback; } });
  listener({ loaded: 1024 }); listener({ loaded: 1024 }); listener({ loaded: 4096 });
  active = false; listener({ loaded: 8192 });
  assert.deepEqual(received, [1024, 4096]); controller.destroy();
});

test("controlled segments attach with bounded buffers and cleanly release the media source", async () => {
  let instance;
  class Hls {
    static Events = { ERROR: "error" };
    static isSupported() { return true; }
    constructor(config) { this.config = config; instance = this; }
    on(_event, handler) { this.handler = handler; }
    loadSource(url) { this.url = url; }
    attachMedia(video) { this.video = video; }
    destroy() { this.destroyed = true; }
  }
  const video = { dataset: {} };
  let errors = 0;
  const controller = await attachSegmentedPlayback(video, "https://media.example/index.m3u8", {
    loadLibrary: async () => ({ default: Hls }), onFatal: () => { errors++; }
  });
  assert.deepEqual(instance.config, SEGMENT_BUFFER_CONFIG);
  assert.equal(video.disableRemotePlayback, true);
  assert.equal(video.dataset.managedStream, "true");
  assert.equal(instance.video, video);
  instance.handler("error", { fatal: false });
  assert.equal(errors, 0);
  instance.handler("error", { fatal: true });
  assert.equal(errors, 1);
  controller.destroy();
  assert.equal(instance.destroyed, true);
  assert.equal(video.dataset.managedStream, undefined);
  instance.handler("error", { fatal: true });
  assert.equal(errors, 1);
});

test("older native HLS keeps browser playback without the managed pause policy", async () => {
  const video = { dataset: {}, canPlayType: () => "maybe", load() { this.loaded = true; } };
  const controller = await attachSegmentedPlayback(video, "https://media.example/index.m3u8", {
    loadLibrary: async () => ({ default: { isSupported: () => false } })
  });
  assert.equal(controller.mode, "native");
  assert.equal(video.dataset.managedStream, undefined);
  assert.equal(video.disableRemotePlayback, false);
  assert.equal(video.loaded, true);
});

test("closing a player during library download cannot attach a late stream", async () => {
  let supportedChecked = false;
  const controller = await attachSegmentedPlayback({}, "https://media.example/index.m3u8", {
    active: () => false,
    loadLibrary: async () => ({ default: { isSupported() { supportedChecked = true; } } })
  });
  assert.equal(controller, null);
  assert.equal(supportedChecked, false);
});
