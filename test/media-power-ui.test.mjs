import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(root, "public/index.html"), "utf8");
const script = readFileSync(path.join(root, "public/app.js"), "utf8");

test("页脚包含低调的媒体运行状态按钮", () => {
  assert.match(html, /id="mediaPowerButton"[^>]*aria-pressed="false"/);
  assert.match(script, /精彩时刻媒体服务\$\{sleeping \? "休眠中/);
  assert.match(script, /refreshMediaPower\(\).*30_000/);
});

test("访客也可以点击状态按钮切换服务", () => {
  assert.doesNotMatch(script, /mediaPowerButton[\s\S]{0,200}if \(!state\.security\.canManage\) return;/);
  assert.match(script, /method: "PUT"/);
});
