import assert from "node:assert/strict";
import test from "node:test";
import { highlightPosterCacheFilename } from "../src/highlight-posters.mjs";

test("视频封面缓存名不暴露原文件名并随文件变化", () => {
  const first = highlightPosterCacheFilename("秘密录像.mp4", { size: 100, mtimeMs: 1_000 });
  const same = highlightPosterCacheFilename("秘密录像.mp4", { size: 100, mtimeMs: 1_000 });
  const changed = highlightPosterCacheFilename("秘密录像.mp4", { size: 101, mtimeMs: 1_000 });
  assert.match(first, /^[a-f0-9]{64}\.jpg$/);
  assert.equal(first, same);
  assert.notEqual(first, changed);
  assert.equal(first.includes("秘密录像"), false);
});
