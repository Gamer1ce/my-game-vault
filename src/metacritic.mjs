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
    .replace(/(?<=\p{L})\.(?=\p{L}|$)/gu, "")
    .replace(/[’']/g, "")
    .replace(/[™®©]/g, "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/gu, " ")
    .replace(/[（(](?:ps[345]|playstation\s*[345]|xbox[^)）]*|switch|windows|steam)[^)）]*[)）]/gi, " ")
    .replace(/\b(?:the\s+)?(game of the year|goty|definitive|deluxe|ultimate|complete|remastered|remake|anniversary|gold|standard|digital)\s+edition\b/gi, " ")
    .replace(/\b(?:windows|pc|console)\s+edition\b$/gi, " ")
    .replace(/\bfor\s+(?:windows|pc)\b$/gi, " ")
    .replace(/\b(?:friends?\s+pass|playtest|open\s+beta|game\s+preview)\b$/gi, " ")
    .replace(/\b(?:ps[345]|playstation\s*[345]|xbox\s*(?:one|series\s*[xs|]+)?|nintendo\s*switch(?:\s*2)?)\b$/gi, " ")
    .replace(/\b(?:trophies|trophy\s+set|achievement\s+set)\b$/gi, " ")
    .replace(/\b(iii|ii|iv|vi|v)\b/gi, (roman) => ({ ii: "2", iii: "3", iv: "4", v: "5", vi: "6" })[roman.toLowerCase()])
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

const scoreTitleAliases = new Map([
  ["HUNDRED LINE -最終防衛学園-", "The Hundred Line: Last Defense Academy"],
  ["十三机兵防卫圈", "13 Sentinels: Aegis Rim"],
  ["ゼノブレイド２", "Xenoblade Chronicles 2"],
  ["AI: ソムニウムファイル ニルヴァーナ イニシアティブ", "AI: The Somnium Files - nirvanA Initiative"],
  ["ダンガンロンパ 希望の学園と絶望の高校生 Anniversary Edition", "Danganronpa: Trigger Happy Havoc"],
  ["スーパーダンガンロンパ２ さよなら絶望学園 Anniversary Edition", "Danganronpa 2: Goodbye Despair"],
  ["ニューダンガンロンパＶ３ みんなのコロシアイ新学期 Anniversary Edition", "Danganronpa V3: Killing Harmony"],
  ["ハッピーダンガンロンパS 超高校級の南国サイコロ合宿", "Danganronpa S: Ultimate Summer Camp"],
  ["女神異聞錄５ 亂戰：魅影攻手", "Persona 5 Strikers"],
  ["灵视异闻 FILE23 本所七大不可思议", "Paranormasight: The Seven Mysteries of Honjo"],
  ["圣兽之王", "Unicorn Overlord"],
  ["真・三國無双 ORIGINS", "Dynasty Warriors: Origins"],
  ["キャサリン・FB for Nintendo Switch", "Catherine: Full Body"]
].map(([source, target]) => [normalizeScoreTitle(source), target]));

function canonicalScoreTitle(value) {
  const title = String(value || "").trim();
  const alias = scoreTitleAliases.get(normalizeScoreTitle(title));
  if (alias) return alias;
  return title
    .replace(/\s*[-–—]\s*Nintendo Switch 2 Edition\s*$/i, "")
    .replace(/\s+for Nintendo Switch\s*$/i, "")
    .trim();
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

function literalMetacriticSlug(value) {
  return String(value || "")
    .replace(/[’'™®©.]/g, "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLocaleLowerCase("en-US");
}

function metacriticTitleVariants(value) {
  const title = String(value || "").trim();
  return [...new Set([
    title,
    title.replace(/\b(?:the\s+)?(?:game of the year|goty|complete|definitive|ultimate|deluxe)\b(?:\s+edition)?$/i, "").trim(),
    title.replace(/\s*[-–—:]\s*(?:windows|pc|console)\s+edition$/i, "").trim()
  ].filter(Boolean))];
}

function knownMetacriticSlugs(value, platform) {
  const title = normalizeScoreTitle(value);
  if (title === "pubg battlegrounds") return ["playerunknowns-battlegrounds"];
  if (title === "hitman world of assassination") return ["hitman-3"];
  if (title.startsWith("ea sports fifa 23")) return ["fifa-23"];
  if (title === "synapse" && platform === "playstation") return ["synapse-2023"];
  if (title === "the hundred line last defense academy") return ["the-hundred-line-last-defense-academy"];
  if (title === "the legend of zelda tears of the kingdom") return ["the-legend-of-zelda-tears-of-the-kingdom"];
  if (title === "xenoblade chronicles definitive edition") return ["xenoblade-chronicles-definitive-edition"];
  if (title === "pokemon legends z a") return ["pokemon-legends-z-a"];
  if (title === "13 sentinels aegis rim") return ["13-sentinels-aegis-rim"];
  if (title === "xenoblade chronicles 2") return ["xenoblade-chronicles-2"];
  if (title === "ai the somnium files nirvana initiative") return ["ai-the-somnium-files-nirvana-initiative"];
  if (title === "danganronpa trigger happy havoc") return ["dangan-ronpa"];
  if (title === "danganronpa 2 goodbye despair") return ["danganronpa-2-goodbye-despair"];
  if (title === "danganronpa v3 killing harmony") return ["danganronpa-v3-killing-harmony"];
  if (title === "danganronpa s ultimate summer camp") return ["danganronpa-s-ultimate-summer-camp"];
  if (title === "rune factory guardians of azuma") return ["rune-factory-guardians-of-azuma"];
  if (title === "warframe") return ["warframe"];
  if (title === "fortnite") return ["fortnite"];
  if (title === "persona 5 strikers") return ["persona-5-strikers"];
  if (title === "paranormasight the seven mysteries of honjo") return ["paranormasight-the-seven-mysteries-of-honjo"];
  if (title === "catherine full body") return ["catherine-full-body"];
  if (title === "unicorn overlord") return ["unicorn-overlord"];
  if (title === "dynasty warriors origins") return ["dynasty-warriors-origins"];
  return [];
}

async function steamStoreScore(fetchFn, game) {
  if (game.platform !== "steam" || !/^\d+$/.test(String(game.externalId || ""))) return null;
  const appId = String(game.externalId);
  const url = new URL("https://store.steampowered.com/api/appdetails");
  url.searchParams.set("appids", appId);
  url.searchParams.set("cc", "us");
  url.searchParams.set("l", "en");
  const response = await fetchFn(url, { headers: { Accept: "application/json" } });
  if (!response.ok) return null;
  const payload = await response.json().catch(() => null);
  const metacritic = payload?.[appId]?.data?.metacritic;
  const score = validScore(metacritic?.score);
  if (score === null) return null;
  let scoreUrl = null;
  try {
    const source = new URL(metacritic?.url);
    if (source.hostname === "metacritic.com" || source.hostname.endsWith(".metacritic.com")) {
      source.protocol = "https:";
      scoreUrl = source.href;
    }
  } catch {}
  return { score, scoreUrl };
}

async function metacriticPageScore(fetchFn, game, rawgMatch) {
  const knownSlugs = knownMetacriticSlugs(game.title, game.platform);
  const slugs = [...new Set([
    ...metacriticTitleVariants(game.title).flatMap((title) => [literalMetacriticSlug(title), metacriticSlug(title)]),
    ...knownSlugs,
    rawgMatch?.slug,
    metacriticSlug(rawgMatch?.name)
  ].filter(Boolean))];
  const visited = new Set();
  const canonical = new Set(knownSlugs);
  for (let index = 0; index < slugs.length; index += 1) {
    const slug = slugs[index];
    if (visited.has(slug)) continue;
    visited.add(slug);
    const url = new URL(`${METACRITIC_BASE}/${encodeURIComponent(slug)}/web`);
    url.searchParams.set("componentName", "product");
    url.searchParams.set("componentDisplayName", "Product");
    url.searchParams.set("componentType", "Product");
    const response = await fetchFn(url, {
      headers: { Accept: "application/json", "User-Agent": "GamePlaytimeTracker/1.0" }
    });
    const payload = await response.json().catch(() => null);
    if (response.status === 301) {
      const canonicalSlugs = payload?.errors?.flatMap((error) => error?.context?.availableOn || []).map((item) => item?.slug).filter(Boolean) || [];
      canonicalSlugs.forEach((candidate) => canonical.add(candidate));
      slugs.push(...canonicalSlugs);
      continue;
    }
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`Metacritic 页面请求失败（${response.status}）`);
    const item = payload?.data?.item;
    if (!item) continue;
    const referenceTitle = rawgMatch?.name || game.title;
    if (!canonical.has(slug) && !chooseMatch([{ ...item, name: item.title }], referenceTitle)) continue;
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
      const scoreTitle = canonicalScoreTitle(game.title);
      const scoreGame = scoreTitle === game.title ? game : { ...game, title: scoreTitle };
      const searches = [
        { search: scoreTitle, search_precise: true, page_size: 15, platforms: platformIds[game.platform] },
        { search: normalizeScoreTitle(scoreTitle), search_precise: true, page_size: 15 },
        { search: normalizeScoreTitle(scoreTitle), page_size: 15 }
      ];
      let match = null;
      for (const params of searches) {
        const payload = await rawgRequest(fetchFn, apiKey, "/games", params);
        match = chooseMatch(Array.isArray(payload?.results) ? payload.results : [], scoreTitle);
        if (match) break;
      }
      let score = validScore(match?.metacritic);
      if (match && score === null && (match.id || match.slug)) {
        const details = await rawgRequest(fetchFn, apiKey, `/games/${encodeURIComponent(match.id || match.slug)}`);
        score = platformScore(details, game.platform) ?? validScore(details?.metacritic);
      }
      if (score === null) {
        const steamFallback = await steamStoreScore(fetchFn, game);
        if (steamFallback) return steamFallback;
      }
      if (score === null) {
        const fallback = await metacriticPageScore(fetchFn, scoreGame, match);
        if (fallback) return fallback;
      }
      return {
        score,
        scoreUrl: match?.slug ? `https://rawg.io/games/${encodeURIComponent(match.slug)}` : null
      };
    }
  };
}
