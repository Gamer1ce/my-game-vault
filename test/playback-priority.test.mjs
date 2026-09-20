import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPlaybackPriority, createBackgroundImagePause, isBackgroundRead } from "../public/playback-priority.js";

const flush = () => new Promise(resolve => setImmediate(resolve));

test("playback URLs and mutations bypass the background read gate", () => {
  assert.equal(isBackgroundRead("/api/games"), true);
  assert.equal(isBackgroundRead("/api/highlights/playback?filename=x"), false);
  for (const method of ["POST", "PUT", "DELETE", "PATCH", "post"]) {
    assert.equal(isBackgroundRead("/api/likes", { method }), false);
  }
});

test("reads wait while video is open, then resume without losing the result", async () => {
  const priority = createPlaybackPriority();
  priority.setActive(true);
  let calls = 0;
  const result = priority.read(async () => ++calls);
  await flush();
  assert.equal(calls, 0);
  priority.setActive(false);
  assert.equal(await result, 1);
});

test("an in-flight background read is aborted and retried only after close", async () => {
  const priority = createPlaybackPriority();
  let calls = 0;
  let firstSignal;
  const result = priority.read(signal => {
    calls++;
    if (calls > 1) return "restored";
    firstSignal = signal;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  });
  await flush();
  priority.setActive(true);
  await flush();
  assert.equal(firstSignal.aborted, true);
  assert.equal(calls, 1);
  priority.setActive(false);
  assert.equal(await result, "restored");
  assert.equal(calls, 2);
});

test("completed data cannot render background resources until the video closes", async () => {
  const priority = createPlaybackPriority();
  let finish;
  let rendered = false;
  const result = priority.read(() => new Promise(resolve => { finish = resolve; })).then(() => { rendered = true; });
  await flush();
  priority.setActive(true);
  finish("cached data");
  await flush();
  assert.equal(rendered, false);
  priority.setActive(false);
  await result;
  assert.equal(rendered, true);
});

test("real failures are not retried; caller cancellation survives a paused queue", async () => {
  const priority = createPlaybackPriority();
  const error = new Error("HTTP 500");
  let calls = 0;
  await assert.rejects(priority.read(() => { calls++; throw error; }), error);
  assert.equal(calls, 1);
  priority.setActive(true);
  const controller = new AbortController();
  const pending = priority.read(() => { calls++; }, controller.signal);
  controller.abort(new Error("caller cancelled"));
  await assert.rejects(pending, /caller cancelled/);
  priority.setActive(false);
  assert.equal(calls, 1);
});

test("rapid reopen does not start queued reads and repeated section work is deduplicated", async () => {
  const priority = createPlaybackPriority();
  let calls = 0;
  priority.setActive(true);
  const pending = priority.read(() => ++calls);
  priority.setActive(false);
  priority.setActive(true);
  await flush();
  assert.equal(calls, 0);
  let sections = 0;
  priority.defer("calendar", () => sections++);
  priority.defer("calendar", () => sections++);
  priority.setActive(false);
  await pending;
  assert.equal(calls, 1);
  assert.equal(sections, 1);
  assert.equal(priority.defer("calendar", () => sections++), false);
});

test("only unfinished background images are suspended; new images are caught and sources restored", () => {
  const makeImage = (complete = false) => ({
    complete, naturalWidth: complete ? 100 : 0, isConnected: true,
    attrs: new Map([["src", "poster.jpg"], ["srcset", "poster@2x.jpg 2x"], ["loading", "lazy"]]),
    getAttribute(name) { return this.attrs.get(name) ?? null; },
    setAttribute(name, value) { this.attrs.set(name, value); },
    removeAttribute(name) { this.attrs.delete(name); }
  });
  const ready = makeImage(true);
  const pending = makeImage();
  const images = [ready, pending];
  let scan;
  let disconnected = false;
  class Observer {
    constructor(callback) { scan = callback; }
    observe() {}
    disconnect() { disconnected = true; }
  }
  const pause = createBackgroundImagePause([{ querySelectorAll: () => images }], Observer);
  pause.setActive(true);
  assert.equal(ready.getAttribute("src"), "poster.jpg");
  assert.match(pending.getAttribute("src"), /^data:image/);
  assert.equal(pending.getAttribute("srcset"), null);
  images.push(makeImage());
  scan();
  assert.match(images[2].getAttribute("src"), /^data:image/);
  pause.setActive(false);
  assert.equal(disconnected, true);
  assert.equal(pending.getAttribute("src"), "poster.jpg");
  assert.equal(pending.getAttribute("srcset"), "poster@2x.jpg 2x");
  assert.equal(pending.getAttribute("loading"), "lazy");
  assert.equal(pending.getAttribute("data-playback-deferred"), null);
  assert.equal(images[2].getAttribute("src"), "poster.jpg");
});

test("page wires priority to video open/close, skips polls and releases the old video source", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /setVideoPriority\(item.type === "video"\)/);
  assert.match(app, /video\.removeAttribute\("src"\); video\.load\(\)/);
  assert.match(app, /replaceChildren\(\); setVideoPriority\(false\)/);
  assert.match(app, /!playbackPriority.active\) loadGuestbook/);
  assert.match(app, /!playbackPriority.active\) refreshMediaPower/);
  assert.match(app, /playbackPriority.defer\("game-batch"/);
  assert.match(app, /playbackPriority.defer\(`section:/);
});
