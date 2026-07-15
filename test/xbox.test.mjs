import test from "node:test";
import assert from "node:assert/strict";
import { createXboxConnector, normalizeOpenXblTitles, parseOpenXblAccount, parseOpenXblAchievements, parseOpenXblStats, parseOpenXblTitleAchievements } from "../src/platforms/xbox.mjs";

test("解析 OpenXBL 账号资料", () => {
  assert.deepEqual(parseOpenXblAccount({ profileUsers: [{ id: "2533", settings: [{ id: "Gamertag", value: "Player" }] }] }), { xuid: "2533", gamertag: "Player" });
});

test("规范化 OpenXBL 游戏历史和时长", () => {
  const stats = parseOpenXblStats({ statlistscollection: [{ stats: [{ xuid: "2533", titleid: "123", name: "MinutesPlayed", value: "456" }] }] });
  const games = normalizeOpenXblTitles({ titles: [{ titleId: "123", name: "Forza", type: "Game", devices: ["XboxSeries"], titleHistory: { lastTimePlayed: "2026-07-01T00:00:00Z" } }] }, stats);
  assert.deepEqual(games[0], { platform: "xbox", externalId: "123", title: "Forza", coverUrl: null, storeUrl: "https://www.xbox.com/search/results?q=Forza", minutes: 456, lastPlayed: "2026-07-01", notes: "OpenXBL · XboxSeries" });
});

test("解析 OpenXBL 每款游戏的成就进度", () => {
  const achievements = parseOpenXblAchievements({ titles: [
    { titleId: "123", achievement: { currentAchievements: 40, totalAchievements: 50 } },
    { titleId: "456", achievement: { currentAchievements: 12, totalAchievements: 0 } }
  ] });
  assert.deepEqual(achievements.get("123"), { earned: 40, total: 50 });
  assert.deepEqual(achievements.get("456"), { earned: 12, total: null });
});

test("从 OpenXBL 单游戏成就列表补全总数", () => {
  assert.deepEqual(parseOpenXblTitleAchievements({
    achievements: [{ progressState: "Achieved" }, { progressState: "InProgress" }, { progressState: "NotStarted" }],
    pagingInfo: { totalRecords: 3 }
  }), { earned: 1, total: 3 });
});

test("标题汇总缺少分母时读取单游戏成就列表", async () => {
  const calls = [];
  const connector = createXboxConnector({ fetchFn: async (url) => {
    calls.push(url);
    if (url.endsWith("/titleHistory")) return { ok: true, json: async () => ({ titles: [{ titleId: "1", name: "Halo", minutesPlayed: 90 }] }) };
    if (url.endsWith("/achievements")) return { ok: true, json: async () => ({ titles: [{ titleId: "1", achievement: { currentAchievements: 2, totalAchievements: 0 } }] }) };
    if (url.includes("/achievements/player/2533/1")) return { ok: true, json: async () => ({ achievements: [{ progressState: "Achieved" }, { progressState: "Achieved" }, { progressState: "NotStarted" }], pagingInfo: { totalRecords: 3 } }) };
    return { ok: true, json: async () => ({}) };
  } });
  const games = await connector.fetchGames({ apiKey: "key", xuid: "2533" });
  assert.equal(games[0].achievementsEarned, 2);
  assert.equal(games[0].achievementsTotal, 3);
  assert.ok(calls.some((url) => url.includes("/achievements/player/2533/1")));
});

test("OpenXBL 连接器验证 API Key 并请求历史和统计", async () => {
  const calls = [];
  const connector = createXboxConnector({ fetchFn: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/account")) return { ok: true, json: async () => ({ xuid: "2533", gamertag: "Player" }) };
    if (url.endsWith("/titleHistory")) return { ok: true, json: async () => ({ titles: [{ titleId: "1", name: "Halo" }] }) };
    if (url.endsWith("/achievements")) return { ok: true, json: async () => ({ titles: [{ titleId: "1", achievement: { currentAchievements: 2, totalAchievements: 10 } }] }) };
    return { ok: true, json: async () => ({ results: [{ titleId: "1", stats: [{ name: "MinutesPlayed", value: 90 }] }] }) };
  } });
  const account = await connector.connect("key");
  const games = await connector.fetchGames({ apiKey: "key", ...account });
  assert.equal(games[0].minutes, 90);
  assert.equal(games[0].achievementsEarned, 2);
  assert.equal(games[0].achievementsTotal, 10);
  assert.equal(calls.length, 4);
  assert.equal(calls[0].options.headers["x-authorization"], "key");
  assert.equal(calls[0].options.headers["Accept-Language"], "en-US");
  assert.match(calls[3].options.body, /MinutesPlayed/);
});

test("OpenXBL 包装错误不会被误当成空列表", async () => {
  const connector = createXboxConnector({ fetchFn: async () => ({
    ok: true,
    status: 200,
    json: async () => ({ code: 400, content: JSON.stringify(["upstream failed"]) })
  }) });
  await assert.rejects(() => connector.connect("key"), /upstream failed/);
});

test("OpenXBL 无效 Key 返回清晰错误", async () => {
  const connector = createXboxConnector({ fetchFn: async () => ({ ok: false, status: 403, json: async () => ({ message: "Forbidden" }) }) });
  await assert.rejects(() => connector.connect("bad"), /API Key 无效/);
});
