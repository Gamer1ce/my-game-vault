import { parentPort, workerData } from "node:worker_threads";
import { listHighlights } from "./highlights.mjs";
import { streamUrlFor } from "./highlight-streams.mjs";
import { existsSync } from "node:fs";
import path from "node:path";

const hasStreams = existsSync(path.join(workerData.directory, ".playback-cache"));
parentPort.postMessage(listHighlights(workerData.directory, workerData.limit).map(item => ({
  ...item, streamUrl: hasStreams ? streamUrlFor(workerData.directory, item) : null
})));
