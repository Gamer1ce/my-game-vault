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

const PLAYBACK_SIZE_BANDS = [32, 96, 256].map((megabytes) => megabytes * 1024 * 1024);

function playbackSizeBand(item) {
  const size = Number(item?.size);
  if (!Number.isFinite(size) || size <= 0) return PLAYBACK_SIZE_BANDS.length;
  const band = PLAYBACK_SIZE_BANDS.findIndex((limit) => size <= limit);
  return band === -1 ? PLAYBACK_SIZE_BANDS.length : band;
}

export function arrangeHighlightsForPlayback(items = [], random = Math.random) {
  const videoBands = Array.from({ length: PLAYBACK_SIZE_BANDS.length + 1 }, () => []);
  const images = [];
  const unknown = [];
  for (const item of items) {
    if (item?.type === "video") videoBands[playbackSizeBand(item)].push(item);
    else if (item?.type === "image") images.push(item);
    else unknown.push(item);
  }
  return [
    ...videoBands.flatMap((band) => shuffleHighlights(band, random)),
    ...shuffleHighlights(images, random),
    ...shuffleHighlights(unknown, random)
  ];
}

export function canUseDirectLocalPlayback(item) {
  return item?.type === "video"
    && item.remoteAvailable !== true
    && item.storageSource !== "baidu"
    && typeof item.url === "string"
    && item.url.startsWith("/media/highlights/");
}

export function filteredHighlightEntries(items = [], type = "video") {
  const activeType = normalizeHighlightType(type);
  return items
    .map((item, sourceIndex) => ({ item, sourceIndex }))
    .filter(({ item }) => item?.type === activeType);
}
