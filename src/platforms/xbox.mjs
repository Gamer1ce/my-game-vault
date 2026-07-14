const API_BASE = "https://api.xbl.io/v2";

function xboxHeaders(apiKey) {
  return { "x-authorization": apiKey, Accept: "application/json", "Accept-Language": "en-US", "Content-Type": "application/json" };
}

function decodeOpenXblPayload(payload) {
  let decoded = payload;
  for (let index = 0; index < 2 && typeof decoded === "string"; index += 1) {
    try { decoded = JSON.parse(decoded); } catch { break; }
  }
  if (decoded && typeof decoded === "object" && !Array.isArray(decoded) && "code" in decoded && "content" in decoded) {
    const code = Number(decoded.code);
    let content = decoded.content;
    for (let index = 0; index < 2 && typeof content === "string"; index += 1) {
      try { content = JSON.parse(content); } catch { break; }
    }
    if (code < 200 || code >= 300) {
      const message = Array.isArray(content) ? content.join("；") : content?.message || content?.error || String(content || "");
      throw new Error(message || `OpenXBL 上游请求失败（${code}）`);
    }
    return content;
  }
  return decoded;
}

async function openXblRequest(fetchFn, apiKey, pathname, options = {}) {
  const response = await fetchFn(`${API_BASE}${pathname}`, {
    ...options,
    headers: { ...xboxHeaders(apiKey), ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.message || payload?.error_description || payload?.error;
    if (response.status === 401 || response.status === 403) throw new Error("OpenXBL API Key 无效、已过期，或账号尚未完成 Xbox 关联");
    if (response.status === 429) throw new Error("OpenXBL 免费额度暂时用完，请稍后再同步");
    throw new Error(detail || `OpenXBL 请求失败（${response.status}）`);
  }
  try {
    return decodeOpenXblPayload(payload);
  } catch (error) {
    if (/Accept-Language/.test(error.message)) throw new Error("OpenXBL 请求语言设置无效，请更新程序后重试");
    throw error;
  }
}

function findSetting(payload, id) {
  const wanted = id.toLowerCase();
  const queue = [payload];
  while (queue.length) {
    const item = queue.shift();
    if (!item || typeof item !== "object") continue;
    if (String(item.id || item.name || "").toLowerCase() === wanted && item.value != null) return item.value;
    queue.push(...(Array.isArray(item) ? item : Object.values(item)));
  }
  return null;
}

function findFirst(payload, keys) {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  const queue = [payload];
  while (queue.length) {
    const item = queue.shift();
    if (!item || typeof item !== "object") continue;
    for (const [key, value] of Object.entries(item)) {
      if (wanted.has(key.toLowerCase()) && value != null && typeof value !== "object") return value;
    }
    queue.push(...(Array.isArray(item) ? item : Object.values(item)));
  }
  return null;
}

function titleList(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ["titles", "titleHistory", "userTitles", "items"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

function titleIdOf(item) {
  return String(item?.titleId ?? item?.titleID ?? item?.titleid ?? item?.id ?? "").trim();
}

function minutesIn(item) {
  const direct = item?.minutesPlayed ?? item?.MinutesPlayed ?? item?.playtimeMinutes ?? item?.playTimeMinutes;
  if (Number.isFinite(Number(direct))) return Math.max(0, Math.round(Number(direct)));
  const stat = findSetting(item?.stats ?? item, "MinutesPlayed");
  return Number.isFinite(Number(stat)) ? Math.max(0, Math.round(Number(stat))) : 0;
}

export function parseOpenXblAccount(payload) {
  const xuid = String(findFirst(payload, ["xuid", "id", "userId"]) || "").trim();
  const gamertag = String(findSetting(payload, "Gamertag") || findFirst(payload, ["gamertag", "displayName"]) || "").trim();
  if (!xuid) throw new Error("OpenXBL 账号响应中没有 XUID，请先在 OpenXBL 完成 Xbox 账号关联");
  return { xuid, gamertag: gamertag || null };
}

export function parseOpenXblStats(payload) {
  const result = new Map();
  const visit = (node, inheritedTitleId = null) => {
    if (!node || typeof node !== "object") return;
    const titleId = titleIdOf(node) || inheritedTitleId;
    const minutes = minutesIn(node);
    if (titleId && minutes > 0) result.set(titleId, Math.max(result.get(titleId) || 0, minutes));
    for (const value of Array.isArray(node) ? node : Object.values(node)) visit(value, titleId);
  };
  visit(payload);
  return result;
}

export function parseOpenXblAchievements(payload) {
  const result = new Map();
  for (const item of titleList(payload)) {
    const titleId = titleIdOf(item);
    const earned = Number(item?.achievement?.currentAchievements);
    const total = Number(item?.achievement?.totalAchievements);
    if (titleId && Number.isFinite(earned) && Number.isFinite(total) && (earned > 0 || total > 0)) {
      result.set(titleId, {
        earned: Math.max(0, Math.round(earned)),
        total: total > 0 ? Math.max(0, Math.round(total)) : null
      });
    }
  }
  return result;
}

export function normalizeOpenXblTitles(payload, statsByTitle = new Map(), achievementsByTitle = new Map()) {
  return titleList(payload)
    .filter((item) => titleIdOf(item) && (item?.name || item?.titleName || item?.title) && String(item?.type || "Game").toLowerCase() !== "app")
    .map((item) => {
      const titleId = titleIdOf(item);
      const lastPlayed = item?.titleHistory?.lastTimePlayed || item?.lastTimePlayed || item?.lastPlayed || null;
      const devices = item?.devices || item?.deviceTypes || [];
      const productId = String(item?.productId || item?.productID || item?.storeId || "").trim();
      const title = String(item.name || item.titleName || item.title).trim();
      const achievements = achievementsByTitle.get(titleId);
      return {
        platform: "xbox",
        externalId: titleId,
        title,
        coverUrl: item.displayImage || item.imageUrl || item.images?.[0]?.url || null,
        storeUrl: productId ? `https://apps.microsoft.com/detail/${encodeURIComponent(productId)}` : `https://www.xbox.com/search/results?q=${encodeURIComponent(title)}`,
        minutes: Math.max(minutesIn(item), Number(statsByTitle.get(titleId) || 0)),
        lastPlayed: lastPlayed ? String(lastPlayed).slice(0, 10) : null,
        notes: `OpenXBL${Array.isArray(devices) && devices.length ? ` · ${devices.join(", ")}` : ""}`,
        ...(achievements ? { achievementsEarned: achievements.earned, achievementsTotal: achievements.total } : {})
      };
    });
}

export function createXboxConnector({ fetchFn = fetch } = {}) {
  return {
    async connect(apiKey) {
      return parseOpenXblAccount(await openXblRequest(fetchFn, apiKey, "/account"));
    },

    async fetchGames(connection) {
      const history = await openXblRequest(fetchFn, connection.apiKey, "/player/titleHistory");
      const titles = titleList(history);
      let achievementsByTitle = new Map();
      try {
        achievementsByTitle = parseOpenXblAchievements(await openXblRequest(fetchFn, connection.apiKey, "/achievements"));
      } catch (error) {
        if (/API Key|额度/.test(error.message)) throw error;
      }
      const statsByTitle = new Map();
      for (let index = 0; index < titles.length; index += 25) {
        const ids = titles.slice(index, index + 25).map(titleIdOf).filter(Boolean);
        if (!ids.length) continue;
        try {
          const stats = await openXblRequest(fetchFn, connection.apiKey, "/player/stats", {
            method: "POST",
            body: JSON.stringify({
              xuids: [connection.xuid],
              groups: [],
              stats: ids.map((titleId) => ({ name: "MinutesPlayed", titleId }))
            })
          });
          for (const [titleId, minutes] of parseOpenXblStats(stats)) statsByTitle.set(titleId, minutes);
        } catch (error) {
          // 某些游戏或免费账户可能不开放统计接口；仍保留游戏历史中的数据。
          if (/API Key|额度/.test(error.message)) throw error;
        }
      }
      return normalizeOpenXblTitles(history, statsByTitle, achievementsByTitle);
    }
  };
}
