import { createHash } from "node:crypto";

const GAMEPLAY_SHEET_NAME = "gameplay online";

const localizedTitleHints = new Map([
  ["虹彩六號 圍攻行動 x", "rainbow six siege"],
  ["apex 英雄 流傳千古組合包", "apex legends"],
  ["戰地風雲 2042", "battlefield 2042"],
  ["喋血復仇 標準版", "back 4 blood"],
  ["鬥陣特攻", "overwatch"],
  ["跑車浪漫旅 7", "gran turismo 7"],
  ["決勝時刻", "call of duty"],
  ["看門狗 2", "watch dogs 2"],
  ["決勝時刻 黑色行動 冷戰", "call of duty black ops cold war"],
  ["極限巔峰", "steep"],
  ["黑相集 棉蘭號", "man of medan"],
  ["決勝時刻 現代戰爭 ii 2022 公開測試", "call of duty modern warfare ii"],
  ["湯姆克蘭西 全境封鎖 2", "division 2"],
  ["艾爾登法環", "elden ring"],
  ["極速快感 熱焰", "need for speed heat"],
  ["虹彩六號 撤離禁區", "rainbow six extraction"],
  ["決勝時刻 現代戰爭", "call of duty modern warfare"],
  ["永劫無間", "naraka bladepoint"]
]);

function textValue(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  if (value && typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || "").join("");
    if (value.result !== undefined) return textValue(value.result);
  }
  return String(value ?? "").trim();
}

function normalizedSheetName(value) {
  return String(value || "").trim().replace(/^["']+|["']+$/g, "").trim().toLowerCase();
}

export function playstationTitleKey(value) {
  return String(value || "")
    .replace(/[™®©]/g, "")
    .normalize("NFKC")
    .replace(/[《》「」『』【】]/g, " ")
    .replace(/[_/\\:：()（）\[\]{}'’‘“”".,，。!！?？+&-]+/g, " ")
    .replace(/\b(?:playstation|ps)\s*[345]\b/gi, " ")
    .replace(/\b(?:standard edition|標準版)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function titleHint(value) {
  const key = playstationTitleKey(value);
  return localizedTitleHints.get(key) || key;
}

function parseDate(value) {
  const text = textValue(value);
  const match = text.match(/^(\d{4})[-/]([01]?\d)[-/]([0-3]?\d)/);
  if (!match) return null;
  return `${match[1]}-${String(Number(match[2])).padStart(2, "0")}-${String(Number(match[3])).padStart(2, "0")}`;
}

function numberValue(value) {
  const numeric = Number(textValue(value).replace(/,/g, ""));
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function headerMap(row) {
  const headers = new Map();
  row.eachCell({ includeEmpty: true }, (cell, column) => {
    const key = textValue(cell.value).trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
    if (key) headers.set(key, column);
  });
  return headers;
}

function roundedHistory(dailySeconds, totalSeconds) {
  const rows = [...dailySeconds.entries()].map(([date, seconds]) => ({
    date,
    minutes: Math.floor(seconds / 60),
    remainder: seconds % 60
  }));
  let remaining = Math.max(0, Math.round(totalSeconds / 60) - rows.reduce((sum, row) => sum + row.minutes, 0));
  for (const row of [...rows].sort((left, right) => right.remainder - left.remainder || left.date.localeCompare(right.date))) {
    if (remaining <= 0) break;
    row.minutes += 1;
    remaining -= 1;
  }
  return rows.sort((left, right) => left.date.localeCompare(right.date)).map(({ date, minutes }) => ({ date, minutes }));
}

export function parsePlaystationGameplayWorkbook(workbook) {
  const sheet = workbook.worksheets.find((candidate) => normalizedSheetName(candidate.name) === GAMEPLAY_SHEET_NAME);
  if (!sheet) return null;

  let headers = null;
  let headerRowNumber = 0;
  for (let rowNumber = 1; rowNumber <= Math.min(sheet.rowCount, 25); rowNumber += 1) {
    const candidate = headerMap(sheet.getRow(rowNumber));
    if (candidate.has("name") && candidate.has("date of play") && candidate.has("session duration")) {
      headers = candidate;
      headerRowNumber = rowNumber;
      break;
    }
  }
  if (!headers) throw new Error("Gameplay Online 工作表缺少 Name、Date Of Play 或 Session Duration 表头");

  const games = new Map();
  const errors = [];
  let previousTitle = "";
  for (let rowNumber = headerRowNumber + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const explicitTitle = textValue(row.getCell(headers.get("name")).value).trim();
    if (explicitTitle) previousTitle = explicitTitle;
    const title = explicitTitle || previousTitle;
    const date = parseDate(row.getCell(headers.get("date of play")).value);
    const seconds = numberValue(row.getCell(headers.get("session duration")).value);
    if (!title && !date && (seconds === null || seconds === 0)) continue;
    if (!title || !date || seconds === null) {
      errors.push({ row: rowNumber, reason: !title ? "缺少游戏名称" : !date ? "无法识别游玩日期" : "无法识别 Session Duration" });
      continue;
    }

    const key = playstationTitleKey(title);
    const game = games.get(key) || { title, totalSeconds: 0, lastPlayed: null, dailySeconds: new Map() };
    game.totalSeconds += seconds;
    game.lastPlayed = !game.lastPlayed || date > game.lastPlayed ? date : game.lastPlayed;
    game.dailySeconds.set(date, Number(game.dailySeconds.get(date) || 0) + seconds);
    games.set(key, game);
  }

  const records = [...games.values()].map((game) => ({
    title: game.title,
    minutes: Math.round(game.totalSeconds / 60),
    lastPlayed: game.lastPlayed,
    history: roundedHistory(game.dailySeconds, game.totalSeconds)
  })).sort((left, right) => left.title.localeCompare(right.title, "zh-Hant"));

  return { sheetName: sheet.name, records, errors };
}

function dayDistance(left, right) {
  if (!left || !right) return Number.POSITIVE_INFINITY;
  const leftTime = Date.parse(`${left}T00:00:00Z`);
  const rightTime = Date.parse(`${right}T00:00:00Z`);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) ? Math.abs(leftTime - rightTime) / 86_400_000 : Number.POSITIVE_INFINITY;
}

function titleScore(importedTitle, gameTitle) {
  const importedKey = playstationTitleKey(importedTitle);
  const hint = titleHint(importedTitle);
  const gameKey = playstationTitleKey(gameTitle);
  if (importedKey === gameKey) return 100;
  if (hint === gameKey) return 95;
  if (gameKey.includes(hint) || hint.includes(gameKey)) return 85;
  const hintTokens = hint.split(" ").filter((token) => token.length > 1);
  if (hintTokens.length && hintTokens.every((token) => gameKey.includes(token))) return 80;
  const overlap = hintTokens.filter((token) => gameKey.includes(token)).length;
  return hintTokens.length ? Math.round((overlap / hintTokens.length) * 50) : 0;
}

export function matchPlaystationCalibrationRecord(record, games, aliases = new Map()) {
  const aliasKey = playstationTitleKey(record.title);
  const aliasedPlatformId = aliases.get(aliasKey);
  if (aliasedPlatformId) {
    const aliased = games.find((game) => String(game.platformId || game.externalId || "") === String(aliasedPlatformId));
    if (aliased) return { game: aliased, aliasKey, score: Number.POSITIVE_INFINITY, method: "saved-alias" };
  }

  const ranked = games.map((game) => {
    const base = titleScore(record.title, game.title);
    const distance = dayDistance(record.lastPlayed, game.lastPlayed);
    const dateBonus = distance === 0 ? 20 : distance <= 3 ? 15 : distance <= 14 ? 8 : distance <= 60 ? 3 : 0;
    const wantsPs5 = /(?:ps|playstation)\s*5/i.test(record.title);
    const platformId = String(game.platformId || game.externalId || "");
    const platformBonus = wantsPs5 ? (platformId.startsWith("PPSA") ? 8 : -8) : 0;
    return { game, score: base + dateBonus + platformBonus, base, distance };
  }).filter((candidate) => candidate.base >= 50)
    .sort((left, right) => right.score - left.score || left.distance - right.distance);

  if (!ranked.length) return null;
  if (ranked.length > 1 && ranked[0].score === ranked[1].score) return null;
  const exactTitle = playstationTitleKey(record.title) === playstationTitleKey(ranked[0].game.title);
  return { game: ranked[0].game, aliasKey, score: ranked[0].score, method: exactTitle ? "title" : "title-alias" };
}

export function playstationCalibrationFingerprint(records) {
  const canonical = records.map((record) => ({
    title: playstationTitleKey(record.title),
    minutes: Number(record.minutes || 0),
    lastPlayed: record.lastPlayed || null,
    history: (record.history || []).map((item) => [item.date, Number(item.minutes || 0)])
  })).sort((left, right) => left.title.localeCompare(right.title));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function calibratedFinalMinutes(currentPlatformMinutes, calibratedMinutes, calibrationPlatformMinutes) {
  const current = Math.max(0, Number(currentPlatformMinutes || 0));
  if (calibratedMinutes === null || calibratedMinutes === undefined || calibrationPlatformMinutes === null || calibrationPlatformMinutes === undefined) return current;
  return Math.max(0, Number(calibratedMinutes || 0)) + Math.max(0, current - Math.max(0, Number(calibrationPlatformMinutes || 0)));
}
