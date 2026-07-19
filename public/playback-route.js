export const PLAYBACK_ROUTE_SAMPLE_BYTES = 256 * 1024;
export const PLAYBACK_ROUTE_CACHE_KEY = "game-vault:baidu-media-route:v1";
export const PLAYBACK_ROUTE_CACHE_TTL_MS = 10 * 60 * 1000;

export function playbackCandidates(playback) {
  const candidates = Array.isArray(playback?.candidates) ? playback.candidates : [];
  const normalized = candidates.filter((candidate) => candidate
    && typeof candidate.id === "string"
    && typeof candidate.url === "string");
  if (normalized.length) return normalized;
  return typeof playback?.url === "string"
    ? [{ id: "default", label: "默认线路", url: playback.url }]
    : [];
}

export function readPreferredPlaybackRoute(storage) {
  try {
    const saved = JSON.parse(storage?.getItem(PLAYBACK_ROUTE_CACHE_KEY) || "null");
    const savedAt = Number(saved?.savedAt || 0);
    return saved && typeof saved.id === "string" && savedAt + PLAYBACK_ROUTE_CACHE_TTL_MS > Date.now()
      ? saved.id
      : null;
  } catch {
    return null;
  }
}

export function savePreferredPlaybackRoute(storage, candidate) {
  try {
    storage?.setItem(PLAYBACK_ROUTE_CACHE_KEY, JSON.stringify({ id: candidate.id, savedAt: Date.now() }));
  } catch {
    // Storage can be disabled in private browsing; route selection still works for this playback.
  }
}

export async function measurePlaybackCandidate(candidate, {
  fetchImpl = fetch,
  sampleBytes = PLAYBACK_ROUTE_SAMPLE_BYTES,
  timeoutMs = 9000
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  let received = 0;
  try {
    const response = await fetchImpl(candidate.url, {
      headers: { Range: `bytes=0-${sampleBytes - 1}` },
      cache: "no-store",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      while (received < sampleBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
      }
      await reader.cancel().catch(() => {});
    } else {
      received = (await response.arrayBuffer()).byteLength;
    }
    if (!received) throw new Error("empty response");
    return {
      candidate,
      ok: true,
      bytesPerSecond: received / Math.max(0.001, (performance.now() - startedAt) / 1000)
    };
  } catch (error) {
    return { candidate, ok: false, bytesPerSecond: 0, error: error?.message || String(error) };
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

export async function selectPlaybackCandidate(candidates, options = {}) {
  if (candidates.length <= 1) return candidates[0] || null;
  const preferredId = options.preferredId;
  const preferred = preferredId && candidates.find((candidate) => candidate.id === preferredId);
  if (preferred) return preferred;
  const measure = options.measureImpl || measurePlaybackCandidate;
  const results = await Promise.all(candidates.map((candidate) => measure(candidate, options)));
  const successful = results.filter((result) => result.ok)
    .sort((left, right) => right.bytesPerSecond - left.bytesPerSecond);
  return successful[0]?.candidate || candidates[0];
}
