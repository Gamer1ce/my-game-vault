import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { resolveHighlightFile } from "./highlights.mjs";

export const STREAM_CACHE_FOLDER = ".playback-cache";
export function streamId(filename, size, mtimeMs) {
  return createHash("sha256").update(JSON.stringify([filename, Number(size), Math.trunc(Number(mtimeMs)), "hls-fmp4-v1"])).digest("hex").slice(0, 32);
}

function regularPath(root, parts) {
  let file = realpathSync(root);
  for (let i = 0; i < parts.length; i++) {
    file = path.join(file, parts[i]);
    const stats = lstatSync(file);
    if (stats.isSymbolicLink() || (i < parts.length - 1 ? !stats.isDirectory() : !stats.isFile())) throw new Error("Invalid stream path");
  }
  return file;
}

export function resolveStreamAsset(directory, id, asset) {
  if (!/^[a-f0-9]{32}$/.test(id) || !/^(index\.m3u8|init\.mp4|segment-\d{5}\.m4s)$/.test(asset)) throw new Error("Invalid stream asset");
  const metadataPath = regularPath(directory, [STREAM_CACHE_FOLDER, id, "metadata.json"]);
  if (lstatSync(metadataPath).size > 4096) throw new Error("Invalid metadata");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  const { stats } = resolveHighlightFile(directory, metadata.filename);
  if (streamId(metadata.filename, stats.size, stats.mtimeMs) !== id) throw new Error("Stale stream");
  const file = regularPath(directory, [STREAM_CACHE_FOLDER, id, asset]);
  return { file, type: asset.endsWith("m3u8") ? "application/vnd.apple.mpegurl" : "video/mp4" };
}

export function streamUrlFor(directory, item) {
  if (item.type !== "video") return null;
  try {
    // Date serialization can round sub-millisecond filesystem timestamps.
    const { stats } = resolveHighlightFile(directory, item.filename);
    const id = streamId(item.filename, stats.size, stats.mtimeMs);
    resolveStreamAsset(directory, id, "index.m3u8");
    return `/media/highlight-streams/${id}/index.m3u8`;
  } catch { return null; }
}
