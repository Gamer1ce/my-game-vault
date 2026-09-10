export const STARTUP_WAIT_MS = 20_000;

// A play request can remain pending without a decoded frame (notably on mobile).
export function playbackStartupState({ readyState = 0, requestedAt = null, now = 0, error = null } = {}) {
  if (error) return { message: error, label: "重试播放", disabled: false };
  if (requestedAt === null) return {
    message: readyState < 1 ? "线路已就绪，点击播放开始加载视频。" : "点击播放原画，加载期间会继续缓冲。",
    label: "播放原画", disabled: false
  };
  if (now - requestedAt >= STARTUP_WAIT_MS) return {
    message: "暂未收到可播放画面。可以重试，或点击“换条线路”。",
    label: "重试播放", disabled: false
  };
  return { message: readyState < 1 ? "正在加载视频信息…" : "正在缓冲第一段画面…", label: "正在加载…", disabled: true };
}
