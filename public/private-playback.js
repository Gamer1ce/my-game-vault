import { measurePlaybackCandidate } from "./playback-route.js";
import { attachSegmentedPlayback } from "./segmented-playback.js?v=20260920-2";

export const PRIVATE_MEMORY_LIMIT = 96 * 1024 * 1024;
export function memoryBufferEligible(size) { return Number.isSafeInteger(size) && size > 0 && size <= PRIVATE_MEMORY_LIMIT; }
export function playableAhead(video) {
  for (let i = 0; i < video.buffered.length; i++) if (video.buffered.start(i) <= video.currentTime + 0.1 && video.buffered.end(i) > video.currentTime) return video.buffered.end(i) - video.currentTime;
  return 0;
}

export function createPrivatePlayback(video, item, { message, fetchImpl = fetch, pageOrigin = location.origin }) {
  const lifetime = new AbortController(); let transfer, segmented, objectUrl, timer, dead = false, route, switched = false, starting = false, lastTime = 0, lastAdvance = performance.now(), requested = false;
  const listeners = [];
  const listen = (event, fn) => { video.addEventListener(event, fn); listeners.push([event, fn]); };
  const request = (url, options = {}) => fetchImpl(url, { credentials: "include", cache: "no-store", ...options, signal: AbortSignal.any([lifetime.signal, ...(options.signal ? [options.signal] : [])]) });
  const fallback = { id: "site", label: "兼容线路", url: new URL(item.url, pageOrigin).href };
  const active = () => !dead;
  let previousMessage = "", progressAt = 0;
  const say = text => { if (active() && text !== previousMessage) { previousMessage = text; message(text); } };
  function resetMedia() {
    clearInterval(timer); transfer?.abort(); transfer = null; segmented?.destroy(); segmented = null;
    video.pause(); video.removeAttribute("src"); video.load();
    if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = null;
  }
  async function play() {
    if (requested || !active()) return;
    requested = true;
    try { await video.play(); say(""); } catch { say("已缓冲，点击视频中的播放按钮即可观看。"); }
  }
  async function failover() {
    if (!active()) return;
    if (route?.id === "direct" && !switched) {
      switched = true; const position = video.currentTime || 0;
      say("直连暂时不稳定，正在切换兼容线路…");
      await start(fallback, position, position === 0 && !requested);
    } else say("这条线路暂时无法继续加载，请关闭后重新播放。已缓存内容仍可播放。");
  }
  async function bufferAll() {
    transfer = new AbortController(); const controller = transfer;
    let watchdog;
    const touch = () => { clearTimeout(watchdog); watchdog = setTimeout(() => controller.abort(), 15000); };
    try {
      touch();
      const response = await request(route.url, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const chunks = []; let bytes = 0; const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > PRIVATE_MEMORY_LIMIT || bytes > item.size) { await reader.cancel(); throw new Error("Media size changed"); }
        chunks.push(value); touch();
        if (performance.now() - progressAt >= 100 || bytes === item.size) {
          progressAt = performance.now(); say(`正在缓冲原画 ${Math.min(100, Math.floor(bytes / item.size * 100))}% · ${route.label}`);
        }
      }
      if (bytes !== item.size) throw new Error("Incomplete media");
      if (!active() || controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(new Blob(chunks, { type: response.headers.get("Content-Type") || "video/mp4" }));
      video.removeAttribute("crossorigin"); video.src = objectUrl; video.load(); await play();
    } finally { clearTimeout(watchdog); }
  }
  async function start(nextRoute, position = 0, memory = true) {
    resetMedia(); route = nextRoute; requested = false; starting = true;
    say(`正在缓冲原画 · ${route.label}`); video.preload = "auto";
    if (memory && memoryBufferEligible(item.size)) {
      try { await bufferAll(); } catch { if (active()) await failover(); }
      return;
    }
    video.crossOrigin = "use-credentials";
    if (route.id === "site" && /^\/api\/my-media\/streams\/[a-f0-9]{32}\/index\.m3u8$/.test(item.streamUrl || "")) {
      try { segmented = await attachSegmentedPlayback(video, item.streamUrl, { active, onFatal: () => { segmented?.destroy(); segmented = null; video.src = route.url; video.load(); } }); }
      catch { video.src = route.url; video.load(); }
    } else { video.src = route.url; video.load(); }
    if (!active()) return;
    let positioned = position === 0; const began = performance.now(); lastAdvance = began;
    timer = setInterval(() => {
      if (!active()) return;
      if (!positioned && video.readyState >= 1) { video.currentTime = position; positioned = true; }
      const ahead = playableAhead(video), remaining = video.duration - video.currentTime;
      if (starting && (ahead >= Math.min(12, remaining) - 0.2 || (performance.now() - began > 20000 && ahead > 1))) { starting = false; void play(); }
      else if (starting) say(`正在缓冲原画 ${Math.floor(ahead)} 秒 · ${route.label}`);
      if (video.currentTime > lastTime + 0.1) { lastTime = video.currentTime; lastAdvance = performance.now(); }
      if ((starting || (!video.paused && !video.ended)) && ahead < 0.5 && performance.now() - lastAdvance > 15000) { clearInterval(timer); void failover(); }
    }, 400);
  }
  listen("error", () => { if (active() && route && !objectUrl) void failover(); });
  listen("playing", () => { starting = false; lastAdvance = performance.now(); say(""); });
  const ready = (async () => {
    let direct;
    say("正在选择安全播放线路…");
    try {
      const response = await request("/api/my-media/playback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: item.filename }), signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error("Playback authorization unavailable");
      const grant = (await response.json()).direct;
      if (grant && new URL(grant.origin).protocol === "https:" && new URL(grant.origin).hostname === "steamway.gamer1ce.top") {
        const session = await request(`${grant.origin}/api/private-playback/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticket: grant.ticket }), signal: AbortSignal.timeout(4000) });
        if (session.ok) {
          const result = await session.json();
          const url = new URL(result.url);
          if (url.origin === grant.origin && /^\/api\/private-playback\/file\/[a-f0-9]{32}$/.test(url.pathname) && !url.search && !url.hash) direct = { id: "direct", label: "家庭 IPv6 直连", url: result.url };
        }
      }
    } catch { /* A blocked IPv6 route or cookie falls back to the authenticated site. */ }
    if (!active()) return;
    let chosen = fallback;
    if (direct) {
      const options = { fetchImpl: request, fileSize: item.size, sampleBytes: 256 * 1024, tailSampleBytes: 32 * 1024, timeoutMs: 4000 };
      // Validate the private direct route without waiting for a slow fallback
      // probe or making it compete with the video's first bytes.
      const result = await measurePlaybackCandidate(direct, options);
      if (result.ok) chosen = direct;
    }
    if (active()) await start(chosen);
  })();
  ready.catch(() => say("视频暂时无法加载，请关闭后重试。"));
  return { ready, destroy() { dead = true; lifetime.abort(); resetMedia(); for (const [event, fn] of listeners) video.removeEventListener(event, fn); } };
}
