import test from "node:test";
import assert from "node:assert/strict";
import {
  localPlaybackCandidates,
  playbackCandidates,
  readPreferredPlaybackRoute,
  savePreferredPlaybackRoute,
  selectPlaybackCandidate
} from "../public/playback-route.js";

test("本机视频优先测速 IPv6 直连并保留网站兼容线路", () => {
  assert.deepEqual(localPlaybackCandidates("/media/highlights/clip%20one.mp4?v=42", {
    pageOrigin: "https://gamer1ce.top",
    directOrigin: "https://steamway.gamer1ce.top"
  }), [
    {
      id: "home-ipv6-direct",
      label: "家庭 IPv6 直连",
      url: "https://steamway.gamer1ce.top/media/highlights/clip%20one.mp4?v=42"
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

test("已选择的媒体线路保存在当前会话", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key),
    setItem: (key, value) => values.set(key, value)
  };
  savePreferredPlaybackRoute(storage, { id: "aliyun-esa" });
  assert.equal(readPreferredPlaybackRoute(storage), "aliyun-esa");
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
  assert.equal((await selectPlaybackCandidate(candidates, { preferredId: "cloudflare" })).id, "cloudflare");
});
