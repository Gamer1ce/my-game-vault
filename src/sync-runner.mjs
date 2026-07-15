export function createSyncRunner(platforms, { isConnected, onError = () => {} } = {}) {
  if (!Array.isArray(platforms) || typeof isConnected !== "function") throw new TypeError("同步平台与连接检查函数不能为空");
  let activeRun = null;

  async function execute(trigger) {
    const startedAt = new Date().toISOString();
    const results = [];

    for (const platform of platforms) {
      if (!isConnected(platform.id)) continue;
      try {
        const result = await platform.sync();
        results.push({
          provider: platform.id,
          ok: true,
          synced: Number(result?.synced || 0),
          historyBackfilled: Number(result?.historyBackfilled || 0)
        });
      } catch (error) {
        const message = error?.message || "同步失败";
        results.push({ provider: platform.id, ok: false, error: message });
        try { onError(platform.id, error, trigger); } catch { /* 日志回调不能中断其他平台 */ }
      }
    }

    return { trigger, startedAt, completedAt: new Date().toISOString(), results };
  }

  return {
    run(trigger = "manual") {
      if (activeRun) return activeRun;
      activeRun = execute(trigger).finally(() => { activeRun = null; });
      return activeRun;
    },
    isRunning() {
      return Boolean(activeRun);
    }
  };
}
