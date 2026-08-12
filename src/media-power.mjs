import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MEDIA_POWER_MODES = new Set(["running", "sleeping"]);

export function createMediaPowerStore({ dataDirectory, logger = console } = {}) {
  if (!dataDirectory) throw new Error("媒体服务状态缺少数据目录");
  const runtimeDirectory = path.join(dataDirectory, "runtime");
  const stateFile = path.join(runtimeDirectory, "media-power.json");
  let current = { mode: "running", updatedAt: null };

  if (existsSync(stateFile)) {
    try {
      const saved = JSON.parse(readFileSync(stateFile, "utf8"));
      if (!MEDIA_POWER_MODES.has(saved?.mode)) throw new Error("mode invalid");
      current = {
        mode: saved.mode,
        updatedAt: typeof saved.updatedAt === "string" ? saved.updatedAt : null
      };
    } catch {
      current = { mode: "sleeping", updatedAt: null };
      logger.warn?.("媒体服务状态文件损坏，已安全进入休眠模式");
    }
  }

  return {
    status() {
      return { ...current, sleeping: current.mode === "sleeping" };
    },
    set(mode) {
      if (!MEDIA_POWER_MODES.has(mode)) throw new TypeError("媒体服务状态无效");
      mkdirSync(runtimeDirectory, { recursive: true });
      const next = { mode, updatedAt: new Date().toISOString() };
      const temporary = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      chmodSync(temporary, 0o600);
      renameSync(temporary, stateFile);
      current = next;
      return this.status();
    }
  };
}
