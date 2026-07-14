import test from "node:test";
import assert from "node:assert/strict";
import { cumulativeDelta, groupActivityRows, monthEnd, shanghaiDate } from "../src/activity.mjs";

test("累计时长只记录正向增量且首次同步仅建立基线", () => {
  assert.equal(cumulativeDelta(null, 600), 0);
  assert.equal(cumulativeDelta(600, 645), 45);
  assert.equal(cumulativeDelta(645, 620), 0);
});

test("日历使用上海时区日期并正确跨月", () => {
  assert.equal(shanghaiDate(new Date("2026-07-13T16:30:00Z")), "2026-07-14");
  assert.equal(monthEnd("2026-12"), "2027-01-01");
});

test("每日活动按日期汇总并保留游戏明细", () => {
  const days = groupActivityRows([
    { date: "2026-07-14", platform: "steam", title: "Game A", minutes: 20 },
    { date: "2026-07-14", platform: "xbox", title: "Game B", minutes: 35 }
  ]);
  assert.equal(days[0].totalMinutes, 55);
  assert.equal(days[0].games.length, 2);
});

test("日历保留无法还原分钟数的最后游玩历史", () => {
  const [day] = groupActivityRows([
    { date: "2026-06-01", platform: "playstation", externalId: "1", title: "Game", minutes: 0, eventType: "lastPlayed" }
  ]);
  assert.equal(day.totalMinutes, 0);
  assert.equal(day.historicalCount, 1);
  assert.equal(day.games[0].eventType, "lastPlayed");
});
