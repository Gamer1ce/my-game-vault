import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, statSync, symlinkSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveStreamAsset, streamId, streamUrlFor } from "../src/highlight-streams.mjs";
import { listHighlights } from "../src/highlights.mjs";
import { segmentedUrl, SEGMENT_BUFFER_CONFIG } from "../public/segmented-playback.js";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "stream-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "video.mp4"), "original");
  const stats = statSync(path.join(root, "video.mp4"));
  const id = streamId("video.mp4", stats.size, stats.mtimeMs);
  const cache = path.join(root, ".playback-cache", id);
  mkdirSync(cache, { recursive: true });
  writeFileSync(path.join(cache, "metadata.json"), JSON.stringify({ filename: "video.mp4" }));
  writeFileSync(path.join(cache, "index.m3u8"), "#EXTM3U\n#EXT-X-ENDLIST\n");
  writeFileSync(path.join(cache, "init.mp4"), "init");
  writeFileSync(path.join(cache, "segment-00000.m4s"), "segment");
  return { root, cache, id };
}

test("stream assets are read-only, original-bound and hidden from the media gallery", t => {
  const { root, id } = fixture(t);
  const items = listHighlights(root);
  assert.equal(items.length, 1);
  assert.equal(streamUrlFor(root, items[0]), `/media/highlight-streams/${id}/index.m3u8`);
  assert.equal(resolveStreamAsset(root, id, "index.m3u8").type, "application/vnd.apple.mpegurl");
  assert.equal(resolveStreamAsset(root, id, "segment-00000.m4s").type, "video/mp4");
  for (const name of ["metadata.json", "../video.mp4", "segment-0.m4s", "private.env"]) assert.throws(() => resolveStreamAsset(root, id, name));
  assert.throws(() => resolveStreamAsset(root, "../private", "index.m3u8"));
  unlinkSync(path.join(root, "video.mp4"));
  assert.throws(() => resolveStreamAsset(root, id, "index.m3u8"));
});

test("replaced source and symlinked cache assets cannot leak old or outside files", t => {
  const { root, id, cache } = fixture(t);
  unlinkSync(path.join(cache, "init.mp4"));
  symlinkSync(path.join(root, "video.mp4"), path.join(cache, "init.mp4"));
  assert.throws(() => resolveStreamAsset(root, id, "init.mp4"));
  writeFileSync(path.join(root, "video.mp4"), "a replaced source");
  assert.throws(() => resolveStreamAsset(root, id, "index.m3u8"));
  assert.equal(streamUrlFor(root, listHighlights(root)[0]), null);
});

test("segmented playback stays on the chosen node and rejects arbitrary manifest addresses", () => {
  const manifest = `/media/highlight-streams/${"a".repeat(32)}/index.m3u8`;
  assert.equal(segmentedUrl("https://media.example:8443/media/highlights/video.mp4?v=1", manifest), `https://media.example:8443${manifest}`);
  assert.equal(segmentedUrl("https://media.example/media/highlights/video.mp4", "https://elsewhere.example/index.m3u8"), null);
  assert.equal(segmentedUrl("https://media.example/api/key", manifest), null);
  assert.equal(SEGMENT_BUFFER_CONFIG.maxBufferLength, 16);
  assert.equal(SEGMENT_BUFFER_CONFIG.backBufferLength, 4);
  assert.equal(SEGMENT_BUFFER_CONFIG.enableWorker, false);
});
