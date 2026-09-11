const highlightTypes = new Set(["video", "image"]);

export function normalizeHighlightType(value) {
  return highlightTypes.has(value) ? value : "video";
}

export function highlightCounts(items = []) {
  return items.reduce((counts, item) => {
    if (highlightTypes.has(item?.type)) counts[item.type] += 1;
    return counts;
  }, { video: 0, image: 0 });
}

export function shuffleHighlights(items = [], random = Math.random) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return shuffled;
}

export function arrangeHighlightsForPlayback(items = [], random = Math.random) {
  return shuffleHighlights(items, random);
}

export function canUseDirectLocalPlayback(item) {
  return item?.type === "video"
    && item.remoteAvailable !== true
    && item.storageSource !== "baidu"
    && typeof item.url === "string"
    && item.url.startsWith("/media/highlights/");
}

export function highlightCategories(items = [], type = "video") {
  const counts = new Map();
  for (const item of items) if (item.type === type) {
    const label = item.gameCategory || "未分类";
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts].sort((a, b) => (a[0] === "未分类") - (b[0] === "未分类") || b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"));
}

export function filteredHighlightEntries(items = [], type = "video", { category = "", query = "", sort = "random" } = {}) {
  const activeType = normalizeHighlightType(type);
  const needle = query.normalize("NFKC").trim().toLocaleLowerCase();
  const entries = items
    .map((item, sourceIndex) => ({ item, sourceIndex }))
    .filter(({ item }) => item?.type === activeType
      && (!category || (item.gameCategory || "未分类") === category)
      && (!needle || `${item.filename} ${item.title || ""} ${item.gameCategory || "未分类"}`.normalize("NFKC").toLocaleLowerCase().includes(needle)));
  if (sort === "newest") entries.sort((a, b) => String(b.item.modifiedAt || "").localeCompare(String(a.item.modifiedAt || "")));
  if (sort === "name") entries.sort((a, b) => a.item.filename.localeCompare(b.item.filename, "zh-CN"));
  if (sort === "smallest") entries.sort((a, b) => Number(a.item.size || 0) - Number(b.item.size || 0));
  return entries;
}
