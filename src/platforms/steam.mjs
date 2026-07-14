const API_BASE = "https://api.steampowered.com";

function steamHeaders(apiKey) {
  return { "x-webapi-key": apiKey, Accept: "application/json" };
}

async function steamRequest(fetchFn, apiKey, pathname, params = {}) {
  const url = new URL(`${API_BASE}${pathname}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetchFn(url, { headers: steamHeaders(apiKey) });
  const payload = await response.json().catch(() => null);
  if (response.status === 401 || response.status === 403) throw new Error("Steam Web API Key 无效，或无权读取该账号");
  if (!response.ok) throw new Error(payload?.response?.message || `Steam Web API 请求失败（${response.status}）`);
  return payload;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function identityFromInput(input) {
  const value = String(input || "").trim();
  if (/^7656119\d{10}$/.test(value)) return { steamId: value };
  try {
    const url = new URL(value);
    if (!/(^|\.)steamcommunity\.com$/i.test(url.hostname)) throw new Error();
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "profiles" && /^7656119\d{10}$/.test(parts[1] || "")) return { steamId: parts[1] };
    if (parts[0] === "id" && parts[1]) return { vanity: parts[1] };
  } catch {
    // 允许直接填写自定义个人主页名称。
  }
  if (/^[\w-]{2,64}$/.test(value)) return { vanity: value };
  throw new Error("请输入 SteamID64、Steam 自定义主页名称或完整个人主页链接");
}

export function normalizeSteamGames(payload) {
  return (payload?.response?.games || []).map((game) => {
    const lastPlayed = Number(game.rtime_last_played || 0);
    const platforms = [
      Number(game.playtime_windows_forever || 0) > 0 ? "Windows" : "",
      Number(game.playtime_mac_forever || 0) > 0 ? "macOS" : "",
      Number(game.playtime_linux_forever || 0) > 0 ? "Linux" : "",
      Number(game.playtime_deck_forever || 0) > 0 ? "Steam Deck" : ""
    ].filter(Boolean);
    return {
      platform: "steam",
      externalId: String(game.appid),
      title: String(game.name || `Steam App ${game.appid}`).trim(),
      coverUrl: `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${game.appid}/header.jpg`,
      storeUrl: `https://store.steampowered.com/app/${game.appid}/`,
      minutes: Math.max(0, Math.round(Number(game.playtime_forever || 0))),
      lastPlayed: lastPlayed ? new Date(lastPlayed * 1000).toISOString().slice(0, 10) : null,
      notes: `Steam${platforms.length ? ` · ${platforms.join(", ")}` : ""}`
    };
  });
}

export function createSteamConnector({ fetchFn = fetch } = {}) {
  async function resolveSteamId(apiKey, identity) {
    const parsed = identityFromInput(identity);
    if (parsed.steamId) return parsed.steamId;
    const payload = await steamRequest(fetchFn, apiKey, "/ISteamUser/ResolveVanityURL/v1/", { vanityurl: parsed.vanity });
    if (Number(payload?.response?.success) !== 1 || !payload?.response?.steamid) throw new Error("找不到该 Steam 自定义主页");
    return String(payload.response.steamid);
  }

  return {
    async connect(apiKey, identity) {
      const steamId = await resolveSteamId(apiKey, identity);
      const profile = await steamRequest(fetchFn, apiKey, "/ISteamUser/GetPlayerSummaries/v2/", { steamids: steamId });
      const player = profile?.response?.players?.[0];
      if (!player) throw new Error("Steam 账号不存在或个人资料不可访问");
      return { steamId, personaName: player.personaname || null };
    },

    async fetchGames(connection) {
      const payload = await steamRequest(fetchFn, connection.apiKey, "/IPlayerService/GetOwnedGames/v1/", {
        steamid: connection.steamId,
        include_appinfo: true,
        include_played_free_games: true,
        include_free_sub: true,
        skip_unvetted_apps: false
      });
      if (!Array.isArray(payload?.response?.games)) {
        throw new Error("Steam 未返回游戏列表，请把个人资料中的“游戏详情”设为公开");
      }
      const games = normalizeSteamGames(payload);
      const eligible = payload.response.games.filter((game) => game.has_community_visible_stats);
      const achievementRows = await mapWithConcurrency(eligible, 4, async (game) => {
        try {
          const result = await steamRequest(fetchFn, connection.apiKey, "/ISteamUserStats/GetPlayerAchievements/v1/", {
            appid: game.appid,
            steamid: connection.steamId,
            l: "schinese"
          });
          const achievements = result?.playerstats?.achievements;
          if (!Array.isArray(achievements) || !achievements.length) return null;
          return {
            externalId: String(game.appid),
            earned: achievements.filter((item) => Number(item.achieved) === 1).length,
            total: achievements.length
          };
        } catch (error) {
          if (/API Key|额度|无效|无权/.test(error.message)) throw error;
          return null;
        }
      });
      const achievementsById = new Map(achievementRows.filter(Boolean).map((item) => [item.externalId, item]));
      return games.map((game) => {
        const row = achievementsById.get(game.externalId);
        return row ? { ...game, achievementsEarned: row.earned, achievementsTotal: row.total } : game;
      });
    }
  };
}
