import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { highlightTitle, listHighlights, resolveHighlightFile, isSafeHighlightPath, resolveHighlightsDirectory } from "../src/highlights.mjs";

test("递归扫描保留完整路径、根目录链接和同名文件", () => {
  const root = mkdtempSync(path.join(tmpdir(), "recursive-media-"));
  try {
    for (const folder of ["PS5/CREATE/Video Clips/游戏 A", "SWITCH/游戏 B"]) {
      mkdirSync(path.join(root, folder), { recursive: true });
      writeFileSync(path.join(root, folder, "same.mp4"), folder);
    }
    writeFileSync(path.join(root, "same.mp4"), "root");
    const items = listHighlights(root);
    assert.equal(items.length, 3);
    assert.equal(new Set(items.map(x => x.filename)).size, 3);
    assert.equal(items.find(x => x.filename === "same.mp4").url.split("?")[0], "/media/highlights/same.mp4");
    const nested = items.find(x => x.filename.startsWith("PS5/"));
    assert.equal(nested.title, "same");
    assert.equal(decodeURIComponent(nested.url.split("?")[0].slice("/media/highlights/".length)), nested.filename);
    assert.equal(resolveHighlightFile(root, nested.filename).stats.size, nested.size);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("隐藏目录、回收站和符号链接既不列出也不能直接读取", () => {
  const root = mkdtempSync(path.join(tmpdir(), "safe-media-"));
  const outside = mkdtempSync(path.join(tmpdir(), "outside-media-"));
  try {
    writeFileSync(path.join(outside, "secret.mp4"), "private");
    for (const folder of [".Trashes", "$RECYCLE.BIN", "System Volume Information", ".private"]) {
      mkdirSync(path.join(root, folder)); writeFileSync(path.join(root, folder, "clip.mp4"), "private");
      assert.throws(() => resolveHighlightFile(root, `${folder}/clip.mp4`));
    }
    symlinkSync(outside, path.join(root, "linked-folder"));
    symlinkSync(path.join(outside, "secret.mp4"), path.join(root, "linked.mp4"));
    assert.equal(listHighlights(root).length, 0);
    assert.throws(() => resolveHighlightFile(root, "linked-folder/secret.mp4"));
    assert.throws(() => resolveHighlightFile(root, "linked.mp4"));
    for (const name of ["../secret.mp4", "/tmp/secret.mp4", "a/../secret.mp4", "a\\secret.mp4", "a//b.mp4", "a/./b.mp4", "a/\0b.mp4"]) {
      assert.equal(isSafeHighlightPath(name), false, name);
    }
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

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
    assert.ok(items.every((item) => item.url.includes("?v=")));
    assert.ok(items.find((item) => item.type === "video")?.posterUrl.startsWith("/media/highlight-posters/"));
    assert.ok(items.find((item) => item.type === "image")?.posterUrl.startsWith("/media/highlight-thumbnails/"));
    assert.ok(items.find((item) => item.filename === "截图 01.PNG")?.url.includes("%E6%88%AA%E5%9B%BE%2001.PNG"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("精彩时刻按文件大小从小到大排列", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "game-vault-highlight-size-"));
  try {
    writeFileSync(path.join(directory, "大型.webm"), Buffer.alloc(80));
    writeFileSync(path.join(directory, "小型.webm"), Buffer.alloc(8));
    writeFileSync(path.join(directory, "中型.webm"), Buffer.alloc(32));

    const items = listHighlights(directory);
    assert.deepEqual(items.map((item) => item.filename), ["小型.webm", "中型.webm", "大型.webm"]);
    assert.deepEqual(items.map((item) => item.size), [8, 32, 80]);
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
