import {
  exchangeAccessCodeForAuthTokens,
  exchangeNpssoForAccessCode,
  exchangeRefreshTokenForAuthTokens,
  getUserPlayedGames,
  getUserTrophyProfileSummary,
  getUserTitles
} from "psn-api";

const defaultApi = {
  exchangeAccessCodeForAuthTokens,
  exchangeNpssoForAccessCode,
  exchangeRefreshTokenForAuthTokens,
  getUserPlayedGames,
  getUserTrophyProfileSummary,
  getUserTitles
};

function achievementTitleKey(value) {
  return String(value || "")
    .replace(/[™®©]/g, "")
    .replace(/[《》]/g, " ")
    .replace(/\b(?:trophies|trophy set|ps[345]|playstation\s*[345])\b/gi, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function trophyCount(value) {
  return ["bronze", "silver", "gold", "platinum"].reduce((sum, grade) => sum + Number(value?.[grade] || 0), 0);
}

function trophyPlatform(value) {
  const platforms = Array.isArray(value) ? value : String(value || "").split(",");
  if (platforms.some((item) => /PS5/i.test(item))) return "ps5";
  if (platforms.some((item) => /PS4/i.test(item))) return "ps4";
  return "";
}

export function normalizePlaystationAchievements(trophyTitles) {
  return (trophyTitles || []).map((title) => ({
    key: achievementTitleKey(title.trophyTitleName),
    platform: trophyPlatform(title.trophyTitlePlatform),
    earned: trophyCount(title.earnedTrophies),
    total: trophyCount(title.definedTrophies)
  })).filter((item) => item.key && item.total > 0);
}

export function normalizePlaystationSummary(profile) {
  const earned = trophyCount(profile?.earnedTrophies);
  const completedGames = Math.max(0, Number(profile?.earnedTrophies?.platinum || 0));
  return { achievementsEarned: earned, completedGames };
}

export function parseIsoDurationToMinutes(value) {
  if (!value || typeof value !== "string") return 0;
  const match = value.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (!match) return 0;
  const [, days = 0, hours = 0, minutes = 0, seconds = 0] = match;
  return Math.round(Number(days) * 1440 + Number(hours) * 60 + Number(minutes) + Number(seconds) / 60);
}

function playstationCover(title) {
  const images = title?.concept?.media?.images || [];
  const preferred = images.find((image) => /BACKGROUND|BANNER|HERO|SCREENSHOT/i.test(image?.type || ""))
    || images.find((image) => /COVER|PORTRAIT|BOX/i.test(image?.type || ""))
    || images[0];
  return preferred?.url || title.localizedImageUrl || title.imageUrl || null;
}

function playstationStore(title) {
  const conceptId = title?.concept?.id;
  if (conceptId) return `https://store.playstation.com/concept/${conceptId}`;
  return `https://store.playstation.com/search/${encodeURIComponent(title.localizedName || title.name)}`;
}

export function normalizePlaystationTitles(titles) {
  return titles
    .filter((title) => title?.titleId && (title?.localizedName || title?.name))
    .map((title) => ({
      platform: "playstation",
      externalId: String(title.titleId),
      title: String(title.localizedName || title.name).trim(),
      coverUrl: playstationCover(title),
      storeUrl: playstationStore(title),
      minutes: parseIsoDurationToMinutes(title.playDuration),
      lastPlayed: title.lastPlayedDateTime ? String(title.lastPlayedDateTime).slice(0, 10) : null,
      notes: [title.category, title.playCount ? `启动 ${title.playCount} 次` : ""].filter(Boolean).join(" · ")
    }));
}

export function createPlaystationConnector(api = defaultApi) {
  async function fetchSnapshot(accessToken) {
      const authorization = { accessToken };
      const titles = [];
      let offset = 0;
      const limit = 100;
      for (let page = 0; page < 100; page += 1) {
        const response = await api.getUserPlayedGames(authorization, "me", { limit, offset });
        if (response?.error) throw new Error(response.error?.message || response.error?.code || "PlayStation 游戏历史读取失败");
        titles.push(...(response.titles || []));
        if (!response.titles?.length || titles.length >= Number(response.totalItemCount || 0)) break;
        const next = Number(response.nextOffset);
        if (!Number.isFinite(next) || next <= offset) break;
        offset = next;
      }
      const games = normalizePlaystationTitles(titles);
      if (typeof api.getUserTitles !== "function") return { games, achievementSummary: null };
      const trophyTitles = [];
      let trophyOffset = 0;
      const trophyLimit = 200;
      for (let page = 0; page < 100; page += 1) {
        const response = await api.getUserTitles(authorization, "me", { limit: trophyLimit, offset: trophyOffset });
        if (response?.error) throw new Error(response.error?.message || response.error?.code || "PlayStation 奖杯列表读取失败");
        trophyTitles.push(...(response.trophyTitles || []));
        if (!response.trophyTitles?.length || trophyTitles.length >= Number(response.totalItemCount || 0)) break;
        trophyOffset += response.trophyTitles.length;
      }
      const achievements = normalizePlaystationAchievements(trophyTitles);
      const mergedGames = games.map((game) => {
        const key = achievementTitleKey(game.title);
        const platform = /ps5/i.test(game.notes) ? "ps5" : /ps4/i.test(game.notes) ? "ps4" : "";
        const candidates = achievements.filter((item) => item.key === key);
        const match = candidates.find((item) => item.platform === platform) || candidates[0];
        return match ? { ...game, achievementsEarned: match.earned, achievementsTotal: match.total } : game;
      });
      let achievementSummary = {
        achievementsEarned: achievements.reduce((sum, item) => sum + item.earned, 0),
        completedGames: achievements.filter((item) => item.earned >= item.total).length
      };
      if (typeof api.getUserTrophyProfileSummary === "function") {
        const profile = await api.getUserTrophyProfileSummary(authorization, "me");
        if (profile?.error) throw new Error(profile.error?.message || profile.error?.code || "PlayStation 奖杯汇总读取失败");
        achievementSummary = normalizePlaystationSummary(profile);
      }
      return { games: mergedGames, achievementSummary };
  }

  return {
    async connect(npsso) {
      const accessCode = await api.exchangeNpssoForAccessCode(npsso);
      return api.exchangeAccessCodeForAuthTokens(accessCode);
    },

    async refresh(refreshToken) {
      return api.exchangeRefreshTokenForAuthTokens(refreshToken);
    },

    fetchSnapshot,

    async fetchGames(accessToken) {
      return (await fetchSnapshot(accessToken)).games;
    }
  };
}
