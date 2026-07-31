import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const legacyMigration = "legacy-community-from-games-v1";

function tableExists(database, name) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function migrateLegacyCommunityData(community, legacy) {
  if (!legacy || community.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(legacyMigration)) return;

  community.exec("BEGIN IMMEDIATE");
  try {
    if (tableExists(legacy, "guestbook_messages")) {
      const insert = community.prepare(`
        INSERT OR IGNORE INTO guestbook_messages(id, nickname, message, created_at)
        VALUES (?, ?, ?, ?)
      `);
      for (const row of legacy.prepare("SELECT id, nickname, message, created_at FROM guestbook_messages ORDER BY id").all()) {
        insert.run(row.id, row.nickname, row.message, row.created_at);
      }
    }

    if (tableExists(legacy, "feedback_messages")) {
      const insert = community.prepare(`
        INSERT OR IGNORE INTO feedback_messages(id, nickname, message, created_at)
        VALUES (?, ?, ?, ?)
      `);
      for (const row of legacy.prepare("SELECT id, nickname, message, created_at FROM feedback_messages ORDER BY id").all()) {
        insert.run(row.id, row.nickname, row.message, row.created_at);
      }
    }

    if (tableExists(legacy, "site_counters")) {
      const legacyLikes = Number(legacy.prepare("SELECT value FROM site_counters WHERE name = 'likes'").get()?.value || 0);
      community.prepare(`
        UPDATE site_counters
        SET value = MAX(value, ?), updated_at = CURRENT_TIMESTAMP
        WHERE name = 'likes'
      `).run(legacyLikes);
    }

    community.prepare("INSERT INTO schema_migrations(name) VALUES (?)").run(legacyMigration);
    community.exec("COMMIT");
  } catch (error) {
    community.exec("ROLLBACK");
    throw error;
  }
}

export function openCommunityDatabase({ dataDirectory, legacyDatabase = null, databaseFile = null }) {
  const filename = databaseFile || path.join(dataDirectory, "community.db");
  const community = new DatabaseSync(filename);
  community.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS guestbook_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nickname TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS feedback_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nickname TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS site_counters (
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0 CHECK(value >= 0),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT OR IGNORE INTO site_counters(name, value) VALUES ('likes', 0);
  `);
  migrateLegacyCommunityData(community, legacyDatabase);
  return community;
}
