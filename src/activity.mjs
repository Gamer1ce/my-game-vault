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
