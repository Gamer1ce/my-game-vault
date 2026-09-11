import path from "node:path";

export const categoryKey = (value) => String(value || "").normalize("NFKC").toLowerCase().replace(/[™®]/g, "").replace(/[^\p{L}\p{N}]/gu, "");
const aliases = [
  ["THE FINALS", "The Finals"], ["ARC Raiders"], ["Apex Legends"],
  ["Persona 3 Reload", "女神异闻录3 Reload"], ["Persona 5 Royal", "女神异闻录5 皇家版"],
  ["Overwatch 2"], ["R.E.P.O.", "Repo"], ["HELLDIVERS 2"],
  ["NINJA GAIDEN 4", "NINJAGAIDEN4"],
  ["DOOM: The Dark Ages"], ["Tom Clancy's Rainbow Six Siege"],
  ["Call of Duty: Infinite Warfare"], ["Warhammer 40,000: Darktide"],
  ["A Plague Tale: Requiem"], ["Counter-Strike 2"], ["The Outlast Trials"]
];

export function filenameGamePrefix(filename) {
  const stem = path.basename(String(filename || ""), path.extname(String(filename || ""))).normalize("NFKC");
  // Only a title before a recording date or an explicit [game] label is evidence.
  const tagged = stem.match(/^\[([^\]]{1,100})\]/);
  if (tagged) return tagged[1].trim();
  const date = stem.search(/20\d{2}[._-]?(?:0[1-9]|1[0-2])[._-]?(?:0[1-9]|[12]\d|3[01])/);
  if (date <= 0) return "";
  return stem.slice(0, date).replace(/[\s_.-]+$/g, "").replace(/_/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
}

export function mediaCategoryKey(item) {
  return JSON.stringify([item.storageSource || "default", item.playbackId || item.filename]);
}

export function classifyHighlights(items, { games = [], overrides = [], rules = [] } = {}) {
  const names = new Map();
  for (const game of games) {
    const title = String(game.title || game.name || "").replace(/\s+(?:PS[345]|Xbox Series X\|S)$/i, "").trim();
    if (title) names.set(categoryKey(title), title);
  }
  for (const [name, ...variants] of aliases) for (const variant of [name, ...variants]) names.set(categoryKey(variant), name);
  const manual = new Map(overrides.map((row) => [row.key, row.label]));
  const learned = new Map(rules.map((row) => [row.key, row.label]));
  return items.map((item) => {
    const prefix = filenameGamePrefix(item.filename);
    const key = categoryKey(prefix);
    const override = manual.get(mediaCategoryKey(item));
    const rule = key && learned.get(key);
    const known = names.get(key);
    const plausible = /\p{L}/u.test(prefix) && !/^(wingdk|java-runtime-beta|desktop|screen|recording|video|unknown|游戏|录屏|录像)$/i.test(prefix);
    const label = override || rule || known || (plausible ? prefix : "未分类");
    return { ...item, gameCategory: label, categorySource: override ? "manual" : rule ? "rule" : label === "未分类" ? "unknown" : "filename", categoryPrefix: prefix };
  });
}

export function createHighlightCategoryStore(db) {
  db.exec("CREATE TABLE IF NOT EXISTS highlight_categories (key TEXT PRIMARY KEY, label TEXT NOT NULL); CREATE TABLE IF NOT EXISTS highlight_category_rules (key TEXT PRIMARY KEY, label TEXT NOT NULL)");
  return {
    snapshot: () => ({ overrides: db.prepare("SELECT key,label FROM highlight_categories").all(), rules: db.prepare("SELECT key,label FROM highlight_category_rules").all() }),
    set(item, label, applyToPrefix = false) {
      if (typeof label !== "string" || label.trim().length > 100 || /[\x00-\x1f]/.test(label)) throw new Error("分类名称须为 1–100 个字符；留空可恢复自动分类");
      const value = label.trim();
      const key = mediaCategoryKey(item);
      const prefix = categoryKey(filenameGamePrefix(item.filename));
      db.exec("BEGIN");
      try {
        if (value) db.prepare("INSERT INTO highlight_categories VALUES (?,?) ON CONFLICT(key) DO UPDATE SET label=excluded.label").run(key, value);
        else db.prepare("DELETE FROM highlight_categories WHERE key=?").run(key);
        if (applyToPrefix && prefix) {
          if (value) db.prepare("INSERT INTO highlight_category_rules VALUES (?,?) ON CONFLICT(key) DO UPDATE SET label=excluded.label").run(prefix, value);
          else db.prepare("DELETE FROM highlight_category_rules WHERE key=?").run(prefix);
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    }
  };
}
