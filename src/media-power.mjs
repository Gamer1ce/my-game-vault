import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MEDIA_POWER_MODES = new Set(["running", "sleeping"]);

export function createMediaPowerStore({ dataDirectory, logger = console } = {}) {
  if (!dataDirectory) throw new Error("展示状态缺少数据目录");
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
      current = { mode: "running", updatedAt: null };
      logger.warn?.("展示状态文件损坏，已恢复默认运行状态");
    }
  }

  return {
    status() {
      return { ...current, sleeping: current.mode === "sleeping" };
    },
    set(mode) {
      if (!MEDIA_POWER_MODES.has(mode)) throw new TypeError("展示状态无效");
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
