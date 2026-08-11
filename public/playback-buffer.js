export const MIN_BUFFER_SECONDS = 8;
export const DEFAULT_BUFFER_SECONDS = 12;
export const MAX_BUFFER_SECONDS = 15;
export const BUFFER_STALL_TIMEOUT_MS = 12_000;
export const DEFAULT_PLAYBACK_READ_AHEAD_SECONDS = 90;
export const MIN_PLAYBACK_READ_AHEAD_SECONDS = 60;
export const MAX_PLAYBACK_READ_AHEAD_SECONDS = 120;
export const MAX_READ_AHEAD_RANGE_BYTES = 8 * 1024 * 1024;
export const READ_AHEAD_RANGE_OVERLAP_BYTES = 256 * 1024;

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

export function recommendedPlaybackReadAhead(duration, currentTime = 0, mediaSecondsPerSecond) {
  const total = Number(duration);
  const position = Math.max(0, Number(currentTime) || 0);
  if (!Number.isFinite(total) || total <= position) return 0;
  const remaining = total - position;
  const rate = Number(mediaSecondsPerSecond);
  if (!Number.isFinite(rate) || rate <= 0) return Math.min(remaining, DEFAULT_PLAYBACK_READ_AHEAD_SECONDS);
  if (rate >= 1.5) return Math.min(remaining, MIN_PLAYBACK_READ_AHEAD_SECONDS);
  if (rate >= 1) return Math.min(remaining, DEFAULT_PLAYBACK_READ_AHEAD_SECONDS);
  return Math.min(remaining, MAX_PLAYBACK_READ_AHEAD_SECONDS);
}

export function planPlaybackReadAheadRange({
  size,
  duration,
  currentTime = 0,
  bufferedEnd = 0,
  prefetchedThrough = 0,
  readAheadSeconds = DEFAULT_PLAYBACK_READ_AHEAD_SECONDS,
  maxBytes = MAX_READ_AHEAD_RANGE_BYTES,
  overlapBytes = READ_AHEAD_RANGE_OVERLAP_BYTES
} = {}) {
  const bytes = Number(size);
  const total = Number(duration);
  const position = Math.max(0, Number(currentTime) || 0);
  const targetSeconds = Number(readAheadSeconds);
  const chunkLimit = Number(maxBytes);
  const overlap = Math.max(0, Number(overlapBytes) || 0);
  if (!Number.isFinite(bytes) || bytes <= 0 || !Number.isFinite(total) || total <= 0
    || !Number.isFinite(targetSeconds) || targetSeconds <= 0 || !Number.isFinite(chunkLimit) || chunkLimit <= 0) return null;

  const availableThrough = Math.min(total, Math.max(position, Number(bufferedEnd) || 0, Number(prefetchedThrough) || 0));
  const targetTime = Math.min(total, position + targetSeconds);
  if (availableThrough + 0.5 >= targetTime) return null;

  const estimatedStart = Math.floor((availableThrough / total) * bytes);
  const startByte = Math.max(0, estimatedStart - overlap);
  const targetEndByte = Math.min(bytes - 1, Math.ceil((targetTime / total) * bytes) - 1);
  const endByte = Math.min(targetEndByte, startByte + Math.floor(chunkLimit) - 1);
  if (endByte < startByte) return null;
  return {
    startByte,
    endByte,
    throughTime: Math.min(total, ((endByte + 1) / bytes) * total)
  };
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
