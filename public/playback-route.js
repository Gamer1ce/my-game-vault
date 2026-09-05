export const PLAYBACK_ROUTE_SAMPLE_BYTES = 512 * 1024;

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

export function localPlaybackCandidates(localUrl, { pageOrigin, directOrigin, mirrorOrigin } = {}) {
  try {
    const siteUrl = new URL(localUrl, pageOrigin);
    if (!siteUrl.pathname.startsWith("/media/highlights/")) return [];
    const candidates = [];
    const addOrigin = (id, label, origin) => {
      if (!origin) return;
      const base = new URL(origin);
      if (base.protocol !== "https:" || base.origin === siteUrl.origin
        || candidates.some((candidate) => new URL(candidate.url).origin === base.origin)) return;
      candidates.push({
        id,
        label,
        url: new URL(`${siteUrl.pathname}${siteUrl.search}`, `${base.origin}/`).href
      });
    };
    addOrigin("home-ipv6-direct", "家庭 IPv6 直连", directOrigin);
    addOrigin("azure-mirror", "Azure 镜像", mirrorOrigin);
    candidates.push({
      id: "site-proxy",
      label: "Cloudflare 兼容线路",
      url: siteUrl.href
    });
    return candidates;
  } catch {
    return [];
  }
}

export async function measurePlaybackCandidate(candidate, {
  fetchImpl = fetch,
  sampleBytes = PLAYBACK_ROUTE_SAMPLE_BYTES,
  timeoutMs = 6000
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  let received = 0;
  try {
    const response = await fetchImpl(candidate.url, {
      headers: { Range: `bytes=0-${sampleBytes - 1}` },
      cache: "default",
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
  const measure = options.measureImpl || measurePlaybackCandidate;
  const results = await Promise.all(candidates.map((candidate) => measure(candidate, options)));
  const successful = results.filter((result) => result.ok)
    .sort((left, right) => right.bytesPerSecond - left.bytesPerSecond);
  return successful[0]?.candidate || candidates[0];
}
