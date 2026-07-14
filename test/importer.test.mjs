import test from "node:test";
import assert from "node:assert/strict";
import { normalizePlatform, normalizeRows, parseDuration, parseJsonRows } from "../src/importer.mjs";

test("识别四家平台名称", () => {
  assert.equal(normalizePlatform("Xbox"), "xbox");
  assert.equal(normalizePlatform("PS5"), "playstation");
  assert.equal(normalizePlatform("任天堂"), "nintendo");
  assert.equal(normalizePlatform("Steam"), "steam");
});

test("解析常见时长格式", () => {
  assert.equal(parseDuration("12h 35m"), 755);
  assert.equal(parseDuration("12 小时 35 分钟"), 755);
  assert.equal(parseDuration("12:35"), 755);
  assert.equal(parseDuration(12.5, "hours"), 750);
});

test("规范化中英文字段并报告错误行", () => {
  const result = normalizeRows([
    { 游戏名称: "星之卡比", 游玩时长: "20 小时 5 分钟", 平台: "Nintendo" },
    { Title: "Forza Horizon 5", Hours: 30 },
    { Title: "缺少时长" }
  ], "xbox");
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].minutes, 1205);
  assert.equal(result.records[1].minutes, 1800);
  assert.equal(result.errors.length, 1);
});

test("从常见 JSON 包装中读取数组", () => {
  assert.deepEqual(parseJsonRows('{"games":[{"title":"Halo"}]}'), [{ title: "Halo" }]);
});

test("日期不受本地时区偏移影响", () => {
  const result = normalizeRows([{ title: "Halo", hours: 1, date: new Date(2026, 5, 20) }], "xbox");
  assert.equal(result.records[0].lastPlayed, "2026-06-20");
});
