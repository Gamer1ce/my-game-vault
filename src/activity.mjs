export function cumulativeDelta(previousMinutes, currentMinutes) {
  if (previousMinutes === null || previousMinutes === undefined) return 0;
  return Math.max(0, Math.round(Number(currentMinutes || 0)) - Math.round(Number(previousMinutes || 0)));
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

export function groupActivityRows(rows) {
  const byDate = new Map();
  for (const row of rows) {
    if (!byDate.has(row.date)) byDate.set(row.date, { date: row.date, totalMinutes: 0, historicalCount: 0, games: [], keys: new Map() });
    const day = byDate.get(row.date);
    const key = `${row.platform}:${row.externalId || String(row.title).toLocaleLowerCase("zh-CN")}`;
    const existingIndex = day.keys.get(key);
    if (existingIndex !== undefined) {
      const existing = day.games[existingIndex];
      if (Number(row.minutes) > Number(existing.minutes)) day.games[existingIndex] = row;
      continue;
    }
    day.keys.set(key, day.games.length);
    day.totalMinutes += Number(row.minutes || 0);
    if (row.eventType === "lastPlayed") day.historicalCount += 1;
    day.games.push(row);
  }
  return [...byDate.values()].map(({ keys, ...day }) => day);
}
