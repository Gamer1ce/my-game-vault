import test from "node:test";
import assert from "node:assert/strict";
import { aggregateNintendoGames, createNintendoConnector, NINTENDO_CLIENT_ID, NINTENDO_PLAY_ACTIVITY_CLIENT_ID, normalizeNintendoPlayActivity, normalizeNintendoTitleActivity } from "../src/platforms/nintendo.mjs";

test("Nintendo 月报和日报聚合时避免重复月份", () => {
  const games = aggregateNintendoGames([{
    label: "客厅 Switch",
    monthly: [{
      month: "2026-06",
      playedApps: [{ applicationId: "0100", title: "Zelda", imageUri: { extraLarge: "https://example.com/zelda.jpg" } }],
      insights: { rankings: { byTime: [{ applicationId: "0100", units: 7200 }] } }
    }],
    daily: [
      { date: "2026-06-30", playedApps: [{ applicationId: "0100", title: "Zelda", imageUri: { extraLarge: "https://example.com/zelda.jpg" } }], devicePlayers: [{ playedApps: [{ applicationId: "0100", playingTime: 1800 }] }], anonymousPlayer: null },
      { date: "2026-07-01", playedApps: [{ applicationId: "0100", title: "Zelda", imageUri: { extraLarge: "https://example.com/zelda.jpg" } }], devicePlayers: [{ playedApps: [{ applicationId: "0100", playingTime: 3600 }] }], anonymousPlayer: null }
    ]
  }]);
  assert.deepEqual(games[0], {
    platform: "nintendo",
    externalId: "0100",
    title: "Zelda",
    coverUrl: "https://example.com/zelda.jpg",
    storeUrl: "https://www.nintendo.com/us/search/#q=Zelda",
    minutes: 180,
    lastPlayed: "2026-07-01",
    notes: "Nintendo 家长监护 · 客厅 Switch"
  });
});

test("Nintendo 授权回跳校验并交换会话令牌", async () => {
  let request;
  const connector = createNintendoConnector({
    fetchFn: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ session_token: "long-lived-token" }) };
    }
  });
  const start = connector.authorizationStart();
  const authorize = new URL(start.authorizationUrl);
  assert.equal(authorize.searchParams.get("client_id"), NINTENDO_CLIENT_ID);
  assert.equal(authorize.searchParams.get("state"), start.state);
  const callback = `npf${NINTENDO_CLIENT_ID}://auth#state=${start.state}&session_token_code=abc`;
  assert.equal(await connector.complete(callback, start), "long-lived-token");
  assert.match(request.options.body, /session_token_code=abc/);
});

test("Nintendo 游戏记录模式无需家长监护并返回累计与每日时长", async () => {
  const normalized = normalizeNintendoPlayActivity({
    playHistories: [{ titleId: "0100", titleName: "Zelda", imageUrl: "https://example.com/z.jpg", lastPlayedAt: "2026-07-14T10:00:00+09:00", totalPlayedDays: 12, totalPlayedMinutes: 2967 }],
    recentPlayHistories: [{ playedDate: "2026-07-14T00:00:00+09:00", dailyPlayHistories: [{ titleId: "0100", titleName: "Zelda", totalPlayedMinutes: 16 }] }]
  });
  assert.equal(normalized.games[0].minutes, 2967);
  assert.equal(normalized.games[0].lastPlayed, "2026-07-14");
  assert.deepEqual(normalized.activity[0], {
    date: "2026-07-14", externalId: "0100", title: "Zelda", minutes: 16,
    coverUrl: "https://example.com/z.jpg", storeUrl: "https://www.nintendo.com/us/search/#q=Zelda"
  });

  const calls = [];
  const connector = createNintendoConnector({ fetchFn: async (url, options) => {
    calls.push({ url: String(url), options });
    return calls.length === 1
      ? { ok: true, status: 200, json: async () => ({ token_type: "Bearer", access_token: "short-token" }) }
      : { ok: true, status: 200, json: async () => ({ playHistories: [], recentPlayHistories: [] }) };
  } });
  const start = connector.authorizationStart("play-activity");
  assert.equal(new URL(start.authorizationUrl).searchParams.get("client_id"), NINTENDO_PLAY_ACTIVITY_CLIENT_ID);
  const result = await connector.fetchGames("session", "play-activity");
  assert.equal(result.mode, "play-activity");
  assert.match(calls[1].url, /app-api\.znej\.nintendo\.com\/api\/v2\.0/);
  assert.equal(calls[1].options.headers["gentry-locale"], "en-US");
  assert.match(calls[1].options.headers["User-Agent"], /com\.nintendo\.znej\/3\.2\.0/);
});

test("Nintendo 单游戏历史规范化为逐日精确时长", () => {
  assert.deepEqual(normalizeNintendoTitleActivity({ playedDays: [
    { playedDate: "2026-07-10T00:00:00Z", minutesPlayed: 45 },
    { playedDate: "2026-07-09T00:00:00Z", minutesPlayed: 0 }
  ] }, { externalId: "0100", title: "Zelda", coverUrl: "https://example.com/z.jpg", storeUrl: "https://example.com/store" }), [{
    date: "2026-07-10", externalId: "0100", title: "Zelda", minutes: 45,
    coverUrl: "https://example.com/z.jpg", storeUrl: "https://example.com/store"
  }]);
});

test("Nintendo 游戏记录按标题回填完整历史并复用版本游标", async () => {
  const calls = [];
  const payload = {
    playHistories: [{ titleId: "0100", titleName: "Zelda", totalPlayedMinutes: 100, totalPlayedDays: 2, lastPlayedAt: "2026-07-14T00:00:00Z", lastUpdatedAt: "2026-07-15T00:00:00Z" }],
    recentPlayHistories: []
  };
  const connector = createNintendoConnector({ fetchFn: async (url) => {
    calls.push(String(url));
    if (String(url).includes("/api/token")) return { ok: true, json: async () => ({ access_token: "access", token_type: "Bearer" }) };
    if (String(url).includes("/game_titles/0100")) return { ok: true, json: async () => ({ playedDaysOffset: 0, playedDays: [{ playedDate: "2026-07-14T00:00:00Z", minutesPlayed: 60 }, { playedDate: "2026-07-13T00:00:00Z", minutesPlayed: 40 }] }) };
    return { ok: true, json: async () => payload };
  } });
  const first = await connector.fetchGames("session", "play-activity");
  assert.equal(first.historyBackfilled, 1);
  assert.equal(first.activity.length, 2);
  const revision = first.historySync[0].revision;
  const beforeSecond = calls.filter((url) => url.includes("/game_titles/")).length;
  const second = await connector.fetchGames("session", "play-activity", { historyState: new Map([["0100", revision]]) });
  assert.equal(second.historyBackfilled, 0);
  assert.equal(calls.filter((url) => url.includes("/game_titles/")).length, beforeSecond);
});

test("Nintendo 接口错误会保留服务端状态与内部代码", async () => {
  const connector = createNintendoConnector({ fetchFn: async (_url, _options) => _url.includes("/api/token")
    ? { ok: true, status: 200, json: async () => ({ token_type: "Bearer", access_token: "short-token" }) }
    : { ok: false, status: 590, json: async () => ({ code: "0900", detail: "系统维护" }) }
  });
  await assert.rejects(() => connector.fetchGames("session", "play-activity"), /590\/0900.*系统维护/);
});

test("Nintendo 连接器读取设备、日报和月报", async () => {
  const moon = {
    getDevices: async () => ({ items: [{ deviceId: "device", label: "Switch" }] }),
    getDailySummaries: async () => ({ items: [{ date: "2026-07-02", playingTime: 600, playedApps: [{ applicationId: "1", title: "Mario" }], devicePlayers: [], anonymousPlayer: null }] }),
    getMonthlySummaries: async () => ({ indexes: [] }),
    getMonthlySummary: async () => { throw new Error("不应调用"); }
  };
  const connector = createNintendoConnector({ moonApi: { createWithSessionToken: async () => ({ moon, data: { user: { nickname: "Player" } } }) } });
  const result = await connector.fetchGames("token");
  assert.equal(result.nickname, "Player");
  assert.equal(result.deviceCount, 1);
  assert.equal(result.games[0].minutes, 10);
});

test("Nintendo 单个旧设备损坏时仍同步其他主机", async () => {
  const moon = {
    getDevices: async () => ({ items: [{ deviceId: "good", label: "Switch 2" }, { deviceId: "broken" }] }),
    getDailySummaries: async (id) => {
      if (id === "broken") throw new Error("Nintendo server error");
      return { items: [{ date: "2026-07-14", playingTime: 600, playedApps: [{ applicationId: "1", title: "Mario" }], devicePlayers: [], anonymousPlayer: null }] };
    },
    getMonthlySummaries: async () => ({ indexes: [] }),
    getMonthlySummary: async () => { throw new Error("不应调用"); }
  };
  const connector = createNintendoConnector({ moonApi: { createWithSessionToken: async () => ({ moon, data: {} }) } });
  const result = await connector.fetchGames("token");
  assert.equal(result.games[0].title, "Mario");
  assert.equal(result.skippedSections, 1);
});
