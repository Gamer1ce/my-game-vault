import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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

export function listHighlights(directory, limit = 500) {
  const items = [];
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return items;
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    const extension = path.extname(entry.name).toLowerCase();
    const type = mediaExtensions.get(extension);
    if (!type) continue;
    try {
      const stats = statSync(path.join(directory, entry.name));
      items.push({
        filename: entry.name,
        title: highlightTitle(entry.name),
        type,
        url: `/media/highlights/${encodeURIComponent(entry.name)}`,
        size: stats.size,
        modifiedAt: stats.mtime.toISOString()
      });
    } catch {
      // 文件可能恰好在扫描时被移动；下一次刷新会重新读取。
    }
  }
  return items.sort((a, b) => a.size - b.size || b.modifiedAt.localeCompare(a.modifiedAt) || a.filename.localeCompare(b.filename, "zh-CN")).slice(0, limit);
}

export const supportedHighlightFormats = [...mediaExtensions.keys()];
