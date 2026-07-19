export function recommendedBufferTarget(duration, mediaSecondsPerSecond) {
  const total = Number(duration);
  if (!Number.isFinite(total) || total <= 0) return 0;
  const rate = Number(mediaSecondsPerSecond);
  if (!Number.isFinite(rate) || rate <= 0) return total;
  if (rate >= 1.15) return Math.min(total, Math.max(12, total * 0.1));
  const fraction = Math.min(1, Math.max(0.25, 1 - rate + 0.08));
  return total * fraction;
}

export function estimatedBufferWait(targetSeconds, bufferedSeconds, mediaSecondsPerSecond) {
  const rate = Number(mediaSecondsPerSecond);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return Math.max(0, (Number(targetSeconds || 0) - Number(bufferedSeconds || 0)) / rate);
}

export async function resumeBufferedPlayback(video) {
  return video.play();
}

export const DEFAULT_FULL_CACHE_LIMIT_BYTES = 256 * 1024 * 1024;

export function shouldFullyCacheVideo(size, source, limit = DEFAULT_FULL_CACHE_LIMIT_BYTES) {
  const bytes = Number(size);
  return source === "local" && Number.isFinite(bytes) && bytes > 0 && bytes <= limit;
}
