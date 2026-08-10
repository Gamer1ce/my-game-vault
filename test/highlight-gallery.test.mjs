import assert from "node:assert/strict";
import test from "node:test";
import {
  arrangeHighlightsForPlayback,
  canUseDirectLocalPlayback,
  filteredHighlightEntries,
  highlightCounts,
  normalizeHighlightType,
  shuffleHighlights
} from "../public/highlight-gallery.js";

const highlights = [
  { filename: "clip.webm", type: "video" },
  { filename: "shot.png", type: "image" },
  { filename: "clip-2.mp4", type: "video" },
  { filename: "notes.txt", type: "unknown" }
];

test("精彩时刻统计视频与截图数量", () => {
  assert.deepEqual(highlightCounts(highlights), { video: 2, image: 1 });
});

test("精彩时刻切换类型时保留原始数组索引", () => {
  assert.deepEqual(filteredHighlightEntries(highlights, "image"), [{ item: highlights[1], sourceIndex: 1 }]);
  assert.deepEqual(filteredHighlightEntries(highlights, "video").map(({ sourceIndex }) => sourceIndex), [0, 2]);
});

test("无效精彩时刻类型安全回退到视频", () => {
  assert.equal(normalizeHighlightType("all"), "video");
  assert.equal(normalizeHighlightType("image"), "image");
});

test("精彩时刻在加载时随机排列且不修改原始清单", () => {
  const original = [...highlights];
  const randomValues = [0, 0, 0];
  const shuffled = shuffleHighlights(highlights, () => randomValues.shift());

  assert.deepEqual(highlights, original);
  assert.deepEqual(shuffled.map(({ filename }) => filename), ["shot.png", "clip-2.mp4", "notes.txt", "clip.webm"]);
});

test("视频按体积分组后随机，避免首屏被超大文件占满", () => {
  const megabyte = 1024 * 1024;
  const items = [
    { filename: "huge.mp4", type: "video", size: 400 * megabyte },
    { filename: "small-a.mp4", type: "video", size: 12 * megabyte },
    { filename: "medium.mp4", type: "video", size: 80 * megabyte },
    { filename: "small-b.webm", type: "video", size: 20 * megabyte },
    { filename: "shot-a.png", type: "image", size: 2 * megabyte },
    { filename: "shot-b.png", type: "image", size: 1 * megabyte }
  ];
  const arranged = arrangeHighlightsForPlayback(items, () => 0);
  assert.deepEqual(arranged.filter((item) => item.type === "video").map((item) => item.filename), [
    "small-b.webm",
    "small-a.mp4",
    "medium.mp4",
    "huge.mp4"
  ]);
  assert.deepEqual(new Set(arranged.filter((item) => item.type === "image").map((item) => item.filename)), new Set(["shot-a.png", "shot-b.png"]));
});

test("只有没有云端副本的本机视频跳过播放接口", () => {
  const local = { type: "video", url: "/media/highlights/local.mp4", remoteAvailable: false };
  assert.equal(canUseDirectLocalPlayback(local), true);
  assert.equal(canUseDirectLocalPlayback({ ...local, remoteAvailable: true }), false);
  assert.equal(canUseDirectLocalPlayback({ ...local, storageSource: "baidu" }), false);
  assert.equal(canUseDirectLocalPlayback({ ...local, url: "https://media.example/local.mp4" }), false);
});
