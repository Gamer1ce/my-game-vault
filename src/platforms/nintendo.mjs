import { createHash, randomBytes } from "node:crypto";
import { addUserAgent } from "nxapi";
import MoonApi from "nxapi/moon";

addUserAgent("game-time-vault/0.1.0 (personal local app)");

export const NINTENDO_CLIENT_ID = "54789befb391a838";
export const NINTENDO_REDIRECT_URI = `npf${NINTENDO_CLIENT_ID}://auth`;
export const NINTENDO_PLAY_ACTIVITY_CLIENT_ID = "5c38e31cd085304b";
export const NINTENDO_PLAY_ACTIVITY_REDIRECT_URI = `npf${NINTENDO_PLAY_ACTIVITY_CLIENT_ID}://auth`;
// Nintendo Moon 会拒绝旧版客户端。Android 2.4.0 的官方内部版本为 660。
export const NINTENDO_APP_VERSION = "2.4.0";
export const NINTENDO_APP_BUILD = "660";
const NINTENDO_SCOPE = [
  "openid",
  "user",
  "user.mii",
  "moonUser:administration",
  "moonDevice:create",
  "moonOwnedDevice:administration",
  "moonParentalControlSetting",
  "moonParentalControlSetting:update",
  "moonParentalControlSettingState",
  "moonPairingState",
  "moonSmartDevice:administration",
  "moonDailySummary",
  "moonMonthlySummary"
].join(" ");
const NINTENDO_PLAY_ACTIVITY_SCOPE = "openid user user.mii user.email user.links[].id";
// Nintendo Store 3.x 当前游戏记录接口。
const NINTENDO_PLAY_ACTIVITY_USER_AGENT = "com.nintendo.znej/3.2.0 (iOS/26.0.1)";
const NINTENDO_PLAY_ACTIVITY_URL = "https://app-api.znej.nintendo.com/api/v2.0/users/me/play_histories";

function secondsToMinutes(value) {
  return Math.max(0, Math.round(Number(value || 0) / 60));
}

function updateMetadata(target, title, deviceLabel) {
  if (title?.title) target.title = String(title.title).trim();
  const imageUri = title?.imageUri;
  const coverUrl = typeof imageUri === "string"
    ? imageUri
    : imageUri?.extraLarge || imageUri?.large || imageUri?.medium || imageUri?.small || imageUri?.extraSmall;
  if (coverUrl) target.coverUrl = String(coverUrl);
  if (title?.shopUri) target.storeUrl = String(title.shopUri);
  if (deviceLabel) target.devices.add(deviceLabel);
}

export function aggregateNintendoGames(deviceReports) {
  const games = new Map();
  const getGame = (applicationId) => {
    const key = String(applicationId || "").trim();
    if (!key) return null;
    if (!games.has(key)) games.set(key, { applicationId: key, title: `Nintendo 游戏 ${key}`, coverUrl: null, storeUrl: null, seconds: 0, lastPlayed: null, devices: new Set() });
    return games.get(key);
  };

  for (const report of deviceReports) {
    const monthlyMonths = new Set();
    for (const monthly of report.monthly || []) {
      if (!monthly?.month) continue;
      monthlyMonths.add(String(monthly.month).slice(0, 7));
      const titles = new Map((monthly.playedApps || []).map((title) => [String(title.applicationId), title]));
      for (const ranking of monthly.insights?.rankings?.byTime || []) {
        const game = getGame(ranking.applicationId);
        if (!game) continue;
        game.seconds += Math.max(0, Number(ranking.units || 0));
        updateMetadata(game, titles.get(game.applicationId), report.label);
      }
    }

    for (const daily of report.daily || []) {
      const date = String(daily?.date || "").slice(0, 10);
      if (monthlyMonths.has(date.slice(0, 7))) continue;
      const titles = new Map((daily.playedApps || []).map((title) => [String(title.applicationId), title]));
      const players = [...(daily.devicePlayers || []), ...(daily.anonymousPlayer ? [daily.anonymousPlayer] : [])];
      let hadPerTitleTime = false;
      for (const player of players) {
        for (const played of player.playedApps || []) {
          const game = getGame(played.applicationId);
          if (!game) continue;
          hadPerTitleTime = true;
          game.seconds += Math.max(0, Number(played.playingTime || 0));
          if (date && (!game.lastPlayed || date > game.lastPlayed)) game.lastPlayed = date;
          updateMetadata(game, titles.get(game.applicationId), report.label);
        }
      }

      // 少数日报不会返回玩家维度；只有单款游戏时才可安全归属整日时长。
      if (!hadPerTitleTime && titles.size === 1) {
        const [applicationId, title] = titles.entries().next().value;
        const game = getGame(applicationId);
        game.seconds += Math.max(0, Number(daily.playingTime || 0));
        if (date && (!game.lastPlayed || date > game.lastPlayed)) game.lastPlayed = date;
        updateMetadata(game, title, report.label);
      }
    }
  }

  return [...games.values()].map((game) => ({
    platform: "nintendo",
    externalId: game.applicationId,
    title: game.title,
    coverUrl: game.coverUrl,
    storeUrl: game.storeUrl || `https://www.nintendo.com/us/search/#q=${encodeURIComponent(game.title)}`,
    minutes: secondsToMinutes(game.seconds),
    lastPlayed: game.lastPlayed,
    notes: `Nintendo 家长监护${game.devices.size ? ` · ${[...game.devices].join(", ")}` : ""}`
  }));
}

export function normalizeNintendoPlayActivity(payload) {
  const games = (payload?.playHistories || []).map((game) => ({
    platform: "nintendo",
    externalId: String(game.titleId || "").trim(),
    title: String(game.titleName || "").trim(),
    coverUrl: game.imageUrl ? String(game.imageUrl) : null,
    storeUrl: `https://www.nintendo.com/us/search/#q=${encodeURIComponent(game.titleName || "")}`,
    minutes: Math.max(0, Math.round(Number(game.totalPlayedMinutes || 0))),
    lastPlayed: game.lastPlayedAt ? String(game.lastPlayedAt).slice(0, 10) : null,
    historyRevision: [game.lastUpdatedAt, game.lastPlayedAt, game.totalPlayedDays, game.totalPlayedMinutes].map((value) => String(value ?? "")).join("|"),
    totalPlayedDays: Math.max(0, Math.round(Number(game.totalPlayedDays || 0))),
    notes: `Nintendo 游戏记录${game.totalPlayedDays ? ` · 游玩 ${Number(game.totalPlayedDays)} 天` : ""}`
  })).filter((game) => game.externalId && game.title);
  const metadata = new Map(games.map((game) => [game.externalId, game]));
  const activity = [];
  for (const day of payload?.recentPlayHistories || []) {
    const date = String(day?.playedDate || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    for (const item of day?.dailyPlayHistories || []) {
      const externalId = String(item.titleId || "").trim();
      const minutes = Math.max(0, Math.round(Number(item.totalPlayedMinutes || 0)));
      if (!externalId || minutes <= 0) continue;
      const game = metadata.get(externalId);
      activity.push({
        date,
        externalId,
        title: String(item.titleName || game?.title || externalId).trim(),
        minutes,
        coverUrl: item.imageUrl || game?.coverUrl || null,
        storeUrl: game?.storeUrl || null
      });
    }
  }
  return { games, activity };
}

export function normalizeNintendoTitleActivity(payload, game) {
  if (!game?.externalId || !Array.isArray(payload?.playedDays)) return [];
  return payload.playedDays.map((day) => ({
    date: String(day?.playedDate || "").slice(0, 10),
    externalId: game.externalId,
    title: game.title,
    minutes: Math.max(0, Math.round(Number(day?.minutesPlayed || 0))),
    coverUrl: game.coverUrl || null,
    storeUrl: game.storeUrl || null
  })).filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.date) && item.minutes > 0);
}

async function exchangeSessionToken(fetchFn, code, verifier, clientId) {
  const response = await fetchFn("https://accounts.nintendo.com/connect/1.0.0/api/session_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Platform": "Android",
      "X-ProductVersion": "2.0.0",
      "User-Agent": "NASDKAPI; Android"
    },
    body: new URLSearchParams({
      client_id: clientId,
      session_token_code: code,
      session_token_code_verifier: verifier
    }).toString()
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.session_token) throw new Error(payload.error_description || payload.detail || `Nintendo 会话交换失败（${response.status}）`);
  return payload.session_token;
}

async function fetchPlayActivity(fetchFn, sessionToken, { historyState = new Map() } = {}) {
  const tokenResponse = await fetchFn("https://accounts.nintendo.com/connect/1.0.0/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Accept: "application/json",
      "User-Agent": NINTENDO_PLAY_ACTIVITY_USER_AGENT
    },
    body: JSON.stringify({
      client_id: NINTENDO_PLAY_ACTIVITY_CLIENT_ID,
      session_token: sessionToken,
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer-session-token"
    })
  });
  const token = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !token.access_token) throw new Error(token.error_description || `Nintendo 游戏记录令牌获取失败（${tokenResponse.status}）`);
  const historyResponse = await fetchFn(NINTENDO_PLAY_ACTIVITY_URL, {
    headers: {
      Authorization: `${token.token_type || "Bearer"} ${token.access_token}`,
      Accept: "application/json",
      "User-Agent": NINTENDO_PLAY_ACTIVITY_USER_AGENT,
      "gentry-locale": "en-US"
    }
  });
  const payload = await historyResponse.json().catch(() => ({}));
  if (!historyResponse.ok) {
    const apiCode = payload.code ? `/${payload.code}` : "";
    const detail = payload.detail || payload.error_description || payload.message;
    throw new Error(detail ? `Nintendo 游戏记录读取失败（${historyResponse.status}${apiCode}）：${detail}` : `Nintendo 游戏记录读取失败（${historyResponse.status}${apiCode}）`);
  }
  const normalized = normalizeNintendoPlayActivity(payload);
  const activity = new Map(normalized.activity.map((item) => [`${item.date}:${item.externalId}`, item]));
  const pending = normalized.games.filter((game) => game.totalPlayedDays > 0 && historyState.get(game.externalId) !== game.historyRevision);
  const historySync = [];
  const historyErrors = [];
  let cursor = 0;

  async function historyWorker() {
    while (cursor < pending.length) {
      const game = pending[cursor++];
      try {
        const pageLimit = 500;
        let offset = 0;
        let received = 0;
        for (let page = 0; page < 20; page += 1) {
          const url = new URL(`${NINTENDO_PLAY_ACTIVITY_URL}/game_titles/${encodeURIComponent(game.externalId)}`);
          url.searchParams.set("offset", String(offset));
          url.searchParams.set("limit", String(pageLimit));
          const response = await fetchFn(url, {
            headers: {
              Authorization: `${token.token_type || "Bearer"} ${token.access_token}`,
              Accept: "application/json",
              "User-Agent": NINTENDO_PLAY_ACTIVITY_USER_AGENT,
              "gentry-locale": "en-US"
            }
          });
          const detail = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(detail.detail || detail.message || `HTTP ${response.status}`);
          const rows = normalizeNintendoTitleActivity(detail, game);
          for (const item of rows) activity.set(`${item.date}:${item.externalId}`, item);
          const returned = Array.isArray(detail.playedDays) ? detail.playedDays.length : 0;
          received += returned;
          if (!returned || returned < pageLimit || received >= game.totalPlayedDays) break;
          const baseOffset = Number.isFinite(Number(detail.playedDaysOffset)) ? Number(detail.playedDaysOffset) : offset;
          const nextOffset = baseOffset + returned;
          if (nextOffset <= offset) break;
          offset = nextOffset;
        }
        historySync.push({ titleId: game.externalId, revision: game.historyRevision, totalPlayedDays: game.totalPlayedDays });
      } catch (error) {
        historyErrors.push({ titleId: game.externalId, message: error.message || "读取失败" });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(3, pending.length) }, () => historyWorker()));
  return {
    games: normalized.games,
    activity: [...activity.values()],
    historySync,
    historyErrors,
    historyBackfilled: historySync.length,
    nickname: null,
    deviceCount: 0,
    skippedSections: historyErrors.length,
    mode: "play-activity"
  };
}

export function createNintendoConnector({ fetchFn = fetch, moonApi = MoonApi } = {}) {
  return {
    authorizationStart(mode = "parental") {
      const playActivity = mode === "play-activity";
      const clientId = playActivity ? NINTENDO_PLAY_ACTIVITY_CLIENT_ID : NINTENDO_CLIENT_ID;
      const redirectUri = playActivity ? NINTENDO_PLAY_ACTIVITY_REDIRECT_URI : NINTENDO_REDIRECT_URI;
      const state = randomBytes(36).toString("base64url");
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const params = new URLSearchParams({
        state,
        redirect_uri: redirectUri,
        client_id: clientId,
        scope: playActivity ? NINTENDO_PLAY_ACTIVITY_SCOPE : NINTENDO_SCOPE,
        response_type: "session_token_code",
        session_token_code_challenge: challenge,
        session_token_code_challenge_method: "S256"
      });
      return { state, verifier, clientId, mode: playActivity ? "play-activity" : "parental", authorizationUrl: `https://accounts.nintendo.com/connect/1.0.0/authorize?${params}` };
    },

    async complete(callbackUrl, pending) {
      let url;
      try { url = new URL(String(callbackUrl || "").trim()); } catch { throw new Error("Nintendo 回跳链接格式无效"); }
      const clientId = pending.clientId || NINTENDO_CLIENT_ID;
      if (url.protocol !== `npf${clientId}:`) throw new Error("这不是当前 Nintendo 连接方式生成的授权链接");
      const params = new URLSearchParams(url.hash.slice(1));
      if (params.get("state") !== pending.state) throw new Error("Nintendo 授权状态不匹配，请重新开始连接");
      const code = params.get("session_token_code");
      if (!code) throw new Error("回跳链接中没有 session_token_code");
      return exchangeSessionToken(fetchFn, code, pending.verifier, clientId);
    },

    async fetchGames(sessionToken, mode = "parental", options = {}) {
      if (mode === "play-activity") return fetchPlayActivity(fetchFn, sessionToken, options);
      const { moon, data } = await moonApi.createWithSessionToken(sessionToken);
      moon.znma_version = NINTENDO_APP_VERSION;
      moon.znma_build = NINTENDO_APP_BUILD;
      moon.znma_useragent = `moon_ANDROID/${NINTENDO_APP_VERSION} (com.nintendo.znma; build:${NINTENDO_APP_BUILD}; ANDROID 26)`;
      const devices = await moon.getDevices();
      if (!devices?.items?.length) throw new Error("Nintendo 账号尚未在家长监护 App 中绑定主机");
      const reports = [];
      const failures = [];
      for (const device of devices.items) {
        let daily = { items: [] };
        let monthlyIndex = { indexes: [], items: [] };
        try { daily = await moon.getDailySummaries(device.deviceId); }
        catch (error) { failures.push({ deviceId: device.deviceId, section: "daily", error }); }
        try { monthlyIndex = await moon.getMonthlySummaries(device.deviceId); }
        catch (error) { failures.push({ deviceId: device.deviceId, section: "monthly", error }); }
        const months = [...new Set([...(monthlyIndex?.indexes || []), ...(monthlyIndex?.items || []).map((item) => item.month)].filter(Boolean))];
        const monthly = [];
        for (const month of months) {
          try { monthly.push(await moon.getMonthlySummary(device.deviceId, month)); }
          catch (error) { failures.push({ deviceId: device.deviceId, section: month, error }); }
        }
        reports.push({ label: device.label || device.deviceId, daily: daily?.items || [], monthly });
      }
      const games = aggregateNintendoGames(reports);
      if (!games.length && failures.length >= devices.items.length * 2) {
        throw new Error("Nintendo 的所有主机记录暂时都无法读取，请先在官方家长监护 App 中确认游玩记录可见");
      }
      return { games, nickname: data?.user?.nickname || null, deviceCount: devices.items.length, skippedSections: failures.length };
    }
  };
}
