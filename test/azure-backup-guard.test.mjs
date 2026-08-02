import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Azure 镜像拒绝用空游戏库覆盖公网数据", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "playlog-azure-guard-"));
  try {
    const databaseFile = path.join(directory, "games.db");
    const database = new DatabaseSync(databaseFile);
    database.exec(`
      CREATE TABLE games (
        id INTEGER PRIMARY KEY,
        minutes INTEGER NOT NULL DEFAULT 0,
        time_status TEXT NOT NULL DEFAULT 'known'
      );
    `);
    database.close();

    const keyFile = path.join(directory, "dummy-key");
    writeFileSync(keyFile, "test-only\n", { mode: 0o600 });
    const result = spawnSync("/bin/zsh", [path.join(root, "scripts/sync-azure-backup.zsh")], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GAME_VAULT_DATABASE_FILE: databaseFile,
        AZURE_BACKUP_KEY_PATH: keyFile,
        AZURE_BACKUP_LOCK_DIR: path.join(directory, "sync.lock"),
        AZURE_BACKUP_MIN_VISIBLE_GAMES: "1"
      }
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /refusing to replace Azure with only 0 visible games/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
