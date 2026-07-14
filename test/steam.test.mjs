import test from "node:test";
import assert from "node:assert/strict";
import { createSteamConnector, normalizeSteamGames } from "../src/platforms/steam.mjs";

test("规范化 Steam 游戏时长和最后游玩日期", () => {
  const games = normalizeSteamGames({ response: { games: [{ appid: 730, name: "Counter-Strike 2", playtime_forever: 125, playtime_windows_forever: 120, playtime_deck_forever: 5, rtime_last_played: 1782864000 }] } });
  assert.deepEqual(games[0], { platform: "steam", externalId: "730", title: "Counter-Strike 2", coverUrl: "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/730/header.jpg", storeUrl: "https://store.steampowered.com/app/730/", minutes: 125, lastPlayed: "2026-07-01", notes: "Steam · Windows, Steam Deck" });
});

test("Steam 连接器解析自定义主页并同步游戏", async () => {
  const calls = [];
  const connector = createSteamConnector({ fetchFn: async (url, options) => {
    calls.push({ url: url.toString(), options });
    if (url.pathname.includes("ResolveVanityURL")) return { ok: true, status: 200, json: async () => ({ response: { success: 1, steamid: "76561198000000000" } }) };
    if (url.pathname.includes("GetPlayerSummaries")) return { ok: true, status: 200, json: async () => ({ response: { players: [{ personaname: "Player" }] } }) };
    return { ok: true, status: 200, json: async () => ({ response: { games: [{ appid: 1, name: "Game", playtime_forever: 60 }] } }) };
  } });
  const account = await connector.connect("key", "https://steamcommunity.com/id/player/");
  assert.deepEqual(account, { steamId: "76561198000000000", personaName: "Player" });
  assert.equal((await connector.fetchGames({ apiKey: "key", ...account }))[0].minutes, 60);
  assert.equal(calls[0].options.headers["x-webapi-key"], "key");
  assert.equal(calls.length, 3);
});

test("Steam 私密游戏详情返回清晰错误", async () => {
  const connector = createSteamConnector({ fetchFn: async (url) => {
    if (url.pathname.includes("GetPlayerSummaries")) return { ok: true, status: 200, json: async () => ({ response: { players: [{}] } }) };
    return { ok: true, status: 200, json: async () => ({ response: {} }) };
  } });
  await assert.rejects(() => connector.fetchGames({ apiKey: "key", steamId: "76561198000000000" }), /游戏详情.*公开/);
});

test("Steam 同步官方成就数量", async () => {
  const connector = createSteamConnector({ fetchFn: async (url) => {
    if (url.pathname.includes("GetOwnedGames")) return { ok: true, status: 200, json: async () => ({ response: { games: [{ appid: 10, name: "Game", playtime_forever: 60, has_community_visible_stats: true }] } }) };
    return { ok: true, status: 200, json: async () => ({ playerstats: { achievements: [{ achieved: 1 }, { achieved: 0 }] } }) };
  } });
  const [game] = await connector.fetchGames({ apiKey: "key", steamId: "76561198000000000" });
  assert.equal(game.achievementsEarned, 1);
  assert.equal(game.achievementsTotal, 2);
});
