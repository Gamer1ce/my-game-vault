import { Worker } from "node:worker_threads";

const pending = new Map();
// Slow external-drive traversal must not occupy the HTTP server's event loop.
// Concurrent readers of the same library share one scan, not one worker each.
export function readMediaIndex(directory, limit = 5000) {
  const key = JSON.stringify([directory, limit]);
  if (pending.has(key)) return pending.get(key);
  const result = new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./media-index-worker.mjs", import.meta.url), {
      workerData: { directory, limit }, resourceLimits: { maxOldGenerationSizeMb: 128 }
    });
    const timeout = setTimeout(() => { void worker.terminate(); reject(new Error("媒体硬盘扫描超时")); }, 60_000);
    timeout.unref();
    worker.once("message", resolve); worker.once("error", reject);
    worker.once("exit", code => { clearTimeout(timeout); if (code) reject(new Error("媒体索引暂时不可用")); });
  }).finally(() => pending.delete(key));
  pending.set(key, result); return result;
}
