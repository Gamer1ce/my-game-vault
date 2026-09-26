import { playableBuffer } from "./playback-health.js?v=20260920-1";

export function pausedBufferCapped({ ahead, idleMs, controlled, suspended = false }) {
  // Safari can keep NETWORK_LOADING even after a paused native buffer stops.
  // MMS explicitly emits endstreaming; respect that signal instead of waiting
  // for a target which the browser has stopped trying to fill.
  return ahead >= 1.5 && idleMs >= 4000 && (!controlled || suspended);
}

export function startupBufferReady({ ahead, remaining, idleMs, controlled, suspended = false }) {
  const target = Number.isFinite(remaining) ? Math.min(12, remaining) : 12;
  return (target > 0 && ahead >= target - 0.2) || pausedBufferCapped({ ahead, idleMs, controlled, suspended });
}

// A single underrun stays native. Repeated starvation gets one bounded refill
// instead of repeatedly resuming with only a fragment or two. No quality change.
export function createAdaptiveBuffering(video, {
  active = () => true, onState = () => {}, now = () => performance.now(),
  schedule = fn => setInterval(fn, 400), unschedule = clearInterval
} = {}) {
  let dead = false, played = false, holding = false, ownPause = false, waitingEpisode = false, refillBlocked = false;
  let waits = [], began = 0, progressAt = 0, lastEnd = 0, target = 16, lastMessage = "";
  const listeners = [];
  const listen = (event, fn) => { video.addEventListener(event, fn); listeners.push([event, fn]); };
  const emit = reason => {
    const ahead = playableBuffer(video);
    const message = `${holding}:${Math.floor(ahead)}:${target}:${reason}`;
    if (message !== lastMessage) { lastMessage = message; onState({ recovering: holding, ahead, target, reason }); }
  };
  function reset() { holding = false; waits = []; waitingEpisode = false; emit("idle"); }
  async function resume() {
    if (!holding || dead || !active()) return;
    holding = false; waits = []; emit("resuming");
    try { await video.play(); }
    catch { if (!dead && active()) emit("manual"); }
  }
  function tick() {
    if (!holding || dead) return;
    if (!active() || video.ended || video.seeking || video.error) { reset(); return; }
    const ahead = playableBuffer(video), end = video.currentTime + ahead, time = now();
    if (end > lastEnd + 0.05) { lastEnd = end; progressAt = time; }
    emit("buffering");
    // Browsers can cap paused native buffers. Do not wait for an unreachable
    // target, nor mistake a slow in-flight HLS fragment for a paused loader.
    const capped = pausedBufferCapped({ ahead, idleMs: time - progressAt, controlled: video.dataset?.managedStream === "true", suspended: video.dataset?.bufferSuspended === "true" });
    if (capped) refillBlocked = true;
    if (ahead >= target - 0.1 || capped) void resume();
    else if (time - began >= 60000) { holding = false; waits = []; emit("manual"); }
  }
  listen("playing", () => { played = true; waitingEpisode = false; if (holding) reset(); });
  listen("waiting", () => {
    if (dead || !active() || holding || refillBlocked || waitingEpisode || !played || video.paused || video.seeking || video.ended || playableBuffer(video) >= 0.5) return;
    waitingEpisode = true;
    const time = now(); waits = waits.filter(t => time - t < 30000); waits.push(time);
    if (waits.length < 2) return;
    const remaining = Number.isFinite(video.duration) ? video.duration - video.currentTime : 16;
    if (remaining <= 2) return;
    target = Math.min(16, remaining); began = progressAt = time; lastEnd = video.currentTime + playableBuffer(video);
    holding = true; ownPause = true; emit("buffering"); video.pause();
  });
  listen("pause", () => { if (ownPause) { ownPause = false; return; } reset(); });
  listen("play", () => { if (holding) reset(); });
  for (const event of ["seeking", "ended", "error", "emptied"]) listen(event, reset);
  listen("emptied", () => { refillBlocked = false; played = false; });
  const timer = schedule(tick);
  return {
    get recovering() { return holding; }, reset,
    destroy() { dead = true; holding = false; unschedule(timer); for (const [event, fn] of listeners) video.removeEventListener(event, fn); }
  };
}
