import test from "node:test";
import assert from "node:assert/strict";
import {
  PLAYBACK_ROUTE_SAMPLE_BYTES,
  localPlaybackCandidates,
  playbackCandidates,
  selectPlaybackCandidate
} from "../public/playback-route.js";

test("线路测速使用持续速度样本", () => {
  assert.equal(PLAYBACK_ROUTE_SAMPLE_BYTES, 512 * 1024);
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
