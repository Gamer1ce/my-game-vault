import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

function readJson(file) {
  if (!file || !existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function atomicJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  chmodSync(file, 0o600);
}

export function createSyncRequestQueue(file, {
  now = () => new Date(),
  createId = randomUUID
} = {}) {
  const requestFile = String(file || "").trim();
  const resultFile = requestFile ? `${requestFile}.result.json` : "";

  return {
    enabled: Boolean(requestFile),
    enqueue() {
      if (!requestFile) throw new Error("远程同步请求队列未启用");
      const request = {
        id: createId(),
        requestedAt: now().toISOString()
      };
      atomicJson(requestFile, request);
      if (resultFile && existsSync(resultFile)) unlinkSync(resultFile);
      return request;
    },
    status() {
      if (!requestFile) return { enabled: false, request: null, result: null };
      return {
        enabled: true,
        request: readJson(requestFile),
        result: readJson(resultFile)
      };
    }
  };
}
