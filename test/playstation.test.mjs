import test from "node:test";
import assert from "node:assert/strict";
import { createPlaystationConnector, normalizePlaystationAchievements, normalizePlaystationTitles, parseIsoDurationToMinutes } from "../src/platforms/playstation.mjs";

test("解析 PSN ISO 8601 时长", () => {
  assert.equal(parseIsoDurationToMinutes("PT228H56M33S"), 13737);
  assert.equal(parseIsoDurationToMinutes("P1DT2H30M"), 1590);
  assert.equal(parseIsoDurationToMinutes("invalid"), 0);
});

test("规范化 PSN 游戏记录", () => {
  const records = normalizePlaystationTitles([{ titleId: "PPSA00001", name: "Game", localizedName: "游戏", playDuration: "PT12H30M", lastPlayedDateTime: "2026-07-01T10:00:00Z", category: "ps5_native_game", playCount: 8 }]);
  assert.deepEqual(records[0], { platform: "playstation", externalId: "PPSA00001", title: "游戏", coverUrl: null, storeUrl: "https://store.playstation.com/search/%E6%B8%B8%E6%88%8F", minutes: 750, lastPlayed: "2026-07-01", notes: "ps5_native_game · 启动 8 次" });
});

test("汇总 PlayStation 奖杯并识别全成就", () => {
  assert.deepEqual(normalizePlaystationAchievements([{
    trophyTitleName: "Game™", trophyTitlePlatform: "PS5",
    earnedTrophies: { bronze: 10, silver: 5, gold: 2, platinum: 1 },
    definedTrophies: { bronze: 10, silver: 5, gold: 2, platinum: 1 }
  }]), [{ key: "game", platform: "ps5", earned: 18, total: 18 }]);
});

test("PSN 连接器完成认证与分页", async () => {
  const calls = [];
  const connector = createPlaystationConnector({
    exchangeNpssoForAccessCode: async (token) => `code:${token}`,
    exchangeAccessCodeForAuthTokens: async (code) => ({ accessToken: code, refreshToken: "refresh", expiresIn: 3600 }),
    exchangeRefreshTokenForAuthTokens: async () => ({ accessToken: "new", refreshToken: "new-refresh", expiresIn: 3600 }),
    getUserPlayedGames: async (_auth, _account, options) => {
      calls.push(options.offset);
      return options.offset === 0
        ? { titles: [{ titleId: "1", name: "A", playDuration: "PT1H" }], totalItemCount: 2, nextOffset: 1 }
        : { titles: [{ titleId: "2", name: "B", playDuration: "PT2H" }], totalItemCount: 2, nextOffset: 2 };
    }
  });
  assert.equal((await connector.connect("npsso")).accessToken, "code:npsso");
  assert.equal((await connector.refresh("refresh")).accessToken, "new");
  assert.deepEqual((await connector.fetchGames("access")).map((game) => game.minutes), [60, 120]);
  assert.deepEqual(calls, [0, 1]);
});
