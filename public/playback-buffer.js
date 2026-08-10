export const MIN_BUFFER_SECONDS = 8;
export const DEFAULT_BUFFER_SECONDS = 12;
export const MAX_BUFFER_SECONDS = 15;
export const BUFFER_STALL_TIMEOUT_MS = 12_000;

export function recommendedBufferTarget(duration, mediaSecondsPerSecond) {
  const total = Number(duration);
  if (!Number.isFinite(total) || total <= 0) return 0;
  const rate = Number(mediaSecondsPerSecond);
  if (!Number.isFinite(rate) || rate <= 0) return Math.min(total, DEFAULT_BUFFER_SECONDS);
  if (rate >= 1.5) return Math.min(total, MIN_BUFFER_SECONDS);
  if (rate >= 1) return Math.min(total, 10);
  if (rate >= 0.75) return Math.min(total, DEFAULT_BUFFER_SECONDS);
  return Math.min(total, MAX_BUFFER_SECONDS);
}

export function estimatedBufferWait(targetSeconds, bufferedSeconds, mediaSecondsPerSecond) {
  const rate = Number(mediaSecondsPerSecond);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return Math.max(0, (Number(targetSeconds || 0) - Number(bufferedSeconds || 0)) / rate);
}

export async function resumeBufferedPlayback(video) {
  return video.play();
}

export function bufferProgressTimedOut({
  now,
  lastProgressAt,
  playing = false,
  ready = false,
  timeoutMs = BUFFER_STALL_TIMEOUT_MS
} = {}) {
  const current = Number(now);
  const last = Number(lastProgressAt);
  const timeout = Number(timeoutMs);
  if (playing || ready || !Number.isFinite(current) || !Number.isFinite(last) || !Number.isFinite(timeout) || timeout <= 0) return false;
  return current - last >= timeout;
}
