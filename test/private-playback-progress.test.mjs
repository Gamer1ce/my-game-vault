import test from "node:test";
import assert from "node:assert/strict";
import { createPrivatePlayback } from "../public/private-playback.js";

test("private playback keeps a progressing direct route, then falls back only after actual inactivity", async t => {
  let time = 0, end = 0; const timers = new Set(), events = new Map();
  t.mock.method(performance, "now", () => time);
  t.mock.method(globalThis, "setInterval", fn => { timers.add(fn); return fn; });
  t.mock.method(globalThis, "clearInterval", fn => timers.delete(fn));
  const video = { currentTime: 0, duration: 300, readyState: 1, paused: true, ended: false, seeking: false, dataset: {},
    buffered: { length: 1, start: () => 0, end: () => end },
    pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); }, load() {},
    removeAttribute(name) { if (name === "src") this.src = ""; },
    addEventListener(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); }, removeEventListener(name, fn) { events.get(name)?.delete(fn); }
  };
  const origin = "https://steamway.gamer1ce.top:8443", direct = origin + "/api/private-playback/file/" + "a".repeat(32), size = 3e9;
  const fetchImpl = async (url, options) => {
    if (url === "/api/my-media/playback") return Response.json({ direct: { origin, ticket: "test-ticket" } });
    if (url.endsWith("/session")) return Response.json({ url: direct });
    assert.equal(url, direct);
    const [start, end] = options.headers.Range.slice(6).split("-").map(Number);
    return new Response(new Uint8Array(end - start + 1), { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${size}` } });
  };
  const playback = createPrivatePlayback(video, { size, filename: "test.mp4", url: "/api/my-media/files/test.mp4" }, { pageOrigin: "https://gamer1ce.top", fetchImpl, message() {} });
  t.after(() => playback.destroy()); await playback.ready;
  assert.equal(video.src, direct);
  const tick = (ms, buffered) => { time += ms; end = buffered; for (const fn of [...timers]) fn(); };
  tick(20_000, 0.2); assert.equal(video.src, direct);
  tick(20_000, 0.4); assert.equal(video.src, direct);
  video.seeking = true; tick(31_000, 0.4); assert.equal(video.src, direct);
  video.seeking = false; for (const fn of events.get("seeking")) fn(); tick(20_000, 0.4); assert.equal(video.src, direct);
  tick(11_000, 0.4); await Promise.resolve();
  assert.equal(video.src, "https://gamer1ce.top/api/my-media/files/test.mp4");
});
