import { readdirSync, statSync } from "node:fs";
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

export function listHighlights(directory, limit = 500) {
  const items = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
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
  return items.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.filename.localeCompare(b.filename, "zh-CN")).slice(0, limit);
}

export const supportedHighlightFormats = [...mediaExtensions.keys()];
