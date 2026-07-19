export function cumulativeDelta(previousMinutes, currentMinutes) {
  if (previousMinutes === null || previousMinutes === undefined) return 0;
  return Math.max(0, Math.round(Number(currentMinutes || 0)) - Math.round(Number(previousMinutes || 0)));
}

export function reconciledLifetimeMinutes(platformMinutes, exactHistoryMinutes) {
  const platform = Math.max(0, Math.round(Number(platformMinutes || 0)));
  const history = Math.max(0, Math.round(Number(exactHistoryMinutes || 0)));
  return Math.max(platform, history);
}

export function shanghaiDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function monthEnd(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 10);
}

export function recentDateRange(dayCount = 14, endDate = shanghaiDate()) {
  const count = Math.max(1, Math.min(90, Math.trunc(Number(dayCount) || 14)));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) throw new Error("结束日期格式无效");
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(end.getTime())) throw new Error("结束日期无效");
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(end);
    date.setUTCDate(end.getUTCDate() - count + index + 1);
    return date.toISOString().slice(0, 10);
  });
}

export function groupRecentActivity(dates, rows) {
  const platforms = ["xbox", "playstation", "nintendo", "steam"];
  const byDate = new Map(dates.map((date) => [date, {
    date,
    totalMinutes: 0,
    exactMinutes: 0,
    detectedMinutes: 0,
    platforms: Object.fromEntries(platforms.map((platform) => [platform, 0]))
  }]));
  for (const row of rows) {
    const day = byDate.get(row.date);
    if (!day || !platforms.includes(row.platform)) continue;
    const minutes = Math.max(0, Number(row.minutes || 0));
    day.totalMinutes += minutes;
    day.platforms[row.platform] += minutes;
    if (row.precision === "exact") day.exactMinutes += minutes;
    else if (row.precision === "detected") day.detectedMinutes += minutes;
  }
  return [...byDate.values()];
}

export function activityDate(lastPlayed, fallback = shanghaiDate()) {
  const value = String(lastPlayed || "");
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && value <= fallback ? value : fallback;
}

export function groupActivityRows(rows) {
  const byDate = new Map();
  for (const row of rows) {
    if (!byDate.has(row.date)) byDate.set(row.date, { date: row.date, games: [], keys: new Map() });
    const day = byDate.get(row.date);
    const key = `${row.platform}:${row.externalId || String(row.title).toLocaleLowerCase("zh-CN")}`;
    const existingIndex = day.keys.get(key);
    if (existingIndex !== undefined) {
      const existing = day.games[existingIndex];
      if (Number(row.minutes) > Number(existing.minutes) || (Number(row.minutes) === Number(existing.minutes) && row.precision === "exact")) day.games[existingIndex] = row;
      continue;
    }
    day.keys.set(key, day.games.length);
    day.games.push(row);
  }
  return [...byDate.values()].map(({ keys, ...day }) => ({
    ...day,
    totalMinutes: day.games.reduce((sum, row) => sum + Number(row.minutes || 0), 0),
    exactMinutes: day.games.reduce((sum, row) => sum + (row.precision === "exact" ? Number(row.minutes || 0) : 0), 0),
    detectedMinutes: day.games.reduce((sum, row) => sum + (row.precision === "detected" ? Number(row.minutes || 0) : 0), 0),
    historicalCount: day.games.filter((row) => row.eventType === "lastPlayed" && !Number(row.minutes)).length
  }));
}
