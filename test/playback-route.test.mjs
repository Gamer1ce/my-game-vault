import test from "node:test";
import assert from "node:assert/strict";
import {
  PLAYBACK_ROUTE_SAMPLE_BYTES,
  PLAYBACK_ROUTE_TAIL_SAMPLE_BYTES,
  localPlaybackCandidates,
  measurePlaybackCandidate,
  playbackCandidates,
  rankPlaybackCandidates,
  selectPlaybackCandidate
} from "../public/playback-route.js";

test("已验证的家庭直连不等待兼容线路测速，也不被 CDN 小样本抢走", async () => {
  const candidates = [{ id: "home-ipv6-direct", url: "https://direct.example/video" }, { id: "site-proxy", url: "https://relay.example/video" }];
  const measured = [];
  const result = await rankPlaybackCandidates(candidates, { preferDirect: true, measureImpl: async candidate => {
    measured.push(candidate.id);
    if (candidate.id === "site-proxy") throw new Error("slow relay must not be requested");
    return { ok: true, bytesPerSecond: 5_000_000, tailVerified: true };
  } });
  assert.deepEqual(measured, ["home-ipv6-direct"]);
  assert.deepEqual(result.map(x => x.id), ["home-ipv6-direct", "site-proxy"]);
  assert.equal(result[0].tailVerified, true);
});

test("直连失败立即使用唯一兼容入口，取消选路后不再开始播放", async () => {
  const candidates = [{ id: "home-ipv6-direct", url: "https://direct.example/video" }, { id: "site-proxy", url: "https://relay.example/video" }];
  let calls = 0;
  const result = await rankPlaybackCandidates(candidates, { preferDirect: true, measureImpl: async () => { calls++; return { ok: false }; } });
  assert.equal(calls, 1); assert.equal(result[0].id, "site-proxy");
  const controller = new AbortController();
  assert.deepEqual(await rankPlaybackCandidates(candidates, { preferDirect: true, signal: controller.signal, measureImpl: async () => { controller.abort(); return { ok: true }; } }), []);
});

test("线路检测使用有限的连通性样本，不声称测量持续速度", () => {
  assert.equal(PLAYBACK_ROUTE_SAMPLE_BYTES, 512 * 1024);
  assert.equal(PLAYBACK_ROUTE_TAIL_SAMPLE_BYTES, 64 * 1024);
});

test("本机视频优先测速 IPv6 直连并保留网站兼容线路", () => {
  assert.deepEqual(localPlaybackCandidates("/media/highlights/clip%20one.mp4?v=42", {
    pageOrigin: "https://gamer1ce.top",
    directOrigin: "https://steamway.gamer1ce.top",
    mirrorOrigin: "https://azure.gamer1ce.top"
  }), [
    {
      id: "home-ipv6-direct",
      label: "家庭 IPv6 直连",
      url: "https://steamway.gamer1ce.top/media/highlights/clip%20one.mp4?v=42"
    },
    {
      id: "azure-mirror",
      label: "Azure 镜像",
      url: "https://azure.gamer1ce.top/media/highlights/clip%20one.mp4?v=42"
    },
    {
      id: "site-proxy",
      label: "Cloudflare 兼容线路",
      url: "https://gamer1ce.top/media/highlights/clip%20one.mp4?v=42"
    }
  ]);
  assert.deepEqual(localPlaybackCandidates("/api/games", {
    pageOrigin: "https://gamer1ce.top",
    directOrigin: "https://steamway.gamer1ce.top"
  }), []);
});

test("家庭直连保留自定义 HTTPS 端口、编码路径和版本参数", () => {
  const candidates = localPlaybackCandidates("/media/highlights/clip%20one.mp4?v=42", {
    pageOrigin: "https://gamer1ce.top",
    directOrigin: "https://steamway.gamer1ce.top:8443",
    mirrorOrigin: "https://azure.gamer1ce.top"
  });
  assert.equal(candidates[0].url, "https://steamway.gamer1ce.top:8443/media/highlights/clip%20one.mp4?v=42");
  assert.equal(candidates[0].id, "home-ipv6-direct");
  assert.equal(candidates[2].url, "https://gamer1ce.top/media/highlights/clip%20one.mp4?v=42");
});

test("旧版单线路播放响应保持兼容", () => {
  assert.deepEqual(playbackCandidates({ url: "https://media.example/v1/token/video.mp4" }), [{
    id: "default",
    label: "默认线路",
    url: "https://media.example/v1/token/video.mp4"
  }]);
});

test("双线路首次播放选择实测速率更高的候选", async () => {
  const candidates = [
    { id: "aliyun-esa", url: "https://media-cn.example/video" },
    { id: "cloudflare", url: "https://media.example/video" }
  ];
  const selected = await selectPlaybackCandidate(candidates, {
    measureImpl: async (candidate) => ({
      candidate,
      ok: true,
      bytesPerSecond: candidate.id === "aliyun-esa" ? 8_000_000 : 1_000_000
    })
  });
  assert.equal(selected.id, "aliyun-esa");
});

test("每个视频都重新测速，不盲从上次的线路", async () => {
  const candidates = [
    { id: "home-ipv6-direct", url: "https://direct.example/video" },
    { id: "azure-mirror", url: "https://azure.example/video" }
  ];
  let measured = 0;
  const selected = await selectPlaybackCandidate(candidates, {
    preferredId: "azure-mirror",
    measureImpl: async (candidate) => {
      measured += 1;
      return { candidate, ok: true, bytesPerSecond: candidate.id === "home-ipv6-direct" ? 8_000_000 : 1_000_000 };
    }
  });
  assert.equal(measured, 2);
  assert.equal(selected.id, "home-ipv6-direct");
});

test("测速同时验证文件尾部 Range，避免小样本成功而真实播放失败", async () => {
  const ranges = [];
  const result = await measurePlaybackCandidate({ id: "direct", url: "https://direct.example/video.mp4" }, {
    fileSize: 100,
    sampleBytes: 8,
    tailSampleBytes: 4,
    fetchImpl: async (_url, options) => {
      assert.equal(options.cache, "no-store");
      const range = options.headers.Range;
      ranges.push(range);
      const [start, end] = range.slice(6).split("-").map(Number);
      return new Response(new Uint8Array(end - start + 1), {
        status: 206,
        headers: { "Content-Range": `bytes ${start}-${end}/100` }
      });
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.tailVerified, true);
  assert.deepEqual(ranges, ["bytes=0-7", "bytes=96-99"]);
});

test("忽略不支持 Range 的假成功线路，备用顺序按实测速度排列", async () => {
  const candidates = [
    { id: "direct", url: "https://direct.example/video" },
    { id: "azure", url: "https://azure.example/video" },
    { id: "proxy", url: "https://proxy.example/video" }
  ];
  const ranked = await rankPlaybackCandidates(candidates, {
    measureImpl: async (candidate) => candidate.id === "direct"
      ? { candidate, ok: false, bytesPerSecond: 0 }
      : { candidate, ok: true, bytesPerSecond: candidate.id === "proxy" ? 5_000_000 : 2_000_000, tailVerified: true }
  });
  assert.deepEqual(ranked.map((candidate) => candidate.id), ["proxy", "azure", "direct"]);
  assert.equal(ranked[0].measuredBytesPerSecond, 5_000_000);

  const rejected = await measurePlaybackCandidate(candidates[0], {
    sampleBytes: 8,
    fetchImpl: async () => new Response(new Uint8Array(8), { status: 200 })
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /Range HTTP 200/);
});

test("Range 响应头正确但正文被截断时不可作为成功测速", async () => {
  const result = await measurePlaybackCandidate({ id: "direct", url: "https://example.org/video" }, {
    sampleBytes: 8,
    fetchImpl: async () => new Response(new Uint8Array(4), {
      status: 206, headers: { "Content-Range": "bytes 0-7/100" }
    })
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /incomplete/);
});

test("大文件使用更长的有限样本，仍检查尾部且不整片下载", async () => {
  const ranges = [];
  const size = 4 * 1024 ** 3;
  const result = await measurePlaybackCandidate({ url: "https://example.org/large.mp4" }, {
    fileSize: size,
    fetchImpl: async (_url, { headers }) => {
      const [start, end] = headers.Range.slice(6).split("-").map(Number);
      ranges.push([start, end]);
      return new Response(new Uint8Array(end - start + 1), { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${size}` } });
    }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(ranges, [[0, 2 * 1024 ** 2 - 1], [size - PLAYBACK_ROUTE_TAIL_SAMPLE_BYTES, size - 1]]);
});

test("忽略 Range 的响应立即取消，防止后台下载整部大视频", async () => {
  let cancelled = false;
  const result = await measurePlaybackCandidate({ url: "https://example.org/video" }, {
    fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 200 })
  });
  assert.equal(result.ok, false);
  assert.equal(cancelled, true);
});

test("关闭播放器立即取消仍在读取的线路样本", async () => {
  const controller = new AbortController();
  let requested;
  const began = new Promise(resolve => { requested = resolve; });
  const result = measurePlaybackCandidate({ url: "https://example.org/video" }, {
    signal: controller.signal,
    fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }); requested();
    })
  });
  await began; controller.abort();
  assert.equal((await result).ok, false);
});
