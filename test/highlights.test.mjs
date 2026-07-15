import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { highlightTitle, listHighlights, resolveHighlightsDirectory } from "../src/highlights.mjs";

test("精彩时刻只列出受支持的普通媒体文件", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "game-vault-highlights-"));
  try {
    writeFileSync(path.join(directory, "夜之城_终章.mp4"), "video");
    writeFileSync(path.join(directory, "截图 01.PNG"), "image");
    writeFileSync(path.join(directory, "说明.txt"), "ignore");
    writeFileSync(path.join(directory, ".hidden.jpg"), "ignore");
    mkdirSync(path.join(directory, "album.jpg"));

    const items = listHighlights(directory);
    assert.equal(items.length, 2);
    assert.deepEqual(new Set(items.map((item) => item.type)), new Set(["image", "video"]));
    assert.ok(items.every((item) => item.url.startsWith("/media/highlights/")));
    assert.ok(items.find((item) => item.filename === "截图 01.PNG")?.url.includes("%E6%88%AA%E5%9B%BE%2001.PNG"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("文件名会成为适合展示的标题", () => {
  assert.equal(highlightTitle("赛博朋克2077_精彩击杀.mp4"), "赛博朋克2077 精彩击杀");
  assert.equal(highlightTitle("Screenshot-2026-07-15.jpg"), "Screenshot-2026-07-15");
});

test("精彩时刻目录支持外置硬盘配置并以环境变量优先", () => {
  const dataDirectory = mkdtempSync(path.join(tmpdir(), "game-vault-data-"));
  try {
    writeFileSync(path.join(dataDirectory, "highlights-path.txt"), "/Volumes/GameDisk/Captures\n");
    assert.deepEqual(resolveHighlightsDirectory(dataDirectory, { environment: {}, homeDirectory: "/Users/test" }), {
      directory: "/Volumes/GameDisk/Captures",
      custom: true,
      source: "file"
    });
    assert.deepEqual(resolveHighlightsDirectory(dataDirectory, { environment: { HIGHLIGHTS_DIR: "~/External Clips" }, homeDirectory: "/Users/test" }), {
      directory: "/Users/test/External Clips",
      custom: true,
      source: "environment"
    });
  } finally {
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test("外置目录暂时离线时返回空清单", () => {
  assert.deepEqual(listHighlights("/Volumes/does-not-exist/game-vault"), []);
});
