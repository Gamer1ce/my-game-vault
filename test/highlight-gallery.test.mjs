import assert from "node:assert/strict";
import test from "node:test";
import { filteredHighlightEntries, highlightCounts, normalizeHighlightType, shuffleHighlights } from "../public/highlight-gallery.js";

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
