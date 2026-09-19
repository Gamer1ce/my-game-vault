// Only TimeRanges represent data the media element can actually play. A fetch
// into the HTTP cache is not a media buffer and must never count as one.
export function playableBuffer(video) {
  const position = Math.max(0, Number(video.currentTime) || 0);
  for (let index = 0; index < video.buffered.length; index += 1) {
    if (video.buffered.start(index) <= position + 0.05 && video.buffered.end(index) >= position) {
      return Math.max(0, video.buffered.end(index) - position);
    }
  }
  return 0;
}

export function averageMediaBitrate(size, duration) {
  return Number(size) > 0 && Number(duration) > 0 && Number.isFinite(Number(duration))
    ? Number(size) * 8 / Number(duration) : 0;
}

export function recoveryBufferTarget({ duration, currentTime = 0, stalls = 1 } = {}) {
  const remaining = Math.max(0, Number(duration) - Number(currentTime));
  if (!Number.isFinite(remaining)) return 12;
  return Math.min(remaining, Math.min(30, 8 + Math.max(1, stalls) * 4));
}

export function recoveryState({ ahead, target, now, lastProgressAt, networkState }) {
  if (ahead >= target - 0.1) return "ready";
  // Safari may stop loading while paused. Do not loop play/pause or promise
  // an unreachable buffer target: keep the cached data and offer manual resume.
  if (now - lastProgressAt >= 12_000 && networkState !== 2) return "suspended";
  if (now - lastProgressAt >= 30_000) return "stalled";
  return "loading";
}

export function droppedFrameRatio(previous, current) {
  const frames = Number(current?.totalVideoFrames) - Number(previous?.totalVideoFrames);
  const dropped = Number(current?.droppedVideoFrames) - Number(previous?.droppedVideoFrames);
  return frames >= 60 && dropped >= 0 ? dropped / frames : 0;
}
