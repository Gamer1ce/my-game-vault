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

export function filteredHighlightEntries(items = [], type = "video") {
  const activeType = normalizeHighlightType(type);
  return items
    .map((item, sourceIndex) => ({ item, sourceIndex }))
    .filter(({ item }) => item?.type === activeType);
}
