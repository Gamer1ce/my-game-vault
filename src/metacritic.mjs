const API_BASE = "https://api.rawg.io/api";
const METACRITIC_BASE = "https://backend.metacritic.com/games/metacritic";

const platformIds = {
  steam: "4",
  playstation: "187,18,16,15,27",
  xbox: "186,1,14,80",
  nintendo: "7"
};

export function normalizeScoreTitle(value) {
  return String(value || "")
    .replace(/[™®©]/g, "")
    .normalize("NFKD")
    .replace(/[（(](?:ps[345]|playstation\s*[345]|xbox[^)）]*|switch|windows|steam)[^)）]*[)）]/gi, " ")
    .replace(/\b(game of the year|goty|definitive|deluxe|ultimate|complete|remastered|remake|anniversary|gold|standard|digital)\s+edition\b/gi, " ")
    .replace(/\b(?:ps[345]|playstation\s*[345]|xbox\s*(?:one|series\s*[xs|]+)?|nintendo\s*switch)\b$/gi, " ")
    .replace(/\b(?:trophies|trophy\s+set|achievement\s+set)\b$/gi, " ")
    .replace(/\b(iii|ii|iv|vi|v)\b/gi, (roman) => ({ ii: "2", iii: "3", iv: "4", v: "5", vi: "6" })[roman.toLowerCase()])
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function chooseMatch(results, title) {
  const wanted = normalizeScoreTitle(title);
  const exact = results.find((item) => [item?.name, item?.name_original, ...(item?.alternative_names || [])]
    .some((name) => normalizeScoreTitle(name) === wanted));
  if (exact) return exact;
  const wantedTokens = new Set(wanted.split(" ").filter(Boolean));
  let best = null;
  let bestScore = 0;
  for (const item of results) {
    const candidate = normalizeScoreTitle(item?.name);
    const candidateTokens = new Set(candidate.split(" ").filter(Boolean));
    const intersection = [...wantedTokens].filter((token) => candidateTokens.has(token)).length;
    const union = new Set([...wantedTokens, ...candidateTokens]).size;
    const score = union ? intersection / union : 0;
    if (score > bestScore) { best = item; bestScore = score; }
  }
  return bestScore >= 0.72 ? best : null;
}

function validScore(value) {
  const score = Number(value);
  return value !== null && value !== undefined && Number.isInteger(score) && score >= 0 && score <= 100 ? score : null;
}

function metacriticSlug(value) {
  return normalizeScoreTitle(value).replace(/\s+/g, "-");
}

async function metacriticPageScore(fetchFn, game, rawgMatch) {
  const slugs = [...new Set([
    metacriticSlug(game.title),
    rawgMatch?.slug,
    metacriticSlug(rawgMatch?.name)
  ].filter(Boolean))];
  for (const slug of slugs) {
    const url = new URL(`${METACRITIC_BASE}/${encodeURIComponent(slug)}/web`);
    url.searchParams.set("componentName", "product");
    url.searchParams.set("componentDisplayName", "Product");
    url.searchParams.set("componentType", "Product");
    const response = await fetchFn(url, {
      headers: { Accept: "application/json", "User-Agent": "GamePlaytimeTracker/1.0" }
    });
    if (response.status === 404) continue;
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Metacritic 页面请求失败（${response.status}）`);
    const item = payload?.data?.item;
    if (!item) continue;
    const referenceTitle = rawgMatch?.name || game.title;
    if (!chooseMatch([{ ...item, name: item.title }], referenceTitle)) continue;
    const score = validScore(item?.criticScoreSummary?.score);
    if (score !== null) {
      return { score, scoreUrl: `https://www.metacritic.com/game/${encodeURIComponent(item.slug || slug)}/` };
    }
  }
  return null;
}

function platformScore(details, platform) {
  const wantedIds = new Set(String(platformIds[platform] || "").split(",").map(Number));
  const ratings = Array.isArray(details?.metacritic_platforms) ? details.metacritic_platforms : [];
  const rating = ratings.find((item) => wantedIds.has(Number(item?.platform?.platform ?? item?.platform?.id)));
  return validScore(rating?.metascore);
}

async function rawgRequest(fetchFn, apiKey, pathname, params = {}) {
  const url = new URL(`${API_BASE}${pathname}`);
  url.searchParams.set("key", apiKey);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  const response = await fetchFn(url, { headers: { Accept: "application/json" } });
  const payload = await response.json().catch(() => null);
  if (response.status === 401 || response.status === 403) throw new Error("RAWG API Key 无效或无权访问");
  if (!response.ok) throw new Error(payload?.detail || `RAWG 请求失败（${response.status}）`);
  return payload;
}

export function createMetacriticConnector({ fetchFn = fetch } = {}) {
  return {
    async connect(apiKey) {
      await rawgRequest(fetchFn, apiKey, "/games", { page_size: 1 });
      return { connected: true };
    },

    async fetchScore(apiKey, game) {
      const searches = [
        { search: game.title, search_precise: true, page_size: 15, platforms: platformIds[game.platform] },
        { search: normalizeScoreTitle(game.title), search_precise: true, page_size: 15 },
        { search: normalizeScoreTitle(game.title), page_size: 15 }
      ];
      let match = null;
      for (const params of searches) {
        const payload = await rawgRequest(fetchFn, apiKey, "/games", params);
        match = chooseMatch(Array.isArray(payload?.results) ? payload.results : [], game.title);
        if (match) break;
      }
      let score = validScore(match?.metacritic);
      if (match && score === null && (match.id || match.slug)) {
        const details = await rawgRequest(fetchFn, apiKey, `/games/${encodeURIComponent(match.id || match.slug)}`);
        score = platformScore(details, game.platform) ?? validScore(details?.metacritic);
      }
      if (score === null) {
        const fallback = await metacriticPageScore(fetchFn, game, match);
        if (fallback) return fallback;
      }
      return {
        score,
        scoreUrl: match?.slug ? `https://rawg.io/games/${encodeURIComponent(match.slug)}` : null
      };
    }
  };
}
