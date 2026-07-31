import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openCommunityDatabase } from "../src/community-store.mjs";

function legacyDatabase(filename, { likes, message }) {
  const database = new DatabaseSync(filename);
  database.exec(`
    CREATE TABLE guestbook_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nickname TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE feedback_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nickname TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE site_counters (
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    );
  `);
  database.prepare("INSERT INTO guestbook_messages(nickname, message) VALUES (?, ?)").run("访客", message);
  database.prepare("INSERT INTO feedback_messages(nickname, message) VALUES (?, ?)").run("访客", `反馈：${message}`);
  database.prepare("INSERT INTO site_counters(name, value) VALUES ('likes', ?)").run(likes);
  return database;
}

test("首次启动把旧游戏数据库中的社区内容迁移到独立数据库", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "playlog-community-"));
  try {
    const legacy = legacyDatabase(path.join(directory, "games.db"), { likes: 107, message: "旧留言" });
    const community = openCommunityDatabase({ dataDirectory: directory, legacyDatabase: legacy });

    assert.equal(community.prepare("SELECT message FROM guestbook_messages").get().message, "旧留言");
    assert.equal(community.prepare("SELECT message FROM feedback_messages").get().message, "反馈：旧留言");
    assert.equal(community.prepare("SELECT value FROM site_counters WHERE name = 'likes'").get().value, 107);

    community.close();
    legacy.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("后续游戏数据库镜像不会覆盖已经迁移的社区内容", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "playlog-community-"));
  try {
    const firstLegacy = legacyDatabase(path.join(directory, "games-first.db"), { likes: 107, message: "需要保留" });
    const firstCommunity = openCommunityDatabase({ dataDirectory: directory, legacyDatabase: firstLegacy });
    firstCommunity.prepare("INSERT INTO guestbook_messages(nickname, message) VALUES (?, ?)").run("新访客", "公网新留言");
    firstCommunity.prepare("UPDATE site_counters SET value = 108 WHERE name = 'likes'").run();
    firstCommunity.close();
    firstLegacy.close();

    const replacement = legacyDatabase(path.join(directory, "games-replacement.db"), { likes: 2, message: "镜像旧留言" });
    const community = openCommunityDatabase({ dataDirectory: directory, legacyDatabase: replacement });
    const messages = community.prepare("SELECT message FROM guestbook_messages ORDER BY id").all().map((row) => row.message);

    assert.deepEqual(messages, ["需要保留", "公网新留言"]);
    assert.equal(community.prepare("SELECT value FROM site_counters WHERE name = 'likes'").get().value, 108);

    community.close();
    replacement.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("全新安装无需旧社区表也能创建数据库", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "playlog-community-"));
  try {
    const legacy = new DatabaseSync(path.join(directory, "games.db"));
    const community = openCommunityDatabase({ dataDirectory: directory, legacyDatabase: legacy });

    assert.equal(community.prepare("SELECT value FROM site_counters WHERE name = 'likes'").get().value, 0);
    assert.deepEqual(community.prepare("SELECT * FROM guestbook_messages").all(), []);

    community.close();
    legacy.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
