import test from "node:test";
import assert from "node:assert/strict";
import { activityDate, cumulativeDelta, groupActivityRows, groupRecentActivity, monthEnd, recentDateRange, reconciledLifetimeMinutes, shanghaiDate } from "../src/activity.mjs";

test("累计时长只记录正向增量且首次同步仅建立基线", () => {
  assert.equal(cumulativeDelta(null, 600), 0);
  assert.equal(cumulativeDelta(600, 645), 45);
  assert.equal(cumulativeDelta(645, 620), 0);
});

test("累计字段落后时使用官方逐日历史且不会重复叠加", () => {
  assert.equal(reconciledLifetimeMinutes(5662, 5732), 5732);
  assert.equal(reconciledLifetimeMinutes(5800, 5732), 5800);
  assert.equal(reconciledLifetimeMinutes(5800, 60), 5800);
});

test("平台接口临时返回零时保留已经确认的累计时长", () => {
  assert.equal(reconciledLifetimeMinutes(0, 3727), 3727);
  assert.equal(cumulativeDelta(3727, reconciledLifetimeMinutes(0, 3727)), 0);
});

test("日历使用上海时区日期并正确跨月", () => {
  assert.equal(shanghaiDate(new Date("2026-07-13T16:30:00Z")), "2026-07-14");
  assert.equal(monthEnd("2026-12"), "2027-01-01");
  assert.equal(activityDate("2026-07-13", "2026-07-15"), "2026-07-13");
  assert.equal(activityDate("2026-07-16", "2026-07-15"), "2026-07-15");
});

test("每日活动按日期汇总并保留游戏明细", () => {
  const days = groupActivityRows([
    { date: "2026-07-14", platform: "steam", title: "Game A", minutes: 20, precision: "detected" },
    { date: "2026-07-14", platform: "xbox", title: "Game B", minutes: 35, precision: "exact" }
  ]);
  assert.equal(days[0].totalMinutes, 55);
  assert.equal(days[0].exactMinutes, 35);
  assert.equal(days[0].detectedMinutes, 20);
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

test("同一游戏同一天优先保留确切逐日记录", () => {
  const [day] = groupActivityRows([
    { date: "2026-07-14", platform: "nintendo", externalId: "1", title: "Game", minutes: 40, precision: "detected" },
    { date: "2026-07-14", platform: "nintendo", externalId: "1", title: "Game", minutes: 40, precision: "exact" },
    { date: "2026-07-14", platform: "nintendo", externalId: "1", title: "Game", minutes: 0, eventType: "lastPlayed", precision: "history" }
  ]);
  assert.equal(day.games.length, 1);
  assert.equal(day.games[0].precision, "exact");
  assert.equal(day.totalMinutes, 40);
  assert.equal(day.historicalCount, 0);
});

test("近两周日期跨月连续且包含结束日期", () => {
  const dates = recentDateRange(14, "2026-01-05");
  assert.equal(dates.length, 14);
  assert.equal(dates[0], "2025-12-23");
  assert.equal(dates.at(-1), "2026-01-05");
});

test("近两周活动按日期与平台汇总并保留精度", () => {
  const days = groupRecentActivity(["2026-07-14", "2026-07-15"], [
    { date: "2026-07-14", platform: "nintendo", minutes: 45, precision: "exact" },
    { date: "2026-07-14", platform: "steam", minutes: 30, precision: "detected" },
    { date: "2026-07-15", platform: "xbox", minutes: 20, precision: "detected" }
  ]);
  assert.deepEqual(days[0], {
    date: "2026-07-14",
    totalMinutes: 75,
    exactMinutes: 45,
    detectedMinutes: 30,
    platforms: { xbox: 0, playstation: 0, nintendo: 45, steam: 30 }
  });
  assert.equal(days[1].platforms.xbox, 20);
});
