const TITLE_HEADERS = ["title", "game", "game title", "name", "游戏", "游戏名称", "软件", "software"];
const PLATFORM_HEADERS = ["platform", "游戏平台", "平台"];
const MINUTE_HEADERS = ["minutes", "playtime minutes", "分钟", "游玩分钟"];
const HOUR_HEADERS = ["hours", "playtime hours", "小时", "游玩小时"];
const DURATION_HEADERS = ["playtime", "play time", "duration", "time played", "游玩时长", "游戏时长", "时长"];
const DATE_HEADERS = ["last played", "last_played", "lastplayed", "date", "最后游玩", "最后游玩时间", "日期"];
const ID_HEADERS = ["external id", "external_id", "title id", "title_id", "np communication id", "游戏id"];

const normalizedKey = (value) => String(value ?? "").trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");

function findValue(row, aliases) {
  const entries = Object.entries(row).map(([key, value]) => [normalizedKey(key), value]);
  const match = entries.find(([key]) => aliases.includes(key));
  return match?.[1];
}

export function normalizePlatform(value, fallback = "") {
  const platform = normalizedKey(value || fallback);
  if (["xbox", "microsoft", "微软"].includes(platform)) return "xbox";
  if (["playstation", "play station", "ps", "ps4", "ps5", "索尼"].includes(platform)) return "playstation";
  if (["nintendo", "switch", "switch 2", "任天堂"].includes(platform)) return "nintendo";
  if (["steam", "valve", "蒸汽平台"].includes(platform)) return "steam";
  return "";
}

export function parseDuration(value, unit = "duration") {
  if (value === undefined || value === null || value === "") return null;

  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    return Math.round(unit === "hours" ? value * 60 : value);
  }

  const text = String(value).trim().toLowerCase().replace(/,/g, "");
  if (!text) return null;
  const colon = text.match(/^(\d+):(\d{1,2})$/);
  if (colon) return Number(colon[1]) * 60 + Number(colon[2]);

  const hours = text.match(/([\d.]+)\s*(?:hours?|hrs?|h|小时|小時)/);
  const minutes = text.match(/([\d.]+)\s*(?:minutes?|mins?|m|分钟|分鐘)/);
  if (hours || minutes) {
    return Math.round(Number(hours?.[1] || 0) * 60 + Number(minutes?.[1] || 0));
  }

  const numeric = Number(text);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.round(unit === "hours" ? numeric * 60 : numeric);
}

function normalizeDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  const exact = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (exact) return `${exact[1]}-${exact[2]}-${exact[3]}`;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString().slice(0, 10);
}

export function normalizeRows(rows, fallbackPlatform = "") {
  const records = [];
  const errors = [];

  rows.forEach((row, index) => {
    const title = String(findValue(row, TITLE_HEADERS) ?? "").trim();
    const platform = normalizePlatform(findValue(row, PLATFORM_HEADERS), fallbackPlatform);
    const minutesValue = findValue(row, MINUTE_HEADERS);
    const hoursValue = findValue(row, HOUR_HEADERS);
    const durationValue = findValue(row, DURATION_HEADERS);
    const minutes = minutesValue !== undefined
      ? parseDuration(minutesValue, "minutes")
      : hoursValue !== undefined
        ? parseDuration(hoursValue, "hours")
        : parseDuration(durationValue, "duration");

    if (!title || !platform || minutes === null) {
      errors.push({ row: index + 2, reason: !title ? "缺少游戏名称" : !platform ? "无法识别平台" : "无法识别游玩时长" });
      return;
    }

    records.push({
      title,
      platform,
      minutes,
      lastPlayed: normalizeDate(findValue(row, DATE_HEADERS)),
      externalId: String(findValue(row, ID_HEADERS) ?? "").trim() || null
    });
  });

  return { records, errors };
}

export function parseJsonRows(input) {
  const data = JSON.parse(input);
  if (Array.isArray(data)) return data;
  for (const key of ["games", "titles", "items", "data", "playHistory", "play_activity"]) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  throw new Error("JSON 中没有找到游戏记录数组");
}
