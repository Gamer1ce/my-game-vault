import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CredentialStore } from "../src/credential-store.mjs";

test("凭据被加密保存并可删除", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "playlog-credentials-"));
  try {
    const store = new CredentialStore(directory);
    store.set("playstation", { refreshToken: "very-secret-token" });
    assert.deepEqual(store.get("playstation"), { refreshToken: "very-secret-token" });
    assert.equal(readFileSync(path.join(directory, "credentials.enc"), "utf8").includes("very-secret-token"), false);
    store.delete("playstation");
    assert.equal(store.get("playstation"), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
