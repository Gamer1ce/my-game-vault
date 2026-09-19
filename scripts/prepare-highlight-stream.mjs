// Explicit, local-only preparation. Public requests never start FFmpeg jobs.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, statSync, statfsSync, renameSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { resolveHighlightFile } from "../src/highlights.mjs";
import { STREAM_CACHE_FOLDER, streamId, resolveStreamAsset } from "../src/highlight-streams.mjs";

const [directory, filename] = process.argv.slice(2);
if (!directory || !filename) throw new Error('Usage: node scripts/prepare-highlight-stream.mjs "/media/directory" "relative/video.mp4"');
const { file, stats, realDirectory } = resolveHighlightFile(directory, filename);
const id = streamId(filename, stats.size, stats.mtimeMs);
try {
  resolveStreamAsset(realDirectory, id, "index.m3u8");
  console.log(JSON.stringify({ id, status: "already-prepared" }));
  process.exit(0);
} catch { /* first preparation */ }
const probe = spawnSync(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { encoding: "utf8", timeout: 30_000 });
if (probe.status !== 0) throw new Error("Unable to inspect source video");
const info = JSON.parse(probe.stdout);
const video = info.streams.find(s => s.codec_type === "video");
const audio = info.streams.find(s => s.codec_type === "audio");
if (video?.codec_name !== "h264" || (audio && audio.codec_name !== "aac")) throw new Error("Lossless preparation currently supports H.264/AAC only; original file is unchanged");
const disk = statfsSync(realDirectory);
if (disk.bavail * disk.bsize < stats.size * 1.1 + 1024 ** 3) throw new Error("Not enough space for a lossless playback cache");
const cacheRoot = path.join(realDirectory, STREAM_CACHE_FOLDER);
mkdirSync(cacheRoot, { recursive: true });
const temporary = path.join(cacheRoot, `.prepare-${id}-${process.pid}`);
const destination = path.join(cacheRoot, id);
if (existsSync(destination)) throw new Error("Existing incomplete cache requires local inspection; not overwriting it");
mkdirSync(temporary);
try {
  const result = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-i", file,
    "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy",
    "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod",
    "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
    "-hls_flags", "independent_segments", "-hls_segment_filename", "segment-%05d.m4s", "index.m3u8"
  ], { cwd: temporary, stdio: ["ignore", "inherit", "inherit"], timeout: 30 * 60_000 });
  if (result.status !== 0) throw new Error("FFmpeg stream-copy preparation failed");
  const playlist = readFileSync(path.join(temporary, "index.m3u8"), "utf8");
  const segments = playlist.split(/\r?\n/).filter(line => line && !line.startsWith("#"));
  if (!playlist.includes("#EXT-X-ENDLIST") || !segments.length || segments.some(name => !/^segment-\d{5}\.m4s$/.test(name) || statSync(path.join(temporary, name)).size <= 0)) throw new Error("Incomplete output");
  const after = statSync(file);
  if (streamId(filename, after.size, after.mtimeMs) !== id) throw new Error("Source changed during preparation");
  writeFileSync(path.join(temporary, "metadata.json"), JSON.stringify({ filename, size: stats.size, mtimeMs: Math.trunc(stats.mtimeMs), duration: Number(info.format.duration), codec: video.codec_name, createdAt: new Date().toISOString() }));
  renameSync(temporary, destination);
  console.log(JSON.stringify({ id, status: "prepared", segments: segments.length, duration: Number(info.format.duration), sourceUnchanged: true }));
} finally {
  // Only this run's temporary output is removable; never touch the source.
  rmSync(temporary, { recursive: true, force: true });
}
