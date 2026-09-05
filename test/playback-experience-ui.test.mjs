import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(root, "public/index.html"), "utf8");
const script = readFileSync(path.join(root, "public/app.js"), "utf8");
const styles = readFileSync(path.join(root, "public/styles.css"), "utf8");

test("视频备用线路按实测速度排序且允许手动切换", () => {
  assert.match(script, /rankPlaybackCandidates\(candidates, \{ fileSize: item\.size \}\)/);
  assert.match(script, /class="highlight-route-next"[^>]*>换条线路</);
  assert.match(script, /fallbackCandidates = rankedCandidates\.slice\(1\)/);
  assert.match(styles, /\.highlight-buffer-actions \.highlight-route-next/);
  assert.match(html, /playback-route\.js\?v=20260905-2/);
});

test("线路切换保留播放位置，慢缓存不再被误判为故障", () => {
  assert.match(script, /pendingResume = \{ resumeAt, resumePlaying \}/);
  assert.match(script, /video\.currentTime = Math\.min\(resume\.resumeAt/);
  assert.doesNotMatch(script, /当前线路读取超时/);
  assert.doesNotMatch(script, /当前线路缓存停滞/);
  assert.match(script, /video\.addEventListener\("error", \(\) => \{\s*if \(switchToFallback/);
});

test("连续状态提示不会被上一条过时器提前隐藏", () => {
  assert.match(script, /if \(toastTimer\) window\.clearTimeout\(toastTimer\)/);
  assert.match(script, /toastTimer = window\.setTimeout/);
});
