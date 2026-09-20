export const SEGMENT_BUFFER_CONFIG = Object.freeze({
  maxBufferLength: 16,
  maxMaxBufferLength: 20,
  maxBufferSize: 192 * 1024 * 1024,
  backBufferLength: 4,
  // Same-origin packaged worker: no blob worker or broader script CSP needed.
  enableWorker: true,
  workerPath: "/vendor/hls.worker-1.7.3.js",
  preferManagedMediaSource: true,
  lowLatencyMode: false
});

export function segmentedUrl(originalUrl, streamPath) {
  if (!/^\/media\/highlight-streams\/[a-f0-9]{32}\/index\.m3u8$/.test(streamPath || "")) return null;
  const original = new URL(originalUrl);
  if (!original.pathname.startsWith("/media/highlights/")) return null;
  return new URL(streamPath, original.origin).href;
}

export async function attachSegmentedPlayback(video, url, {
  onFatal, active = () => true,
  loadLibrary = () => import("./vendor/hls.light-1.7.3.min.mjs")
} = {}) {
  const { default: Hls } = await loadLibrary();
  if (!active()) return null;
  // Required by iPhone ManagedMediaSource unless an AirPlay alternative exists.
  video.disableRemotePlayback = true;
  if (Hls.isSupported()) {
    const hls = new Hls({ ...SEGMENT_BUFFER_CONFIG });
    let destroyed = false;
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal && !destroyed && active()) onFatal?.(data.details);
    });
    try {
      video.dataset.managedStream = "true";
      hls.loadSource(url);
      hls.attachMedia(video);
    } catch (error) {
      destroyed = true;
      hls.destroy();
      delete video.dataset.managedStream;
      video.disableRemotePlayback = false;
      throw error;
    }
    return {
      mode: "managed",
      destroy() { destroyed = true; delete video.dataset.managedStream; hls.destroy(); }
    };
  }
  video.disableRemotePlayback = false;
  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = url;
    video.load();
    return { mode: "native", destroy() {} };
  }
  throw new Error("Segmented playback unsupported");
}
