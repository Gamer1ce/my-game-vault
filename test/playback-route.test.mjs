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

test("线路测速使用持续速度样本", () => {
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
