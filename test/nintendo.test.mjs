import test from "node:test";
import assert from "node:assert/strict";
import { aggregateNintendoGames, createNintendoConnector, NINTENDO_CLIENT_ID } from "../src/platforms/nintendo.mjs";

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
