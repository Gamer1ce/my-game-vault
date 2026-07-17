import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fastStartStatus, readTopLevelBoxes } from "../src/mp4-faststart.mjs";

function box(type, payloadSize = 0) {
  const value = Buffer.alloc(8 + payloadSize);
  value.writeUInt32BE(value.length, 0);
  value.write(type, 4, 4, "ascii");
  return value;
}

test("识别 MP4 索引位于媒体数据之前", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "game-vault-mp4-"));
  try {
    const optimized = path.join(directory, "optimized.mp4");
    const delayed = path.join(directory, "delayed.mp4");
    writeFileSync(optimized, Buffer.concat([box("ftyp", 4), box("moov", 8), box("mdat", 16)]));
    writeFileSync(delayed, Buffer.concat([box("ftyp", 4), box("mdat", 16), box("moov", 8)]));
    assert.equal(fastStartStatus(optimized).optimized, true);
    assert.equal(fastStartStatus(delayed).optimized, false);
    assert.deepEqual(readTopLevelBoxes(optimized).map((item) => item.type), ["ftyp", "moov", "mdat"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
