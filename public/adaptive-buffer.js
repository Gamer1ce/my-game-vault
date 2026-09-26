import { playableBuffer } from "./playback-health.js?v=20260920-1";

// A single underrun stays native. Repeated starvation gets one bounded refill
// instead of repeatedly resuming with only a fragment or two. No quality change.
export function createAdaptiveBuffering(video, {
  active = () => true, onState = () => {}, now = () => performance.now(),
  schedule = fn => setInterval(fn, 400), unschedule = clearInterval
} = {}) {
  let dead = false, played = false, holding = false, ownPause = false, waitingEpisode = false;
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
    const capped = video.dataset?.managedStream !== "true" && video.networkState === 1 && time - progressAt >= 4000;
    if (ahead >= target - 0.1 || (ahead >= 2 && (capped || time - began >= 45000))) void resume();
    else if (time - began >= 60000) { holding = false; waits = []; emit("manual"); }
  }
  listen("playing", () => { played = true; waitingEpisode = false; if (holding) reset(); });
  listen("waiting", () => {
    if (dead || !active() || holding || waitingEpisode || !played || video.paused || video.seeking || video.ended || playableBuffer(video) >= 0.5) return;
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
  const timer = schedule(tick);
  return {
    get recovering() { return holding; }, reset,
    destroy() { dead = true; holding = false; unschedule(timer); for (const [event, fn] of listeners) video.removeEventListener(event, fn); }
  };
}
