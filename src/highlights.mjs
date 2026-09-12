import { existsSync, readFileSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const mediaExtensions = new Map([
  [".jpg", "image"],
  [".jpeg", "image"],
  [".png", "image"],
  [".webp", "image"],
  [".gif", "image"],
  [".avif", "image"],
  [".mp4", "video"],
  [".webm", "video"],
  [".mov", "video"],
  [".m4v", "video"]
]);

export function highlightTitle(filename) {
  const extension = path.extname(filename);
  return path.basename(filename, extension).replace(/_+/g, " ").trim() || "未命名精彩时刻";
}

function configuredPath(value, homeDirectory) {
  const firstLine = String(value || "").split(/\r?\n/, 1)[0].trim();
  if (!firstLine || firstLine.length > 4096 || firstLine.includes("\0")) return null;
  const expanded = firstLine === "~" ? homeDirectory : firstLine.startsWith("~/") ? path.join(homeDirectory, firstLine.slice(2)) : firstLine;
  return path.resolve(expanded);
}

export function resolveHighlightsDirectory(dataDirectory, { environment = process.env, homeDirectory = homedir() } = {}) {
  const environmentDirectory = configuredPath(environment.HIGHLIGHTS_DIR, homeDirectory);
  if (environmentDirectory) return { directory: environmentDirectory, custom: true, source: "environment" };

  const configFile = path.join(dataDirectory, "highlights-path.txt");
  if (existsSync(configFile)) {
    try {
      const fileDirectory = configuredPath(readFileSync(configFile, "utf8"), homeDirectory);
      if (fileDirectory) return { directory: fileDirectory, custom: true, source: "file" };
    } catch {
      // 配置文件短暂不可读时回退到项目内的默认媒体目录。
    }
  }
  return { directory: path.join(dataDirectory, "highlights"), custom: false, source: "default" };
}

const excludedDirectories = new Set(["system volume information", "$recycle.bin"]);
export function isSafeHighlightPath(value) {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\\\x00-\x1f]/.test(value)) return false;
  const parts = value.split("/");
  return parts.length <= 32 && parts.every(part => part && !part.startsWith(".") && !excludedDirectories.has(part.toLowerCase()));
}

export function resolveHighlightFile(directory, filename) {
  if (!isSafeHighlightPath(filename)) throw new Error("媒体路径无效");
  const realDirectory = realpathSync(directory);
  let file = realDirectory;
  let stats;
  const parts = filename.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    file = path.join(file, parts[index]);
    stats = lstatSync(file);
    if (stats.isSymbolicLink() || (index < parts.length - 1 && !stats.isDirectory())) throw new Error("媒体路径不允许符号链接");
  }
  if (!stats?.isFile() || !realpathSync(file).startsWith(`${realDirectory}${path.sep}`)) throw new Error("媒体路径越界");
  return { file, stats, realDirectory };
}

export function listHighlights(directory, limit = 500) {
  const items = [];
  function walk(relativeDirectory = "") {
  let entries;
  try {
    entries = readdirSync(path.join(directory, relativeDirectory), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const filename = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (!isSafeHighlightPath(filename) || entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { walk(filename); continue; }
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    const type = mediaExtensions.get(extension);
    if (!type) continue;
    try {
      const { stats } = resolveHighlightFile(directory, filename);
      const version = Math.trunc(stats.mtimeMs);
      items.push({
        filename,
        folder: relativeDirectory,
        title: highlightTitle(entry.name),
        type,
        url: `/media/highlights/${encodeURIComponent(filename)}?v=${version}`,
        posterUrl: type === "video"
          ? `/media/highlight-posters/${encodeURIComponent(filename)}?v=${version}`
          : `/media/highlight-thumbnails/${encodeURIComponent(filename)}?v=${version}`,
        size: stats.size,
        modifiedAt: stats.mtime.toISOString()
      });
    } catch {
      // 文件可能恰好在扫描时被移动；下一次刷新会重新读取。
    }
  }
  }
  walk();
  return items.sort((a, b) => a.size - b.size || b.modifiedAt.localeCompare(a.modifiedAt) || a.filename.localeCompare(b.filename, "zh-CN")).slice(0, limit);
}

export const supportedHighlightFormats = [...mediaExtensions.keys()];
export const supportedHighlightVideoFormats = [...mediaExtensions.entries()]
  .filter(([, type]) => type === "video")
  .map(([extension]) => extension);
export const supportedHighlightImageFormats = [...mediaExtensions.entries()]
  .filter(([, type]) => type === "image")
  .map(([extension]) => extension);
