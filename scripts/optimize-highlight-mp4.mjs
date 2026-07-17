import { chmodSync, renameSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { listHighlights, resolveHighlightsDirectory } from "../src/highlights.mjs";
import { fastStartStatus } from "../src/mp4-faststart.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDirectory = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, "data");
const storage = resolveHighlightsDirectory(dataDirectory);
const dryRun = process.argv.includes("--dry-run");
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const supported = new Set([".mp4", ".m4v", ".mov"]);
const videos = listHighlights(storage.directory, 5000).filter((item) => supported.has(path.extname(item.filename).toLowerCase()));

if (spawnSync(ffmpeg, ["-version"], { stdio: "ignore" }).status !== 0) throw new Error("没有找到 FFmpeg，无法执行无损 Fast Start 优化");
if (!videos.length) throw new Error(`没有找到可优化的 MP4/MOV 视频：${storage.directory}`);

let optimized = 0;
let skipped = 0;
let failed = 0;
for (let index = 0; index < videos.length; index += 1) {
  const item = videos[index];
  const source = path.join(storage.directory, item.filename);
  const label = `[${index + 1}/${videos.length}] ${item.filename}`;
  try {
    const before = fastStartStatus(source);
    if (!before.supported) {
      failed += 1;
      console.error(`${label} · 未找到标准 moov/mdat 结构，跳过`);
      continue;
    }
    if (before.optimized) {
      skipped += 1;
      console.log(`${label} · 索引已在文件开头，跳过`);
      continue;
    }
    if (dryRun) {
      console.log(`${label} · 需要无损重排索引`);
      continue;
    }

    const extension = path.extname(item.filename).toLowerCase();
    const temporary = path.join(storage.directory, `.${path.basename(item.filename, extension)}.${process.pid}.faststart${extension}`);
    try {
      const original = statSync(source);
      const result = spawnSync(ffmpeg, [
        "-hide_banner", "-loglevel", "error", "-i", source,
        "-map", "0", "-map_metadata", "0", "-c", "copy", "-movflags", "+faststart", "-y", temporary
      ], { stdio: ["ignore", "inherit", "inherit"] });
      if (result.status !== 0) throw new Error(`FFmpeg 退出码 ${result.status}`);
      const after = fastStartStatus(temporary);
      if (!after.supported || !after.optimized || statSync(temporary).size <= 0) throw new Error("输出文件结构校验失败");
      chmodSync(temporary, original.mode);
      utimesSync(temporary, original.atime, original.mtime);
      renameSync(temporary, source);
      optimized += 1;
      console.log(`${label} · 优化完成（音视频流未重新编码）`);
    } catch (error) {
      try { unlinkSync(temporary); } catch {}
      throw error;
    }
  } catch (error) {
    failed += 1;
    console.error(`${label} · 失败：${error.message}`);
  }
}

console.log(dryRun
  ? `检查完成：${videos.length} 个文件，${skipped} 个已优化，${failed} 个无法处理`
  : `Fast Start 完成：优化 ${optimized} 个，跳过 ${skipped} 个，失败 ${failed} 个`);
if (failed) process.exitCode = 1;
