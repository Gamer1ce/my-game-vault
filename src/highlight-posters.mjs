import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const activePosters = new Map();

export function highlightPosterCacheFilename(filename, stats = {}) {
  const fingerprint = [
    String(filename || ""),
    Number(stats.size || 0),
    Math.trunc(Number(stats.mtimeMs || 0))
  ].join("\0");
  return `${createHash("sha256").update(fingerprint).digest("hex")}.jpg`;
}

function usableFile(filename) {
  try {
    const stats = statSync(filename);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

export function createHighlightPosterService({ cacheDirectory, spawnImpl = spawn, timeoutMs = 20_000 } = {}) {
  const directory = path.resolve(String(cacheDirectory || ""));
  mkdirSync(directory, { recursive: true });

  return {
    async posterFor(inputFile, filename, stats, { seekSeconds = 0.5 } = {}) {
      const destination = path.join(directory, highlightPosterCacheFilename(filename, stats));
      if (usableFile(destination)) return destination;
      if (activePosters.has(destination)) return activePosters.get(destination);

      const task = new Promise((resolve, reject) => {
        const temporary = `${destination}.${process.pid}-${randomBytes(5).toString("hex")}.tmp.jpg`;
        const seekArguments = Number(seekSeconds) > 0 ? ["-ss", String(seekSeconds)] : [];
        const child = spawnImpl("ffmpeg", [
          "-hide_banner",
          "-loglevel", "error",
          ...seekArguments,
          "-i", inputFile,
          "-map", "0:v:0",
          "-frames:v", "1",
          "-vf", "scale=960:-2:force_original_aspect_ratio=decrease",
          "-q:v", "4",
          "-an",
          "-sn",
          "-dn",
          "-update", "1",
          "-f", "image2",
          "-c:v", "mjpeg",
          "-y",
          temporary
        ], { stdio: "ignore" });
        let settled = false;
        let timer;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error || !usableFile(temporary)) {
            rmSync(temporary, { force: true });
            reject(error || new Error("视频封面生成失败"));
            return;
          }
          try {
            renameSync(temporary, destination);
            resolve(destination);
          } catch (renameError) {
            rmSync(temporary, { force: true });
            reject(renameError);
          }
        };
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          finish(new Error("视频封面生成超时"));
        }, timeoutMs);
        child.once("error", finish);
        child.once("exit", (code) => finish(code === 0 ? null : new Error(`视频封面生成失败（${code ?? "unknown"}）`)));
      }).finally(() => activePosters.delete(destination));

      activePosters.set(destination, task);
      return task;
    }
  };
}
