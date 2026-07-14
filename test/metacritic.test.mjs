import test from "node:test";
import assert from "node:assert/strict";
import { createMetacriticConnector, normalizeScoreTitle } from "../src/metacritic.mjs";

test("评分匹配会忽略商标和版本后缀", () => {
  assert.equal(normalizeScoreTitle("Cyberpunk 2077™ Ultimate Edition"), normalizeScoreTitle("Cyberpunk 2077"));
  assert.equal(normalizeScoreTitle("Baldur's Gate III"), normalizeScoreTitle("Baldur's Gate 3"));
});

test("RAWG 连接器按平台精确匹配 Metacritic 评分", async () => {
  const calls = [];
  const connector = createMetacriticConnector({ fetchFn: async (url) => {
    calls.push(url);
    return calls.length === 1
      ? { ok: true, status: 200, json: async () => ({ results: [] }) }
      : { ok: true, status: 200, json: async () => ({ results: [{ name: "Cyberpunk 2077", slug: "cyberpunk-2077", metacritic: 86 }] }) };
  } });
  await connector.connect("valid-api-key-1234");
  const result = await connector.fetchScore("valid-api-key-1234", { title: "Cyberpunk 2077™", platform: "steam" });
  assert.deepEqual(result, { score: 86, scoreUrl: "https://rawg.io/games/cyberpunk-2077" });
  assert.equal(calls[1].searchParams.get("platforms"), "4");
  assert.equal(calls[1].searchParams.get("search_precise"), "true");
});

test("未收录评分时返回空值，不把 null 当成 0 分", async () => {
  const connector = createMetacriticConnector({ fetchFn: async () => ({
    ok: true,
    status: 200,
    json: async () => ({ results: [{ name: "Game", slug: "game", metacritic: null }] })
  }) });
  assert.deepEqual(await connector.fetchScore("valid-api-key-1234", { title: "Game", platform: "xbox" }), {
    score: null,
    scoreUrl: "https://rawg.io/games/game"
  });
});

test("RAWG 缺分时从 Metacritic 公开游戏页补全", async () => {
  const connector = createMetacriticConnector({ fetchFn: async (url) => {
    if (url.hostname === "backend.metacritic.com") {
      return { ok: true, status: 200, json: async () => ({
        data: { item: { title: "Metaphor: ReFantazio", slug: "metaphor-refantazio", criticScoreSummary: { score: 94 } } }
      }) };
    }
    return url.pathname === "/api/games/42"
      ? { ok: true, status: 200, json: async () => ({ metacritic: null, metacritic_platforms: [] }) }
      : { ok: true, status: 200, json: async () => ({ results: [{ id: 42, name: "Metaphor: ReFantazio", slug: "metaphor-refantazio", metacritic: null }] }) };
  } });
  assert.deepEqual(await connector.fetchScore("valid-api-key-1234", { title: "Metaphor: ReFantazio", platform: "playstation" }), {
    score: 94,
    scoreUrl: "https://www.metacritic.com/game/metaphor-refantazio/"
  });
});

test("Metacritic 标题迁移后跟随返回的规范 slug", async () => {
  const connector = createMetacriticConnector({ fetchFn: async (url) => {
    if (url.hostname === "backend.metacritic.com" && url.pathname.includes("persona-5-strikers")) {
      return { ok: true, status: 200, json: async () => ({
        data: { item: { title: "Persona 5 Strikers", slug: "persona-5-strikers", criticScoreSummary: { score: 83 } } }
      }) };
    }
    if (url.hostname === "backend.metacritic.com") {
      return { ok: false, status: 301, json: async () => ({
        errors: [{ context: { availableOn: [{ slug: "persona-5-strikers" }] } }]
      }) };
    }
    return { ok: true, status: 200, json: async () => ({
      results: [{ name: "Persona 5 Scramble: The Phantom Strikers", slug: "persona-5-scramble-the-phantom-strikers", metacritic: null }]
    }) };
  } });
  assert.deepEqual(await connector.fetchScore("valid-api-key-1234", { title: "Persona 5 Scramble: The Phantom Strikers", platform: "playstation" }), {
    score: 83,
    scoreUrl: "https://www.metacritic.com/game/persona-5-strikers/"
  });
});

test("列表无总分时读取游戏详情中的平台分数", async () => {
  const connector = createMetacriticConnector({ fetchFn: async (url) => ({
    ok: true,
    status: 200,
    json: async () => url.pathname === "/api/games/42"
      ? { metacritic: null, metacritic_platforms: [{ metascore: 91, platform: { platform: 4 } }] }
      : { results: [{ id: 42, name: "Game", slug: "game", metacritic: null }] }
  }) });
  assert.deepEqual(await connector.fetchScore("valid-api-key-1234", { title: "Game", platform: "steam" }), {
    score: 91,
    scoreUrl: "https://rawg.io/games/game"
  });
});
