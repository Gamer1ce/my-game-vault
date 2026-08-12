import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(root, "public/index.html"), "utf8");
const script = readFileSync(path.join(root, "public/app.js"), "utf8");
const server = readFileSync(path.join(root, "server.mjs"), "utf8");

test("页脚包含低调的纯展示状态按钮", () => {
  assert.match(html, /id="mediaPowerButton"[^>]*aria-pressed="false"/);
  assert.match(html, /title="切换展示状态，不影响网站功能"/);
  assert.match(script, /展示状态\$\{sleeping \? "休眠中/);
  assert.match(script, /refreshMediaPower\(\).*30_000/);
});

test("访客也可以点击状态按钮切换服务", () => {
  assert.doesNotMatch(script, /mediaPowerButton[\s\S]{0,200}if \(!state\.security\.canManage\) return;/);
  assert.match(script, /method: "PUT"/);
});

test("切换展示状态不会关闭播放器或重新读取精彩时刻", () => {
  const handler = script.match(/\$\("#mediaPowerButton"\)\.addEventListener\("click",[\s\S]*?\n\}\);/)?.[0] || "";
  assert.doesNotMatch(handler, /highlightDialog|stopHighlightBufferTimer|loadHighlights/);
  assert.match(handler, /renderMediaPower\(\)/);
});

test("运行中和休眠中都不会拦截任何媒体接口", () => {
  assert.doesNotMatch(server, /mediaSleepingResponse/);
  assert.doesNotMatch(server, /mediaPower\.status\(\)\.sleeping/);
  assert.doesNotMatch(server, /power\.sleeping/);
  assert.match(server, /app\.get\("\/media\/highlights\/:filename"/);
  assert.match(server, /app\.get\("\/media\/highlight-posters\/:filename"/);
  assert.match(server, /app\.get\("\/api\/highlights\/playback"/);
});
