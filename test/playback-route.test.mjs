import test from "node:test";
import assert from "node:assert/strict";
import {
  playbackCandidates,
  readPreferredPlaybackRoute,
  savePreferredPlaybackRoute,
  selectPlaybackCandidate
} from "../public/playback-route.js";

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
    sampleBytes: 4,
    fetchImpl: async (url) => {
      if (url.includes("media-cn")) await new Promise((resolve) => setTimeout(resolve, 2));
      else await new Promise((resolve) => setTimeout(resolve, 15));
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 206 });
    }
  });
  assert.equal(selected.id, "aliyun-esa");
  assert.equal((await selectPlaybackCandidate(candidates, { preferredId: "cloudflare" })).id, "cloudflare");
});
