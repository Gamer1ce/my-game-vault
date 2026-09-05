export const PLAYBACK_ROUTE_SAMPLE_BYTES = 512 * 1024;
export const PLAYBACK_ROUTE_TAIL_SAMPLE_BYTES = 64 * 1024;

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
  tailSampleBytes = PLAYBACK_ROUTE_TAIL_SAMPLE_BYTES,
  fileSize = 0,
  timeoutMs = 8000
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  let received = 0;

  const readRange = async (startByte, endByte) => {
    const response = await fetchImpl(candidate.url, {
      headers: { Range: `bytes=${startByte}-${endByte}` },
      cache: "default",
      signal: controller.signal
    });
    if (response.status !== 206) throw new Error(`Range HTTP ${response.status}`);
    const contentRange = response.headers?.get?.("Content-Range") || "";
    const rangeMatch = contentRange.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
    if (!rangeMatch || Number(rangeMatch[1]) !== startByte || Number(rangeMatch[2]) !== endByte) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error("Content-Range 无效");
    }
    const expected = endByte - startByte + 1;
    let rangeBytes = 0;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      while (rangeBytes < expected) {
        const { done, value } = await reader.read();
        if (done) break;
        rangeBytes += value.byteLength;
      }
      await reader.cancel().catch(() => {});
    } else {
      rangeBytes = (await response.arrayBuffer()).byteLength;
    }
    if (!rangeBytes) throw new Error("empty response");
    return rangeBytes;
  };

  try {
    const bytes = Number(fileSize);
    const headEnd = Number.isFinite(bytes) && bytes > 0
      ? Math.min(sampleBytes - 1, bytes - 1)
      : sampleBytes - 1;
    received += await readRange(0, headEnd);
    let tailVerified = false;
    if (Number.isFinite(bytes) && bytes > sampleBytes + tailSampleBytes) {
      received += await readRange(bytes - tailSampleBytes, bytes - 1);
      tailVerified = true;
    }
    return {
      candidate,
      ok: true,
      bytesPerSecond: received / Math.max(0.001, (performance.now() - startedAt) / 1000),
      tailVerified
    };
  } catch (error) {
    return { candidate, ok: false, bytesPerSecond: 0, error: error?.message || String(error) };
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

export async function rankPlaybackCandidates(candidates, options = {}) {
  if (candidates.length <= 1) return [...candidates];
  const measure = options.measureImpl || measurePlaybackCandidate;
  const results = await Promise.all(candidates.map((candidate) => measure(candidate, options)));
  const successful = results.filter((result) => result.ok)
    .sort((left, right) => right.bytesPerSecond - left.bytesPerSecond);
  const failedIds = new Set(results.filter((result) => !result.ok).map((result) => result.candidate.id));
  return [
    ...successful.map((result) => ({
      ...result.candidate,
      measuredBytesPerSecond: result.bytesPerSecond,
      tailVerified: result.tailVerified === true
    })),
    ...candidates.filter((candidate) => failedIds.has(candidate.id))
  ];
}

export async function selectPlaybackCandidate(candidates, options = {}) {
  return (await rankPlaybackCandidates(candidates, options))[0] || null;
}
